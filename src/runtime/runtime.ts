import { type EgressPolicy } from './egress'
import { SpecHttpClient } from './http'
import { queryOne, queryRecords } from './jsonpath'
import { cursorAfter, mapRecord } from './mapper'
import { MISSING, render, renderRequired, toDate } from './template'

import {
  parseConnectorSpec,
  streamSpecSchema,
  type ParsedConnectorSpec,
  type ParsedStreamSpec,
  type PaginationSpec,
  type RequestSpec
} from '../spec'
import type {
  ConnectionContext,
  ConnectorDefinition,
  HookContext,
  MappedRecord,
  ReadBatch,
  ReadOptions,
  StreamState
} from '../types'

export type RuntimeOptions = {
  fetch?: typeof fetch
  /**
   * Egress policy per connector. Default: public HTTPS hosts only, for every
   * connector. Built-in connectors put config values (Zendesk subdomain,
   * ServiceNow instance) into their hosts, so a typed value could otherwise
   * point a request at a private address. Tests and trusted setups pass `'any'`.
   */
  egress?: (definition: ConnectorDefinition) => EgressPolicy
  userAgent?: string
  timeoutMs?: number
  maxResponseBytes?: number
  sleep?: (ms: number) => Promise<void>
  /** Stop a read that keeps returning the same page. */
  maxPages?: number
}

type PageState = { offset?: number; page?: number; token?: unknown; url?: string }

const parsedSpecs = new WeakMap<object, ParsedConnectorSpec>()

function mergeRequest(base: RequestSpec, override?: Partial<RequestSpec>): RequestSpec {
  if (!override) {
    return base
  }
  const body =
    (
      base.body &&
      override.body &&
      typeof base.body === 'object' &&
      typeof override.body === 'object' &&
      !Array.isArray(base.body)
    ) ?
      { ...(base.body as object), ...(override.body as object) }
    : (override.body ?? base.body)
  return {
    ...base,
    ...override,
    query: { ...(base.query ?? {}), ...(override.query ?? {}) },
    headers: { ...(base.headers ?? {}), ...(override.headers ?? {}) },
    body
  }
}

function lookedBack(cursor: string | number, format: string, lookbackSeconds: number): string | number {
  if (!lookbackSeconds) {
    return cursor
  }
  const date = toDate(cursor)
  if (!date) {
    return cursor
  }
  const shifted = new Date(date.getTime() - lookbackSeconds * 1000)
  switch (format) {
    case 'unix':
      return Math.floor(shifted.getTime() / 1000)
    case 'unixMs':
      return shifted.getTime()
    case 'date':
      return shifted.toISOString().slice(0, 10)
    default:
      return shifted.toISOString()
  }
}

function parseLinkHeader(header: string | null): string | undefined {
  if (!header) {
    return undefined
  }
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part)
    if (match) {
      return match[1]
    }
  }
  return undefined
}

function setParam(
  target: { query: Record<string, any>; body: any },
  where: 'query' | 'body',
  name: string,
  value: unknown
) {
  if (where === 'body') {
    // A dotted name sets a nested field: Intercom search wants `pagination.starting_after`.
    const body: Record<string, any> = { ...(target.body && typeof target.body === 'object' ? target.body : {}) }
    const keys = name.split('.')
    let node = body
    for (const key of keys.slice(0, -1)) {
      node[key] = { ...(node[key] && typeof node[key] === 'object' ? node[key] : {}) }
      node = node[key]
    }
    node[keys[keys.length - 1]] = value
    target.body = body
  } else {
    target.query[name] = value
  }
}

/**
 * Executes connector specs: test a connection, list its streams, read a
 * stream page by page as mapped records with resumable state.
 */
export class ConnectorRuntime {
  constructor(private readonly options: RuntimeOptions = {}) {}

  spec(definition: ConnectorDefinition): ParsedConnectorSpec {
    let parsed = parsedSpecs.get(definition)
    if (!parsed) {
      parsed = parseConnectorSpec(definition.spec)
      parsedSpecs.set(definition, parsed)
    }
    return parsed
  }

  private egress(definition: ConnectorDefinition): EgressPolicy {
    return this.options.egress?.(definition) ?? 'public-only'
  }

  http(definition: ConnectorDefinition, connection: ConnectionContext, signal?: AbortSignal): SpecHttpClient {
    return new SpecHttpClient(this.spec(definition), connection, {
      fetch: this.options.fetch,
      egress: this.egress(definition),
      userAgent: this.options.userAgent,
      timeoutMs: this.options.timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes,
      sleep: this.options.sleep,
      signal
    })
  }

  private context(definition: ConnectorDefinition, connection: ConnectionContext, signal?: AbortSignal): HookContext {
    return { spec: this.spec(definition), connection, http: this.http(definition, connection, signal) }
  }

  /** One authenticated request; throws when the credentials or config do not work. */
  async test(definition: ConnectorDefinition, connection: ConnectionContext): Promise<{ account?: string }> {
    const ctx = this.context(definition, connection)
    if (definition.hooks?.test) {
      return definition.hooks.test(ctx)
    }
    const test = ctx.spec.test
    if (test) {
      const response = await ctx.http.request(this.buildRequest(test.request, ctx.http.scope()))
      const account = test.account ? queryOne(response.data, test.account) : undefined
      return account === undefined || account === null ? {} : { account: String(account) }
    }
    // No test request: read one page of the first stream.
    const [first] = Object.keys(await this.streams(definition, connection))
    if (first) {
      for await (const _batch of this.read(definition, connection, first, {}, { maxRecords: 1 })) {
        break
      }
    }
    return {}
  }

  /** The spec's streams plus the ones discovered in this account. */
  async streams(
    definition: ConnectorDefinition,
    connection: ConnectionContext
  ): Promise<Record<string, ParsedStreamSpec>> {
    const spec = this.spec(definition)
    if (!definition.hooks?.discover) {
      return spec.streams
    }
    const discovered = await definition.hooks.discover(this.context(definition, connection))
    const parsed = Object.fromEntries(
      Object.entries(discovered).map(([name, stream]) => [name, streamSpecSchema.parse(stream)])
    )
    return { ...spec.streams, ...parsed }
  }

  private buildRequest(request: RequestSpec, scope: Record<string, unknown>) {
    const query = (render(request.query ?? {}, scope) ?? {}) as Record<string, any>
    const body = request.body === undefined ? undefined : render(request.body, scope)
    const headers = render(request.headers ?? {}, scope) as Record<string, string>
    return {
      method: request.method ?? 'GET',
      url: renderRequired(request.path, scope, 'request.path'),
      query,
      headers,
      body: body === MISSING ? undefined : body
    }
  }

  /**
   * Read one stream. Each batch is one provider page, mapped, with the state
   * to store once it is written. The cursor advances only in the last batch,
   * because providers do not page in modification order; earlier batches
   * carry the page position so an interrupted run resumes where it stopped.
   */
  async *read(
    definition: ConnectorDefinition,
    connection: ConnectionContext,
    streamName: string,
    state: StreamState = {},
    options: ReadOptions = {}
  ): AsyncIterable<ReadBatch> {
    const streams = await this.streams(definition, connection)
    const stream = streams[streamName]
    if (!stream) {
      throw new Error(`Unknown stream "${streamName}" for ${definition.spec.id}`)
    }
    const ctx = this.context(definition, connection, options.signal)
    const startCursor = options.full ? undefined : state.cursor
    let maxCursor: string | number | undefined =
      (state.extra?.maxCursor as string | number | undefined) ?? startCursor
    let seen = 0

    const mapAll = (raw: unknown[]): MappedRecord[] => {
      const out: MappedRecord[] = []
      for (const item of raw) {
        const transformed = definition.hooks?.transform ? definition.hooks.transform(streamName, item, ctx) : item
        if (transformed === null || transformed === undefined) {
          continue
        }
        const mapped = mapRecord(transformed, stream)
        if (!mapped) {
          continue
        }
        if (mapped.cursor !== undefined && (maxCursor === undefined || cursorAfter(mapped.cursor, maxCursor))) {
          maxCursor = mapped.cursor
        }
        out.push(mapped)
      }
      return out
    }

    const custom = definition.hooks?.read?.(
      { name: streamName, spec: stream },
      { ...state, cursor: startCursor },
      { ...ctx, options }
    )
    if (custom) {
      for await (const page of custom) {
        options.signal?.throwIfAborted()
        let records = mapAll(page.records)
        if (options.maxRecords !== undefined) {
          records = records.slice(0, Math.max(0, options.maxRecords - seen))
        }
        seen += records.length
        // A hook that pages newest-first keeps the old cursor until its last batch by setting `cursor` itself (even to undefined).
        yield { records, state: { ...page.state, cursor: 'cursor' in page.state ? page.state.cursor : maxCursor } }
        if (options.maxRecords !== undefined && seen >= options.maxRecords) {
          return
        }
      }
      return
    }

    const incremental = stream.incremental
    const request =
      incremental && startCursor !== undefined ? mergeRequest(stream.request, incremental.request) : stream.request
    const scope = {
      ...ctx.http.scope(),
      cursor:
        startCursor === undefined || !incremental ?
          undefined
        : lookedBack(startCursor, incremental.format, incremental.lookbackSeconds)
    }

    const pagination: PaginationSpec =
      (incremental && startCursor !== undefined ? incremental.pagination : undefined) ?? stream.pagination
    const origin = new URL(ctx.http.baseUrl).origin
    // A next-page URL from a response must stay on the API's origin: the request carries the credentials.
    const sameOrigin = (link: string) => {
      try {
        return new URL(link, `${origin}/`).origin === origin
      } catch {
        return false
      }
    }
    let page: PageState = (state.page as PageState | undefined) ?? {}
    const maxPages = this.options.maxPages ?? 100_000
    let lastToken: unknown

    for (let pageCount = 0; pageCount < maxPages; pageCount++) {
      options.signal?.throwIfAborted()
      const built = this.buildRequest(request, scope)
      const target: { query: Record<string, any>; body: any } = { query: built.query, body: built.body }
      let url = built.url
      switch (pagination.type) {
        case 'cursor':
        case 'lastId':
          if (page.token !== undefined) {
            setParam(target, pagination.in, pagination.param, page.token)
          }
          break
        case 'offset':
          setParam(target, pagination.in, pagination.param, page.offset ?? pagination.start)
          if (pagination.limitParam) {
            setParam(target, pagination.in, pagination.limitParam, pagination.limit)
          }
          break
        case 'page':
          setParam(target, pagination.in, pagination.param, page.page ?? pagination.start)
          if (pagination.sizeParam) {
            setParam(target, pagination.in, pagination.sizeParam, pagination.size)
          }
          break
        case 'linkHeader':
        case 'nextUrl':
          if (page.url) {
            url = page.url
            target.query = {}
          }
          break
      }

      const response = await ctx.http.request({ ...built, url, query: target.query, body: target.body })
      const raw = queryRecords(response.data, stream.records)
      let records = mapAll(raw)
      if (options.maxRecords !== undefined) {
        records = records.slice(0, Math.max(0, options.maxRecords - seen))
      }
      seen += records.length

      const hasMoreFlag =
        'hasMore' in pagination && pagination.hasMore ? queryOne(response.data, pagination.hasMore) : undefined
      const doneFlag = 'done' in pagination && pagination.done ? queryOne(response.data, pagination.done) === true : false
      let next: PageState | undefined
      switch (pagination.type) {
        case 'none':
          break
        case 'cursor': {
          const token = queryOne(response.data, pagination.next)
          if (
            !doneFlag &&
            token !== undefined &&
            token !== null &&
            token !== '' &&
            hasMoreFlag !== false &&
            token !== lastToken
          ) {
            next = { token }
            lastToken = token
          }
          break
        }
        case 'lastId': {
          const lastRaw = raw[raw.length - 1]
          const token = lastRaw === undefined ? undefined : queryOne(lastRaw, pagination.idPath)
          if (token !== undefined && hasMoreFlag !== false && (hasMoreFlag === true || !pagination.hasMore)) {
            next = { token }
          }
          break
        }
        case 'offset': {
          const offset = (page.offset ?? pagination.start) + raw.length
          if (raw.length > 0 && hasMoreFlag !== false && (hasMoreFlag === true || raw.length >= pagination.limit)) {
            next = { offset }
          }
          break
        }
        case 'page': {
          if (raw.length > 0 && hasMoreFlag !== false && (hasMoreFlag === true || raw.length >= pagination.size)) {
            next = { page: (page.page ?? pagination.start) + 1 }
          }
          break
        }
        case 'linkHeader': {
          const link = parseLinkHeader(response.headers.get('link'))
          if (link && link !== page.url && this.checkOrigin(link, sameOrigin, streamName)) {
            next = { url: link }
          }
          break
        }
        case 'nextUrl': {
          const link = queryOne<string>(response.data, pagination.next)
          if (
            !doneFlag &&
            typeof link === 'string' &&
            link &&
            link !== page.url &&
            this.checkOrigin(link, sameOrigin, streamName)
          ) {
            next = { url: link }
          }
          break
        }
      }

      const done = !next || (options.maxRecords !== undefined && seen >= options.maxRecords)
      yield {
        records,
        state:
          done ?
            { cursor: maxCursor }
          : { cursor: startCursor, page: next, extra: maxCursor === undefined ? undefined : { maxCursor } }
      }
      if (done) {
        return
      }
      page = next!
    }
    throw new Error(`Stream ${streamName} did not finish after ${maxPages} pages`)
  }

  private checkOrigin(link: string, sameOrigin: (link: string) => boolean, streamName: string): true {
    if (!sameOrigin(link)) {
      throw new Error(`Stream ${streamName} named a next page on another origin; refusing to send credentials there`)
    }
    return true
  }
}
