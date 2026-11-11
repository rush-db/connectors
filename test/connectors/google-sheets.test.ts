import { describe, expect, it } from 'vitest'

import { googleSheets } from '../../src/connectors'
import { headerNames } from '../../src/connectors/google-sheets'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const connection = (keyColumn?: string): ConnectionContext => ({
  config: { spreadsheetId: 'sheet123', ...(keyColumn ? { keyColumn } : {}) },
  credentials: { type: 'oauth2', accessToken: 'token' }
})

const meta = {
  path: '/v4/spreadsheets/sheet123',
  body: {
    sheets: [
      { properties: { sheetId: 0, title: 'Customers', sheetType: 'GRID' } },
      { properties: { sheetId: 1, title: 'Q1 Plan', sheetType: 'GRID' } },
      { properties: { sheetId: 2, title: 'Chart', sheetType: 'OBJECT' } }
    ]
  }
}

const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => [`c${from + index}@example.com`, `Customer ${from + index}`, 100 + index])

describe('google sheets', () => {
  it('parses with streams left to discovery', () => {
    expect(parseConnectorSpec(googleSheets.spec).streams).toEqual({})
  })

  it('tests with the spreadsheet title', async () => {
    const { runtime } = mockRuntime([{ path: '/v4/spreadsheets/sheet123', body: { properties: { title: 'CRM export' } } }])
    expect(await runtime.test(googleSheets, connection())).toEqual({ account: 'CRM export' })
  })

  it('discovers one stream per grid tab', async () => {
    const { runtime } = mockRuntime([meta])
    const streams = await runtime.streams(googleSheets, connection('Email'))
    expect(Object.keys(streams)).toEqual(['customers', 'q1_plan'])
    expect(streams.customers).toMatchObject({ label: 'GSHEET_CUSTOMERS', id: "$['Email']" })
  })

  it('reads rows in chunks with the header row as names and the key column as id', async () => {
    const { fetch, runtime } = mockRuntime([
      meta,
      { path: /values\/'Customers'!1%3A1$/, body: { values: [['Email', 'Name', 'Seats', '']] } },
      { path: /values\/'Customers'!2%3A5001$/, body: { values: [...rows(1, 4998), ['', '', ''], ['', 'No key', 1]] } },
      { path: /values\/'Customers'!5002%3A10001$/, body: { values: rows(5001, 1) } }
    ])
    const batches = await readAll(runtime, googleSheets, connection('Email'), 'customers')
    expect(fetch.calls.filter((call) => call.url.includes('/values/'))).toHaveLength(3)
    expect(batches[0].state).toEqual({ cursor: undefined, page: { row: 5002 } })
    expect(batches.at(-1)!.state).toEqual({ cursor: undefined })
    const all = records(batches)
    expect(all).toHaveLength(4999)
    expect(all[0]).toMatchObject({
      externalId: 'c1@example.com',
      properties: { email: 'c1@example.com', name: 'Customer 1', seats: 100, row: 2, column_d: null }
    })
    expect(all.at(-1)!.externalId).toBe('c5001@example.com')
  })

  it('resumes from the stored row and falls back to row numbers', async () => {
    const { fetch, runtime } = mockRuntime([
      meta,
      { path: /values\/'Q1%20Plan'!1%3A1$/, body: { values: [['Goal']] } },
      { path: /values\/'Q1%20Plan'!7%3A5006$/, body: { values: [['Grow']] } }
    ])
    const batches = await readAll(runtime, googleSheets, connection(), 'q1_plan', { page: { row: 7 } })
    expect(records(batches)[0]).toMatchObject({ externalId: '7', properties: { goal: 'Grow' } })
    expect(new URL(fetch.calls.at(-1)!.url).searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE')
  })

  it('names blank and repeated headers', () => {
    expect(headerNames(['Name', '', 'Name', null])).toEqual(['Name', 'column_B', 'Name_2', 'column_D'])
  })
})
