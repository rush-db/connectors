import { describe, expect, it } from 'vitest'

import { gong } from '../../src/connectors/gong'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const basic: ConnectionContext = { config: {}, credentials: { type: 'basic', username: 'key', password: 'secret' } }

const call = (id: string, started: string) => ({
  metaData: {
    id,
    url: `https://app.gong.io/call?id=${id}`,
    title: `Discovery ${id}`,
    scheduled: started,
    started,
    duration: 1800,
    primaryUserId: 'u1',
    direction: 'Conference',
    system: 'Zoom',
    scope: 'External'
  },
  parties: [
    { id: 'p1', emailAddress: 'rep@example.com', name: 'Rep', userId: 'u1', affiliation: 'Internal' },
    { id: 'p2', emailAddress: 'buyer@example.com', name: 'Buyer', affiliation: 'External' }
  ],
  content: { brief: 'Talked about pricing.', topics: [{ name: 'Pricing', duration: 300 }] }
})

describe('gong', () => {
  it('parses', () => {
    const spec = parseConnectorSpec(gong.spec)
    expect(Object.keys(spec.streams)).toEqual(['calls', 'users', 'transcripts'])
    expect(spec.streams.transcripts.optional).toBe(true)
    expect(spec.auth.map((auth) => auth.type)).toEqual(['basic', 'oauth2'])
  })

  it('tests with basic auth', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/v2/users', body: { users: [], records: {} } }])
    expect(await runtime.test(gong, basic)).toEqual({})
    expect(fetch.calls[0].headers.authorization).toBe(`Basic ${Buffer.from('key:secret').toString('base64')}`)
  })

  it('uses the per-customer API host of an OAuth connection', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/v2/users', body: { users: [], records: {} } }])
    await runtime.test(gong, {
      config: {},
      credentials: { type: 'oauth2', accessToken: 'at', extra: { api_base_url_for_customer: 'https://us-1234.api.gong.io/' } }
    })
    expect(fetch.calls[0].url).toBe('https://us-1234.api.gong.io/v2/users')
  })

  it('backfills calls over two cursor pages and stores the window end', async () => {
    const before = Date.now()
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/v2/calls/extensive',
        respond: ({ body }: any) =>
          body.cursor === 'c2' ?
            { body: { records: { currentPageSize: 1 }, calls: [call('2', '2024-01-02T10:00:00Z')] } }
          : { body: { records: { cursor: 'c2' }, calls: [call('1', '2024-01-01T10:00:00Z')] } }
      }
    ])
    const batches = await readAll(runtime, gong, basic, 'calls')
    const [first, second] = records(batches)
    expect(first.externalId).toBe('1')
    expect(first.properties).toMatchObject({
      title: 'Discovery 1',
      started: '2024-01-01T10:00:00.000Z',
      duration: 1800,
      content_brief: 'Talked about pricing.',
      external_id: '1'
    })
    expect(JSON.parse(String(first.properties.parties))).toHaveLength(2)
    expect(first.links).toEqual([
      { type: 'HOSTED_BY', target: 'users', direction: 'out', externalIds: ['u1'] },
      { type: 'ATTENDED_BY', target: 'users', direction: 'out', externalIds: ['u1'] }
    ])
    expect(second.externalId).toBe('2')
    const [firstBody, secondBody] = fetch.calls.map((request) => request.body as any)
    expect(firstBody.filter).toEqual({})
    expect(firstBody.contentSelector.exposedFields.parties).toBe(true)
    expect(secondBody.cursor).toBe('c2')
    expect(batches[0].state.cursor).toBeUndefined()
    expect(Date.parse(String(batches.at(-1)!.state.cursor))).toBeGreaterThanOrEqual(before)
  })

  it('reads a window from the cursor less the lookback and treats 404 as no calls', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/v2/calls/extensive',
        status: 404,
        body: { requestId: 'r1', errors: ['No calls found corresponding to the provided filters'] }
      }
    ])
    const batches = await readAll(runtime, gong, basic, 'calls', { cursor: '2024-01-10T00:00:00.000Z' })
    expect((fetch.calls[0].body as any).filter).toEqual({ fromDateTime: '2024-01-08T00:00:00.000Z' })
    expect(records(batches)).toEqual([])
    expect(batches.at(-1)!.state.cursor).not.toBe('2024-01-10T00:00:00.000Z')
  })

  it('still fails on other errors', async () => {
    const { runtime } = mockRuntime([
      { method: 'POST', path: '/v2/calls/extensive', status: 400, body: { errors: ['Bad filter'] } }
    ])
    await expect(readAll(runtime, gong, basic, 'calls')).rejects.toThrow(/400/)
  })

  it('turns transcripts into plain text linked to the call', async () => {
    const { runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/v2/calls/transcript',
        body: {
          records: {},
          callTranscripts: [
            {
              callId: '1',
              transcript: [
                { speakerId: 's1', topic: 'Intro', sentences: [{ start: 0, end: 900, text: 'Hello.' }, { start: 900, end: 1500, text: 'Thanks for joining.' }] },
                { speakerId: 's2', topic: null, sentences: [{ start: 1600, end: 2000, text: 'Happy to.' }] }
              ]
            }
          ]
        }
      }
    ])
    const [transcript] = records(await readAll(runtime, gong, basic, 'transcripts'))
    expect(transcript.properties).toMatchObject({
      text: 's1: Hello. Thanks for joining.\ns2: Happy to.',
      speaker_ids: ['s1', 's2'],
      topics: ['Intro']
    })
    expect(transcript.links).toEqual([{ type: 'TRANSCRIPT_OF', target: 'calls', direction: 'out', externalIds: ['1'] }])
  })

  it('pages users with a query cursor', async () => {
    const { runtime } = mockRuntime([
      { path: '/v2/users', query: { cursor: 'u2' }, body: { records: {}, users: [{ id: 'u2', emailAddress: 'b@example.com', managerId: 'u1' }] } },
      { path: '/v2/users', body: { records: { cursor: 'u2' }, users: [{ id: 'u1', emailAddress: 'a@example.com', created: '2023-01-01T00:00:00Z' }] } }
    ])
    const users = records(await readAll(runtime, gong, basic, 'users'))
    expect(users.map((user) => user.externalId)).toEqual(['u1', 'u2'])
    expect(users[1].links).toEqual([{ type: 'REPORTS_TO', target: 'users', direction: 'out', externalIds: ['u1'] }])
  })
})
