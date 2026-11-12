import { defineConnector } from '../types'

/*
 * Zendesk Support. Tickets and users use the cursor-based incremental export
 * (`start_time` on the first request, then `after_url` until `end_of_stream`);
 * organizations the time-based export (`next_page` until `end_of_stream`).
 * Export endpoints allow about 10 requests a minute; the runtime waits out
 * 429 responses using `Retry-After`. Ticket comments are not synced (they
 * need one request per ticket).
 */

const DATES = { created_at: 'datetime', updated_at: 'datetime' } as const

export const zendesk = defineConnector({
  spec: {
    id: 'zendesk',
    name: 'Zendesk',
    category: 'support',
    description: 'Tickets, users (requesters and agents), organizations and groups from Zendesk Support.',
    docsUrl: 'https://developer.zendesk.com/api-reference/',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://{{config.subdomain}}.zendesk.com/oauth/authorizations/new',
        tokenUrl: 'https://{{config.subdomain}}.zendesk.com/oauth/tokens',
        scopes: ['read']
      },
      {
        type: 'basic',
        usernameLabel: 'Email address followed by /token',
        passwordLabel: 'API token',
        help: 'Admin Center → Apps and integrations → APIs → Zendesk API → Add API token. Username is `you@company.com/token`, password is the token. Use an agent whose role can read every ticket.'
      }
    ],
    config: {
      subdomain: {
        label: 'Subdomain',
        placeholder: 'acme',
        help: 'The part before .zendesk.com in your Zendesk URL.'
      }
    },
    baseUrl: 'https://{{config.subdomain}}.zendesk.com',
    rateLimit: { requestsPerSecond: 1 },
    test: { request: { path: '/api/v2/users/me' }, account: '$.user.email' },
    streams: {
      tickets: {
        label: 'ZENDESK_TICKET',
        description: 'Tickets, deleted ones as tombstones.',
        request: { path: '/api/v2/incremental/tickets/cursor.json', query: { start_time: 0, per_page: 1000 } },
        records: '$.tickets',
        id: '$.id',
        pagination: { type: 'nextUrl', next: '$.after_url', done: '$.end_of_stream' },
        incremental: {
          cursorField: '$.updated_at',
          format: 'iso',
          request: { query: { start_time: '{{cursor|unix}}' } },
          lookbackSeconds: 120
        },
        deleted: { path: '$.status', value: 'deleted' },
        fields: {
          omit: ['url', 'via', 'satisfaction_rating', 'custom_fields', 'fields'],
          types: { ...DATES, due_at: 'datetime' }
        },
        relations: [
          { type: 'REQUESTED_BY', target: 'users', path: '$.requester_id' },
          { type: 'ASSIGNED_TO', target: 'users', path: '$.assignee_id' },
          { type: 'FOR_ORGANIZATION', target: 'organizations', path: '$.organization_id' },
          { type: 'ASSIGNED_TO_GROUP', target: 'groups', path: '$.group_id' }
        ]
      },
      users: {
        label: 'ZENDESK_USER',
        description: 'End users, agents and admins.',
        request: { path: '/api/v2/incremental/users/cursor.json', query: { start_time: 0, per_page: 1000 } },
        records: '$.users',
        id: '$.id',
        pagination: { type: 'nextUrl', next: '$.after_url', done: '$.end_of_stream' },
        incremental: {
          cursorField: '$.updated_at',
          format: 'iso',
          request: { query: { start_time: '{{cursor|unix}}' } },
          lookbackSeconds: 120
        },
        fields: { omit: ['url', 'photo'], types: { ...DATES, last_login_at: 'datetime' } },
        relations: [
          { type: 'BELONGS_TO', target: 'organizations', path: '$.organization_id' },
          { type: 'MEMBER_OF', target: 'groups', path: '$.default_group_id' }
        ]
      },
      organizations: {
        label: 'ZENDESK_ORGANIZATION',
        description: 'Customer organizations.',
        request: { path: '/api/v2/incremental/organizations.json', query: { start_time: 0 } },
        records: '$.organizations',
        id: '$.id',
        pagination: { type: 'nextUrl', next: '$.next_page', done: '$.end_of_stream' },
        incremental: {
          cursorField: '$.updated_at',
          format: 'iso',
          request: { query: { start_time: '{{cursor|unix}}' } },
          lookbackSeconds: 120
        },
        fields: { omit: ['url'], types: DATES }
      },
      groups: {
        label: 'ZENDESK_GROUP',
        description: 'Agent groups.',
        request: { path: '/api/v2/groups', query: { 'page[size]': 100 } },
        records: '$.groups',
        id: '$.id',
        pagination: { type: 'nextUrl', next: '$.links.next' },
        deleted: { path: '$.deleted', value: true },
        fields: { omit: ['url'], types: DATES }
      }
    },
    webhooks: {
      // Zendesk signs `timestamp + body` with the webhook's signing secret, base64.
      signature: {
        scheme: 'hmacSha256',
        header: 'X-Zendesk-Webhook-Signature',
        timestampHeader: 'X-Zendesk-Webhook-Signature-Timestamp',
        encoding: 'base64'
      },
      type: '$.type',
      id: '$.id',
      objectId: '$.detail.id',
      routes: {
        'zen:event-type:ticket.permanently_deleted': { stream: 'tickets', action: 'delete' },
        'zen:event-type:ticket.*': { stream: 'tickets', action: 'refetch' },
        'zen:event-type:user.deleted': { stream: 'users', action: 'delete' },
        'zen:event-type:user.*': { stream: 'users', action: 'refetch' },
        'zen:event-type:organization.deleted': { stream: 'organizations', action: 'delete' },
        'zen:event-type:organization.*': { stream: 'organizations', action: 'refetch' }
      },
      setup:
        'Admin Center → Apps and integrations → Webhooks → Create webhook → Zendesk events: pick the ticket, user and organization events, endpoint = the connection’s webhook URL, method POST, format JSON. After creating it, reveal the signing secret and paste it here.'
    }
  }
})
