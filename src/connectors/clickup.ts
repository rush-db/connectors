import { defineConnector, type ConnectorHttp } from '../types'

/*
 * ClickUp API v2 for one Workspace (a "team" in the API).
 *
 * Spaces come from the Workspace. Folders and lists live under each space
 * (folderless lists directly under the space), and ClickUp has no endpoint
 * listing them for the whole Workspace, so the `read` hook walks the
 * hierarchy. Users are the Workspace's members from the authorized
 * Workspaces list, which the hook narrows to the configured one.
 *
 * Tasks come from the filtered Workspace tasks endpoint (100 per page,
 * subtasks and closed tasks included) with `date_updated_gt` once a cursor
 * exists. Deleted tasks are not reported. The `transform` hook turns tags,
 * assignees and custom fields into flat values.
 */

const API = '/api/v2'

const teamId = (config: Record<string, unknown>) => encodeURIComponent(String(config.teamId ?? ''))

async function spacesOf(http: ConnectorHttp, team: string): Promise<any[]> {
  const response = await http.request({ url: `${API}/team/${team}/space`, query: { archived: false } })
  return response.data?.spaces ?? []
}

async function* readFolders(http: ConnectorHttp, team: string) {
  for (const space of await spacesOf(http, team)) {
    const response = await http.request({ url: `${API}/space/${encodeURIComponent(space.id)}/folder`, query: { archived: false } })
    yield { records: response.data?.folders ?? [], state: {} }
  }
}

async function* readLists(http: ConnectorHttp, team: string) {
  for (const space of await spacesOf(http, team)) {
    const id = encodeURIComponent(space.id)
    const folderless = await http.request({ url: `${API}/space/${id}/list`, query: { archived: false } })
    // A folderless list names a hidden placeholder folder; it is not a folder people see.
    const lists = (folderless.data?.lists ?? []).map((list: any) => (list?.folder?.hidden ? { ...list, folder: null } : list))
    // Folders embed their lists.
    const folders = await http.request({ url: `${API}/space/${id}/folder`, query: { archived: false } })
    for (const folder of folders.data?.folders ?? []) {
      for (const list of folder?.lists ?? []) {
        lists.push({ ...list, folder: { id: folder.id, name: folder.name }, space: list.space ?? { id: space.id } })
      }
    }
    yield { records: lists, state: {} }
  }
}

async function* readUsers(http: ConnectorHttp, team: string) {
  const response = await http.request({ url: `${API}/team` })
  const workspace = (response.data?.teams ?? []).find((candidate: any) => String(candidate?.id) === decodeURIComponent(team))
  if (!workspace) {
    throw new Error(`ClickUp Workspace ${decodeURIComponent(team)} is not among the token's Workspaces`)
  }
  yield { records: (workspace.members ?? []).map((member: any) => member?.user).filter(Boolean), state: {} }
}

const scalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value)

/** A task as flat properties plus the ids the relations read. */
export function flattenTask(task: any) {
  const fields: Record<string, unknown> = {}
  for (const field of Array.isArray(task?.custom_fields) ? task.custom_fields : []) {
    const value = field?.value
    if (typeof field?.name === 'string' && value !== undefined && (scalar(value) || (Array.isArray(value) && value.every(scalar)))) {
      fields[field.name] = value
    }
  }
  return {
    id: task.id,
    custom_id: task.custom_id ?? null,
    name: task.name ?? null,
    description: task.text_content || null,
    status: task.status?.status ?? null,
    status_type: task.status?.type ?? null,
    priority: task.priority?.priority ?? null,
    url: task.url ?? null,
    archived: task.archived ?? null,
    points: task.points ?? null,
    time_estimate: task.time_estimate ?? null,
    due_date: task.due_date ?? null,
    start_date: task.start_date ?? null,
    date_created: task.date_created ?? null,
    date_updated: task.date_updated ?? null,
    date_closed: task.date_closed ?? null,
    date_done: task.date_done ?? null,
    tags: (Array.isArray(task.tags) ? task.tags : []).map((tag: any) => tag?.name).filter(Boolean),
    parent_id: task.parent ?? null,
    creator_id: task.creator?.id ?? null,
    assignee_ids: (Array.isArray(task.assignees) ? task.assignees : []).map((user: any) => user?.id).filter((id: unknown) => id !== undefined),
    list_id: task.list?.id ?? null,
    folder_id: task.folder?.hidden ? null : (task.folder?.id ?? null),
    space_id: task.space?.id ?? null,
    fields
  }
}

const MS_DATES = ['due_date', 'start_date', 'date_created', 'date_updated', 'date_closed', 'date_done'] as const

export const clickup = defineConnector({
  spec: {
    id: 'clickup',
    name: 'ClickUp',
    category: 'project-management',
    description: 'Spaces, folders, lists, tasks and members of a ClickUp Workspace.',
    docsUrl: 'https://developer.clickup.com/reference',
    auth: [
      {
        type: 'bearer',
        label: 'Personal API token',
        // Personal tokens (pk_…) go in the Authorization header as is.
        prefix: '',
        help: 'Avatar → Settings → Apps → API Token → Generate. ClickUp tokens have no read-only scope; they act as their user, so use a member with view-only access to the spaces to sync.'
      }
    ],
    config: {
      teamId: {
        label: 'Workspace ID',
        placeholder: '9012345678',
        help: 'The number after app.clickup.com/ in the address bar when the Workspace is open.'
      }
    },
    baseUrl: 'https://api.clickup.com',
    // 100 requests per minute per token on most plans.
    rateLimit: { requestsPerSecond: 1.5 },
    test: { request: { path: `${API}/user` }, account: '$.user.username' },
    streams: {
      spaces: {
        label: 'CLICKUP_SPACE',
        description: 'Spaces of the Workspace.',
        request: { path: `${API}/team/{{config.teamId}}/space`, query: { archived: false } },
        records: '$.spaces',
        id: '$.id',
        fields: { omit: ['statuses', 'features', 'members'] }
      },
      folders: {
        label: 'CLICKUP_FOLDER',
        description: 'Folders of every space.',
        // The read hook lists the folders of each space.
        request: { path: `${API}/team/{{config.teamId}}/space` },
        records: '$.folders',
        id: '$.id',
        fields: { omit: ['lists', 'statuses', 'space'] },
        relations: [{ type: 'IN_SPACE', target: 'spaces', path: '$.space.id' }]
      },
      lists: {
        label: 'CLICKUP_LIST',
        description: 'Lists of every space and folder.',
        // The read hook lists folderless lists and the lists of each folder.
        request: { path: `${API}/team/{{config.teamId}}/space` },
        records: '$.lists',
        id: '$.id',
        fields: { omit: ['folder', 'space', 'statuses', 'assignee', 'status', 'priority'] },
        relations: [
          { type: 'IN_FOLDER', target: 'folders', path: '$.folder.id' },
          { type: 'IN_SPACE', target: 'spaces', path: '$.space.id' }
        ]
      },
      tasks: {
        label: 'CLICKUP_TASK',
        description: 'Tasks and subtasks, closed ones included.',
        request: {
          path: `${API}/team/{{config.teamId}}/task`,
          query: { include_closed: true, subtasks: true, order_by: 'updated' }
        },
        records: '$.tasks',
        id: '$.id',
        pagination: { type: 'page', param: 'page', start: 0, size: 100 },
        incremental: {
          // Applied to the transformed task: milliseconds as a string.
          cursorField: '$.date_updated',
          format: 'unixMs',
          request: { query: { date_updated_gt: '{{cursor|unixMs}}' } },
          lookbackSeconds: 60
        },
        fields: { types: Object.fromEntries(MS_DATES.map((name) => [name, 'unixMs' as const])) },
        relations: [
          { type: 'IN_LIST', target: 'lists', path: '$.list_id' },
          { type: 'CHILD_OF', target: 'tasks', path: '$.parent_id' },
          { type: 'ASSIGNED_TO', target: 'users', path: '$.assignee_ids' },
          { type: 'CREATED_BY', target: 'users', path: '$.creator_id' }
        ]
      },
      users: {
        label: 'CLICKUP_USER',
        description: 'Members of the Workspace.',
        // The read hook picks the configured Workspace from the authorized ones.
        request: { path: `${API}/team` },
        records: '$.teams',
        id: '$.id',
        fields: { omit: ['profilePicture'] }
      }
    }
  },
  hooks: {
    read(stream, _state, ctx) {
      const team = teamId(ctx.connection.config)
      switch (stream.name) {
        case 'folders':
          return readFolders(ctx.http, team)
        case 'lists':
          return readLists(ctx.http, team)
        case 'users':
          return readUsers(ctx.http, team)
        default:
          return undefined
      }
    },
    transform(stream, record) {
      return stream === 'tasks' ? flattenTask(record) : record
    }
  }
})
