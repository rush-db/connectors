import type { StreamSpec } from '../spec'
import { defineConnector, type ConnectorHttp, type StreamState } from '../types'

/*
 * Similarweb REST API, the `api.similarweb.com/v1/website/…` endpoints
 * documented as API version 4.0 (developers.similarweb.com). Similarweb has
 * since published API V5 (docs.similarweb.com); its docs call V4 "older" but
 * announce no retirement date, and the v1 endpoints below are still in the
 * current V4 reference. Revisit when V5 replaces them.
 *
 * Website traffic is query-based: per configured domain, the read hook asks
 * the four total-traffic-and-engagement endpoints (visits, pages per visit,
 * average visit duration, bounce rate; desktop and mobile web combined) for a
 * range of months and merges them into one record per domain, country and
 * month with a stable id. Each call costs one hit (or one data credit per
 * result) from the account's plan; `/capabilities` is free and gives the
 * latest month with data, so a run never asks for a month that is not out.
 *
 *   GET /v1/website/{domain}/total-traffic-and-engagement/visits
 *       ?start_date=YYYY-MM&end_date=YYYY-MM&country=world&granularity=monthly&main_domain_only=false
 *       → { meta, visits: [{ date: '2024-01-01', visits: 123.4 }] }
 */

/** A list setting as values: an array, or a comma/space separated string. */
function listSetting(value: unknown): string[] {
  const list =
    Array.isArray(value) ? value.map(String)
    : typeof value === 'string' && value.trim() ? value.split(/[\s,]+/)
    : []
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))]
}

const METRICS = ['visits', 'pages-per-visit', 'average-visit-duration', 'bounce-rate'] as const

const month = (date: Date) => date.toISOString().slice(0, 7)

/** Domains as path segments: lower-case host names without scheme, `www.` or path. */
export function configuredDomains(config: Record<string, unknown>): string[] {
  return [
    ...new Set(
      listSetting(config.domains)
        .map((domain) =>
          domain
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/[/?#].*$/, '')
        )
        .filter((domain) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain))
    )
  ]
}

const countryOf = (config: Record<string, unknown>) => {
  const country = String(config.country ?? 'world').toLowerCase()
  return /^[a-z]{2}$|^world$/.test(country) ? country : 'world'
}

/** Months to read: from the cursor's month (re-read, data can be restated) or the configured history, up to the latest available. */
export function monthRange(
  config: Record<string, unknown>,
  cursor: unknown,
  latest: string,
  now = new Date()
): { start: string; end: string } | undefined {
  const lastFull = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const end = month(lastFull) < latest ? month(lastFull) : latest
  let start: string
  if (typeof cursor === 'string' && /^\d{4}-\d{2}/.test(cursor)) {
    start = cursor.slice(0, 7)
  } else {
    const months = Number(config.historyMonths ?? 12)
    const first = new Date(`${end}-01T00:00:00Z`)
    first.setUTCMonth(first.getUTCMonth() - ((Number.isFinite(months) && months > 0 ? Math.floor(months) : 12) - 1))
    start = month(first)
  }
  return start <= end ? { start, end } : undefined
}

/** The latest month every web data source has, from the free capabilities endpoint. */
async function latestMonth(http: ConnectorHttp): Promise<string> {
  const response = await http.request({ url: '/capabilities' })
  const ends = ['web_desktop_data', 'web_mobile_data']
    .map((key) => response.data?.[key]?.snapshot_interval?.end_date)
    .filter((value): value is string => typeof value === 'string')
  return ends.length ? ends.sort()[0].slice(0, 7) : '9999-12'
}

async function* readDomainMonths(http: ConnectorHttp, config: Record<string, unknown>, state: StreamState) {
  const domains = configuredDomains(config)
  const country = countryOf(config)
  const range = monthRange(config, state.cursor, await latestMonth(http))
  if (!range || !domains.length) {
    yield { records: [], state: { cursor: state.cursor } }
    return
  }
  let newest = typeof state.cursor === 'string' ? state.cursor : undefined
  for (const [index, domain] of domains.entries()) {
    const byMonth = new Map<string, Record<string, unknown>>()
    for (const metric of METRICS) {
      const key = metric.replace(/-/g, '_')
      const response = await http.request({
        url: `/v1/website/${domain}/total-traffic-and-engagement/${metric}`,
        query: {
          start_date: range.start,
          end_date: range.end,
          country,
          granularity: 'monthly',
          main_domain_only: config.mainDomainOnly === 'true' ? 'true' : 'false',
          format: 'json'
        }
      })
      const rows: any[] = Array.isArray(response.data?.[key]) ? response.data[key] : []
      for (const row of rows) {
        const date = typeof row?.date === 'string' ? row.date.slice(0, 10) : undefined
        if (!date) {
          continue
        }
        const record: Record<string, unknown> = byMonth.get(date) ?? {
          id: `${domain}:${country}:${date.slice(0, 7)}`,
          domain,
          country,
          month: date.slice(0, 7),
          date
        }
        record[key] = row[key] ?? null
        byMonth.set(date, record)
      }
    }
    const records = [...byMonth.values()]
    for (const record of records) {
      if (!newest || (record.date as string) > newest) {
        newest = record.date as string
      }
    }
    yield { records, state: { cursor: index === domains.length - 1 ? newest : state.cursor } }
  }
}

const streams: Record<string, StreamSpec> = {
  domains: {
    label: 'SIMILARWEB_DOMAIN',
    description: 'The tracked domains (no API call).',
    request: { path: '/capabilities' },
    records: '$',
    id: '$.domain'
  },
  domain_months: {
    label: 'SIMILARWEB_DOMAIN_MONTH',
    description: 'Monthly visits, pages per visit, average visit duration (seconds) and bounce rate per domain, desktop and mobile web combined.',
    request: { path: '/v1/website/{domain}/total-traffic-and-engagement/visits' },
    records: '$',
    id: '$.id',
    incremental: { cursorField: '$.date', format: 'date', lookbackSeconds: 0 },
    fields: {
      types: {
        date: 'datetime',
        visits: 'number',
        pages_per_visit: 'number',
        average_visit_duration: 'number',
        bounce_rate: 'number'
      }
    },
    relations: [{ type: 'TRAFFIC_OF', target: 'domains', path: '$.domain', direction: 'out' }]
  }
}

export const similarweb = defineConnector({
  spec: {
    id: 'similarweb',
    name: 'Similarweb',
    category: 'market-intelligence',
    description:
      'Monthly website traffic and engagement (visits, pages per visit, visit duration, bounce rate) for the domains you list. Every run spends Similarweb hits or data credits.',
    docsUrl: 'https://developers.similarweb.com/reference/visits',
    auth: [
      {
        type: 'apiKey',
        label: 'API key',
        in: 'query',
        name: 'api_key',
        help: 'Similarweb → Settings → Account → API → Standard API → Generate a new API key (account admins only), then switch it on under Activation. Keys only read data; each traffic request spends hits or data credits.'
      }
    ],
    config: {
      domains: {
        label: 'Domains',
        type: 'list',
        placeholder: 'example.com, example.org',
        help: 'Websites to track, without https:// or www. Each domain costs four requests per run.'
      },
      country: {
        label: 'Country',
        required: false,
        default: 'world',
        help: 'world for worldwide, or a two-letter country code your plan includes (us, gb, de).'
      },
      historyMonths: {
        label: 'History (months)',
        required: false,
        default: '12',
        help: 'Months the first run reads (up to 37, depending on your plan). Later runs re-read from the last month they stored.'
      },
      mainDomainOnly: {
        label: 'Main domain only',
        type: 'select',
        required: false,
        options: [
          { value: 'false', label: 'Include subdomains' },
          { value: 'true', label: 'Main domain only' }
        ],
        default: 'false'
      }
    },
    baseUrl: 'https://api.similarweb.com',
    // Similarweb allows 10 requests per second.
    rateLimit: { requestsPerSecond: 5 },
    // Free: no hits or credits spent.
    test: { request: { path: '/capabilities' } },
    streams
  },
  hooks: {
    read(stream, state, ctx) {
      const config = ctx.connection.config
      if (stream.name === 'domains') {
        return (async function* () {
          yield { records: configuredDomains(config).map((domain) => ({ domain })), state: {} }
        })()
      }
      if (stream.name === 'domain_months') {
        return readDomainMonths(ctx.http, config, state)
      }
      return undefined
    }
  },
  beta: true
})
