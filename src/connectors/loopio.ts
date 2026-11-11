import { defineConnector } from '../types'

/*
 * Loopio public API v2 (US or EU data center, from config).
 *
 * Loopio's OAuth server issues tokens through the authorization-code grant
 * (with PKCE) as well as client credentials; the connector uses the
 * authorization code, so the runtime's OAuth flow and refresh apply.
 *
 * Library entries filter by `lastUpdatedDate` through the JSON `filter` query
 * parameter. An empty `language` lists entries in every language (Loopio
 * otherwise narrows the list). Projects and users have no modification-time
 * filter that their records can carry a cursor for, so they are read in full.
 * Confidential projects are not available through the API.
 */

export const loopio = defineConnector({
  spec: {
    id: 'loopio',
    name: 'Loopio',
    category: 'documents',
    description: 'RFP response library entries, projects and users from Loopio.',
    docsUrl: 'https://developer.loopio.com',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://{{config.host}}/oauth2/authorize',
        tokenUrl: 'https://{{config.host}}/oauth2/access_token',
        scopes: ['library:read', 'project:read', 'user:read'],
        clientAuth: 'basic',
        pkce: true
      }
    ],
    config: {
      host: {
        label: 'Data center',
        type: 'select',
        options: [
          { value: 'api.loopio.com', label: 'North America' },
          { value: 'api.eu.loopio.com', label: 'Europe' }
        ],
        default: 'api.loopio.com'
      }
    },
    baseUrl: 'https://{{config.host}}/data/v2',
    // 100 calls per minute.
    rateLimit: { requestsPerSecond: 1.5 },
    test: { request: { path: '/identify/me' }, account: '$.customerName' },
    streams: {
      library_entries: {
        label: 'LOOPIO_ENTRY',
        description: 'Library entries: questions, the approved answer, location (stack, category), tags and review state.',
        request: { path: '/libraryEntries', query: { filter: '{"language":""}' } },
        records: '$.items',
        id: '$.id',
        pagination: { type: 'page', param: 'page', sizeParam: 'pageSize', size: 200, start: 1 },
        incremental: {
          cursorField: '$.lastUpdatedDate',
          request: { query: { filter: '{"language":"","lastUpdatedDate":{"gte":"{{cursor|iso}}"}}' } },
          lookbackSeconds: 60
        },
        fields: {
          // Inline image URLs expire after ten minutes.
          omit: ['InlineImages'],
          types: { createdDate: 'datetime', lastUpdatedDate: 'datetime', lastReviewedDate: 'datetime' },
          // `location.stack.name` → `location_stack_name`; questions and footnotes stay JSON.
          nestedDepth: 3
        },
        relations: [
          { type: 'CREATED_BY', target: 'users', path: '$.creator.id', direction: 'out' },
          { type: 'OWNED_BY', target: 'users', path: '$.libraryEntryOwner.id', direction: 'out' }
        ]
      },
      projects: {
        label: 'LOOPIO_PROJECT',
        description: 'RFP, RFI, DDQ and security questionnaire projects with status and due date.',
        request: { path: '/projects' },
        records: '$.items',
        id: '$.id',
        pagination: { type: 'page', param: 'page', sizeParam: 'pageSize', size: 100, start: 1 },
        fields: { types: { createdDate: 'datetime', dueDate: 'datetime' } },
        relations: [
          { type: 'OWNED_BY', target: 'users', path: '$.owner.id', direction: 'out' },
          { type: 'CREATED_BY', target: 'users', path: '$.creator.id', direction: 'out' }
        ]
      },
      users: {
        label: 'LOOPIO_USER',
        description: 'Loopio users who own and write entries and projects.',
        request: { path: '/users', query: { sortBy: 'id', sortDirection: 'asc' } },
        records: '$.items',
        id: '$.id',
        pagination: { type: 'page', param: 'page', sizeParam: 'pageSize', size: 100, start: 1 }
      }
    }
  }
})
