import { defineConnector } from '../types'

/*
 * YouTrack REST API (Cloud and Server), at the instance URL from the config.
 *
 * Every list pages with `$skip`/`$top` and names the fields it returns.
 * Issues are read sorted by update time; once a cursor exists the search
 * query adds `updated: <date> .. *`. YouTrack reads absolute dates in the
 * user's time zone, so the filter uses the date only with a lookback of one
 * day, which covers any zone offset (re-reads, never misses).
 *
 * The `transform` hook flattens custom fields into `fields_<field name>`
 * properties (the value's name or presentation) and reads the assignee from
 * the Assignee field. Deleted issues are not reported by the API.
 */

const ISSUE_FIELDS = [
  'id',
  'idReadable',
  'summary',
  'description',
  'created',
  'updated',
  'resolved',
  'project(id,shortName)',
  'reporter(id,login)',
  'updater(id,login)',
  'tags(name)',
  'customFields(name,$type,value(id,name,login,fullName,text,presentation,minutes,$type))'
].join(',')

/** A custom field value as a scalar (or a list of them). */
export function customFieldValue(field: any): string | number | boolean | null | Array<string | number | boolean> {
  const value = field?.value
  if (value === null || value === undefined) {
    return null
  }
  if (field?.$type === 'DateIssueCustomField' && typeof value === 'number') {
    return new Date(value).toISOString()
  }
  const one = (item: any): string | number | boolean | null => {
    if (item === null || item === undefined) {
      return null
    }
    if (typeof item !== 'object') {
      return item
    }
    return item.presentation ?? item.name ?? item.fullName ?? item.login ?? item.text ?? null
  }
  if (Array.isArray(value)) {
    return value.map(one).filter((item): item is string | number | boolean => item !== null)
  }
  return one(value)
}

/** An issue as flat properties plus the ids the relations read. */
export function flattenIssue(issue: any) {
  const fields: Record<string, unknown> = {}
  let assignees: string[] = []
  for (const field of Array.isArray(issue?.customFields) ? issue.customFields : []) {
    if (typeof field?.name !== 'string') {
      continue
    }
    fields[field.name] = customFieldValue(field)
    if (field.name === 'Assignee') {
      const value = field.value
      assignees = (Array.isArray(value) ? value : [value]).map((user: any) => user?.id).filter(Boolean)
    }
  }
  return {
    id: issue.id,
    id_readable: issue.idReadable ?? null,
    summary: issue.summary ?? null,
    description: issue.description ?? null,
    created: issue.created ?? null,
    updated: issue.updated ?? null,
    resolved: issue.resolved ?? null,
    project_id: issue.project?.id ?? null,
    project_key: issue.project?.shortName ?? null,
    reporter_id: issue.reporter?.id ?? null,
    updater_id: issue.updater?.id ?? null,
    assignee_ids: assignees,
    tags: (Array.isArray(issue.tags) ? issue.tags : []).map((tag: any) => tag?.name).filter(Boolean),
    fields
  }
}

export const youtrack = defineConnector({
  spec: {
    id: 'youtrack',
    name: 'YouTrack',
    category: 'project-management',
    description: 'Issues with their custom fields, projects and users from YouTrack Cloud or Server.',
    docsUrl: 'https://www.jetbrains.com/help/youtrack/devportal/youtrack-rest-api.html',
    auth: [
      {
        type: 'bearer',
        label: 'Permanent token',
        help: 'Profile → Account Security → Tokens → New token, scope YouTrack. The token acts as its user: use an account with read-only access to the projects to sync.'
      }
    ],
    config: {
      url: {
        label: 'YouTrack URL',
        type: 'url',
        placeholder: 'https://acme.youtrack.cloud',
        help: 'The address you open YouTrack at, including any path prefix of a self-hosted instance (https://example.com/youtrack).'
      }
    },
    baseUrl: '{{config.url}}',
    rateLimit: { requestsPerSecond: 5 },
    test: { request: { path: '/api/users/me', query: { fields: 'id,login' } }, account: '$.login' },
    streams: {
      issues: {
        label: 'YOUTRACK_ISSUE',
        description: 'Issues of every project the account can read, custom fields as `fields_<name>`.',
        request: { path: '/api/issues', query: { fields: ISSUE_FIELDS, query: 'sort by: updated asc' } },
        records: '$',
        id: '$.id',
        pagination: { type: 'offset', param: '$skip', limitParam: '$top', limit: 100 },
        incremental: {
          cursorField: '$.updated',
          format: 'unixMs',
          request: { query: { query: 'updated: {{cursor|date}} .. * sort by: updated asc' } },
          lookbackSeconds: 86_400
        },
        fields: { types: { created: 'unixMs', updated: 'unixMs', resolved: 'unixMs' } },
        relations: [
          { type: 'IN_PROJECT', target: 'projects', path: '$.project_id' },
          { type: 'REPORTED_BY', target: 'users', path: '$.reporter_id' },
          { type: 'ASSIGNED_TO', target: 'users', path: '$.assignee_ids' }
        ]
      },
      projects: {
        label: 'YOUTRACK_PROJECT',
        description: 'Projects.',
        request: { path: '/api/admin/projects', query: { fields: 'id,name,shortName,description,archived,leader(id)' } },
        records: '$',
        id: '$.id',
        pagination: { type: 'offset', param: '$skip', limitParam: '$top', limit: 100 },
        // `$type` is on every YouTrack object; it becomes `type`.
        fields: { omit: ['$type', 'leader'] },
        relations: [{ type: 'LED_BY', target: 'users', path: '$.leader.id' }]
      },
      users: {
        label: 'YOUTRACK_USER',
        description: 'Users.',
        request: { path: '/api/users', query: { fields: 'id,login,fullName,email,banned,guest' } },
        records: '$',
        id: '$.id',
        pagination: { type: 'offset', param: '$skip', limitParam: '$top', limit: 100 },
        fields: { omit: ['$type'] }
      }
    }
  },
  hooks: {
    transform(stream, record) {
      return stream === 'issues' ? flattenIssue(record) : record
    }
  }
})
