import { describe, expect, it } from 'vitest'

import { posthog } from '../../src/connectors/posthog'
import { parseConnectorSpec } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const connection = (host = 'eu.posthog.com') => bearer({ host, projectId: '42' })
const base = 'https://eu.posthog.com/api/projects/42'

const person = (n: number) => ({
  id: n,
  uuid: `0190a000-0000-7000-8000-00000000000${n}`,
  name: `user${n}@example.com`,
  distinct_ids: [`d${n}`, `anon-${n}`],
  properties: { email: `user${n}@example.com`, plan: 'pro', $initial_geoip: { country: 'DE' } },
  created_at: '2024-01-01T00:00:00Z',
  last_seen_at: '2024-02-01T12:00:00Z'
})

describe('posthog', () => {
  it('parses with optional events, insights and dashboards', () => {
    const spec = parseConnectorSpec(posthog.spec)
    expect(Object.keys(spec.streams)).toEqual(['persons', 'cohorts', 'feature_flags', 'insights', 'dashboards', 'events'])
    expect(spec.streams.events.optional).toBe(true)
    expect(spec.streams.persons.optional).toBeUndefined()
    expect(spec.category).toBe('analytics')
  })

  it('tests against the configured host and project', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/projects/42/feature_flags/', body: { results: [] } }])
    await runtime.test(posthog, connection())
    expect(fetch.calls[0].url).toBe(`${base}/feature_flags/?limit=1`)
    expect(fetch.calls[0].headers.authorization).toBe('Bearer test-token')
  })

  it('backfills persons over next URLs', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/api/projects/42/persons/',
        query: { offset: '1' },
        body: { results: [person(2)], next: null }
      },
      {
        path: '/api/projects/42/persons/',
        body: { results: [person(1)], next: `${base}/persons/?limit=100&offset=1` }
      }
    ])
    const batches = await readAll(runtime, posthog, connection(), 'persons')
    const [first, second] = records(batches)
    expect(fetch.calls).toHaveLength(2)
    expect(first.externalId).toBe(person(1).uuid)
    expect(first.properties).toMatchObject({
      person_id: 1,
      distinct_ids: ['d1', 'anon-1'],
      properties_email: 'user1@example.com',
      properties_initial_geoip: '{"country":"DE"}',
      created_at: '2024-01-01T00:00:00.000Z'
    })
    expect(second.externalId).toBe(person(2).uuid)
  })

  it('links insights to dashboards and filters by last modification once a cursor exists', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/api/projects/42/insights/',
        body: {
          results: [
            { id: 7, short_id: 'abc', name: 'Signups', dashboards: [3, 4], deleted: false, last_modified_at: '2024-03-02T10:00:00Z', result: [1, 2] }
          ],
          next: null
        }
      }
    ])
    const batches = await readAll(runtime, posthog, connection(), 'insights', { cursor: '2024-03-01T12:00:00Z' })
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('date_from')).toBe('2024-02-29')
    expect(query.get('basic')).toBe('true')
    const [insight] = records(batches)
    expect(insight.links).toEqual([{ type: 'ON_DASHBOARD', target: 'dashboards', direction: 'out', externalIds: ['3', '4'] }])
    expect(insight.properties).not.toHaveProperty('result')
    expect(batches.at(-1)!.state.cursor).toBe('2024-03-02T10:00:00Z')
  })

  it('marks deleted feature flags as tombstones', async () => {
    const { runtime } = mockRuntime([
      {
        path: '/api/projects/42/feature_flags/',
        body: { results: [{ id: 1, key: 'beta', deleted: true, filters: { groups: [] } }], next: null }
      }
    ])
    const [flag] = records(await readAll(runtime, posthog, connection(), 'feature_flags'))
    expect(flag).toMatchObject({ externalId: '1', deleted: true })
  })

  it('reads events after the cursor with a lookback', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/api/projects/42/events/',
        body: {
          results: [
            { id: 'e1', event: '$pageview', distinct_id: 'd1', timestamp: '2024-03-01T12:05:00Z', properties: { $current_url: 'https://example.com/' }, elements: [] }
          ],
          next: null
        }
      }
    ])
    const batches = await readAll(runtime, posthog, connection(), 'events', { cursor: '2024-03-01T12:00:00Z' })
    expect(new URL(fetch.calls[0].url).searchParams.get('after')).toBe('2024-03-01T11:50:00.000Z')
    const [event] = records(batches)
    expect(event.properties).toMatchObject({ event: '$pageview', properties_current_url: 'https://example.com/' })
    expect(event.properties).not.toHaveProperty('elements')
    expect(batches.at(-1)!.state.cursor).toBe('2024-03-01T12:05:00Z')
  })
})
