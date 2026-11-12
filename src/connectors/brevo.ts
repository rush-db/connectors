import { defineConnector } from '../types'

/*
 * Brevo (formerly Sendinblue) API v3.
 *
 * Contacts, companies and deals filter by `modifiedSince` once a cursor
 * exists. Contacts are read oldest-first so contacts added during a read land
 * on later pages instead of shifting earlier ones. Lists and email campaigns
 * have no modification filter (campaign dates filter sent campaigns only) and
 * are read in full; campaign HTML is left out.
 *
 * Contact, company and deal attributes are account-defined; they are
 * flattened into the record (`FIRSTNAME` → `firstname`). Deal amounts are in
 * major units.
 */

export const brevo = defineConnector({
  spec: {
    id: 'brevo',
    name: 'Brevo',
    category: 'marketing',
    description: 'Contacts, lists, email campaigns, companies and deals from Brevo.',
    docsUrl: 'https://developers.brevo.com/reference',
    auth: [
      {
        type: 'apiKey',
        label: 'API key',
        in: 'header',
        name: 'api-key',
        help: 'Brevo → SMTP & API → API keys → Generate a new API key. Brevo keys are not scoped; the connector only sends GET requests. Under Security → Authorised IPs, allow the platform’s egress IPs if IP blocking is on.'
      }
    ],
    baseUrl: 'https://api.brevo.com/v3',
    rateLimit: { requestsPerSecond: 5 },
    test: { request: { path: '/account' }, account: '$.companyName' },
    streams: {
      contacts: {
        label: 'BREVO_CONTACT',
        description: 'Contacts with their attributes, list memberships and blocklist flags.',
        request: { path: '/contacts', query: { sort: 'asc' } },
        records: '$.contacts',
        id: '$.id',
        pagination: { type: 'offset', param: 'offset', limitParam: 'limit', limit: 1000 },
        incremental: {
          cursorField: '$.modifiedAt',
          request: { query: { modifiedSince: '{{cursor|iso}}' } },
          lookbackSeconds: 60
        },
        fields: {
          flatten: ['$.attributes'],
          types: { createdAt: 'datetime', modifiedAt: 'datetime' }
        },
        relations: [{ type: 'IN_LIST', target: 'lists', path: '$.listIds[*]', direction: 'out' }]
      },
      lists: {
        label: 'BREVO_LIST',
        description: 'Contact lists with subscriber counts.',
        request: { path: '/contacts/lists', query: { sort: 'asc' } },
        records: '$.lists',
        id: '$.id',
        pagination: { type: 'offset', param: 'offset', limitParam: 'limit', limit: 50 }
      },
      email_campaigns: {
        label: 'BREVO_EMAIL_CAMPAIGN',
        description: 'Email campaigns with sender, recipients and status (no HTML).',
        request: { path: '/emailCampaigns', query: { sort: 'asc', excludeHtmlContent: true } },
        records: '$.campaigns',
        id: '$.id',
        pagination: { type: 'offset', param: 'offset', limitParam: 'limit', limit: 100 },
        fields: {
          omit: ['htmlContent', 'statistics'],
          types: { createdAt: 'datetime', modifiedAt: 'datetime', sentDate: 'datetime', scheduledAt: 'datetime' }
        },
        relations: [{ type: 'SENT_TO_LIST', target: 'lists', path: '$.recipients.lists[*]', direction: 'out' }]
      },
      companies: {
        label: 'BREVO_COMPANY',
        description: 'CRM companies with their linked contacts.',
        request: { path: '/companies', query: { sort: 'asc', sortBy: 'created_at' } },
        records: '$.items',
        id: '$.id',
        pagination: { type: 'page', param: 'page', sizeParam: 'limit', size: 100, start: 1 },
        incremental: {
          cursorField: '$.attributes.last_updated_at',
          request: { query: { modifiedSince: '{{cursor|iso}}' } },
          lookbackSeconds: 60
        },
        fields: {
          flatten: ['$.attributes'],
          omit: ['linkedContactsIds', 'linkedDealsIds'],
          types: { created_at: 'datetime', last_updated_at: 'datetime', owner_assign_date: 'datetime' }
        },
        relations: [{ type: 'HAS_CONTACT', target: 'contacts', path: '$.linkedContactsIds[*]', direction: 'out' }],
        optional: true
      },
      deals: {
        label: 'BREVO_DEAL',
        description: 'CRM deals with their pipeline stage, linked contacts and companies.',
        request: { path: '/crm/deals', query: { sort: 'asc', sortBy: 'created_at' } },
        records: '$.items',
        id: '$.id',
        pagination: { type: 'offset', param: 'offset', limitParam: 'limit', limit: 50 },
        incremental: {
          cursorField: '$.attributes.last_updated_date',
          request: { query: { modifiedSince: '{{cursor|iso}}' } },
          lookbackSeconds: 60
        },
        fields: {
          flatten: ['$.attributes'],
          omit: ['linkedContactsIds', 'linkedCompaniesIds'],
          types: {
            amount: 'number',
            created_at: 'datetime',
            last_updated_date: 'datetime',
            stage_updated_at: 'datetime',
            close_date: 'datetime'
          }
        },
        relations: [
          { type: 'INVOLVES', target: 'contacts', path: '$.linkedContactsIds[*]', direction: 'out' },
          { type: 'FOR_COMPANY', target: 'companies', path: '$.linkedCompaniesIds[*]', direction: 'out' }
        ],
        optional: true
      }
    }
  }
})
