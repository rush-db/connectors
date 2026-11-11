import { readFileSync } from 'node:fs'

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/*
 * The agent's local configuration. It lives on the customer's host and is
 * the outer wall of what can leave their network: only the sources and
 * streams listed here are read, only the `columns` listed (when given) are
 * selected, and the field doctrine set in RushDB is applied on top before
 * a batch is sent. Secrets come from the environment (`${VAR}`), never from
 * RushDB.
 */

const relationSchema = z.object({
  type: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** Another stream of this config, as `<source>.<stream>`. */
  target: z.string(),
  /** The column holding the target's id. */
  field: z.string(),
  direction: z.enum(['in', 'out']).optional()
})

export const agentStreamSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    label: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    /** SQL sources: a table (`schema.table`) or a SELECT. MongoDB: a collection. */
    table: z.string().optional(),
    query: z.string().optional(),
    collection: z.string().optional(),
    /** MongoDB only: a filter document applied to every read. */
    filter: z.record(z.unknown()).optional(),
    /** The column identifying a row (unique, never changes). */
    id: z.string().default('id'),
    /** A column that grows when a row changes (`updated_at`, a version). Without one, every cycle reads everything. */
    cursor: z.string().optional(),
    /** Only these columns leave the host (besides id and cursor). Recommended. */
    columns: z.array(z.string()).optional(),
    relations: z.array(relationSchema).optional(),
    /** A row is a deletion when this column has this value (soft-delete flags). */
    deleted: z.object({ column: z.string(), value: z.unknown().default(true) }).optional(),
    batchSize: z.number().int().min(1).max(5000).default(1000)
  })
  .refine((stream) => [stream.table, stream.query, stream.collection].filter(Boolean).length === 1, {
    message: 'A stream has exactly one of table, query or collection'
  })
export type AgentStreamConfig = z.output<typeof agentStreamSchema>

export const agentSourceSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  type: z.enum(['postgres', 'mysql', 'mongodb', 'clickhouse']),
  /** Connection URL. Use a read-only user. */
  url: z.string().min(1),
  /** MongoDB: the database (when the URL has none). ClickHouse: the database. */
  database: z.string().optional(),
  streams: z.array(agentStreamSchema).min(1)
})
export type AgentSourceConfig = z.output<typeof agentSourceSchema>

export const agentConfigSchema = z.object({
  rushdb: z.object({
    /** The RushDB API: RushDB Cloud or your own server. */
    url: z.string().url(),
    /** The connection's agent token (`rag_…`), shown once in RushDB. */
    token: z.string().min(20),
    /** Allow http:// (a self-hosted RushDB on the same private network). */
    allowInsecure: z.boolean().default(false)
  }),
  sources: z.array(agentSourceSchema).min(1),
  /** Seconds between checks for "Sync now" between cycles. */
  pollSeconds: z.number().int().min(5).max(3600).default(30),
  /** Where the agent writes its local log of what it sent (counts only, no values). Off when unset. */
  auditLog: z.string().optional()
})
export type AgentConfig = z.output<typeof agentConfigSchema>

/** `${VAR}` and `${VAR:-default}` from the environment; a missing variable without a default is an error. */
export function interpolateEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_match, name: string, fallback?: string) => {
    const value = env[name] ?? fallback
    if (value === undefined) {
      throw new Error(`Environment variable ${name} is not set (used in the agent config)`)
    }
    return value
  })
}

export function parseAgentConfig(text: string, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const raw = parseYaml(interpolateEnv(text, env))
  const config = agentConfigSchema.parse(raw)
  if (!config.rushdb.allowInsecure && !config.rushdb.url.startsWith('https://')) {
    throw new Error('rushdb.url must be https:// (set rushdb.allowInsecure for a RushDB on your own private network)')
  }
  const names = new Set<string>()
  for (const source of config.sources) {
    for (const stream of source.streams) {
      const id = streamId(source, stream)
      if (names.has(id)) {
        throw new Error(`Duplicate stream ${id}`)
      }
      names.add(id)
      if (source.type === 'mongodb' ? !stream.collection : stream.collection) {
        throw new Error(`${id}: MongoDB streams use collection; SQL streams use table or query`)
      }
    }
  }
  for (const source of config.sources) {
    for (const stream of source.streams) {
      for (const relation of stream.relations ?? []) {
        if (!names.has(relation.target)) {
          throw new Error(`${streamId(source, stream)}: relation target ${relation.target} is not a stream of this config`)
        }
      }
    }
  }
  return config
}

export function loadAgentConfig(path: string, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return parseAgentConfig(readFileSync(path, 'utf8'), env)
}

/** The stream's id in RushDB: `<source>.<stream>`. */
export const streamId = (source: { name: string }, stream: { name: string }) => `${source.name}.${stream.name}`

export const SAMPLE_CONFIG = `# rushdb-agent configuration. Secrets come from the environment.
rushdb:
  url: https://api.rushdb.com
  token: \${RUSHDB_AGENT_TOKEN}

sources:
  - name: warehouse
    type: clickhouse            # postgres | mysql | mongodb | clickhouse
    url: \${CLICKHOUSE_URL}     # a read-only user, e.g. https://reader:secret@clickhouse.internal:8443
    database: analytics
    streams:
      - name: accounts
        label: ACCOUNT
        table: accounts
        id: account_id
        cursor: updated_at      # rows are re-read when this grows
        columns: [account_id, name, plan, region, updated_at]   # only these leave the host
      - name: invoices
        label: INVOICE
        query: SELECT invoice_id, account_id, amount, status, updated_at FROM invoices WHERE status != 'draft'
        id: invoice_id
        cursor: updated_at
        relations:
          - { type: BILLED_TO, target: warehouse.accounts, field: account_id }
`
