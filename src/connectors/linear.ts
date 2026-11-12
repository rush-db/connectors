import type { StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * Linear GraphQL API (https://api.linear.app/graphql).
 *
 * Every stream is one GraphQL connection read with `first`/`after` and
 * `pageInfo.endCursor`. Streams with an incremental read swap in the same
 * query filtered by `updatedAt > cursor` once a cursor exists; the cursor is
 * rendered into the query text as an ISO date-time, so no variable types are
 * involved. Archived records are included (Linear archives closed issues
 * automatically); permanently deleted ones only arrive through webhooks.
 */

const PAGE = 100

type Connection = {
  /** Root field, `issues`. */
  field: string
  /** Fields of each node. */
  nodes: string
  /** Extra root arguments. */
  args?: string
}

function query(connection: Connection, since?: string): string {
  const args = [
    'first: $first',
    'after: $after',
    ...(connection.args ? [connection.args] : []),
    ...(since ? [`filter: { updatedAt: { gt: "${since}" } }`] : [])
  ].join(', ')
  return `query Sync($first: Int!, $after: String) { ${connection.field}(${args}) { nodes { ${connection.nodes} } pageInfo { hasNextPage endCursor } } }`
}

function linearStream(
  connection: Connection,
  stream: Omit<StreamSpec, 'request' | 'records' | 'id' | 'pagination' | 'incremental'> & { incremental?: boolean }
): StreamSpec {
  const { incremental, ...rest } = stream
  return {
    ...rest,
    request: { method: 'POST', path: '/graphql', body: { query: query(connection), variables: { first: PAGE } } },
    records: `$.data.${connection.field}.nodes`,
    id: '$.id',
    pagination: {
      type: 'cursor',
      next: `$.data.${connection.field}.pageInfo.endCursor`,
      hasMore: `$.data.${connection.field}.pageInfo.hasNextPage`,
      param: 'variables.after',
      in: 'body'
    },
    ...(incremental ?
      {
        incremental: {
          cursorField: '$.updatedAt',
          format: 'iso' as const,
          // The body merge is shallow: the filtered query and its variables replace the full-read ones.
          request: { body: { query: query(connection, '{{cursor|iso}}'), variables: { first: PAGE } } },
          lookbackSeconds: 60
        }
      }
    : {})
  }
}

const ISSUES: Connection = {
  field: 'issues',
  args: 'includeArchived: true',
  nodes:
    'id identifier number title description priority priorityLabel estimate url branchName dueDate labelIds createdAt updatedAt startedAt completedAt canceledAt archivedAt state { id name type } team { id key } assignee { id } creator { id } project { id } cycle { id } parent { id }'
}
const PROJECTS: Connection = {
  field: 'projects',
  args: 'includeArchived: true',
  nodes:
    'id name description url priority progress startDate targetDate createdAt updatedAt startedAt completedAt canceledAt archivedAt status { id name type } lead { id } creator { id } teams { nodes { id } }'
}
const TEAMS: Connection = {
  field: 'teams',
  nodes: 'id key name description private timezone createdAt updatedAt archivedAt'
}
const USERS: Connection = {
  field: 'users',
  args: 'includeDisabled: true',
  nodes: 'id name displayName email active admin guest timezone createdAt updatedAt'
}
const CYCLES: Connection = {
  field: 'cycles',
  args: 'includeArchived: true',
  nodes: 'id number name description startsAt endsAt completedAt progress createdAt updatedAt archivedAt team { id }'
}
const COMMENTS: Connection = {
  field: 'comments',
  nodes: 'id body url createdAt updatedAt editedAt issue { id } user { id } parent { id }'
}

const DATES = {
  createdAt: 'datetime',
  updatedAt: 'datetime',
  startedAt: 'datetime',
  completedAt: 'datetime',
  canceledAt: 'datetime',
  archivedAt: 'datetime'
} as const

export const linear = defineConnector({
  spec: {
    id: 'linear',
    name: 'Linear',
    category: 'project-management',
    description: 'Issues, projects, cycles, teams, users and comments from Linear, with assignees, parents and cycles.',
    docsUrl: 'https://linear.app/developers/graphql',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://linear.app/oauth/authorize',
        tokenUrl: 'https://api.linear.app/oauth/token',
        scopes: ['read'],
        scopeSeparator: ',',
        pkce: true,
        authorizeParams: { prompt: 'consent' }
      },
      {
        type: 'bearer',
        label: 'Personal API key',
        // Personal keys go in the Authorization header as is, without "Bearer".
        prefix: '',
        help: 'Linear → Settings → Security & access → Personal API keys → New API key with the "Read" permission only.'
      }
    ],
    errors: '$.errors',
    baseUrl: 'https://api.linear.app',
    // 2,500 requests per hour for API keys (5,000 for OAuth apps); query complexity is limited separately.
    rateLimit: { requestsPerSecond: 0.6 },
    test: {
      request: { method: 'POST', path: '/graphql', body: { query: 'query { viewer { id } organization { name } }' } },
      account: '$.data.organization.name'
    },
    streams: {
      issues: linearStream(ISSUES, {
        label: 'LINEAR_ISSUE',
        description: 'Issues of every team the account can see, archived ones included.',
        incremental: true,
        fields: { types: { ...DATES, dueDate: 'datetime' } },
        relations: [
          { type: 'IN_TEAM', target: 'teams', path: '$.team.id' },
          { type: 'IN_PROJECT', target: 'projects', path: '$.project.id' },
          { type: 'IN_CYCLE', target: 'cycles', path: '$.cycle.id' },
          { type: 'ASSIGNED_TO', target: 'users', path: '$.assignee.id' },
          { type: 'CREATED_BY', target: 'users', path: '$.creator.id' },
          { type: 'CHILD_OF', target: 'issues', path: '$.parent.id' }
        ]
      }),
      projects: linearStream(PROJECTS, {
        label: 'LINEAR_PROJECT',
        description: 'Projects.',
        incremental: true,
        fields: { omit: ['teams'], types: { ...DATES, startDate: 'datetime', targetDate: 'datetime' } },
        relations: [
          { type: 'LED_BY', target: 'users', path: '$.lead.id' },
          { type: 'CREATED_BY', target: 'users', path: '$.creator.id' },
          { type: 'FOR_TEAM', target: 'teams', path: '$.teams.nodes[*].id' }
        ]
      }),
      teams: linearStream(TEAMS, {
        label: 'LINEAR_TEAM',
        description: 'Teams.',
        fields: { types: DATES }
      }),
      users: linearStream(USERS, {
        label: 'LINEAR_USER',
        description: 'Users of the workspace, disabled ones included.',
        fields: { types: DATES }
      }),
      cycles: linearStream(CYCLES, {
        label: 'LINEAR_CYCLE',
        description: 'Cycles (sprints) of every team.',
        incremental: true,
        fields: { types: { ...DATES, startsAt: 'datetime', endsAt: 'datetime' } },
        relations: [{ type: 'IN_TEAM', target: 'teams', path: '$.team.id' }]
      }),
      comments: linearStream(COMMENTS, {
        label: 'LINEAR_COMMENT',
        description: 'Comments on issues.',
        optional: true,
        incremental: true,
        fields: { types: { ...DATES, editedAt: 'datetime' } },
        relations: [
          { type: 'ON_ISSUE', target: 'issues', path: '$.issue.id' },
          { type: 'AUTHORED_BY', target: 'users', path: '$.user.id' },
          { type: 'REPLY_TO', target: 'comments', path: '$.parent.id' }
        ]
      })
    },
    webhooks: {
      // `Linear-Signature`: hex HMAC-SHA256 of the raw body with the webhook's signing secret.
      signature: { scheme: 'hmacSha256', header: 'Linear-Signature' },
      type: '$.type',
      typeSuffix: '$.action',
      // The delivery id is only in the `Linear-Delivery` header; the webhook timestamp (ms) is the closest body field.
      id: '$.webhookTimestamp',
      object: '$.data',
      // Webhook payloads use flat ids (`teamId`) rather than the GraphQL shape: refetch, or delete by id.
      routes: {
        'Issue.remove': { stream: 'issues', action: 'delete' },
        'Issue.*': { stream: 'issues', action: 'refetch' },
        'Comment.remove': { stream: 'comments', action: 'delete' },
        'Comment.*': { stream: 'comments', action: 'refetch' },
        'Project.remove': { stream: 'projects', action: 'delete' },
        'Project.*': { stream: 'projects', action: 'refetch' },
        'Cycle.remove': { stream: 'cycles', action: 'delete' },
        'Cycle.*': { stream: 'cycles', action: 'refetch' }
      },
      setup:
        'Linear → Settings → API → Webhooks → New webhook: URL = the connection’s webhook URL, data change events Issues, Comments, Projects and Cycles. Copy the webhook’s signing secret from its detail page and paste it here.'
    }
  }
})
