import type { FieldType, RelationSpec, StreamSpec } from '../spec'
import { defineConnector, type ConnectionContext, type ConnectorHttp, type StreamState } from '../types'

/*
 * Salesforce REST API, schedule-only (no webhooks).
 *
 * The spec lists the standard objects with `SELECT FIELDS(STANDARD)`, so it
 * works on its own; `discover` replaces them with the account's real field
 * lists (custom fields included) and adds every queryable, replicable custom
 * object (`__c`). Reference fields become key relations when they point to
 * exactly one synced object.
 *
 * `read` runs SOQL ordered by SystemModstamp and follows `nextRecordsUrl`.
 * With a cursor it reads `/queryAll` so deleted rows arrive as tombstones
 * (`IsDeleted = true`). Ascending order means every batch can advance the
 * cursor, so an interrupted backfill resumes as an incremental read.
 */

export const SALESFORCE_API = '/services/data/v62.0'

type StandardObject = { name: string; stream: string; label: string; relations: RelationSpec[] }

const rel = (type: string, target: string, field: string): RelationSpec => ({ type, target, field, direction: 'out' })

const STANDARD: StandardObject[] = [
  {
    name: 'Account',
    stream: 'accounts',
    label: 'SF_ACCOUNT',
    relations: [rel('OWNED_BY', 'users', 'OwnerId'), rel('CHILD_OF', 'accounts', 'ParentId')]
  },
  {
    name: 'Contact',
    stream: 'contacts',
    label: 'SF_CONTACT',
    relations: [
      rel('WORKS_AT', 'accounts', 'AccountId'),
      rel('OWNED_BY', 'users', 'OwnerId'),
      rel('REPORTS_TO', 'contacts', 'ReportsToId')
    ]
  },
  {
    name: 'Lead',
    stream: 'leads',
    label: 'SF_LEAD',
    relations: [
      rel('OWNED_BY', 'users', 'OwnerId'),
      rel('CONVERTED_TO_ACCOUNT', 'accounts', 'ConvertedAccountId'),
      rel('CONVERTED_TO_CONTACT', 'contacts', 'ConvertedContactId'),
      rel('CONVERTED_TO_OPPORTUNITY', 'opportunities', 'ConvertedOpportunityId')
    ]
  },
  {
    name: 'Opportunity',
    stream: 'opportunities',
    label: 'SF_OPPORTUNITY',
    relations: [rel('FOR_ACCOUNT', 'accounts', 'AccountId'), rel('OWNED_BY', 'users', 'OwnerId')]
  },
  {
    name: 'Case',
    stream: 'cases',
    label: 'SF_CASE',
    relations: [
      rel('FOR_ACCOUNT', 'accounts', 'AccountId'),
      rel('REQUESTED_BY', 'contacts', 'ContactId'),
      rel('ASSIGNED_TO', 'users', 'OwnerId')
    ]
  },
  { name: 'User', stream: 'users', label: 'SF_USER', relations: [rel('REPORTS_TO', 'users', 'ManagerId')] },
  {
    name: 'Task',
    stream: 'tasks',
    label: 'SF_TASK',
    relations: [rel('FOR_ACCOUNT', 'accounts', 'AccountId'), rel('ASSIGNED_TO', 'users', 'OwnerId')]
  },
  {
    name: 'Event',
    stream: 'events',
    label: 'SF_EVENT',
    relations: [rel('FOR_ACCOUNT', 'accounts', 'AccountId'), rel('ASSIGNED_TO', 'users', 'OwnerId')]
  }
]

/** Fields written by the platform on every save; relations through them are noise. */
const SKIP_RELATIONS = new Set(['CreatedById', 'LastModifiedById', 'MasterRecordId'])

function streamFor(objectName: string): string {
  return STANDARD.find((object) => object.name === objectName)?.stream ?? objectName.toLowerCase()
}

function labelFor(objectName: string): string {
  const standard = STANDARD.find((object) => object.name === objectName)
  if (standard) {
    return standard.label
  }
  const base = objectName
    .replace(/__c$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  return `SF_${base || 'OBJECT'}`
}

function relationType(objectName: string, field: string, relationshipName?: string): string {
  const known = STANDARD.find((object) => object.name === objectName)?.relations.find(
    (relation) => relation.field === field
  )
  if (known) {
    return known.type
  }
  if (field === 'OwnerId') {
    return 'OWNED_BY'
  }
  const base = (relationshipName ?? field.replace(/Id$/, ''))
    .replace(/__r$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  return /^[A-Z]/.test(base) ? `HAS_${base}` : 'REFERENCES'
}

function standardStream(object: StandardObject): StreamSpec {
  return {
    label: object.label,
    description: `Salesforce ${object.name} records.`,
    request: { path: `${SALESFORCE_API}/query`, query: { q: `SELECT FIELDS(STANDARD) FROM ${object.name}` } },
    records: '$.records',
    id: '$.Id',
    pagination: { type: 'nextUrl', next: '$.nextRecordsUrl' },
    incremental: { cursorField: '$.SystemModstamp', format: 'iso', lookbackSeconds: 60 },
    deleted: { path: '$.IsDeleted', value: true },
    fields: {
      omit: ['attributes'],
      types: { CreatedDate: 'datetime', LastModifiedDate: 'datetime', SystemModstamp: 'datetime' }
    },
    relations: object.relations
  }
}

type DescribeField = {
  name: string
  type: string
  referenceTo?: string[]
  relationshipName?: string | null
}

const DATETIME_TYPES = new Set(['datetime'])
const SKIP_TYPES = new Set(['base64', 'address', 'location'])

/** One stream from an object's describe; exported for tests. */
export function describedStream(objectName: string, fields: DescribeField[], synced: Set<string>): StreamSpec {
  const names = fields.filter((field) => !SKIP_TYPES.has(field.type)).map((field) => field.name)
  const has = (name: string) => names.includes(name)
  const cursorField = has('SystemModstamp') ? 'SystemModstamp' : has('LastModifiedDate') ? 'LastModifiedDate' : undefined
  const types: Record<string, FieldType> = {}
  const relations: RelationSpec[] = []
  for (const field of fields) {
    if (DATETIME_TYPES.has(field.type)) {
      types[field.name] = 'datetime'
    }
    if (field.type !== 'reference' || SKIP_RELATIONS.has(field.name) || SKIP_TYPES.has(field.type)) {
      continue
    }
    const targets = (field.referenceTo ?? []).filter((target) => synced.has(target))
    if (targets.length === 1) {
      relations.push(
        rel(relationType(objectName, field.name, field.relationshipName ?? undefined), streamFor(targets[0]), field.name)
      )
    }
  }
  return {
    label: labelFor(objectName),
    description: `Salesforce ${objectName} records.`,
    request: { path: `${SALESFORCE_API}/query`, query: { q: `SELECT ${names.join(', ')} FROM ${objectName}` } },
    records: '$.records',
    id: '$.Id',
    pagination: { type: 'nextUrl', next: '$.nextRecordsUrl' },
    ...(cursorField ? { incremental: { cursorField: `$.${cursorField}`, format: 'iso' as const, lookbackSeconds: 60 } } : {}),
    ...(has('IsDeleted') ? { deleted: { path: '$.IsDeleted', value: true } } : {}),
    fields: { omit: ['attributes'], types },
    relations
  }
}

const discovered = new WeakMap<ConnectionContext, { at: number; streams: Record<string, StreamSpec> }>()
const DISCOVERY_TTL_MS = 10 * 60 * 1000

async function discover(http: ConnectorHttp): Promise<Record<string, StreamSpec>> {
  const list = await http.request({ url: `${SALESFORCE_API}/sobjects` })
  const objects: any[] = list.data?.sobjects ?? []
  const wanted = objects.filter(
    (object) =>
      object.queryable &&
      !object.deprecatedAndHidden &&
      (STANDARD.some((standard) => standard.name === object.name) ||
        (object.custom && object.replicateable && String(object.name).endsWith('__c')))
  )
  const synced = new Set(wanted.map((object) => String(object.name)))
  const streams: Record<string, StreamSpec> = {}
  for (const object of wanted) {
    const describe = await http.request({ url: `${SALESFORCE_API}/sobjects/${object.name}/describe` })
    streams[streamFor(object.name)] = describedStream(object.name, describe.data?.fields ?? [], synced)
  }
  return streams
}

/** SOQL datetime literal: no milliseconds, UTC. */
export function soqlDatetime(value: string | number): string {
  const date = new Date(typeof value === 'number' ? value : Date.parse(value))
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function* readSoql(
  http: ConnectorHttp,
  baseQuery: string,
  cursorField: string | undefined,
  state: StreamState,
  lookbackSeconds: number
) {
  const since = state.cursor === undefined || !cursorField ? undefined : Date.parse(String(state.cursor))
  let soql = baseQuery
  if (cursorField) {
    if (since !== undefined && Number.isFinite(since)) {
      soql += ` WHERE ${cursorField} > ${soqlDatetime(since - lookbackSeconds * 1000)}`
    }
    soql += ` ORDER BY ${cursorField} ASC`
  }
  const endpoint = since !== undefined && Number.isFinite(since) ? 'queryAll' : 'query'
  let response = await http.request({ url: `${SALESFORCE_API}/${endpoint}`, query: { q: soql } })
  let cursor = state.cursor
  for (;;) {
    const records: any[] = response.data?.records ?? []
    if (cursorField) {
      for (const record of records) {
        const value = record[cursorField]
        if (typeof value === 'string' && (cursor === undefined || Date.parse(value) > Date.parse(String(cursor)))) {
          cursor = value
        }
      }
    }
    yield { records, state: { cursor } }
    const next = response.data?.nextRecordsUrl
    if (response.data?.done !== false || !next) {
      return
    }
    response = await http.request({ url: next })
  }
}

export const salesforce = defineConnector({
  spec: {
    id: 'salesforce',
    name: 'Salesforce',
    category: 'crm',
    description:
      'Accounts, contacts, leads, opportunities, cases, users, tasks, events and custom objects from Salesforce.',
    docsUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize',
        tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
        // Salesforce has no read-only API scope: connect as a user whose profile or
        // permission set grants read access only.
        scopes: ['api', 'refresh_token'],
        keepTokenFields: ['instance_url']
      }
    ],
    baseUrl: '{{credentials.instance_url}}',
    rateLimit: { requestsPerSecond: 5 },
    test: {
      request: { path: `${SALESFORCE_API}/query`, query: { q: 'SELECT Id, Name FROM Organization LIMIT 1' } },
      account: '$.records[0].Name'
    },
    streams: Object.fromEntries(STANDARD.map((object) => [object.stream, standardStream(object)]))
  },
  hooks: {
    async discover(ctx) {
      const cached = discovered.get(ctx.connection)
      if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) {
        return cached.streams
      }
      const streams = await discover(ctx.http)
      discovered.set(ctx.connection, { at: Date.now(), streams })
      return streams
    },
    read(stream, state, ctx) {
      const query = stream.spec.request.query?.q
      if (typeof query !== 'string') {
        return undefined
      }
      const cursorField = stream.spec.incremental?.cursorField.replace(/^\$\./, '')
      return readSoql(ctx.http, query, cursorField, state, stream.spec.incremental?.lookbackSeconds ?? 60)
    }
  }
})
