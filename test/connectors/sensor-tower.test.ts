import { describe, expect, it } from 'vitest'

import { estimateRecord, estimatesStart, listSetting, sensorTower } from '../../src/connectors/sensor-tower'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const connection = (config: Record<string, unknown> = {}): ConnectionContext => ({
  config: { os: 'ios', appIds: '100000001, 100000002', countries: 'us,GB', ...config },
  credentials: { type: 'apiKey', apiKey: 'st-token' }
})

describe('sensor-tower', () => {
  it('parses as a beta market-intelligence connector', () => {
    const spec = parseConnectorSpec(sensorTower.spec)
    expect(Object.keys(spec.streams)).toEqual(['apps', 'estimates', 'rankings'])
    expect(spec.category).toBe('market-intelligence')
    expect(spec.description).toMatch(/API units/)
    expect(sensorTower.beta).toBe(true)
  })

  it('reads list settings and computes the start date', () => {
    expect(listSetting('a, b a')).toEqual(['a', 'b'])
    expect(listSetting(undefined, ['US'])).toEqual(['US'])
    expect(estimatesStart({}, '2024-05-01')).toBe('2024-03-01')
    expect(estimatesStart({ historyMonths: '3' }, undefined, new Date('2024-05-20T00:00:00Z'))).toBe('2024-02-01')
  })

  it('normalizes iOS and Android estimate rows', () => {
    expect(estimateRecord('ios', { aid: 1, cc: 'US', d: '2024-01-01T00:00:00Z', iu: 10, au: 5, ir: 1000, ar: 500 })).toMatchObject({
      id: 'ios:1:US:2024-01-01',
      downloads: 15,
      revenue: 1500
    })
    expect(estimateRecord('android', { aid: 'com.example.app', c: 'DE', d: '2024-01-01', u: 7, r: 300 })).toEqual({
      id: 'android:com.example.app:DE:2024-01-01',
      app_id: 'com.example.app',
      os: 'android',
      country: 'DE',
      date: '2024-01-01',
      downloads: 7,
      revenue: 300
    })
    expect(estimateRecord('ios', { aid: 1 })).toBeNull()
  })

  it('tests with the first app and sends the token as auth_token', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/v1/ios/apps', body: { apps: [{ app_id: 100000001, name: 'Example App' }] } }])
    expect(await runtime.test(sensorTower, connection())).toEqual({ account: 'Example App' })
    const url = new URL(fetch.calls[0].url)
    expect(url.origin).toBe('https://api.sensortower.com')
    expect(url.searchParams.get('auth_token')).toBe('st-token')
    expect(url.searchParams.get('app_ids')).toBe('100000001')
  })

  it('reads app metadata in one request for the configured ids', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/v1/ios/apps',
        body: {
          apps: [
            { app_id: 100000001, name: 'Example App', publisher_name: 'Example Inc.', categories: [6014], release_date: '2020-01-01T00:00:00Z' },
            { app_id: 100000002, name: 'Other App', publisher_name: 'Example Inc.', categories: [6005] }
          ]
        }
      }
    ])
    const [first, second] = records(await readAll(runtime, sensorTower, connection(), 'apps'))
    expect(new URL(fetch.calls[0].url).searchParams.get('app_ids')).toBe('100000001,100000002')
    expect(first).toMatchObject({ externalId: '100000001', properties: { name: 'Example App', os: 'ios', categories: [6014] } })
    expect(second.externalId).toBe('100000002')
  })

  it('sends one estimates request per app and country and moves the cursor on the last one', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/v1/ios/sales_report_estimates',
        respond: ({ url }) => ({
          body: [
            {
              aid: Number(url.searchParams.get('app_ids')),
              cc: url.searchParams.get('countries'),
              d: '2024-04-01T00:00:00Z',
              iu: 100,
              au: 20,
              ir: 199900,
              ar: 100
            }
          ]
        })
      }
    ])
    const batches = await readAll(runtime, sensorTower, connection(), 'estimates', { cursor: '2024-03-01' })
    expect(fetch.calls).toHaveLength(4)
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('start_date')).toBe('2024-01-01')
    expect(query.get('date_granularity')).toBe('monthly')
    expect(fetch.calls.map((call) => new URL(call.url).searchParams.get('countries'))).toEqual(['US', 'GB', 'US', 'GB'])
    const [first] = records(batches)
    expect(first).toMatchObject({
      externalId: 'ios:100000001:US:2024-04-01',
      properties: { downloads: 120, revenue: 2000, iphone_revenue: 1999, date: '2024-04-01T00:00:00.000Z' }
    })
    expect(first.links).toEqual([{ type: 'ESTIMATE_OF', target: 'apps', direction: 'out', externalIds: ['100000001'] }])
    expect(batches.slice(0, -1).every((batch) => batch.state.cursor === '2024-03-01')).toBe(true)
    expect(batches.at(-1)!.state.cursor).toBe('2024-04-01')
  })

  it('reads one chart per category, chart type and country', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/v1/android/ranking', body: { ranking: ['com.example.a', 'com.example.b'] } }
    ])
    const batches = await readAll(
      runtime,
      sensorTower,
      connection({ os: 'android', appIds: 'com.example.a', countries: 'US', categories: 'game', chartTypes: 'topselling_free' }),
      'rankings'
    )
    expect(fetch.calls).toHaveLength(1)
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('chart_type')).toBe('topselling_free')
    expect(query.get('category')).toBe('game')
    const [chart] = records(batches)
    expect(chart.properties).toMatchObject({ top_app_id: 'com.example.a', app_ids: ['com.example.a', 'com.example.b'] })
    expect(chart.links[0]).toMatchObject({ type: 'RANKS', externalIds: ['com.example.a', 'com.example.b'] })
  })
})
