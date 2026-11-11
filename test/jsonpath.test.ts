import { describe, expect, it } from 'vitest'

import { queryAll, queryOne, queryRecords } from '../src'
import { parsePath } from '../src/runtime/jsonpath'

const doc = {
  data: [
    { id: 1, tags: ['a', 'b'], owner: { id: 'u1' } },
    { id: 2, tags: [], owner: null }
  ],
  'odd key': { value: 3 },
  nested: { deep: { list: [[1, 2], [3]] } }
}

describe('jsonpath', () => {
  it('reads keys, quoted keys and indexes', () => {
    expect(queryOne(doc, '$.data[0].id')).toBe(1)
    expect(queryOne(doc, "$['odd key'].value")).toBe(3)
    expect(queryOne(doc, '$["odd key"].value')).toBe(3)
    expect(queryOne(doc, '$.data[-1].id')).toBe(2)
    expect(queryOne(doc, '$.nested.deep.list[1][0]')).toBe(3)
    expect(queryOne(doc, '$')).toBe(doc)
  })

  it('returns undefined through missing and null values', () => {
    expect(queryOne(doc, '$.data[1].owner.id')).toBeUndefined()
    expect(queryOne(doc, '$.missing.deeper')).toBeUndefined()
    expect(queryOne(doc, '$.data[9].id')).toBeUndefined()
  })

  it('fans out wildcards', () => {
    expect(queryAll(doc, '$.data[*].id')).toEqual([1, 2])
    expect(queryAll(doc, '$.data.*.owner.id')).toEqual(['u1'])
    expect(queryAll(doc, '$.odd key')).toEqual([{ value: 3 }])
    expect(queryOne(doc, '$.data[*].tags[*]')).toBe('a')
  })

  it('treats a selected array as the record list and a single object as a list of one', () => {
    expect(queryRecords(doc, '$.data')).toHaveLength(2)
    expect(queryRecords({ item: { id: 1 } }, '$.item')).toEqual([{ id: 1 }])
    expect(queryRecords([{ id: 1 }], '$')).toEqual([{ id: 1 }])
    expect(queryRecords({}, '$.nothing')).toEqual([])
  })

  it('rejects anything outside the subset', () => {
    expect(() => parsePath('data.id')).toThrow(/start with \$/)
    expect(() => parsePath('$.data[?(@.id)]')).toThrow(/Unsupported/)
    expect(() => parsePath('$.data[0')).toThrow(/Unclosed/)
    expect(() => parsePath('$..id')).toThrow(/Empty key/)
  })
})
