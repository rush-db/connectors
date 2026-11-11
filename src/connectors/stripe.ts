import type { FieldType, RelationSpec, StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * Stripe, API version pinned so field shapes do not change under the
 * connector (register the webhook endpoint with the same version).
 *
 * No incremental cursor, on purpose. List endpoints filter by `created`, not
 * by modification time: a `created[gte]` cursor would read new objects only
 * and miss every later change (a subscription cancelled, an invoice paid, a
 * charge refunded). The Events API has the changes but keeps 30 days only and
 * fans out across every object type. So a scheduled run re-reads each stream
 * in full, and the webhook keeps records current in between.
 *
 * Amounts are integers in the currency's minor unit and typed `cents`, which
 * divides by 100. Zero-decimal currencies (JPY, KRW, …) come out 100× too
 * small; the raw `currency` property is kept next to every amount.
 */

const STRIPE_VERSION = '2024-06-20'

const key = (type: string, target: string, field: string): RelationSpec => ({ type, target, field, direction: 'out' })

function list(
  path: string,
  label: string,
  description: string,
  types: Record<string, FieldType>,
  relations: RelationSpec[] = [],
  query: Record<string, string | number> = {},
  omit: string[] = []
): StreamSpec {
  return {
    label,
    description,
    request: { path, query: { limit: 100, ...query } },
    records: '$.data',
    id: '$.id',
    pagination: { type: 'lastId', param: 'starting_after', idPath: '$.id', hasMore: '$.has_more' },
    fields: { omit: ['object', ...omit], types: { created: 'unix', ...types } },
    relations
  }
}

export const stripe = defineConnector({
  spec: {
    id: 'stripe',
    name: 'Stripe',
    category: 'billing',
    description:
      'Customers, subscriptions, invoices, charges, payment intents, products, prices, refunds and disputes from Stripe.',
    docsUrl: 'https://docs.stripe.com/api',
    auth: [
      {
        type: 'bearer',
        label: 'Restricted API key',
        help: 'Developers → API keys → Create restricted key, with Read access to Customers, Subscriptions, Invoices, Charges, PaymentIntents, Products, Prices, Refunds and Disputes and no write access. Starts with rk_live_ or rk_test_.'
      },
      {
        type: 'oauth2',
        authorizeUrl: 'https://connect.stripe.com/oauth/authorize',
        tokenUrl: 'https://connect.stripe.com/oauth/token',
        scopes: ['read_only'],
        pkce: false
      }
    ],
    baseUrl: 'https://api.stripe.com',
    headers: { 'Stripe-Version': STRIPE_VERSION },
    // Live mode allows 100 read requests per second; stay well under it.
    rateLimit: { requestsPerSecond: 25 },
    test: { request: { path: '/v1/customers', query: { limit: 1 } } },
    streams: {
      customers: list('/v1/customers', 'STRIPE_CUSTOMER', 'Customers.', { balance: 'cents' }),
      subscriptions: list(
        '/v1/subscriptions',
        'STRIPE_SUBSCRIPTION',
        'Subscriptions in every status, cancelled included.',
        {
          current_period_start: 'unix',
          current_period_end: 'unix',
          start_date: 'unix',
          billing_cycle_anchor: 'unix',
          cancel_at: 'unix',
          canceled_at: 'unix',
          ended_at: 'unix',
          trial_start: 'unix',
          trial_end: 'unix'
        },
        [
          key('BELONGS_TO', 'customers', 'customer'),
          key('LATEST_INVOICE', 'invoices', 'latest_invoice'),
          { type: 'INCLUDES_PRICE', target: 'prices', path: '$.items.data[*].price.id', direction: 'out' }
        ],
        { status: 'all' }
      ),
      invoices: list(
        '/v1/invoices',
        'STRIPE_INVOICE',
        'Invoices.',
        {
          amount_due: 'cents',
          amount_paid: 'cents',
          amount_remaining: 'cents',
          subtotal: 'cents',
          tax: 'cents',
          total: 'cents',
          starting_balance: 'cents',
          ending_balance: 'cents',
          period_start: 'unix',
          period_end: 'unix',
          due_date: 'unix',
          status_transitions_finalized_at: 'unix',
          status_transitions_paid_at: 'unix',
          status_transitions_voided_at: 'unix',
          status_transitions_marked_uncollectible_at: 'unix'
        },
        [
          key('BILLED_TO', 'customers', 'customer'),
          key('FOR_SUBSCRIPTION', 'subscriptions', 'subscription'),
          key('PAID_BY', 'charges', 'charge'),
          key('PAID_WITH', 'payment_intents', 'payment_intent')
        ],
        {},
        // Line items are a nested list; read them from the invoice in Stripe when needed.
        ['lines']
      ),
      charges: list(
        '/v1/charges',
        'STRIPE_CHARGE',
        'Charges (card and other payments).',
        { amount: 'cents', amount_captured: 'cents', amount_refunded: 'cents' },
        [
          key('BILLED_TO', 'customers', 'customer'),
          key('FOR_INVOICE', 'invoices', 'invoice'),
          key('FOR_PAYMENT_INTENT', 'payment_intents', 'payment_intent')
        ]
      ),
      payment_intents: list(
        '/v1/payment_intents',
        'STRIPE_PAYMENT_INTENT',
        'Payment intents.',
        { amount: 'cents', amount_received: 'cents', amount_capturable: 'cents', canceled_at: 'unix' },
        [
          key('BILLED_TO', 'customers', 'customer'),
          key('FOR_INVOICE', 'invoices', 'invoice'),
          key('LATEST_CHARGE', 'charges', 'latest_charge')
        ]
      ),
      products: list('/v1/products', 'STRIPE_PRODUCT', 'Products.', { updated: 'unix' }, [
        key('DEFAULT_PRICE', 'prices', 'default_price')
      ]),
      prices: list('/v1/prices', 'STRIPE_PRICE', 'Prices of the products.', { unit_amount: 'cents' }, [
        key('PRICE_OF', 'products', 'product')
      ]),
      refunds: list('/v1/refunds', 'STRIPE_REFUND', 'Refunds.', { amount: 'cents' }, [
        key('REFUNDS', 'charges', 'charge'),
        key('FOR_PAYMENT_INTENT', 'payment_intents', 'payment_intent')
      ]),
      disputes: list('/v1/disputes', 'STRIPE_DISPUTE', 'Disputes (chargebacks).', {
        amount: 'cents',
        evidence_details_due_by: 'unix'
      }, [key('DISPUTES', 'charges', 'charge'), key('FOR_PAYMENT_INTENT', 'payment_intents', 'payment_intent')])
    },
    webhooks: {
      signature: { scheme: 'stripe' },
      type: '$.type',
      id: '$.id',
      object: '$.data.object',
      // Exact types where a prefix also covers other objects (`customer.tax_id.*`, `customer.discount.*`).
      routes: {
        'customer.created': { stream: 'customers', action: 'upsert' },
        'customer.updated': { stream: 'customers', action: 'upsert' },
        'customer.deleted': { stream: 'customers', action: 'delete' },
        'customer.subscription.*': { stream: 'subscriptions', action: 'upsert' },
        'invoice.deleted': { stream: 'invoices', action: 'delete' },
        'invoice.*': { stream: 'invoices', action: 'upsert' },
        'charge.dispute.*': { stream: 'disputes', action: 'upsert' },
        'charge.refund.updated': { stream: 'refunds', action: 'upsert' },
        'charge.*': { stream: 'charges', action: 'upsert' },
        'payment_intent.*': { stream: 'payment_intents', action: 'upsert' },
        'product.deleted': { stream: 'products', action: 'delete' },
        'product.*': { stream: 'products', action: 'upsert' },
        'price.deleted': { stream: 'prices', action: 'delete' },
        'price.*': { stream: 'prices', action: 'upsert' },
        'refund.*': { stream: 'refunds', action: 'upsert' }
      },
      setup: `Stripe Dashboard → Developers → Webhooks → Add endpoint: the connection’s webhook URL, API version ${STRIPE_VERSION}, events customer.*, customer.subscription.*, invoice.*, charge.*, payment_intent.*, product.*, price.* and refund.*. Copy the endpoint’s signing secret (whsec_…) here.`
    }
  }
})
