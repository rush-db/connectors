import { describe, expect, it } from 'vitest'

import { AgentClient, interpolateEnv, normalizeValue, pageQuery, parseAgentConfig, RushDBAgent } from '../src/agent'
import { hashPiiValue } from '../src/pii'
import { createMockFetch, noSleep } from '../src/testing'

import type { AgentStreamConfig, Position, Row, SourceDriver } from '../src/agent'

const CONFIG = `
rushdb:
  url: https://rushdb.example.com
  token: \${TOKEN}
sources:
  - name: wh
    type: clickhouse
    url: \${CH_URL:-https://reader@clickhouse.internal:8443}
    streams:
      - name: accounts
        label: ACCOUNT
        table: analytics.accounts
        id: account_id
        cursor: updated_at
        columns: [account_id, name, email, plan, updated_at]
        batchSize: 10
      - name: invoices
        label: INVOICE
        query: SELECT * FROM invoices;
        id: invoice_id
        relations:
          - { type: BILLED_TO, target: wh.accounts, field: account_id }
        batchSize: 10
`

describe('agent config', () => {
  it('interpolates the environment and validates streams', () => {
    const config = parseAgentConfig(CONFIG, { TOKEN: 'rag_x_secretsecretsecretsecret' })
    expect(config.rushdb.token).toBe('rag_x_secretsecretsecretsecret')
    expect(config.sources[0].url).toBe('https://reader@clickhouse.internal:8443')
    expect(config.sources[0].streams[1].relations?.[0].target).toBe('wh.accounts')
  })

  it('refuses a missing secret, plain http and unknown relation targets', () => {
    expect(() => interpolateEnv('${NOPE}', {})).toThrow(/NOPE/)
    expect(() => parseAgentConfig(CONFIG.replace('https://rushdb', 'http://rushdb'), { TOKEN: 'rag_x_secretsecretsecretsecret' })).toThrow(/https/)
    expect(() =>
      parseAgentConfig(CONFIG.replace('target: wh.accounts', 'target: wh.nope'), { TOKEN: 'rag_x_secretsecretsecretsecret' })
    ).toThrow(/not a stream/)
  })
})

describe('keyset queries', () => {
  const stream = { name: 's', label: 'L', table: 'public.t', id: 'id', cursor: 'updated_at', batchSize: 100, columns: ['name'] } as AgentStreamConfig

  it('pages after (cursor, id) with parameters in Postgres and MySQL', () => {
    expect(pageQuery(stream, 'postgres', { cursor: '2024-01-01', id: 7 }, 100)).toEqual({
      text: 'SELECT "name", "id", "updated_at" FROM "public"."t" WHERE ("updated_at" > $1 OR ("updated_at" = $2 AND "id" > $3)) ORDER BY "updated_at", "id" LIMIT 100',
      params: ['2024-01-01', '2024-01-01', 7]
    })
    expect(pageQuery(stream, 'mysql', {}, 50).text).toBe(
      'SELECT `name`, `id`, `updated_at` FROM `public`.`t` ORDER BY `updated_at`, `id` LIMIT 50'
    )
  })

  it('escapes ClickHouse literals and wraps queries', () => {
    const query = pageQuery(
      { ...stream, table: undefined, query: 'SELECT * FROM x;', columns: undefined } as AgentStreamConfig,
      'clickhouse',
      { cursor: "2024-01-01 00:00:00", id: "a'b" },
      10
    )
    expect(query.text).toBe(
      "SELECT * FROM (SELECT * FROM x) AS rushdb_source WHERE (`updated_at` > '2024-01-01 00:00:00' OR (`updated_at` = '2024-01-01 00:00:00' AND `id` > 'a\\'b')) ORDER BY `updated_at`, `id` LIMIT 10"
    )
    expect(query.params).toEqual([])
  })

  it('normalizes database values', () => {
    expect(normalizeValue(new Date('2024-01-02T03:04:05Z'))).toBe('2024-01-02T03:04:05.000Z')
    expect(normalizeValue(10n)).toBe(10)
    expect(normalizeValue('2024-01-02 03:04:05')).toBe('2024-01-02T03:04:05Z')
    expect(normalizeValue({ a: new Date(0) })).toEqual({ a: '1970-01-01T00:00:00.000Z' })
  })
})

/** A table in memory, paged the way the SQL drivers page. */
function fakeDriver(tables: Record<string, Row[]>): SourceDriver {
  return {
    connect: async () => 'fake 1.0',
    close: async () => undefined,
    sample: async (stream: AgentStreamConfig, limit: number) => (tables[stream.name] ?? []).slice(0, limit),
    page: async (stream: AgentStreamConfig, after: Position, limit: number) => {
      const rows = [...(tables[stream.name] ?? [])].sort((a, b) =>
        stream.cursor ?
          String(a[stream.cursor]).localeCompare(String(b[stream.cursor])) || String(a[stream.id]).localeCompare(String(b[stream.id]))
        : String(a[stream.id]).localeCompare(String(b[stream.id]))
      )
      return rows
        .filter((row) => {
          if (stream.cursor && after.cursor !== undefined) {
            const cursor = String(row[stream.cursor])
            return cursor > String(after.cursor) || (cursor === String(after.cursor) && String(row[stream.id]) > String(after.id))
          }
          return after.id === undefined || String(row[stream.id]) > String(after.id)
        })
        .slice(0, limit)
    }
  }
}

describe('agent cycle', () => {
  const accounts = Array.from({ length: 15 }, (_, index) => ({
    account_id: `a${String(index).padStart(2, '0')}`,
    name: `Account ${index}`,
    email: `owner${index}@example.com`,
    plan: index % 2 ? 'pro' : 'free',
    updated_at: `2024-01-${String(1 + index).padStart(2, '0')}`
  }))
  const invoices = [{ invoice_id: 'i1', account_id: 'a01', amount: 10, card_number: '4111111111111111' }]

  function setup(policy: Record<string, unknown> = { mode: 'auto' }) {
    const batches: any[] = []
    const fetch = createMockFetch([
      {
        path: '/api/v1/agent',
        respond: () => ({
          body: {
            data: {
              connection: { id: 'c', name: 'On-prem', paused: false },
              intervalMinutes: 15,
              syncRequested: false,
              hashKey: 'project-key',
              streams: [
                { stream: 'wh.accounts', label: 'ACCOUNT', enabled: true, deleteMode: 'soft', policy, state: null },
                { stream: 'wh.invoices', label: 'INVOICE', enabled: true, deleteMode: 'soft', policy: { mode: 'auto' }, state: null }
              ]
            }
          }
        })
      },
      { method: 'POST', path: '/api/v1/agent/runs', body: { data: { runId: 'run-1', full: false } } },
      {
        method: 'POST',
        path: /\/runs\/run-1\/batches$/,
        respond: ({ body }) => {
          batches.push(body)
          return { body: { data: { written: (body as any).records.length, deleted: 0, links: 0 } } }
        }
      },
      { method: 'POST', path: /\/runs\/run-1\/finish$/, body: { data: { status: 'completed' } } }
    ])
    const config = parseAgentConfig(CONFIG, { TOKEN: 'rag_x_secretsecretsecretsecret' })
    const agent = new RushDBAgent({
      client: new AgentClient(config.rushdb.url, config.rushdb.token, { fetch, sleep: noSleep }),
      config,
      driverFor: () => fakeDriver({ accounts, invoices }),
      log: () => undefined
    })
    return { agent, batches, fetch }
  }

  it('pages every stream with checkpoints and keeps personal data home', async () => {
    const { agent, batches, fetch } = setup()
    await agent.connect()
    const report = await agent.cycle()
    expect(report.status).toBe('completed')
    const accountBatches = batches.filter((batch) => batch.stream === 'wh.accounts')
    expect(accountBatches.map((batch) => batch.records.length)).toEqual([10, 5])
    expect(accountBatches[0].state).toEqual({ id: 'a09', cursor: '2024-01-10' })
    const sent = JSON.stringify(batches)
    // Not reviewed yet: fields that look personal never leave.
    expect(sent).not.toContain('@example.com')
    expect(sent).not.toContain('4111111111111111')
    expect(accountBatches[0].records[0].properties).toMatchObject({ name: 'Account 0', plan: 'free', external_id: 'a00' })
    // The token goes in its own header, never Authorization.
    expect(fetch.calls[0].headers['x-rushdb-agent-token']).toBe('rag_x_secretsecretsecretsecret')
    expect(fetch.calls[0].headers.authorization).toBeUndefined()
  })

  it('applies a reviewed allowlist and hashes with the project key', async () => {
    const { agent, batches } = setup({ mode: 'allowlist', include: ['plan'], hash: ['email'] })
    await agent.connect()
    await agent.cycle()
    const first = batches.find((batch) => batch.stream === 'wh.accounts').records[0].properties
    expect(Object.keys(first).sort()).toEqual(['email', 'external_id', 'plan'])
    expect(first.email).toBe(hashPiiValue('owner0@example.com', 'project-key'))
  })

  it('reports field profiles without values', async () => {
    const reports: any[] = []
    const fetch = createMockFetch([
      { method: 'POST', path: '/api/v1/agent/fields', respond: ({ body }) => (reports.push(body), { body: { data: { received: 2 } } }) }
    ])
    const config = parseAgentConfig(CONFIG, { TOKEN: 'rag_x_secretsecretsecretsecret' })
    const agent = new RushDBAgent({
      client: new AgentClient(config.rushdb.url, config.rushdb.token, { fetch, sleep: noSleep }),
      config,
      driverFor: () => fakeDriver({ accounts, invoices }),
      log: () => undefined
    })
    await agent.connect()
    await agent.reportFields()
    const sent = JSON.stringify(reports)
    expect(sent).toContain('"kind":"email"')
    expect(sent).not.toContain('example.com')
    expect(sent).not.toContain('Account 0')
  })
})
