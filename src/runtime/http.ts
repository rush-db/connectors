import { queryOne } from './jsonpath'
import { assertEgressAllowed, type EgressPolicy } from './egress'
import { needsRefresh, refreshCredentials } from './oauth'
import { renderRequired } from './template'

import type { ParsedConnectorSpec } from '../spec'
import type { ConnectionContext, ConnectorHttp, Credentials, HttpRequest, HttpResponse } from '../types'

export class ConnectorHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message)
    this.name = 'ConnectorHttpError'
  }

  /** Credentials were refused: the connection needs a person to authorize again. */
  get isAuthError() {
    return this.status === 401 || this.status === 403
  }
}

export type HttpOptions = {
  fetch?: typeof fetch
  egress: EgressPolicy
  userAgent?: string
  /** Largest response body accepted, in bytes. */
  maxResponseBytes?: number
  /** Time per request. */
  timeoutMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type AuthApplied = { headers: Record<string, string>; query: Record<string, string> }

function applyAuth(spec: ParsedConnectorSpec, credentials: Credentials): AuthApplied {
  const applied: AuthApplied = { headers: {}, query: {} }
  switch (credentials.type) {
    case 'oauth2': {
      const oauth = spec.auth.find((auth) => auth.type === 'oauth2') as
        | Extract<ParsedConnectorSpec['auth'][number], { type: 'oauth2' }>
        | undefined
      applied.headers[oauth?.header ?? 'Authorization'] = `${oauth?.prefix ?? 'Bearer '}${credentials.accessToken}`
      break
    }
    case 'bearer': {
      const bearer = spec.auth.find((auth) => auth.type === 'bearer') as
        | Extract<ParsedConnectorSpec['auth'][number], { type: 'bearer' }>
        | undefined
      applied.headers[bearer?.header ?? 'Authorization'] = `${bearer?.prefix ?? 'Bearer '}${credentials.token}`
      break
    }
    case 'basic':
      applied.headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
      break
    case 'apiKey': {
      const apiKey = spec.auth.find((auth) => auth.type === 'apiKey') as
        | Extract<ParsedConnectorSpec['auth'][number], { type: 'apiKey' }>
        | undefined
      if (!apiKey) {
        throw new Error(`${spec.id} does not accept an API key`)
      }
      const value = `${apiKey.prefix}${credentials.apiKey}`
      if (apiKey.in === 'query') {
        applied.query[apiKey.name] = value
      } else {
        applied.headers[apiKey.name] = value
      }
      break
    }
    case 'none':
      break
  }
  return applied
}

function retryAfterMs(headers: Headers, header: string): number | undefined {
  const value = headers.get(header) ?? headers.get('retry-after')
  if (!value) {
    return undefined
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.min(seconds * 1000, 120_000)
  }
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), 120_000)
}

/**
 * The connection's HTTP client: auth on every request, token refresh before
 * expiry and once on a 401, a requests-per-second budget, retries with
 * backoff on the spec's retryable statuses, the egress check and a response
 * size cap.
 */
export class SpecHttpClient implements ConnectorHttp {
  readonly baseUrl: string
  private nextSlotAt = 0
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly spec: ParsedConnectorSpec,
    private readonly connection: ConnectionContext,
    private readonly options: HttpOptions
  ) {
    this.fetchImpl = options.fetch ?? fetch
    this.sleep = options.sleep ?? defaultSleep
    const auth = spec.auth.find((candidate) => candidate.type === connection.credentials.type)
    const base = (auth && 'baseUrl' in auth && auth.baseUrl) || spec.baseUrl
    this.baseUrl = renderRequired(base, this.scope(), 'baseUrl').replace(/\/$/, '')
  }

  scope(): Record<string, unknown> {
    const credentials = this.connection.credentials
    return {
      config: this.connection.config,
      credentials: credentials.type === 'oauth2' ? (credentials.extra ?? {}) : {}
    }
  }

  private async throttle() {
    const perSecond = this.spec.rateLimit.requestsPerSecond
    if (!perSecond) {
      return
    }
    const now = Date.now()
    const slot = Math.max(now, this.nextSlotAt)
    this.nextSlotAt = slot + 1000 / perSecond
    if (slot > now) {
      await this.sleep(slot - now)
    }
  }

  private async refresh(): Promise<boolean> {
    const { credentials, oauthClient } = this.connection
    if (credentials.type !== 'oauth2' || !credentials.refreshToken || !oauthClient) {
      return false
    }
    const refreshed = await refreshCredentials(
      this.spec,
      credentials,
      oauthClient,
      this.connection.config,
      this.fetchImpl
    )
    this.connection.credentials = refreshed
    await this.connection.onCredentials?.(refreshed)
    return true
  }

  async request<T = any>(request: HttpRequest): Promise<HttpResponse<T>> {
    if (needsRefresh(this.connection.credentials)) {
      await this.refresh()
    }
    const url = new URL(/^https?:\/\//.test(request.url) ? request.url : `${this.baseUrl}${request.url}`)
    await assertEgressAllowed(url.toString(), this.options.egress)

    const { maxRetries, retryOn, retryAfterHeader } = this.spec.rateLimit
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      await this.throttle()
      const auth = applyAuth(this.spec, this.connection.credentials)
      const target = new URL(url)
      for (const [key, value] of Object.entries({ ...(request.query ?? {}), ...auth.query })) {
        if (value !== undefined) {
          target.searchParams.set(key, String(value))
        }
      }
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': this.options.userAgent ?? 'RushDB-Connectors/0.1',
        ...(this.spec.headers ?? {}),
        ...(request.headers ?? {}),
        ...auth.headers
      }
      let body: string | undefined
      if (request.body !== undefined) {
        headers['Content-Type'] ??= 'application/json'
        body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000)
      const onAbort = () => controller.abort()
      this.options.signal?.addEventListener('abort', onAbort)
      let response: Response
      try {
        response = await this.fetchImpl(target.toString(), {
          method: request.method ?? 'GET',
          headers,
          body,
          signal: controller.signal,
          redirect: this.options.egress === 'any' ? 'follow' : 'error'
        })
      } catch (error) {
        clearTimeout(timeout)
        this.options.signal?.removeEventListener('abort', onAbort)
        if (this.options.signal?.aborted) {
          throw error
        }
        if (attempt < maxRetries) {
          await this.sleep(Math.min(30_000, 500 * 2 ** attempt))
          continue
        }
        throw new ConnectorHttpError(`Request to ${target.origin} failed: ${(error as Error).message}`, 0)
      } finally {
        clearTimeout(timeout)
        this.options.signal?.removeEventListener('abort', onAbort)
      }

      if (response.status === 401 && !refreshed && (await this.refresh().catch(() => false))) {
        refreshed = true
        continue
      }
      if (retryOn.includes(response.status) && attempt < maxRetries) {
        await response.body?.cancel().catch(() => undefined)
        const wait = retryAfterMs(response.headers, retryAfterHeader) ?? Math.min(30_000, 500 * 2 ** attempt)
        await this.sleep(wait + Math.floor(Math.random() * 250))
        continue
      }

      const text = await this.readBody(response)
      let data: any = text
      if (text && (response.headers.get('content-type') ?? '').includes('json')) {
        data = JSON.parse(text)
      } else if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
      }
      if (!response.ok) {
        const detail = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)
        throw new ConnectorHttpError(
          `${request.method ?? 'GET'} ${target.pathname} returned ${response.status}: ${detail}`,
          response.status,
          data
        )
      }
      if (this.spec.errors && data && typeof data === 'object') {
        const reported = queryOne(data, this.spec.errors)
        if (reported !== undefined && reported !== null && (!Array.isArray(reported) || reported.length > 0)) {
          const detail = JSON.stringify(reported).slice(0, 300)
          throw new ConnectorHttpError(`${request.method ?? 'GET'} ${target.pathname} reported errors: ${detail}`, response.status, data)
        }
      }
      return { status: response.status, headers: response.headers, data }
    }
  }

  private async readBody(response: Response): Promise<string> {
    const max = this.options.maxResponseBytes ?? 50 * 1024 * 1024
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > max) {
      throw new ConnectorHttpError(`Response larger than ${max} bytes`, response.status)
    }
    if (!response.body) {
      return response.text()
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > max) {
        await reader.cancel()
        throw new ConnectorHttpError(`Response larger than ${max} bytes`, response.status)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
}
