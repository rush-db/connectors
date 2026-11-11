import { importDriver, type Position, type Row, type SourceDriver } from './driver'
import { pageQuery, sampleQuery } from './sql'

import type { AgentSourceConfig, AgentStreamConfig } from '../config'

export function mysqlDriver(source: AgentSourceConfig): SourceDriver {
  let pool: any
  return {
    async connect() {
      const mysql = await importDriver<any>('mysql2/promise')
      pool = mysql.createPool({ uri: source.url, connectionLimit: 2, dateStrings: false, supportBigNumbers: true })
      const connection = await pool.getConnection()
      try {
        await connection.query('SET SESSION TRANSACTION READ ONLY')
        const [rows] = await connection.query('SELECT VERSION() AS version')
        return String(rows[0]?.version ?? 'mysql')
      } finally {
        connection.release()
      }
    },
    async page(stream: AgentStreamConfig, after: Position, limit: number): Promise<Row[]> {
      const { text, params } = pageQuery(stream, 'mysql', after, limit)
      const [rows] = await pool.query(text, params)
      return rows
    },
    async sample(stream: AgentStreamConfig, limit: number): Promise<Row[]> {
      const [rows] = await pool.query(sampleQuery(stream, 'mysql', limit))
      return rows
    },
    async close() {
      await pool?.end()
    }
  }
}
