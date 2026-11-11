import { describe, expect, it } from 'vitest'

import { ConnectorRuntime, defineConnector } from '../src'
import { createMockFetch, noSleep } from '../src/testing'

describe('errors reported in a 200 response', () => {
  const definition = defineConnector({
    spec: {
      id: 'gql',
      name: 'GraphQL',
      category: 'custom',
      description: 'A GraphQL API',
      auth: [{ type: 'bearer' }],
      baseUrl: 'https://api.example.com',
      errors: '$.errors',
      streams: {
        items: {
          label: 'GQL_ITEM',
          request: { method: 'POST', path: '/graphql', body: { query: '{ items { id } }' } },
          records: '$.data.items',
          id: '$.id'
        }
      }
    }
  })
  const connection = { config: {}, credentials: { type: 'bearer' as const, token: 't' } }

  it('fails the read when the API reports errors', async () => {
    const fetch = createMockFetch([{ method: 'POST', path: '/graphql', body: { errors: [{ message: 'Field "x" not found' }], data: null } }])
    const runtime = new ConnectorRuntime({ fetch, sleep: noSleep, egress: () => 'any' })
    await expect(async () => {
      for await (const _batch of runtime.read(definition, connection, 'items')) {
        // drain
      }
    }).rejects.toThrow(/reported errors/)
  })

  it('reads normally when errors is empty', async () => {
    const fetch = createMockFetch([{ method: 'POST', path: '/graphql', body: { errors: [], data: { items: [{ id: 1 }] } } }])
    const runtime = new ConnectorRuntime({ fetch, sleep: noSleep, egress: () => 'any' })
    const records = []
    for await (const batch of runtime.read(definition, connection, 'items')) {
      records.push(...batch.records)
    }
    expect(records).toHaveLength(1)
  })
})
