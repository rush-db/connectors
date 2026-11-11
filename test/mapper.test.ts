import { describe, expect, it } from 'vitest'

import { cursorAfter, mapRecord, propertyName, streamSpecSchema } from '../src'

const stream = streamSpecSchema.parse({
  label: 'THING',
  request: { path: '/things' },
  records: '$.data',
  id: '$.id',
  incremental: { cursorField: '$.updated' },
  deleted: { path: '$.deleted' },
  fields: {
    flatten: ['$.properties'],
    rename: { FirstName: 'given_name' },
    omit: ['secret'],
    types: {
      amount: 'cents',
      created: 'unix',
      created_ms: 'unixMs',
      count: 'number',
      active: 'boolean',
      when: 'datetime',
      code: 'string',
      meta: 'json'
    }
  },
  relations: [
    { type: 'BILLED_TO', target: 'customers', field: 'customer' },
    { type: 'WORKS_AT', target: 'companies', path: '$.companies[*].id' },
    { type: 'OWNED_BY', target: 'users', path: '$.owner' }
  ]
})

const raw = {
  id: 'r1',
  properties: { FirstName: 'Ada', 'Close Date': '2024-05-01' },
  amount: 1999,
  created: 1700000000,
  created_ms: 1700000000000,
  count: '5',
  active: 'yes',
  when: '2024-01-01 00:00:00',
  code: 42,
  meta: 'kept',
  secret: 's',
  address: { city: 'Berlin', geo: { lat: 52.5 } },
  items: [{ sku: 'a' }],
  tags: ['x', 'y'],
  customer: { id: 'cus_1', email: 'ada@example.com' },
  companies: [{ id: 1 }, { id: 2 }, { id: 1 }],
  owner: { accountId: 'acc-9' },
  updated: '2024-02-02T00:00:00Z',
  deleted: false
}

describe('mapper', () => {
  it('names properties in snake case', () => {
    expect(propertyName('FirstName')).toBe('first_name')
    expect(propertyName('Close Date')).toBe('close_date')
    expect(propertyName('hs_lastmodifieddate')).toBe('hs_lastmodifieddate')
    expect(propertyName('2024 revenue')).toBe('f_2024_revenue')
    expect(propertyName('***')).toBe('value')
  })

  it('flattens, renames, types and keeps one record per provider object', () => {
    const mapped = mapRecord(raw, stream)!
    expect(mapped.externalId).toBe('r1')
    const p = mapped.properties
    expect(p.given_name).toBe('Ada')
    expect(p.close_date).toBe('2024-05-01')
    expect(p).not.toHaveProperty('properties')
    expect(p).not.toHaveProperty('secret')
    expect(p).not.toHaveProperty('id')
    expect(p.external_id).toBe('r1')
    expect(p.amount).toBe(19.99)
    expect(p.created).toBe('2023-11-14T22:13:20.000Z')
    expect(p.created_ms).toBe('2023-11-14T22:13:20.000Z')
    expect(p.count).toBe(5)
    expect(p.active).toBe(true)
    expect(p.when).toBe('2024-01-01T00:00:00.000Z')
    expect(p.code).toBe('42')
    expect(p.meta).toBe('kept')
    // Nested objects become prefixed properties down to the depth, deeper ones JSON.
    expect(p.address_city).toBe('Berlin')
    expect(p.address_geo).toBe('{"lat":52.5}')
    // Arrays of objects become JSON; arrays of scalars stay arrays.
    expect(p.items).toBe('[{"sku":"a"}]')
    expect(p.tags).toEqual(['x', 'y'])
    expect(mapped.cursor).toBe('2024-02-02T00:00:00Z')
    expect(mapped.deleted).toBeUndefined()
  })

  it('keeps the bare id for key relations and links path relations by id pairs', () => {
    const mapped = mapRecord(raw, stream)!
    expect(mapped.properties.customer).toBe('cus_1')
    expect(mapped.properties).not.toHaveProperty('customer_email')
    expect(mapped.links).toEqual([
      { type: 'WORKS_AT', target: 'companies', direction: 'out', externalIds: ['1', '2'] },
      { type: 'OWNED_BY', target: 'users', direction: 'out', externalIds: ['acc-9'] }
    ])
  })

  it('keeps a key relation that is already a bare id', () => {
    const mapped = mapRecord({ id: 'r2', customer: 'cus_2' }, stream)!
    expect(mapped.properties.customer).toBe('cus_2')
    expect(mapped.links).toEqual([])
  })

  it('omits a nested object with every property it would become', () => {
    const omitting = streamSpecSchema.parse({ ...stream, fields: { omit: ['attributes'] } })
    expect(mapRecord({ id: 'r4', attributes: { type: 'Account' }, attributes_note: 'n' }, omitting)!.properties).toEqual({
      attributes_note: 'n',
      external_id: 'r4'
    })
  })

  it('marks tombstones and skips records without an id', () => {
    expect(mapRecord({ id: 'r3', deleted: true }, stream)?.deleted).toBe(true)
    expect(mapRecord({ name: 'no id' }, stream)).toBeUndefined()
    expect(mapRecord({ id: '' }, stream)).toBeUndefined()
  })

  it('handles nulls and bad values in conversions', () => {
    const mapped = mapRecord({ id: 1, amount: null, count: 'abc', when: 'not a date' }, stream)!
    expect(mapped.properties.amount).toBeNull()
    expect(mapped.properties.count).toBeNull()
    expect(mapped.properties.when).toBeNull()
    expect(mapped.externalId).toBe('1')
  })

  it('compares cursors of one stream', () => {
    expect(cursorAfter(5, 3)).toBe(true)
    expect(cursorAfter('2024-01-02T00:00:00Z', '2024-01-01T23:59:59Z')).toBe(true)
    expect(cursorAfter('2024-01-01T00:00:00.000+0100', '2024-01-01T00:00:00Z')).toBe(false)
    expect(cursorAfter('b', 'a')).toBe(true)
  })
})
