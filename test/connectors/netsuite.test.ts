import { describe, expect, it } from 'vitest'

import { netsuite } from '../../src/connectors'
import { TABLES, pageQuery } from '../../src/connectors/netsuite'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const SUITEQL = '/services/rest/query/v1/suiteql'
const connection = (): ConnectionContext => ({
  config: { account: '1234567-sb1' },
  credentials: { type: 'oauth2', accessToken: 'token' }
})
const table = (name: string) => TABLES.find((candidate) => candidate.table === name)!

const transaction = (n: number) => ({
  links: [],
  id: String(n),
  rushdb_id: n,
  tranid: `INV${n}`,
  type: 'CustInvc',
  entity: '58',
  foreigntotal: '120.50',
  rushdb_modified_at: `2024-03-01T10:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:00Z`
})

describe('netsuite', () => {
  it('parses', () => {
    const spec = parseConnectorSpec(netsuite.spec)
    expect(spec.category).toBe('accounting')
    expect(spec.streams.transaction_lines.optional).toBe(true)
    expect(spec.baseUrl).toBe('https://{{config.account}}.suitetalk.api.netsuite.com')
  })

  it('pages by key, never by offset', () => {
    expect(pageQuery(table('transaction'), {})).toBe(
      `SELECT t.*, t.id AS rushdb_id, TO_CHAR(t.lastmodifieddate, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS rushdb_modified_at FROM transaction t ORDER BY t.lastmodifieddate, t.id`
    )
    expect(pageQuery(table('transaction'), { modified: '2024-03-01T10:00:00Z' })).toContain(
      `WHERE t.lastmodifieddate >= TO_TIMESTAMP('2024-03-01 10:00:00', 'YYYY-MM-DD HH24:MI:SS')`
    )
    expect(pageQuery(table('transaction'), { modified: '2024-03-01T10:00:00Z', id: '42' })).toContain(
      `(t.lastmodifieddate > TO_TIMESTAMP('2024-03-01 10:00:00', 'YYYY-MM-DD HH24:MI:SS') OR (t.lastmodifieddate = TO_TIMESTAMP('2024-03-01 10:00:00', 'YYYY-MM-DD HH24:MI:SS') AND t.id > 42))`
    )
    expect(pageQuery(table('subsidiary'), { id: '7' })).toBe(
      'SELECT t.*, t.id AS rushdb_id FROM subsidiary t WHERE t.id > 7 ORDER BY t.id'
    )
    expect(pageQuery(table('transactionline'), {})).toContain('t.uniquekey AS rushdb_id')
    // A key that is not a number cannot reach the query.
    expect(() => pageQuery(table('subsidiary'), { id: '1 OR 1=1' })).toThrow(/not an internal id/)
  })

  it('backfills transactions with keyed pages against the account host', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: SUITEQL,
        respond: ({ body }) => {
          const q = (body as { q: string }).q
          const items = q.includes('t.id > 1000') ? [transaction(1001)] : Array.from({ length: 1000 }, (_, index) => transaction(index + 1))
          return { body: { items, hasMore: false, count: items.length, offset: 0 } }
        }
      }
    ])
    const batches = await readAll(runtime, netsuite, connection(), 'transactions')
    expect(records(batches)).toHaveLength(1001)
    expect(fetch.calls).toHaveLength(2)
    expect(fetch.calls[0].url.startsWith('https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?')).toBe(true)
    expect(fetch.calls[0].headers.prefer).toBe('transient')
    expect(new URL(fetch.calls[1].url).searchParams.get('offset')).toBe('0')
    expect((fetch.calls[1].body as { q: string }).q).toContain(`= TO_TIMESTAMP('2024-03-01 10:16:00', 'YYYY-MM-DD HH24:MI:SS') AND t.id > 1000`)
    const [first] = records(batches)
    expect(first.externalId).toBe('1')
    expect(first.properties).toMatchObject({ tranid: 'INV1', entity: '58', rushdb_modified_at: '2024-03-01T10:00:00.000Z' })
    expect(first.properties).not.toHaveProperty('links')
    expect(batches.at(-1)!.state.cursor).toBe('2024-03-01T10:16:00Z')
  })

  it('starts an incremental read a lookback before the cursor', async () => {
    const { fetch, runtime } = mockRuntime([{ method: 'POST', path: SUITEQL, body: { items: [] } }])
    await readAll(runtime, netsuite, connection(), 'customers', { cursor: '2024-03-01T10:05:00Z' })
    expect((fetch.calls[0].body as { q: string }).q).toContain(
      `WHERE t.lastmodifieddate >= TO_TIMESTAMP('2024-03-01 10:00:00', 'YYYY-MM-DD HH24:MI:SS')`
    )
  })

  it('stops when a full page does not move the key', async () => {
    const same = Array.from({ length: 1000 }, () => ({ id: '5', rushdb_id: 5 }))
    const { fetch, runtime } = mockRuntime([{ method: 'POST', path: SUITEQL, body: { items: same } }])
    await readAll(runtime, netsuite, connection(), 'subsidiaries')
    expect(fetch.calls).toHaveLength(2)
  })
})
