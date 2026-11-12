import type { StreamSpec } from '../spec'
import { defineConnector, type ConnectorHttp, type StreamState } from '../types'

/*
 * Notion API (version pinned). Pages and databases come from the search API,
 * which filters only by object type and sorts by `last_edited_time`. A full
 * read pages through everything; with a cursor the `read` hook sorts newest
 * first and stops at the first result older than the cursor. Newest first
 * means the cursor may only move once the run finishes, so the hook keeps the
 * old cursor on every batch but the last.
 *
 * The `transform` hook turns typed page properties into plain values (text,
 * numbers, select names, people and relation ids).
 */

const NOTION_VERSION = '2022-06-28'

const plain = (rich: any): string =>
  Array.isArray(rich) ? rich.map((part) => part?.plain_text ?? '').join('') : ''

/** The plain value of one typed Notion property. */
export function notionValue(property: any): unknown {
  if (!property || typeof property !== 'object') {
    return null
  }
  const value = property[property.type]
  switch (property.type) {
    case 'title':
    case 'rich_text':
      return plain(value)
    case 'number':
    case 'checkbox':
    case 'url':
    case 'email':
    case 'phone_number':
    case 'created_time':
    case 'last_edited_time':
      return value ?? null
    case 'select':
    case 'status':
      return value?.name ?? null
    case 'multi_select':
      return Array.isArray(value) ? value.map((option: any) => option?.name) : []
    case 'date':
      return value?.start ?? null
    case 'people':
    case 'relation':
      return Array.isArray(value) ? value.map((item: any) => item?.id).filter(Boolean) : []
    case 'created_by':
    case 'last_edited_by':
      return value?.id ?? null
    case 'files':
      return Array.isArray(value) ? value.map((file: any) => file?.name).filter(Boolean) : []
    case 'unique_id':
      return value ? `${value.prefix ? `${value.prefix}-` : ''}${value.number}` : null
    case 'formula':
      return value ? (value[value.type]?.start ?? value[value.type] ?? null) : null
    case 'rollup':
      if (!value) {
        return null
      }
      if (value.type === 'array') {
        return JSON.stringify((value.array ?? []).map(notionValue))
      }
      return value[value.type]?.start ?? value[value.type] ?? null
    case 'verification':
      return value?.state ?? null
    default:
      return value === undefined ? null : JSON.stringify(value)
  }
}

export function flattenPage(page: any) {
  const properties: Record<string, unknown> = {}
  let title = ''
  for (const [name, property] of Object.entries<any>(page?.properties ?? {})) {
    properties[name] = notionValue(property)
    if (property?.type === 'title') {
      title = plain(property.title)
    }
  }
  return {
    id: page.id,
    title,
    url: page.url ?? null,
    created_time: page.created_time ?? null,
    last_edited_time: page.last_edited_time ?? null,
    archived: Boolean(page.archived || page.in_trash),
    parent: page.parent ?? null,
    created_by: page.created_by?.id ?? null,
    last_edited_by: page.last_edited_by?.id ?? null,
    properties
  }
}

export function flattenDatabase(database: any) {
  return {
    id: database.id,
    title: plain(database.title),
    description: plain(database.description),
    url: database.url ?? null,
    created_time: database.created_time ?? null,
    last_edited_time: database.last_edited_time ?? null,
    archived: Boolean(database.archived || database.in_trash),
    is_inline: database.is_inline ?? null,
    parent: database.parent ?? null,
    created_by: database.created_by?.id ?? null,
    property_names: Object.keys(database.properties ?? {})
  }
}

function searchStream(object: 'page' | 'database', label: string, description: string, extra: Partial<StreamSpec>): StreamSpec {
  return {
    label,
    description,
    request: {
      method: 'POST',
      path: '/v1/search',
      body: {
        filter: { property: 'object', value: object },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 100
      }
    },
    records: '$.results',
    id: '$.id',
    pagination: { type: 'cursor', next: '$.next_cursor', param: 'start_cursor', in: 'body', hasMore: '$.has_more' },
    incremental: { cursorField: '$.last_edited_time', format: 'iso', lookbackSeconds: 120 },
    deleted: { path: '$.archived', value: true },
    ...extra
  }
}

async function* readNewest(
  http: ConnectorHttp,
  object: 'page' | 'database',
  state: StreamState,
  lookbackSeconds: number
) {
  const since = Date.parse(String(state.cursor)) - lookbackSeconds * 1000
  let startCursor: string | undefined
  let newest: string | undefined
  for (;;) {
    const response = await http.request({
      method: 'POST',
      url: '/v1/search',
      body: {
        filter: { property: 'object', value: object },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 100,
        ...(startCursor ? { start_cursor: startCursor } : {})
      }
    })
    const results: any[] = response.data?.results ?? []
    const fresh = results.filter((result) => Date.parse(result?.last_edited_time) >= since)
    for (const result of fresh) {
      if (!newest || Date.parse(result.last_edited_time) > Date.parse(newest)) {
        newest = result.last_edited_time
      }
    }
    const reachedOld = fresh.length < results.length
    const next = response.data?.has_more ? response.data?.next_cursor : undefined
    if (reachedOld || !next) {
      yield { records: fresh, state: { cursor: newest ?? state.cursor } }
      return
    }
    yield { records: fresh, state: { cursor: state.cursor } }
    startCursor = next
  }
}

export const notion = defineConnector({
  spec: {
    id: 'notion',
    name: 'Notion',
    category: 'knowledge',
    description: 'Pages (with their properties), databases and users from the Notion pages shared with the integration.',
    docsUrl: 'https://developers.notion.com/reference/intro',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
        tokenUrl: 'https://api.notion.com/v1/oauth/token',
        // Capabilities are set on the integration: enable "Read content" and "Read user information" only.
        scopes: [],
        pkce: false,
        clientAuth: 'basic',
        authorizeParams: { owner: 'user' }
      },
      {
        type: 'bearer',
        label: 'Internal integration secret',
        help: 'notion.so/profile/integrations → New integration with only the read capabilities; then share the pages and databases to sync with it (… → Connections).'
      }
    ],
    baseUrl: 'https://api.notion.com',
    headers: { 'Notion-Version': NOTION_VERSION },
    // Notion allows an average of 3 requests per second.
    rateLimit: { requestsPerSecond: 3 },
    test: { request: { path: '/v1/users/me' }, account: '$.bot.workspace_name' },
    streams: {
      pages: searchStream('page', 'NOTION_PAGE', 'Pages and database rows.', {
        fields: {
          flatten: ['$.properties'],
          omit: ['parent_type', 'parent_workspace', 'parent_block_id'],
          types: { created_time: 'datetime', last_edited_time: 'datetime' }
        },
        relations: [
          { type: 'CHILD_OF', target: 'pages', path: '$.parent.page_id' },
          { type: 'IN_DATABASE', target: 'databases', path: '$.parent.database_id' },
          { type: 'CREATED_BY', target: 'users', path: '$.created_by' }
        ]
      }),
      databases: searchStream('database', 'NOTION_DATABASE', 'Databases.', {
        fields: { types: { created_time: 'datetime', last_edited_time: 'datetime' } },
        relations: [
          { type: 'CHILD_OF', target: 'pages', path: '$.parent.page_id' },
          { type: 'CREATED_BY', target: 'users', path: '$.created_by' }
        ]
      }),
      users: {
        label: 'NOTION_USER',
        description: 'People and bots of the workspace.',
        request: { path: '/v1/users', query: { page_size: 100 } },
        records: '$.results',
        id: '$.id',
        pagination: { type: 'cursor', next: '$.next_cursor', param: 'start_cursor', hasMore: '$.has_more' },
        fields: { omit: ['object', 'avatar_url'] }
      }
    },
    webhooks: {
      signature: { scheme: 'hmacSha256', header: 'X-Notion-Signature', prefix: 'sha256=' },
      type: '$.type',
      id: '$.id',
      objectId: '$.entity.id',
      routes: {
        'page.deleted': { stream: 'pages', action: 'delete' },
        'page.*': { stream: 'pages', action: 'refetch' },
        'database.deleted': { stream: 'databases', action: 'delete' },
        'database.*': { stream: 'databases', action: 'refetch' },
        'data_source.*': { stream: 'databases', action: 'refetch' }
      },
      setup:
        'notion.so/profile/integrations → your integration → Webhooks → Create a subscription with the connection’s webhook URL and the page and database events. Notion first POSTs a `verification_token`; paste it in Notion to verify the endpoint, and here as the signing secret (it signs every later delivery).'
    }
  },
  hooks: {
    read(stream, state, ctx) {
      if ((stream.name !== 'pages' && stream.name !== 'databases') || state.cursor === undefined) {
        return undefined
      }
      if (!Number.isFinite(Date.parse(String(state.cursor)))) {
        return undefined
      }
      return readNewest(
        ctx.http,
        stream.name === 'pages' ? 'page' : 'database',
        state,
        stream.spec.incremental?.lookbackSeconds ?? 120
      )
    },
    transform(stream, record) {
      if (stream === 'pages') {
        return flattenPage(record)
      }
      if (stream === 'databases') {
        return flattenDatabase(record)
      }
      return record
    }
  }
})
