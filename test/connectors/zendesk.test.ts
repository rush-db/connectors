import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { zendesk } from '../../src/connectors'
import { parseConnectorSpec, parseWebhook, verifyWebhook, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const BASE = 'https://acme.zendesk.com'
const connection = (): ConnectionContext => ({
  config: { subdomain: 'acme' },
  credentials: { type: 'basic', username: 'agent@example.com/token', password: 'zd-token' }
})
const ticket = (id: number, updated: string, status = 'open') => ({
  id,
  url: `${BASE}/api/v2/tickets/${id}.json`,
  subject: `Ticket ${id}`,
  status,
  requester_id: 11,
  assignee_id: 22,
  organization_id: 33,
  group_id: 44,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: updated,
  via: { channel: 'email' }
})

describe('zendesk', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(zendesk.spec).streams)).toEqual(['tickets', 'users', 'organizations', 'groups'])
  })

  it('tests with email/token basic auth', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/v2/users/me', body: { user: { email: 'agent@example.com' } } }])
    expect(await runtime.test(zendesk, connection())).toEqual({ account: 'agent@example.com' })
    expect(fetch.calls[0].url.startsWith(BASE)).toBe(true)
    expect(fetch.calls[0].headers.authorization).toBe(`Basic ${Buffer.from('agent@example.com/token:zd-token').toString('base64')}`)
  })

  it('backfills tickets through the cursor export until end_of_stream', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/api/v2/incremental/tickets/cursor.json',
        query: { cursor: 'c2' },
        body: { tickets: [ticket(2, '2024-01-03T00:00:00Z', 'deleted')], after_url: `${BASE}/api/v2/incremental/tickets/cursor.json?cursor=c3`, end_of_stream: true }
      },
      {
        path: '/api/v2/incremental/tickets/cursor.json',
        body: { tickets: [ticket(1, '2024-01-02T00:00:00Z')], after_url: `${BASE}/api/v2/incremental/tickets/cursor.json?cursor=c2`, end_of_stream: false }
      }
    ])
    const batches = await readAll(runtime, zendesk, connection(), 'tickets')
    expect(fetch.calls).toHaveLength(2)
    expect(new URL(fetch.calls[0].url).searchParams.get('start_time')).toBe('0')
    expect(new URL(fetch.calls[1].url).searchParams.has('start_time')).toBe(false)
    const [first, second] = records(batches)
    expect(first.properties).toMatchObject({ subject: 'Ticket 1', status: 'open', updated_at: '2024-01-02T00:00:00.000Z' })
    expect(first.properties).not.toHaveProperty('via_channel')
    expect(first.links.map((link) => [link.type, link.target, link.externalIds[0]])).toEqual([
      ['REQUESTED_BY', 'users', '11'],
      ['ASSIGNED_TO', 'users', '22'],
      ['FOR_ORGANIZATION', 'organizations', '33'],
      ['ASSIGNED_TO_GROUP', 'groups', '44']
    ])
    expect(second.deleted).toBe(true)
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-03T00:00:00Z')
  })

  it('starts an incremental run from the cursor as unix time', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/api/v2/incremental/organizations.json', body: { organizations: [], next_page: null, end_of_stream: true } }
    ])
    await readAll(runtime, zendesk, connection(), 'organizations', { cursor: '2024-01-10T00:00:00Z' })
    expect(new URL(fetch.calls[0].url).searchParams.get('start_time')).toBe(String(Date.parse('2024-01-10T00:00:00Z') / 1000 - 120))
  })

  it('verifies timestamp + body signatures and routes Zendesk events', () => {
    const spec = parseConnectorSpec(zendesk.spec)
    const rawBody = JSON.stringify({
      type: 'zen:event-type:user.deleted',
      id: 'e-1',
      account_id: 1,
      subject: 'zen:user:55',
      detail: { id: '55' },
      event: {}
    })
    const timestamp = '2024-01-01T00:00:00Z'
    const signature = createHmac('sha256', 'zd-secret').update(timestamp + rawBody).digest('base64')
    const headers = { 'x-zendesk-webhook-signature': signature, 'x-zendesk-webhook-signature-timestamp': timestamp }
    expect(verifyWebhook(spec, { headers, rawBody, secret: 'zd-secret' })).toBe(true)
    expect(parseWebhook(spec, JSON.parse(rawBody))).toEqual([
      { id: 'e-1', type: 'zen:event-type:user.deleted', stream: 'users', action: 'delete', externalId: '55' }
    ])
    expect(parseWebhook(spec, { type: 'zen:event-type:ticket.status_changed', id: 'e-2', detail: { id: '9' } })[0]).toMatchObject({
      stream: 'tickets',
      action: 'refetch',
      externalId: '9'
    })
  })
})
