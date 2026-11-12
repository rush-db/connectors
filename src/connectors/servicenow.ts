import type { FieldType, RelationSpec, StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * ServiceNow Table API. One stream per table named in the `tables` setting;
 * the spec carries the default tables so the catalog can list them, and
 * `discover` builds the streams from the connection's own list.
 *
 * Records come with raw values (`sysparm_display_value=false`) and plain
 * sys_id references (`sysparm_exclude_reference_link=true`). `sys_updated_on`
 * is UTC without a zone (`2024-01-01 12:00:00`); the cursor goes back in the
 * same format through the `sqlDatetime` filter.
 */

export const DEFAULT_TABLES = ['incident', 'problem', 'change_request', 'sys_user', 'cmdb_ci', 'kb_knowledge']

/** Reference fields with an obvious target table, and what to call the relation. */
const REFERENCES: Record<string, { table: string; type: string }> = {
  caller_id: { table: 'sys_user', type: 'REQUESTED_BY' },
  requested_by: { table: 'sys_user', type: 'REQUESTED_BY' },
  opened_by: { table: 'sys_user', type: 'OPENED_BY' },
  assigned_to: { table: 'sys_user', type: 'ASSIGNED_TO' },
  resolved_by: { table: 'sys_user', type: 'RESOLVED_BY' },
  closed_by: { table: 'sys_user', type: 'CLOSED_BY' },
  manager: { table: 'sys_user', type: 'REPORTS_TO' },
  author: { table: 'sys_user', type: 'AUTHORED_BY' },
  cmdb_ci: { table: 'cmdb_ci', type: 'AFFECTS' },
  problem_id: { table: 'problem', type: 'CAUSED_BY' },
  rfc: { table: 'change_request', type: 'CAUSED_BY_CHANGE' }
}

const DATETIMES: Record<string, FieldType> = {
  sys_created_on: 'datetime',
  sys_updated_on: 'datetime',
  opened_at: 'datetime',
  closed_at: 'datetime',
  resolved_at: 'datetime',
  start_date: 'datetime',
  end_date: 'datetime',
  due_date: 'datetime',
  last_login_time: 'datetime'
}

function labelFor(table: string): string {
  return `SN_${table.toUpperCase()}`
}

/** The configured tables, valid names only (they become URL path segments). */
export function configuredTables(config: Record<string, unknown>): string[] {
  const raw = config.tables
  const list =
    Array.isArray(raw) ? raw.map(String)
    : typeof raw === 'string' && raw.trim() ? raw.split(/[\s,]+/)
    : DEFAULT_TABLES
  return [...new Set(list.map((table) => table.trim().toLowerCase()).filter((table) => /^[a-z][a-z0-9_]*$/.test(table)))]
}

export function tableStream(table: string, synced: string[]): StreamSpec {
  const relations: RelationSpec[] = Object.entries(REFERENCES)
    .filter(([, reference]) => synced.includes(reference.table))
    .map(([field, reference]) => ({ type: reference.type, target: reference.table, path: `$.${field}`, direction: 'out' }))
  return {
    label: labelFor(table),
    description: `Rows of the ${table} table.`,
    request: {
      path: `/api/now/table/${table}`,
      query: {
        sysparm_query: 'ORDERBYsys_updated_on',
        sysparm_display_value: 'false',
        sysparm_exclude_reference_link: 'true'
      }
    },
    records: '$.result',
    id: '$.sys_id',
    pagination: { type: 'offset', param: 'sysparm_offset', limitParam: 'sysparm_limit', limit: 1000 },
    incremental: {
      cursorField: '$.sys_updated_on',
      format: 'iso',
      request: { query: { sysparm_query: 'sys_updated_on>{{cursor|sqlDatetime}}^ORDERBYsys_updated_on' } },
      lookbackSeconds: 120
    },
    fields: { omit: ['sys_tags'], types: DATETIMES },
    relations
  }
}

export const servicenow = defineConnector({
  spec: {
    id: 'servicenow',
    name: 'ServiceNow',
    category: 'itsm',
    description: 'Incidents, problems, changes, users, configuration items, knowledge articles or any other ServiceNow table.',
    docsUrl: 'https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI',
    auth: [
      {
        type: 'basic',
        usernameLabel: 'Username',
        passwordLabel: 'Password',
        help: 'A ServiceNow integration user with read-only roles on the synced tables (for example `itil` read, `knowledge`, `cmdb_read`) and the `snc_platform_rest_api_access` role where required.'
      },
      {
        type: 'oauth2',
        authorizeUrl: 'https://{{config.instance}}.service-now.com/oauth_auth.do',
        tokenUrl: 'https://{{config.instance}}.service-now.com/oauth_token.do',
        // ServiceNow scopes do not restrict tables; the user's roles do. Use a read-only user.
        scopes: ['useraccount'],
        pkce: false
      }
    ],
    config: {
      instance: {
        label: 'Instance name',
        placeholder: 'acme',
        help: 'The part before .service-now.com in your instance URL.'
      },
      tables: {
        label: 'Tables',
        type: 'list',
        required: false,
        default: DEFAULT_TABLES.join(','),
        help: 'Table names to sync, such as incident, problem, change_request, sys_user, cmdb_ci, kb_knowledge.'
      }
    },
    baseUrl: 'https://{{config.instance}}.service-now.com',
    rateLimit: { requestsPerSecond: 5 },
    test: {
      request: { path: '/api/now/table/sys_user', query: { sysparm_limit: 1, sysparm_fields: 'sys_id' } }
    },
    streams: Object.fromEntries(DEFAULT_TABLES.map((table) => [table, tableStream(table, DEFAULT_TABLES)]))
  },
  hooks: {
    async discover(ctx) {
      const tables = configuredTables(ctx.connection.config)
      return Object.fromEntries(tables.map((table) => [table, tableStream(table, tables)]))
    }
  }
})
