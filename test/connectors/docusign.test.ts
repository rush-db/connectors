import { describe, expect, it } from 'vitest'

import { docusign } from '../../src/connectors/docusign'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const ACCOUNT = '00000000-0000-0000-0000-0000000000aa'
const API = `/restapi/v2.1/accounts/${ACCOUNT}`

const connection = (config: Record<string, unknown> = {}): ConnectionContext => ({
  config: { environment: 'account-d.docusign.com', ...config },
  credentials: { type: 'oauth2', accessToken: 'at' }
})

const userinfo = {
  path: '/oauth/userinfo',
  body: {
    sub: 'user-1',
    accounts: [
      { account_id: 'other', is_default: false, account_name: 'Other Co', base_uri: 'https://na2.docusign.net' },
      { account_id: ACCOUNT, is_default: true, account_name: 'Example Co', base_uri: 'https://demo.docusign.net' }
    ]
  }
}

const envelope = (id: string, modified: string) => ({
  envelopeId: id,
  status: 'sent',
  emailSubject: `Please sign ${id}`,
  createdDateTime: '2024-01-01T10:00:00.0000000Z',
  lastModifiedDateTime: modified,
  sender: { userId: 'u1', userName: 'Sender', email: 'sender@example.com' },
  envelopeUri: `/envelopes/${id}`,
  recipients: {
    signers: [{ recipientIdGuid: `${id}-r1`, recipientId: '1', name: 'Signer', email: 'signer@example.com', status: 'sent', routingOrder: '1', userId: 'u9' }],
    carbonCopies: [{ recipientIdGuid: `${id}-r2`, recipientId: '2', name: 'Copy', email: 'cc@example.com', status: 'created', routingOrder: '2' }]
  }
})

describe('docusign', () => {
  it('parses', () => {
    const spec = parseConnectorSpec(docusign.spec)
    expect(Object.keys(spec.streams)).toEqual(['envelopes', 'recipients', 'templates', 'users'])
    expect(spec.category).toBe('documents')
  })

  it('tests by resolving the default account', async () => {
    const { fetch, runtime } = mockRuntime([userinfo])
    expect(await runtime.test(docusign, connection())).toEqual({ account: 'Example Co' })
    expect(fetch.calls[0].url).toBe('https://account-d.docusign.com/oauth/userinfo')
  })

  it('uses the configured account and refuses a non-DocuSign host', async () => {
    const { runtime } = mockRuntime([userinfo])
    expect(await runtime.test(docusign, connection({ accountId: 'other' }))).toEqual({ account: 'Other Co' })
    const { runtime: evil } = mockRuntime([
      { path: '/oauth/userinfo', body: { accounts: [{ account_id: 'x', is_default: true, base_uri: 'https://docusign.net.example.com' }] } }
    ])
    await expect(evil.test(docusign, connection())).rejects.toThrow(/unexpected API host/)
    const { runtime: missing } = mockRuntime([userinfo])
    await expect(missing.test(docusign, connection({ accountId: 'nope' }))).rejects.toThrow(/not available/)
  })

  it('backfills envelopes on the account host over two pages', async () => {
    const page = Array.from({ length: 100 }, (_, index) => envelope(`e${index}`, '2024-01-02T10:00:00.0000000Z'))
    const { fetch, runtime } = mockRuntime([
      userinfo,
      {
        path: `${API}/envelopes`,
        query: { start_position: '100' },
        body: { resultSetSize: '1', totalSetSize: '101', envelopes: [envelope('e100', '2024-01-05T10:00:00.0000000Z')] }
      },
      { path: `${API}/envelopes`, query: { start_position: '0' }, body: { resultSetSize: '100', totalSetSize: '101', envelopes: page, nextUri: '/envelopes?start_position=100' } }
    ])
    const batches = await readAll(runtime, docusign, connection(), 'envelopes')
    const all = records(batches)
    expect(all).toHaveLength(101)
    expect(all[0].properties).toMatchObject({
      status: 'sent',
      email_subject: 'Please sign e0',
      created_date_time: '2024-01-01T10:00:00.000Z',
      sender_user_id: 'u1',
      external_id: 'e0'
    })
    expect(all[0].properties).not.toHaveProperty('envelope_uri')
    expect(all[0].links).toEqual([{ type: 'SENT_BY', target: 'users', direction: 'out', externalIds: ['u1'] }])
    const first = new URL(fetch.calls.find((call) => call.url.includes('/envelopes'))!.url)
    expect(first.origin).toBe('https://demo.docusign.net')
    expect(first.searchParams.get('from_date')).toBe('2000-01-01T00:00:00Z')
    expect(first.searchParams.get('order_by')).toBe('created')
    expect(first.searchParams.get('count')).toBe('100')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-05T10:00:00.0000000Z')
  })

  it('sends from_date from the cursor less the lookback', async () => {
    const { fetch, runtime } = mockRuntime([userinfo, { path: `${API}/envelopes`, body: { resultSetSize: '0', totalSetSize: '0' } }])
    const batches = await readAll(runtime, docusign, connection(), 'envelopes', { cursor: '2024-01-05T10:00:00.0000000Z' })
    const url = new URL(fetch.calls.at(-1)!.url)
    expect(url.searchParams.get('from_date')).toBe('2024-01-05T09:55:00.000Z')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-05T10:00:00.0000000Z')
  })

  it('yields one record per recipient through the read hook', async () => {
    const page = Array.from({ length: 100 }, (_, index) => envelope(`e${index}`, '2024-01-02T10:00:00Z'))
    const { fetch, runtime } = mockRuntime([
      userinfo,
      {
        path: `${API}/envelopes`,
        query: { start_position: '100' },
        body: { envelopes: [envelope('e100', '2024-01-06T00:00:00Z')] }
      },
      { path: `${API}/envelopes`, query: { start_position: '0' }, body: { envelopes: page, nextUri: '/envelopes?start_position=100' } }
    ])
    const batches = await readAll(runtime, docusign, connection(), 'recipients', { cursor: '2024-01-01T00:00:00Z' })
    const all = records(batches)
    expect(all).toHaveLength(202)
    expect(all[0]).toMatchObject({
      externalId: 'e0-r1',
      properties: { recipient_group: 'signers', status: 'sent', routing_order: 1, envelope_id: 'e0' },
      links: [
        { type: 'RECIPIENT_OF', target: 'envelopes', direction: 'out', externalIds: ['e0'] },
        { type: 'IS_USER', target: 'users', direction: 'out', externalIds: ['u9'] }
      ]
    })
    expect(all[1].properties.recipient_group).toBe('carbonCopies')
    const envelopeCalls = fetch.calls.filter((call) => call.url.includes('/envelopes')).map((call) => new URL(call.url).searchParams)
    expect(envelopeCalls[0].get('include')).toBe('recipients')
    expect(envelopeCalls[0].get('from_date')).toBe('2023-12-31T23:55:00.000Z')
    expect(envelopeCalls[1].get('start_position')).toBe('100')
    expect(batches[0].state.cursor).toBe('2024-01-01T00:00:00Z')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-06T00:00:00Z')
  })

  it('reads templates incrementally by modification date', async () => {
    const { fetch, runtime } = mockRuntime([
      userinfo,
      {
        path: `${API}/templates`,
        body: { envelopeTemplates: [{ templateId: 't1', name: 'NDA', lastModified: '2024-03-01T00:00:00Z', owner: { userId: 'u1' } }] }
      }
    ])
    const batches = await readAll(runtime, docusign, connection(), 'templates', { cursor: '2024-02-01T00:00:00Z' })
    expect(new URL(fetch.calls.at(-1)!.url).searchParams.get('modified_from_date')).toBe('2024-01-31T23:55:00.000Z')
    expect(records(batches)[0].links).toEqual([{ type: 'OWNED_BY', target: 'users', direction: 'out', externalIds: ['u1'] }])
  })
})
