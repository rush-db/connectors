import { queryAll, queryOne } from './jsonpath'
import { toDate } from './template'

import type { FieldType, ParsedStreamSpec } from '../spec'
import type { MappedRecord, PropertyValue, ScalarValue } from '../types'

/**
 * Property names as the graph keeps them: snake_case ASCII. `hs_lastmodifieddate`
 * stays, `FirstName` → `first_name`, `Close Date` → `close_date`.
 */
export function propertyName(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  // A leading digit or an empty name would not survive as a property.
  const safe = snake || 'value'
  return /^\d/.test(safe) ? `f_${safe}` : safe
}

const isScalar = (value: unknown): value is ScalarValue =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

/** Engine ingest turns nested objects into child records; connectors keep one record per provider object. */
function flattenInto(
  out: Record<string, PropertyValue>,
  prefix: string,
  value: unknown,
  depth: number,
  maxDepth: number
) {
  if (value === undefined) {
    return
  }
  if (isScalar(value)) {
    out[prefix] = value
    return
  }
  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      out[prefix] = value as ScalarValue[]
    } else {
      out[prefix] = JSON.stringify(value)
    }
    return
  }
  if (typeof value === 'object') {
    if (depth >= maxDepth) {
      out[prefix] = JSON.stringify(value)
      return
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flattenInto(out, prefix ? `${prefix}_${propertyName(key)}` : propertyName(key), item, depth + 1, maxDepth)
    }
  }
}

function convert(value: PropertyValue, type: FieldType): PropertyValue {
  if (value === null) {
    return null
  }
  if (Array.isArray(value)) {
    return type === 'json' ? JSON.stringify(value) : value.map((item) => convert(item, type) as ScalarValue)
  }
  switch (type) {
    case 'string':
      return String(value)
    case 'number': {
      const number = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(number) ? number : null
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : ['true', '1', 'yes'].includes(String(value).toLowerCase())
    case 'datetime':
    case 'unix':
    case 'unixMs': {
      const date =
        type === 'unix' && typeof value === 'number' ? new Date(value * 1000)
        : type === 'unixMs' && typeof value === 'number' ? new Date(value)
        : toDate(value)
      return date ? date.toISOString() : null
    }
    case 'cents': {
      const number = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(number) ? number / 100 : null
    }
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value)
  }
}

function idString(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined
  }
  if (typeof value === 'object') {
    // `{ id: … }` references (Stripe expanded objects, Jira `{ accountId }`).
    const candidate = (value as any).id ?? (value as any).accountId ?? (value as any).value
    return candidate === undefined ? undefined : idString(candidate)
  }
  return String(value)
}

/** Map one raw provider record; undefined when it has no id. */
export function mapRecord(raw: any, stream: ParsedStreamSpec): MappedRecord | undefined {
  const externalId = idString(queryOne(raw, stream.id))
  if (externalId === undefined) {
    return undefined
  }
  const fields = stream.fields
  const maxDepth = fields?.nestedDepth ?? 2

  let source: Record<string, unknown> = raw && typeof raw === 'object' ? { ...raw } : { value: raw }
  for (const path of fields?.flatten ?? []) {
    const nested = queryOne<Record<string, unknown>>(raw, path)
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const topKey = path.replace(/^\$\.?/, '').split(/[.[]/)[0]
      if (topKey) {
        delete source[topKey]
      }
      source = { ...source, ...nested }
    }
  }

  const rename = Object.fromEntries(
    Object.entries(fields?.rename ?? {}).map(([from, to]) => [propertyName(from), propertyName(to)])
  )
  // An omitted key drops the whole value, including the `key_child` properties a nested object would become.
  const omitted = new Set((fields?.omit ?? []).map(propertyName))
  let properties: Record<string, PropertyValue> = {}
  for (const [key, value] of Object.entries(source)) {
    const name = propertyName(key)
    if (omitted.has(name)) {
      continue
    }
    flattenInto(properties, rename[name] ?? name, value, 1, maxDepth)
  }

  if (fields?.pick?.length) {
    const keep = new Set(fields.pick.map(propertyName))
    properties = Object.fromEntries(Object.entries(properties).filter(([key]) => keep.has(key)))
  }
  for (const omit of omitted) {
    delete properties[omit]
  }
  for (const [field, type] of Object.entries(fields?.types ?? {})) {
    const name = propertyName(field)
    if (name in properties) {
      properties[name] = convert(properties[name], type)
    }
  }

  // Engine ids are ours; the provider's id lives in `external_id`.
  delete properties.id
  properties.external_id = externalId

  const links: MappedRecord['links'] = []
  for (const relation of stream.relations ?? []) {
    if (!relation.path) {
      continue
    }
    const externalIds = [
      ...new Set(
        queryAll(raw, relation.path)
          .flatMap((value) => (Array.isArray(value) ? value : [value]))
          .map(idString)
          .filter((id): id is string => Boolean(id))
      )
    ]
    if (externalIds.length) {
      links.push({ type: relation.type, target: relation.target, direction: relation.direction, externalIds })
    }
  }

  // Key relations hold a reference to another stream: keep the bare id, not an expanded object.
  for (const relation of stream.relations ?? []) {
    if (relation.field) {
      const name = propertyName(relation.field)
      const value = source[relation.field] ?? source[name]
      const id = idString(value)
      if (id !== undefined) {
        properties[name] = id
        for (const key of Object.keys(properties)) {
          if (key.startsWith(`${name}_`)) {
            delete properties[key]
          }
        }
      }
    }
  }

  const cursorValue = stream.incremental ? queryOne(raw, stream.incremental.cursorField) : undefined
  const deleted =
    stream.deleted ? queryOne(raw, stream.deleted.path) === (stream.deleted.value ?? true) : undefined

  return {
    externalId,
    properties,
    links,
    ...(deleted ? { deleted: true } : {}),
    ...(typeof cursorValue === 'string' || typeof cursorValue === 'number' ? { cursor: cursorValue } : {})
  }
}

/** Compare two cursor values of one stream (ISO strings, dates, numbers). */
export function cursorAfter(a: string | number, b: string | number): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return a > b
  }
  const da = toDate(a)
  const db = toDate(b)
  if (da && db) {
    return da.getTime() > db.getTime()
  }
  return String(a) > String(b)
}
