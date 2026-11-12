import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { hubspot } from '../../src/connectors'
import { parseConnectorSpec, parseWebhook, verifyWebhook } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const contact = (id: string, updatedAt: string, company?: string) => ({
  id,
  properties: {
    email: `person${id}@example.com`,
    firstname: 'Test',
    lastname: `Person ${id}`,
    hubspot_owner_id: 'o1',
    createdate: '2023-06-01T10:00:00.000Z',
    lastmodifieddate: updatedAt,
    hs_object_id: id
  },
  createdAt: '2023-06-01T10:00:00.000Z',
  updatedAt,
  archived: false,
  ...(company ? { associations: { companies: { results: [{ id: company, type: 'contact_to_company' }] } } } : {})
})

describe('hubspot', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(hubspot.spec).streams)).toEqual(['contacts', 'companies', 'deals', 'tickets', 'owners'])
  })

  it('tests the connection', async () => {
    const { runtime } = mockRuntime([{ path: '/account-info/v3/details', body: { portalId: 123456 } }])
    expect(await runtime.test(hubspot, bearer())).toEqual({ account: '123456' })
  })

  it('backfills contacts from the list API with associations', async () => {
    const { fetch, runtime } = mockRuntime([
      { path: '/crm/v3/objects/contacts', query: { after: 'p2' }, body: { results: [contact('2', '2024-01-02T00:00:00.000Z')] } },
      {
        path: '/crm/v3/objects/contacts',
        body: { results: [contact('1', '2024-01-01T00:00:00.000Z', 'c9')], paging: { next: { after: 'p2' } } }
      }
    ])
    const batches = await readAll(runtime, hubspot, bearer(), 'contacts')
    const [first, second] = records(batches)
    expect(first.externalId).toBe('1')
    expect(first.properties).toMatchObject({ email: 'person1@example.com', firstname: 'Test', external_id: '1' })
    expect(first.properties).not.toHaveProperty('associations_companies')
    expect(first.links).toEqual([
      { type: 'WORKS_AT', target: 'companies', direction: 'out', externalIds: ['c9'] },
      { type: 'OWNED_BY', target: 'owners', direction: 'out', externalIds: ['o1'] }
    ])
    expect(second.externalId).toBe('2')
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('associations')).toBe('companies')
    expect(query.get('properties')).toContain('lastmodifieddate')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-02T00:00:00.000Z')
  })

  it('reads changes through search and adds associations', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        method: 'POST',
        path: '/crm/v3/objects/contacts/search',
        respond: ({ body }: any) =>
          body.after ?
            { body: { results: [contact('4', '2024-01-11T00:00:00.000Z')] } }
          : { body: { results: [contact('3', '2024-01-10T12:00:00.000Z')], paging: { next: { after: '1' } } } }
      },
      {
        method: 'POST',
        path: '/crm/v4/associations/contacts/companies/batch/read',
        respond: ({ body }: any) => ({
          body: { results: body.inputs.map((input: any) => ({ from: { id: input.id }, to: [{ toObjectId: 77 }] })) }
        })
      }
    ])
    const batches = await readAll(runtime, hubspot, bearer(), 'contacts', { cursor: '2024-01-10T00:00:00.000Z' })
    const search = fetch.calls.find((call) => call.url.endsWith('/search'))!
    const filter = (search.body as any).filterGroups[0].filters[0]
    expect(filter).toEqual({
      propertyName: 'lastmodifieddate',
      operator: 'GTE',
      value: String(Date.parse('2024-01-10T00:00:00.000Z') - 300_000)
    })
    expect(records(batches).map((record) => record.links[0])).toEqual([
      { type: 'WORKS_AT', target: 'companies', direction: 'out', externalIds: ['77'] },
      { type: 'WORKS_AT', target: 'companies', direction: 'out', externalIds: ['77'] }
    ])
    expect(batches[0].state.cursor).toBe('2024-01-10T12:00:00.000Z')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-11T00:00:00.000Z')
  })

  it('verifies v3 signatures and routes object-id events', () => {
    const spec = parseConnectorSpec(hubspot.spec)
    const rawBody = JSON.stringify([
      { eventId: 1, subscriptionType: 'contact.propertyChange', objectId: 101, propertyName: 'email' },
      { eventId: 2, subscriptionType: 'deal.deletion', objectId: 202 },
      { eventId: 3, subscriptionType: 'contact.privacyDeletion', objectId: 303 }
    ])
    const url = 'https://hooks.example.com/connections/abc/webhook'
    const timestamp = String(Date.now())
    const signature = createHmac('sha256', 'client-secret').update(`POST${url}${rawBody}${timestamp}`).digest('base64')
    const headers = { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp }
    expect(verifyWebhook(spec, { headers, rawBody, secret: 'client-secret', url, method: 'POST' })).toBe(true)
    expect(parseWebhook(spec, JSON.parse(rawBody))).toEqual([
      { id: '1', type: 'contact.propertyChange', stream: 'contacts', action: 'refetch', externalId: '101' },
      { id: '2', type: 'deal.deletion', stream: 'deals', action: 'delete', externalId: '202' },
      { id: '3', type: 'contact.privacyDeletion', stream: 'contacts', action: 'delete', externalId: '303' }
    ])
  })
})
