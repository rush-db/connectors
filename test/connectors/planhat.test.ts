import { describe, expect, it } from 'vitest'

import { planhat } from '../../src/connectors/planhat'
import { parseConnectorSpec } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const company = (id: string) => ({
  _id: id,
  name: `Example Co ${id}`,
  owner: 'u1',
  coOwner: 'u2',
  phase: 'Onboarding',
  status: 'customer',
  mrr: 1250.5,
  h: 7,
  domains: ['example.com'],
  custom: { Segment: 'SMB', 'Renewal Owner': 'u1' },
  createDate: '2024-01-01T10:00:00.000Z',
  lastUpdated: '2024-02-01T10:00:00.000Z'
})

describe('planhat', () => {
  it('parses', () => {
    const spec = parseConnectorSpec(planhat.spec)
    expect(Object.keys(spec.streams)).toEqual(['companies', 'endusers', 'licenses', 'conversations', 'users'])
    expect(spec.category).toBe('customer-success')
    expect(spec.streams.conversations.optional).toBe(true)
  })

  it('tests the connection', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/companies', body: [] }])
    expect(await runtime.test(planhat, bearer())).toEqual({})
    expect(new URL(fetch.calls[0].url).searchParams.get('limit')).toBe('1')
  })

  it('backfills companies with offset pagination, typed fields and owners', async () => {
    const page = Array.from({ length: 1000 }, (_, index) => company(`c${index}`))
    const { fetch, runtime } = mockRuntime([
      { path: '/companies', query: { offset: '1000' }, body: [company('c1000')] },
      { path: '/companies', query: { offset: '0' }, body: page }
    ])
    const batches = await readAll(runtime, planhat, bearer(), 'companies')
    const all = records(batches)
    expect(all).toHaveLength(1001)
    expect(all[0].externalId).toBe('c0')
    expect(all[0].properties).toMatchObject({
      name: 'Example Co c0',
      mrr: 1250.5,
      custom_segment: 'SMB',
      custom_renewal_owner: 'u1',
      create_date: '2024-01-01T10:00:00.000Z',
      last_updated: '2024-02-01T10:00:00.000Z',
      domains: ['example.com'],
      external_id: 'c0'
    })
    expect(all[0].properties).not.toHaveProperty('_id')
    expect(all[0].links).toEqual([
      { type: 'OWNED_BY', target: 'users', direction: 'out', externalIds: ['u1'] },
      { type: 'CO_OWNED_BY', target: 'users', direction: 'out', externalIds: ['u2'] }
    ])
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('limit')).toBe('1000')
    expect(query.get('sort')).toBe('_id')
    expect(new URL(fetch.calls[1].url).searchParams.get('offset')).toBe('1000')
  })

  it('reads in full with a stored cursor and links conversations', async () => {
    const { fetch, runtime } = mockRuntime([
      {
        path: '/conversations',
        body: [
          {
            _id: 'cv1',
            companyId: 'c1',
            type: 'email',
            subject: 'Renewal',
            endusers: ['e1', 'e2'],
            users: [{ id: 'u1', name: 'Agent', isOwner: true }],
            date: '2024-03-01T12:00:00.000Z'
          }
        ]
      }
    ])
    const batches = await readAll(runtime, planhat, bearer(), 'conversations', { cursor: '2024-01-01T00:00:00Z' })
    expect(fetch.calls).toHaveLength(1)
    expect(new URL(fetch.calls[0].url).searchParams.has('updatedAt')).toBe(false)
    expect(records(batches)[0].links).toEqual([
      { type: 'FOR_COMPANY', target: 'companies', direction: 'out', externalIds: ['c1'] },
      { type: 'INVOLVES', target: 'endusers', direction: 'out', externalIds: ['e1', 'e2'] },
      { type: 'HANDLED_BY', target: 'users', direction: 'out', externalIds: ['u1'] }
    ])
  })
})
