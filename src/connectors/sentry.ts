import { defineConnector, type ConnectorHttp, type StreamState } from '../types'

/*
 * Sentry Web API (/api/0) for one organization.
 *
 * Sentry pages with a `Link` header whose `next` entry is always present and
 * carries `results="true"` or `results="false"`; following it until it
 * disappears would never stop, so the `read` hook pages every stream and
 * stops on `results="false"`.
 *
 * Issues are read over the last 90 days (Sentry's event retention), every
 * status included, newest `lastSeen` first. Once a cursor exists the search
 * adds `lastSeen:>=<cursor>`, and the hook keeps the old cursor until its last
 * batch. `lastSeen` moves when new events arrive, not when an issue is
 * resolved or assigned: such changes are picked up by the next full read.
 *
 * No webhooks: Sentry integration webhooks carry no event id in the body
 * (only in the `Request-ID` header), which the webhook spec cannot read yet.
 */

const PAGE = 100
const ISSUE_PERIOD = '90d'

type SentryLink = { url: string; rel?: string; results?: string }

/** The entries of a Sentry `Link` header. */
export function parseSentryLinks(header: string | null): SentryLink[] {
  if (!header) {
    return []
  }
  return header.split(/,\s*(?=<)/).flatMap((part) => {
    const url = /^\s*<([^>]+)>/.exec(part)?.[1]
    if (!url) {
      return []
    }
    const attributes = Object.fromEntries([...part.matchAll(/;\s*(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]))
    return [{ url, rel: attributes.rel, results: attributes.results }]
  })
}

async function* readLinked(http: ConnectorHttp, path: string, query: Record<string, string | number>, state: StreamState) {
  const origin = new URL(http.baseUrl).origin
  let request: { url: string; query?: Record<string, string | number> } = { url: path, query }
  for (;;) {
    const response = await http.request(request)
    const records: unknown[] = Array.isArray(response.data) ? response.data : []
    const next = parseSentryLinks(response.headers.get('link')).find((link) => link.rel === 'next')
    const more = Boolean(next && next.results === 'true' && records.length)
    // Newest first (issues): the stored cursor moves only with the last batch.
    yield { records, state: more ? { cursor: state.cursor } : {} }
    if (!more) {
      return
    }
    if (new URL(next!.url, `${origin}/`).origin !== origin) {
      throw new Error('Sentry named a next page on another origin; refusing to send credentials there')
    }
    request = { url: next!.url }
  }
}

export const sentry = defineConnector({
  spec: {
    id: 'sentry',
    name: 'Sentry',
    category: 'engineering',
    description: 'Projects, issues and releases of a Sentry organization.',
    docsUrl: 'https://docs.sentry.io/api/',
    auth: [
      {
        type: 'bearer',
        label: 'Auth token',
        help: 'Settings → Developer Settings → Custom Integrations → Create an internal integration with Read access to Project, Issue & Event, Release and Organization, and copy its token. (A personal token with the scopes org:read, project:read, project:releases and event:read works too.)'
      }
    ],
    config: {
      host: {
        label: 'Region',
        type: 'select',
        options: [
          { value: 'sentry.io', label: 'sentry.io' },
          { value: 'us.sentry.io', label: 'United States (us.sentry.io)' },
          { value: 'de.sentry.io', label: 'European Union (de.sentry.io)' }
        ],
        default: 'sentry.io',
        help: 'Where your organization’s data is stored (Settings → Organization → Data Storage Location).'
      },
      organization: {
        label: 'Organization slug',
        placeholder: 'acme',
        help: 'The part after /organizations/ in Sentry’s address bar, or the subdomain of acme.sentry.io.'
      }
    },
    baseUrl: 'https://{{config.host}}/api/0',
    rateLimit: { requestsPerSecond: 5 },
    test: { request: { path: '/organizations/{{config.organization}}/' }, account: '$.name' },
    streams: {
      projects: {
        label: 'SENTRY_PROJECT',
        description: 'Projects of the organization.',
        request: { path: '/organizations/{{config.organization}}/projects/' },
        records: '$',
        id: '$.id',
        fields: {
          pick: ['slug', 'name', 'platform', 'status', 'date_created', 'is_member', 'has_access', 'is_bookmarked', 'first_event'],
          types: { date_created: 'datetime', first_event: 'datetime' }
        }
      },
      issues: {
        label: 'SENTRY_ISSUE',
        description: 'Issues of every status seen in the last 90 days.',
        request: {
          path: '/organizations/{{config.organization}}/issues/',
          query: { query: '', statsPeriod: ISSUE_PERIOD, sort: 'date', limit: PAGE }
        },
        records: '$',
        id: '$.id',
        incremental: {
          cursorField: '$.lastSeen',
          format: 'iso',
          request: { query: { query: 'lastSeen:>={{cursor|iso}}' } },
          lookbackSeconds: 120
        },
        fields: {
          omit: ['stats', 'annotations', 'plugin_actions', 'plugin_issues', 'plugin_contexts', 'share_id', 'project', 'subscription_details'],
          types: { count: 'number', first_seen: 'datetime', last_seen: 'datetime' }
        },
        relations: [{ type: 'IN_PROJECT', target: 'projects', path: '$.project.id' }]
      },
      releases: {
        label: 'SENTRY_RELEASE',
        description: 'Releases and the projects they shipped.',
        optional: true,
        request: { path: '/organizations/{{config.organization}}/releases/', query: { per_page: PAGE } },
        records: '$',
        id: '$.version',
        fields: {
          omit: ['projects', 'authors', 'last_commit', 'last_deploy', 'data', 'current_project_meta', 'owner'],
          types: {
            date_created: 'datetime',
            date_released: 'datetime',
            first_event: 'datetime',
            last_event: 'datetime'
          }
        },
        relations: [{ type: 'FOR_PROJECT', target: 'projects', path: '$.projects[*].id' }]
      }
    }
  },
  hooks: {
    read(stream, state, ctx) {
      const organization = encodeURIComponent(String(ctx.connection.config.organization ?? ''))
      switch (stream.name) {
        case 'projects':
          return readLinked(ctx.http, `/organizations/${organization}/projects/`, {}, {})
        case 'releases':
          return readLinked(ctx.http, `/organizations/${organization}/releases/`, { per_page: PAGE }, {})
        case 'issues': {
          const since = state.cursor === undefined ? NaN : Date.parse(String(state.cursor))
          const lookback = (stream.spec.incremental?.lookbackSeconds ?? 120) * 1000
          const query = Number.isFinite(since) ? `lastSeen:>=${new Date(since - lookback).toISOString()}` : ''
          return readLinked(
            ctx.http,
            `/organizations/${organization}/issues/`,
            { query, statsPeriod: ISSUE_PERIOD, sort: 'date', limit: PAGE },
            state
          )
        }
        default:
          return undefined
      }
    }
  }
})
