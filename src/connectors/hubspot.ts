import type { StreamSpec } from '../spec'
import { defineConnector, type ConnectorHttp } from '../types'

/*
 * HubSpot CRM v3.
 *
 * A full read uses the list endpoints, which return associations
 * (`?associations=companies`) for the relations. The list endpoints cannot
 * filter by modification time, so an incremental read (a stored cursor) goes
 * through the search API sorted by the last-modified property, and the `read`
 * hook adds the associations from the v4 batch endpoint in the list shape, so
 * one set of relation paths serves both. Search stops at 10,000 results per
 * query; the hook restarts the query from the last value it saw before that.
 */

type CrmObject = {
  stream: string
  objectType: string
  label: string
  description: string
  properties: string[]
  /** Contacts keep `lastmodifieddate`; the other objects `hs_lastmodifieddate`. */
  modifiedProperty: string
  associations: string[]
  types: Record<string, 'number' | 'datetime' | 'boolean'>
  relations: NonNullable<StreamSpec['relations']>
}

const OWNER = (type: string) => ({ type, target: 'owners', path: '$.properties.hubspot_owner_id' })

const OBJECTS: CrmObject[] = [
  {
    stream: 'contacts',
    objectType: 'contacts',
    label: 'HUBSPOT_CONTACT',
    description: 'People in the CRM.',
    properties: [
      'email',
      'firstname',
      'lastname',
      'phone',
      'mobilephone',
      'jobtitle',
      'company',
      'website',
      'city',
      'state',
      'country',
      'lifecyclestage',
      'hs_lead_status',
      'hubspot_owner_id',
      'createdate',
      'lastmodifieddate'
    ],
    modifiedProperty: 'lastmodifieddate',
    associations: ['companies'],
    types: { createdate: 'datetime', lastmodifieddate: 'datetime' },
    relations: [{ type: 'WORKS_AT', target: 'companies', path: '$.associations.companies.results[*].id' }, OWNER('OWNED_BY')]
  },
  {
    stream: 'companies',
    objectType: 'companies',
    label: 'HUBSPOT_COMPANY',
    description: 'Companies in the CRM.',
    properties: [
      'name',
      'domain',
      'industry',
      'phone',
      'city',
      'state',
      'country',
      'numberofemployees',
      'annualrevenue',
      'lifecyclestage',
      'hubspot_owner_id',
      'createdate',
      'hs_lastmodifieddate'
    ],
    modifiedProperty: 'hs_lastmodifieddate',
    associations: [],
    types: {
      numberofemployees: 'number',
      annualrevenue: 'number',
      createdate: 'datetime',
      hs_lastmodifieddate: 'datetime'
    },
    relations: [OWNER('OWNED_BY')]
  },
  {
    stream: 'deals',
    objectType: 'deals',
    label: 'HUBSPOT_DEAL',
    description: 'Deals and their pipeline stage.',
    properties: [
      'dealname',
      'amount',
      'dealstage',
      'pipeline',
      'closedate',
      'dealtype',
      'hs_priority',
      'hs_is_closed',
      'hs_is_closed_won',
      'hubspot_owner_id',
      'createdate',
      'hs_lastmodifieddate'
    ],
    modifiedProperty: 'hs_lastmodifieddate',
    associations: ['companies', 'contacts'],
    types: {
      amount: 'number',
      hs_is_closed: 'boolean',
      hs_is_closed_won: 'boolean',
      closedate: 'datetime',
      createdate: 'datetime',
      hs_lastmodifieddate: 'datetime'
    },
    relations: [
      { type: 'FOR_COMPANY', target: 'companies', path: '$.associations.companies.results[*].id' },
      { type: 'INVOLVES', target: 'contacts', path: '$.associations.contacts.results[*].id' },
      OWNER('OWNED_BY')
    ]
  },
  {
    stream: 'tickets',
    objectType: 'tickets',
    label: 'HUBSPOT_TICKET',
    description: 'Support tickets.',
    properties: [
      'subject',
      'content',
      'hs_pipeline',
      'hs_pipeline_stage',
      'hs_ticket_priority',
      'hs_ticket_category',
      'source_type',
      'hubspot_owner_id',
      'createdate',
      'closed_date',
      'hs_lastmodifieddate'
    ],
    modifiedProperty: 'hs_lastmodifieddate',
    associations: ['contacts', 'companies'],
    types: { createdate: 'datetime', closed_date: 'datetime', hs_lastmodifieddate: 'datetime' },
    relations: [
      { type: 'REQUESTED_BY', target: 'contacts', path: '$.associations.contacts.results[*].id' },
      { type: 'FOR_COMPANY', target: 'companies', path: '$.associations.companies.results[*].id' },
      OWNER('ASSIGNED_TO')
    ]
  }
]

function crmStream(object: CrmObject): StreamSpec {
  return {
    label: object.label,
    description: object.description,
    request: {
      path: `/crm/v3/objects/${object.objectType}`,
      query: {
        limit: 100,
        archived: false,
        properties: object.properties.join(','),
        ...(object.associations.length ? { associations: object.associations.join(',') } : {})
      }
    },
    records: '$.results',
    id: '$.id',
    pagination: { type: 'cursor', next: '$.paging.next.after', param: 'after' },
    // The read hook runs the search API once a cursor exists.
    incremental: { cursorField: '$.updatedAt', format: 'iso', lookbackSeconds: 300 },
    fields: {
      flatten: ['$.properties'],
      omit: ['associations', 'hs_object_id'],
      types: { created_at: 'datetime', updated_at: 'datetime', ...object.types }
    },
    relations: object.relations
  }
}

const SEARCH_LIMIT = 10_000
const PAGE = 100

async function associate(http: ConnectorHttp, object: CrmObject, records: any[]) {
  for (const to of object.associations) {
    if (!records.length) {
      break
    }
    const response = await http.request({
      method: 'POST',
      url: `/crm/v4/associations/${object.objectType}/${to}/batch/read`,
      body: { inputs: records.map((record) => ({ id: String(record.id) })) }
    })
    const byId = new Map<string, Array<{ id: string }>>()
    for (const result of response.data?.results ?? []) {
      byId.set(
        String(result.from?.id),
        (result.to ?? []).map((target: any) => ({ id: String(target.toObjectId) }))
      )
    }
    for (const record of records) {
      record.associations = { ...(record.associations ?? {}), [to]: { results: byId.get(String(record.id)) ?? [] } }
    }
  }
}

async function* searchModified(http: ConnectorHttp, object: CrmObject, since: number) {
  let bound = since
  let after: string | undefined
  let offset = 0
  let maxSeen: string | undefined
  for (;;) {
    const response = await http.request({
      method: 'POST',
      url: `/crm/v3/objects/${object.objectType}/search`,
      body: {
        filterGroups: [
          { filters: [{ propertyName: object.modifiedProperty, operator: 'GTE', value: String(bound) }] }
        ],
        sorts: [{ propertyName: object.modifiedProperty, direction: 'ASCENDING' }],
        properties: object.properties,
        limit: PAGE,
        ...(after ? { after } : {})
      }
    })
    const records: any[] = response.data?.results ?? []
    await associate(http, object, records)
    for (const record of records) {
      if (typeof record.updatedAt === 'string' && (!maxSeen || record.updatedAt > maxSeen)) {
        maxSeen = record.updatedAt
      }
    }
    // Ascending order: everything up to the newest record seen is written once this batch is.
    yield { records, state: { cursor: maxSeen ?? new Date(since).toISOString() } }

    const next = response.data?.paging?.next?.after
    if (!next || !records.length) {
      return
    }
    offset += records.length
    if (offset + PAGE > SEARCH_LIMIT) {
      const last = Date.parse(records[records.length - 1]?.properties?.[object.modifiedProperty] ?? '')
      if (!Number.isFinite(last) || last <= bound) {
        throw new Error(`More than ${SEARCH_LIMIT} HubSpot ${object.objectType} share one modification time`)
      }
      bound = last
      after = undefined
      offset = 0
    } else {
      after = String(next)
    }
  }
}

export const hubspot = defineConnector({
  spec: {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'crm',
    description: 'Contacts, companies, deals, tickets and owners from HubSpot CRM, with their associations.',
    docsUrl: 'https://developers.hubspot.com/docs/api/crm/understanding-the-crm',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
        tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
        // `tickets` is HubSpot's only ticket scope; there is no read-only variant.
        scopes: [
          'crm.objects.contacts.read',
          'crm.objects.companies.read',
          'crm.objects.deals.read',
          'crm.objects.owners.read',
          'tickets'
        ],
        pkce: false
      },
      {
        type: 'bearer',
        label: 'Private app access token',
        help: 'Settings → Integrations → Private apps → Create a private app with the read scopes for contacts, companies, deals, owners and tickets; copy its access token.'
      }
    ],
    baseUrl: 'https://api.hubapi.com',
    // Search allows 5 requests per second per account; the other endpoints 100–190 per 10 seconds.
    rateLimit: { requestsPerSecond: 4 },
    test: { request: { path: '/account-info/v3/details' }, account: '$.portalId' },
    streams: {
      ...Object.fromEntries(OBJECTS.map((object) => [object.stream, crmStream(object)])),
      owners: {
        label: 'HUBSPOT_OWNER',
        description: 'Users who own CRM records.',
        request: { path: '/crm/v3/owners', query: { limit: 100 } },
        records: '$.results',
        id: '$.id',
        pagination: { type: 'cursor', next: '$.paging.next.after', param: 'after' },
        fields: { types: { createdAt: 'datetime', updatedAt: 'datetime' } }
      }
    },
    webhooks: {
      signature: { scheme: 'hubspotV3' },
      events: '$[*]',
      type: '$.subscriptionType',
      id: '$.eventId',
      objectId: '$.objectId',
      // HubSpot events carry only the object id: refetch the stream, or delete by id.
      routes: {
        'contact.deletion': { stream: 'contacts', action: 'delete' },
        'contact.privacyDeletion': { stream: 'contacts', action: 'delete' },
        'contact.*': { stream: 'contacts', action: 'refetch' },
        'company.deletion': { stream: 'companies', action: 'delete' },
        'company.*': { stream: 'companies', action: 'refetch' },
        'deal.deletion': { stream: 'deals', action: 'delete' },
        'deal.*': { stream: 'deals', action: 'refetch' },
        'ticket.deletion': { stream: 'tickets', action: 'delete' },
        'ticket.*': { stream: 'tickets', action: 'refetch' }
      },
      setup:
        'In your HubSpot developer account, open the app → Webhooks, set the target URL to the connection’s webhook URL and subscribe to creation, deletion, propertyChange and associationChange for contacts, companies, deals and tickets. Requests are signed (v3) with the app’s client secret, which is the signing secret here.'
    }
  },
  hooks: {
    read(stream, state, ctx) {
      const object = OBJECTS.find((candidate) => candidate.stream === stream.name)
      const since = state.cursor === undefined ? NaN : Date.parse(String(state.cursor))
      if (!object || !Number.isFinite(since)) {
        return undefined
      }
      const lookback = (stream.spec.incremental?.lookbackSeconds ?? 0) * 1000
      return searchModified(ctx.http, object, since - lookback)
    }
  }
})
