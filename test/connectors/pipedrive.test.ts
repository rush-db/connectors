import { describe, expect, it } from 'vitest'

import { pipedrive } from '../../src/connectors'
import { parseConnectorSpec, parseWebhook, verifyWebhook, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const apiKey = (): ConnectionContext => ({ config: {}, credentials: { type: 'apiKey', apiKey: 'pd-token' } })
const person = (id: number, update: string) => ({
  id,
  name: `Person ${id}`,
  owner_id: 9,
  org_id: 50,
  emails: [{ value: `p${id}@example.com`, primary: true, label: 'work' }],
  add_time: '2023-01-01T00:00:00Z',
  update_time: update,
  custom_fields: { tier: 'gold' }
})

describe('pipedrive', () => {
  it('parses', () => {
    expect(Object.keys(parseConnectorSpec(pipedrive.spec).streams)).toEqual([
      'persons',
      'organizations',
      'deals',
      'activities',
      'users',
      'pipelines',
      'stages'
    ])
  })

  it('tests with the API token header', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/v1/users/me', body: { data: { company_name: 'Acme' } } }])
    expect(await runtime.test(pipedrive, apiKey())).toEqual({ account: 'Acme' })
    expect(fetch.calls[0].headers['x-api-token']).toBe('pd-token')
  })

  it('backfills persons over cursor pages', async () => {
    const { runtime } = mockRuntime([
      { path: '/api/v2/persons', query: { cursor: 'c2' }, body: { data: [person(2, '2024-01-02T00:00:00Z')], additional_data: { next_cursor: null } } },
      { path: '/api/v2/persons', body: { data: [person(1, '2024-01-01T00:00:00Z')], additional_data: { next_cursor: 'c2' } } }
    ])
    const batches = await readAll(runtime, pipedrive, apiKey(), 'persons')
    const [first] = records(batches)
    expect(records(batches)).toHaveLength(2)
    expect(first.properties).toMatchObject({ name: 'Person 1', custom_fields_tier: 'gold', update_time: '2024-01-01T00:00:00.000Z' })
    expect(first.properties.emails).toBe('[{"value":"p1@example.com","primary":true,"label":"work"}]')
    expect(first.links).toEqual([
      { type: 'WORKS_AT', target: 'organizations', direction: 'out', externalIds: ['50'] },
      { type: 'OWNED_BY', target: 'users', direction: 'out', externalIds: ['9'] }
    ])
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-02T00:00:00Z')
  })

  it('sends updated_since and uses the OAuth api_domain', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/v2/deals', body: { data: [] } }])
    await readAll(
      runtime,
      pipedrive,
      { config: {}, credentials: { type: 'oauth2', accessToken: 't', extra: { api_domain: 'https://acme.pipedrive.com' } } },
      'deals',
      { cursor: '2024-01-10T00:00:00Z' }
    )
    const url = new URL(fetch.calls[0].url)
    expect(url.origin).toBe('https://acme.pipedrive.com')
    expect(url.searchParams.get('updated_since')).toBe('2024-01-09T23:59:00.000Z')
    expect(url.searchParams.get('sort_by')).toBe('update_time')
  })

  it('verifies basic-auth webhooks and routes v2 payloads', () => {
    const spec = parseConnectorSpec(pipedrive.spec)
    const headers = { authorization: `Basic ${Buffer.from('hook:pass').toString('base64')}` }
    expect(verifyWebhook(spec, { headers, rawBody: '{}', secret: 'hook:pass' })).toBe(true)
    expect(verifyWebhook(spec, { headers, rawBody: '{}', secret: 'hook:other' })).toBe(false)
    const change = parseWebhook(spec, {
      meta: { action: 'change', entity: 'person', entity_id: '1', id: 'evt-1' },
      data: person(1, '2024-01-03T00:00:00Z'),
      previous: { name: 'Old' }
    })
    expect(change[0]).toMatchObject({ type: 'person.change', stream: 'persons', action: 'upsert', externalId: '1' })
    expect(change[0].record?.properties.name).toBe('Person 1')
    expect(
      parseWebhook(spec, { meta: { action: 'delete', entity: 'deal', entity_id: '7', id: 'evt-2' }, data: null, previous: { id: 7 } })
    ).toEqual([{ id: 'evt-2', type: 'deal.delete', stream: 'deals', action: 'delete', externalId: '7' }])
  })
})
