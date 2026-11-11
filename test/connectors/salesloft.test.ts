import { describe, expect, it } from 'vitest'

import { salesloft } from '../../src/connectors/salesloft'
import { parseConnectorSpec } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const person = (id: number, updatedAt: string) => ({
  id,
  first_name: 'Test',
  last_name: `Person ${id}`,
  email_address: `person${id}@example.com`,
  title: 'Buyer',
  tags: ['inbound'],
  account: { id: 11, _href: 'https://api.salesloft.com/v2/accounts/11' },
  owner: { id: 21, _href: 'https://api.salesloft.com/v2/users/21' },
  created_at: '2024-01-01T00:00:00.000000-05:00',
  updated_at: updatedAt
})

describe('salesloft', () => {
  it('parses', () => {
    const spec = parseConnectorSpec(salesloft.spec)
    expect(Object.keys(spec.streams)).toEqual(['people', 'accounts', 'cadences', 'calls', 'emails', 'users'])
    expect(spec.streams.emails.optional).toBe(true)
    expect(spec.streams.users.incremental).toBeUndefined()
  })

  it('tests the connection', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/v2/team', body: { data: { id: 1, name: 'Example Team' } } }])
    expect(await runtime.test(salesloft, bearer())).toEqual({ account: 'Example Team' })
    expect(fetch.calls[0].headers.authorization).toBe('Bearer test-token')
  })

  it('backfills people over two pages sorted by updated_at', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/v2/people',
        query: { page: '2' },
        body: { metadata: { paging: { per_page: 100, current_page: 2, next_page: null } }, data: [person(2, '2024-01-03T00:00:00.000000Z')] }
      },
      {
        path: '/v2/people',
        body: { metadata: { paging: { per_page: 100, current_page: 1, next_page: 2 } }, data: [person(1, '2024-01-02T00:00:00.000000Z')] }
      }
    ])
    const batches = await readAll(runtime, salesloft, bearer(), 'people')
    const [first, second] = records(batches)
    expect(first.externalId).toBe('1')
    expect(first.properties).toMatchObject({
      email_address: 'person1@example.com',
      account_id: 11,
      owner_id: 21,
      tags: ['inbound'],
      created_at: '2024-01-01T05:00:00.000Z',
      external_id: '1'
    })
    expect(first.properties).not.toHaveProperty('account_href')
    expect(first.links).toEqual([
      { type: 'WORKS_AT', target: 'accounts', direction: 'out', externalIds: ['11'] },
      { type: 'OWNED_BY', target: 'users', direction: 'out', externalIds: ['21'] }
    ])
    expect(second.externalId).toBe('2')
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('sort_by')).toBe('updated_at')
    expect(query.get('sort_direction')).toBe('ASC')
    expect(query.get('per_page')).toBe('100')
    expect(query.has('updated_at[gt]')).toBe(false)
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-03T00:00:00.000000Z')
  })

  it('filters calls with updated_at[gt] from the cursor less the lookback', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/v2/activities/calls',
        body: {
          metadata: { paging: { next_page: null } },
          data: [
            {
              id: 501,
              to: '+10000000000',
              duration: 95,
              disposition: 'Connected',
              sentiment: 'Interested',
              user: { id: 21, _href: 'x' },
              called_person: { id: 1, _href: 'x' },
              cadence: { id: 31, _href: 'x' },
              updated_at: '2024-02-01T00:00:00.000Z'
            }
          ]
        }
      }
    ])
    const batches = await readAll(runtime, salesloft, bearer(), 'calls', { cursor: '2024-01-31T00:00:00.000Z' })
    expect(new URL(fetch.calls[0].url).searchParams.get('updated_at[gt]')).toBe('2024-01-30T23:59:00.000Z')
    const [call] = records(batches)
    expect(call.links.map((link) => [link.type, link.target, link.externalIds[0]])).toEqual([
      ['MADE_BY', 'users', '21'],
      ['CALLED', 'people', '1'],
      ['IN_CADENCE', 'cadences', '31']
    ])
    expect(batches.at(-1)!.state.cursor).toBe('2024-02-01T00:00:00.000Z')
  })
})
