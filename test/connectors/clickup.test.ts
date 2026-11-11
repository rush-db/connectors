import { describe, expect, it } from 'vitest'

import { clickup } from '../../src/connectors/clickup'
import { parseConnectorSpec } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const connection = () => bearer({ teamId: '901' })

const task = (id: string, updated: string) => ({
  id,
  custom_id: null,
  name: `Task ${id}`,
  text_content: 'Plain description',
  description: 'Plain description',
  status: { status: 'in progress', type: 'custom', color: '#000' },
  priority: { id: '2', priority: 'high' },
  date_created: '1704067200000',
  date_updated: updated,
  date_closed: null,
  due_date: '1706745600000',
  creator: { id: 11, username: 'creator' },
  assignees: [{ id: 12, username: 'dev' }],
  tags: [{ name: 'backend' }],
  parent: id === 't2' ? 't1' : null,
  list: { id: 'l1' },
  folder: { id: 'f1' },
  space: { id: 's1' },
  custom_fields: [
    { id: 'cf1', name: 'Estimate', type: 'number', value: 5 },
    { id: 'cf2', name: 'Empty', type: 'text' },
    { id: 'cf3', name: 'Files', type: 'attachment', value: [{ id: 'a' }] }
  ]
})

describe('clickup', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(clickup.spec).streams)).toEqual(['spaces', 'folders', 'lists', 'tasks', 'users'])
  })

  it('tests with the token as is', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/v2/user', body: { user: { id: 11, username: 'dev' } } }])
    expect(await runtime.test(clickup, connection())).toEqual({ account: 'dev' })
    expect(fetch.calls[0].headers.authorization).toBe('test-token')
  })

  it('backfills tasks over two pages', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/api/v2/team/901/task', query: { page: '1' }, body: { tasks: [task('t2', '1704240000000')], last_page: true } },
      {
        path: '/api/v2/team/901/task',
        query: { page: '0' },
        body: { tasks: [task('t1', '1704153600000'), ...Array.from({ length: 99 }, (_, n) => task(`x${n}`, '1704153600000'))] }
      }
    ])
    const batches = await readAll(runtime, clickup, connection(), 'tasks')
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('include_closed')).toBe('true')
    expect(query.get('subtasks')).toBe('true')
    expect(query.has('date_updated_gt')).toBe(false)
    const all = records(batches)
    expect(all).toHaveLength(101)
    const last = all[100]
    expect(last.properties).toMatchObject({
      name: 'Task t2',
      description: 'Plain description',
      status: 'in progress',
      priority: 'high',
      tags: ['backend'],
      date_updated: '2024-01-03T00:00:00.000Z',
      due_date: '2024-02-01T00:00:00.000Z',
      fields_estimate: 5,
      external_id: 't2'
    })
    expect(last.properties).not.toHaveProperty('fields_files')
    expect(last.links.map((link) => [link.type, link.externalIds])).toEqual([
      ['IN_LIST', ['l1']],
      ['CHILD_OF', ['t1']],
      ['ASSIGNED_TO', ['12']],
      ['CREATED_BY', ['11']]
    ])
    expect(batches.at(-1)!.state.cursor).toBe('1704240000000')
  })

  it('sends date_updated_gt in milliseconds once a cursor exists', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/v2/team/901/task', body: { tasks: [] } }])
    await readAll(runtime, clickup, connection(), 'tasks', { cursor: '1704240000000' })
    expect(new URL(fetch.calls[0].url).searchParams.get('date_updated_gt')).toBe(String(1704240000000 - 60_000))
  })

  it('walks spaces for folders and lists', async () => {
    const { runtime } = mockRuntime([
      { path: '/api/v2/team/901/space', body: { spaces: [{ id: 's1', name: 'Product' }] } },
      {
        path: '/api/v2/space/s1/folder',
        body: { folders: [{ id: 'f1', name: 'Roadmap', space: { id: 's1' }, lists: [{ id: 'l2', name: 'Q1' }] }] }
      },
      {
        path: '/api/v2/space/s1/list',
        body: { lists: [{ id: 'l1', name: 'Inbox', folder: { id: 'h1', name: 'hidden', hidden: true }, space: { id: 's1' } }] }
      }
    ])
    const folders = records(await readAll(runtime, clickup, connection(), 'folders'))
    expect(folders.map((folder) => [folder.externalId, folder.properties.name, folder.links[0]?.externalIds])).toEqual([['f1', 'Roadmap', ['s1']]])
    const lists = records(await readAll(runtime, clickup, connection(), 'lists'))
    expect(lists.map((list) => [list.externalId, list.links.map((link) => `${link.type}:${link.externalIds}`)])).toEqual([
      ['l1', ['IN_SPACE:s1']],
      ['l2', ['IN_FOLDER:f1', 'IN_SPACE:s1']]
    ])
  })

  it('reads the members of the configured Workspace only', async () => {
    const { runtime } = mockRuntime([
      {
        path: '/api/v2/team',
        body: {
          teams: [
            { id: '800', members: [{ user: { id: 1, username: 'other' } }] },
            { id: '901', members: [{ user: { id: 12, username: 'dev', email: 'dev@example.com', role: 3 } }] }
          ]
        }
      }
    ])
    const users = records(await readAll(runtime, clickup, connection(), 'users'))
    expect(users).toEqual([
      { externalId: '12', properties: { username: 'dev', email: 'dev@example.com', role: 3, external_id: '12' }, links: [] }
    ])
  })
})
