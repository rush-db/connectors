import type { FieldPolicy, FieldProfile } from '../pii'
import type { MappedRecord } from '../types'

export const AGENT_TOKEN_HEADER = 'x-rushdb-agent-token'

export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: any
  ) {
    super(message)
    this.name = 'AgentApiError'
  }
}

export type RemoteStream = {
  stream: string
  label: string
  enabled: boolean
  deleteMode: string
  policy: FieldPolicy
  state: Record<string, unknown> | null
}

export type AgentDescription = {
  connection: { id: string; name: string; paused: boolean }
  intervalMinutes: number
  syncRequested: boolean
  hashKey: string
  streams: RemoteStream[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The agent's only outbound peer: the RushDB API it is configured with. */
export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; maxRetries?: number } = {}
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const fetchImpl = this.options.fetch ?? fetch
    const wait = this.options.sleep ?? sleep
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/v1/agent${path}`
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetchImpl(url, {
          method,
          headers: { 'Content-Type': 'application/json', [AGENT_TOKEN_HEADER]: this.token, 'User-Agent': 'rushdb-agent' },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error'
        })
      } catch (error) {
        if (attempt < (this.options.maxRetries ?? 6)) {
          await wait(Math.min(60_000, 1000 * 2 ** attempt))
          continue
        }
        throw new AgentApiError(`RushDB is unreachable: ${(error as Error).message}`, 0)
      }
      const text = await response.text()
      let data: any = undefined
      try {
        data = text ? JSON.parse(text) : undefined
      } catch {
        data = text
      }
      if (response.ok) {
        return (data?.data ?? data) as T
      }
      if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt < (this.options.maxRetries ?? 6)) {
        const retryAfter = Number(response.headers.get('retry-after'))
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** attempt))
        continue
      }
      const message = data?.message ?? data?.error ?? (typeof data === 'string' ? data : `HTTP ${response.status}`)
      throw new AgentApiError(`${method} ${path}: ${Array.isArray(message) ? message.join('; ') : message}`, response.status, data)
    }
  }

  describe() {
    return this.call<AgentDescription>('GET', '')
  }

  heartbeat(body: { version: string; hostname?: string; sources?: Array<{ type: string; streams: number }>; error?: string | null }) {
    return this.call<AgentDescription>('POST', '/heartbeat', body)
  }

  registerStreams(streams: Array<{ stream: string; label: string; relations?: unknown[] }>) {
    return this.call<AgentDescription>('POST', '/streams', { streams })
  }

  reportFields(streams: Array<{ stream: string; fields: FieldProfile[] }>) {
    return this.call<{ received: number }>('POST', '/fields', { streams })
  }

  startRun(body: { trigger: 'schedule' | 'manual'; full?: boolean }) {
    return this.call<{ runId: string; full: boolean }>('POST', '/runs', body)
  }

  batch(runId: string, body: { stream: string; records: MappedRecord[]; state: Record<string, unknown> | null; errors?: Array<{ externalId?: string; message: string }> }) {
    return this.call<{ written: number; deleted: number; links: number; skipped?: boolean }>('POST', `/runs/${runId}/batches`, body)
  }

  finish(runId: string, body: { status: 'completed' | 'failed'; error?: string; failedStreams?: Array<{ stream: string; error: string }> }) {
    return this.call<{ status: string }>('POST', `/runs/${runId}/finish`, body)
  }
}
