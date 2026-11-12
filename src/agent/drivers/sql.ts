import { selectedColumns, type Position } from './driver'

import type { AgentStreamConfig } from '../config'

export type Dialect = 'postgres' | 'mysql' | 'clickhouse'

/** Quote an identifier (or a dotted path `schema.table`) for a dialect. */
export function quoteIdentifier(name: string, dialect: Dialect): string {
  return name
    .split('.')
    .map((part) =>
      dialect === 'postgres' ? `"${part.replace(/"/g, '""')}"` : `\`${part.replace(/`/g, '``')}\``
    )
    .join('.')
}

/** A literal for ClickHouse, whose client takes no positional parameters here. */
export function clickhouseLiteral(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (value instanceof Date) {
    return `'${value.toISOString().replace('T', ' ').replace('Z', '')}'`
  }
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * The keyset query of one page: rows after (cursor, id), ordered by them,
 * so a page never skips or repeats a row even when many share a cursor
 * value. A configured `query` is wrapped as a subquery.
 */
export function pageQuery(
  stream: AgentStreamConfig,
  dialect: Dialect,
  after: Position,
  limit: number
): { text: string; params: unknown[] } {
  const q = (name: string) => quoteIdentifier(name, dialect)
  const params: unknown[] = []
  const param = (value: unknown) => {
    if (dialect === 'clickhouse') {
      return clickhouseLiteral(value)
    }
    params.push(value)
    return dialect === 'postgres' ? `$${params.length}` : '?'
  }
  const columns = selectedColumns(stream)
  const select = columns ? columns.map(q).join(', ') : '*'
  const from = stream.query ? `(${stream.query.trim().replace(/;\s*$/, '')}) AS rushdb_source` : q(stream.table!)
  const id = q(stream.id)
  const where: string[] = []
  let order: string
  if (stream.cursor) {
    const cursor = q(stream.cursor)
    if (after.cursor !== undefined && after.cursor !== null) {
      const value = param(after.cursor)
      where.push(
        after.id !== undefined && after.id !== null ?
          `(${cursor} > ${value} OR (${cursor} = ${dialect === 'clickhouse' ? value : param(after.cursor)} AND ${id} > ${param(after.id)}))`
        : `${cursor} >= ${value}`
      )
    }
    order = `${cursor}, ${id}`
  } else {
    if (after.id !== undefined && after.id !== null) {
      where.push(`${id} > ${param(after.id)}`)
    }
    order = id
  }
  const text = `SELECT ${select} FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${Math.floor(limit)}`
  return { text, params }
}

export function sampleQuery(stream: AgentStreamConfig, dialect: Dialect, limit: number): string {
  const q = (name: string) => quoteIdentifier(name, dialect)
  const columns = selectedColumns(stream)
  const from = stream.query ? `(${stream.query.trim().replace(/;\s*$/, '')}) AS rushdb_source` : q(stream.table!)
  return `SELECT ${columns ? columns.map(q).join(', ') : '*'} FROM ${from} LIMIT ${Math.floor(limit)}`
}
