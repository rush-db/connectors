import type { FieldType, RelationSpec, StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * Salesloft REST API v2.
 *
 * Lists are sorted by `updated_at` ascending and page with `page` until
 * `metadata.paging.next_page` is empty; once a cursor exists they filter with
 * `updated_at[gt]`. Related objects are `{ id, _href }` references.
 *
 * OAuth scopes are chosen on the Salesloft app, not in the authorize request.
 * Select read scopes only: people:read, accounts:read, cadences:read,
 * calls:read, emails:read, team:read. Email bodies need the privileged
 * email_contents:read scope and are not read.
 */

const ref = (type: string, target: string, field: string): RelationSpec => ({
  type,
  target,
  path: `$.${field}.id`,
  direction: 'out'
})

function list(
  path: string,
  label: string,
  description: string,
  types: Record<string, FieldType>,
  relations: RelationSpec[],
  options: { optional?: boolean; omit?: string[]; full?: boolean } = {}
): StreamSpec {
  return {
    label,
    description,
    request: { path, query: { per_page: 100, sort_by: 'updated_at', sort_direction: 'ASC' } },
    records: '$.data',
    id: '$.id',
    pagination: { type: 'cursor', next: '$.metadata.paging.next_page', param: 'page' },
    ...(options.full ?
      {}
    : {
        incremental: {
          cursorField: '$.updated_at',
          request: { query: { 'updated_at[gt]': '{{cursor|iso}}' } },
          lookbackSeconds: 60
        }
      }),
    fields: {
      // A reference `{ id, _href }` becomes `<name>_id` and `<name>_href`; the URL is dropped.
      omit: options.omit,
      types: { created_at: 'datetime', updated_at: 'datetime', ...types }
    },
    relations,
    ...(options.optional ? { optional: true } : {})
  }
}

export const salesloft = defineConnector({
  spec: {
    id: 'salesloft',
    name: 'Salesloft',
    category: 'sales',
    description: 'People, accounts, cadences, calls, emails and users from Salesloft.',
    docsUrl: 'https://developers.salesloft.com/docs/api',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://accounts.salesloft.com/oauth/authorize',
        tokenUrl: 'https://accounts.salesloft.com/oauth/token',
        // Scopes live on the app (see above); the authorize request carries none.
        scopes: [],
        pkce: false
      },
      {
        type: 'bearer',
        label: 'API key',
        help: 'Settings → API → API Keys → Create, with the read scopes only: people:read, accounts:read, cadences:read, calls:read, emails:read and team:read.'
      }
    ],
    baseUrl: 'https://api.salesloft.com',
    // 600 cost units per minute per team; deep pages cost more.
    rateLimit: { requestsPerSecond: 5 },
    test: { request: { path: '/v2/team' }, account: '$.data.name' },
    streams: {
      people: list(
        '/v2/people',
        'SALESLOFT_PERSON',
        'People (prospects and contacts).',
        { last_contacted_at: 'datetime', last_replied_at: 'datetime' },
        [ref('WORKS_AT', 'accounts', 'account'), ref('OWNED_BY', 'users', 'owner')],
        { omit: ['account_href', 'owner_href', 'last_contacted_by_href', 'import_href', 'person_stage_href'] }
      ),
      accounts: list(
        '/v2/accounts',
        'SALESLOFT_ACCOUNT',
        'Accounts (companies).',
        { last_contacted_at: 'datetime', archived_at: 'datetime' },
        [ref('OWNED_BY', 'users', 'owner')],
        { omit: ['owner_href', 'creator_href', 'company_stage_href', 'account_tier_href', 'last_contacted_by_href'] }
      ),
      cadences: list(
        '/v2/cadences',
        'SALESLOFT_CADENCE',
        'Cadences (outreach sequences).',
        { archived_at: 'datetime' },
        [ref('OWNED_BY', 'users', 'owner'), ref('CREATED_BY', 'users', 'creator')],
        { omit: ['owner_href', 'creator_href', 'updater_href', 'bridge_phone_extension'] }
      ),
      calls: list(
        '/v2/activities/calls',
        'SALESLOFT_CALL',
        'Logged calls with disposition and sentiment.',
        { duration: 'number' },
        [
          ref('MADE_BY', 'users', 'user'),
          ref('CALLED', 'people', 'called_person'),
          ref('IN_CADENCE', 'cadences', 'cadence')
        ],
        { omit: ['user_href', 'called_person_href', 'cadence_href', 'step_href', 'action_href', 'crm_activity_href', 'note_href'] }
      ),
      emails: list(
        '/v2/activities/emails',
        'SALESLOFT_EMAIL',
        'Sent emails (metadata and engagement counts, no bodies). High volume; off by default.',
        { sent_at: 'datetime' },
        [
          ref('SENT_BY', 'users', 'user'),
          ref('SENT_TO', 'people', 'recipient'),
          ref('IN_CADENCE', 'cadences', 'cadence')
        ],
        { optional: true, omit: ['user_href', 'recipient_href', 'cadence_href', 'step_href', 'action_href', 'crm_activity_href', 'mailing_href'] }
      ),
      users: list(
        '/v2/users',
        'SALESLOFT_USER',
        'Users of the Salesloft team.',
        {},
        [],
        // A small list, read in full: the users endpoint does not document an `updated_at` filter.
        { omit: ['team_href', 'group_href', 'role_href'], full: true }
      )
    }
  }
})
