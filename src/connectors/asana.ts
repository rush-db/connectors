import { defineConnector, type ConnectionContext, type ConnectorHttp, type StreamState } from '../types'

/*
 * Asana REST API 1.0 for one workspace.
 *
 * Lists page with `limit`/`offset` and `next_page.offset`, and return only the
 * fields named in `opt_fields`. Tasks (and sections) are listed per project,
 * so the `read` hook walks the workspace's projects; tasks read with
 * `modified_since` once a cursor exists. Projects are not read in
 * modification order, so the hook keeps the old cursor until its last batch.
 * A task in several projects is read once per project (same id, one record).
 * Tasks in no project (private "My tasks" items) and subtasks outside a
 * project are not read. Deleted tasks are not reported.
 *
 * The `transform` hook turns tags, memberships and custom fields (their
 * display values) into flat values.
 */

const PAGE = 100

const TASK_FIELDS = [
  'name',
  'notes',
  'resource_subtype',
  'completed',
  'completed_at',
  'created_at',
  'modified_at',
  'due_on',
  'due_at',
  'start_on',
  'num_subtasks',
  'permalink_url',
  'assignee',
  'parent',
  'projects',
  'memberships.section',
  'tags.name',
  'custom_fields.name',
  'custom_fields.display_value'
].join(',')

const workspace = (connection: ConnectionContext) => String(connection.config.workspaceId ?? '')

async function* pages(http: ConnectorHttp, url: string, query: Record<string, string | number>) {
  let offset: string | undefined
  for (;;) {
    const response = await http.request({ url, query: { limit: PAGE, ...query, ...(offset ? { offset } : {}) } })
    yield (response.data?.data ?? []) as any[]
    offset = response.data?.next_page?.offset
    if (!offset) {
      return
    }
  }
}

async function* projectGids(http: ConnectorHttp, connection: ConnectionContext) {
  for await (const projects of pages(http, '/projects', { workspace: workspace(connection), opt_fields: 'gid' })) {
    for (const project of projects) {
      yield String(project.gid)
    }
  }
}

async function* readTasks(http: ConnectorHttp, connection: ConnectionContext, state: StreamState, lookbackSeconds: number) {
  const since = state.cursor === undefined ? NaN : Date.parse(String(state.cursor))
  const modified: Record<string, string> =
    Number.isFinite(since) ? { modified_since: new Date(since - lookbackSeconds * 1000).toISOString() } : {}
  for await (const project of projectGids(http, connection)) {
    for await (const tasks of pages(http, '/tasks', { project, opt_fields: TASK_FIELDS, ...modified })) {
      yield { records: tasks, state: { cursor: state.cursor } }
    }
  }
  // The runtime stores the newest modified_at seen.
  yield { records: [], state: {} }
}

async function* readSections(http: ConnectorHttp, connection: ConnectionContext) {
  for await (const project of projectGids(http, connection)) {
    for await (const sections of pages(http, `/projects/${encodeURIComponent(project)}/sections`, {
      opt_fields: 'name,created_at,project'
    })) {
      yield { records: sections, state: {} }
    }
  }
}

const gids = (items: unknown): string[] =>
  (Array.isArray(items) ? items : []).map((item: any) => item?.gid).filter((gid): gid is string => typeof gid === 'string')

/** A task as flat properties plus the gids the relations read. */
export function flattenTask(task: any) {
  const fields: Record<string, string | null> = {}
  for (const field of Array.isArray(task?.custom_fields) ? task.custom_fields : []) {
    if (typeof field?.name === 'string') {
      fields[field.name] = field.display_value ?? null
    }
  }
  return {
    gid: task.gid,
    name: task.name ?? null,
    notes: task.notes || null,
    resource_subtype: task.resource_subtype ?? null,
    completed: task.completed ?? null,
    completed_at: task.completed_at ?? null,
    created_at: task.created_at ?? null,
    modified_at: task.modified_at ?? null,
    due_on: task.due_on ?? null,
    due_at: task.due_at ?? null,
    start_on: task.start_on ?? null,
    num_subtasks: task.num_subtasks ?? null,
    permalink_url: task.permalink_url ?? null,
    tags: (Array.isArray(task.tags) ? task.tags : []).map((tag: any) => tag?.name).filter(Boolean),
    assignee_gid: task.assignee?.gid ?? null,
    parent_gid: task.parent?.gid ?? null,
    project_gids: gids(task.projects),
    section_gids: gids((Array.isArray(task.memberships) ? task.memberships : []).map((membership: any) => membership?.section)),
    fields
  }
}

const OMIT = ['gid', 'resource_type']

export const asana = defineConnector({
  spec: {
    id: 'asana',
    name: 'Asana',
    category: 'project-management',
    description: 'Projects, tasks, sections and users of an Asana workspace, with assignees, subtasks and sections.',
    docsUrl: 'https://developers.asana.com/reference/rest-api-reference',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
        tokenUrl: 'https://app.asana.com/-/oauth_token',
        scopes: ['workspaces:read', 'projects:read', 'tasks:read', 'users:read', 'tags:read', 'custom_fields:read'],
        pkce: true
      },
      {
        type: 'bearer',
        label: 'Personal access token',
        help: 'Asana → My settings → Apps → Developer apps (app.asana.com/0/my-apps) → Create new token. Personal access tokens have their user’s full access; use an account with comment-only or view access to the projects to sync.'
      }
    ],
    config: {
      workspaceId: {
        label: 'Workspace ID',
        placeholder: '1200000000000000',
        help: 'The gid of the workspace or organization: https://app.asana.com/api/1.0/workspaces lists the ones your account belongs to.'
      }
    },
    baseUrl: 'https://app.asana.com/api/1.0',
    // 150 requests per minute on free workspaces, 1,500 on paid ones.
    rateLimit: { requestsPerSecond: 2 },
    test: { request: { path: '/users/me', query: { opt_fields: 'name' } }, account: '$.data.name' },
    streams: {
      workspaces: {
        label: 'ASANA_WORKSPACE',
        description: 'The configured workspace.',
        request: { path: '/workspaces/{{config.workspaceId}}', query: { opt_fields: 'name,is_organization,email_domains' } },
        records: '$.data',
        id: '$.gid',
        fields: { omit: OMIT }
      },
      projects: {
        label: 'ASANA_PROJECT',
        description: 'Projects of the workspace, archived ones included.',
        request: {
          path: '/projects',
          query: {
            workspace: '{{config.workspaceId}}',
            limit: PAGE,
            opt_fields: 'name,notes,archived,color,public,created_at,modified_at,due_on,start_on,permalink_url,owner,team.name,workspace'
          }
        },
        records: '$.data',
        id: '$.gid',
        pagination: { type: 'cursor', next: '$.next_page.offset', param: 'offset' },
        fields: {
          omit: [...OMIT, 'owner', 'workspace', 'team_resource_type'],
          types: { created_at: 'datetime', modified_at: 'datetime' }
        },
        relations: [
          { type: 'OWNED_BY', target: 'users', path: '$.owner.gid' },
          { type: 'IN_WORKSPACE', target: 'workspaces', path: '$.workspace.gid' }
        ]
      },
      tasks: {
        label: 'ASANA_TASK',
        description: 'Tasks of every project, custom fields as `fields_<name>`.',
        // The read hook lists the tasks of each project.
        request: { path: '/tasks' },
        records: '$.data',
        id: '$.gid',
        incremental: { cursorField: '$.modified_at', format: 'iso', lookbackSeconds: 60 },
        fields: {
          omit: OMIT,
          types: { completed_at: 'datetime', created_at: 'datetime', modified_at: 'datetime', due_at: 'datetime' }
        },
        relations: [
          { type: 'IN_PROJECT', target: 'projects', path: '$.project_gids' },
          { type: 'IN_SECTION', target: 'sections', path: '$.section_gids' },
          { type: 'ASSIGNED_TO', target: 'users', path: '$.assignee_gid' },
          { type: 'CHILD_OF', target: 'tasks', path: '$.parent_gid' }
        ]
      },
      users: {
        label: 'ASANA_USER',
        description: 'Users of the workspace.',
        request: { path: '/users', query: { workspace: '{{config.workspaceId}}', limit: PAGE, opt_fields: 'name,email' } },
        records: '$.data',
        id: '$.gid',
        pagination: { type: 'cursor', next: '$.next_page.offset', param: 'offset' },
        fields: { omit: OMIT }
      },
      sections: {
        label: 'ASANA_SECTION',
        description: 'Sections (board columns) of every project.',
        optional: true,
        request: { path: '/sections' },
        records: '$.data',
        id: '$.gid',
        fields: { omit: [...OMIT, 'project'], types: { created_at: 'datetime' } },
        relations: [{ type: 'IN_PROJECT', target: 'projects', path: '$.project.gid' }]
      }
    }
  },
  hooks: {
    read(stream, state, ctx) {
      if (stream.name === 'tasks') {
        return readTasks(ctx.http, ctx.connection, state, stream.spec.incremental?.lookbackSeconds ?? 60)
      }
      return stream.name === 'sections' ? readSections(ctx.http, ctx.connection) : undefined
    },
    transform(stream, record) {
      return stream === 'tasks' ? flattenTask(record) : record
    }
  }
})
