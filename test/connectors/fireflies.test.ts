import { describe, expect, it } from 'vitest'

import { fireflies } from '../../src/connectors/fireflies'
import { parseConnectorSpec } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const transcript = (id: string, date: number) => ({
  id,
  title: `Weekly sync ${id}`,
  date,
  duration: 32.5,
  host_email: 'host@example.com',
  organizer_email: 'host@example.com',
  participants: ['host@example.com', 'guest@example.com'],
  meeting_attendees: [{ displayName: 'Guest', email: 'guest@example.com', name: 'Guest' }],
  transcript_url: `https://app.fireflies.ai/view/${id}`,
  user: { user_id: 'user-1' },
  summary: { keywords: ['roadmap', 'pricing'], action_items: 'Send the proposal', overview: 'Discussed the roadmap.' }
})

describe('fireflies', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(fireflies.spec).streams)).toEqual(['transcripts', 'users'])
  })

  it('tests with a GraphQL query', async () => {
    const { fetch, runtime } = mockRuntime([
      { method: 'POST', path: '/graphql', body: { data: { user: { user_id: 'user-1', email: 'host@example.com', name: 'Host' } } } }
    ])
    expect(await runtime.test(fireflies, bearer())).toEqual({ account: 'host@example.com' })
    expect((fetch.calls[0].body as any).query).toContain('user')
  })

  it('backfills transcripts with skip/limit in the variables', async () => {
    const page = Array.from({ length: 50 }, (_, index) => transcript(`t${index}`, 1704067200000 + index * 1000))
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/graphql',
        respond: ({ body }: any) => ({
          body: { data: { transcripts: body.variables.skip === 0 ? page : [transcript('t50', 1704153600000)] } }
        })
      }
    ])
    const batches = await readAll(runtime, fireflies, bearer(), 'transcripts')
    const all = records(batches)
    expect(all).toHaveLength(51)
    expect(all[0].properties).toMatchObject({
      title: 'Weekly sync t0',
      date: '2024-01-01T00:00:00.000Z',
      participants: ['host@example.com', 'guest@example.com'],
      summary_keywords: ['roadmap', 'pricing'],
      summary_action_items: 'Send the proposal',
      external_id: 't0'
    })
    expect(typeof all[0].properties.meeting_attendees).toBe('string')
    expect(all[0].properties).not.toHaveProperty('user_user_id')
    expect(all[0].links).toEqual([{ type: 'RECORDED_BY', target: 'users', direction: 'out', externalIds: ['user-1'] }])
    const bodies = fetch.calls.map((call) => call.body as any)
    expect(bodies[0].variables).toEqual({ skip: 0, limit: 50 })
    expect(bodies[1].variables).toEqual({ skip: 50, limit: 50 })
    expect(bodies[0].query).toContain('transcripts(limit: $limit, skip: $skip, fromDate: $fromDate)')
    expect(batches.at(-1)!.state.cursor).toBe(1704153600000)
  })

  it('sends fromDate from the cursor less a day', async () => {
    const { fetch, runtime } = mockRuntime([
      { method: 'POST', path: '/graphql', body: { data: { transcripts: [transcript('t9', 1706745600000)] } } }
    ])
    const batches = await readAll(runtime, fireflies, bearer(), 'transcripts', { cursor: 1704153600000 })
    expect((fetch.calls[0].body as any).variables).toEqual({ fromDate: '2024-01-01T00:00:00.000Z', skip: 0, limit: 50 })
    expect(batches.at(-1)!.state.cursor).toBe(1706745600000)
  })

  it('reads users', async () => {
    const { runtime } = mockRuntime([
      { method: 'POST', path: '/graphql', body: { data: { users: [{ user_id: 'user-1', email: 'host@example.com', is_admin: true }] } } }
    ])
    const [user] = records(await readAll(runtime, fireflies, bearer(), 'users'))
    expect(user).toMatchObject({ externalId: 'user-1', properties: { email: 'host@example.com', is_admin: true } })
  })
})
