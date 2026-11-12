import type { FieldType, RelationSpec, StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * Lemon Squeezy API v1 (JSON:API).
 *
 * Every resource is `{ type, id, attributes, relationships, links }`. The
 * attributes are flattened into the record; `relationships` only carries
 * links to related endpoints (no ids unless `include` is used), so relations
 * come from the foreign keys the attributes hold (`store_id`, `customer_id`, …),
 * which name the same related resources.
 *
 * No incremental cursor: list endpoints filter by store, status or email but
 * not by modification time, so each run re-reads in full; the webhook keeps
 * orders, subscriptions and license keys current in between.
 *
 * Amounts are integers in cents and typed `cents`.
 */

const rel = (type: string, target: string, attribute: string): RelationSpec => ({
  type,
  target,
  path: `$.attributes.${attribute}`,
  direction: 'out'
})

function list(
  path: string,
  label: string,
  description: string,
  types: Record<string, FieldType>,
  relations: RelationSpec[] = [],
  extra: Partial<Pick<StreamSpec, 'optional'>> & { omit?: string[] } = {}
): StreamSpec {
  return {
    label,
    description,
    request: { path, query: { 'page[size]': 100 } },
    records: '$.data',
    id: '$.id',
    // `links.next` is the full URL of the next page; it is absent on the last one.
    pagination: { type: 'nextUrl', next: '$.links.next' },
    fields: {
      flatten: ['$.attributes'],
      // `urls` holds pre-signed customer links (receipts, portals, update-payment pages).
      omit: ['type', 'relationships', 'links', 'urls', ...(extra.omit ?? [])],
      types: { created_at: 'datetime', updated_at: 'datetime', ...types }
    },
    relations,
    ...(extra.optional ? { optional: true } : {})
  }
}

export const lemonsqueezy = defineConnector({
  spec: {
    id: 'lemonsqueezy',
    name: 'Lemon Squeezy',
    category: 'billing',
    description: 'Stores, customers, products, variants, orders, subscriptions and license keys from Lemon Squeezy.',
    docsUrl: 'https://docs.lemonsqueezy.com/api',
    auth: [
      {
        type: 'bearer',
        label: 'API key',
        help: 'Settings → API → Create API key. Lemon Squeezy keys cannot be limited to read access, so the connector only sends GET requests; create the key in test mode first to try it.'
      }
    ],
    baseUrl: 'https://api.lemonsqueezy.com',
    headers: { Accept: 'application/vnd.api+json' },
    // 300 requests per minute per API key.
    rateLimit: { requestsPerSecond: 4 },
    test: { request: { path: '/v1/users/me' }, account: '$.data.attributes.name' },
    streams: {
      stores: list('/v1/stores', 'LEMONSQUEEZY_STORE', 'Stores of the account.', {
        total_revenue: 'cents',
        thirty_day_revenue: 'cents'
      }),
      customers: list(
        '/v1/customers',
        'LEMONSQUEEZY_CUSTOMER',
        'Customers and their lifetime revenue.',
        { total_revenue_currency: 'cents', mrr: 'cents' },
        [rel('IN_STORE', 'stores', 'store_id')]
      ),
      products: list(
        '/v1/products',
        'LEMONSQUEEZY_PRODUCT',
        'Products.',
        { price: 'cents', from_price: 'cents', to_price: 'cents' },
        [rel('IN_STORE', 'stores', 'store_id')]
      ),
      variants: list(
        '/v1/variants',
        'LEMONSQUEEZY_VARIANT',
        'Variants (prices and plans) of the products.',
        { price: 'cents' },
        [rel('VARIANT_OF', 'products', 'product_id')]
      ),
      orders: list(
        '/v1/orders',
        'LEMONSQUEEZY_ORDER',
        'Orders, refunds included.',
        {
          subtotal: 'cents',
          setup_fee: 'cents',
          discount_total: 'cents',
          tax: 'cents',
          total: 'cents',
          refunded_amount: 'cents',
          referral_amount: 'cents',
          subtotal_usd: 'cents',
          setup_fee_usd: 'cents',
          discount_total_usd: 'cents',
          tax_usd: 'cents',
          total_usd: 'cents',
          refunded_amount_usd: 'cents',
          first_order_item_price: 'cents',
          refunded_at: 'datetime',
          first_order_item_created_at: 'datetime',
          first_order_item_updated_at: 'datetime'
        },
        [
          rel('IN_STORE', 'stores', 'store_id'),
          rel('PLACED_BY', 'customers', 'customer_id'),
          rel('FOR_PRODUCT', 'products', 'first_order_item.product_id'),
          rel('FOR_VARIANT', 'variants', 'first_order_item.variant_id')
        ]
      ),
      subscriptions: list(
        '/v1/subscriptions',
        'LEMONSQUEEZY_SUBSCRIPTION',
        'Subscriptions in every status.',
        {
          renews_at: 'datetime',
          ends_at: 'datetime',
          trial_ends_at: 'datetime',
          first_subscription_item_created_at: 'datetime',
          first_subscription_item_updated_at: 'datetime'
        },
        [
          rel('IN_STORE', 'stores', 'store_id'),
          rel('BELONGS_TO', 'customers', 'customer_id'),
          rel('FROM_ORDER', 'orders', 'order_id'),
          rel('FOR_PRODUCT', 'products', 'product_id'),
          rel('FOR_VARIANT', 'variants', 'variant_id')
        ],
        // Card brand and last four digits are payment details; keep them out.
        { omit: ['card_brand', 'card_last_four'] }
      ),
      license_keys: list(
        '/v1/license-keys',
        'LEMONSQUEEZY_LICENSE_KEY',
        'License keys issued for orders (the key itself is not stored, only its short form).',
        { expires_at: 'datetime' },
        [
          rel('IN_STORE', 'stores', 'store_id'),
          rel('BELONGS_TO', 'customers', 'customer_id'),
          rel('FROM_ORDER', 'orders', 'order_id'),
          rel('FOR_PRODUCT', 'products', 'product_id')
        ],
        { optional: true, omit: ['key'] }
      )
    },
    webhooks: {
      signature: { scheme: 'hmacSha256', header: 'X-Signature', encoding: 'hex' },
      type: '$.meta.event_name',
      // Deliveries carry no event id; the object's update time tells repeated deliveries of one change apart.
      id: '$.data.attributes.updated_at',
      object: '$.data',
      routes: {
        order_created: { stream: 'orders', action: 'upsert' },
        order_refunded: { stream: 'orders', action: 'upsert' },
        // Exact types: `subscription_payment_*` events carry a subscription invoice, which is not a stream here.
        subscription_created: { stream: 'subscriptions', action: 'upsert' },
        subscription_updated: { stream: 'subscriptions', action: 'upsert' },
        subscription_cancelled: { stream: 'subscriptions', action: 'upsert' },
        subscription_resumed: { stream: 'subscriptions', action: 'upsert' },
        subscription_expired: { stream: 'subscriptions', action: 'upsert' },
        subscription_paused: { stream: 'subscriptions', action: 'upsert' },
        subscription_unpaused: { stream: 'subscriptions', action: 'upsert' },
        subscription_plan_changed: { stream: 'subscriptions', action: 'upsert' },
        license_key_created: { stream: 'license_keys', action: 'upsert' },
        license_key_updated: { stream: 'license_keys', action: 'upsert' }
      },
      setup:
        'Lemon Squeezy → Settings → Webhooks → Add endpoint: the connection’s webhook URL, a signing secret of your choice (6–40 characters, enter the same value here), and the order, subscription and license key events.'
    }
  }
})
