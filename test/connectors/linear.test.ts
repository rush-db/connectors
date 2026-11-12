import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { linear } from '../../src/connectors/linear'
import { parseConnectorSpec, parseWebhook, verifyWebhook, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const apiKey = (): ConnectionContext => ({ config: {}, credentials: { type: 'bearer', token: 'lin_api_test' } })

const issue = (id: string, updatedAt: string) => ({
  id,
  identifier: `ENG-${id}`,
  title: `Issue ${id}`,
  priority: 2,
  labelIds: ['label-1'],
  createdAt: '2024-01-01T09:00:00.000Z',
  updatedAt,
  dueDate: '2024-02-01',
  state: { id: 'st-1', name: 'In Progress', type: 'started' },
  team: { id: 'team-1', key: 'ENG' },
  assignee: { id: 'user-1' },
  creator: { id: 'user-2' },
  project: null,
  cycle: { id: 'cycle-1' },
  parent: id === '2' ? { id: '1' } : null
})

const page = (field: string, nodes: unknown[], endCursor: string | null) => ({
  data: { [field]: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } }
})

describe('linear', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(linear.spec).streams)).toEqual([
      'issues',
      'projects',
      'teams',
      'users',
      'cycles',
      'comments'
    ])
  })

  it('tests with the API key as is', async () => {
    const { fetch, runtime } = mockRuntime([
      { method: 'POST', path: '/graphql', body: { data: { viewer: { id: 'me' }, organization: { name: 'Acme' } } } }
    ])
    expect(await runtime.test(linear, apiKey())).toEqual({ account: 'Acme' })
    expect(fetch.calls[0].headers.authorization).toBe('lin_api_test')
  })

  it('backfills issues over two pages', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/graphql',
        respond: ({ body }: any) =>
          body.variables.after === 'c1' ?
            { body: page('issues', [issue('2', '2024-01-03T00:00:00.000Z')], null) }
          : { body: page('issues', [issue('1', '2024-01-02T00:00:00.000Z')], 'c1') }
      }
    ])
    const batches = await readAll(runtime, linear, apiKey(), 'issues')
    expect(fetch.calls).toHaveLength(2)
    expect((fetch.calls[0].body as any).query).not.toContain('filter')
    expect((fetch.calls[1].body as any).variables).toEqual({ first: 100, after: 'c1' })
    const [first, second] = records(batches)
    expect(first.properties).toMatchObject({
      identifier: 'ENG-1',
      title: 'Issue 1',
      state_name: 'In Progress',
      team_key: 'ENG',
      label_ids: ['label-1'],
      due_date: '2024-02-01T00:00:00.000Z',
      external_id: '1'
    })
    expect(first.links.map((link) => [link.type, link.externalIds])).toEqual([
      ['IN_TEAM', ['team-1']],
      ['IN_CYCLE', ['cycle-1']],
      ['ASSIGNED_TO', ['user-1']],
      ['CREATED_BY', ['user-2']]
    ])
    expect(second.links.find((link) => link.type === 'CHILD_OF')?.externalIds).toEqual(['1'])
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-03T00:00:00.000Z')
  })

  it('filters by updatedAt once a cursor exists', async () => {
    const { fetch, runtime } = mockRuntime([
      { method: 'POST', path: '/graphql', body: page('issues', [issue('3', '2024-01-10T00:05:00.000Z')], null) }
    ])
    const batches = await readAll(runtime, linear, apiKey(), 'issues', { cursor: '2024-01-10T00:00:00.000Z' })
    expect((fetch.calls[0].body as any).query).toContain('filter: { updatedAt: { gt: "2024-01-09T23:59:00.000Z" } }')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-10T00:05:00.000Z')
  })

  it('links projects to their teams', async () => {
    const { runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/graphql',
        body: page(
          'projects',
          [{ id: 'p1', name: 'Launch', updatedAt: '2024-01-01T00:00:00.000Z', lead: { id: 'user-1' }, teams: { nodes: [{ id: 'team-1' }] } }],
          null
        )
      }
    ])
    const [project] = records(await readAll(runtime, linear, apiKey(), 'projects'))
    expect(project.properties).not.toHaveProperty('teams_nodes')
    expect(project.links).toEqual([
      { type: 'LED_BY', target: 'users', direction: 'out', externalIds: ['user-1'] },
      { type: 'FOR_TEAM', target: 'teams', direction: 'out', externalIds: ['team-1'] }
    ])
  })

  it('verifies Linear-Signature and routes data change events', () => {
    const spec = parseConnectorSpec(linear.spec)
    const rawBody = JSON.stringify({
      action: 'remove',
      type: 'Issue',
      data: { id: 'i-9', teamId: 'team-1' },
      webhookTimestamp: 1704067200000
    })
    const signature = createHmac('sha256', 'lin-secret').update(rawBody).digest('hex')
    expect(verifyWebhook(spec, { headers: { 'linear-signature': signature }, rawBody, secret: 'lin-secret' })).toBe(true)
    expect(verifyWebhook(spec, { headers: { 'linear-signature': signature }, rawBody: `${rawBody} `, secret: 'lin-secret' })).toBe(
      false
    )
    expect(parseWebhook(spec, JSON.parse(rawBody))).toEqual([
      { id: '1704067200000', type: 'Issue.remove', stream: 'issues', action: 'delete', externalId: 'i-9' }
    ])
    expect(parseWebhook(spec, { action: 'update', type: 'Comment', data: { id: 'c-1' }, webhookTimestamp: 2 })).toEqual([
      { id: '2', type: 'Comment.update', stream: 'comments', action: 'refetch', externalId: 'c-1' }
    ])
  })
})
