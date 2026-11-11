import { describe, expect, it } from 'vitest'

import { defineConnector, type StreamSpec } from '../src'
import { bearer, mockRuntime, readAll, records } from './helpers'

const BASE = 'https://api.example.com'

function connector(stream: Partial<StreamSpec> & { pagination: NonNullable<StreamSpec['pagination']> }, extra: Partial<StreamSpec> = {}) {
  return defineConnector({
    spec: {
      id: 'example',
      name: 'Example',
      category: 'custom',
      description: 'Test connector',
      auth: [{ type: 'bearer' }],
      baseUrl: BASE,
      streams: {
        items: {
          label: 'ITEM',
          request: { path: '/items' },
          records: '$.data',
          id: '$.id',
          ...stream,
          ...extra
        } as StreamSpec
      }
    }
  })
}

const page = (...ids: number[]) => ({ data: ids.map((id) => ({ id, updated: `2024-01-0${id}T00:00:00Z` })) })

describe('pagination', () => {
  it('cursor: sends the next token until there is none', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/items', query: { after: 'p2' }, body: { ...page(3), next: null } },
      { path: '/items', body: { ...page(1, 2), next: 'p2' } }
    ])
    const def = connector({ pagination: { type: 'cursor', next: '$.next', param: 'after' } })
    const batches = await readAll(runtime, def, bearer(), 'items')
    expect(records(batches).map((record) => record.externalId)).toEqual(['1', '2', '3'])
    expect(fetch.calls).toHaveLength(2)
    expect(fetch.calls[0].headers.authorization).toBe('Bearer test-token')
  })

  it('cursor: stops on a repeated token, a false hasMore or done', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/items', body: { ...page(1), next: 'same', more: true } }])
    await readAll(runtime, connector({ pagination: { type: 'cursor', next: '$.next', param: 'after' } }), bearer(), 'items')
    expect(fetch.calls).toHaveLength(2)

    const second = mockRuntime([{ path: '/items', body: { ...page(1), next: 'p2', more: false } }])
    await readAll(
      second.runtime,
      connector({ pagination: { type: 'cursor', next: '$.next', param: 'after', hasMore: '$.more' } }),
      bearer(),
      'items'
    )
    expect(second.fetch.calls).toHaveLength(1)

    const third = mockRuntime([{ path: '/items', body: { ...page(1), next: 'p2', end: true } }])
    await readAll(
      third.runtime,
      connector({ pagination: { type: 'cursor', next: '$.next', param: 'after', done: '$.end' } }),
      bearer(),
      'items'
    )
    expect(third.fetch.calls).toHaveLength(1)
  })

  it('cursor in the body sets a dotted parameter as a nested field', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/items',
        respond: ({ body }: any) =>
          body?.pagination?.starting_after ? { body: page(2) } : { body: { ...page(1), next: 'c2' } }
      }
    ])
    const def = connector(
      { pagination: { type: 'cursor', next: '$.next', param: 'pagination.starting_after', in: 'body' } },
      { request: { method: 'POST', path: '/items', body: { pagination: { per_page: 1 } } } }
    )
    const batches = await readAll(runtime, def, bearer(), 'items')
    expect(records(batches)).toHaveLength(2)
    expect(fetch.calls[1].body).toEqual({ pagination: { per_page: 1, starting_after: 'c2' } })
  })

  it('lastId: starts after the last record while hasMore is true', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/items', query: { starting_after: '2' }, body: { ...page(3), has_more: false } },
      { path: '/items', body: { ...page(1, 2), has_more: true } }
    ])
    const def = connector({ pagination: { type: 'lastId', param: 'starting_after', hasMore: '$.has_more' } })
    expect(records(await readAll(runtime, def, bearer(), 'items'))).toHaveLength(3)
    expect(fetch.calls).toHaveLength(2)
  })

  it('offset: moves by the page size and stops on a short page', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/items', query: { offset: '0' }, body: page(1, 2) },
      { path: '/items', query: { offset: '2' }, body: page(3) }
    ])
    const def = connector({ pagination: { type: 'offset', param: 'offset', limitParam: 'limit', limit: 2 } })
    expect(records(await readAll(runtime, def, bearer(), 'items'))).toHaveLength(3)
    expect(new URL(fetch.calls[0].url).searchParams.get('limit')).toBe('2')
    expect(fetch.calls).toHaveLength(2)
  })

  it('page: counts pages from start', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/items', query: { page: '1' }, body: page(1, 2) },
      { path: '/items', query: { page: '2' }, body: page(3) }
    ])
    const def = connector({ pagination: { type: 'page', param: 'page', sizeParam: 'per_page', size: 2 } })
    expect(records(await readAll(runtime, def, bearer(), 'items'))).toHaveLength(3)
    expect(fetch.calls).toHaveLength(2)
  })

  it('linkHeader: follows rel="next"', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/items', query: { page: '2' }, body: page(2) },
      { path: '/items', headers: { link: `<${BASE}/items?page=2>; rel="next", <${BASE}/items?page=9>; rel="last"` }, body: page(1) }
    ])
    expect(records(await readAll(runtime, connector({ pagination: { type: 'linkHeader' } }), bearer(), 'items'))).toHaveLength(2)
    expect(fetch.calls[1].url).toBe(`${BASE}/items?page=2`)
  })

  it('nextUrl: follows the URL in the body until done, relative URLs included', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/items/next', body: { ...page(2), next: '/items/next', end: true } },
      { path: '/items', body: { ...page(1), next: '/items/next', end: false } }
    ])
    const def = connector({ pagination: { type: 'nextUrl', next: '$.next', done: '$.end' } })
    expect(records(await readAll(runtime, def, bearer(), 'items'))).toHaveLength(2)
    expect(fetch.calls).toHaveLength(2)
  })

  it('nextUrl: refuses to send credentials to another origin', async () => {
    const { runtime } = mockRuntime([{ path: '/items', body: { ...page(1), next: 'https://evil.example.net/steal' } }])
    const def = connector({ pagination: { type: 'nextUrl', next: '$.next' } })
    await expect(readAll(runtime, def, bearer(), 'items')).rejects.toThrow(/another origin/)
  })

  it('stops at maxRecords', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/items', body: { ...page(1, 2, 3), next: 'more' } }])
    const def = connector({ pagination: { type: 'cursor', next: '$.next', param: 'after' } })
    const batches = await readAll(runtime, def, bearer(), 'items', {}, { maxRecords: 2 })
    expect(records(batches)).toHaveLength(2)
    expect(fetch.calls).toHaveLength(1)
  })
})

describe('incremental', () => {
  const def = connector(
    { pagination: { type: 'cursor', next: '$.next', param: 'after' } },
    {
      incremental: {
        cursorField: '$.updated',
        request: { query: { since: '{{cursor|iso}}' } },
        lookbackSeconds: 60
      }
    }
  )

  it('advances the cursor only on the last batch', async () => {
    const { runtime } = mockRuntime([
      { path: '/items', query: { after: 'p2' }, body: page(2) },
      { path: '/items', body: { ...page(3, 1), next: 'p2' } }
    ])
    const batches = await readAll(runtime, def, bearer(), 'items')
    expect(batches[0].state).toEqual({
      cursor: undefined,
      page: { token: 'p2' },
      extra: { maxCursor: '2024-01-03T00:00:00Z' }
    })
    expect(batches[1].state).toEqual({ cursor: '2024-01-03T00:00:00Z' })
  })

  it('sends the stored cursor minus the lookback', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/items', body: page(5) }])
    const batches = await readAll(runtime, def, bearer(), 'items', { cursor: '2024-01-04T00:00:00.000Z' })
    expect(new URL(fetch.calls[0].url).searchParams.get('since')).toBe('2024-01-03T23:59:00.000Z')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-05T00:00:00Z')
  })

  it('omits the cursor parameter on a full read', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/items', body: page(1) }])
    await readAll(runtime, def, bearer(), 'items', { cursor: '2024-01-04T00:00:00Z' }, { full: true })
    expect(new URL(fetch.calls[0].url).searchParams.has('since')).toBe(false)
  })

  it('resumes from the page state of an interrupted run', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/items', query: { after: 'p2' }, body: page(2) }])
    const batches = await readAll(runtime, def, bearer(), 'items', {
      cursor: '2024-01-01T00:00:00Z',
      page: { token: 'p2' },
      extra: { maxCursor: '2024-01-09T00:00:00Z' }
    })
    expect(fetch.calls).toHaveLength(1)
    expect(new URL(fetch.calls[0].url).searchParams.get('since')).toBe('2023-12-31T23:59:00.000Z')
    expect(batches[0].state).toEqual({ cursor: '2024-01-09T00:00:00Z' })
  })

  it('uses the incremental pagination once a cursor exists', async () => {
    const searchDef = connector(
      { pagination: { type: 'cursor', next: '$.next', param: 'after' } },
      {
        incremental: {
          cursorField: '$.updated',
          request: { method: 'POST', path: '/items/search', body: { since: '{{cursor|unix}}' } },
          pagination: { type: 'cursor', next: '$.next', param: 'after', in: 'body' }
        }
      }
    )
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/items/search',
        respond: ({ body }: any) => (body.after ? { body: page(4) } : { body: { ...page(3), next: 's2' } })
      }
    ])
    const batches = await readAll(runtime, searchDef, bearer(), 'items', { cursor: '2024-01-02T00:00:00Z' })
    expect(records(batches)).toHaveLength(2)
    expect(fetch.calls[0].body).toEqual({ since: 1704153540 })
    expect(fetch.calls[1].body).toEqual({ since: 1704153540, after: 's2' })
  })
})

describe('hooks', () => {
  it('a read hook may keep the old cursor explicitly, even when it is undefined', async () => {
    const def = defineConnector({
      spec: connector({ pagination: { type: 'none' } }, { incremental: { cursorField: '$.updated' } }).spec,
      hooks: {
        async *read() {
          yield { records: page(9).data, state: { cursor: undefined, page: { n: 1 } } }
          yield { records: page(8).data, state: {} }
        }
      }
    })
    const { runtime } = mockRuntime([])
    const batches = await readAll(runtime, def, bearer(), 'items')
    expect(batches[0].state).toEqual({ cursor: undefined, page: { n: 1 } })
    expect(batches[1].state).toEqual({ cursor: '2024-01-09T00:00:00Z' })
  })

  it('transform can drop records and discover adds streams', async () => {
    const def = defineConnector({
      spec: connector({ pagination: { type: 'none' } }).spec,
      hooks: {
        async discover() {
          return { extra: { label: 'EXTRA', request: { path: '/extra' }, records: '$', id: '$.id' } }
        },
        transform: (_stream, record) => (record.id === 2 ? null : record)
      }
    })
    const { runtime } = mockRuntime([
      { path: '/items', body: page(1, 2) },
      { path: '/extra', body: [{ id: 'x' }] }
    ])
    expect(Object.keys(await runtime.streams(def, bearer()))).toEqual(['items', 'extra'])
    expect(records(await readAll(runtime, def, bearer(), 'items')).map((record) => record.externalId)).toEqual(['1'])
    expect(records(await readAll(runtime, def, bearer(), 'extra'))).toHaveLength(1)
    await expect(readAll(runtime, def, bearer(), 'nope')).rejects.toThrow(/Unknown stream/)
  })
})
