import type { StreamSpec } from '../spec'
import { toDate } from '../runtime/template'
import { defineConnector, type ConnectionContext, type ConnectorHttp, type StreamState } from '../types'

/*
 * DocuSign eSignature REST API v2.1.
 *
 * The API host differs per account (`https://na3.docusign.net`, …). The
 * OAuth server (production or developer, from config) tells it at
 * `/oauth/userinfo`, so the spec's base URL is the OAuth server and the
 * `discover` hook resolves the account once per connection and rewrites the
 * stream paths to absolute URLs on the account's host. The account is the one
 * in config, or the user's default account.
 *
 * Envelopes are listed with `from_date` and the default `from_to_status=changed`,
 * so an incremental read gets every envelope changed since the cursor (the
 * newest `lastModifiedDateTime` seen). A full read starts from 2000-01-01:
 * without `from_date` DocuSign returns the last two years only. Pages are
 * ordered by creation, which a change during the read does not reorder.
 *
 * Recipients are not a list endpoint: the `read` hook lists envelopes with
 * `include=recipients` and yields one record per recipient.
 *
 * DocuSign has no read-only OAuth scope: `signature` grants the eSignature
 * API. Connect with a user whose DocuSign permission profile cannot send or
 * change envelopes.
 */

const API = '/restapi/v2.1/accounts/{{config.accountId}}'
const EPOCH = '2000-01-01T00:00:00Z'
const PAGE = 100

type Account = { accountId: string; baseUri: string; name?: string }

const accounts = new WeakMap<ConnectionContext, Account>()

const docusignHost = (uri: string) => {
  try {
    const url = new URL(uri)
    return url.protocol === 'https:' && /(^|\.)docusign\.(net|com)$/.test(url.hostname)
  } catch {
    return false
  }
}

async function resolveAccount(http: ConnectorHttp, connection: ConnectionContext): Promise<Account> {
  const cached = accounts.get(connection)
  if (cached) {
    return cached
  }
  const { data } = await http.request({ url: '/oauth/userinfo' })
  const list: any[] = Array.isArray(data?.accounts) ? data.accounts : []
  const wanted = String(connection.config.accountId ?? '').trim()
  const account =
    wanted ?
      list.find((candidate) => String(candidate.account_id) === wanted)
    : (list.find((candidate) => candidate.is_default === true || candidate.is_default === 'true') ?? list[0])
  if (!account) {
    throw new Error(wanted ? `DocuSign account ${wanted} is not available to this user` : 'This DocuSign user has no account')
  }
  // The token goes to this host: accept DocuSign hosts only.
  if (!docusignHost(String(account.base_uri))) {
    throw new Error(`DocuSign returned an unexpected API host for account ${account.account_id}`)
  }
  const resolved = {
    accountId: String(account.account_id),
    baseUri: String(account.base_uri).replace(/\/$/, ''),
    name: account.account_name
  }
  accounts.set(connection, resolved)
  return resolved
}

const offset = { type: 'offset', param: 'start_position', limitParam: 'count', limit: PAGE } as const

function streams(api: string): Record<string, StreamSpec> {
  return {
    envelopes: {
      label: 'DOCUSIGN_ENVELOPE',
      description: 'Envelopes in every status, with sender and status times.',
      request: {
        path: `${api}/envelopes`,
        query: { from_date: EPOCH, order_by: 'created', order: 'asc' }
      },
      records: '$.envelopes',
      id: '$.envelopeId',
      pagination: offset,
      incremental: {
        cursorField: '$.lastModifiedDateTime',
        request: { query: { from_date: '{{cursor|iso}}' } },
        lookbackSeconds: 300
      },
      fields: {
        omit: [
          'envelopeUri',
          'recipientsUri',
          'documentsUri',
          'documentsCombinedUri',
          'certificateUri',
          'notificationUri',
          'attachmentsUri',
          'customFieldsUri',
          'templatesUri',
          'envelopeLocation',
          'purgeState'
        ],
        types: {
          createdDateTime: 'datetime',
          sentDateTime: 'datetime',
          deliveredDateTime: 'datetime',
          completedDateTime: 'datetime',
          declinedDateTime: 'datetime',
          voidedDateTime: 'datetime',
          lastModifiedDateTime: 'datetime',
          statusChangedDateTime: 'datetime',
          expireDateTime: 'datetime'
        }
      },
      relations: [{ type: 'SENT_BY', target: 'users', path: '$.sender.userId', direction: 'out' }]
    },
    recipients: {
      label: 'DOCUSIGN_RECIPIENT',
      description: 'Signers, carbon copies and other recipients of each envelope, with their status (names and emails).',
      // Read by the hook: envelopes with their recipients, one record per recipient.
      request: {
        path: `${api}/envelopes`,
        query: { from_date: EPOCH, order_by: 'created', order: 'asc', include: 'recipients' }
      },
      records: '$.envelopes',
      id: '$.recipientIdGuid',
      pagination: offset,
      incremental: {
        cursorField: '$.envelopeLastModifiedDateTime',
        request: { query: { from_date: '{{cursor|iso}}' } },
        lookbackSeconds: 300
      },
      fields: {
        omit: ['tabs', 'envelopeLastModifiedDateTime'],
        types: {
          sentDateTime: 'datetime',
          deliveredDateTime: 'datetime',
          signedDateTime: 'datetime',
          declinedDateTime: 'datetime',
          routingOrder: 'number'
        }
      },
      relations: [
        { type: 'RECIPIENT_OF', target: 'envelopes', path: '$.envelopeId', direction: 'out' },
        { type: 'IS_USER', target: 'users', path: '$.userId', direction: 'out' }
      ]
    },
    templates: {
      label: 'DOCUSIGN_TEMPLATE',
      description: 'Envelope templates.',
      request: { path: `${api}/templates`, query: { order_by: 'modified', order: 'asc' } },
      records: '$.envelopeTemplates',
      id: '$.templateId',
      pagination: offset,
      incremental: {
        cursorField: '$.lastModified',
        request: { query: { modified_from_date: '{{cursor|iso}}' } },
        lookbackSeconds: 300
      },
      fields: { omit: ['uri', 'folderUri'], types: { created: 'datetime', lastModified: 'datetime', lastUsed: 'datetime' } },
      relations: [{ type: 'OWNED_BY', target: 'users', path: '$.owner.userId', direction: 'out' }],
      optional: true
    },
    users: {
      label: 'DOCUSIGN_USER',
      description: 'Users of the account.',
      request: { path: `${api}/users` },
      records: '$.users',
      id: '$.userId',
      pagination: offset,
      fields: { omit: ['uri'], types: { createdDateTime: 'datetime', lastLogin: 'datetime' } }
    }
  }
}

const RECIPIENT_GROUPS = [
  'signers',
  'carbonCopies',
  'certifiedDeliveries',
  'agents',
  'editors',
  'intermediaries',
  'inPersonSigners',
  'witnesses',
  'seals',
  'notaries'
]

async function* readRecipients(
  http: ConnectorHttp,
  spec: { request: { path: string; query?: Record<string, unknown> }; incremental?: { lookbackSeconds: number } },
  state: StreamState
) {
  const since = state.cursor === undefined ? undefined : toDate(state.cursor)
  const lookback = (spec.incremental?.lookbackSeconds ?? 0) * 1000
  const query: Record<string, string | number> = {
    ...(spec.request.query as Record<string, string | number>),
    ...(since ? { from_date: new Date(since.getTime() - lookback).toISOString() } : {}),
    count: PAGE
  }
  let maxModified = state.cursor
  for (let start = 0; ; start += PAGE) {
    const { data } = await http.request({ url: spec.request.path, query: { ...query, start_position: start } })
    const envelopes: any[] = Array.isArray(data?.envelopes) ? data.envelopes : []
    const records: unknown[] = []
    for (const envelope of envelopes) {
      const modified = envelope.lastModifiedDateTime
      if (typeof modified === 'string' && (maxModified === undefined || Date.parse(modified) > Date.parse(String(maxModified)))) {
        maxModified = modified
      }
      for (const group of RECIPIENT_GROUPS) {
        for (const recipient of envelope.recipients?.[group] ?? []) {
          records.push({
            ...recipient,
            recipientGroup: group,
            envelopeId: envelope.envelopeId,
            envelopeLastModifiedDateTime: modified
          })
        }
      }
    }
    const last = envelopes.length < PAGE || !data?.nextUri
    // Pages come in creation order: the cursor moves only once every page is written.
    yield { records, state: { cursor: last ? maxModified : state.cursor } }
    if (last) {
      return
    }
  }
}

export const docusign = defineConnector({
  spec: {
    id: 'docusign',
    name: 'DocuSign',
    category: 'documents',
    description: 'Envelopes, recipients, templates and users from DocuSign eSignature.',
    docsUrl: 'https://developers.docusign.com/docs/esign-rest-api/reference/',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://{{config.environment}}/oauth/auth',
        tokenUrl: 'https://{{config.environment}}/oauth/token',
        // No read-only scope exists; `extended` keeps the refresh token valid while it is used.
        scopes: ['signature', 'extended'],
        clientAuth: 'basic',
        pkce: true
      }
    ],
    config: {
      environment: {
        label: 'Environment',
        type: 'select',
        options: [
          { value: 'account.docusign.com', label: 'Production' },
          { value: 'account-d.docusign.com', label: 'Developer (demo)' }
        ],
        default: 'account.docusign.com'
      },
      accountId: {
        label: 'Account ID',
        required: false,
        help: 'The API account ID (a GUID, under Settings → Apps and Keys). Leave empty to use the user’s default account.'
      }
    },
    baseUrl: 'https://{{config.environment}}',
    // 3,000 API calls per hour per account.
    rateLimit: { requestsPerSecond: 0.8 },
    test: { request: { path: '/oauth/userinfo' }, account: '$.accounts[0].account_name' },
    streams: streams(API)
  },
  hooks: {
    async discover(ctx) {
      const account = await resolveAccount(ctx.http, ctx.connection)
      return streams(`${account.baseUri}/restapi/v2.1/accounts/${account.accountId}`)
    },
    async test(ctx) {
      const account = await resolveAccount(ctx.http, ctx.connection)
      return account.name ? { account: String(account.name) } : {}
    },
    read(stream, state, ctx) {
      return stream.name === 'recipients' ? readRecipients(ctx.http, stream.spec, state) : undefined
    }
  }
})
