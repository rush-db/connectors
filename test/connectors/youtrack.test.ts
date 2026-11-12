import { describe, expect, it } from 'vitest'

import { youtrack } from '../../src/connectors/youtrack'
import { parseConnectorSpec } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const connection = () => bearer({ url: 'https://acme.youtrack.cloud' })

const issue = (id: string, updated: number) => ({
  $type: 'Issue',
  id,
  idReadable: `ENG-${id}`,
  summary: `Issue ${id}`,
  created: 1704067200000,
  updated,
  resolved: null,
  project: { $type: 'Project', id: '0-1', shortName: 'ENG' },
  reporter: { $type: 'User', id: '1-1', login: 'reporter' },
  tags: [{ $type: 'Tag', name: 'backend' }],
  customFields: [
    { $type: 'SingleEnumIssueCustomField', name: 'Priority', value: { $type: 'EnumBundleElement', name: 'Major' } },
    { $type: 'SingleUserIssueCustomField', name: 'Assignee', value: { $type: 'User', id: '1-2', login: 'dev' } },
    { $type: 'DateIssueCustomField', name: 'Due Date', value: 1706745600000 },
    { $type: 'MultiVersionIssueCustomField', name: 'Fix versions', value: [{ name: '1.0' }, { name: '1.1' }] },
    { $type: 'PeriodIssueCustomField', name: 'Estimation', value: { $type: 'PeriodValue', minutes: 120, presentation: '2h' } },
    { $type: 'SimpleIssueCustomField', name: 'Story points', value: 3 }
  ]
})

describe('youtrack', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(youtrack.spec).streams)).toEqual(['issues', 'projects', 'users'])
  })

  it('tests against the instance URL', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/users/me', body: { id: '1-1', login: 'dev' } }])
    expect(await runtime.test(youtrack, connection())).toEqual({ account: 'dev' })
    expect(fetch.calls[0].url).toBe('https://acme.youtrack.cloud/api/users/me?fields=id%2Clogin')
    expect(fetch.calls[0].headers.authorization).toBe('Bearer test-token')
  })

  it('backfills issues over two pages with custom fields flattened', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/api/issues', query: { $skip: '100' }, body: [issue('2', 1704240000000)] },
      { path: '/api/issues', body: Array.from({ length: 100 }, (_, n) => issue(String(1000 + n), 1704153600000)) }
    ])
    const batches = await readAll(runtime, youtrack, connection(), 'issues')
    const first = new URL(fetch.calls[0].url).searchParams
    expect(first.get('query')).toBe('sort by: updated asc')
    expect(first.get('$top')).toBe('100')
    expect(first.get('fields')).toContain('customFields(')
    const all = records(batches)
    expect(all).toHaveLength(101)
    expect(all[100].properties).toMatchObject({
      id_readable: 'ENG-2',
      summary: 'Issue 2',
      created: '2024-01-01T00:00:00.000Z',
      updated: '2024-01-03T00:00:00.000Z',
      tags: ['backend'],
      fields_priority: 'Major',
      fields_assignee: 'dev',
      fields_due_date: '2024-02-01T00:00:00.000Z',
      fields_fix_versions: ['1.0', '1.1'],
      fields_estimation: '2h',
      fields_story_points: 3,
      external_id: '2'
    })
    expect(all[100].links.map((link) => [link.type, link.externalIds])).toEqual([
      ['IN_PROJECT', ['0-1']],
      ['REPORTED_BY', ['1-1']],
      ['ASSIGNED_TO', ['1-2']]
    ])
    expect(batches.at(-1)!.state.cursor).toBe(1704240000000)
  })

  it('filters by update date with a day of lookback', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/issues', body: [] }])
    await readAll(runtime, youtrack, connection(), 'issues', { cursor: Date.parse('2024-01-10T06:00:00Z') })
    expect(new URL(fetch.calls[0].url).searchParams.get('query')).toBe('updated: 2024-01-09 .. * sort by: updated asc')
  })

  it('reads projects without $type noise', async () => {
    const { runtime } = mockRuntime([
      { path: '/api/admin/projects', body: [{ $type: 'Project', id: '0-1', name: 'Engineering', shortName: 'ENG', archived: false, leader: { $type: 'User', id: '1-1' } }] }
    ])
    const [project] = records(await readAll(runtime, youtrack, connection(), 'projects'))
    expect(project.properties).toEqual({ name: 'Engineering', short_name: 'ENG', archived: false, external_id: '0-1' })
    expect(project.links).toEqual([{ type: 'LED_BY', target: 'users', direction: 'out', externalIds: ['1-1'] }])
  })
})
