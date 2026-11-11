import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { stripe } from '../../src/connectors'
import { parseConnectorSpec, parseWebhook, verifyWebhook } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const invoice = (id: string, customer: unknown) => ({
  id,
  object: 'invoice',
  customer,
  subscription: 'sub_1',
  charge: 'ch_1',
  payment_intent: null,
  amount_due: 1999,
  amount_paid: 1999,
  total: 1999,
  currency: 'usd',
  created: 1704067200,
  period_start: 1704067200,
  status: 'paid',
  status_transitions: { paid_at: 1704070800, finalized_at: 1704067300 },
  lines: { object: 'list', data: [{ id: 'il_1' }] }
})

describe('stripe', () => {
  it('parses and pins the API version', () => {
    const spec = parseConnectorSpec(stripe.spec)
    expect(Object.keys(spec.streams)).toHaveLength(9)
    expect(spec.headers?.['Stripe-Version']).toBe('2024-06-20')
    expect(Object.values(spec.streams).some((stream) => stream.incremental)).toBe(false)
  })

  it('tests with the restricted key', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/v1/customers', body: { data: [] } }])
    expect(await runtime.test(stripe, bearer())).toEqual({})
    expect(fetch.calls[0].headers['stripe-version']).toBe('2024-06-20')
  })

  it('backfills invoices with starting_after, typed amounts and bare key ids', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/v1/invoices', query: { starting_after: 'in_1' }, body: { data: [invoice('in_2', 'cus_2')], has_more: false } },
      {
        path: '/v1/invoices',
        body: { data: [invoice('in_1', { id: 'cus_1', object: 'customer', email: 'a@example.com' })], has_more: true }
      }
    ])
    const batches = await readAll(runtime, stripe, bearer(), 'invoices')
    const [first, second] = records(batches)
    expect(first.properties).toMatchObject({
      amount_due: 19.99,
      total: 19.99,
      currency: 'usd',
      created: '2024-01-01T00:00:00.000Z',
      status_transitions_paid_at: '2024-01-01T01:00:00.000Z',
      customer: 'cus_1',
      subscription: 'sub_1'
    })
    expect(first.properties).not.toHaveProperty('customer_email')
    expect(first.properties).not.toHaveProperty('lines_data')
    expect(first.properties).not.toHaveProperty('object')
    expect(second.properties.customer).toBe('cus_2')
    expect(fetch.calls).toHaveLength(2)
  })

  it('reads in full even with a stored cursor and links subscription prices', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/v1/subscriptions',
        body: {
          data: [{ id: 'sub_1', customer: 'cus_1', status: 'active', created: 1704067200, items: { data: [{ id: 'si_1', price: { id: 'price_1' } }] } }],
          has_more: false
        }
      }
    ])
    const batches = await readAll(runtime, stripe, bearer(), 'subscriptions', { cursor: 1704067200 })
    expect(new URL(fetch.calls[0].url).searchParams.get('status')).toBe('all')
    expect(new URL(fetch.calls[0].url).searchParams.has('created[gte]')).toBe(false)
    expect(records(batches)[0].links).toEqual([{ type: 'INCLUDES_PRICE', target: 'prices', direction: 'out', externalIds: ['price_1'] }])
  })

  it('verifies Stripe-Signature and routes events', () => {
    const spec = parseConnectorSpec(stripe.spec)
    const event = (type: string, object: unknown) => ({ id: `evt_${type}`, type, data: { object } })
    const rawBody = JSON.stringify(event('customer.updated', { id: 'cus_1', object: 'customer', balance: -500, created: 1704067200 }))
    const t = Math.floor(Date.now() / 1000)
    const signature = createHmac('sha256', 'whsec_1').update(`${t}.${rawBody}`).digest('hex')
    expect(verifyWebhook(spec, { headers: { 'stripe-signature': `t=${t},v1=${signature}` }, rawBody, secret: 'whsec_1' })).toBe(true)
    const [updated] = parseWebhook(spec, JSON.parse(rawBody))
    expect(updated).toMatchObject({ stream: 'customers', action: 'upsert', externalId: 'cus_1' })
    expect(updated.record?.properties.balance).toBe(-5)
    expect(parseWebhook(spec, event('customer.deleted', { id: 'cus_1' }))[0]).toMatchObject({ action: 'delete', stream: 'customers' })
    expect(parseWebhook(spec, event('charge.dispute.created', { id: 'dp_1', charge: 'ch_1', amount: 500 }))[0]).toMatchObject({
      stream: 'disputes',
      externalId: 'dp_1'
    })
    expect(parseWebhook(spec, event('customer.subscription.updated', { id: 'sub_1' }))[0].stream).toBe('subscriptions')
    expect(parseWebhook(spec, event('customer.tax_id.created', { id: 'txi_1' }))).toEqual([])
  })
})
