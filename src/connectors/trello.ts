import { defineConnector, type ConnectionContext, type ConnectorHttp, type StreamState } from '../types'

/*
 * Trello REST API 1.
 *
 * Trello authenticates with two query parameters: the app's API key (a
 * config value, sent as `key` on every request) and the member's token (the
 * credential, sent as `token`).
 *
 * Boards come from the member. Lists, cards, members and actions are only
 * listed per board, so the `read` hook walks the member's boards. Members of
 * several boards are yielded once, with every board they belong to.
 *
 * Trello cannot filter lists, cards or boards by modification time, so they
 * are read in full. Actions (optional) are read newest first per board with
 * `since` once a cursor exists. Trello's webhooks sign the body plus the
 * callback URL with HMAC-SHA1, which the signature schemes cannot express yet,
 * so they are not wired.
 */

const API = '/1'
const ACTIONS_PAGE = 1000

const BOARD_FIELDS = 'name,desc,closed,url,shortUrl,idOrganization,dateLastActivity'
const CARD_FIELDS = 'name,desc,closed,idBoard,idList,idMembers,labels,due,dueComplete,start,dateLastActivity,url,shortUrl,idShort,pos'

const key = (connection: ConnectionContext) => String(connection.config.apiKey ?? '')

async function boardIds(http: ConnectorHttp, connection: ConnectionContext): Promise<string[]> {
  const response = await http.request({
    url: `${API}/members/me/boards`,
    query: { key: key(connection), filter: 'all', fields: 'id' }
  })
  return (Array.isArray(response.data) ? response.data : []).map((board: any) => String(board.id))
}

async function* readPerBoard(
  http: ConnectorHttp,
  connection: ConnectionContext,
  path: (board: string) => string,
  query: Record<string, string>
) {
  for (const board of await boardIds(http, connection)) {
    const response = await http.request({ url: path(encodeURIComponent(board)), query: { key: key(connection), ...query } })
    yield { records: Array.isArray(response.data) ? response.data : [], state: {} }
  }
}

async function* readMembers(http: ConnectorHttp, connection: ConnectionContext) {
  const members = new Map<string, any>()
  for (const board of await boardIds(http, connection)) {
    const response = await http.request({
      url: `${API}/boards/${encodeURIComponent(board)}/members`,
      query: { key: key(connection), fields: 'fullName,username' }
    })
    for (const member of Array.isArray(response.data) ? response.data : []) {
      const known = members.get(member.id)
      members.set(member.id, { ...member, idBoards: [...(known?.idBoards ?? []), board] })
    }
  }
  yield { records: [...members.values()], state: {} }
}

async function* readActions(http: ConnectorHttp, connection: ConnectionContext, state: StreamState, lookbackSeconds: number) {
  const since = state.cursor === undefined ? NaN : Date.parse(String(state.cursor))
  for (const board of await boardIds(http, connection)) {
    let before: string | undefined
    for (;;) {
      const response = await http.request({
        url: `${API}/boards/${encodeURIComponent(board)}/actions`,
        query: {
          key: key(connection),
          limit: ACTIONS_PAGE,
          ...(Number.isFinite(since) ? { since: new Date(since - lookbackSeconds * 1000).toISOString() } : {}),
          ...(before ? { before } : {})
        }
      })
      const actions: any[] = Array.isArray(response.data) ? response.data : []
      // Newest first: keep the stored cursor until the last batch.
      yield { records: actions, state: { cursor: state.cursor } }
      if (actions.length < ACTIONS_PAGE) {
        break
      }
      before = actions[actions.length - 1].id
    }
  }
  // The runtime stores the newest action date seen.
  yield { records: [], state: {} }
}

export const trello = defineConnector({
  spec: {
    id: 'trello',
    name: 'Trello',
    category: 'project-management',
    description: 'Boards, lists, cards and members from Trello, with card assignments and board activity.',
    docsUrl: 'https://developer.atlassian.com/cloud/trello/rest/',
    auth: [
      {
        type: 'apiKey',
        label: 'Token',
        in: 'query',
        name: 'token',
        help: 'trello.com/power-ups/admin → your Power-Up → API key. Generate a token from that page with the authorize link using scope=read and expiration=never; paste the token here and the API key in the config.'
      }
    ],
    config: {
      apiKey: {
        label: 'API key',
        placeholder: '32 hex characters',
        help: 'The API key of your Trello Power-Up (trello.com/power-ups/admin → API key). The token must be generated for this key.'
      }
    },
    baseUrl: 'https://api.trello.com',
    // 100 requests per 10 seconds per token.
    rateLimit: { requestsPerSecond: 8 },
    test: { request: { path: `${API}/members/me`, query: { key: '{{config.apiKey}}', fields: 'username' } }, account: '$.username' },
    streams: {
      boards: {
        label: 'TRELLO_BOARD',
        description: 'Boards of the member, closed ones included.',
        request: { path: `${API}/members/me/boards`, query: { key: '{{config.apiKey}}', filter: 'all', fields: BOARD_FIELDS } },
        records: '$',
        id: '$.id',
        fields: { types: { dateLastActivity: 'datetime' } }
      },
      lists: {
        label: 'TRELLO_LIST',
        description: 'Lists of every board, archived ones included.',
        // The read hook walks the boards.
        request: { path: `${API}/members/me/boards` },
        records: '$',
        id: '$.id',
        relations: [{ type: 'ON_BOARD', target: 'boards', path: '$.idBoard' }]
      },
      cards: {
        label: 'TRELLO_CARD',
        description: 'Cards of every board, archived ones included.',
        request: { path: `${API}/members/me/boards` },
        records: '$',
        id: '$.id',
        fields: { omit: ['idMembers'], types: { due: 'datetime', start: 'datetime', dateLastActivity: 'datetime' } },
        relations: [
          { type: 'IN_LIST', target: 'lists', path: '$.idList' },
          { type: 'ON_BOARD', target: 'boards', path: '$.idBoard' },
          { type: 'ASSIGNED_TO', target: 'members', path: '$.idMembers' }
        ]
      },
      members: {
        label: 'TRELLO_MEMBER',
        description: 'Members of the boards.',
        request: { path: `${API}/members/me/boards` },
        records: '$',
        id: '$.id',
        fields: { omit: ['idBoards'] },
        relations: [{ type: 'MEMBER_OF', target: 'boards', path: '$.idBoards' }]
      },
      actions: {
        label: 'TRELLO_ACTION',
        description: 'Board activity: card moves, comments, changes.',
        optional: true,
        request: { path: `${API}/members/me/boards` },
        records: '$',
        id: '$.id',
        incremental: { cursorField: '$.date', format: 'iso', lookbackSeconds: 60 },
        fields: { omit: ['memberCreator', 'limits', 'appCreator'], types: { date: 'datetime' } },
        relations: [
          { type: 'PERFORMED_BY', target: 'members', path: '$.idMemberCreator' },
          { type: 'ON_CARD', target: 'cards', path: '$.data.card.id' },
          { type: 'ON_BOARD', target: 'boards', path: '$.data.board.id' }
        ]
      }
    }
  },
  hooks: {
    read(stream, state, ctx) {
      switch (stream.name) {
        case 'lists':
          return readPerBoard(ctx.http, ctx.connection, (board) => `${API}/boards/${board}/lists`, {
            filter: 'all',
            fields: 'name,closed,idBoard,pos'
          })
        case 'cards':
          return readPerBoard(ctx.http, ctx.connection, (board) => `${API}/boards/${board}/cards/all`, { fields: CARD_FIELDS })
        case 'members':
          return readMembers(ctx.http, ctx.connection)
        case 'actions':
          return readActions(ctx.http, ctx.connection, state, stream.spec.incremental?.lookbackSeconds ?? 60)
        default:
          return undefined
      }
    },
    transform(stream, record) {
      if (stream === 'cards' && Array.isArray(record?.labels)) {
        return { ...record, labels: record.labels.map((label: any) => label?.name || label?.color).filter(Boolean) }
      }
      return record
    }
  }
})
