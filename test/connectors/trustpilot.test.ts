import { describe, expect, it } from 'vitest'

import { businessUnitIds, trustpilot } from '../../src/connectors/trustpilot'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const UNIT_A = '507f191e810c19729de860ea'
const UNIT_B = '507f191e810c19729de860eb'

const connection = (units = `${UNIT_A},${UNIT_B}`): ConnectionContext => ({
  config: { businessUnitIds: units },
  credentials: { type: 'apiKey', apiKey: 'tp-key' }
})

const review = (id: string, createdAt: string, unit = UNIT_A) => ({
  id,
  stars: 4,
  title: 'Good service',
  text: 'Fast delivery.',
  language: 'en',
  createdAt,
  updatedAt: null,
  isVerified: true,
  companyReply: { text: 'Thanks!', createdAt },
  consumer: { id: `c-${id}`, displayName: 'Reviewer', links: [{ href: 'https://example.com', rel: 'self' }] },
  businessUnit: { id: unit, displayName: 'Example' },
  links: []
})

describe('trustpilot', () => {
  it('parses as a market-intelligence connector with the apikey header', () => {
    const spec = parseConnectorSpec(trustpilot.spec)
    expect(Object.keys(spec.streams)).toEqual(['business_units', 'reviews'])
    expect(spec.category).toBe('market-intelligence')
    expect(spec.auth[0]).toMatchObject({ type: 'apiKey', in: 'header', name: 'apikey' })
    expect(businessUnitIds({ businessUnitIds: `${UNIT_A}, not-an-id` })).toEqual([UNIT_A])
  })

  it('tests with the first business unit profile', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: `/v1/business-units/${UNIT_A}/profileinfo`, body: { companyName: 'Example Inc.', isClaimed: true } }
    ])
    expect(await runtime.test(trustpilot, connection())).toEqual({ account: 'Example Inc.' })
    expect(fetch.calls[0].headers.apikey).toBe('tp-key')
  })

  it('reads business unit profiles', async () => {
    const { runtime } = mockRuntime([
      {
        path: /\/v1\/business-units\/[a-f0-9]+\/profileinfo$/,
        body: { companyName: 'Example Inc.', address: { city: 'Example City', countryCode: 'DK' }, socialmedia: {}, links: [] }
      }
    ])
    const units = records(await readAll(runtime, trustpilot, connection(), 'business_units'))
    expect(units.map((unit) => unit.externalId)).toEqual([UNIT_A, UNIT_B])
    expect(units[0].properties).toMatchObject({ company_name: 'Example Inc.', address_city: 'Example City' })
    expect(units[0].properties).not.toHaveProperty('links')
  })

  it('backfills reviews over pages, newest first, linked to the business unit', async () => {
    const full = Array.from({ length: 100 }, (_, index) => review(`r${index}`, '2024-03-01T10:00:00Z'))
    const { fetch, runtime } = mockRuntime([
      { path: `/v1/business-units/${UNIT_A}/reviews`, query: { page: '1' }, body: { reviews: full } },
      { path: `/v1/business-units/${UNIT_A}/reviews`, query: { page: '2' }, body: { reviews: [review('r100', '2024-01-01T10:00:00Z')] } }
    ])
    const batches = await readAll(runtime, trustpilot, connection(UNIT_A), 'reviews')
    expect(fetch.calls).toHaveLength(2)
    expect(new URL(fetch.calls[0].url).searchParams.get('orderBy')).toBe('createdat.desc')
    expect(new URL(fetch.calls[0].url).searchParams.get('perPage')).toBe('100')
    const all = records(batches)
    expect(all).toHaveLength(101)
    expect(all[0].properties).toMatchObject({
      stars: 4,
      created_at: '2024-03-01T10:00:00.000Z',
      company_reply_text: 'Thanks!',
      consumer_display_name: 'Reviewer'
    })
    expect(all[0].properties).not.toHaveProperty('consumer_links')
    expect(all[0].links).toEqual([{ type: 'REVIEW_OF', target: 'business_units', direction: 'out', externalIds: [UNIT_A] }])
    expect(batches[0].state.cursor).toBeUndefined()
    expect(batches.at(-1)!.state.cursor).toBe('2024-03-01T10:00:00Z')
  })

  it('stops at reviews older than the cursor and keeps the old cursor until the last unit', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: `/v1/business-units/${UNIT_A}/reviews`,
        body: { reviews: [review('a2', '2024-03-05T00:00:00Z'), review('a1', '2024-02-01T00:00:00Z')] }
      },
      {
        path: `/v1/business-units/${UNIT_B}/reviews`,
        body: { reviews: [review('b1', '2024-03-04T00:00:00Z', UNIT_B)] }
      }
    ])
    const batches = await readAll(runtime, trustpilot, connection(), 'reviews', { cursor: '2024-03-01T00:00:00Z' })
    expect(fetch.calls).toHaveLength(2)
    expect(records(batches).map((record) => record.externalId)).toEqual(['a2', 'b1'])
    expect(batches[0].state.cursor).toBe('2024-03-01T00:00:00Z')
    expect(batches.at(-1)!.state.cursor).toBe('2024-03-05T00:00:00Z')
  })
})
