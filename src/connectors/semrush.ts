import { ConnectorHttpError } from '../runtime/http'
import type { StreamSpec } from '../spec'
import { defineConnector, type ConnectorHttp } from '../types'

/*
 * Semrush Standard (Analytics) API, `GET https://api.semrush.com/?type=…`
 * with the API key as `key` (developer.semrush.com/api/v3/analytics). Answers
 * are CSV-like text, `;`-separated with a header line, so the read hook asks
 * for fixed `export_columns` and parses the rows by position.
 *
 *   domain_rank    Domain Overview (one database): 10 API units per line
 *   domain_organic Domain Organic Search Keywords: 10 API units per line
 *
 * Every line spends API units from the subscription, so the keyword stream is
 * optional and capped by `keywordLimit` per domain. A report with no data
 * answers `ERROR 50 :: NOTHING FOUND` and costs nothing; other `ERROR …`
 * answers (132: unit balance is zero) fail the run.
 *
 * Reports are snapshots of the current month; there is nothing to filter by
 * modification time, so every run reads them in full and upserts by id.
 */

/** A list setting as values: an array, or a comma/space separated string. */
function listSetting(value: unknown): string[] {
  const list =
    Array.isArray(value) ? value.map(String)
    : typeof value === 'string' && value.trim() ? value.split(/[\s,]+/)
    : []
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))]
}

/** Requested column codes → property names. */
const OVERVIEW_COLUMNS: Record<string, string> = {
  Dn: 'domain',
  Rk: 'rank',
  Or: 'organic_keywords',
  Ot: 'organic_traffic',
  Oc: 'organic_cost',
  Ad: 'adwords_keywords',
  At: 'adwords_traffic',
  Ac: 'adwords_cost'
}

const KEYWORD_COLUMNS: Record<string, string> = {
  Ph: 'keyword',
  Po: 'position',
  Pp: 'previous_position',
  Pd: 'position_difference',
  Nq: 'search_volume',
  Cp: 'cpc',
  Ur: 'url',
  Tr: 'traffic_share',
  Tc: 'traffic_cost_share',
  Co: 'competition',
  Nr: 'number_of_results',
  Td: 'trend'
}

export function configuredDomains(config: Record<string, unknown>): string[] {
  return listSetting(config.domains)
    .map((domain) =>
      domain
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/[/?#].*$/, '')
    )
    .filter((domain) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain))
}

const databaseOf = (config: Record<string, unknown>) => {
  const database = String(config.database ?? 'us').toLowerCase()
  return /^[a-z-]{2,10}$/.test(database) ? database : 'us'
}

/**
 * Parse a Semrush report: a header line, then one `;`-separated line per row,
 * read by position into the requested columns. A row with more cells than
 * columns had a `;` inside the URL; the extra cells are joined back into it.
 */
export function parseReport(text: unknown, columns: string[]): Array<Record<string, string>> {
  if (typeof text !== 'string') {
    return []
  }
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('ERROR 50 ')) {
    return []
  }
  if (trimmed.startsWith('ERROR')) {
    throw new Error(`Semrush answered: ${trimmed.slice(0, 200)}`)
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim())
  const urlIndex = columns.indexOf('url')
  return lines.slice(1).map((line) => {
    let cells = line.split(';')
    if (cells.length > columns.length && urlIndex >= 0) {
      const extra = cells.length - columns.length
      cells = [
        ...cells.slice(0, urlIndex),
        cells.slice(urlIndex, urlIndex + extra + 1).join(';'),
        ...cells.slice(urlIndex + extra + 1)
      ]
    }
    return Object.fromEntries(columns.map((column, index) => [column, (cells[index] ?? '').trim()]))
  })
}

async function report(http: ConnectorHttp, query: Record<string, string | number>, columns: Record<string, string>) {
  try {
    const response = await http.request({
      url: '/',
      query: { ...query, export_columns: Object.keys(columns).join(',') },
      headers: { Accept: 'text/plain, */*' }
    })
    return parseReport(response.data, Object.values(columns))
  } catch (error) {
    // Some errors come with a 4xx status and the same text body.
    if (error instanceof ConnectorHttpError && typeof error.body === 'string') {
      return parseReport(error.body, Object.values(columns))
    }
    throw error
  }
}

async function* readOverview(http: ConnectorHttp, config: Record<string, unknown>) {
  const database = databaseOf(config)
  for (const domain of configuredDomains(config)) {
    const rows = await report(http, { type: 'domain_rank', domain, database }, OVERVIEW_COLUMNS)
    yield { records: rows.map((row) => ({ ...row, id: `${domain}:${database}`, domain, database })), state: {} }
  }
}

async function* readKeywords(http: ConnectorHttp, config: Record<string, unknown>) {
  const database = databaseOf(config)
  const limit = Math.min(Math.max(Math.floor(Number(config.keywordLimit ?? 100)) || 100, 1), 10_000)
  for (const domain of configuredDomains(config)) {
    const rows = await report(
      http,
      { type: 'domain_organic', domain, database, display_limit: limit, display_sort: 'tr_desc' },
      KEYWORD_COLUMNS
    )
    yield {
      records: rows.map((row) => ({
        ...row,
        id: `${domain}:${database}:${row.keyword}`,
        domain,
        database,
        domain_id: `${domain}:${database}`,
        trend: row.trend ? row.trend.split(',').map(Number) : []
      })),
      state: {}
    }
  }
}

const number = 'number' as const

const streams: Record<string, StreamSpec> = {
  domains: {
    label: 'SEMRUSH_DOMAIN',
    description: 'Domain overview in the chosen database: Semrush rank, organic and paid keywords, traffic and traffic cost.',
    request: { path: '/', query: { type: 'domain_rank' } },
    records: '$',
    id: '$.id',
    fields: {
      types: {
        rank: number,
        organic_keywords: number,
        organic_traffic: number,
        organic_cost: number,
        adwords_keywords: number,
        adwords_traffic: number,
        adwords_cost: number
      }
    }
  },
  keywords: {
    label: 'SEMRUSH_KEYWORD',
    description: 'Top organic keywords per domain by traffic share (10 API units per keyword).',
    request: { path: '/', query: { type: 'domain_organic' } },
    records: '$',
    id: '$.id',
    fields: {
      omit: ['domain_id'],
      types: {
        position: number,
        previous_position: number,
        position_difference: number,
        search_volume: number,
        cpc: number,
        traffic_share: number,
        traffic_cost_share: number,
        competition: number,
        number_of_results: number,
        trend: number
      }
    },
    relations: [{ type: 'RANKS_FOR', target: 'domains', path: '$.domain_id', direction: 'in' }],
    optional: true
  }
}

export const semrush = defineConnector({
  spec: {
    id: 'semrush',
    name: 'Semrush',
    category: 'market-intelligence',
    description:
      'Domain overview and top organic keywords for the domains you list, in one regional database. Every run spends Semrush API units.',
    docsUrl: 'https://developer.semrush.com/api/v3/analytics/domain-reports/',
    auth: [
      {
        type: 'apiKey',
        label: 'API key',
        in: 'query',
        name: 'key',
        help: 'Semrush → Subscription info → API units → API key. Needs a Business plan with API units; the Analytics API only reads, and each report line spends units.'
      }
    ],
    config: {
      domains: {
        label: 'Domains',
        type: 'list',
        placeholder: 'example.com, example.org',
        help: 'Domains to track, without https:// or www.'
      },
      database: {
        label: 'Database',
        default: 'us',
        placeholder: 'us',
        help: 'Regional database (country): us, uk, de, fr, … See Semrush “Databases” in the API docs.'
      },
      keywordLimit: {
        label: 'Keywords per domain',
        required: false,
        default: '100',
        help: 'Top organic keywords read per domain and run (10 API units each).'
      }
    },
    baseUrl: 'https://api.semrush.com',
    rateLimit: { requestsPerSecond: 5 },
    streams
  },
  hooks: {
    read(stream, _state, ctx) {
      if (stream.name === 'domains') {
        return readOverview(ctx.http, ctx.connection.config)
      }
      if (stream.name === 'keywords') {
        return readKeywords(ctx.http, ctx.connection.config)
      }
      return undefined
    },
    async test(ctx) {
      // Free: the remaining API unit balance. Semrush documents this URL on www.semrush.com (http in the docs; https works too).
      const response = await ctx.http.request({ url: 'https://www.semrush.com/users/countapiunits.html' })
      const units = Number(String(response.data).replace(/[^\d.]/g, ''))
      if (String(response.data).trim().startsWith('ERROR') || !Number.isFinite(units)) {
        throw new Error(`Semrush answered: ${String(response.data).slice(0, 200)}`)
      }
      return {}
    }
  },
  beta: true
})
