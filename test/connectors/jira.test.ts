import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { jira } from '../../src/connectors'
import { adfToText, jqlDate } from '../../src/connectors/jira'
import { parseConnectorSpec, parseWebhook, verifyWebhook, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const basic = (): ConnectionContext => ({
  config: { site: 'acme.atlassian.net' },
  credentials: { type: 'basic', username: 'dev@example.com', password: 'api-token' }
})

const issue = (id: string, updated: string) => ({
  id,
  key: `ENG-${id}`,
  fields: {
    summary: `Issue ${id}`,
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'High' },
    issuetype: { name: 'Bug' },
    project: { id: '100', key: 'ENG' },
    assignee: { accountId: 'acc-1' },
    reporter: { accountId: 'acc-2' },
    labels: ['backend'],
    created: '2024-01-01T09:00:00.000+0100',
    updated,
    description: {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Steps:' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open' }] }] }] }
      ]
    },
    issuelinks: [{ outwardIssue: { id: '900' } }, { inwardIssue: { id: '901' } }]
  }
})

describe('jira', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(jira.spec).streams)).toEqual(['issues', 'projects', 'users'])
  })

  it('tests against the site, or the API gateway with OAuth', async () => {
    const { fetch, runtime } = mockRuntime([{ path: /\/rest\/api\/3\/serverInfo$/, body: { baseUrl: 'https://acme.atlassian.net' } }])
    expect(await runtime.test(jira, basic())).toEqual({ account: 'https://acme.atlassian.net' })
    await runtime.test(jira, { config: { site: 'acme.atlassian.net', cloudId: 'cloud-1' }, credentials: { type: 'oauth2', accessToken: 't' } })
    expect(fetch.calls[0].url).toBe('https://acme.atlassian.net/rest/api/3/serverInfo')
    expect(fetch.calls[1].url).toBe('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/serverInfo')
  })

  it('backfills issues as flat records with plain-text descriptions', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/rest/api/3/search/jql', query: { nextPageToken: 'n2' }, body: { issues: [issue('2', '2024-01-03T10:00:00.000+0000')], isLast: true } },
      { path: '/rest/api/3/search/jql', body: { issues: [issue('1', '2024-01-02T10:00:00.000+0000')], nextPageToken: 'n2' } }
    ])
    const batches = await readAll(runtime, jira, basic(), 'issues')
    expect(new URL(fetch.calls[0].url).searchParams.get('jql')).toBe('updated >= "1970/01/01 00:00" ORDER BY updated ASC')
    const [first] = records(batches)
    expect(records(batches)).toHaveLength(2)
    expect(first.properties).toMatchObject({
      key: 'ENG-1',
      summary: 'Issue 1',
      status: 'In Progress',
      issue_type: 'Bug',
      description: 'Steps:\n- Open',
      labels: ['backend'],
      created: '2024-01-01T08:00:00.000Z'
    })
    expect(first.links.map((link) => [link.type, link.externalIds])).toEqual([
      ['IN_PROJECT', ['100']],
      ['ASSIGNED_TO', ['acc-1']],
      ['REPORTED_BY', ['acc-2']],
      ['LINKED_TO', ['900', '901']]
    ])
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-03T10:00:00.000+0000')
  })

  it('writes the cursor in the user’s time zone', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/rest/api/3/myself', body: { accountId: 'me', timeZone: 'Europe/Berlin' } },
      { path: '/rest/api/3/search/jql', body: { issues: [] } }
    ])
    await readAll(runtime, jira, basic(), 'issues', { cursor: '2024-01-10T00:00:00.000+0000' })
    const search = fetch.calls.find((call) => call.url.includes('/search/jql'))!
    expect(new URL(search.url).searchParams.get('jql')).toBe('updated >= "2024/01/10 00:58" ORDER BY updated ASC')
    expect(jqlDate(Date.parse('2024-07-01T12:00:00Z'), 'America/New_York')).toBe('2024/07/01 08:00')
  })

  it('reads projects with offset pages', async () => {
    const { runtime } = mockRuntime([
      { path: '/rest/api/3/project/search', body: { values: [{ id: '100', key: 'ENG', name: 'Engineering', lead: { accountId: 'acc-1' } }], isLast: true } }
    ])
    const [project] = records(await readAll(runtime, jira, basic(), 'projects'))
    expect(project.properties).toEqual({ key: 'ENG', name: 'Engineering', external_id: '100' })
    expect(project.links).toEqual([{ type: 'LED_BY', target: 'users', direction: 'out', externalIds: ['acc-1'] }])
  })

  it('flattens ADF', () => {
    expect(adfToText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Ada' } }, { type: 'hardBreak' }] }] })).toBe(
      '@Ada\n\n'
    )
  })

  it('verifies X-Hub-Signature and routes issue events', () => {
    const spec = parseConnectorSpec(jira.spec)
    const rawBody = JSON.stringify({ timestamp: 1704067200000, webhookEvent: 'jira:issue_deleted', issue: issue('5', '2024-01-01T00:00:00.000+0000') })
    const signature = `sha256=${createHmac('sha256', 'jira-secret').update(rawBody).digest('hex')}`
    expect(verifyWebhook(spec, { headers: { 'x-hub-signature': signature }, rawBody, secret: 'jira-secret' })).toBe(true)
    expect(parseWebhook(spec, JSON.parse(rawBody))).toEqual([
      { id: '1704067200000', type: 'jira:issue_deleted', stream: 'issues', action: 'delete', externalId: '5' }
    ])
    expect(parseWebhook(spec, { timestamp: 1, webhookEvent: 'jira:issue_updated', issue: { id: '6' } })[0]).toMatchObject({
      action: 'refetch',
      externalId: '6'
    })
  })
})
