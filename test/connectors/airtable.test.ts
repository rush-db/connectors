import { describe, expect, it } from 'vitest'

import { airtable } from '../../src/connectors'
import { parseConnectorSpec } from '../../src'
import { bearer, mockRuntime, readAll, records } from '../helpers'

const connection = () => bearer({ baseId: 'appBASE' })
const meta = {
  path: '/v0/meta/bases/appBASE/tables',
  body: {
    tables: [
      {
        id: 'tblCompanies',
        name: 'Companies',
        fields: [
          { id: 'fld1', name: 'Name', type: 'singleLineText' },
          { id: 'fld2', name: 'Last Modified', type: 'lastModifiedTime' }
        ]
      },
      {
        id: 'tblPeople',
        name: 'People',
        fields: [
          { id: 'fld3', name: 'Name', type: 'singleLineText' },
          { id: 'fld4', name: 'Company', type: 'multipleRecordLinks', options: { linkedTableId: 'tblCompanies' } }
        ]
      }
    ]
  }
}
const person = (id: string, company: string) => ({
  id,
  createdTime: '2024-01-01T00:00:00.000Z',
  fields: { Name: `Person ${id}`, Company: [company] }
})

describe('airtable', () => {
  it('parses with streams left to discovery', () => {
    expect(parseConnectorSpec(airtable.spec).streams).toEqual({})
  })

  it('tests by reading the base schema', async () => {
    const { fetch, runtime } = mockRuntime([meta])
    await runtime.test(airtable, connection())
    expect(fetch.calls[0].headers.authorization).toBe('Bearer test-token')
  })

  it('discovers tables, linked-record relations and incremental where possible', async () => {
    const { runtime } = mockRuntime([meta])
    const streams = await runtime.streams(airtable, connection())
    expect(streams.people).toMatchObject({
      label: 'AIRTABLE_PEOPLE',
      relations: [{ type: 'LINKED_COMPANY', target: 'companies', path: "$.fields['Company']" }]
    })
    expect(streams.people.incremental).toBeUndefined()
    expect(streams.companies.incremental?.cursorField).toBe("$.fields['Last Modified']")
  })

  it('backfills with the offset token', async () => {
    const { runtime } = mockRuntime([
      meta,
      { path: '/v0/appBASE/tblPeople', query: { offset: 'itr2' }, body: { records: [person('rec2', 'recC2')] } },
      { path: '/v0/appBASE/tblPeople', body: { records: [person('rec1', 'recC1')], offset: 'itr2' } }
    ])
    const batches = await readAll(runtime, airtable, connection(), 'people')
    const [first, second] = records(batches)
    expect(first.properties).toEqual({
      name: 'Person rec1',
      company: ['recC1'],
      created_time: '2024-01-01T00:00:00.000Z',
      external_id: 'rec1'
    })
    expect(first.links).toEqual([{ type: 'LINKED_COMPANY', target: 'companies', direction: 'out', externalIds: ['recC1'] }])
    expect(second.externalId).toBe('rec2')
  })

  it('filters by LAST_MODIFIED_TIME() once a cursor exists', async () => {
    const { fetch, runtime } = mockRuntime([
      meta,
      {
        path: '/v0/appBASE/tblCompanies',
        body: { records: [{ id: 'recC1', createdTime: '2024-01-01T00:00:00.000Z', fields: { Name: 'Acme', 'Last Modified': '2024-01-11T00:00:00.000Z' } }] }
      }
    ])
    const batches = await readAll(runtime, airtable, connection(), 'companies', { cursor: '2024-01-10T00:00:00.000Z' })
    expect(new URL(fetch.calls.at(-1)!.url).searchParams.get('filterByFormula')).toBe(
      "IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('2024-01-09T23:59:00.000Z'))"
    )
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-11T00:00:00.000Z')
  })
})
