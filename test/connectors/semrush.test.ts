import { describe, expect, it } from 'vitest'

import { parseReport, semrush } from '../../src/connectors/semrush'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const connection = (config: Record<string, unknown> = {}): ConnectionContext => ({
  config: { domains: 'example.com', database: 'uk', keywordLimit: '2', ...config },
  credentials: { type: 'apiKey', apiKey: 'sr-key' }
})

describe('semrush', () => {
  it('parses as a beta connector with keywords optional', () => {
    const spec = parseConnectorSpec(semrush.spec)
    expect(Object.keys(spec.streams)).toEqual(['domains', 'keywords'])
    expect(spec.streams.keywords.optional).toBe(true)
    expect(semrush.beta).toBe(true)
  })

  it('parses CSV-like reports by position', () => {
    expect(parseReport('Keyword;Url\nfoo;https://example.com/a;b\nbar;https://example.com/', ['keyword', 'url'])).toEqual([
      { keyword: 'foo', url: 'https://example.com/a;b' },
      { keyword: 'bar', url: 'https://example.com/' }
    ])
    expect(parseReport('ERROR 50 :: NOTHING FOUND', ['keyword'])).toEqual([])
    expect(() => parseReport('ERROR 132 :: API UNITS BALANCE IS ZERO', ['keyword'])).toThrow(/ERROR 132/)
  })

  it('tests with the free unit balance call', async () => {
    const { fetch, runtime } = mockRuntime([{ path: /www\.semrush\.com\/users\/countapiunits\.html$/, body: 125000 }])
    expect(await runtime.test(semrush, connection())).toEqual({})
    expect(new URL(fetch.calls[0].url).searchParams.get('key')).toBe('sr-key')
  })

  it('reads the domain overview', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/',
        query: { type: 'domain_rank' },
        body: 'Domain;Rank;Organic Keywords;Organic Traffic;Organic Cost;Adwords Keywords;Adwords Traffic;Adwords Cost\nexample.com;24041;5249;37332;143496;0;0;0\n'
      }
    ])
    const [domain] = records(await readAll(runtime, semrush, connection(), 'domains'))
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('database')).toBe('uk')
    expect(query.get('export_columns')).toBe('Dn,Rk,Or,Ot,Oc,Ad,At,Ac')
    expect(domain).toMatchObject({
      externalId: 'example.com:uk',
      properties: { domain: 'example.com', database: 'uk', rank: 24041, organic_traffic: 37332, adwords_cost: 0 }
    })
  })

  it('reads top keywords and links them to the domain', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/',
        query: { type: 'domain_organic' },
        body:
          'Keyword;Position;Previous Position;Position Difference;Search Volume;CPC;Url;Traffic (%);Traffic Cost (%);Competition;Number of Results;Trends\n' +
          'example widgets;1;2;1;5400;1.25;https://example.com/widgets;12.5;10.1;0.4;1200000;0.8,1.0,0.9\n' +
          'buy widgets;3;3;0;880;2.10;https://example.com/buy;3.2;4.0;0.9;450000;1.0,1.0\n'
      }
    ])
    const [first, second] = records(await readAll(runtime, semrush, connection(), 'keywords'))
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('display_limit')).toBe('2')
    expect(query.get('display_sort')).toBe('tr_desc')
    expect(first).toMatchObject({
      externalId: 'example.com:uk:example widgets',
      properties: { keyword: 'example widgets', position: 1, search_volume: 5400, cpc: 1.25, trend: [0.8, 1, 0.9] }
    })
    expect(first.properties).not.toHaveProperty('domain_id')
    expect(first.links).toEqual([{ type: 'RANKS_FOR', target: 'domains', direction: 'in', externalIds: ['example.com:uk'] }])
    expect(second.properties.position_difference).toBe(0)
  })

  it('treats an empty report answered with an error status as no rows', async () => {
    const { runtime } = mockRuntime([{ path: '/', status: 400, body: 'ERROR 50 :: NOTHING FOUND' }])
    expect(records(await readAll(runtime, semrush, connection(), 'domains'))).toEqual([])
  })
})
