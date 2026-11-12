import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { paddle } from '../../src/connectors'
import { parseConnectorSpec, parseWebhook, verifyWebhook } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const sandbox = () => bearer({ environment: 'sandbox-api.paddle.com' })
const transaction = (id: string) => ({
  id,
  status: 'completed',
  customer_id: 'ctm_1',
  subscription_id: 'sub_1',
  currency_code: 'EUR',
  billed_at: '2024-01-01T00:00:00Z',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:05Z',
  details: { totals: { subtotal: '1000', tax: '190', total: '1190', currency_code: 'EUR' } }
})

describe('paddle', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(paddle.spec).streams)).toEqual([
      'customers',
      'subscriptions',
      'transactions',
      'products',
      'prices',
      'adjustments'
    ])
  })

  it('tests against the configured environment', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/customers', body: { data: [] } }])
    await runtime.test(paddle, sandbox())
    expect(new URL(fetch.calls[0].url).host).toBe('sandbox-api.paddle.com')
  })

  it('backfills transactions with after=<last id>', async () => {
    const { runtime } = mockRuntime([
      { path: '/transactions', query: { after: 'txn_1' }, body: { data: [transaction('txn_2')], meta: { pagination: { has_more: false } } } },
      { path: '/transactions', body: { data: [transaction('txn_1')], meta: { pagination: { has_more: true } } } }
    ])
    const batches = await readAll(runtime, paddle, sandbox(), 'transactions')
    const [first, second] = records(batches)
    expect(first.properties).toMatchObject({
      details_totals_total: 11.9,
      details_totals_tax: 1.9,
      details_totals_currency_code: 'EUR',
      customer_id: 'ctm_1',
      billed_at: '2024-01-01T00:00:00.000Z'
    })
    expect(second.externalId).toBe('txn_2')
  })

  it('verifies Paddle-Signature and upserts from notifications', () => {
    const spec = parseConnectorSpec(paddle.spec)
    const rawBody = JSON.stringify({
      event_id: 'evt_1',
      event_type: 'subscription.updated',
      occurred_at: '2024-01-02T00:00:00Z',
      data: { id: 'sub_1', status: 'past_due', customer_id: 'ctm_1', items: [{ price: { id: 'pri_1' } }] }
    })
    const ts = Math.floor(Date.now() / 1000)
    const h1 = createHmac('sha256', 'pdl_secret').update(`${ts}:${rawBody}`).digest('hex')
    expect(verifyWebhook(spec, { headers: { 'paddle-signature': `ts=${ts};h1=${h1}` }, rawBody, secret: 'pdl_secret' })).toBe(true)
    const [event] = parseWebhook(spec, JSON.parse(rawBody))
    expect(event).toMatchObject({ stream: 'subscriptions', action: 'upsert', externalId: 'sub_1' })
    expect(event.record?.links).toEqual([{ type: 'INCLUDES_PRICE', target: 'prices', direction: 'out', externalIds: ['pri_1'] }])
  })
})
