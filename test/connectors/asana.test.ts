import { describe, expect, it } from 'vitest'

import { asana } from '../../src/connectors/asana'
import { parseConnectorSpec } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const connection = () => bearer({ workspaceId: '100' })

const task = (gid: string, modified: string) => ({
  gid,
  resource_type: 'task',
  name: `Task ${gid}`,
  notes: 'Details',
  completed: false,
  created_at: '2024-01-01T00:00:00.000Z',
  modified_at: modified,
  due_on: '2024-02-01',
  assignee: { gid: 'u1', resource_type: 'user' },
  parent: gid === 't2' ? { gid: 't1', resource_type: 'task' } : null,
  projects: [{ gid: 'p1', resource_type: 'project' }],
  memberships: [{ section: { gid: 's1', resource_type: 'section' } }],
  tags: [{ gid: 'g1', name: 'urgent' }],
  custom_fields: [{ gid: 'cf1', name: 'Effort', display_value: 'High' }]
})

const projects = { path: '/api/1.0/projects', body: { data: [{ gid: 'p1' }], next_page: null } }

describe('asana', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(asana.spec).streams)).toEqual(['workspaces', 'projects', 'tasks', 'users', 'sections'])
  })

  it('tests the token', async () => {
    const { runtime } = mockRuntime([{ path: '/api/1.0/users/me', body: { data: { gid: 'u1', name: 'Test User' } } }])
    expect(await runtime.test(asana, connection())).toEqual({ account: 'Test User' })
  })

  it('backfills tasks per project over two pages', async () => {
    const { fetch, runtime } = mockRuntime([
      projects,
      { path: '/api/1.0/tasks', query: { offset: 'o2' }, body: { data: [task('t2', '2024-01-03T00:00:00.000Z')], next_page: null } },
      { path: '/api/1.0/tasks', body: { data: [task('t1', '2024-01-02T00:00:00.000Z')], next_page: { offset: 'o2' } } }
    ])
    const batches = await readAll(runtime, asana, connection(), 'tasks')
    const query = new URL(fetch.calls[1].url).searchParams
    expect(query.get('project')).toBe('p1')
    expect(query.get('opt_fields')).toContain('custom_fields.display_value')
    expect(query.has('modified_since')).toBe(false)
    const [first, second] = records(batches)
    expect(first.properties).toMatchObject({
      name: 'Task t1',
      notes: 'Details',
      tags: ['urgent'],
      fields_effort: 'High',
      modified_at: '2024-01-02T00:00:00.000Z',
      external_id: 't1'
    })
    expect(first.properties).not.toHaveProperty('gid')
    expect(first.links.map((link) => [link.type, link.externalIds])).toEqual([
      ['IN_PROJECT', ['p1']],
      ['IN_SECTION', ['s1']],
      ['ASSIGNED_TO', ['u1']]
    ])
    expect(second.links.at(-1)).toEqual({ type: 'CHILD_OF', target: 'tasks', direction: 'out', externalIds: ['t1'] })
    expect(batches[0].state.cursor).toBeUndefined()
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-03T00:00:00.000Z')
  })

  it('reads changed tasks with modified_since', async () => {
    const { fetch, runtime } = mockRuntime([
      projects,
      { path: '/api/1.0/tasks', body: { data: [task('t3', '2024-01-10T00:05:00.000Z')], next_page: null } }
    ])
    const batches = await readAll(runtime, asana, connection(), 'tasks', { cursor: '2024-01-10T00:00:00.000Z' })
    expect(new URL(fetch.calls[1].url).searchParams.get('modified_since')).toBe('2024-01-09T23:59:00.000Z')
    expect(batches[0].state.cursor).toBe('2024-01-10T00:00:00.000Z')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-10T00:05:00.000Z')
  })

  it('reads projects with offset tokens and sections per project', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/api/1.0/projects',
        body: {
          data: [{ gid: 'p1', resource_type: 'project', name: 'Launch', archived: false, owner: { gid: 'u1' }, workspace: { gid: '100' }, team: { gid: 'tm', name: 'Product', resource_type: 'team' } }],
          next_page: null
        }
      },
      { path: '/api/1.0/projects/p1/sections', body: { data: [{ gid: 's1', name: 'Doing', project: { gid: 'p1' } }], next_page: null } }
    ])
    const [project] = records(await readAll(runtime, asana, connection(), 'projects'))
    expect(new URL(fetch.calls[0].url).searchParams.get('workspace')).toBe('100')
    expect(project.properties).toEqual({ name: 'Launch', archived: false, team_gid: 'tm', team_name: 'Product', external_id: 'p1' })
    expect(project.links.map((link) => link.type)).toEqual(['OWNED_BY', 'IN_WORKSPACE'])
    const [section] = records(await readAll(runtime, asana, connection(), 'sections'))
    expect(section).toEqual({
      externalId: 's1',
      properties: { name: 'Doing', external_id: 's1' },
      links: [{ type: 'IN_PROJECT', target: 'projects', direction: 'out', externalIds: ['p1'] }]
    })
  })
})
