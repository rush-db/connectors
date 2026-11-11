import type { FieldType, RelationSpec, StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * Planhat REST API.
 *
 * Lists page with `limit`/`offset` and sort by `_id` here, so a page boundary
 * does not move while the read runs. No incremental cursor: the list
 * endpoints filter by company id, email or archived state but not by
 * modification time (`updatedAt` / `lastUpdated` are returned, not
 * filterable), so each run re-reads in full.
 *
 * Amounts (`mrr`, `arr`, license `value`) are in major units already.
 */

const PAGE = 1000

function list(
  path: string,
  label: string,
  description: string,
  types: Record<string, FieldType>,
  relations: RelationSpec[] = [],
  options: { optional?: boolean; query?: Record<string, string | number | boolean> } = {}
): StreamSpec {
  return {
    label,
    description,
    request: { path, query: { sort: '_id', ...(options.query ?? {}) } },
    records: '$',
    id: '$._id',
    pagination: { type: 'offset', param: 'offset', limitParam: 'limit', limit: PAGE },
    fields: { types: { createDate: 'datetime', updatedAt: 'datetime', ...types } },
    relations,
    ...(options.optional ? { optional: true } : {})
  }
}

export const planhat = defineConnector({
  spec: {
    id: 'planhat',
    name: 'Planhat',
    category: 'customer-success',
    description: 'Companies, end users, licenses, conversations and team members from Planhat.',
    docsUrl: 'https://www.planhat.com/developers/api/introduction',
    auth: [
      {
        type: 'bearer',
        label: 'API access token',
        help: 'Settings → Service Accounts → add a service account with read-only permissions on Companies, End Users, Licenses, Conversations and Users, then generate its token.'
      }
    ],
    baseUrl: 'https://api.planhat.com',
    // A soft quota of 200 calls per minute on the main API.
    rateLimit: { requestsPerSecond: 3 },
    test: { request: { path: '/companies', query: { limit: 1, select: '_id' } } },
    streams: {
      companies: list(
        '/companies',
        'PLANHAT_COMPANY',
        'Customer companies with health, phase and revenue.',
        { lastUpdated: 'datetime', phaseSince: 'datetime', renewalDate: 'datetime', mrr: 'number', arr: 'number' },
        [
          { type: 'OWNED_BY', target: 'users', path: '$.owner', direction: 'out' },
          { type: 'CO_OWNED_BY', target: 'users', path: '$.coOwner', direction: 'out' }
        ]
      ),
      endusers: list(
        '/endusers',
        'PLANHAT_ENDUSER',
        'People at customer companies.',
        { lastActive: 'datetime', lastTouch: 'datetime' },
        [{ type: 'WORKS_AT', target: 'companies', path: '$.companyId', direction: 'out' }]
      ),
      licenses: list(
        '/licenses',
        'PLANHAT_LICENSE',
        'Licenses (recurring revenue items) of the companies.',
        { fromDate: 'datetime', toDate: 'datetime', mrr: 'number', value: 'number' },
        [{ type: 'FOR_COMPANY', target: 'companies', path: '$.companyId', direction: 'out' }]
      ),
      conversations: list(
        '/conversations',
        'PLANHAT_CONVERSATION',
        'Emails, calls, meetings and notes logged on companies (message bodies included).',
        { date: 'datetime' },
        [
          { type: 'FOR_COMPANY', target: 'companies', path: '$.companyId', direction: 'out' },
          { type: 'INVOLVES', target: 'endusers', path: '$.endusers[*]', direction: 'out' },
          { type: 'HANDLED_BY', target: 'users', path: '$.users[*]', direction: 'out' }
        ],
        { optional: true }
      ),
      users: list('/users', 'PLANHAT_USER', 'Planhat team members who own companies and conversations.', {
        lastVisit: 'datetime'
      })
    }
  }
})
