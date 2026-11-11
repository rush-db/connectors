import type { StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * Pipedrive API v2 (users stay on v1, which has no v2 list yet). v2 lists page
 * with `cursor`/`additional_data.next_cursor` and filter by `updated_since`,
 * so persons, organizations, deals and activities read incrementally.
 */

const DATES = { add_time: 'datetime', update_time: 'datetime' } as const

function v2(
  path: string,
  label: string,
  description: string,
  extra: Omit<Partial<StreamSpec>, 'incremental'> & { incremental?: boolean } = {}
): StreamSpec {
  const { incremental, ...rest } = extra
  return {
    label,
    description,
    request: {
      path,
      query: { limit: 500, ...(incremental ? { sort_by: 'update_time', sort_direction: 'asc' } : {}) }
    },
    records: '$.data',
    id: '$.id',
    pagination: { type: 'cursor', next: '$.additional_data.next_cursor', param: 'cursor' },
    ...(incremental ?
      {
        incremental: {
          cursorField: '$.update_time',
          format: 'iso' as const,
          request: { query: { updated_since: '{{cursor|iso}}' } },
          lookbackSeconds: 60
        }
      }
    : {}),
    fields: { types: DATES, nestedDepth: 2 },
    ...rest
  }
}

export const pipedrive = defineConnector({
  spec: {
    id: 'pipedrive',
    name: 'Pipedrive',
    category: 'crm',
    description: 'Persons, organizations, deals, activities, users, pipelines and stages from Pipedrive.',
    docsUrl: 'https://developers.pipedrive.com/docs/api/v1',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://oauth.pipedrive.com/oauth/authorize',
        tokenUrl: 'https://oauth.pipedrive.com/oauth/token',
        scopes: ['base', 'deals:read', 'contacts:read', 'activities:read', 'users:read'],
        pkce: false,
        clientAuth: 'basic',
        // OAuth calls go to the company domain the token response names.
        keepTokenFields: ['api_domain'],
        baseUrl: '{{credentials.api_domain}}'
      },
      {
        type: 'apiKey',
        label: 'API token',
        help: 'Personal preferences → API in Pipedrive. The token acts as you: use a user with read-only visibility where possible.',
        in: 'header',
        name: 'x-api-token'
      }
    ],
    baseUrl: 'https://api.pipedrive.com',
    rateLimit: { requestsPerSecond: 8 },
    test: { request: { path: '/api/v1/users/me' }, account: '$.data.company_name' },
    streams: {
      persons: v2('/api/v2/persons', 'PIPEDRIVE_PERSON', 'Contacts (people).', {
        incremental: true,
        relations: [
          { type: 'WORKS_AT', target: 'organizations', path: '$.org_id' },
          { type: 'OWNED_BY', target: 'users', path: '$.owner_id' }
        ]
      }),
      organizations: v2('/api/v2/organizations', 'PIPEDRIVE_ORGANIZATION', 'Companies.', {
        incremental: true,
        relations: [{ type: 'OWNED_BY', target: 'users', path: '$.owner_id' }]
      }),
      deals: v2('/api/v2/deals', 'PIPEDRIVE_DEAL', 'Deals with value, stage and status.', {
        incremental: true,
        relations: [
          { type: 'INVOLVES', target: 'persons', path: '$.person_id' },
          { type: 'FOR_ORGANIZATION', target: 'organizations', path: '$.org_id' },
          { type: 'OWNED_BY', target: 'users', path: '$.owner_id' },
          { type: 'IN_STAGE', target: 'stages', path: '$.stage_id' },
          { type: 'IN_PIPELINE', target: 'pipelines', path: '$.pipeline_id' }
        ]
      }),
      activities: v2('/api/v2/activities', 'PIPEDRIVE_ACTIVITY', 'Calls, meetings, tasks and other activities.', {
        incremental: true,
        relations: [
          { type: 'FOR_DEAL', target: 'deals', path: '$.deal_id' },
          { type: 'INVOLVES', target: 'persons', path: '$.participants[*].person_id' },
          { type: 'FOR_ORGANIZATION', target: 'organizations', path: '$.org_id' },
          { type: 'ASSIGNED_TO', target: 'users', path: '$.owner_id' }
        ]
      }),
      users: {
        label: 'PIPEDRIVE_USER',
        description: 'Users of the Pipedrive company.',
        request: { path: '/api/v1/users' },
        records: '$.data',
        id: '$.id',
        fields: { types: { created: 'datetime', modified: 'datetime', last_login: 'datetime' } }
      },
      pipelines: v2('/api/v2/pipelines', 'PIPEDRIVE_PIPELINE', 'Sales pipelines.'),
      stages: v2('/api/v2/stages', 'PIPEDRIVE_STAGE', 'Stages of the pipelines.', {
        relations: [{ type: 'BELONGS_TO', target: 'pipelines', path: '$.pipeline_id' }]
      })
    },
    webhooks: {
      // v2 webhooks are not signed; Pipedrive sends the HTTP basic credentials set on the webhook.
      signature: { scheme: 'sharedSecret', header: 'Authorization' },
      type: '$.meta.entity',
      typeSuffix: '$.meta.action',
      id: '$.meta.id',
      object: '$.data',
      objectId: '$.meta.entity_id',
      routes: {
        'person.delete': { stream: 'persons', action: 'delete' },
        'person.*': { stream: 'persons', action: 'upsert' },
        'organization.delete': { stream: 'organizations', action: 'delete' },
        'organization.*': { stream: 'organizations', action: 'upsert' },
        'deal.delete': { stream: 'deals', action: 'delete' },
        'deal.*': { stream: 'deals', action: 'upsert' },
        'activity.delete': { stream: 'activities', action: 'delete' },
        'activity.*': { stream: 'activities', action: 'upsert' },
        'user.*': { stream: 'users', action: 'refetch' },
        'pipeline.*': { stream: 'pipelines', action: 'refetch' },
        'stage.*': { stream: 'stages', action: 'refetch' }
      },
      setup:
        'Pipedrive → Tools and apps → Webhooks → Create new webhook (version 2.0): event action `*`, event object `*`, endpoint URL = the connection’s webhook URL. Set an HTTP auth username and password and enter them here as `username:password`; Pipedrive does not sign deliveries, so these credentials are the only proof they come from Pipedrive.'
    }
  }
})
