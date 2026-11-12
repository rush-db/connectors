import type { StreamSpec } from '../spec'
import { defineConnector, type ConnectorHttp, type StreamState } from '../types'

/*
 * Trustpilot public Business Units API (developers.trustpilot.com), with the
 * API key in the `apikey` header. It reads the public profile and public
 * reviews of any business unit, so the connector tracks your own company and
 * competitors alike: category `market-intelligence` rather than `support`.
 * Answering reviews or reading private reviews (customer emails, order ids)
 * needs a business user's OAuth token and is out of scope.
 *
 *   GET /v1/business-units/{id}/profileinfo
 *   GET /v1/business-units/{id}/reviews?orderBy=createdat.desc&perPage=100&page=N
 *
 * The public reviews endpoint has no date filter, but sorts by creation date.
 * Incremental runs read newest first and stop at the first review created
 * before the stored cursor (minus a day). The cursor is a creation time, so a
 * later edit or company reply on an older review is not picked up by an
 * incremental run; a full run refreshes every review (the endpoint caps at
 * 100,000 reviews per business unit).
 *
 * The public `GET /v1/business-units/{id}` (trust score, review count) is no
 * longer in the current reference, so business units come from `profileinfo`.
 */

/** A list setting as values: an array, or a comma/space separated string. */
function listSetting(value: unknown): string[] {
  const list =
    Array.isArray(value) ? value.map(String)
    : typeof value === 'string' && value.trim() ? value.split(/[\s,]+/)
    : []
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))]
}

/** Business unit ids are 24-character hex object ids; they go into URL paths. */
export const businessUnitIds = (config: Record<string, unknown>) =>
  listSetting(config.businessUnitIds).filter((id) => /^[a-f0-9]{24}$/i.test(id))

const PER_PAGE = 100
const LOOKBACK_MS = 86_400_000

async function* readBusinessUnits(http: ConnectorHttp, config: Record<string, unknown>) {
  for (const id of businessUnitIds(config)) {
    const response = await http.request({ url: `/v1/business-units/${id}/profileinfo` })
    yield { records: [{ ...(response.data ?? {}), id }], state: {} }
  }
}

async function* readReviews(http: ConnectorHttp, config: Record<string, unknown>, state: StreamState) {
  const units = businessUnitIds(config)
  const since = typeof state.cursor === 'string' ? Date.parse(state.cursor) - LOOKBACK_MS : undefined
  let newest = typeof state.cursor === 'string' ? state.cursor : undefined
  for (const [unitIndex, unit] of units.entries()) {
    for (let page = 1; ; page++) {
      const response = await http.request({
        url: `/v1/business-units/${unit}/reviews`,
        query: { orderBy: 'createdat.desc', perPage: PER_PAGE, page, includeReportedReviews: false }
      })
      const reviews: any[] = Array.isArray(response.data?.reviews) ? response.data.reviews : []
      const fresh =
        since === undefined ? reviews : reviews.filter((review) => !(Date.parse(review?.createdAt) < since))
      for (const review of fresh) {
        if (typeof review?.createdAt === 'string' && (!newest || Date.parse(review.createdAt) > Date.parse(newest))) {
          newest = review.createdAt
        }
      }
      const done = reviews.length < PER_PAGE || fresh.length < reviews.length
      const last = done && unitIndex === units.length - 1
      yield {
        records: fresh.map((review) => ({ ...review, businessUnit: { ...(review.businessUnit ?? {}), id: unit } })),
        // Newest first: keep the old cursor until every business unit is read.
        state: { cursor: last ? newest : state.cursor }
      }
      if (done) {
        break
      }
    }
  }
  if (!units.length) {
    yield { records: [], state: { cursor: state.cursor } }
  }
}

const streams: Record<string, StreamSpec> = {
  business_units: {
    label: 'TRUSTPILOT_BUSINESS_UNIT',
    description: 'Public profile of each configured business unit (name, contact, description, claimed status).',
    request: { path: '/v1/business-units/{id}/profileinfo' },
    records: '$',
    id: '$.id',
    fields: { omit: ['links', 'socialmedia'] }
  },
  reviews: {
    label: 'TRUSTPILOT_REVIEW',
    description: 'Public reviews with stars, text, language and the company reply.',
    request: { path: '/v1/business-units/{id}/reviews' },
    records: '$',
    id: '$.id',
    incremental: { cursorField: '$.createdAt', lookbackSeconds: 0 },
    fields: {
      omit: ['links', 'consumer_links', 'business_unit_links', 'report_data'],
      types: { created_at: 'datetime', updated_at: 'datetime', experienced_at: 'datetime', stars: 'number' }
    },
    relations: [{ type: 'REVIEW_OF', target: 'business_units', path: '$.businessUnit.id', direction: 'out' }]
  }
}

export const trustpilot = defineConnector({
  spec: {
    id: 'trustpilot',
    name: 'Trustpilot',
    category: 'market-intelligence',
    description: 'Public reviews and profile of the Trustpilot business units you list: your company or competitors.',
    docsUrl: 'https://developers.trustpilot.com/business-units-api',
    auth: [
      {
        type: 'apiKey',
        label: 'API key',
        in: 'header',
        name: 'apikey',
        help: 'Trustpilot Business → Integrations → API → create an application and copy its API key. The key reads public data only.'
      }
    ],
    config: {
      businessUnitIds: {
        label: 'Business unit IDs',
        type: 'list',
        placeholder: '507f191e810c19729de860ea',
        help: '24-character ids of the business units to track. Find one with GET /v1/business-units/search?query=example.com or in Trustpilot Business → Settings.'
      }
    },
    baseUrl: 'https://api.trustpilot.com',
    // No published per-second figure; Trustpilot asks clients to back off on 429.
    rateLimit: { requestsPerSecond: 2 },
    streams
  },
  hooks: {
    read(stream, state, ctx) {
      if (stream.name === 'business_units') {
        return readBusinessUnits(ctx.http, ctx.connection.config)
      }
      if (stream.name === 'reviews') {
        return readReviews(ctx.http, ctx.connection.config, state)
      }
      return undefined
    },
    async test(ctx) {
      const [first] = businessUnitIds(ctx.connection.config)
      if (!first) {
        throw new Error('Add at least one business unit id')
      }
      const response = await ctx.http.request({ url: `/v1/business-units/${first}/profileinfo` })
      const name = response.data?.companyName
      return typeof name === 'string' ? { account: name } : {}
    }
  },
  beta: true
})
