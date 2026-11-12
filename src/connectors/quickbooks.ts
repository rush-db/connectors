import type { FieldType, RelationSpec, StreamSpec } from '../spec'
import { defineConnector, type ConnectorHttp, type StreamState } from '../types'

/*
 * QuickBooks Online Accounting API, minor version pinned (75 is the oldest
 * Intuit still honours; lower values are silently answered as 75).
 *
 * The company (realm) id arrives on the OAuth redirect, not in the token
 * response, so the spec keeps it with `keepCallbackParams`.
 *
 * `read` pages the query endpoint (`STARTPOSITION`/`MAXRESULTS`, at most
 * 1000) ordered by `Metadata.LastUpdatedTime`, so every page can advance the
 * cursor. The query endpoint never returns deleted entities; with a cursor
 * younger than 30 days the read ends with a Change Data Capture call that
 * lists them (`status: "Deleted"`), which become tombstones. Older cursors
 * skip that step: CDC keeps 30 days only.
 *
 * Amounts are decimals in the transaction's currency (`CurrencyRef`), not
 * minor units.
 */

export const QUICKBOOKS_MINOR_VERSION = '75'
const PAGE_SIZE = 1000
const CDC_WINDOW_MS = 30 * 24 * 3600 * 1000

const ref = (type: string, target: string, path: string): RelationSpec => ({ type, target, path, direction: 'out' })

type Entity = {
  stream: string
  entity: string
  label: string
  description: string
  relations?: RelationSpec[]
  types?: Record<string, FieldType>
  optional?: boolean
}

const DATES: Record<string, FieldType> = { TxnDate: 'datetime', DueDate: 'datetime', ExpirationDate: 'datetime' }

const lineItems = (type = 'INCLUDES_ITEM') =>
  ref(type, 'items', '$.Line[*].SalesItemLineDetail.ItemRef.value')

export const ENTITIES: Entity[] = [
  {
    stream: 'customers',
    entity: 'Customer',
    label: 'QBO_CUSTOMER',
    description: 'Customers and sub-customers (jobs).',
    relations: [ref('CHILD_OF', 'customers', '$.ParentRef.value')]
  },
  { stream: 'vendors', entity: 'Vendor', label: 'QBO_VENDOR', description: 'Vendors (suppliers).' },
  {
    stream: 'employees',
    entity: 'Employee',
    label: 'QBO_EMPLOYEE',
    description: 'Employees. Off by default: personal data.',
    types: { HiredDate: 'datetime', ReleasedDate: 'datetime', BirthDate: 'datetime' },
    optional: true
  },
  {
    stream: 'accounts',
    entity: 'Account',
    label: 'QBO_ACCOUNT',
    description: 'The chart of accounts.',
    relations: [ref('CHILD_OF', 'accounts', '$.ParentRef.value')]
  },
  {
    stream: 'items',
    entity: 'Item',
    label: 'QBO_ITEM',
    description: 'Products and services.',
    relations: [
      ref('CHILD_OF', 'items', '$.ParentRef.value'),
      ref('INCOME_ACCOUNT', 'accounts', '$.IncomeAccountRef.value'),
      ref('EXPENSE_ACCOUNT', 'accounts', '$.ExpenseAccountRef.value'),
      ref('ASSET_ACCOUNT', 'accounts', '$.AssetAccountRef.value')
    ],
    types: { InvStartDate: 'datetime' }
  },
  { stream: 'classes', entity: 'Class', label: 'QBO_CLASS', description: 'Classes (tracking categories).' },
  { stream: 'departments', entity: 'Department', label: 'QBO_DEPARTMENT', description: 'Departments (locations).' },
  {
    stream: 'invoices',
    entity: 'Invoice',
    label: 'QBO_INVOICE',
    description: 'Invoices.',
    relations: [
      ref('BILLED_TO', 'customers', '$.CustomerRef.value'),
      lineItems(),
      ref('IN_DEPARTMENT', 'departments', '$.DepartmentRef.value')
    ]
  },
  {
    stream: 'estimates',
    entity: 'Estimate',
    label: 'QBO_ESTIMATE',
    description: 'Estimates (quotes).',
    relations: [ref('FOR_CUSTOMER', 'customers', '$.CustomerRef.value'), lineItems()]
  },
  {
    stream: 'sales_receipts',
    entity: 'SalesReceipt',
    label: 'QBO_SALES_RECEIPT',
    description: 'Sales receipts (paid on the spot).',
    relations: [
      ref('BILLED_TO', 'customers', '$.CustomerRef.value'),
      lineItems(),
      ref('DEPOSITED_TO', 'accounts', '$.DepositToAccountRef.value')
    ]
  },
  {
    stream: 'credit_memos',
    entity: 'CreditMemo',
    label: 'QBO_CREDIT_MEMO',
    description: 'Credit memos.',
    relations: [ref('FOR_CUSTOMER', 'customers', '$.CustomerRef.value'), lineItems()]
  },
  {
    stream: 'payments',
    entity: 'Payment',
    label: 'QBO_PAYMENT',
    description: 'Customer payments, linked to the invoices they pay.',
    relations: [
      ref('FROM_CUSTOMER', 'customers', '$.CustomerRef.value'),
      ref('PAYS', 'invoices', '$._linked.Invoice[*]'),
      ref('DEPOSITED_TO', 'accounts', '$.DepositToAccountRef.value')
    ]
  },
  {
    stream: 'bills',
    entity: 'Bill',
    label: 'QBO_BILL',
    description: 'Bills from vendors.',
    relations: [
      ref('FROM_VENDOR', 'vendors', '$.VendorRef.value'),
      ref('PAYABLE_ACCOUNT', 'accounts', '$.APAccountRef.value'),
      ref('EXPENSE_ACCOUNT', 'accounts', '$.Line[*].AccountBasedExpenseLineDetail.AccountRef.value'),
      ref('INCLUDES_ITEM', 'items', '$.Line[*].ItemBasedExpenseLineDetail.ItemRef.value')
    ]
  },
  {
    stream: 'bill_payments',
    entity: 'BillPayment',
    label: 'QBO_BILL_PAYMENT',
    description: 'Payments of bills, linked to the bills they pay.',
    relations: [ref('TO_VENDOR', 'vendors', '$.VendorRef.value'), ref('PAYS', 'bills', '$._linked.Bill[*]')]
  },
  {
    stream: 'purchases',
    entity: 'Purchase',
    label: 'QBO_PURCHASE',
    description: 'Expenses, checks and credit card charges.',
    relations: [
      ref('PAID_FROM', 'accounts', '$.AccountRef.value'),
      ref('EXPENSE_ACCOUNT', 'accounts', '$.Line[*].AccountBasedExpenseLineDetail.AccountRef.value'),
      ref('INCLUDES_ITEM', 'items', '$.Line[*].ItemBasedExpenseLineDetail.ItemRef.value')
    ]
  },
  {
    stream: 'purchase_orders',
    entity: 'PurchaseOrder',
    label: 'QBO_PURCHASE_ORDER',
    description: 'Purchase orders.',
    relations: [
      ref('FROM_VENDOR', 'vendors', '$.VendorRef.value'),
      ref('INCLUDES_ITEM', 'items', '$.Line[*].ItemBasedExpenseLineDetail.ItemRef.value')
    ]
  },
  {
    stream: 'journal_entries',
    entity: 'JournalEntry',
    label: 'QBO_JOURNAL_ENTRY',
    description: 'Manual journal entries. Off by default: high volume in some books.',
    relations: [ref('POSTS_TO', 'accounts', '$.Line[*].JournalEntryLineDetail.AccountRef.value')],
    optional: true
  }
]

function entityStream(entity: Entity): StreamSpec {
  return {
    label: entity.label,
    description: entity.description,
    request: {
      path: '/query',
      query: { query: `SELECT * FROM ${entity.entity}`, minorversion: QUICKBOOKS_MINOR_VERSION }
    },
    records: `$.QueryResponse.${entity.entity}`,
    id: '$.Id',
    incremental: { cursorField: '$.MetaData.LastUpdatedTime', format: 'iso', lookbackSeconds: 120 },
    deleted: { path: '$.status', value: 'Deleted' },
    fields: {
      // Line items are a nested list; their item and account references become relations above.
      omit: ['domain', 'sparse', 'SyncToken', 'Line', '_linked'],
      types: { MetaData_CreateTime: 'datetime', MetaData_LastUpdatedTime: 'datetime', ...DATES, ...entity.types }
    },
    relations: entity.relations ?? [],
    ...(entity.optional ? { optional: true } : {})
  }
}

/** The ids of linked transactions by type (`Line[*].LinkedTxn[*]`), for the `PAYS` relations. */
export function linkedTransactions(record: any): Record<string, string[]> {
  const linked: Record<string, string[]> = {}
  for (const line of Array.isArray(record?.Line) ? record.Line : []) {
    for (const txn of Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : []) {
      if (txn?.TxnType && txn?.TxnId !== undefined) {
        ;(linked[txn.TxnType] ??= []).push(String(txn.TxnId))
      }
    }
  }
  return linked
}

/** A query-language string literal: single quotes escaped with a backslash. */
const literal = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

async function* readEntity(http: ConnectorHttp, entity: string, state: StreamState, lookbackSeconds: number) {
  const since = state.cursor === undefined ? undefined : Date.parse(String(state.cursor))
  const hasSince = since !== undefined && Number.isFinite(since)
  const where = hasSince ? ` WHERE Metadata.LastUpdatedTime > ${literal(new Date(since - lookbackSeconds * 1000).toISOString())}` : ''
  let cursor = state.cursor
  const advance = (records: any[]) => {
    for (const record of records) {
      const value = record?.MetaData?.LastUpdatedTime
      if (typeof value === 'string' && (cursor === undefined || Date.parse(value) > Date.parse(String(cursor)))) {
        cursor = value
      }
    }
  }
  for (let start = 1; ; start += PAGE_SIZE) {
    const query = `SELECT * FROM ${entity}${where} ORDERBY Metadata.LastUpdatedTime STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`
    const response = await http.request({ url: '/query', query: { query, minorversion: QUICKBOOKS_MINOR_VERSION } })
    const records: any[] = response.data?.QueryResponse?.[entity] ?? []
    advance(records)
    yield { records, state: { cursor } }
    if (records.length < PAGE_SIZE) {
      break
    }
  }
  if (hasSince && Date.now() - since < CDC_WINDOW_MS) {
    const response = await http.request({
      url: '/cdc',
      query: {
        entities: entity,
        changedSince: new Date(since - lookbackSeconds * 1000).toISOString(),
        minorversion: QUICKBOOKS_MINOR_VERSION
      }
    })
    const deleted = (response.data?.CDCResponse ?? [])
      .flatMap((cdc: any) => cdc?.QueryResponse ?? [])
      .flatMap((query: any) => query?.[entity] ?? [])
      .filter((record: any) => record?.status === 'Deleted')
    if (deleted.length) {
      advance(deleted)
      yield { records: deleted, state: { cursor } }
    }
  }
}

const byStream = new Map(ENTITIES.map((entity) => [entity.stream, entity]))

export const quickbooks = defineConnector({
  spec: {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    category: 'accounting',
    description:
      'Customers, vendors, accounts, items, invoices, estimates, payments, bills, purchases and journal entries from QuickBooks Online.',
    docsUrl: 'https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
        tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
        // The accounting scope has no read-only variant; the connector only reads.
        scopes: ['com.intuit.quickbooks.accounting'],
        clientAuth: 'basic',
        pkce: false,
        keepCallbackParams: ['realmId']
      }
    ],
    config: {
      environment: {
        label: 'Environment',
        type: 'select',
        required: false,
        default: 'quickbooks.api.intuit.com',
        options: [
          { value: 'quickbooks.api.intuit.com', label: 'Production' },
          { value: 'sandbox-quickbooks.api.intuit.com', label: 'Sandbox company' }
        ]
      }
    },
    baseUrl: 'https://{{config.environment}}/v3/company/{{credentials.realmId}}',
    headers: { Accept: 'application/json' },
    // 500 requests a minute and 10 at a time per company; stay under both.
    rateLimit: { requestsPerSecond: 4 },
    test: {
      request: { path: '/companyinfo/{{credentials.realmId}}', query: { minorversion: QUICKBOOKS_MINOR_VERSION } },
      account: '$.CompanyInfo.CompanyName'
    },
    streams: Object.fromEntries(ENTITIES.map((entity) => [entity.stream, entityStream(entity)])),
    webhooks: {
      signature: { scheme: 'hmacSha256', header: 'intuit-signature', encoding: 'base64' },
      events: '$.eventNotifications[*].dataChangeEvent.entities[*]',
      type: '$.name',
      typeSuffix: '$.operation',
      // Notifications carry no event id: the entity id and its change time make one.
      id: '$.id',
      idSuffix: '$.lastUpdated',
      objectId: '$.id',
      routes: Object.fromEntries(
        ENTITIES.flatMap((entity) => [
          [`${entity.entity}.Delete`, { stream: entity.stream, action: 'delete' as const }],
          [`${entity.entity}.*`, { stream: entity.stream, action: 'refetch' as const }]
        ])
      ),
      setup:
        'Webhooks go to one URL per Intuit app, so they need the workspace’s own app (Settings → OAuth app). Intuit Developer → your app → Webhooks: the connection’s webhook URL and the entities to watch. Copy the Verifier Token here.'
    }
  },
  hooks: {
    read(stream, state, ctx) {
      const entity = byStream.get(stream.name)
      return entity ? readEntity(ctx.http, entity.entity, state, stream.spec.incremental?.lookbackSeconds ?? 120) : undefined
    },
    transform(stream, record) {
      return stream === 'payments' || stream === 'bill_payments' ? { ...record, _linked: linkedTransactions(record) } : record
    }
  }
})
