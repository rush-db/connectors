import { describe, expect, it } from 'vitest'

import { confluence, storageToText } from '../../src/connectors/confluence'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const basic = (): ConnectionContext => ({
  config: { site: 'acme.atlassian.net' },
  credentials: { type: 'basic', username: 'dev@example.com', password: 'api-token' }
})

const page = (id: string, modified: string, parentId?: string) => ({
  id,
  status: 'current',
  title: `Page ${id}`,
  spaceId: '10',
  parentId: parentId ?? null,
  parentType: parentId ? 'page' : null,
  authorId: 'acc-1',
  createdAt: '2024-01-01T00:00:00.000Z',
  version: { number: 3, createdAt: modified, authorId: 'acc-2', message: '' },
  body: {
    storage: {
      representation: 'storage',
      value: '<h1>Title</h1><p>Hello&nbsp;<strong>world</strong> &amp; more</p><ul><li><p>One</p></li><li>Two</li></ul>'
    }
  },
  _links: { webui: `/spaces/ENG/pages/${id}` }
})

describe('confluence', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(confluence.spec).streams)).toEqual(['spaces', 'pages', 'blogposts'])
  })

  it('tests against the site, or the API gateway with OAuth', async () => {
    const { fetch, runtime } = mockRuntime([{ path: /\/wiki\/api\/v2\/spaces$/, body: { results: [] } }])
    await runtime.test(confluence, basic())
    await runtime.test(confluence, {
      config: { site: 'acme.atlassian.net', cloudId: 'cloud-1' },
      credentials: { type: 'oauth2', accessToken: 't' }
    })
    expect(fetch.calls[0].url).toBe('https://acme.atlassian.net/wiki/api/v2/spaces?limit=1')
    expect(fetch.calls[1].url).toBe('https://api.atlassian.com/ex/confluence/cloud-1/wiki/api/v2/spaces?limit=1')
  })

  it('backfills pages over two pages with plain-text bodies', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/wiki/api/v2/pages',
        query: { cursor: 'abc' },
        body: { results: [page('2', '2024-01-03T00:00:00.000Z', '1')], _links: {} }
      },
      {
        path: '/wiki/api/v2/pages',
        body: { results: [page('1', '2024-01-02T00:00:00.000Z')], _links: { next: '/wiki/api/v2/pages?cursor=abc&limit=250' } }
      }
    ])
    const batches = await readAll(runtime, confluence, basic(), 'pages')
    expect(new URL(fetch.calls[0].url).searchParams.get('body-format')).toBe('storage')
    expect(fetch.calls[1].url).toBe('https://acme.atlassian.net/wiki/api/v2/pages?cursor=abc&limit=250')
    const [first, second] = records(batches)
    expect(first.properties).toMatchObject({
      title: 'Page 1',
      space_id: '10',
      version: 3,
      body: 'Title\nHello world & more\n- One\n- Two',
      updated_at: '2024-01-02T00:00:00.000Z',
      external_id: '1'
    })
    expect(first.properties).not.toHaveProperty('version_message', '')
    expect(first.links).toEqual([{ type: 'IN_SPACE', target: 'spaces', direction: 'out', externalIds: ['10'] }])
    expect(second.links).toContainEqual({ type: 'CHILD_OF', target: 'pages', direction: 'out', externalIds: ['1'] })
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-03T00:00:00.000Z')
  })

  it('reads newest-modified first and stops at the cursor', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/wiki/api/v2/blogposts',
        query: { cursor: 'p2' },
        body: { results: [page('8', '2024-01-10T00:10:00.000Z'), page('7', '2024-01-01T00:00:00.000Z')], _links: { next: '/wiki/api/v2/blogposts?cursor=p3' } }
      },
      {
        path: '/wiki/api/v2/blogposts',
        body: { results: [page('9', '2024-01-12T00:00:00.000Z')], _links: { next: '/wiki/api/v2/blogposts?cursor=p2' } }
      }
    ])
    const batches = await readAll(runtime, confluence, basic(), 'blogposts', { cursor: '2024-01-10T00:00:00.000Z' })
    expect(new URL(fetch.calls[0].url).searchParams.get('sort')).toBe('-modified-date')
    expect(fetch.calls).toHaveLength(2)
    expect(records(batches).map((record) => record.externalId)).toEqual(['9', '8'])
    expect(batches[0].state.cursor).toBe('2024-01-10T00:00:00.000Z')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-12T00:00:00.000Z')
  })

  it('reads spaces with a plain description', async () => {
    const { runtime } = mockRuntime([
      {
        path: '/wiki/api/v2/spaces',
        body: {
          results: [{ id: '10', key: 'ENG', name: 'Engineering', homepageId: '1', description: { plain: { value: 'Docs', representation: 'plain' } }, _links: { webui: '/spaces/ENG' } }]
        }
      }
    ])
    const [space] = records(await readAll(runtime, confluence, basic(), 'spaces'))
    expect(space.properties).toEqual({ key: 'ENG', name: 'Engineering', homepage_id: '1', description: 'Docs', external_id: '10' })
    expect(space.links[0]).toMatchObject({ type: 'HOME_PAGE', externalIds: ['1'] })
  })

  it('keeps code macro text', () => {
    expect(
      storageToText('<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[if (a < b) {}]]></ac:plain-text-body></ac:structured-macro><table><tr><td>A</td><td>B</td></tr></table>')
    ).toBe('if (a < b) {}\nA\tB')
  })
})
