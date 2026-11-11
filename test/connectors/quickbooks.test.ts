import { describe, expect, it } from 'vitest'

import { quickbooks } from '../../src/connectors'
import { linkedTransactions } from '../../src/connectors/quickbooks'
import { ConnectorRuntime, exchangeCode, parseConnectorSpec, parseWebhook, type ConnectionContext } from '../../src'
import { createMockFetch } from '../../src/testing'
import { mockRuntime, readAll, records } from '../helpers'

const BASE = '/v3/company/4620816365'
const connection = (): ConnectionContext => ({
  config: { environment: 'sandbox-quickbooks.api.intuit.com' },
  credentials: { type: 'oauth2', accessToken: 'token', extra: { realmId: '4620816365' } }
})

const invoice = (n: number) => ({
  Id: String(n),
  SyncToken: '0',
  domain: 'QBO',
  sparse: false,
  DocNumber: `INV-${n}`,
  TxnDate: '2024-03-01',
  TotalAmt: 120.5,
  CustomerRef: { value: '58', name: 'Acme' },
  Line: [
    { Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '7' } } },
    { Amount: 20.5, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '9' } } },
    { Amount: 120.5, DetailType: 'SubTotalLineDetail' }
  ],
  MetaData: { CreateTime: '2024-03-01T09:00:00-08:00', LastUpdatedTime: `2024-03-0${1 + (n % 5)}T10:00:00-08:00` }
})

describe('quickbooks', () => {
  it('parses', () => {
    const spec = parseConnectorSpec(quickbooks.spec)
    expect(spec.category).toBe('accounting')
    expect(Object.keys(spec.streams)).toContain('invoices')
    expect(spec.streams.employees.optional).toBe(true)
  })

  it('keeps the company id from the authorization redirect', async () => {
    const fetch = createMockFetch([{ method: 'POST', path: '/oauth2/v1/tokens/bearer', body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } }])
    const credentials = await exchangeCode(new ConnectorRuntime().spec(quickbooks), {
      client: { clientId: 'id', clientSecret: 'secret' },
      code: 'c',
      redirectUri: 'https://app.example.com/cb',
      callbackParams: { code: 'c', state: 's', realmId: '4620816365' },
      fetch
    })
    expect(credentials).toMatchObject({ type: 'oauth2', extra: { realmId: '4620816365' } })
    // Intuit authenticates the client with basic auth.
    expect(fetch.calls[0].headers.authorization).toMatch(/^Basic /)
  })

  it('tests the connection against the company', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: `${BASE}/companyinfo/4620816365`, body: { CompanyInfo: { CompanyName: 'Sandbox Company' } } }
    ])
    expect(await runtime.test(quickbooks, connection())).toMatchObject({ account: 'Sandbox Company' })
    expect(fetch.calls[0].url.startsWith('https://sandbox-quickbooks.api.intuit.com/v3/company/4620816365/')).toBe(true)
  })

  it('backfills with query pages ordered by modification time', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: `${BASE}/query`,
        respond: ({ url }) => {
          const query = url.searchParams.get('query') ?? ''
          const start = Number(/STARTPOSITION (\d+)/.exec(query)?.[1])
          const page = start === 1 ? Array.from({ length: 1000 }, (_, index) => invoice(index + 1)) : [invoice(1001)]
          return { body: { QueryResponse: { Invoice: page, startPosition: start } } }
        }
      }
    ])
    const batches = await readAll(runtime, quickbooks, connection(), 'invoices')
    expect(records(batches)).toHaveLength(1001)
    expect(fetch.calls).toHaveLength(2)
    const query = new URL(fetch.calls[1].url).searchParams
    expect(query.get('query')).toBe(
      'SELECT * FROM Invoice ORDERBY Metadata.LastUpdatedTime STARTPOSITION 1001 MAXRESULTS 1000'
    )
    expect(query.get('minorversion')).toBe('75')
    const [first] = records(batches)
    expect(first.externalId).toBe('1')
    expect(first.properties).toMatchObject({ doc_number: 'INV-1', total_amt: 120.5 })
    expect(first.properties).not.toHaveProperty('line')
    expect(first.properties).not.toHaveProperty('sync_token')
    expect(first.links).toEqual(
      expect.arrayContaining([
        { type: 'BILLED_TO', target: 'customers', direction: 'out', externalIds: ['58'] },
        { type: 'INCLUDES_ITEM', target: 'items', direction: 'out', externalIds: ['7', '9'] }
      ])
    )
    expect(batches.at(-1)!.state.cursor).toBe('2024-03-05T10:00:00-08:00')
  })

  it('links payments to the invoices they pay', async () => {
    const payment = {
      Id: '90',
      CustomerRef: { value: '58' },
      Line: [
        { Amount: 50, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }] },
        { Amount: 10, LinkedTxn: [{ TxnId: '4', TxnType: 'CreditMemo' }, { TxnId: '2', TxnType: 'Invoice' }] }
      ],
      MetaData: { LastUpdatedTime: '2024-03-02T10:00:00-08:00' }
    }
    expect(linkedTransactions(payment)).toEqual({ Invoice: ['1', '2'], CreditMemo: ['4'] })
    const { runtime } = mockRuntime([{ path: `${BASE}/query`, body: { QueryResponse: { Payment: [payment] } } }])
    const [record] = records(await readAll(runtime, quickbooks, connection(), 'payments'))
    expect(record.links).toEqual(
      expect.arrayContaining([{ type: 'PAYS', target: 'invoices', direction: 'out', externalIds: ['1', '2'] }])
    )
    expect(Object.keys(record.properties).some((name) => name.includes('linked'))).toBe(false)
  })

  it('reads changes after the cursor and deletions from change data capture', async () => {
    const cursor = new Date(Date.now() - 3600_000).toISOString()
    const { fetch, runtime } = mockRuntime([
      { path: `${BASE}/query`, body: { QueryResponse: { Invoice: [invoice(3)] } } },
      {
        path: `${BASE}/cdc`,
        body: {
          CDCResponse: [
            {
              QueryResponse: [
                { Invoice: [invoice(3), { domain: 'QBO', status: 'Deleted', Id: '12', MetaData: { LastUpdatedTime: '2099-01-01T00:00:00Z' } }] }
              ]
            }
          ]
        }
      }
    ])
    const batches = await readAll(runtime, quickbooks, connection(), 'invoices', { cursor })
    const query = new URL(fetch.calls[0].url).searchParams.get('query')
    expect(query).toBe(
      `SELECT * FROM Invoice WHERE Metadata.LastUpdatedTime > '${new Date(Date.parse(cursor) - 120_000).toISOString()}' ORDERBY Metadata.LastUpdatedTime STARTPOSITION 1 MAXRESULTS 1000`
    )
    expect(new URL(fetch.calls[1].url).searchParams.get('entities')).toBe('Invoice')
    const deleted = records(batches).filter((record) => record.deleted)
    expect(deleted.map((record) => record.externalId)).toEqual(['12'])
    expect(batches.at(-1)!.state.cursor).toBe('2099-01-01T00:00:00Z')
  })

  it('skips change data capture for cursors older than 30 days', async () => {
    const { fetch, runtime } = mockRuntime([{ path: `${BASE}/query`, body: { QueryResponse: {} } }])
    await readAll(runtime, quickbooks, connection(), 'invoices', { cursor: '2020-01-01T00:00:00Z' })
    expect(fetch.calls.map((call) => new URL(call.url).pathname)).toEqual([`${BASE}/query`])
  })

  it('routes webhook notifications with an id per change', () => {
    const spec = parseConnectorSpec(quickbooks.spec)
    const events = parseWebhook(spec, {
      eventNotifications: [
        {
          realmId: '4620816365',
          dataChangeEvent: {
            entities: [
              { name: 'Invoice', id: '1', operation: 'Update', lastUpdated: '2024-03-02T18:00:00.000Z' },
              { name: 'Customer', id: '58', operation: 'Delete', lastUpdated: '2024-03-02T18:01:00.000Z' },
              { name: 'TimeActivity', id: '3', operation: 'Create', lastUpdated: '2024-03-02T18:02:00.000Z' }
            ]
          }
        }
      ]
    })
    expect(events).toEqual([
      { id: '1:2024-03-02T18:00:00.000Z', type: 'Invoice.Update', stream: 'invoices', action: 'refetch', externalId: '1' },
      { id: '58:2024-03-02T18:01:00.000Z', type: 'Customer.Delete', stream: 'customers', action: 'delete', externalId: '58' }
    ])
  })
})
