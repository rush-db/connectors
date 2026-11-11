import type { AgentSourceConfig, AgentStreamConfig } from '../config'

export type Row = Record<string, unknown>

/** Where a stream's last page ended: the cursor value and the id of its last row. */
export type Position = { cursor?: unknown; id?: unknown }

export interface SourceDriver {
  /** Connects and returns a version string (for `check` and heartbeats). */
  connect(): Promise<string>
  /** The next rows after `after`, ordered by (cursor, id) or by id. */
  page(stream: AgentStreamConfig, after: Position, limit: number): Promise<Row[]>
  /** A few rows for the field review (read locally, never sent). */
  sample(stream: AgentStreamConfig, limit: number): Promise<Row[]>
  close(): Promise<void>
}

export type DriverFactory = (source: AgentSourceConfig) => SourceDriver

/** Optional peer dependencies: only the drivers a config uses must be installed. */
export async function importDriver<T = any>(name: string): Promise<T> {
  try {
    // A real dynamic import, also from the CommonJS build.
    const load = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>
    const module = await load(name)
    return (module.default ?? module) as T
  } catch {
    throw new Error(`The ${name} package is needed for this source: npm install ${name} (the Docker image has every driver)`)
  }
}

/** Columns a stream selects: the configured ones plus id, cursor, relation and deletion columns. */
export function selectedColumns(stream: AgentStreamConfig): string[] | undefined {
  if (!stream.columns?.length) {
    return undefined
  }
  return [
    ...new Set([
      ...stream.columns,
      stream.id,
      ...(stream.cursor ? [stream.cursor] : []),
      ...(stream.relations ?? []).map((relation) => relation.field),
      ...(stream.deleted ? [stream.deleted.column] : [])
    ])
  ]
}
