import { describe, expect, it } from 'vitest'

import { xero } from '../../src/connectors'
import { xeroDates } from '../../src/connectors/xero'
import { parseConnectorSpec, parseWebhook, type ConnectionContext } from '../../src'
import type { MockRoute } from '../../src/testing'
import { mockRuntime, readAll, records } from '../helpers'

const connection = (tenant?: string): ConnectionContext => ({
  config: tenant ? { tenant } : {},
  credentials: { type: 'oauth2', accessToken: 'token' }
})

const connections = (...names: string[]): MockRoute => ({
  path: '/connections',
  body: names.map((name, index) => ({ tenantId: `tenant-${index + 1}`, tenantName: name, tenantType: 'ORGANISATION' }))
})

const invoice = (n: number) => ({
  InvoiceID: `inv-${n}`,
  InvoiceNumber: `INV-${n}`,
  Type: 'ACCREC',
  Status: 'AUTHORISED',
  Total: 115,
  Contact: { ContactID: 'c-1', Name: 'Acme' },
  LineItems: [{ Description: 'Widget', Item: { ItemID: 'item-1', Code: 'W' } }],
  Payments: [{ PaymentID: 'pay-1' }],
  Date: '/Date(1709251200000+0000)/',
  UpdatedDateUTC: `/Date(${1709251200000 + n * 1000}+0000)/`
})

describe('xero', () => {
  it('parses with granular read scopes only', () => {
    const spec = parseConnectorSpec(xero.spec)
    const oauth = spec.auth[0]
    expect(oauth.type === 'oauth2' && oauth.scopes.filter((scope) => scope !== 'offline_access').every((scope) => scope.endsWith('.read'))).toBe(true)
    expect(Object.keys(spec.streams)).toContain('bank_transactions')
  })

  it('turns Microsoft JSON dates into ISO', () => {
    expect(xeroDates({ a: '/Date(1573755038314+0000)/', b: ['/Date(0)/'], c: 'Date(1)', d: 3 })).toEqual({
      a: '2019-11-14T18:10:38.314Z',
      b: ['1970-01-01T00:00:00.000Z'],
      c: 'Date(1)',
      d: 3
    })
  })

  it('tests the connection by naming the organisation', async () => {
    const { runtime } = mockRuntime([connections('Demo Company (UK)')])
    expect(await runtime.test(xero, connection())).toMatchObject({ account: 'Demo Company (UK)' })
  })

  it('asks for the organisation when the authorization reaches several', async () => {
    const { runtime } = mockRuntime([connections('One', 'Two')])
    await expect(readAll(runtime, xero, connection(), 'invoices')).rejects.toThrow(/2 organisations \(One, Two\)/)
  })

  it('backfills invoices page by page for the chosen organisation', async () => {
    const { fetch, runtime } = mockRuntime([
      connections('One', 'Two'),
      {
        path: '/api.xro/2.0/Invoices',
        respond: ({ url }) => ({
          body: {
            Invoices: url.searchParams.get('page') === '1' ? Array.from({ length: 1000 }, (_, index) => invoice(index + 1)) : [invoice(1001)]
          }
        })
      }
    ])
    const batches = await readAll(runtime, xero, connection('two'), 'invoices')
    expect(records(batches)).toHaveLength(1001)
    const reads = fetch.calls.filter((call) => call.url.includes('/Invoices'))
    expect(reads).toHaveLength(2)
    expect(reads[0].headers['xero-tenant-id']).toBe('tenant-2')
    expect(reads[0].headers['if-modified-since']).toBeUndefined()
    expect(new URL(reads[1].url).searchParams.get('pageSize')).toBe('1000')
    const [first] = records(batches)
    expect(first.externalId).toBe('inv-1')
    expect(first.properties).toMatchObject({ invoice_number: 'INV-1', date: '2024-03-01T00:00:00.000Z' })
    expect(first.properties).not.toHaveProperty('line_items')
    expect(first.links).toEqual(
      expect.arrayContaining([
        { type: 'FOR_CONTACT', target: 'contacts', direction: 'out', externalIds: ['c-1'] },
        { type: 'INCLUDES_ITEM', target: 'items', direction: 'out', externalIds: ['item-1'] },
        { type: 'PAID_BY', target: 'payments', direction: 'out', externalIds: ['pay-1'] }
      ])
    )
    expect(batches.at(-1)!.state.cursor).toBe(new Date(1709251200000 + 1001 * 1000).toISOString())
  })

  it('reads changes since the cursor and treats 304 as none', async () => {
    const { fetch, runtime } = mockRuntime([
      connections('One'),
      { path: '/api.xro/2.0/Accounts', status: 304 }
    ])
    const batches = await readAll(runtime, xero, connection(), 'accounts', { cursor: '2024-03-01T00:02:00.000Z' })
    expect(records(batches)).toEqual([])
    const read = fetch.calls.find((call) => call.url.includes('/Accounts'))!
    expect(read.headers['if-modified-since']).toBe('2024-03-01T00:00:00')
    expect(new URL(read.url).searchParams.has('page')).toBe(false)
    expect(batches.at(-1)!.state.cursor).toBe('2024-03-01T00:02:00.000Z')
  })

  it('refetches the stream a webhook event names', () => {
    const events = parseWebhook(parseConnectorSpec(xero.spec), {
      events: [
        { resourceId: 'inv-1', eventDateUtc: '2024-03-01T10:00:00.000', eventType: 'UPDATE', eventCategory: 'INVOICE', tenantId: 't' },
        { resourceId: 'c-1', eventDateUtc: '2024-03-01T10:01:00.000', eventType: 'CREATE', eventCategory: 'CONTACT', tenantId: 't' }
      ],
      firstEventSequence: 1,
      lastEventSequence: 2,
      entropy: 'x'
    })
    expect(events).toEqual([
      { id: 'inv-1:2024-03-01T10:00:00.000', type: 'INVOICE.UPDATE', stream: 'invoices', action: 'refetch', externalId: 'inv-1' },
      { id: 'c-1:2024-03-01T10:01:00.000', type: 'CONTACT.CREATE', stream: 'contacts', action: 'refetch', externalId: 'c-1' }
    ])
  })
})
