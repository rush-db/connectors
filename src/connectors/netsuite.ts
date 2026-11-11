import type { RelationSpec, StreamSpec } from '../spec'
import { defineConnector, type ConnectorHttp, type StreamState } from '../types'

/*
 * NetSuite through SuiteQL (`POST /services/rest/query/v1/suiteql`), OAuth 2.0
 * authorization code against the account's own hosts.
 *
 * SuiteQL pages with limit/offset but stops at 100,000 rows, so `read` pages
 * by key instead: `ORDER BY lastmodifieddate, id` and each page starts after
 * the last (modified, id) seen; tables without a modification date page by id
 * and are read in full every run. Dates come back in the user's display
 * format, so the query adds `rushdb_modified_at`, the modification time as
 * `YYYY-MM-DDTHH:MI:SSZ`. The account's time zone is treated as UTC: the
 * value only needs to compare with itself, never with a clock.
 *
 * Deleted records are not returned; a full re-sync drops nothing either.
 * References are internal ids (`entity`, `item`, `subsidiary`) and link as
 * key relations, so a transaction's `entity` matches whichever of customers,
 * vendors or employees holds that id.
 */

const PAGE_SIZE = 1000
const MODIFIED = 'rushdb_modified_at'
const MODIFIED_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`

const key = (type: string, target: string, field: string): RelationSpec => ({ type, target, field, direction: 'out' })

type Table = {
  stream: string
  table: string
  label: string
  description: string
  /** Column holding the last modification time; without one the table is re-read in full. */
  modified?: string
  relations?: RelationSpec[]
  optional?: boolean
}

export const TABLES: Table[] = [
  {
    stream: 'subsidiaries',
    table: 'subsidiary',
    label: 'NS_SUBSIDIARY',
    description: 'Subsidiaries (OneWorld).',
    relations: [key('CHILD_OF', 'subsidiaries', 'parent')]
  },
  {
    stream: 'departments',
    table: 'department',
    label: 'NS_DEPARTMENT',
    description: 'Departments.',
    relations: [key('CHILD_OF', 'departments', 'parent')]
  },
  {
    stream: 'classes',
    table: 'classification',
    label: 'NS_CLASS',
    description: 'Classes.',
    relations: [key('CHILD_OF', 'classes', 'parent')]
  },
  {
    stream: 'locations',
    table: 'location',
    label: 'NS_LOCATION',
    description: 'Locations.',
    relations: [key('CHILD_OF', 'locations', 'parent')]
  },
  {
    stream: 'accounts',
    table: 'account',
    label: 'NS_ACCOUNT',
    description: 'The chart of accounts.',
    modified: 'lastmodifieddate',
    relations: [key('CHILD_OF', 'accounts', 'parent')]
  },
  {
    stream: 'customers',
    table: 'customer',
    label: 'NS_CUSTOMER',
    description: 'Customers, prospects and leads.',
    modified: 'lastmodifieddate',
    relations: [key('CHILD_OF', 'customers', 'parent'), key('IN_SUBSIDIARY', 'subsidiaries', 'subsidiary')]
  },
  {
    stream: 'vendors',
    table: 'vendor',
    label: 'NS_VENDOR',
    description: 'Vendors.',
    modified: 'lastmodifieddate',
    relations: [key('IN_SUBSIDIARY', 'subsidiaries', 'subsidiary')]
  },
  {
    stream: 'employees',
    table: 'employee',
    label: 'NS_EMPLOYEE',
    description: 'Employees. Off by default: personal data.',
    modified: 'lastmodifieddate',
    relations: [
      key('REPORTS_TO', 'employees', 'supervisor'),
      key('IN_DEPARTMENT', 'departments', 'department'),
      key('IN_SUBSIDIARY', 'subsidiaries', 'subsidiary')
    ],
    optional: true
  },
  {
    stream: 'contacts',
    table: 'contact',
    label: 'NS_CONTACT',
    description: 'Contacts at customers and vendors. Off by default: personal data.',
    modified: 'lastmodifieddate',
    relations: [key('WORKS_AT', 'customers', 'company'), key('WORKS_AT_VENDOR', 'vendors', 'company')],
    optional: true
  },
  {
    stream: 'items',
    table: 'item',
    label: 'NS_ITEM',
    description: 'Items: inventory, services, kits and others.',
    modified: 'lastmodifieddate',
    relations: [
      key('CHILD_OF', 'items', 'parent'),
      key('INCOME_ACCOUNT', 'accounts', 'incomeaccount'),
      key('EXPENSE_ACCOUNT', 'accounts', 'expenseaccount')
    ]
  },
  {
    stream: 'transactions',
    table: 'transaction',
    label: 'NS_TRANSACTION',
    description: 'Every transaction (invoices, sales orders, bills, payments, journals…); `type` tells them apart.',
    modified: 'lastmodifieddate',
    relations: [
      key('FOR_CUSTOMER', 'customers', 'entity'),
      key('FOR_VENDOR', 'vendors', 'entity'),
      key('FOR_EMPLOYEE', 'employees', 'entity'),
      key('CREATED_FROM', 'transactions', 'createdfrom')
    ]
  },
  {
    stream: 'transaction_lines',
    table: 'transactionline',
    label: 'NS_TRANSACTION_LINE',
    description: 'Transaction lines with item, account, amount and quantity. Off by default: high volume.',
    modified: 'linelastmodifieddate',
    relations: [
      key('LINE_OF', 'transactions', 'transaction'),
      key('FOR_ITEM', 'items', 'item'),
      key('IN_DEPARTMENT', 'departments', 'department'),
      key('IN_CLASS', 'classes', 'class'),
      key('AT_LOCATION', 'locations', 'location'),
      key('IN_SUBSIDIARY', 'subsidiaries', 'subsidiary')
    ],
    optional: true
  }
]

/** `transactionline.id` is unique per transaction only; `uniquekey` is unique across them. */
const rowId = (table: Table) => (table.table === 'transactionline' ? 't.uniquekey' : 't.id')

/** One SuiteQL page after `after` (exported for tests). Values are from the previous page or the cursor, never user input. */
export function pageQuery(table: Table, after: { modified?: string; id?: string }): string {
  const id = rowId(table)
  const select = table.modified ?
      `SELECT t.*, ${id} AS rushdb_id, TO_CHAR(t.${table.modified}, ${MODIFIED_FORMAT}) AS ${MODIFIED} FROM ${table.table} t`
    : `SELECT t.*, ${id} AS rushdb_id FROM ${table.table} t`
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
  const idAfter = (value: string) => {
    if (!/^\d+$/.test(value)) {
      throw new Error(`NetSuite key ${JSON.stringify(value)} is not an internal id`)
    }
    return `${id} > ${value}`
  }
  const conditions: string[] = []
  if (table.modified && after.modified) {
    const at = `TO_TIMESTAMP(${quote(after.modified.replace('T', ' ').replace(/Z$/, ''))}, 'YYYY-MM-DD HH24:MI:SS')`
    conditions.push(
      after.id ?
        `(t.${table.modified} > ${at} OR (t.${table.modified} = ${at} AND ${idAfter(after.id)}))`
      : `t.${table.modified} >= ${at}`
    )
  } else if (after.id) {
    conditions.push(idAfter(after.id))
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  const order = table.modified ? ` ORDER BY t.${table.modified}, ${id}` : ` ORDER BY ${id}`
  return `${select}${where}${order}`
}

async function* readTable(http: ConnectorHttp, table: Table, state: StreamState, lookbackSeconds: number) {
  let cursor = state.cursor
  let after: { modified?: string; id?: string } = {}
  const since = table.modified && cursor !== undefined ? Date.parse(String(cursor)) : NaN
  if (Number.isFinite(since)) {
    after = { modified: new Date(since - lookbackSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }
  }
  for (;;) {
    const response = await http.request({
      method: 'POST',
      url: '/services/rest/query/v1/suiteql',
      query: { limit: PAGE_SIZE, offset: 0 },
      headers: { Prefer: 'transient' },
      body: { q: pageQuery(table, after) }
    })
    const records: any[] = response.data?.items ?? []
    const last = records.at(-1)
    if (table.modified) {
      for (const record of records) {
        const value = record?.[MODIFIED]
        if (typeof value === 'string' && (cursor === undefined || value > String(cursor))) {
          cursor = value
        }
      }
    }
    yield { records, state: table.modified ? { cursor } : {} }
    const next = last ? { modified: table.modified ? last[MODIFIED] : undefined, id: String(last.rushdb_id) } : undefined
    // A page that does not move the key would repeat forever.
    if (records.length < PAGE_SIZE || !next || (next.id === after.id && next.modified === after.modified)) {
      return
    }
    after = next
  }
}

function tableStream(table: Table): StreamSpec {
  return {
    label: table.label,
    description: table.description,
    request: {
      method: 'POST',
      path: '/services/rest/query/v1/suiteql',
      headers: { Prefer: 'transient' },
      body: { q: `SELECT * FROM ${table.table}` }
    },
    records: '$.items',
    id: '$.rushdb_id',
    ...(table.modified ?
      { incremental: { cursorField: `$.${MODIFIED}`, format: 'iso' as const, lookbackSeconds: 300 } }
    : {}),
    fields: { omit: ['links', 'rushdb_id'], types: { [MODIFIED]: 'datetime' } },
    relations: table.relations ?? [],
    ...(table.optional ? { optional: true } : {})
  }
}

const byStream = new Map(TABLES.map((table) => [table.stream, table]))

export const netsuite = defineConnector({
  spec: {
    id: 'netsuite',
    name: 'NetSuite',
    category: 'accounting',
    description:
      'Subsidiaries, accounts, customers, vendors, employees, contacts, items, transactions and transaction lines from NetSuite, read with SuiteQL.',
    docsUrl: 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157909186990.html',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://{{config.account}}.app.netsuite.com/app/login/oauth2/authorize.nl',
        tokenUrl: 'https://{{config.account}}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
        // REST web services cannot be limited to reads; authorize as a role with view permissions only.
        scopes: ['rest_webservices'],
        clientAuth: 'basic'
      }
    ],
    config: {
      account: {
        label: 'Account ID',
        placeholder: '1234567 or 1234567-sb1',
        help: 'As in your NetSuite URL (https://1234567.app.netsuite.com): lowercase, with a hyphen instead of the underscore for sandboxes. The integration record needs OAuth 2.0 authorization code grant and the REST Web Services scope; NetSuite refresh tokens last 7 days by default, so set a longer validity there or re-authorize.'
      }
    },
    baseUrl: 'https://{{config.account}}.suitetalk.api.netsuite.com',
    // Concurrency is limited per account (from 5 calls at a time); keep one stream modest.
    rateLimit: { requestsPerSecond: 2 },
    test: {
      request: {
        method: 'POST',
        path: '/services/rest/query/v1/suiteql',
        query: { limit: 1 },
        headers: { Prefer: 'transient' },
        body: { q: 'SELECT id FROM account' }
      }
    },
    streams: Object.fromEntries(TABLES.map((table) => [table.stream, tableStream(table)]))
  },
  hooks: {
    read(stream, state, ctx) {
      const table = byStream.get(stream.name)
      return table ? readTable(ctx.http, table, state, stream.spec.incremental?.lookbackSeconds ?? 300) : undefined
    }
  }
})
