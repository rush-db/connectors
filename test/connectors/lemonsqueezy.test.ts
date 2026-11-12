import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { lemonsqueezy } from '../../src/connectors/lemonsqueezy'
import { parseConnectorSpec, parseWebhook, verifyWebhook } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const order = (id: string, customer: number) => ({
  type: 'orders',
  id,
  attributes: {
    store_id: 1,
    customer_id: customer,
    identifier: `00000000-0000-0000-0000-00000000000${id}`,
    order_number: Number(id),
    user_name: 'Test Buyer',
    user_email: `buyer${id}@example.com`,
    currency: 'USD',
    subtotal: 999,
    tax: 200,
    total: 1199,
    total_usd: 1199,
    status: 'paid',
    refunded: false,
    refunded_at: null,
    first_order_item: { id: 10, order_id: Number(id), product_id: 5, variant_id: 7, price: 999 },
    urls: { receipt: 'https://app.lemonsqueezy.com/my-orders/x?signature=secret' },
    created_at: '2024-01-01T09:45:53.000000Z',
    updated_at: '2024-01-02T09:45:53.000000Z',
    test_mode: false
  },
  relationships: { store: { links: { related: 'https://api.lemonsqueezy.com/v1/orders/1/store' } } },
  links: { self: `https://api.lemonsqueezy.com/v1/orders/${id}` }
})

describe('lemonsqueezy', () => {
  it('parses', () => {
    const spec = parseConnectorSpec(lemonsqueezy.spec)
    expect(Object.keys(spec.streams)).toEqual([
      'stores',
      'customers',
      'products',
      'variants',
      'orders',
      'subscriptions',
      'license_keys'
    ])
    expect(spec.streams.license_keys.optional).toBe(true)
  })

  it('tests the connection with JSON:API headers', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/v1/users/me', body: { data: { type: 'users', id: '1', attributes: { name: 'Test Seller' } } } }
    ])
    expect(await runtime.test(lemonsqueezy, bearer())).toEqual({ account: 'Test Seller' })
    expect(fetch.calls[0].headers.accept).toBe('application/vnd.api+json')
    expect(fetch.calls[0].headers.authorization).toBe('Bearer test-token')
  })

  it('backfills orders over links.next with flattened attributes, cents and relations', async () => {
    const next = 'https://api.lemonsqueezy.com/v1/orders?page%5Bnumber%5D=2&page%5Bsize%5D=100'
    const { fetch, runtime } = mockRuntime([
      {
        path: '/v1/orders',
        query: { 'page[number]': '2' },
        body: { data: [order('2', 4)], links: { first: next } }
      },
      { path: '/v1/orders', body: { data: [order('1', 3)], links: { next } } }
    ])
    const batches = await readAll(runtime, lemonsqueezy, bearer(), 'orders')
    const [first, second] = records(batches)
    expect(first.externalId).toBe('1')
    expect(first.properties).toMatchObject({
      store_id: 1,
      customer_id: 3,
      subtotal: 9.99,
      total: 11.99,
      total_usd: 11.99,
      first_order_item_price: 9.99,
      status: 'paid',
      created_at: '2024-01-01T09:45:53.000Z',
      external_id: '1'
    })
    expect(first.properties).not.toHaveProperty('urls_receipt')
    expect(first.properties).not.toHaveProperty('relationships_store_links_related')
    expect(first.properties).not.toHaveProperty('type')
    expect(first.links).toEqual([
      { type: 'IN_STORE', target: 'stores', direction: 'out', externalIds: ['1'] },
      { type: 'PLACED_BY', target: 'customers', direction: 'out', externalIds: ['3'] },
      { type: 'FOR_PRODUCT', target: 'products', direction: 'out', externalIds: ['5'] },
      { type: 'FOR_VARIANT', target: 'variants', direction: 'out', externalIds: ['7'] }
    ])
    expect(second.properties.customer_id).toBe(4)
    expect(fetch.calls).toHaveLength(2)
    expect(new URL(fetch.calls[0].url).searchParams.get('page[size]')).toBe('100')
  })

  it('reads in full even with a stored cursor and drops the license key itself', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/v1/license-keys',
        body: {
          data: [
            {
              type: 'license-keys',
              id: '9',
              attributes: { store_id: 1, customer_id: 3, order_id: 1, product_id: 5, key: 'SECRET-KEY', key_short: 'XXXX-KEY', status: 'active' }
            }
          ]
        }
      }
    ])
    const batches = await readAll(runtime, lemonsqueezy, bearer(), 'license_keys', { cursor: '2024-01-01T00:00:00Z' })
    expect(fetch.calls).toHaveLength(1)
    const [key] = records(batches)
    expect(key.properties).not.toHaveProperty('key')
    expect(key.properties.key_short).toBe('XXXX-KEY')
    expect(key.links.map((link) => link.type)).toEqual(['IN_STORE', 'BELONGS_TO', 'FROM_ORDER', 'FOR_PRODUCT'])
  })

  it('verifies X-Signature and routes events', () => {
    const spec = parseConnectorSpec(lemonsqueezy.spec)
    const event = (name: string, data: unknown) => ({ meta: { event_name: name, webhook_id: 'wh_1' }, data })
    const rawBody = JSON.stringify(event('order_created', order('1', 3)))
    const signature = createHmac('sha256', 'signing-secret').update(rawBody).digest('hex')
    expect(verifyWebhook(spec, { headers: { 'x-signature': signature }, rawBody, secret: 'signing-secret' })).toBe(true)
    expect(verifyWebhook(spec, { headers: { 'x-signature': signature }, rawBody: `${rawBody} `, secret: 'signing-secret' })).toBe(false)
    const [created] = parseWebhook(spec, JSON.parse(rawBody))
    expect(created).toMatchObject({ stream: 'orders', action: 'upsert', externalId: '1', id: '2024-01-02T09:45:53.000000Z' })
    expect(created.record?.properties.total).toBe(11.99)
    const subscription = { type: 'subscriptions', id: '20', attributes: { customer_id: 3, status: 'cancelled', updated_at: '2024-02-01T00:00:00Z' } }
    expect(parseWebhook(spec, event('subscription_cancelled', subscription))[0]).toMatchObject({
      stream: 'subscriptions',
      action: 'upsert',
      externalId: '20'
    })
    const invoice = { type: 'subscription-invoices', id: '30', attributes: { updated_at: '2024-02-01T00:00:00Z' } }
    expect(parseWebhook(spec, event('subscription_payment_success', invoice))).toEqual([])
  })
})
