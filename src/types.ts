import type { ConnectorSpec, ParsedConnectorSpec, ParsedStreamSpec, StreamSpec } from './spec'

/** What a connection stores after the person authorises it. Never logged, never sent to an LLM. */
export type Credentials =
  | {
      type: 'oauth2'
      accessToken: string
      refreshToken?: string
      /** ISO time the access token expires. */
      expiresAt?: string
      /** Token-response fields the spec keeps (`instance_url`). */
      extra?: Record<string, string>
    }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; apiKey: string }
  | { type: 'none' }

/** The app a connection authorises through (RushDB's per provider, or the workspace's own). */
export type OAuthClient = { clientId: string; clientSecret: string }

export type ConnectionContext = {
  config: Record<string, unknown>
  credentials: Credentials
  /** Needed to refresh OAuth tokens. */
  oauthClient?: OAuthClient
  /** Called when the runtime refreshed the tokens; persist them. */
  onCredentials?: (credentials: Credentials) => void | Promise<void>
}

/** Per-stream sync state, stored by the caller and handed back on the next run. */
export type StreamState = {
  /** Highest `cursorField` value seen (raw provider format). */
  cursor?: string | number
  /** Pagination position inside an interrupted run. */
  page?: unknown
  /** Hook-owned state (Salesforce bulk job ids, Sheets row offsets). */
  extra?: Record<string, unknown>
}

export type ScalarValue = string | number | boolean | null
export type PropertyValue = ScalarValue | ScalarValue[]

/** A provider record shaped for the graph. */
export type MappedRecord = {
  externalId: string
  properties: Record<string, PropertyValue>
  /** Relations by id pairs: this record → records of `target` with these external ids. */
  links: Array<{ type: string; target: string; direction: 'out' | 'in'; externalIds: string[] }>
  deleted?: boolean
  /** The record's cursor value, raw. */
  cursor?: string | number
}

export type ReadBatch = {
  records: MappedRecord[]
  /** State to persist once these records are written: resuming from it never skips a record. */
  state: StreamState
}

export type ReadOptions = {
  /** Ignore the stored cursor and read everything. */
  full?: boolean
  /** Stop after this many records (previews). */
  maxRecords?: number
  signal?: AbortSignal
}

export type WebhookEvent = {
  id: string
  type: string
  stream: string
  action: 'upsert' | 'delete' | 'refetch'
  externalId?: string
  record?: MappedRecord
}

export type HttpRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  query?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
  body?: unknown
}

export type HttpResponse<T = any> = { status: number; headers: Headers; data: T }

/** The authenticated, rate-limited, retrying HTTP client hooks receive. */
export interface ConnectorHttp {
  request<T = any>(request: HttpRequest): Promise<HttpResponse<T>>
  /** `baseUrl` with templates resolved. */
  readonly baseUrl: string
  /** Template values of the connection: `config` and kept OAuth token fields as `credentials`. */
  scope(): Record<string, unknown>
}

export type HookContext = {
  spec: ParsedConnectorSpec
  connection: ConnectionContext
  http: ConnectorHttp
}

/**
 * Code a built-in connector may add to its spec. Every hook is optional; a
 * connector without hooks is the spec alone.
 */
export type ConnectorHooks = {
  /** Streams that depend on the account (Salesforce objects, Airtable tables, sheet tabs). Merged over `spec.streams`. */
  discover?(ctx: HookContext): Promise<Record<string, StreamSpec>>
  /** Replace the generic reader for one stream. Yield raw records (mapped by the runtime) and state checkpoints. */
  read?(
    stream: { name: string; spec: ParsedStreamSpec },
    state: StreamState,
    ctx: HookContext & { options: ReadOptions }
  ): AsyncIterable<{ records: unknown[]; state: StreamState }> | undefined
  /** Adjust a raw record before mapping; return null to skip it. */
  transform?(stream: string, record: any, ctx: HookContext): any | null
  /** Replace the spec's test request. Returns an account label when it can. */
  test?(ctx: HookContext): Promise<{ account?: string }>
}

export type ConnectorDefinition = {
  spec: ConnectorSpec
  hooks?: ConnectorHooks
  /** Listed in the catalog with a "beta" badge. */
  beta?: boolean
}

export type ConnectorCatalogEntry = {
  id: string
  name: string
  category: string
  description: string
  docsUrl?: string
  auth: string[]
  streams: Array<{ name: string; label: string; description?: string; optional?: boolean }>
  config: ConnectorSpec['config']
  webhooks: boolean
  incremental: boolean
  beta: boolean
  /** The brand logo as a `data:image/svg+xml` URI, for an `<img src>`. */
  logo?: string
}

export function defineConnector(definition: ConnectorDefinition): ConnectorDefinition {
  return definition
}
