import { describe, expect, it } from 'vitest'

import { brevo } from '../../src/connectors/brevo'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const apiKey: ConnectionContext = { config: {}, credentials: { type: 'apiKey', apiKey: 'xkeysib-test' } }

const contact = (id: number, modifiedAt: string) => ({
  id,
  email: `contact${id}@example.com`,
  emailBlacklisted: false,
  smsBlacklisted: false,
  createdAt: '2024-01-01T10:00:00.000+02:00',
  modifiedAt,
  listIds: [2, 7],
  attributes: { FIRSTNAME: 'Test', LASTNAME: `Contact ${id}` }
})

describe('brevo', () => {
  it('parses', () => {
    const spec = parseConnectorSpec(brevo.spec)
    expect(Object.keys(spec.streams)).toEqual(['contacts', 'lists', 'email_campaigns', 'companies', 'deals'])
    expect(spec.streams.deals.optional).toBe(true)
    expect(spec.category).toBe('marketing')
  })

  it('tests with the api-key header', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/v3/account', body: { companyName: 'Example Co', email: 'owner@example.com' } }])
    expect(await runtime.test(brevo, apiKey)).toEqual({ account: 'Example Co' })
    expect(fetch.calls[0].headers['api-key']).toBe('xkeysib-test')
  })

  it('backfills contacts over two offset pages with flattened attributes and lists', async () => {
    const page = Array.from({ length: 1000 }, (_, index) => contact(index + 1, '2024-01-02T00:00:00.000Z'))
    const { fetch, runtime } = mockRuntime([
      { path: '/v3/contacts', query: { offset: '1000' }, body: { contacts: [contact(1001, '2024-01-05T00:00:00.000Z')], count: 1001 } },
      { path: '/v3/contacts', query: { offset: '0' }, body: { contacts: page, count: 1001 } }
    ])
    const batches = await readAll(runtime, brevo, apiKey, 'contacts')
    const all = records(batches)
    expect(all).toHaveLength(1001)
    expect(all[0].properties).toMatchObject({
      email: 'contact1@example.com',
      firstname: 'Test',
      lastname: 'Contact 1',
      email_blacklisted: false,
      created_at: '2024-01-01T08:00:00.000Z',
      list_ids: [2, 7],
      external_id: '1'
    })
    expect(all[0].links).toEqual([{ type: 'IN_LIST', target: 'lists', direction: 'out', externalIds: ['2', '7'] }])
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('limit')).toBe('1000')
    expect(query.get('sort')).toBe('asc')
    expect(query.has('modifiedSince')).toBe(false)
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-05T00:00:00.000Z')
  })

  it('sends modifiedSince from the cursor less the lookback', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/v3/contacts', body: { contacts: [contact(5, '2024-02-02T00:00:00.000Z')], count: 1 } }])
    const batches = await readAll(runtime, brevo, apiKey, 'contacts', { cursor: '2024-02-01T00:00:00.000Z' })
    expect(new URL(fetch.calls[0].url).searchParams.get('modifiedSince')).toBe('2024-01-31T23:59:00.000Z')
    expect(batches.at(-1)!.state.cursor).toBe('2024-02-02T00:00:00.000Z')
  })

  it('reads deals with CRM links and campaigns without HTML', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/v3/crm/deals',
        body: {
          items: [
            {
              id: '65a0000000000000000000d1',
              attributes: { deal_name: 'Renewal', amount: 1200, deal_stage: 'stage-1', last_updated_date: '2024-03-01T00:00:00.000Z' },
              linkedContactsIds: [1],
              linkedCompaniesIds: ['65a0000000000000000000c1']
            }
          ]
        }
      },
      {
        path: '/v3/emailCampaigns',
        body: { campaigns: [{ id: 9, name: 'Launch', status: 'sent', htmlContent: '', recipients: { lists: [2], exclusionLists: [] }, sender: { name: 'Team', email: 'team@example.com' } }], count: 1 }
      }
    ])
    const [deal] = records(await readAll(runtime, brevo, apiKey, 'deals'))
    expect(deal.properties).toMatchObject({ deal_name: 'Renewal', amount: 1200, last_updated_date: '2024-03-01T00:00:00.000Z' })
    expect(deal.properties).not.toHaveProperty('linked_contacts_ids')
    expect(deal.links).toEqual([
      { type: 'INVOLVES', target: 'contacts', direction: 'out', externalIds: ['1'] },
      { type: 'FOR_COMPANY', target: 'companies', direction: 'out', externalIds: ['65a0000000000000000000c1'] }
    ])
    const [campaign] = records(await readAll(runtime, brevo, apiKey, 'email_campaigns'))
    expect(campaign.properties).not.toHaveProperty('html_content')
    expect(campaign.links).toEqual([{ type: 'SENT_TO_LIST', target: 'lists', direction: 'out', externalIds: ['2'] }])
    expect(new URL(fetch.calls.at(-1)!.url).searchParams.get('excludeHtmlContent')).toBe('true')
  })

  it('pages companies by page number', async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({ id: `c${index}`, attributes: { name: `Company ${index}` }, linkedContactsIds: [] }))
    const { fetch, runtime } = mockRuntime([
      { path: '/v3/companies', query: { page: '2' }, body: { items: [{ id: 'c100', attributes: { name: 'Last' }, linkedContactsIds: [4] }] } },
      { path: '/v3/companies', query: { page: '1' }, body: { items: page } }
    ])
    const all = records(await readAll(runtime, brevo, apiKey, 'companies'))
    expect(all).toHaveLength(101)
    expect(all[100].links).toEqual([{ type: 'HAS_CONTACT', target: 'contacts', direction: 'out', externalIds: ['4'] }])
    expect(new URL(fetch.calls[0].url).searchParams.get('limit')).toBe('100')
  })
})
