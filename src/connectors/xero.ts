import type { RelationSpec, StreamSpec } from '../spec'
import { ConnectorHttpError } from '../runtime/http'
import { defineConnector, type ConnectionContext, type ConnectorHttp, type StreamState } from '../types'

/*
 * Xero Accounting API with granular read-only scopes (the only kind apps
 * created since March 2026 may request; one unknown scope fails the whole
 * authorization).
 *
 * Every call names the organisation in `Xero-tenant-id`. A token can reach
 * several organisations: the `tenant` setting picks one, otherwise the
 * connection must reach exactly one (`GET /connections`).
 *
 * `read` orders by `UpdatedDateUTC`, sends the cursor as `If-Modified-Since`
 * and pages with `page` (+ `pageSize=1000` where Xero supports it; a page
 * below 100 records is the last either way). Xero dates are Microsoft JSON
 * (`/Date(1573755038314+0000)/`) and become ISO before mapping. Deleted and
 * voided documents keep coming back with their `Status`, so there are no
 * tombstones. The limit is 60 calls a minute per organisation.
 */

const XERO_API = 'https://api.xero.com'
const ACCOUNTING = `${XERO_API}/api.xro/2.0`
const PAGE_SIZE = 1000
/** Xero's smallest page: fewer records than this means there is no next page. */
const MIN_PAGE = 100

const rel = (type: string, target: string, path: string): RelationSpec => ({ type, target, path, direction: 'out' })
const contact = (type = 'FOR_CONTACT') => rel(type, 'contacts', '$.Contact.ContactID')

type Endpoint = {
  stream: string
  /** Path under the accounting API and key of the records in the response (`Invoices`). */
  resource: string
  id: string
  label: string
  description: string
  paged: boolean
  relations?: RelationSpec[]
  omit?: string[]
  optional?: boolean
}

export const ENDPOINTS: Endpoint[] = [
  {
    stream: 'contacts',
    resource: 'Contacts',
    id: 'ContactID',
    label: 'XERO_CONTACT',
    description: 'Customers and suppliers.',
    paged: true,
    omit: ['ContactPersons', 'ContactGroups', 'PaymentTerms', 'BatchPayments']
  },
  {
    stream: 'accounts',
    resource: 'Accounts',
    id: 'AccountID',
    label: 'XERO_ACCOUNT',
    description: 'The chart of accounts.',
    paged: false
  },
  { stream: 'items', resource: 'Items', id: 'ItemID', label: 'XERO_ITEM', description: 'Products and services.', paged: false },
  {
    stream: 'invoices',
    resource: 'Invoices',
    id: 'InvoiceID',
    label: 'XERO_INVOICE',
    description: 'Sales invoices (ACCREC) and bills (ACCPAY).',
    paged: true,
    relations: [
      contact(),
      rel('INCLUDES_ITEM', 'items', '$.LineItems[*].Item.ItemID'),
      rel('PAID_BY', 'payments', '$.Payments[*].PaymentID')
    ],
    omit: ['LineItems', 'Payments', 'CreditNotes', 'Prepayments', 'Overpayments']
  },
  {
    stream: 'credit_notes',
    resource: 'CreditNotes',
    id: 'CreditNoteID',
    label: 'XERO_CREDIT_NOTE',
    description: 'Credit notes, linked to the invoices they are allocated to.',
    paged: true,
    relations: [contact(), rel('ALLOCATED_TO', 'invoices', '$.Allocations[*].Invoice.InvoiceID')],
    omit: ['LineItems', 'Allocations', 'Payments']
  },
  {
    stream: 'payments',
    resource: 'Payments',
    id: 'PaymentID',
    label: 'XERO_PAYMENT',
    description: 'Payments against invoices and credit notes.',
    paged: true,
    relations: [
      rel('PAYS', 'invoices', '$.Invoice.InvoiceID'),
      rel('REFUNDS', 'credit_notes', '$.CreditNote.CreditNoteID'),
      rel('INTO_ACCOUNT', 'accounts', '$.Account.AccountID')
    ]
  },
  {
    stream: 'bank_transactions',
    resource: 'BankTransactions',
    id: 'BankTransactionID',
    label: 'XERO_BANK_TRANSACTION',
    description: 'Spend and receive money transactions.',
    paged: true,
    relations: [contact(), rel('IN_ACCOUNT', 'accounts', '$.BankAccount.AccountID')],
    omit: ['LineItems']
  },
  {
    stream: 'purchase_orders',
    resource: 'PurchaseOrders',
    id: 'PurchaseOrderID',
    label: 'XERO_PURCHASE_ORDER',
    description: 'Purchase orders.',
    paged: true,
    relations: [contact('FROM_SUPPLIER'), rel('INCLUDES_ITEM', 'items', '$.LineItems[*].Item.ItemID')],
    omit: ['LineItems']
  },
  {
    stream: 'quotes',
    resource: 'Quotes',
    id: 'QuoteID',
    label: 'XERO_QUOTE',
    description: 'Quotes.',
    paged: true,
    relations: [contact(), rel('INCLUDES_ITEM', 'items', '$.LineItems[*].Item.ItemID')],
    omit: ['LineItems']
  },
  {
    stream: 'manual_journals',
    resource: 'ManualJournals',
    id: 'ManualJournalID',
    label: 'XERO_MANUAL_JOURNAL',
    description: 'Manual journals. Off by default.',
    paged: true,
    relations: [rel('POSTS_TO', 'accounts', '$.JournalLines[*].AccountID')],
    omit: ['JournalLines'],
    optional: true
  }
]

function endpointStream(endpoint: Endpoint): StreamSpec {
  return {
    label: endpoint.label,
    description: endpoint.description,
    request: { path: `/api.xro/2.0/${endpoint.resource}`, query: { order: 'UpdatedDateUTC ASC' } },
    records: `$.${endpoint.resource}`,
    id: `$.${endpoint.id}`,
    incremental: { cursorField: '$.UpdatedDateUTC', format: 'iso', lookbackSeconds: 120 },
    fields: {
      omit: ['ValidationErrors', 'Warnings', 'HasValidationErrors', 'HasErrors', ...(endpoint.omit ?? [])],
      types: { UpdatedDateUTC: 'datetime', Date: 'datetime', DueDate: 'datetime', FullyPaidOnDate: 'datetime' }
    },
    relations: endpoint.relations ?? [],
    ...(endpoint.optional ? { optional: true } : {})
  }
}

const MS_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/

/** `/Date(1573755038314+0000)/` → ISO, everywhere in a record. The offset is informational: the number is UTC. */
export function xeroDates<T>(value: T): T {
  if (typeof value === 'string') {
    const match = MS_DATE.exec(value)
    return (match ? new Date(Number(match[1])).toISOString() : value) as T
  }
  if (Array.isArray(value)) {
    return value.map(xeroDates) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, xeroDates(inner)])) as T
  }
  return value
}

type Tenant = { tenantId: string; tenantName?: string; tenantType?: string }

const tenants = new WeakMap<ConnectionContext, Tenant>()

/** The organisation this connection reads: the `tenant` setting (id or name), or the only one the token reaches. */
export async function resolveTenant(http: ConnectorHttp, connection: ConnectionContext): Promise<Tenant> {
  const cached = tenants.get(connection)
  if (cached) {
    return cached
  }
  const response = await http.request<Tenant[]>({ url: `${XERO_API}/connections` })
  const organisations = (response.data ?? []).filter((tenant) => !tenant.tenantType || tenant.tenantType === 'ORGANISATION')
  const wanted = String(connection.config.tenant ?? '').trim()
  const tenant =
    wanted ?
      organisations.find((candidate) => candidate.tenantId === wanted || candidate.tenantName?.toLowerCase() === wanted.toLowerCase())
    : organisations.length === 1 ? organisations[0]
    : undefined
  if (!tenant) {
    throw new Error(
      wanted ? `This Xero authorization does not reach the organisation "${wanted}".`
      : organisations.length === 0 ? 'This Xero authorization reaches no organisation; authorize again and pick one.'
      : `This Xero authorization reaches ${organisations.length} organisations (${organisations.map((candidate) => candidate.tenantName).join(', ')}); name one in the Organisation setting.`
    )
  }
  tenants.set(connection, tenant)
  return tenant
}

async function* readEndpoint(
  http: ConnectorHttp,
  tenant: Tenant,
  endpoint: Endpoint,
  state: StreamState,
  lookbackSeconds: number
) {
  const since = state.cursor === undefined ? undefined : Date.parse(String(state.cursor))
  const headers: Record<string, string> = { 'Xero-tenant-id': tenant.tenantId, Accept: 'application/json' }
  if (since !== undefined && Number.isFinite(since)) {
    // Xero reads the header as UTC without a zone.
    headers['If-Modified-Since'] = new Date(since - lookbackSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, '')
  }
  let cursor = state.cursor
  for (let page = 1; ; page++) {
    const response = await http
      .request({
        url: `${ACCOUNTING}/${endpoint.resource}`,
        headers,
        query: { order: 'UpdatedDateUTC ASC', ...(endpoint.paged ? { page, pageSize: PAGE_SIZE } : {}) }
      })
      // 304 Not Modified: nothing changed since the cursor.
      .catch((error) => {
        if (error instanceof ConnectorHttpError && error.status === 304) {
          return undefined
        }
        throw error
      })
    const records: any[] = xeroDates(response?.data?.[endpoint.resource] ?? [])
    for (const record of records) {
      const value = record?.UpdatedDateUTC
      if (typeof value === 'string' && (cursor === undefined || Date.parse(value) > Date.parse(String(cursor)))) {
        cursor = value
      }
    }
    yield { records, state: { cursor } }
    if (!endpoint.paged || records.length < MIN_PAGE) {
      return
    }
  }
}

const byStream = new Map(ENDPOINTS.map((endpoint) => [endpoint.stream, endpoint]))
const byResource = (resource: string) => ENDPOINTS.find((endpoint) => endpoint.resource === resource)!.stream

export const xero = defineConnector({
  spec: {
    id: 'xero',
    name: 'Xero',
    category: 'accounting',
    description:
      'Contacts, accounts, items, invoices and bills, credit notes, payments, bank transactions, purchase orders, quotes and manual journals from Xero.',
    docsUrl: 'https://developer.xero.com/documentation/api/accounting/overview',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
        tokenUrl: 'https://identity.xero.com/connect/token',
        scopes: [
          'offline_access',
          'accounting.contacts.read',
          'accounting.settings.read',
          'accounting.invoices.read',
          'accounting.payments.read',
          'accounting.banktransactions.read',
          'accounting.manualjournals.read'
        ],
        clientAuth: 'basic'
      }
    ],
    config: {
      tenant: {
        label: 'Organisation',
        required: false,
        placeholder: 'Acme Ltd',
        help: 'Needed only when the authorization reaches several Xero organisations: the organisation’s name or tenant id.'
      }
    },
    baseUrl: XERO_API,
    // 60 calls a minute per organisation.
    rateLimit: { requestsPerSecond: 0.9 },
    streams: Object.fromEntries(ENDPOINTS.map((endpoint) => [endpoint.stream, endpointStream(endpoint)])),
    webhooks: {
      signature: { scheme: 'hmacSha256', header: 'x-xero-signature', encoding: 'base64' },
      events: '$.events[*]',
      type: '$.eventCategory',
      typeSuffix: '$.eventType',
      // Events carry no id of their own: the resource id and the event time make one.
      id: '$.resourceId',
      idSuffix: '$.eventDateUtc',
      objectId: '$.resourceId',
      routes: {
        'INVOICE.*': { stream: byResource('Invoices'), action: 'refetch' },
        'CONTACT.*': { stream: byResource('Contacts'), action: 'refetch' },
        'CREDITNOTE.*': { stream: byResource('CreditNotes'), action: 'refetch' },
        'PAYMENT.*': { stream: byResource('Payments'), action: 'refetch' }
      },
      setup:
        'Webhooks go to one URL per Xero app, so they need the workspace’s own app (Settings → OAuth app). developer.xero.com → your app → Webhooks: the connection’s webhook URL and the Invoices, Contacts, Credit notes and Payments events. Copy the webhook key here.'
    }
  },
  hooks: {
    async test(ctx) {
      const tenant = await resolveTenant(ctx.http, ctx.connection)
      return { account: tenant.tenantName }
    },
    read(stream, state, ctx) {
      const endpoint = byStream.get(stream.name)
      if (!endpoint) {
        return undefined
      }
      const lookback = stream.spec.incremental?.lookbackSeconds ?? 120
      return (async function* () {
        yield* readEndpoint(ctx.http, await resolveTenant(ctx.http, ctx.connection), endpoint, state, lookback)
      })()
    }
  }
})
