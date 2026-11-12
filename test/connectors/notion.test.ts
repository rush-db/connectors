import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { notion } from '../../src/connectors'
import { notionValue } from '../../src/connectors/notion'
import { parseConnectorSpec, parseWebhook, verifyWebhook } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const page = (id: string, edited: string) => ({
  object: 'page',
  id,
  created_time: '2024-01-01T00:00:00.000Z',
  last_edited_time: edited,
  created_by: { object: 'user', id: 'user-1' },
  parent: { type: 'database_id', database_id: 'db-1' },
  archived: false,
  url: `https://www.notion.so/${id}`,
  properties: {
    Name: { id: 'title', type: 'title', title: [{ plain_text: 'Acme ' }, { plain_text: 'renewal' }] },
    Stage: { id: 'a', type: 'status', status: { name: 'Negotiation' } },
    Value: { id: 'b', type: 'number', number: 12000 },
    Tags: { id: 'c', type: 'multi_select', multi_select: [{ name: 'enterprise' }] },
    Owner: { id: 'd', type: 'people', people: [{ object: 'user', id: 'user-2' }] },
    Due: { id: 'e', type: 'date', date: { start: '2024-03-01', end: null } }
  }
})

const search = (filter: string, pages: Record<string, unknown>) => ({
  method: 'POST',
  path: '/v1/search',
  respond: ({ body }: any) => (body.filter.value === filter ? { body: pages[body.start_cursor ?? 'first'] } : { body: { results: [] } })
})

describe('notion', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(notion.spec).streams)).toEqual(['pages', 'databases', 'users'])
  })

  it('tests with the workspace name', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/v1/users/me', body: { bot: { workspace_name: 'Acme' } } }])
    expect(await runtime.test(notion, bearer())).toEqual({ account: 'Acme' })
    expect(fetch.calls[0].headers['notion-version']).toBe('2022-06-28')
  })

  it('backfills pages with flattened properties and parent relations', async () => {
    const { fetch, runtime } = mockRuntime([
      search('page', {
        first: { results: [page('p2', '2024-01-02T00:00:00.000Z')], has_more: true, next_cursor: 'n2' },
        n2: { results: [page('p1', '2024-01-01T00:00:00.000Z')], has_more: false, next_cursor: null }
      })
    ])
    const batches = await readAll(runtime, notion, bearer(), 'pages')
    expect(fetch.calls[1].body).toMatchObject({ start_cursor: 'n2', filter: { value: 'page' } })
    const [first] = records(batches)
    expect(first.properties).toMatchObject({
      title: 'Acme renewal',
      name: 'Acme renewal',
      stage: 'Negotiation',
      value: 12000,
      tags: ['enterprise'],
      owner: ['user-2'],
      due: '2024-03-01',
      parent_database_id: 'db-1'
    })
    expect(first.links).toEqual([
      { type: 'IN_DATABASE', target: 'databases', direction: 'out', externalIds: ['db-1'] },
      { type: 'CREATED_BY', target: 'users', direction: 'out', externalIds: ['user-1'] }
    ])
    expect(batches[0].state.cursor).toBeUndefined()
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-02T00:00:00.000Z')
  })

  it('stops an incremental read at the first older page and moves the cursor last', async () => {
    const { fetch, runtime } = mockRuntime([
      search('page', {
        first: { results: [page('p4', '2024-01-12T00:00:00.000Z')], has_more: true, next_cursor: 'n2' },
        n2: { results: [page('p3', '2024-01-11T00:00:00.000Z'), page('p0', '2023-12-01T00:00:00.000Z')], has_more: true, next_cursor: 'n3' }
      })
    ])
    const batches = await readAll(runtime, notion, bearer(), 'pages', { cursor: '2024-01-10T00:00:00.000Z' })
    expect(fetch.calls).toHaveLength(2)
    expect(records(batches).map((record) => record.externalId)).toEqual(['p4', 'p3'])
    expect(batches[0].state.cursor).toBe('2024-01-10T00:00:00.000Z')
    expect(batches[1].state.cursor).toBe('2024-01-12T00:00:00.000Z')
  })

  it('reads plain values of other property types', () => {
    expect(notionValue({ type: 'formula', formula: { type: 'number', number: 3 } })).toBe(3)
    expect(notionValue({ type: 'unique_id', unique_id: { prefix: 'T', number: 12 } })).toBe('T-12')
    expect(notionValue({ type: 'relation', relation: [{ id: 'x' }] })).toEqual(['x'])
    expect(notionValue({ type: 'checkbox', checkbox: false })).toBe(false)
  })

  it('verifies signatures and routes page events', () => {
    const spec = parseConnectorSpec(notion.spec)
    const rawBody = JSON.stringify({ id: 'evt-1', type: 'page.deleted', timestamp: '2024-01-01T00:00:00Z', entity: { id: 'p1', type: 'page' } })
    const signature = `sha256=${createHmac('sha256', 'verification-token').update(rawBody).digest('hex')}`
    expect(verifyWebhook(spec, { headers: { 'x-notion-signature': signature }, rawBody, secret: 'verification-token' })).toBe(true)
    expect(parseWebhook(spec, JSON.parse(rawBody))).toEqual([
      { id: 'evt-1', type: 'page.deleted', stream: 'pages', action: 'delete', externalId: 'p1' }
    ])
    expect(parseWebhook(spec, { id: 'evt-2', type: 'page.properties_updated', entity: { id: 'p2' } })[0].action).toBe('refetch')
  })
})
