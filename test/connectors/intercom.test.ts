import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { intercom } from '../../src/connectors'
import { parseConnectorSpec, parseWebhook, verifyWebhook } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const contact = (id: string, updated: number) => ({
  type: 'contact',
  id,
  external_id: `user-${id}`,
  role: 'user',
  email: `c${id}@example.com`,
  name: `Contact ${id}`,
  owner_id: 7,
  created_at: 1704067200,
  updated_at: updated,
  custom_attributes: { plan: 'pro' },
  tags: { type: 'list', data: [{ type: 'tag', id: 't1' }], url: '/contacts/x/tags' },
  companies: { type: 'list', data: [{ type: 'company', id: 'co1' }], url: '/contacts/x/companies' }
})

describe('intercom', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(intercom.spec).streams)).toEqual(['contacts', 'companies', 'conversations', 'admins', 'tags'])
  })

  it('tests and pins the API version', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/me', body: { app: { name: 'Acme' } } }])
    expect(await runtime.test(intercom, bearer())).toEqual({ account: 'Acme' })
    expect(fetch.calls[0].headers['intercom-version']).toBe('2.11')
  })

  it('backfills contacts with starting_after', async () => {
    const { runtime } = mockRuntime([
      { path: '/contacts', query: { starting_after: 'abc' }, body: { data: [contact('2', 1704153600)], pages: {} } },
      { path: '/contacts', body: { data: [contact('1', 1704067300)], pages: { next: { starting_after: 'abc' } } } }
    ])
    const batches = await readAll(runtime, intercom, bearer(), 'contacts')
    const [first] = records(batches)
    expect(records(batches)).toHaveLength(2)
    expect(first.externalId).toBe('1')
    expect(first.properties).toMatchObject({
      user_external_id: 'user-1',
      external_id: '1',
      custom_attributes_plan: 'pro',
      updated_at: '2024-01-01T00:01:40.000Z'
    })
    expect(Object.keys(first.properties).some((key) => key.startsWith('tags_') || key.startsWith('companies_'))).toBe(false)
    expect(first.links.map((link) => link.type)).toEqual(['WORKS_AT', 'OWNED_BY', 'TAGGED'])
    expect(batches.at(-1)!.state.cursor).toBe(1704153600)
  })

  it('searches by updated_at once a cursor exists, paging in the body', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/contacts/search',
        respond: ({ body }: any) =>
          body.pagination.starting_after ?
            { body: { data: [contact('4', 1704240000)], pages: {} } }
          : { body: { data: [contact('3', 1704200000)], pages: { next: { starting_after: 's2' } } } }
      }
    ])
    const batches = await readAll(runtime, intercom, bearer(), 'contacts', { cursor: 1704153600 })
    expect(fetch.calls[0].body).toMatchObject({
      query: { field: 'updated_at', operator: '>', value: 1704153540 },
      pagination: { per_page: 150 }
    })
    expect(fetch.calls[1].body).toMatchObject({ pagination: { per_page: 150, starting_after: 's2' } })
    expect(batches.at(-1)!.state.cursor).toBe(1704240000)
  })

  it('verifies HMAC-SHA1 signatures and routes topics', () => {
    const spec = parseConnectorSpec(intercom.spec)
    const notification = (topic: string, item: unknown) => ({ type: 'notification_event', id: `notif_${topic}`, topic, data: { item } })
    const rawBody = JSON.stringify(notification('contact.user.updated', contact('1', 1704067300)))
    const signature = `sha1=${createHmac('sha1', 'client-secret').update(rawBody).digest('hex')}`
    expect(verifyWebhook(spec, { headers: { 'x-hub-signature': signature }, rawBody, secret: 'client-secret' })).toBe(true)
    expect(parseWebhook(spec, JSON.parse(rawBody))[0]).toMatchObject({ stream: 'contacts', action: 'upsert', externalId: '1' })
    expect(parseWebhook(spec, notification('contact.deleted', { id: '1' }))[0]).toMatchObject({ action: 'delete', externalId: '1' })
    expect(parseWebhook(spec, notification('contact.user.tag.created', { type: 'contact_tag', tag: {} }))[0]).toMatchObject({
      stream: 'contacts',
      action: 'refetch'
    })
    expect(parseWebhook(spec, notification('conversation.admin.replied', { id: 'cv1', state: 'open' }))[0].stream).toBe('conversations')
  })
})
