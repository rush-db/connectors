import { defineConnector, type ConnectorHttp } from '../types'

/*
 * monday.com GraphQL API (https://api.monday.com/v2), pinned with
 * `API-Version`.
 *
 * Boards and users page with `page`/`limit` in the GraphQL variables. Items
 * are read per board with cursor pagination: the first page through
 * `boards(ids) { items_page }`, the next ones through `next_items_page(cursor)`,
 * which the `read` hook does since a spec cannot switch queries between pages.
 * The `transform` hook flattens column values into `columns_<column title>`
 * properties (the column's display text).
 *
 * Items are read in full on every run: `items_page` filters by last update
 * only with day keywords (TODAY, YESTERDAY…) in the user's time zone, not by
 * a timestamp. Deleted items are not reported.
 */

const PAGE = 100
const ITEMS_PAGE = 500
const BOARDS_PER_REQUEST = 50

const ITEM_FIELDS =
  'id name state created_at updated_at creator_id group { id title } board { id } parent_item { id } column_values { id type text column { title } }'

async function graphql(http: ConnectorHttp, query: string, variables: Record<string, unknown>) {
  const response = await http.request({ method: 'POST', url: '/v2', body: { query, variables } })
  // GraphQL errors come back with HTTP 200.
  const errors = response.data?.errors ?? (response.data?.error_message ? [{ message: response.data.error_message }] : [])
  if (errors.length) {
    throw new Error(`monday.com: ${errors.map((error: any) => error?.message).join('; ')}`)
  }
  return response.data?.data ?? {}
}

async function* readItems(http: ConnectorHttp) {
  for (let page = 1; ; page++) {
    const data = await graphql(
      http,
      'query ($limit: Int!, $page: Int!) { boards(limit: $limit, page: $page, state: all, order_by: created_at) { id } }',
      { limit: BOARDS_PER_REQUEST, page }
    )
    const boards: Array<{ id: string }> = data.boards ?? []
    for (const board of boards) {
      const first = await graphql(
        http,
        `query ($board: [ID!], $limit: Int!) { boards(ids: $board) { items_page(limit: $limit) { cursor items { ${ITEM_FIELDS} } } } }`,
        { board: [board.id], limit: ITEMS_PAGE }
      )
      let itemsPage = first.boards?.[0]?.items_page
      for (;;) {
        yield { records: itemsPage?.items ?? [], state: {} }
        const cursor = itemsPage?.cursor
        if (!cursor) {
          break
        }
        const next = await graphql(
          http,
          `query ($cursor: String!, $limit: Int!) { next_items_page(cursor: $cursor, limit: $limit) { cursor items { ${ITEM_FIELDS} } } }`,
          { cursor, limit: ITEMS_PAGE }
        )
        itemsPage = next.next_items_page
      }
    }
    if (boards.length < BOARDS_PER_REQUEST) {
      return
    }
  }
}

/** An item as flat properties: column values become `columns.<title>` (display text), ids feed the relations. */
export function flattenItem(item: any) {
  const columns: Record<string, string | null> = {}
  for (const value of Array.isArray(item?.column_values) ? item.column_values : []) {
    let key = value?.column?.title || value?.id
    if (!key) {
      continue
    }
    if (key in columns) {
      key = `${key} ${value.id}`
    }
    columns[key] = typeof value.text === 'string' && value.text !== '' ? value.text : null
  }
  return {
    id: item.id,
    name: item.name ?? null,
    state: item.state ?? null,
    created_at: item.created_at ?? null,
    updated_at: item.updated_at ?? null,
    creator_id: item.creator_id ?? null,
    board_id: item.board?.id ?? null,
    group_id: item.group?.id ?? null,
    group_title: item.group?.title ?? null,
    parent_item_id: item.parent_item?.id ?? null,
    columns
  }
}

export const monday = defineConnector({
  spec: {
    id: 'monday',
    name: 'monday.com',
    category: 'project-management',
    description: 'Boards, items with their column values and users from monday.com.',
    docsUrl: 'https://developer.monday.com/api-reference/docs/basics',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://auth.monday.com/oauth2/authorize',
        tokenUrl: 'https://auth.monday.com/oauth2/token',
        scopes: ['me:read', 'account:read', 'boards:read', 'users:read', 'workspaces:read'],
        pkce: false,
        // monday.com takes the token in the Authorization header as is.
        prefix: ''
      },
      {
        type: 'bearer',
        label: 'Personal API token',
        prefix: '',
        help: 'Avatar → Developers → My access tokens → Copy. The token has the permissions of its user (monday.com has no read-only personal token): use a viewer account that can see the boards to sync.'
      }
    ],
    errors: '$.errors',
    baseUrl: 'https://api.monday.com',
    headers: { 'API-Version': '2026-10' },
    // Per-minute request limits start at 1,000; query complexity is budgeted separately.
    rateLimit: { requestsPerSecond: 2 },
    test: {
      request: { method: 'POST', path: '/v2', body: { query: 'query { me { id } account { name } }' } },
      account: '$.data.account.name'
    },
    streams: {
      boards: {
        label: 'MONDAY_BOARD',
        description: 'Boards, archived ones included.',
        request: {
          method: 'POST',
          path: '/v2',
          body: {
            query:
              'query ($limit: Int!, $page: Int!) { boards(limit: $limit, page: $page, state: all, order_by: created_at) { id name description state board_kind workspace_id updated_at url owners { id } } }',
            variables: {}
          }
        },
        records: '$.data.boards',
        id: '$.id',
        pagination: { type: 'page', param: 'variables.page', sizeParam: 'variables.limit', size: PAGE, start: 1, in: 'body' },
        fields: { omit: ['owners'], types: { updated_at: 'datetime' } },
        relations: [{ type: 'OWNED_BY', target: 'users', path: '$.owners[*].id' }]
      },
      items: {
        label: 'MONDAY_ITEM',
        description: 'Items of every board, column values as `columns_<column title>`.',
        // The read hook pages each board with items_page / next_items_page.
        request: { method: 'POST', path: '/v2' },
        records: '$.data.items',
        id: '$.id',
        fields: { types: { created_at: 'datetime', updated_at: 'datetime' } },
        relations: [
          { type: 'ON_BOARD', target: 'boards', path: '$.board_id' },
          { type: 'CREATED_BY', target: 'users', path: '$.creator_id' },
          { type: 'CHILD_OF', target: 'items', path: '$.parent_item_id' }
        ]
      },
      users: {
        label: 'MONDAY_USER',
        description: 'Users of the account.',
        request: {
          method: 'POST',
          path: '/v2',
          body: {
            query:
              'query ($limit: Int!, $page: Int!) { users(limit: $limit, page: $page) { id name email title enabled is_admin is_guest is_view_only created_at time_zone_identifier } }',
            variables: {}
          }
        },
        records: '$.data.users',
        id: '$.id',
        pagination: { type: 'page', param: 'variables.page', sizeParam: 'variables.limit', size: PAGE, start: 1, in: 'body' },
        fields: { types: { created_at: 'datetime' } }
      }
    }
  },
  hooks: {
    read(stream, _state, ctx) {
      return stream.name === 'items' ? readItems(ctx.http) : undefined
    },
    transform(stream, record) {
      return stream === 'items' ? flattenItem(record) : record
    }
  }
})
