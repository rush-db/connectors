import { importDriver, type Position, type Row, type SourceDriver } from './driver'
import { pageQuery, sampleQuery } from './sql'

import type { AgentSourceConfig, AgentStreamConfig } from '../config'

export function postgresDriver(source: AgentSourceConfig): SourceDriver {
  let pool: any
  return {
    async connect() {
      const pg = await importDriver<any>('pg')
      const Pool = pg.Pool ?? pg.default?.Pool
      // Read-only at the session level too, whatever the user may do.
      pool = new Pool({ connectionString: source.url, max: 2, options: '-c default_transaction_read_only=on' })
      const { rows } = await pool.query('SELECT version() AS version')
      return String(rows[0]?.version ?? 'postgres')
    },
    async page(stream: AgentStreamConfig, after: Position, limit: number): Promise<Row[]> {
      const { text, params } = pageQuery(stream, 'postgres', after, limit)
      return (await pool.query(text, params)).rows
    },
    async sample(stream: AgentStreamConfig, limit: number): Promise<Row[]> {
      return (await pool.query(sampleQuery(stream, 'postgres', limit))).rows
    },
    async close() {
      await pool?.end()
    }
  }
}
