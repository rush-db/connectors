import type { FieldType, RelationSpec, StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * Paddle Billing (not Paddle Classic). Lists page by `after=<last id>` and
 * offer no modification-time filter on every entity, so scheduled runs read
 * each stream in full and the webhook keeps records current in between.
 * Amounts are strings in the currency's minor unit (typed `cents`; see the
 * zero-decimal note in stripe.ts).
 */

const key = (type: string, target: string, field: string): RelationSpec => ({ type, target, field, direction: 'out' })

const DATES: Record<string, FieldType> = { created_at: 'datetime', updated_at: 'datetime' }

function list(
  path: string,
  label: string,
  description: string,
  types: Record<string, FieldType> = {},
  relations: RelationSpec[] = [],
  nestedDepth = 2
): StreamSpec {
  return {
    label,
    description,
    request: { path, query: { per_page: 200 } },
    records: '$.data',
    id: '$.id',
    pagination: { type: 'lastId', param: 'after', idPath: '$.id', hasMore: '$.meta.pagination.has_more' },
    fields: { types: { ...DATES, ...types }, nestedDepth },
    relations
  }
}

export const paddle = defineConnector({
  spec: {
    id: 'paddle',
    name: 'Paddle',
    category: 'billing',
    description: 'Customers, subscriptions, transactions, products, prices and adjustments from Paddle Billing.',
    docsUrl: 'https://developer.paddle.com/api-reference/overview',
    auth: [
      {
        type: 'bearer',
        label: 'API key',
        help: 'Paddle → Developer tools → Authentication → New API key, with read permissions only (customer, subscription, transaction, product, price, adjustment).'
      }
    ],
    config: {
      environment: {
        label: 'Environment',
        type: 'select',
        options: [
          { value: 'api.paddle.com', label: 'Live' },
          { value: 'sandbox-api.paddle.com', label: 'Sandbox' }
        ],
        default: 'api.paddle.com',
        help: 'Live and sandbox accounts have separate API keys.'
      }
    },
    baseUrl: 'https://{{config.environment}}',
    // 240 requests per minute per IP address.
    rateLimit: { requestsPerSecond: 4 },
    test: { request: { path: '/customers', query: { per_page: 1 } } },
    streams: {
      customers: list('/customers', 'PADDLE_CUSTOMER', 'Customers.'),
      subscriptions: list(
        '/subscriptions',
        'PADDLE_SUBSCRIPTION',
        'Subscriptions in every status.',
        {
          started_at: 'datetime',
          first_billed_at: 'datetime',
          next_billed_at: 'datetime',
          paused_at: 'datetime',
          canceled_at: 'datetime',
          current_billing_period_starts_at: 'datetime',
          current_billing_period_ends_at: 'datetime'
        },
        [
          key('BELONGS_TO', 'customers', 'customer_id'),
          { type: 'INCLUDES_PRICE', target: 'prices', path: '$.items[*].price.id', direction: 'out' }
        ]
      ),
      transactions: list(
        '/transactions',
        'PADDLE_TRANSACTION',
        'Transactions (checkouts, renewals, invoices).',
        {
          billed_at: 'datetime',
          details_totals_subtotal: 'cents',
          details_totals_tax: 'cents',
          details_totals_discount: 'cents',
          details_totals_total: 'cents',
          details_totals_grand_total: 'cents',
          details_totals_balance: 'cents'
        },
        [key('BILLED_TO', 'customers', 'customer_id'), key('FOR_SUBSCRIPTION', 'subscriptions', 'subscription_id')],
        3
      ),
      products: list('/products', 'PADDLE_PRODUCT', 'Products.'),
      prices: list('/prices', 'PADDLE_PRICE', 'Prices of the products.', { unit_price_amount: 'cents' }, [
        key('PRICE_OF', 'products', 'product_id')
      ]),
      adjustments: list(
        '/adjustments',
        'PADDLE_ADJUSTMENT',
        'Refunds, credits and chargebacks.',
        { totals_subtotal: 'cents', totals_tax: 'cents', totals_total: 'cents', totals_fee: 'cents', totals_earnings: 'cents' },
        [
          key('ADJUSTS', 'transactions', 'transaction_id'),
          key('BILLED_TO', 'customers', 'customer_id'),
          key('FOR_SUBSCRIPTION', 'subscriptions', 'subscription_id')
        ]
      )
    },
    webhooks: {
      signature: { scheme: 'paddle' },
      type: '$.event_type',
      id: '$.event_id',
      object: '$.data',
      routes: {
        'customer.*': { stream: 'customers', action: 'upsert' },
        'subscription.*': { stream: 'subscriptions', action: 'upsert' },
        'transaction.*': { stream: 'transactions', action: 'upsert' },
        'product.*': { stream: 'products', action: 'upsert' },
        'price.*': { stream: 'prices', action: 'upsert' },
        'adjustment.*': { stream: 'adjustments', action: 'upsert' }
      },
      setup:
        'Paddle → Developer tools → Notifications → New destination: type webhook, URL = the connection’s webhook URL, events customer.*, subscription.*, transaction.*, product.*, price.* and adjustment.*. Copy the destination’s secret key (pdl_ntfset_…) here.'
    }
  }
})
