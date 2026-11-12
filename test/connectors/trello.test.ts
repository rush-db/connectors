import { describe, expect, it } from 'vitest'

import { trello } from '../../src/connectors/trello'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const connection = (): ConnectionContext => ({ config: { apiKey: 'app-key' }, credentials: { type: 'apiKey', apiKey: 'member-token' } })

const boards = { path: '/1/members/me/boards', body: [{ id: 'b1' }, { id: 'b2' }] }

const card = (id: string, board: string) => ({
  id,
  name: `Card ${id}`,
  closed: false,
  idBoard: board,
  idList: `${board}-list`,
  idMembers: ['m1'],
  labels: [{ id: 'l', name: 'Bug', color: 'red' }, { id: 'l2', name: '', color: 'green' }],
  due: '2024-02-01T12:00:00.000Z',
  dateLastActivity: '2024-01-02T00:00:00.000Z'
})

describe('trello', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(trello.spec).streams)).toEqual(['boards', 'lists', 'cards', 'members', 'actions'])
  })

  it('tests with key and token query parameters', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/1/members/me', body: { id: 'm1', username: 'dev' } }])
    expect(await runtime.test(trello, connection())).toEqual({ account: 'dev' })
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('key')).toBe('app-key')
    expect(query.get('token')).toBe('member-token')
  })

  it('reads boards', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/1/members/me/boards', body: [{ id: 'b1', name: 'Roadmap', closed: false, dateLastActivity: '2024-01-02T00:00:00.000Z' }] }
    ])
    const [board] = records(await readAll(runtime, trello, connection(), 'boards'))
    expect(board.properties).toEqual({ name: 'Roadmap', closed: false, date_last_activity: '2024-01-02T00:00:00.000Z', external_id: 'b1' })
    expect(new URL(fetch.calls[0].url).searchParams.get('filter')).toBe('all')
  })

  it('reads cards board by board with label names and links', async () => {
    const { fetch, runtime } = mockRuntime([
      boards,
      { path: '/1/boards/b1/cards/all', body: [card('c1', 'b1')] },
      { path: '/1/boards/b2/cards/all', body: [card('c2', 'b2')] }
    ])
    const batches = await readAll(runtime, trello, connection(), 'cards')
    expect(batches).toHaveLength(2)
    expect(fetch.calls.every((call) => new URL(call.url).searchParams.get('key') === 'app-key')).toBe(true)
    const [first, second] = records(batches)
    expect(first.properties).toMatchObject({ name: 'Card c1', labels: ['Bug', 'green'], due: '2024-02-01T12:00:00.000Z', external_id: 'c1' })
    expect(first.properties).not.toHaveProperty('id_members')
    expect(first.links.map((link) => [link.type, link.externalIds])).toEqual([
      ['IN_LIST', ['b1-list']],
      ['ON_BOARD', ['b1']],
      ['ASSIGNED_TO', ['m1']]
    ])
    expect(second.externalId).toBe('c2')
  })

  it('reads lists and merges members across boards', async () => {
    const { runtime } = mockRuntime([
      boards,
      { path: '/1/boards/b1/lists', body: [{ id: 'l1', name: 'To do', idBoard: 'b1' }] },
      { path: '/1/boards/b2/lists', body: [] },
      { path: '/1/boards/b1/members', body: [{ id: 'm1', fullName: 'Test One', username: 'one' }] },
      { path: '/1/boards/b2/members', body: [{ id: 'm1', fullName: 'Test One', username: 'one' }, { id: 'm2', fullName: 'Test Two', username: 'two' }] }
    ])
    const [list] = records(await readAll(runtime, trello, connection(), 'lists'))
    expect(list.links).toEqual([{ type: 'ON_BOARD', target: 'boards', direction: 'out', externalIds: ['b1'] }])
    const members = records(await readAll(runtime, trello, connection(), 'members'))
    expect(members.map((member) => [member.externalId, member.links[0].externalIds])).toEqual([
      ['m1', ['b1', 'b2']],
      ['m2', ['b2']]
    ])
  })

  it('pages actions newest first with since and before', async () => {
    const action = (id: string, date: string) => ({ id, type: 'commentCard', date, idMemberCreator: 'm1', data: { card: { id: 'c1' }, board: { id: 'b1' }, text: 'Hi' } })
    const { fetch, runtime } = mockRuntime([
      { path: '/1/members/me/boards', body: [{ id: 'b1' }] },
      { path: '/1/boards/b1/actions', query: { before: 'a999' }, body: [action('a0', '2024-01-10T00:01:00.000Z')] },
      {
        path: '/1/boards/b1/actions',
        body: Array.from({ length: 1000 }, (_, n) => action(n === 999 ? 'a999' : `n${n}`, '2024-01-11T00:00:00.000Z'))
      }
    ])
    const batches = await readAll(runtime, trello, connection(), 'actions', { cursor: '2024-01-10T00:00:00.000Z' })
    const first = new URL(fetch.calls[1].url).searchParams
    expect(first.get('since')).toBe('2024-01-09T23:59:00.000Z')
    expect(first.get('limit')).toBe('1000')
    expect(new URL(fetch.calls[2].url).searchParams.get('before')).toBe('a999')
    expect(batches[0].state.cursor).toBe('2024-01-10T00:00:00.000Z')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-11T00:00:00.000Z')
    const last = records(batches).at(-1)!
    expect(last.links.map((link) => [link.type, link.externalIds])).toEqual([
      ['PERFORMED_BY', ['m1']],
      ['ON_CARD', ['c1']],
      ['ON_BOARD', ['b1']]
    ])
  })
})
