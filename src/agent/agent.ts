import { appendFileSync } from 'node:fs'
import { hostname } from 'node:os'

import { mapRecord } from '../runtime/mapper'
import { applyFieldPolicy, profileFields, type FieldPolicy } from '../pii'
import { streamSpecSchema } from '../spec'
import { AgentApiError, type AgentClient, type AgentDescription, type RemoteStream } from './client'
import { streamId, type AgentConfig, type AgentSourceConfig, type AgentStreamConfig } from './config'
import { createDriver, type Position, type Row, type SourceDriver } from './drivers'

import type { MappedRecord } from '../types'

export const AGENT_VERSION = '0.1.0'

/** Database values as JSON the graph can type: dates as ISO, big numbers safely, ids as strings. */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64')
  }
  if (typeof value === 'object') {
    // MongoDB ObjectId, Decimal128 and similar wrappers.
    const ctor = (value as object).constructor?.name
    if (ctor === 'ObjectId' || ctor === 'Decimal128' || ctor === 'Long' || ctor === 'UUID') {
      return String(value)
    }
    if (Array.isArray(value)) {
      return value.map(normalizeValue)
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeValue(item)]))
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
    // ClickHouse and MySQL datetimes without a zone are UTC.
    return `${value.replace(' ', 'T')}Z`
  }
  return value
}

/** The record mapping of a configured stream, as a connector stream spec (same mapper as SaaS connectors). */
export function streamSpecOf(source: AgentSourceConfig, stream: AgentStreamConfig) {
  const id = source.type === 'mongodb' && stream.id === 'id' ? '_id' : stream.id
  return streamSpecSchema.parse({
    label: stream.label,
    request: { path: '/' },
    records: '$',
    id: `$['${id}']`,
    relations: (stream.relations ?? []).map((relation) => ({
      type: relation.type,
      target: relation.target,
      field: relation.field,
      direction: relation.direction ?? 'out'
    })),
    ...(stream.deleted ? { deleted: { path: `$['${stream.deleted.column}']`, value: stream.deleted.value } } : {})
  })
}

export type CycleReport = {
  runId?: string
  streams: Record<string, { sent: number; written: number; skipped?: boolean; error?: string }>
  status: 'completed' | 'failed' | 'skipped' | 'paused'
}

type Options = {
  client: AgentClient
  config: AgentConfig
  driverFor?: (source: AgentSourceConfig) => SourceDriver
  log?: (message: string) => void
  signal?: AbortSignal
}

/**
 * One agent: connects to the configured sources, registers their streams,
 * and runs sync cycles. Every record is mapped and passed through the
 * stream's field doctrine here, on the customer's host, before it is sent.
 */
export class RushDBAgent {
  private drivers = new Map<string, SourceDriver>()
  private versions: string[] = []
  private readonly log: (message: string) => void

  constructor(private readonly options: Options) {
    this.log = options.log ?? ((message) => console.log(`[rushdb-agent] ${message}`))
  }

  private get config() {
    return this.options.config
  }

  private audit(entry: Record<string, unknown>) {
    if (this.config.auditLog) {
      appendFileSync(this.config.auditLog, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    }
  }

  async connect(): Promise<string[]> {
    this.versions = []
    for (const source of this.config.sources) {
      const driver = (this.options.driverFor ?? createDriver)(source)
      const version = await driver.connect()
      this.drivers.set(source.name, driver)
      this.versions.push(`${source.name}: ${version}`)
    }
    return this.versions
  }

  async close() {
    for (const driver of this.drivers.values()) {
      await driver.close().catch(() => undefined)
    }
    this.drivers.clear()
  }

  private sourcesSummary() {
    return this.config.sources.map((source) => ({ type: source.type, streams: source.streams.length }))
  }

  /** Tell RushDB which streams exist (labels and field relations), and who is reporting. */
  async register(): Promise<AgentDescription> {
    await this.options.client.heartbeat({ version: AGENT_VERSION, hostname: hostname(), sources: this.sourcesSummary() })
    return this.options.client.registerStreams(
      this.config.sources.flatMap((source) =>
        source.streams.map((stream) => ({
          stream: streamId(source, stream),
          label: stream.label,
          relations: (stream.relations ?? []).map((relation) => ({ ...relation, direction: relation.direction ?? 'out' }))
        }))
      )
    )
  }

  /** Profile sampled rows locally and report field names, types and PII findings (never values). */
  async reportFields(sampleSize = 200): Promise<number> {
    const streams = []
    for (const source of this.config.sources) {
      const driver = this.drivers.get(source.name)!
      for (const stream of source.streams) {
        const rows = (await driver.sample(stream, sampleSize)).map((row) => normalizeValue(row) as Row)
        const spec = streamSpecOf(source, stream)
        const properties = rows.map((row) => mapRecord(row, spec)?.properties ?? {})
        streams.push({
          stream: streamId(source, stream),
          fields: profileFields(properties).map(({ example: _example, ...field }) => field)
        })
      }
    }
    await this.options.client.reportFields(streams)
    return streams.length
  }

  /** Map rows to records and apply the doctrine; rows that cannot be mapped become errors. */
  prepare(
    source: AgentSourceConfig,
    stream: AgentStreamConfig,
    rows: Row[],
    policy: FieldPolicy,
    hashKey: string
  ): { records: MappedRecord[]; errors: Array<{ message: string }> } {
    const spec = streamSpecOf(source, stream)
    const records: MappedRecord[] = []
    const errors: Array<{ message: string }> = []
    for (const row of rows) {
      const mapped = mapRecord(normalizeValue(row), spec)
      if (!mapped) {
        errors.push({ message: `A row without ${stream.id}` })
        continue
      }
      const { properties } = applyFieldPolicy(mapped.properties, policy, hashKey)
      records.push({ ...mapped, properties: properties as MappedRecord['properties'], links: [] })
    }
    return { records, errors }
  }

  /** One sync cycle over every enabled stream, checkpointed by RushDB after each acknowledged batch. */
  async cycle(trigger: 'schedule' | 'manual' = 'schedule', full = false): Promise<CycleReport> {
    const description = await this.options.client.describe()
    if (description.connection.paused) {
      return { streams: {}, status: 'paused' }
    }
    const remote = new Map(description.streams.map((stream) => [stream.stream, stream]))
    const { runId, full: runFull } = await this.options.client.startRun({ trigger, full })
    const report: CycleReport = { runId, streams: {}, status: 'completed' }
    const failedStreams: Array<{ stream: string; error: string }> = []
    this.audit({ event: 'run.started', runId, trigger })

    try {
      for (const source of this.config.sources) {
        const driver = this.drivers.get(source.name)!
        for (const stream of source.streams) {
          const id = streamId(source, stream)
          const state = remote.get(id)
          if (!state?.enabled) {
            report.streams[id] = { sent: 0, written: 0, skipped: true }
            continue
          }
          try {
            report.streams[id] = await this.syncStream(runId, source, stream, driver, state, description.hashKey, full || runFull)
          } catch (error) {
            if (error instanceof AgentApiError && (error.status === 402 || error.status === 410 || error.status === 401)) {
              throw error
            }
            const message = (error as Error).message
            failedStreams.push({ stream: id, error: message })
            report.streams[id] = { sent: 0, written: 0, error: message }
            this.log(`${id} failed: ${message}`)
          }
          this.options.signal?.throwIfAborted()
        }
      }
    } catch (error) {
      report.status = 'failed'
      const message = (error as Error).message
      if (!(error instanceof AgentApiError && error.status === 410)) {
        await this.options.client.finish(runId, { status: 'failed', error: message }).catch(() => undefined)
      }
      this.audit({ event: 'run.failed', runId, error: message })
      throw error
    }
    const result = await this.options.client.finish(runId, { status: 'completed', ...(failedStreams.length ? { failedStreams } : {}) })
    report.status = result.status === 'failed' ? 'failed' : 'completed'
    this.audit({ event: 'run.finished', runId, status: result.status, streams: report.streams })
    return report
  }

  private async syncStream(
    runId: string,
    source: AgentSourceConfig,
    stream: AgentStreamConfig,
    driver: SourceDriver,
    remote: RemoteStream,
    hashKey: string,
    full: boolean
  ) {
    const id = streamId(source, stream)
    let position: Position = full ? {} : ((remote.state as Position | null) ?? {})
    // Without a cursor every cycle re-reads the table (upserts are idempotent).
    if (!stream.cursor) {
      position = {}
    }
    let sent = 0
    let written = 0
    for (;;) {
      this.options.signal?.throwIfAborted()
      const rows = await driver.page(stream, position, stream.batchSize)
      if (rows.length === 0) {
        break
      }
      const last = rows[rows.length - 1]
      const next: Position = {
        id: normalizeValue(last[source.type === 'mongodb' && stream.id === 'id' ? '_id' : stream.id]),
        ...(stream.cursor ? { cursor: last[stream.cursor] instanceof Date ? (last[stream.cursor] as Date).toISOString() : last[stream.cursor] } : {})
      }
      const { records, errors } = this.prepare(source, stream, rows, remote.policy, hashKey)
      const done = rows.length < stream.batchSize
      // A stream without a cursor starts over next cycle; with one, it continues from here.
      const state = stream.cursor ? next : done ? null : next
      const result = await this.options.client.batch(runId, { stream: id, records, state: state as Record<string, unknown> | null, errors })
      sent += records.length
      written += result.written
      this.audit({ event: 'batch', runId, stream: id, records: records.length, written: result.written })
      position = next
      if (done) {
        break
      }
    }
    return { sent, written }
  }

  /** Run forever: a cycle every interval set in RushDB, sooner when someone presses Sync now. */
  async runForever(): Promise<void> {
    await this.connect()
    let description = await this.register()
    await this.reportFields().catch((error) => this.log(`Field report failed: ${(error as Error).message}`))
    let lastCycle = 0
    let lastError: string | null = null
    while (!this.options.signal?.aborted) {
      try {
        description = await this.options.client.heartbeat({
          version: AGENT_VERSION,
          hostname: hostname(),
          sources: this.sourcesSummary(),
          error: lastError
        })
        const due = Date.now() - lastCycle >= description.intervalMinutes * 60_000
        if (!description.connection.paused && (due || description.syncRequested)) {
          lastCycle = Date.now()
          const report = await this.cycle(description.syncRequested ? 'manual' : 'schedule')
          this.log(`Run ${report.runId ?? ''} ${report.status}: ${Object.entries(report.streams).map(([id, part]) => `${id} ${part.written}`).join(', ')}`)
          lastError = null
        }
      } catch (error) {
        lastError = (error as Error).message
        this.log(`Cycle failed: ${lastError}`)
        if (error instanceof AgentApiError && error.status === 401) {
          throw error
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.pollSeconds * 1000))
    }
    await this.close()
  }
}
