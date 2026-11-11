import type { StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * Intercom REST API (version pinned in a header). Contacts and conversations
 * list in full with `starting_after`; once a cursor exists they go through
 * the search endpoints (`updated_at > cursor`, ascending), which page with
 * `pagination.starting_after` in the body. Companies page by number (the
 * list endpoint stops at 10,000 companies).
 */

const INTERCOM_VERSION = '2.11'

function searchable(
  resource: 'contacts' | 'conversations',
  records: string,
  stream: Omit<StreamSpec, 'request' | 'records' | 'pagination' | 'incremental'>
): StreamSpec {
  return {
    ...stream,
    request: { path: `/${resource}`, query: { per_page: 150 } },
    records,
    pagination: { type: 'cursor', next: '$.pages.next.starting_after', param: 'starting_after' },
    incremental: {
      cursorField: '$.updated_at',
      format: 'unix',
      request: {
        method: 'POST',
        path: `/${resource}/search`,
        query: {},
        body: {
          query: { field: 'updated_at', operator: '>', value: '{{cursor|unix}}' },
          sort: { field: 'updated_at', order: 'ascending' },
          pagination: { per_page: 150 }
        }
      },
      pagination: {
        type: 'cursor',
        next: '$.pages.next.starting_after',
        param: 'pagination.starting_after',
        in: 'body'
      },
      lookbackSeconds: 60
    }
  }
}

export const intercom = defineConnector({
  spec: {
    id: 'intercom',
    name: 'Intercom',
    category: 'support',
    description: 'Contacts (users and leads), companies, conversations, admins and tags from Intercom.',
    docsUrl: 'https://developers.intercom.com/docs/references/rest-api/api.intercom.io',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://app.intercom.com/oauth',
        tokenUrl: 'https://api.intercom.io/auth/eagle/token',
        // Intercom sets permissions on the app, not per request: enable only the "Read" ones
        // (users and companies, conversations, admins, tags).
        scopes: [],
        pkce: false
      },
      {
        type: 'bearer',
        label: 'Access token',
        help: 'Developer Hub → your app → Authentication: the access token of an app with read permissions only.'
      }
    ],
    baseUrl: 'https://api.intercom.io',
    headers: { 'Intercom-Version': INTERCOM_VERSION },
    rateLimit: { requestsPerSecond: 10 },
    test: { request: { path: '/me' }, account: '$.app.name' },
    streams: {
      contacts: searchable('contacts', '$.data', {
        label: 'INTERCOM_CONTACT',
        description: 'Users and leads.',
        id: '$.id',
        fields: {
          // Intercom's `external_id` is the customer's own user id; `external_id` is ours.
          rename: { external_id: 'user_external_id' },
          omit: [
            'type',
            'tags',
            'companies',
            'notes',
            'social_profiles',
            'opted_in_subscription_types',
            'opted_out_subscription_types'
          ],
          types: {
            created_at: 'unix',
            updated_at: 'unix',
            signed_up_at: 'unix',
            last_seen_at: 'unix',
            last_replied_at: 'unix',
            last_contacted_at: 'unix',
            last_email_opened_at: 'unix',
            last_email_clicked_at: 'unix'
          }
        },
        relations: [
          { type: 'WORKS_AT', target: 'companies', path: '$.companies.data[*].id' },
          { type: 'OWNED_BY', target: 'admins', path: '$.owner_id' },
          { type: 'TAGGED', target: 'tags', path: '$.tags.data[*].id' }
        ]
      }),
      companies: {
        label: 'INTERCOM_COMPANY',
        description: 'Companies.',
        request: { path: '/companies' },
        records: '$.data',
        id: '$.id',
        pagination: { type: 'page', param: 'page', sizeParam: 'per_page', size: 60, start: 1 },
        fields: {
          omit: ['type', 'tags', 'segments'],
          types: { created_at: 'unix', updated_at: 'unix', last_request_at: 'unix', remote_created_at: 'unix' }
        },
        relations: [{ type: 'TAGGED', target: 'tags', path: '$.tags.tags[*].id' }]
      },
      conversations: searchable('conversations', '$.conversations', {
        label: 'INTERCOM_CONVERSATION',
        description: 'Conversations with their state, source message and statistics.',
        id: '$.id',
        fields: {
          omit: ['type', 'contacts', 'teammates', 'tags', 'conversation_parts'],
          types: { created_at: 'unix', updated_at: 'unix', waiting_since: 'unix', snoozed_until: 'unix' }
        },
        relations: [
          { type: 'REQUESTED_BY', target: 'contacts', path: '$.contacts.contacts[*].id' },
          { type: 'ASSIGNED_TO', target: 'admins', path: '$.admin_assignee_id' },
          { type: 'TAGGED', target: 'tags', path: '$.tags.tags[*].id' }
        ]
      }),
      admins: {
        label: 'INTERCOM_ADMIN',
        description: 'Teammates.',
        request: { path: '/admins' },
        records: '$.admins',
        id: '$.id',
        fields: { omit: ['type', 'avatar'] }
      },
      tags: {
        label: 'INTERCOM_TAG',
        description: 'Tags.',
        request: { path: '/tags' },
        records: '$.data',
        id: '$.id',
        fields: { omit: ['type'] }
      }
    },
    webhooks: {
      // Intercom signs the body with the app's client secret, HMAC-SHA1, `sha1=<hex>`.
      signature: { scheme: 'hmacSha256', header: 'X-Hub-Signature', prefix: 'sha1=', algorithm: 'sha1' },
      type: '$.topic',
      id: '$.id',
      object: '$.data.item',
      routes: {
        'contact.deleted': { stream: 'contacts', action: 'delete' },
        'contact.user.tag.*': { stream: 'contacts', action: 'refetch' },
        'contact.lead.tag.*': { stream: 'contacts', action: 'refetch' },
        'contact.*': { stream: 'contacts', action: 'upsert' },
        'company.deleted': { stream: 'companies', action: 'delete' },
        'company.contact.*': { stream: 'contacts', action: 'refetch' },
        'company.*': { stream: 'companies', action: 'upsert' },
        'conversation.deleted': { stream: 'conversations', action: 'delete' },
        'conversation.*': { stream: 'conversations', action: 'upsert' }
      },
      setup:
        'Developer Hub → your app → Webhooks: endpoint URL = the connection’s webhook URL; subscribe to the contact, company and conversation topics. Deliveries are signed with the app’s client secret (Basic information page), which is the signing secret here.'
    }
  }
})
