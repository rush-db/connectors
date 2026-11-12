import type { StreamSpec } from '../spec'
import { defineConnector, type ConnectorHttp, type StreamState } from '../types'

/*
 * Sensor Tower API (https://api.sensortower.com/v1/...), authenticated with
 * an `auth_token` query parameter. Its reference
 * (app.sensortower.com/api/docs) is behind a customer login and could not be
 * read for this connector; the paths, parameters and response fields below
 * follow the maintained open-source `sensortowerR` client
 * (github.com/econosopher/sensortowerr) and should be checked against the
 * reference by someone with an account:
 *
 *   GET /v1/{os}/apps?app_ids=…                       → { apps: [...] }
 *   GET /v1/{os}/sales_report_estimates?app_ids=…&countries=…&date_granularity=…&start_date=…&end_date=…
 *       → [{ aid, cc|c, d, iu, ir, au, ar }] (iOS: iPhone/iPad units and revenue)
 *       → [{ aid, c, d, u, r }] (Android)
 *   GET /v1/{os}/ranking?category=…&chart_type=…&country=…&date=…  → { ranking: [app ids] }
 *
 * The API is query-based: nothing lists "all records", so the read hook sends
 * one request per configured app chunk, per app and country, or per chart.
 * Every request spends paid API units from the account's plan. Revenue comes
 * in cents.
 */

const DEFAULT_CHARTS: Record<string, string[]> = {
  ios: ['topfreeapplications', 'toppaidapplications', 'topgrossingapplications'],
  android: ['topselling_free', 'topselling_paid', 'topgrossing']
}

/** A list setting as values: an array, or a comma/space separated string. */
export function listSetting(value: unknown, fallback: string[] = []): string[] {
  const list =
    Array.isArray(value) ? value.map(String)
    : typeof value === 'string' && value.trim() ? value.split(/[\s,]+/)
    : fallback
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))]
}

const osOf = (config: Record<string, unknown>) => (config.os === 'android' ? 'android' : 'ios')

/** App ids become query values and record ids: numeric iTunes ids or Android package names. */
const appIds = (config: Record<string, unknown>) =>
  listSetting(config.appIds).filter((id) => /^[A-Za-z0-9._]+$/.test(id))

const countries = (config: Record<string, unknown>) =>
  listSetting(config.countries, ['US'])
    .map((country) => country.toUpperCase())
    .filter((country) => /^[A-Z]{2}$|^WW$/.test(country))

const day = (date: Date) => date.toISOString().slice(0, 10)

/** `2024-01-01T00:00:00Z` or `2024-01-01` → `2024-01-01`. */
const dayOf = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined)

/** First day to read: re-read two months before the cursor (estimates are revised), else the configured history. */
export function estimatesStart(config: Record<string, unknown>, cursor: unknown, now = new Date()): string {
  const fromCursor = dayOf(cursor)
  if (fromCursor) {
    const start = new Date(`${fromCursor}T00:00:00Z`)
    start.setUTCMonth(start.getUTCMonth() - 2, 1)
    return day(start)
  }
  const months = Number(config.historyMonths ?? 12)
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  start.setUTCMonth(start.getUTCMonth() - (Number.isFinite(months) && months > 0 ? Math.floor(months) : 12))
  return day(start)
}

/** One estimate row in a provider-neutral shape: downloads and revenue (cents) summed across devices. */
export function estimateRecord(os: string, row: Record<string, any>) {
  const appId = String(row.aid ?? row.app_id ?? '')
  const country = String(row.cc ?? row.c ?? row.country ?? '')
  const date = dayOf(row.d ?? row.date)
  if (!appId || !country || !date) {
    return null
  }
  const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0) || 0)
  const ios = os === 'ios'
  return {
    id: `${os}:${appId}:${country}:${date}`,
    app_id: appId,
    os,
    country,
    date,
    downloads: ios ? num(row.iu) + num(row.au) : num(row.u),
    revenue: ios ? num(row.ir) + num(row.ar) : num(row.r),
    ...(ios ?
      { iphone_downloads: num(row.iu), ipad_downloads: num(row.au), iphone_revenue: num(row.ir), ipad_revenue: num(row.ar) }
    : {})
  }
}

async function* readApps(http: ConnectorHttp, config: Record<string, unknown>) {
  const os = osOf(config)
  const ids = appIds(config)
  // The apps endpoint takes up to 100 ids per call.
  for (let index = 0; index < ids.length; index += 100) {
    const response = await http.request({ url: `/v1/${os}/apps`, query: { app_ids: ids.slice(index, index + 100).join(',') } })
    const apps: any[] = Array.isArray(response.data?.apps) ? response.data.apps : []
    yield { records: apps.map((app) => ({ ...app, os })), state: {} }
  }
}

async function* readEstimates(http: ConnectorHttp, config: Record<string, unknown>, state: StreamState) {
  const os = osOf(config)
  const granularity = ['daily', 'weekly', 'monthly', 'quarterly'].includes(String(config.granularity)) ?
      String(config.granularity)
    : 'monthly'
  const start = estimatesStart(config, state.cursor)
  const end = day(new Date())
  const pairs = appIds(config).flatMap((appId) => countries(config).map((country) => [appId, country] as const))
  let newest = dayOf(state.cursor)
  for (const [index, [appId, country]] of pairs.entries()) {
    const response = await http.request({
      url: `/v1/${os}/sales_report_estimates`,
      query: { app_ids: appId, countries: country, date_granularity: granularity, start_date: start, end_date: end }
    })
    const rows: any[] = Array.isArray(response.data) ? response.data : []
    const records = rows.map((row) => estimateRecord(os, row)).filter((record) => record !== null)
    for (const record of records) {
      if (!newest || record.date > newest) {
        newest = record.date
      }
    }
    // The cursor moves only once every app and country is read, so an interrupted run starts over from the old one.
    const last = index === pairs.length - 1
    yield { records, state: { cursor: last ? newest : state.cursor } }
  }
  if (!pairs.length) {
    yield { records: [], state: { cursor: state.cursor } }
  }
}

async function* readRankings(http: ConnectorHttp, config: Record<string, unknown>) {
  const os = osOf(config)
  const categories = listSetting(config.categories)
  const charts = listSetting(config.chartTypes, DEFAULT_CHARTS[os])
  // Yesterday's chart: today's is not complete yet.
  const date = day(new Date(Date.now() - 86_400_000))
  for (const category of categories) {
    for (const chart of charts) {
      for (const country of countries(config)) {
        const response = await http.request({
          url: `/v1/${os}/ranking`,
          query: { category, chart_type: chart, country, date }
        })
        const ranking: unknown[] = Array.isArray(response.data?.ranking) ? response.data.ranking : []
        const ids = ranking.map(String)
        yield {
          records: [
            {
              id: `${os}:${category}:${chart}:${country}:${date}`,
              os,
              category,
              chart_type: chart,
              country,
              date,
              app_ids: ids,
              top_app_id: ids[0] ?? null
            }
          ],
          state: {}
        }
      }
    }
  }
}

const streams: Record<string, StreamSpec> = {
  apps: {
    label: 'SENSORTOWER_APP',
    description: 'Metadata of the configured apps (name, publisher, categories, ratings).',
    request: { path: '/v1/{{config.os}}/apps' },
    records: '$.apps',
    id: '$.app_id',
    fields: { types: { release_date: 'datetime', updated_date: 'datetime' } }
  },
  estimates: {
    label: 'SENSORTOWER_APP_ESTIMATE',
    description: 'Download and revenue estimates per app, country and period.',
    request: { path: '/v1/{{config.os}}/sales_report_estimates' },
    records: '$',
    id: '$.id',
    incremental: { cursorField: '$.date', format: 'date', lookbackSeconds: 0 },
    fields: {
      types: { date: 'datetime', revenue: 'cents', iphone_revenue: 'cents', ipad_revenue: 'cents' }
    },
    relations: [{ type: 'ESTIMATE_OF', target: 'apps', path: '$.app_id', direction: 'out' }]
  },
  rankings: {
    label: 'SENSORTOWER_RANKING',
    description: 'Daily store chart (top free, paid, grossing) per configured category and country.',
    request: { path: '/v1/{{config.os}}/ranking' },
    records: '$',
    id: '$.id',
    fields: { types: { date: 'datetime' } },
    relations: [{ type: 'RANKS', target: 'apps', path: '$.app_ids[*]', direction: 'out' }],
    optional: true
  }
}

export const sensorTower = defineConnector({
  spec: {
    id: 'sensor-tower',
    name: 'Sensor Tower',
    category: 'market-intelligence',
    description:
      'App metadata, download and revenue estimates and store rankings for the apps you list. Every run spends Sensor Tower API units from your plan.',
    docsUrl: 'https://app.sensortower.com/api/docs',
    auth: [
      {
        type: 'apiKey',
        label: 'API token',
        in: 'query',
        name: 'auth_token',
        help: 'Sensor Tower → Account → API settings → API token. Requires a plan with API access; requests spend API units. The token is read-only by design.'
      }
    ],
    config: {
      os: {
        label: 'Store',
        type: 'select',
        options: [
          { value: 'ios', label: 'App Store (iOS)' },
          { value: 'android', label: 'Google Play' }
        ],
        default: 'ios'
      },
      appIds: {
        label: 'App IDs',
        type: 'list',
        placeholder: '284882215, 389801252',
        help: 'App Store numeric ids or Google Play package names (com.example.app), comma separated. Each app costs requests per country on every run.'
      },
      countries: {
        label: 'Countries',
        type: 'list',
        required: false,
        default: 'US',
        help: 'Two-letter country codes (US, GB, DE) or WW for worldwide.'
      },
      granularity: {
        label: 'Estimate period',
        type: 'select',
        required: false,
        options: [
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
          { value: 'quarterly', label: 'Quarterly' }
        ],
        default: 'monthly'
      },
      historyMonths: {
        label: 'History (months)',
        required: false,
        default: '12',
        help: 'How far back the first run reads estimates. Later runs re-read the last two months, which Sensor Tower revises.'
      },
      categories: {
        label: 'Ranking categories',
        type: 'list',
        required: false,
        help: 'Store category ids for the optional rankings stream (iOS 6014 = Games, Android game). Leave empty to skip rankings.'
      },
      chartTypes: {
        label: 'Chart types',
        type: 'list',
        required: false,
        help: 'Defaults to top free, top paid and top grossing (topfreeapplications, … on iOS; topselling_free, … on Android).'
      }
    },
    baseUrl: 'https://api.sensortower.com',
    // No published per-second limit; stay slow, every call costs units.
    rateLimit: { requestsPerSecond: 2 },
    streams
  },
  hooks: {
    read(stream, state, ctx) {
      const config = ctx.connection.config
      switch (stream.name) {
        case 'apps':
          return readApps(ctx.http, config)
        case 'estimates':
          return readEstimates(ctx.http, config, state)
        case 'rankings':
          return readRankings(ctx.http, config)
        default:
          return undefined
      }
    },
    async test(ctx) {
      const [first] = appIds(ctx.connection.config)
      if (!first) {
        throw new Error('Add at least one app id')
      }
      const response = await ctx.http.request({
        url: `/v1/${osOf(ctx.connection.config)}/apps`,
        query: { app_ids: first }
      })
      const name = response.data?.apps?.[0]?.name
      return typeof name === 'string' ? { account: name } : {}
    }
  },
  beta: true
})
