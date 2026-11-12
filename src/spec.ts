import { z } from 'zod'

/*
 * A connector is data: a JSON-serialisable spec that the runtime executes.
 * Built-in connectors may add code hooks (see `ConnectorDefinition`) for what
 * a spec cannot say; custom and AI-built connectors are specs only, so no user
 * code ever runs inside RushDB.
 *
 * Strings in `baseUrl`, `request.path`, `request.query`, `request.body` and
 * `request.headers` are templates: `{{config.subdomain}}`, `{{cursor}}`,
 * `{{cursor|unix}}`, `{{credentials.instance_url}}`. A value that is exactly
 * one placeholder keeps its type; a placeholder that resolves to nothing drops
 * the query parameter or body field that holds it.
 */

/** A JSONPath subset: `$`, `.key`, `['key']`, `[0]`, `[*]`. */
export const jsonPathSchema = z.string().regex(/^\$/, 'A JSONPath starts with $')
export type JsonPath = z.infer<typeof jsonPathSchema>

const templated = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const requestSpecSchema = z.object({
  method: z.enum(['GET', 'POST']).default('GET'),
  path: z.string(),
  query: z.record(templated).optional(),
  body: z.unknown().optional(),
  headers: z.record(z.string()).optional()
})
export type RequestSpec = z.input<typeof requestSpecSchema>

export const oauth2AuthSchema = z.object({
  type: z.literal('oauth2'),
  /** API host for this auth method when it differs from the spec's `baseUrl` (Atlassian OAuth vs a site token). */
  baseUrl: z.string().optional(),
  authorizeUrl: z.string(),
  tokenUrl: z.string(),
  scopes: z.array(z.string()).default([]),
  scopeSeparator: z.string().default(' '),
  pkce: z.boolean().default(true),
  /** How the client authenticates at the token endpoint. */
  clientAuth: z.enum(['body', 'basic']).default('body'),
  authorizeParams: z.record(z.string()).optional(),
  /** Token response fields kept next to the tokens (Salesforce `instance_url`), readable as `{{credentials.<field>}}`. */
  keepTokenFields: z.array(z.string()).optional(),
  /** Redirect query parameters kept next to the tokens (QuickBooks `realmId`), readable as `{{credentials.<param>}}`. */
  keepCallbackParams: z.array(z.string()).optional(),
  /** Header the access token goes in; default `Authorization: Bearer <token>`. */
  header: z.string().optional(),
  prefix: z.string().optional()
})

export const bearerAuthSchema = z.object({
  type: z.literal('bearer'),
  /** API host for this auth method when it differs from the spec's `baseUrl` (Atlassian OAuth vs a site token). */
  baseUrl: z.string().optional(),
  label: z.string().default('API token'),
  help: z.string().optional(),
  header: z.string().default('Authorization'),
  prefix: z.string().default('Bearer ')
})

export const basicAuthSchema = z.object({
  type: z.literal('basic'),
  /** API host for this auth method when it differs from the spec's `baseUrl` (Atlassian OAuth vs a site token). */
  baseUrl: z.string().optional(),
  usernameLabel: z.string().default('Username'),
  passwordLabel: z.string().default('Password'),
  help: z.string().optional()
})

export const apiKeyAuthSchema = z.object({
  type: z.literal('apiKey'),
  /** API host for this auth method when it differs from the spec's `baseUrl` (Atlassian OAuth vs a site token). */
  baseUrl: z.string().optional(),
  label: z.string().default('API key'),
  help: z.string().optional(),
  in: z.enum(['header', 'query']).default('header'),
  name: z.string(),
  prefix: z.string().default('')
})

export const noAuthSchema = z.object({ type: z.literal('none') })

export const authSpecSchema = z.discriminatedUnion('type', [
  oauth2AuthSchema,
  bearerAuthSchema,
  basicAuthSchema,
  apiKeyAuthSchema,
  noAuthSchema
])
export type AuthSpec = z.infer<typeof authSpecSchema>
export type AuthType = AuthSpec['type']

export const configFieldSchema = z.object({
  label: z.string(),
  type: z.enum(['string', 'url', 'select', 'list']).default('string'),
  required: z.boolean().default(true),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  default: z.string().optional()
})
export type ConfigField = z.infer<typeof configFieldSchema>

export const paginationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  /** The response carries the next page token; it goes back as `param`. */
  z.object({
    type: z.literal('cursor'),
    next: jsonPathSchema,
    param: z.string(),
    in: z.enum(['query', 'body']).default('query'),
    hasMore: jsonPathSchema.optional(),
    /** Stop when this path is true, even if a next page is named (Zendesk `end_of_stream`). */
    done: jsonPathSchema.optional()
  }),
  /** The next page starts after the last record's id (Stripe `starting_after`). */
  z.object({
    type: z.literal('lastId'),
    param: z.string(),
    idPath: jsonPathSchema.default('$.id'),
    hasMore: jsonPathSchema.optional(),
    in: z.enum(['query', 'body']).default('query')
  }),
  z.object({
    type: z.literal('offset'),
    param: z.string(),
    limitParam: z.string().optional(),
    limit: z.number().int().positive().default(100),
    start: z.number().int().default(0),
    in: z.enum(['query', 'body']).default('query'),
    hasMore: jsonPathSchema.optional()
  }),
  z.object({
    type: z.literal('page'),
    param: z.string(),
    sizeParam: z.string().optional(),
    size: z.number().int().positive().default(100),
    start: z.number().int().default(1),
    in: z.enum(['query', 'body']).default('query'),
    hasMore: jsonPathSchema.optional()
  }),
  /** RFC 8288 `Link: <…>; rel="next"`. */
  z.object({ type: z.literal('linkHeader') }),
  /** The response carries the full URL of the next page. */
  z.object({
    type: z.literal('nextUrl'),
    next: jsonPathSchema,
    /** Stop when this path is true, even if a next page is named (Zendesk `end_of_stream`). */
    done: jsonPathSchema.optional()
  })
])
export type PaginationSpec = z.infer<typeof paginationSchema>

export const fieldTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'datetime',
  /** Unix seconds → ISO datetime. */
  'unix',
  /** Unix milliseconds → ISO datetime. */
  'unixMs',
  /** Minor currency units → number in major units (1999 → 19.99). */
  'cents',
  /** Kept as a JSON string. */
  'json'
])
export type FieldType = z.infer<typeof fieldTypeSchema>

export const fieldsSpecSchema = z.object({
  /** Objects merged into the top level (HubSpot `$.properties`, Airtable `$.fields`). */
  flatten: z.array(jsonPathSchema).optional(),
  /** Only these properties (after flatten and rename). */
  pick: z.array(z.string()).optional(),
  omit: z.array(z.string()).optional(),
  rename: z.record(z.string()).optional(),
  types: z.record(fieldTypeSchema).optional(),
  /** Nested objects become `parent_child` properties down to this depth; deeper ones become JSON strings. */
  nestedDepth: z.number().int().min(0).max(4).default(2)
})
export type FieldsSpec = z.input<typeof fieldsSpecSchema>

export const relationSpecSchema = z
  .object({
    /** Relationship type, `WORKS_AT`. */
    type: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE'),
    /** The stream whose records the relation points to. */
    target: z.string(),
    /** Where the target ids are in the raw record (one value or many). Linked by id pairs. */
    path: jsonPathSchema.optional(),
    /**
     * A mapped property holding the target's external id (Stripe `customer`).
     * Registered as an approved relationship pattern, so it is re-applied to
     * later writes from any client.
     */
    field: z.string().optional(),
    direction: z.enum(['out', 'in']).default('out')
  })
  .refine((relation) => Boolean(relation.path) !== Boolean(relation.field), {
    message: 'A relation has exactly one of path or field'
  })
export type RelationSpec = z.infer<typeof relationSpecSchema>

export const incrementalSpecSchema = z.object({
  /** Where the record's last-modified value is. */
  cursorField: jsonPathSchema,
  format: z.enum(['iso', 'unix', 'unixMs', 'date']).default('iso'),
  /** Merged into the stream request once a cursor exists; `{{cursor}}` is the stored watermark. */
  request: requestSpecSchema.partial().optional(),
  /** Pagination once a cursor exists, when the incremental endpoint pages differently (a search API). */
  pagination: paginationSchema.optional(),
  /** Re-read this much before the watermark, for providers whose clocks or indexes lag. */
  lookbackSeconds: z.number().int().min(0).default(60)
})
export type IncrementalSpec = z.input<typeof incrementalSpecSchema>

export const streamSpecSchema = z.object({
  /** Default label in RushDB; people can rename it per connection. */
  label: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  description: z.string().optional(),
  request: requestSpecSchema,
  /** The array of records in the response; `$` when the body is the array. */
  records: jsonPathSchema,
  /** The record's id at the provider, unique within the stream. */
  id: jsonPathSchema,
  pagination: paginationSchema.default({ type: 'none' }),
  incremental: incrementalSpecSchema.optional(),
  fields: fieldsSpecSchema.optional(),
  relations: z.array(relationSpecSchema).optional(),
  /** A record is a tombstone when this path equals `value` (default true). */
  deleted: z.object({ path: jsonPathSchema, value: z.unknown().default(true) }).optional(),
  /** Off by default in the wizard (high volume or sensitive). */
  optional: z.boolean().optional()
})
export type StreamSpec = z.input<typeof streamSpecSchema>
export type ParsedStreamSpec = z.output<typeof streamSpecSchema>

export const webhookSignatureSchema = z.discriminatedUnion('scheme', [
  z.object({ scheme: z.literal('none') }),
  /** `header` = hex/base64 HMAC of the raw body (Zendesk, Jira, Notion; Intercom with `algorithm: 'sha1'`). */
  z.object({
    scheme: z.literal('hmacSha256'),
    header: z.string(),
    encoding: z.enum(['hex', 'base64']).default('hex'),
    prefix: z.string().default(''),
    /** Zendesk signs `timestamp + body`; this header holds the timestamp. */
    timestampHeader: z.string().optional(),
    /** Intercom still signs with HMAC-SHA1 (`X-Hub-Signature: sha1=…`). */
    algorithm: z.enum(['sha256', 'sha1']).default('sha256')
  }),
  z.object({ scheme: z.literal('stripe') }),
  z.object({ scheme: z.literal('paddle') }),
  z.object({ scheme: z.literal('hubspotV3') }),
  /**
   * A shared secret sent in a header: verbatim, as `Bearer <secret>`, or as
   * HTTP basic auth (`Authorization: Basic …`, secret `user:password`, Pipedrive).
   */
  z.object({ scheme: z.literal('sharedSecret'), header: z.string() })
])
export type WebhookSignatureSpec = z.infer<typeof webhookSignatureSchema>

export const webhookRouteSchema = z.object({
  stream: z.string(),
  /** upsert: the payload object is the record; delete: it names a deleted record; refetch: sync the stream now. */
  action: z.enum(['upsert', 'delete', 'refetch']).default('upsert')
})

export const webhooksSpecSchema = z.object({
  signature: webhookSignatureSchema,
  /** Where the events are when one delivery carries many (HubSpot sends an array). Default: the body is one event. */
  events: jsonPathSchema.optional(),
  /** Event type, e.g. `$.type` (`customer.updated`). */
  type: jsonPathSchema,
  /** Appended to the type with a dot when the provider splits it in two (Pipedrive `meta.entity` + `meta.action` → `person.delete`). */
  typeSuffix: jsonPathSchema.optional(),
  /** Event id for deduplication. */
  id: jsonPathSchema,
  /** Appended to the id with a colon when the provider has no event id, only the object's (QuickBooks `id` + `lastUpdated`). */
  idSuffix: jsonPathSchema.optional(),
  /** The changed object inside the event. */
  object: jsonPathSchema.optional(),
  /** The changed object's id when the event carries no object (HubSpot `objectId`). */
  objectId: jsonPathSchema.optional(),
  /**
   * Event type → what to do. `*` matches any run of characters (`customer.*`
   * matches `customer.updated` and `customer.tax_id.created`); an exact type
   * wins over patterns, and the longest matching pattern wins over shorter ones.
   */
  routes: z.record(webhookRouteSchema),
  /** Shown in the connection: how to register the webhook at the provider. */
  setup: z.string().optional()
})
export type WebhooksSpec = z.input<typeof webhooksSpecSchema>

export const starterDefinitionSchema = z.object({
  kind: z.enum(['metric', 'filter']),
  name: z.string(),
  description: z.string(),
  /** The label it filters (filters) — written with the stream's default label. */
  label: z.string().optional(),
  sql: z.string()
})
export type StarterDefinition = z.infer<typeof starterDefinitionSchema>

export const connectorCategorySchema = z.enum([
  'crm',
  'billing',
  'accounting',
  'support',
  'itsm',
  'project-management',
  'knowledge',
  'spreadsheet',
  'database',
  'analytics',
  'engineering',
  'marketing',
  'sales',
  'customer-success',
  'documents',
  'market-intelligence',
  'automation',
  'custom'
])
export type ConnectorCategory = z.infer<typeof connectorCategorySchema>

export const connectorSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string(),
  version: z.number().int().positive().default(1),
  category: connectorCategorySchema,
  description: z.string(),
  docsUrl: z.string().url().optional(),
  /** Accepted auth methods; the first is the default. */
  auth: z.array(authSpecSchema).min(1),
  config: z.record(configFieldSchema).optional(),
  baseUrl: z.string(),
  headers: z.record(z.string()).optional(),
  rateLimit: z
    .object({
      requestsPerSecond: z.number().positive().optional(),
      retryOn: z.array(z.number().int()).default([429, 500, 502, 503, 504]),
      maxRetries: z.number().int().min(0).max(10).default(5),
      /** Seconds from this header, when the provider sends it. */
      retryAfterHeader: z.string().default('Retry-After')
    })
    .default({}),
  /**
   * Where an API reports errors inside a successful (200) response, e.g.
   * GraphQL's `$.errors`. A non-empty value there fails the request.
   */
  errors: jsonPathSchema.optional(),
  /** A cheap authenticated request proving the credentials work. */
  test: z.object({ request: requestSpecSchema, account: jsonPathSchema.optional() }).optional(),
  streams: z.record(streamSpecSchema),
  webhooks: webhooksSpecSchema.optional(),
  starterDefinitions: z.array(starterDefinitionSchema).optional()
})
export type ConnectorSpec = z.input<typeof connectorSpecSchema>
export type ParsedConnectorSpec = z.output<typeof connectorSpecSchema>

/** Validate a custom or AI-built spec; throws a ZodError naming every problem. */
export function parseConnectorSpec(input: unknown): ParsedConnectorSpec {
  const spec = connectorSpecSchema.parse(input)
  for (const [name, stream] of Object.entries(spec.streams)) {
    for (const relation of stream.relations ?? []) {
      if (!spec.streams[relation.target]) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['streams', name, 'relations'],
            message: `Relation ${relation.type} targets unknown stream "${relation.target}"`
          }
        ])
      }
    }
  }
  for (const [event, route] of Object.entries(spec.webhooks?.routes ?? {})) {
    if (!spec.streams[route.stream]) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['webhooks', 'routes', event],
          message: `Webhook route targets unknown stream "${route.stream}"`
        }
      ])
    }
  }
  return spec
}
