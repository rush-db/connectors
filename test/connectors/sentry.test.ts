import { describe, expect, it } from 'vitest'

import { parseSentryLinks, sentry } from '../../src/connectors/sentry'
import { parseConnectorSpec } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const connection = () => bearer({ host: 'de.sentry.io', organization: 'acme' })

const link = (cursor: string, more: boolean) =>
  `<https://de.sentry.io/api/0/organizations/acme/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ` +
  `<https://de.sentry.io/api/0/organizations/acme/issues/?cursor=${cursor}>; rel="next"; results="${more}"; cursor="${cursor}"`

const issue = (id: string, lastSeen: string) => ({
  id,
  shortId: `BACKEND-${id}`,
  title: 'TypeError: x is undefined',
  culprit: 'app/handler',
  level: 'error',
  status: 'unresolved',
  count: '42',
  userCount: 3,
  firstSeen: '2024-01-01T00:00:00.000000Z',
  lastSeen,
  project: { id: '7', slug: 'backend', name: 'Backend' },
  assignedTo: { type: 'user', id: '99', name: 'Dev' },
  stats: { '24h': [[1704067200, 1]] }
})

describe('sentry', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(sentry.spec).streams)).toEqual(['projects', 'issues', 'releases'])
  })

  it('tests against the region host', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/0/organizations/acme/', body: { slug: 'acme', name: 'Acme' } }])
    expect(await runtime.test(sentry, connection())).toEqual({ account: 'Acme' })
    expect(fetch.calls[0].url).toBe('https://de.sentry.io/api/0/organizations/acme/')
  })

  it('backfills issues over two pages and stops on results="false"', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/api/0/organizations/acme/issues/',
        query: { cursor: '0:100:0' },
        headers: { link: link('0:200:0', false) },
        body: [issue('2', '2024-01-02T00:00:00Z')]
      },
      {
        path: '/api/0/organizations/acme/issues/',
        headers: { link: link('0:100:0', true) },
        body: [issue('1', '2024-01-03T00:00:00Z')]
      }
    ])
    const batches = await readAll(runtime, sentry, connection(), 'issues')
    expect(fetch.calls).toHaveLength(2)
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('query')).toBe('')
    expect(query.get('statsPeriod')).toBe('90d')
    expect(query.get('sort')).toBe('date')
    const [first] = records(batches)
    expect(first.properties).toMatchObject({
      short_id: 'BACKEND-1',
      level: 'error',
      count: 42,
      user_count: 3,
      last_seen: '2024-01-03T00:00:00.000Z',
      assigned_to_id: '99',
      external_id: '1'
    })
    expect(first.properties).not.toHaveProperty('stats_24h')
    expect(first.properties).not.toHaveProperty('project_slug')
    expect(first.links).toEqual([{ type: 'IN_PROJECT', target: 'projects', direction: 'out', externalIds: ['7'] }])
    expect(batches[0].state.cursor).toBeUndefined()
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-03T00:00:00Z')
  })

  it('filters by lastSeen once a cursor exists', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/api/0/organizations/acme/issues/', headers: { link: link('0:100:0', false) }, body: [issue('3', '2024-01-10T00:10:00Z')] }
    ])
    const batches = await readAll(runtime, sentry, connection(), 'issues', { cursor: '2024-01-10T00:00:00Z' })
    expect(new URL(fetch.calls[0].url).searchParams.get('query')).toBe('lastSeen:>=2024-01-09T23:58:00.000Z')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-10T00:10:00Z')
  })

  it('reads projects and releases', async () => {
    const { runtime } = mockRuntime([
      {
        path: '/api/0/organizations/acme/projects/',
        body: [{ id: '7', slug: 'backend', name: 'Backend', platform: 'python', dateCreated: '2023-01-01T00:00:00Z', avatar: { avatarType: 'letter' } }]
      },
      {
        path: '/api/0/organizations/acme/releases/',
        body: [{ id: 5, version: 'backend@1.2.0', shortVersion: '1.2.0', dateCreated: '2024-01-05T00:00:00Z', projects: [{ id: 7, slug: 'backend' }], authors: [] }]
      }
    ])
    const [project] = records(await readAll(runtime, sentry, connection(), 'projects'))
    expect(project.properties).toEqual({
      slug: 'backend',
      name: 'Backend',
      platform: 'python',
      date_created: '2023-01-01T00:00:00.000Z',
      external_id: '7'
    })
    const [release] = records(await readAll(runtime, sentry, connection(), 'releases'))
    expect(release.externalId).toBe('backend@1.2.0')
    expect(release.links).toEqual([{ type: 'FOR_PROJECT', target: 'projects', direction: 'out', externalIds: ['7'] }])
  })

  it('refuses a next page on another origin', async () => {
    const { runtime } = mockRuntime([
      {
        path: '/api/0/organizations/acme/projects/',
        headers: { link: '<https://evil.example.com/api/0/x?cursor=1>; rel="next"; results="true"; cursor="1"' },
        body: [{ id: '7' }]
      }
    ])
    await expect(readAll(runtime, sentry, connection(), 'projects')).rejects.toThrow('another origin')
  })

  it('parses Link entries', () => {
    expect(parseSentryLinks(link('0:100:0', true))[1]).toEqual({
      url: 'https://de.sentry.io/api/0/organizations/acme/issues/?cursor=0:100:0',
      rel: 'next',
      results: 'true'
    })
  })
})
