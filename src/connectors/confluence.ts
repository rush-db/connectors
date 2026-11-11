import type { StreamSpec } from '../spec'
import { defineConnector, type ConnectorHttp, type StreamState } from '../types'

/*
 * Confluence Cloud REST API v2.
 *
 * Spaces, pages and blog posts page with the relative `_links.next` URL
 * (`/wiki/api/v2/pages?cursor=…`), so the base URL is the site (or the
 * Atlassian API gateway for OAuth) without `/wiki`.
 *
 * The v2 list endpoints cannot filter by modification time. A full read lists
 * everything in id order; once a cursor exists the `read` hook lists pages and
 * blog posts newest-modified first (`sort=-modified-date`) and stops at the
 * first one older than the cursor, keeping the old cursor until its last batch.
 * The `transform` hook turns the storage-format body (XHTML) into plain text.
 *
 * Only current content is read: archived, trashed and deleted pages are not
 * reported, so deletions are not synced.
 */

const LIST_QUERY = { limit: 250, 'body-format': 'storage', status: 'current' }

const ENTITY = (text: string) =>
  text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')

/** Plain text of a Confluence storage-format (XHTML) body. */
export function storageToText(html: unknown): string {
  if (typeof html !== 'string' || !html) {
    return ''
  }
  const text = html
    // Code macros keep their text in CDATA; escape it so the tag stripping below leaves it alone.
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, inner: string) =>
      inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    )
    // A paragraph that ends a list item ends the line once, not twice.
    .replace(/<\/p>\s*<\/li>/gi, '</li>')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(t[dh])>/gi, '\t')
    .replace(/<\/(p|h[1-6]|li|tr|div|blockquote|pre|table|ul|ol|ac:plain-text-body)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return ENTITY(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ ]+/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A page or blog post as flat properties plus the ids the relations read. */
export function flattenContent(content: any) {
  return {
    id: content.id,
    title: content.title ?? null,
    status: content.status ?? null,
    space_id: content.spaceId ?? null,
    parent_page_id: content.parentType === 'page' ? (content.parentId ?? null) : null,
    position: content.position ?? null,
    author_id: content.authorId ?? null,
    owner_id: content.ownerId ?? null,
    created_at: content.createdAt ?? null,
    updated_at: content.version?.createdAt ?? content.createdAt ?? null,
    version: content.version?.number ?? null,
    version_author_id: content.version?.authorId ?? null,
    version_message: content.version?.message || null,
    web_path: content._links?.webui ?? null,
    body: storageToText(content.body?.storage?.value) || null
  }
}

function contentStream(kind: 'pages' | 'blogposts', label: string, description: string): StreamSpec {
  return {
    label,
    description,
    request: { path: `/wiki/api/v2/${kind}`, query: { ...LIST_QUERY, sort: 'id' } },
    records: '$.results',
    id: '$.id',
    pagination: { type: 'nextUrl', next: '$._links.next' },
    // Applied to the transformed record; the read hook pages newest-modified first once a cursor exists.
    incremental: { cursorField: '$.updated_at', format: 'iso', lookbackSeconds: 300 },
    fields: { types: { created_at: 'datetime', updated_at: 'datetime' } },
    relations: [
      { type: 'IN_SPACE', target: 'spaces', path: '$.space_id' },
      ...(kind === 'pages' ? [{ type: 'CHILD_OF', target: 'pages', path: '$.parent_page_id' }] : [])
    ]
  }
}

async function* readModified(http: ConnectorHttp, kind: string, state: StreamState, lookbackSeconds: number) {
  const since = Date.parse(String(state.cursor)) - lookbackSeconds * 1000
  let url = `/wiki/api/v2/${kind}`
  let query: Record<string, string | number> | undefined = { ...LIST_QUERY, sort: '-modified-date' }
  for (;;) {
    const response = await http.request({ url, query })
    const results: any[] = response.data?.results ?? []
    const fresh = results.filter((item) => {
      const modified = Date.parse(item?.version?.createdAt ?? item?.createdAt ?? '')
      return !Number.isFinite(modified) || modified >= since
    })
    const next: unknown = response.data?._links?.next
    const last = fresh.length < results.length || typeof next !== 'string' || !next || !results.length
    // Newest first: the stored cursor moves only with the last batch (the runtime fills in the newest value seen).
    yield { records: fresh, state: last ? {} : { cursor: state.cursor } }
    if (last) {
      return
    }
    url = next as string
    query = undefined
  }
}

export const confluence = defineConnector({
  spec: {
    id: 'confluence',
    name: 'Confluence',
    category: 'knowledge',
    description: 'Spaces, pages and blog posts from Confluence Cloud as plain text, with the page tree.',
    docsUrl: 'https://developer.atlassian.com/cloud/confluence/rest/v2/intro/',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://auth.atlassian.com/authorize',
        tokenUrl: 'https://auth.atlassian.com/oauth/token',
        scopes: ['read:space:confluence', 'read:page:confluence', 'read:blogpost:confluence', 'offline_access'],
        pkce: false,
        authorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
        // OAuth tokens only work through the Atlassian API gateway, addressed by cloud id.
        baseUrl: 'https://api.atlassian.com/ex/confluence/{{config.cloudId}}'
      },
      {
        type: 'basic',
        usernameLabel: 'Atlassian account email',
        passwordLabel: 'API token',
        help: 'Create an API token at id.atlassian.com → Security → API tokens. The connection sees what this account can view; use an account with view-only space permissions.'
      }
    ],
    config: {
      site: {
        label: 'Site',
        placeholder: 'acme.atlassian.net',
        help: 'Your Confluence Cloud host, without https:// and without /wiki.'
      },
      cloudId: {
        label: 'Cloud ID',
        required: false,
        help: 'Needed for OAuth only: the `id` of your site in https://api.atlassian.com/oauth/token/accessible-resources (or https://<site>/_edge/tenant_info).'
      }
    },
    baseUrl: 'https://{{config.site}}',
    rateLimit: { requestsPerSecond: 5 },
    test: { request: { path: '/wiki/api/v2/spaces', query: { limit: 1 } } },
    streams: {
      spaces: {
        label: 'CONFLUENCE_SPACE',
        description: 'Spaces the account can view.',
        request: { path: '/wiki/api/v2/spaces', query: { limit: 250, 'description-format': 'plain' } },
        records: '$.results',
        id: '$.id',
        pagination: { type: 'nextUrl', next: '$._links.next' },
        fields: { omit: ['_links', 'icon'], types: { created_at: 'datetime' } },
        relations: [{ type: 'HOME_PAGE', target: 'pages', path: '$.homepageId' }]
      },
      pages: contentStream('pages', 'CONFLUENCE_PAGE', 'Current pages with their body as plain text.'),
      blogposts: { ...contentStream('blogposts', 'CONFLUENCE_BLOGPOST', 'Current blog posts with their body as plain text.'), optional: true }
    }
  },
  hooks: {
    read(stream, state, ctx) {
      if ((stream.name !== 'pages' && stream.name !== 'blogposts') || !Number.isFinite(Date.parse(String(state.cursor)))) {
        return undefined
      }
      return readModified(ctx.http, stream.name, state, stream.spec.incremental?.lookbackSeconds ?? 300)
    },
    transform(stream, record) {
      if (stream === 'pages' || stream === 'blogposts') {
        return flattenContent(record)
      }
      if (stream === 'spaces') {
        const { description, ...rest } = record ?? {}
        return { ...rest, description: description?.plain?.value ?? null }
      }
      return record
    }
  }
})
