import { describe, expect, it } from 'vitest'

import { salesforce } from '../../src/connectors'
import { soqlDatetime } from '../../src/connectors/salesforce'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import type { MockRoute } from '../../src/testing'
import { mockRuntime, readAll, records } from '../helpers'

const API = '/services/data/v62.0'
const connection = (): ConnectionContext => ({
  config: {},
  credentials: { type: 'oauth2', accessToken: 'token', extra: { instance_url: 'https://acme.my.salesforce.com' } }
})

const field = (name: string, type = 'string', referenceTo: string[] = [], relationshipName: string | null = null) => ({
  name,
  type,
  referenceTo,
  relationshipName
})

const discovery: MockRoute[] = [
  {
    path: `${API}/sobjects`,
    body: {
      sobjects: [
        { name: 'Account', queryable: true, custom: false, replicateable: true },
        { name: 'Contact', queryable: true, custom: false, replicateable: true },
        { name: 'Invoice__c', queryable: true, custom: true, replicateable: true },
        { name: 'Hidden__c', queryable: true, custom: true, replicateable: true, deprecatedAndHidden: true },
        { name: 'Report', queryable: true, custom: false, replicateable: false }
      ]
    }
  },
  {
    path: `${API}/sobjects/Account/describe`,
    body: {
      fields: [
        field('Id', 'id'),
        field('Name'),
        field('Tier__c', 'picklist'),
        field('OwnerId', 'reference', ['User'], 'Owner'),
        field('ParentId', 'reference', ['Account'], 'Parent'),
        field('BillingAddress', 'address'),
        field('Logo__c', 'base64'),
        field('IsDeleted', 'boolean'),
        field('CreatedById', 'reference', ['User'], 'CreatedBy'),
        field('SystemModstamp', 'datetime')
      ]
    }
  },
  {
    path: `${API}/sobjects/Contact/describe`,
    body: {
      fields: [
        field('Id', 'id'),
        field('LastName'),
        field('AccountId', 'reference', ['Account'], 'Account'),
        field('IsDeleted', 'boolean'),
        field('SystemModstamp', 'datetime')
      ]
    }
  },
  {
    path: `${API}/sobjects/Invoice__c/describe`,
    body: {
      fields: [
        field('Id', 'id'),
        field('Amount__c', 'currency'),
        field('Account__c', 'reference', ['Account'], 'Account__r'),
        field('Who__c', 'reference', ['Contact', 'Account'], 'Who__r'),
        field('LastModifiedDate', 'datetime')
      ]
    }
  }
]

const account = (id: string, stamp: string, extra: Record<string, unknown> = {}) => ({
  attributes: { type: 'Account', url: `${API}/sobjects/Account/${id}` },
  Id: id,
  Name: `Account ${id}`,
  Tier__c: 'Gold',
  OwnerId: '005000000000001',
  ParentId: null,
  IsDeleted: false,
  SystemModstamp: stamp,
  ...extra
})

describe('salesforce', () => {
  it('parses with the standard objects', () => {
    expect(Object.keys(parseConnectorSpec(salesforce.spec).streams)).toEqual([
      'accounts',
      'contacts',
      'leads',
      'opportunities',
      'cases',
      'users',
      'tasks',
      'events'
    ])
  })

  it('tests the connection with the organization name', async () => {
    const { fetch, runtime } = mockRuntime([{ path: `${API}/query`, body: { records: [{ Name: 'Acme Inc' }] } }])
    expect(await runtime.test(salesforce, connection())).toEqual({ account: 'Acme Inc' })
    expect(fetch.calls[0].url.startsWith('https://acme.my.salesforce.com/')).toBe(true)
  })

  it('discovers fields, custom objects and reference relations', async () => {
    const { runtime } = mockRuntime(discovery)
    const streams = await runtime.streams(salesforce, connection())
    expect(streams.accounts.request.query?.q).toBe(
      'SELECT Id, Name, Tier__c, OwnerId, ParentId, IsDeleted, CreatedById, SystemModstamp FROM Account'
    )
    expect(streams.accounts.relations).toEqual([
      { type: 'CHILD_OF', target: 'accounts', field: 'ParentId', direction: 'out' }
    ])
    expect(streams['invoice__c']).toMatchObject({
      label: 'SF_INVOICE',
      incremental: { cursorField: '$.LastModifiedDate' },
      relations: [{ type: 'HAS_ACCOUNT', target: 'accounts', field: 'Account__c', direction: 'out' }]
    })
    expect(streams['hidden__c']).toBeUndefined()
    expect(streams.contacts.relations).toEqual([{ type: 'WORKS_AT', target: 'accounts', field: 'AccountId', direction: 'out' }])
    // Static standard streams stay for objects the account did not describe.
    expect(streams.leads.request.query?.q).toBe('SELECT FIELDS(STANDARD) FROM Lead')
  })

  it('backfills with SOQL ordered by SystemModstamp and follows nextRecordsUrl', async () => {
    const { fetch, runtime } = mockRuntime([
      ...discovery,
      {
        path: `${API}/query/01gNEXT-2000`,
        body: { done: true, records: [account('001B', '2024-01-02T00:00:00.000+0000')] }
      },
      {
        path: `${API}/query`,
        body: {
          done: false,
          nextRecordsUrl: `${API}/query/01gNEXT-2000`,
          records: [account('001A', '2024-01-01T00:00:00.000+0000')]
        }
      }
    ])
    const batches = await readAll(runtime, salesforce, connection(), 'accounts')
    const q = new URL(fetch.calls.find((call) => call.url.includes('/query?'))!.url).searchParams.get('q')
    expect(q).toMatch(/FROM Account ORDER BY SystemModstamp ASC$/)
    const [first, second] = records(batches)
    expect(first.externalId).toBe('001A')
    expect(first.properties).toMatchObject({ name: 'Account 001A', tier_c: 'Gold', owner_id: '005000000000001' })
    expect(first.properties).not.toHaveProperty('attributes_type')
    expect(first.properties.system_modstamp).toBe('2024-01-01T00:00:00.000Z')
    expect(second.externalId).toBe('001B')
    expect(batches[0].state.cursor).toBe('2024-01-01T00:00:00.000+0000')
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-02T00:00:00.000+0000')
  })

  it('reads changes and deletions through queryAll', async () => {
    const { fetch, runtime } = mockRuntime([
      ...discovery,
      {
        path: `${API}/queryAll`,
        body: { done: true, records: [account('001C', '2024-01-10T00:05:00.000+0000', { IsDeleted: true })] }
      }
    ])
    const batches = await readAll(runtime, salesforce, connection(), 'accounts', { cursor: '2024-01-10T00:00:00.000+0000' })
    const q = new URL(fetch.calls.find((call) => call.url.includes('/queryAll'))!.url).searchParams.get('q')
    expect(q).toContain('WHERE SystemModstamp > 2024-01-09T23:59:00Z ORDER BY SystemModstamp ASC')
    expect(records(batches)[0].deleted).toBe(true)
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-10T00:05:00.000+0000')
  })

  it('formats SOQL datetimes without milliseconds', () => {
    expect(soqlDatetime('2024-01-01T10:00:00.123+0000')).toBe('2024-01-01T10:00:00Z')
  })
})
