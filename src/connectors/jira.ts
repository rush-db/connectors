import { defineConnector, type ConnectionContext, type ConnectorHttp, type StreamState } from '../types'

/*
 * Jira Cloud REST API v3.
 *
 * Issues come from the enhanced JQL search (`/search/jql`, `nextPageToken`).
 * JQL compares dates in the connecting user's time zone at minute precision,
 * so the `read` hook reads that zone from `/myself` and writes the cursor in
 * it; results are ordered by `updated`, so each batch advances the cursor.
 * The `transform` hook turns an issue into flat properties: Atlassian
 * Document Format descriptions become plain text, people and projects become
 * ids for the relations.
 *
 * Sprints and comments are not synced yet (they need a request per board or
 * per issue).
 */

const ISSUE_FIELDS = [
  'summary',
  'status',
  'priority',
  'issuetype',
  'project',
  'assignee',
  'reporter',
  'creator',
  'created',
  'updated',
  'resolution',
  'resolutiondate',
  'duedate',
  'labels',
  'components',
  'fixVersions',
  'description',
  'parent',
  'issuelinks'
].join(',')

/** Plain text of an Atlassian Document Format node. */
export function adfToText(node: any): string {
  if (node === null || node === undefined) {
    return ''
  }
  if (typeof node === 'string') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map(adfToText).join('')
  }
  switch (node.type) {
    case 'text':
      return node.text ?? ''
    case 'hardBreak':
      return '\n'
    case 'mention':
    case 'emoji':
      return node.attrs?.text ?? ''
    case 'inlineCard':
    case 'blockCard':
      return node.attrs?.url ?? ''
    case 'listItem':
      return `- ${adfToText(node.content).trim()}\n`
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'codeBlock':
    case 'rule':
    case 'tableRow':
      return `${adfToText(node.content)}\n`
    case 'tableCell':
    case 'tableHeader':
      return `${adfToText(node.content).trim()}\t`
    default:
      return adfToText(node.content)
  }
}

const names = (items: any): string[] | undefined =>
  Array.isArray(items) ? items.map((item) => item?.name).filter((name) => typeof name === 'string') : undefined

/** An issue from the API as flat properties plus the ids the relations read. */
export function flattenIssue(issue: any) {
  const fields = issue?.fields ?? {}
  const description = adfToText(fields.description).replace(/\n{3,}/g, '\n\n').trim()
  return {
    id: issue.id,
    key: issue.key,
    summary: fields.summary ?? null,
    description: description || null,
    status: fields.status?.name ?? null,
    status_category: fields.status?.statusCategory?.key ?? null,
    priority: fields.priority?.name ?? null,
    issue_type: fields.issuetype?.name ?? null,
    resolution: fields.resolution?.name ?? null,
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    components: names(fields.components) ?? [],
    fix_versions: names(fields.fixVersions) ?? [],
    created: fields.created ?? null,
    updated: fields.updated ?? null,
    resolved_at: fields.resolutiondate ?? null,
    due_date: fields.duedate ?? null,
    project_id: fields.project?.id ?? null,
    project_key: fields.project?.key ?? null,
    assignee_id: fields.assignee?.accountId ?? null,
    reporter_id: fields.reporter?.accountId ?? null,
    creator_id: fields.creator?.accountId ?? null,
    parent_id: fields.parent?.id ?? null,
    linked_issue_ids: (Array.isArray(fields.issuelinks) ? fields.issuelinks : [])
      .map((link: any) => link?.outwardIssue?.id ?? link?.inwardIssue?.id)
      .filter(Boolean)
  }
}

/** `yyyy/MM/dd HH:mm` in a time zone, as JQL wants it. */
export function jqlDate(time: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(time))
      .map((part) => [part.type, part.value])
  )
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`
}

const zones = new WeakMap<ConnectionContext, string>()

async function userTimeZone(http: ConnectorHttp, connection: ConnectionContext): Promise<string> {
  const cached = zones.get(connection)
  if (cached) {
    return cached
  }
  const me = await http.request({ url: '/rest/api/3/myself' })
  let zone = typeof me.data?.timeZone === 'string' ? me.data.timeZone : 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
  } catch {
    zone = 'UTC'
  }
  zones.set(connection, zone)
  return zone
}

async function* readIssues(
  http: ConnectorHttp,
  connection: ConnectionContext,
  state: StreamState,
  lookbackSeconds: number
) {
  const since = state.cursor === undefined ? NaN : Date.parse(String(state.cursor))
  // The enhanced search refuses unbounded JQL; a date bound from the epoch reads everything.
  const from =
    Number.isFinite(since) ?
      jqlDate(since - lookbackSeconds * 1000, await userTimeZone(http, connection))
    : '1970/01/01 00:00'
  const jql = `updated >= "${from}" ORDER BY updated ASC`
  let token: string | undefined
  let cursor = state.cursor
  for (;;) {
    const response = await http.request({
      url: '/rest/api/3/search/jql',
      query: { jql, fields: ISSUE_FIELDS, maxResults: 100, ...(token ? { nextPageToken: token } : {}) }
    })
    const issues: any[] = response.data?.issues ?? []
    for (const issue of issues) {
      const updated = issue?.fields?.updated
      if (typeof updated === 'string' && (cursor === undefined || Date.parse(updated) > Date.parse(String(cursor)))) {
        cursor = updated
      }
    }
    yield { records: issues, state: { cursor } }
    token = response.data?.nextPageToken
    if (!token || response.data?.isLast === true || !issues.length) {
      return
    }
  }
}

export const jira = defineConnector({
  spec: {
    id: 'jira',
    name: 'Jira',
    category: 'project-management',
    description: 'Issues, projects and users from Jira Cloud, with assignees, reporters, parents and issue links.',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://auth.atlassian.com/authorize',
        tokenUrl: 'https://auth.atlassian.com/oauth/token',
        scopes: ['read:jira-work', 'read:jira-user', 'offline_access'],
        pkce: false,
        authorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
        // OAuth tokens only work through the Atlassian API gateway, addressed by cloud id.
        baseUrl: 'https://api.atlassian.com/ex/jira/{{config.cloudId}}'
      },
      {
        type: 'basic',
        usernameLabel: 'Atlassian account email',
        passwordLabel: 'API token',
        help: 'Create an API token at id.atlassian.com → Security → API tokens. The connection sees what this account can browse; use an account with browse-only permissions.'
      }
    ],
    config: {
      site: {
        label: 'Site',
        placeholder: 'acme.atlassian.net',
        help: 'Your Jira Cloud host, without https://.'
      },
      cloudId: {
        label: 'Cloud ID',
        required: false,
        help: 'Needed for OAuth only: the `id` of your site in https://api.atlassian.com/oauth/token/accessible-resources (or https://<site>/_edge/tenant_info).'
      }
    },
    baseUrl: 'https://{{config.site}}',
    rateLimit: { requestsPerSecond: 5 },
    test: { request: { path: '/rest/api/3/serverInfo' }, account: '$.baseUrl' },
    streams: {
      issues: {
        label: 'JIRA_ISSUE',
        description: 'Issues of every project the account can browse.',
        request: {
          path: '/rest/api/3/search/jql',
          query: { jql: 'updated >= "1970/01/01 00:00" ORDER BY updated ASC', fields: ISSUE_FIELDS, maxResults: 100 }
        },
        records: '$.issues',
        id: '$.id',
        pagination: { type: 'cursor', next: '$.nextPageToken', param: 'nextPageToken' },
        // Applied to the transformed issue; the read hook writes the JQL.
        incremental: { cursorField: '$.updated', format: 'iso', lookbackSeconds: 120 },
        fields: { types: { created: 'datetime', updated: 'datetime', resolved_at: 'datetime' } },
        relations: [
          { type: 'IN_PROJECT', target: 'projects', path: '$.project_id' },
          { type: 'ASSIGNED_TO', target: 'users', path: '$.assignee_id' },
          { type: 'REPORTED_BY', target: 'users', path: '$.reporter_id' },
          { type: 'CHILD_OF', target: 'issues', path: '$.parent_id' },
          { type: 'LINKED_TO', target: 'issues', path: '$.linked_issue_ids' }
        ]
      },
      projects: {
        label: 'JIRA_PROJECT',
        description: 'Projects.',
        request: { path: '/rest/api/3/project/search', query: { expand: 'lead,description' } },
        records: '$.values',
        id: '$.id',
        pagination: { type: 'offset', param: 'startAt', limitParam: 'maxResults', limit: 50 },
        fields: { omit: ['self', 'avatarUrls', 'lead', 'expand'] },
        relations: [{ type: 'LED_BY', target: 'users', path: '$.lead.accountId' }]
      },
      users: {
        label: 'JIRA_USER',
        description: 'Users (Atlassian accounts, apps and customers).',
        request: { path: '/rest/api/3/users/search' },
        records: '$',
        id: '$.accountId',
        pagination: { type: 'offset', param: 'startAt', limitParam: 'maxResults', limit: 1000 },
        fields: { omit: ['self', 'avatarUrls'] }
      }
    },
    webhooks: {
      // Admin webhooks with a secret send `X-Hub-Signature: sha256=<hex HMAC of the body>`.
      signature: { scheme: 'hmacSha256', header: 'X-Hub-Signature', prefix: 'sha256=' },
      type: '$.webhookEvent',
      // Jira events carry no event id; the timestamp is the closest thing.
      id: '$.timestamp',
      object: '$.issue',
      routes: {
        'jira:issue_deleted': { stream: 'issues', action: 'delete' },
        'jira:issue_*': { stream: 'issues', action: 'refetch' },
        'project_*': { stream: 'projects', action: 'refetch' },
        'user_*': { stream: 'users', action: 'refetch' }
      },
      setup:
        'Jira settings → System → WebHooks → Create a WebHook: URL = the connection’s webhook URL, a secret (paste it here as the signing secret), events Issue created/updated/deleted, Project created/updated/deleted and User created/updated/deleted.'
    }
  },
  hooks: {
    read(stream, state, ctx) {
      if (stream.name !== 'issues') {
        return undefined
      }
      return readIssues(ctx.http, ctx.connection, state, stream.spec.incremental?.lookbackSeconds ?? 120)
    },
    transform(stream, record) {
      return stream === 'issues' ? flattenIssue(record) : record
    }
  }
})
