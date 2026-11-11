import { describe, expect, it } from 'vitest'

import { servicenow } from '../../src/connectors'
import { configuredTables } from '../../src/connectors/servicenow'
import { parseConnectorSpec, type ConnectionContext } from '../../src'
import { mockRuntime, readAll, records } from '../helpers'

const connection = (tables?: unknown): ConnectionContext => ({
  config: { instance: 'acme', ...(tables === undefined ? {} : { tables }) },
  credentials: { type: 'basic', username: 'integration', password: 'secret' }
})
const incident = (n: number) => ({
  sys_id: `inc${n}`,
  number: `INC${String(n).padStart(7, '0')}`,
  short_description: `Incident ${n}`,
  caller_id: 'usr1',
  assigned_to: '',
  cmdb_ci: 'ci1',
  sys_created_on: '2024-01-01 08:00:00',
  sys_updated_on: `2024-01-02 ${String(10 + (n % 10)).padStart(2, '0')}:00:00`
})

describe('servicenow', () => {
  it('parses with the default tables', () => {
    expect(Object.keys(parseConnectorSpec(servicenow.spec).streams)).toEqual([
      'incident',
      'problem',
      'change_request',
      'sys_user',
      'cmdb_ci',
      'kb_knowledge'
    ])
  })

  it('reads the table list from config and keeps only valid names', () => {
    expect(configuredTables({ tables: 'incident, sys_user bad/table' })).toEqual(['incident', 'sys_user'])
    expect(configuredTables({ tables: ['Incident', 'incident'] })).toEqual(['incident'])
    expect(configuredTables({})).toHaveLength(6)
  })

  it('discovers a stream per configured table with relations among them', async () => {
    const { runtime } = mockRuntime([])
    const streams = await runtime.streams(servicenow, connection('incident,sys_user,u_vendor'))
    expect(streams.u_vendor).toMatchObject({ label: 'SN_U_VENDOR', request: { path: '/api/now/table/u_vendor' } })
    const types = streams.incident.relations?.map((relation) => relation.type)
    expect(types).toContain('REQUESTED_BY')
    expect(types).not.toContain('AFFECTS')
  })

  it('tests the connection', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/now/table/sys_user', body: { result: [{ sys_id: 'x' }] } }])
    await runtime.test(servicenow, connection())
    expect(fetch.calls[0].url.startsWith('https://acme.service-now.com/')).toBe(true)
  })

  it('backfills a table with offset pages and UTC datetimes', async () => {
    const full = Array.from({ length: 1000 }, (_, index) => incident(index + 1))
    const { fetch, runtime } = mockRuntime([
      { path: '/api/now/table/incident', query: { sysparm_offset: '0' }, body: { result: full } },
      { path: '/api/now/table/incident', query: { sysparm_offset: '1000' }, body: { result: [incident(1001)] } }
    ])
    const batches = await readAll(runtime, servicenow, connection('incident,sys_user'), 'incident')
    expect(records(batches)).toHaveLength(1001)
    expect(fetch.calls).toHaveLength(2)
    const query = new URL(fetch.calls[0].url).searchParams
    expect(query.get('sysparm_limit')).toBe('1000')
    expect(query.get('sysparm_exclude_reference_link')).toBe('true')
    const [first] = records(batches)
    expect(first.properties).toMatchObject({ number: 'INC0000001', sys_created_on: '2024-01-01T08:00:00.000Z' })
    // cmdb_ci is not synced in this connection, so only the caller is linked; an empty reference links nothing.
    expect(first.links).toEqual([{ type: 'REQUESTED_BY', target: 'sys_user', direction: 'out', externalIds: ['usr1'] }])
    expect(batches.at(-1)!.state.cursor).toBe('2024-01-02 19:00:00')
  })

  it('filters by sys_updated_on in ServiceNow format', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/api/now/table/incident', body: { result: [] } }])
    await readAll(runtime, servicenow, connection(), 'incident', { cursor: '2024-01-10 00:00:00' })
    expect(new URL(fetch.calls[0].url).searchParams.get('sysparm_query')).toBe(
      'sys_updated_on>2024-01-09 23:58:00^ORDERBYsys_updated_on'
    )
  })
})
