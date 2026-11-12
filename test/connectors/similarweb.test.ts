import { describe, expect, it } from 'vitest'

import { configuredDomains, monthRange, similarweb } from '../../src/connectors/similarweb'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const connection = (config: Record<string, unknown> = {}): ConnectionContext => ({
  config: { domains: 'https://www.example.com/, example.org', ...config },
  credentials: { type: 'apiKey', apiKey: 'sw-key' }
})

const capabilities = {
  path: '/capabilities',
  body: {
    remaining_hits: 1000,
    web_desktop_data: { snapshot_interval: { start_date: '2021-01-01', end_date: '2024-03-31' } },
    web_mobile_data: { snapshot_interval: { start_date: '2021-01-01', end_date: '2024-02-29' } }
  }
}

const metric = (name: string, values: number[]) => ({
  path: new RegExp(`/v1/website/[^/]+/total-traffic-and-engagement/${name}$`),
  respond: () => ({
    body: {
      meta: { status: 'Success' },
      [name.replace(/-/g, '_')]: values.map((value, index) => ({ date: `2024-0${index + 1}-01`, [name.replace(/-/g, '_')]: value }))
    }
  })
})

describe('similarweb', () => {
  it('parses as a beta connector', () => {
    const spec = parseConnectorSpec(similarweb.spec)
    expect(Object.keys(spec.streams)).toEqual(['domains', 'domain_months'])
    expect(spec.streams.domain_months.label).toBe('SIMILARWEB_DOMAIN_MONTH')
    expect(similarweb.beta).toBe(true)
  })

  it('normalizes domains and month ranges', () => {
    expect(configuredDomains({ domains: 'https://www.Example.com/path, bad, example.com' })).toEqual(['example.com'])
    const now = new Date('2024-05-15T00:00:00Z')
    expect(monthRange({ historyMonths: '3' }, undefined, '2024-03', now)).toEqual({ start: '2024-01', end: '2024-03' })
    expect(monthRange({}, '2024-02-01', '2024-12', now)).toEqual({ start: '2024-02', end: '2024-04' })
    expect(monthRange({}, '2024-05-01', '2024-12', now)).toBeUndefined()
  })

  it('tests with the free capabilities call', async () => {
    const { fetch, runtime } = mockRuntime([capabilities])
    await runtime.test(similarweb, connection())
    expect(new URL(fetch.calls[0].url).searchParams.get('api_key')).toBe('sw-key')
  })

  it('lists the configured domains without calling the API', async () => {
    const { fetch, runtime } = mockRuntime([])
    const domains = records(await readAll(runtime, similarweb, connection(), 'domains'))
    expect(domains.map((domain) => domain.externalId)).toEqual(['example.com', 'example.org'])
    expect(fetch.calls).toHaveLength(0)
  })

  it('merges four metrics into one record per domain and month', async () => {
    const { fetch, runtime } = mockRuntime([
      capabilities,
      metric('visits', [1000.5, 2000]),
      metric('pages-per-visit', [3.5, 4]),
      metric('average-visit-duration', [120, 130]),
      metric('bounce-rate', [0.5, 0.4])
    ])
    const batches = await readAll(runtime, similarweb, connection({ country: 'US' }), 'domain_months', { cursor: '2024-01-01' })
    // Capabilities, then 4 metrics × 2 domains.
    expect(fetch.calls).toHaveLength(9)
    const query = new URL(fetch.calls[1].url).searchParams
    expect(query.get('start_date')).toBe('2024-01')
    // The mobile data ends in February, so that is the last month asked for.
    expect(query.get('end_date')).toBe('2024-02')
    expect(query.get('country')).toBe('us')
    expect(query.get('granularity')).toBe('monthly')
    const all = records(batches)
    expect(all).toHaveLength(4)
    expect(all[0]).toMatchObject({
      externalId: 'example.com:us:2024-01',
      properties: { visits: 1000.5, pages_per_visit: 3.5, average_visit_duration: 120, bounce_rate: 0.5, month: '2024-01' }
    })
    expect(all[0].links).toEqual([{ type: 'TRAFFIC_OF', target: 'domains', direction: 'out', externalIds: ['example.com'] }])
    expect(batches[0].state.cursor).toBe('2024-01-01')
    expect(batches.at(-1)!.state.cursor).toBe('2024-02-01')
  })
})
