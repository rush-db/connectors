import { describe, expect, it } from 'vitest'

import { loopio } from '../../src/connectors/loopio'
import { authorizeUrl, parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const connection = (host = 'api.loopio.com'): ConnectionContext => ({
  config: { host },
  credentials: { type: 'oauth2', accessToken: 'at' }
})

const entry = (id: number, updated: string) => ({
  id,
  questions: [{ id: id * 10, text: 'What is the product?', complianceOption: { id: 1, text: 'Yes' } }],
  answer: { text: 'A graph database.', footnotes: [{ id: 1, name: 'See docs' }] },
  languageCode: 'en',
  creator: { id: 1, name: 'Writer' },
  libraryEntryOwner: { id: 2, name: 'Owner' },
  createdDate: '2023-05-23T15:32:00Z',
  lastUpdatedDate: updated,
  status: 'APPROVED',
  tags: ['security', 'soc2'],
  scores: { time: 10, usage: 8, freshness: 9 },
  InlineImages: { items: [{ id: 1, url: 'https://files.example.com/image?sig=x' }] },
  location: { stack: { id: 1, name: 'Sales' }, category: { id: 5, name: 'Security' } }
})

describe('loopio', () => {
  it('parses and authorizes against the chosen data center', () => {
    const spec = parseConnectorSpec(loopio.spec)
    expect(Object.keys(spec.streams)).toEqual(['library_entries', 'projects', 'users'])
    const url = new URL(
      authorizeUrl(spec, { clientId: 'c', redirectUri: 'https://app.example.com/cb', state: 's', codeChallenge: 'x', config: { host: 'api.eu.loopio.com' } })
    )
    expect(url.origin).toBe('https://api.eu.loopio.com')
    expect(url.searchParams.get('scope')).toBe('library:read project:read user:read')
  })

  it('tests the connection', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/data/v2/identify/me', body: { id: 1, customerName: 'Example Co' } }])
    expect(await runtime.test(loopio, connection('api.eu.loopio.com'))).toEqual({ account: 'Example Co' })
    expect(fetch.calls[0].url).toBe('https://api.eu.loopio.com/data/v2/identify/me')
  })

  it('backfills library entries over two pages in every language', async () => {
    const page = Array.from({ length: 200 }, (_, index) => entry(index + 1, '2024-01-01T00:00:00Z'))
    const { fetch, runtime } = mockRuntime([
      { path: '/data/v2/libraryEntries', query: { page: '2' }, body: { totalItems: 201, totalPages: 2, items: [entry(201, '2024-02-01T00:00:00Z')] } },
      { path: '/data/v2/libraryEntries', query: { page: '1' }, body: { totalItems: 201, totalPages: 2, items: page } }
    ])
    const batches = await readAll(runtime, loopio, connection(), 'library_entries')
    const all = records(batches)
    expect(all).toHaveLength(201)
    expect(all[0].properties).toMatchObject({
      answer_text: 'A graph database.',
      tags: ['security', 'soc2'],
      status: 'APPROVED',
      location_stack_name: 'Sales',
      location_category_id: 5,
      last_updated_date: '2024-01-01T00:00:00.000Z',
      external_id: '1'
    })
    expect(JSON.parse(String(all[0].properties.questions))[0].text).toBe('What is the product?')
    expect(Object.keys(all[0].properties).some((key) => key.startsWith('inline_images'))).toBe(false)
    expect(all[0].links).toEqual([
      { type: 'CREATED_BY', target: 'users', direction: 'out', externalIds: ['1'] },
      { type: 'OWNED_BY', target: 'users', direction: 'out', externalIds: ['2'] }
    ])
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('pageSize')).toBe('200')
    expect(JSON.parse(query.get('filter')!)).toEqual({ language: '' })
    expect(batches.at(-1)!.state.cursor).toBe('2024-02-01T00:00:00Z')
  })

  it('filters library entries by lastUpdatedDate once a cursor exists', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/data/v2/libraryEntries', body: { totalItems: 1, totalPages: 1, items: [entry(7, '2024-03-01T00:00:00Z')] } }
    ])
    const batches = await readAll(runtime, loopio, connection(), 'library_entries', { cursor: '2024-02-01T00:00:00Z' })
    const filter = JSON.parse(new URL(fetch.calls[0].url).searchParams.get('filter')!)
    expect(filter).toEqual({ language: '', lastUpdatedDate: { gte: '2024-01-31T23:59:00.000Z' } })
    expect(batches.at(-1)!.state.cursor).toBe('2024-03-01T00:00:00Z')
  })

  it('reads projects with owners', async () => {
    const { runtime } = mockRuntime([
      {
        path: '/data/v2/projects',
        body: {
          totalItems: 1,
          totalPages: 1,
          items: [{ id: 3, name: 'Example RFP', projectType: 'RFP', status: 'ACTIVE', dueDate: '2024-06-01T23:59:59Z', owner: { id: 2, name: 'Owner' }, creator: { id: 1, name: 'Writer' } }]
        }
      }
    ])
    const [project] = records(await readAll(runtime, loopio, connection(), 'projects'))
    expect(project.properties).toMatchObject({ project_type: 'RFP', due_date: '2024-06-01T23:59:59.000Z' })
    expect(project.links.map((link) => link.type)).toEqual(['OWNED_BY', 'CREATED_BY'])
  })
})
