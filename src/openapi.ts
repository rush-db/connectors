import { propertyName } from './runtime/mapper'

import type { AuthSpec, ConnectorSpec, PaginationSpec, StreamSpec } from './spec'

/**
 * Draft a connector from an OpenAPI 3 document: one stream per chosen GET
 * operation, records path and id guessed from the 200 response schema, auth
 * from the security schemes, pagination from well-known query parameters.
 * The draft is a starting point a person (or the AI builder) previews and
 * corrects; nothing here calls the API.
 */

type OpenApiDocument = {
  openapi?: string
  info?: { title?: string; description?: string }
  servers?: Array<{ url: string }>
  paths?: Record<string, Record<string, any>>
  components?: { schemas?: Record<string, any>; securitySchemes?: Record<string, any> }
}

export type OpenApiOperation = {
  path: string
  method: string
  operationId?: string
  summary?: string
  /** Guessed: where the records are, the id field, and the pagination. */
  records: string
  id: string
  pagination: PaginationSpec
}

function resolve(doc: OpenApiDocument, schema: any, depth = 0): any {
  if (!schema || depth > 8) {
    return schema
  }
  if (schema.$ref && typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').pop()
    return resolve(doc, doc.components?.schemas?.[name], depth + 1)
  }
  if (schema.allOf) {
    return schema.allOf.reduce(
      (merged: any, part: any) => {
        const resolved = resolve(doc, part, depth + 1) ?? {}
        return { ...merged, ...resolved, properties: { ...merged.properties, ...resolved.properties } }
      },
      { properties: {} }
    )
  }
  return schema
}

function responseSchema(doc: OpenApiDocument, operation: any): any {
  const ok = operation?.responses?.['200'] ?? operation?.responses?.['2XX'] ?? operation?.responses?.default
  const content = resolve(doc, ok)?.content
  const json = content?.['application/json'] ?? Object.values(content ?? {})[0]
  return resolve(doc, (json as any)?.schema)
}

function guessRecords(doc: OpenApiDocument, schema: any): { records: string; item: any } {
  if (schema?.type === 'array') {
    return { records: '$', item: resolve(doc, schema.items) }
  }
  const properties = schema?.properties ?? {}
  for (const key of ['data', 'results', 'items', 'records', 'values', 'entries', 'objects']) {
    const property = resolve(doc, properties[key])
    if (property?.type === 'array') {
      return { records: `$.${key}`, item: resolve(doc, property.items) }
    }
  }
  for (const [key, value] of Object.entries(properties)) {
    const property = resolve(doc, value)
    if (property?.type === 'array') {
      return { records: `$.${key}`, item: resolve(doc, property.items) }
    }
  }
  return { records: '$', item: schema }
}

function guessId(item: any): string {
  const properties = Object.keys(item?.properties ?? {})
  const id = ['id', 'uuid', 'key', 'gid', 'sys_id'].find((key) => properties.includes(key))
  return `$.${id ?? 'id'}`
}

function guessPagination(operation: any, schema: any): PaginationSpec {
  const params: string[] = (operation?.parameters ?? []).map((param: any) => param?.name).filter(Boolean)
  const responseKeys = Object.keys(schema?.properties ?? {})
  const has = (name: string) => params.includes(name)
  if (has('starting_after')) {
    return { type: 'lastId', param: 'starting_after', idPath: '$.id', hasMore: '$.has_more', in: 'query' }
  }
  for (const param of ['cursor', 'after', 'page_token', 'pageToken', 'next_page_token', 'start_cursor', 'offset_token']) {
    if (has(param)) {
      const next =
        responseKeys.find((key) => /next.?(cursor|page|token)|cursor|next/i.test(key)) ?? 'next_cursor'
      return { type: 'cursor', param, next: `$.${next}`, in: 'query' }
    }
  }
  if (has('offset')) {
    const limitParam = ['limit', 'per_page', 'page_size', 'pageSize'].find(has)
    return { type: 'offset', param: 'offset', limitParam, limit: 100, start: 0, in: 'query' }
  }
  if (has('page')) {
    const sizeParam = ['per_page', 'page_size', 'pageSize', 'limit', 'size'].find(has)
    return { type: 'page', param: 'page', sizeParam, size: 100, start: 1, in: 'query' }
  }
  return { type: 'none' }
}

function authFrom(doc: OpenApiDocument): AuthSpec[] {
  const auth: AuthSpec[] = []
  for (const scheme of Object.values(doc.components?.securitySchemes ?? {})) {
    if (scheme?.type === 'http' && scheme.scheme === 'bearer') {
      auth.push({ type: 'bearer', label: 'API token', header: 'Authorization', prefix: 'Bearer ' })
    } else if (scheme?.type === 'http' && scheme.scheme === 'basic') {
      auth.push({ type: 'basic', usernameLabel: 'Username', passwordLabel: 'Password' })
    } else if (scheme?.type === 'apiKey' && (scheme.in === 'header' || scheme.in === 'query')) {
      auth.push({ type: 'apiKey', label: 'API key', in: scheme.in, name: scheme.name, prefix: '' })
    } else if (scheme?.type === 'oauth2' && scheme.flows?.authorizationCode) {
      const flow = scheme.flows.authorizationCode
      auth.push({
        type: 'oauth2',
        authorizeUrl: flow.authorizationUrl,
        tokenUrl: flow.tokenUrl,
        scopes: Object.keys(flow.scopes ?? {}),
        scopeSeparator: ' ',
        pkce: true,
        clientAuth: 'body'
      })
    }
  }
  return auth.length ? auth : [{ type: 'bearer', label: 'API token', header: 'Authorization', prefix: 'Bearer ' }]
}

/** Every GET operation of the document, with guesses, for a person to pick from. */
export function listOpenApiOperations(doc: OpenApiDocument): OpenApiOperation[] {
  const out: OpenApiOperation[] = []
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const operation = item?.get
    if (!operation) {
      continue
    }
    const schema = responseSchema(doc, operation)
    const { records, item: recordSchema } = guessRecords(doc, schema)
    out.push({
      path,
      method: 'GET',
      operationId: operation.operationId,
      summary: operation.summary,
      records,
      id: guessId(recordSchema),
      pagination: guessPagination(operation, schema)
    })
  }
  return out
}

function labelFor(path: string): string {
  const segment =
    path
      .split('/')
      .filter((part) => part && !part.startsWith('{'))
      .pop() ?? 'record'
  const singular = segment.replace(/ies$/, 'y').replace(/(?<!s)s$/, '')
  return propertyName(singular).toUpperCase() || 'RECORD'
}

/** A connector draft from chosen operations (paths with `{param}` are skipped: they need a parent id). */
export function connectorFromOpenApi(
  doc: OpenApiDocument,
  params: { id: string; name?: string; baseUrl?: string; paths?: string[] }
): ConnectorSpec {
  const operations = listOpenApiOperations(doc).filter(
    (operation) => !operation.path.includes('{') && (!params.paths || params.paths.includes(operation.path))
  )
  const streams: Record<string, StreamSpec> = {}
  for (const operation of operations) {
    const label = labelFor(operation.path)
    const name = label.toLowerCase()
    streams[streams[name] ? `${name}_${Object.keys(streams).length}` : name] = {
      label,
      description: operation.summary,
      request: { method: 'GET', path: operation.path },
      records: operation.records,
      id: operation.id,
      pagination: operation.pagination
    }
  }
  return {
    id: params.id,
    name: params.name ?? doc.info?.title ?? params.id,
    category: 'custom',
    description: doc.info?.description?.slice(0, 500) ?? `Imported from ${doc.info?.title ?? 'an OpenAPI document'}`,
    auth: authFrom(doc),
    baseUrl: params.baseUrl ?? doc.servers?.[0]?.url ?? '',
    streams
  }
}
