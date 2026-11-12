import { propertyName } from '../runtime/mapper'
import type { RelationSpec, StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * Airtable Web API: one stream per table of the configured base, from the
 * metadata API. Records page with the `offset` token. Linked-record fields
 * become relations to the linked table's stream.
 *
 * Incremental reads need a record's modification time, and Airtable returns
 * one only through a "Last modified time" field. When a table has one, it is
 * the cursor and the request filters with LAST_MODIFIED_TIME() (which covers
 * every field, so a field watching fewer columns can only cause re-reads,
 * never misses). Tables without one are read in full.
 *
 * No webhooks: Airtable webhooks deliver a ping only, and the changes must be
 * fetched from a per-webhook payload cursor, which a spec cannot express yet.
 */

type AirtableField = { id: string; name: string; type: string; options?: { linkedTableId?: string } }
type AirtableTable = { id: string; name: string; fields: AirtableField[] }

/** A JSONPath to a field by name, under `$.fields`. */
function fieldPath(name: string): string | undefined {
  if (!name.includes("'")) {
    return `$.fields['${name}']`
  }
  if (!name.includes('"')) {
    return `$.fields["${name}"]`
  }
  return undefined
}

function relationType(fieldName: string): string {
  const base = propertyName(fieldName).toUpperCase()
  return /^[A-Z]/.test(base) ? `LINKED_${base}` : 'LINKED_TO'
}

export function streamNames(tables: AirtableTable[]): Map<string, string> {
  const names = new Map<string, string>()
  const used = new Set<string>()
  for (const table of tables) {
    let name = propertyName(table.name)
    for (let n = 2; used.has(name); n++) {
      name = `${propertyName(table.name)}_${n}`
    }
    used.add(name)
    names.set(table.id, name)
  }
  return names
}

export function tableStream(table: AirtableTable, names: Map<string, string>): StreamSpec {
  const relations: RelationSpec[] = []
  for (const field of table.fields) {
    const target = field.type === 'multipleRecordLinks' ? names.get(field.options?.linkedTableId ?? '') : undefined
    const path = fieldPath(field.name)
    if (target && path) {
      relations.push({ type: relationType(field.name), target, path, direction: 'out' })
    }
  }
  const modified = table.fields.find((field) => field.type === 'lastModifiedTime')
  const modifiedPath = modified ? fieldPath(modified.name) : undefined
  const label = `AIRTABLE_${propertyName(table.name).toUpperCase()}`.replace(/^AIRTABLE_F_/, 'AIRTABLE_')
  return {
    label,
    description: `Records of the "${table.name}" table.`,
    request: { path: `/v0/{{config.baseId}}/${table.id}`, query: { pageSize: 100 } },
    records: '$.records',
    id: '$.id',
    pagination: { type: 'cursor', next: '$.offset', param: 'offset' },
    ...(modifiedPath ?
      {
        incremental: {
          cursorField: modifiedPath,
          format: 'iso' as const,
          request: {
            query: { filterByFormula: "IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('{{cursor|iso}}'))" }
          },
          lookbackSeconds: 60
        }
      }
    : {}),
    fields: { flatten: ['$.fields'], types: { createdTime: 'datetime' } },
    relations
  }
}

export const airtable = defineConnector({
  spec: {
    id: 'airtable',
    name: 'Airtable',
    category: 'database',
    description: 'Every table of an Airtable base as records, with linked records as relations.',
    docsUrl: 'https://airtable.com/developers/web/api/introduction',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://airtable.com/oauth2/v1/authorize',
        tokenUrl: 'https://airtable.com/oauth2/v1/token',
        scopes: ['data.records:read', 'schema.bases:read'],
        clientAuth: 'basic'
      },
      {
        type: 'bearer',
        label: 'Personal access token',
        help: 'airtable.com/create/tokens → Create token with the scopes data.records:read and schema.bases:read, and access to this base only.'
      }
    ],
    config: {
      baseId: {
        label: 'Base ID',
        placeholder: 'appXXXXXXXXXXXXXX',
        help: 'Starts with "app": the first part of the path in the base URL.'
      }
    },
    baseUrl: 'https://api.airtable.com',
    // Five requests per second per base.
    rateLimit: { requestsPerSecond: 5 },
    test: { request: { path: '/v0/meta/bases/{{config.baseId}}/tables' } },
    streams: {}
  },
  hooks: {
    async discover(ctx) {
      const baseId = String(ctx.connection.config.baseId ?? '')
      const response = await ctx.http.request({ url: `/v0/meta/bases/${encodeURIComponent(baseId)}/tables` })
      const tables: AirtableTable[] = response.data?.tables ?? []
      const names = streamNames(tables)
      return Object.fromEntries(tables.map((table) => [names.get(table.id)!, tableStream(table, names)]))
    }
  }
})
