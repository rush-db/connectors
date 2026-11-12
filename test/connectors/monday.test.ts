import { describe, expect, it } from 'vitest'

import { monday } from '../../src/connectors/monday'
import { parseConnectorSpec } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const item = (id: string) => ({
  id,
  name: `Item ${id}`,
  state: 'active',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
  creator_id: 'u1',
  group: { id: 'topics', title: 'This week' },
  board: { id: 'b1' },
  parent_item: null,
  column_values: [
    { id: 'status', type: 'status', text: 'Working on it', column: { title: 'Status' } },
    { id: 'date4', type: 'date', text: '2024-02-01', column: { title: 'Due date' } },
    { id: 'text', type: 'text', text: '', column: { title: 'Notes' } }
  ]
})

describe('monday', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(monday.spec).streams)).toEqual(['boards', 'items', 'users'])
  })

  it('tests with the token as is and a pinned API version', async () => {
    const { fetch, runtime } = mockRuntime([{ method: 'POST', path: '/v2', body: { data: { me: { id: '1' }, account: { name: 'Acme' } } } }])
    expect(await runtime.test(monday, bearer())).toEqual({ account: 'Acme' })
    expect(fetch.calls[0].headers.authorization).toBe('test-token')
    expect(fetch.calls[0].headers['api-version']).toBe('2026-10')
  })

  it('pages boards through GraphQL variables', async () => {
    const board = (id: string) => ({ id, name: `Board ${id}`, state: 'active', updated_at: '2024-01-01T00:00:00Z', owners: [{ id: 'u1' }] })
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/v2',
        respond: ({ body }: any) => ({
          body: { data: { boards: body.variables.page === 1 ? Array.from({ length: 100 }, (_, n) => board(String(n))) : [board('100')] } }
        })
      }
    ])
    const batches = await readAll(runtime, monday, bearer(), 'boards')
    expect(fetch.calls.map((call: any) => call.body.variables)).toEqual([
      { page: 1, limit: 100 },
      { page: 2, limit: 100 }
    ])
    const all = records(batches)
    expect(all).toHaveLength(101)
    expect(all[0].properties).toEqual({ name: 'Board 0', state: 'active', updated_at: '2024-01-01T00:00:00.000Z', external_id: '0' })
    expect(all[0].links).toEqual([{ type: 'OWNED_BY', target: 'users', direction: 'out', externalIds: ['u1'] }])
  })

  it('reads items per board with items_page and next_items_page, columns flattened', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/v2',
        respond: ({ body }: any) => {
          if (body.query.includes('next_items_page')) {
            return { body: { data: { next_items_page: { cursor: null, items: [item('2')] } } } }
          }
          if (body.query.includes('items_page')) {
            return { body: { data: { boards: [{ items_page: { cursor: 'cur-1', items: [item('1')] } }] } } }
          }
          return { body: { data: { boards: [{ id: 'b1' }] } } }
        }
      }
    ])
    const batches = await readAll(runtime, monday, bearer(), 'items')
    expect((fetch.calls[1].body as any).variables).toEqual({ board: ['b1'], limit: 500 })
    expect((fetch.calls[2].body as any).variables).toEqual({ cursor: 'cur-1', limit: 500 })
    const [first, second] = records(batches)
    expect(first.properties).toEqual({
      name: 'Item 1',
      state: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
      creator_id: 'u1',
      board_id: 'b1',
      group_id: 'topics',
      group_title: 'This week',
      parent_item_id: null,
      columns_status: 'Working on it',
      columns_due_date: '2024-02-01',
      columns_notes: null,
      external_id: '1'
    })
    expect(first.links).toEqual([
      { type: 'ON_BOARD', target: 'boards', direction: 'out', externalIds: ['b1'] },
      { type: 'CREATED_BY', target: 'users', direction: 'out', externalIds: ['u1'] }
    ])
    expect(second.externalId).toBe('2')
  })

  it('fails on GraphQL errors returned with HTTP 200', async () => {
    const { runtime } = mockRuntime([{ method: 'POST', path: '/v2', body: { errors: [{ message: 'Complexity budget exhausted' }] } }])
    await expect(readAll(runtime, monday, bearer(), 'items')).rejects.toThrow('Complexity budget exhausted')
  })
})
