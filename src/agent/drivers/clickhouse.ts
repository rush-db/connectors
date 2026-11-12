import { importDriver, type Position, type Row, type SourceDriver } from './driver'
import { pageQuery, sampleQuery } from './sql'

import type { AgentSourceConfig, AgentStreamConfig } from '../config'

/**
 * ClickHouse has no change log a CDC tool can follow; the agent reads it by
 * keyset over a cursor column (`updated_at`, or the version column of a
 * ReplacingMergeTree). Use `FINAL` in a configured query when rows are
 * replaced and you need the merged state.
 */
export function clickhouseDriver(source: AgentSourceConfig): SourceDriver {
  let client: any
  const run = async (query: string): Promise<Row[]> => {
    const result = await client.query({ query, format: 'JSONEachRow' })
    return (await result.json()) as Row[]
  }
  return {
    async connect() {
      const module = await importDriver<any>('@clickhouse/client')
      const createClient = module.createClient ?? module.default?.createClient
      client = createClient({
        url: source.url,
        ...(source.database ? { database: source.database } : {}),
        // readonly=1: the session refuses writes and settings changes.
        clickhouse_settings: { readonly: '1' as any }
      })
      const [row] = await run('SELECT version() AS version')
      return `clickhouse ${row?.version ?? ''}`.trim()
    },
    page(stream: AgentStreamConfig, after: Position, limit: number) {
      return run(pageQuery(stream, 'clickhouse', after, limit).text)
    },
    sample(stream: AgentStreamConfig, limit: number) {
      return run(sampleQuery(stream, 'clickhouse', limit))
    },
    async close() {
      await client?.close()
    }
  }
}
