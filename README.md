# @rushdb/connectors

Declarative SaaS connectors for [RushDB](https://rushdb.com). A connector is a
JSON-serialisable **spec**: where the API is, how to authenticate, which
endpoints hold which records, how they page, how to read only what changed,
how records relate to each other and how webhooks arrive. A generic
**runtime** executes the spec and returns records shaped for a graph: flat
properties, an external id and links to other records by id.

RushDB uses these connectors to sync company tools (CRM, billing, support,
ITSM, project tracking, docs, spreadsheets, analytics, market intelligence)
and on-prem databases into one knowledge graph. The
package has no dependency on RushDB itself: the runtime only reads from
providers and hands you records and resumable state.

- **Specs, not code.** Custom and generated connectors are data, validated with
  zod. Nothing a person types runs as code.
- **Read-only.** Every built-in connector asks for read scopes only.
- **Resumable.** Each batch carries the state to store once it is written;
  an interrupted sync resumes without skipping records.
- **Safe by default.** Requests go to public HTTPS hosts only, next-page URLs
  must stay on the API's origin, and responses are size-capped.

## Install

```bash
pnpm add @rushdb/connectors
# npm install @rushdb/connectors
```

Node.js 18 or later. The only runtime dependency is `zod`.

## Usage

```ts
import { ConnectorRuntime, getConnector, type StreamState } from '@rushdb/connectors'

const runtime = new ConnectorRuntime()
const stripe = getConnector('stripe')!

const connection = {
  config: {},
  credentials: { type: 'bearer' as const, token: process.env.STRIPE_RESTRICTED_KEY! }
}

// One cheap authenticated request; throws when the key does not work.
await runtime.test(stripe, connection)

// The streams of this connection (connectors with discovery add account-specific ones).
const streams = await runtime.streams(stripe, connection)

// Read one stream. Store `batch.state` after writing `batch.records`.
let state: StreamState = {} // load it from your store
for await (const batch of runtime.read(stripe, connection, 'customers', state)) {
  for (const record of batch.records) {
    // record.externalId, record.properties, record.links, record.deleted
  }
  state = batch.state // persist it
}
```

Each `MappedRecord` has:

| Field        | Meaning                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `externalId` | The record's id at the provider, unique within the stream.                                      |
| `properties` | Flat `snake_case` properties; nested objects become `parent_child`, deeper ones JSON strings.  |
| `links`      | `{ type, target, direction, externalIds }`: relations to records of another stream, by id.      |
| `deleted`    | `true` for a tombstone (a record the provider reports as deleted).                              |

### OAuth

```ts
import { authorizeUrl, createPkcePair, exchangeCode } from '@rushdb/connectors'

const spec = runtime.spec(getConnector('hubspot')!)
const { verifier, challenge } = createPkcePair()
const url = authorizeUrl(spec, { clientId, redirectUri, state, codeChallenge: challenge })
// …after the redirect:
const credentials = await exchangeCode(spec, { client: { clientId, clientSecret }, code, redirectUri, codeVerifier: verifier })
```

Pass `oauthClient` and `onCredentials` in the connection: the runtime refreshes
tokens before they expire and once on a 401, and calls `onCredentials` so you
can store the new ones.

### Webhooks

```ts
import { parseWebhook, verifyWebhook } from '@rushdb/connectors'

const spec = runtime.spec(getConnector('stripe')!)
if (!verifyWebhook(spec, { headers, rawBody, secret, url, method })) {
  return reply.code(401).send()
}
for (const event of parseWebhook(spec, JSON.parse(rawBody))) {
  // event.action: 'upsert' (event.record is mapped), 'delete' (event.externalId) or 'refetch' (sync the stream)
}
```

Header names must be lower-cased. `rawBody` is the exact body as received.

### Egress

By default every request must go to a public HTTPS host: the runtime resolves
the host and refuses loopback, private, link-local (cloud metadata), CGNAT and
multicast addresses. Connector hosts can contain values a person typed (a
Zendesk subdomain, a ServiceNow instance), so this applies to built-in
connectors too. Tests and trusted setups can pass `egress: () => 'any'`.

### Testing kit

`@rushdb/connectors/testing` exports `createMockFetch` (answers from recorded
fixtures and records every call) and `noSleep` (no waiting on retries):

```ts
import { createMockFetch, noSleep } from '@rushdb/connectors/testing'

const fetch = createMockFetch([{ path: '/v1/customers', body: { data: [], has_more: false } }])
const runtime = new ConnectorRuntime({ fetch, sleep: noSleep, egress: () => 'any' })
```

### Custom connectors and OpenAPI drafts

`parseConnectorSpec(json)` validates a spec someone wrote and names every
problem. `connectorFromOpenApi(document, { id })` drafts one from an OpenAPI 3
document (one stream per list operation) for a person to review. See
[docs/spec-reference.md](docs/spec-reference.md) for every field.

## Catalog

| Connector         | Streams                                                                                                                           | Auth                                     | Incremental                                           | Webhooks                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| **HubSpot**       | contacts, companies, deals, tickets, owners                                                                                       | OAuth 2.0, private app token             | Search API on the last-modified property              | v3 signature; refetch by object id, delete         |
| **Salesforce**    | accounts, contacts, leads, opportunities, cases, users, tasks, events, plus custom objects (`__c`) discovered per org            | OAuth 2.0                                | SOQL on `SystemModstamp`; deletions via `queryAll`    | none (scheduled)                                   |
| **Pipedrive**     | persons, organizations, deals, activities, users, pipelines, stages                                                               | OAuth 2.0, API token                     | `updated_since` (API v2)                              | v2 webhooks with HTTP basic credentials            |
| **Stripe**        | customers, subscriptions, invoices, charges, payment_intents, products, prices, refunds, disputes                                 | Restricted API key, Connect OAuth        | Full refresh (list APIs filter by creation only)      | `Stripe-Signature`; upsert and delete              |
| **Paddle**        | customers, subscriptions, transactions, products, prices, adjustments                                                             | API key (live or sandbox)                | Full refresh                                          | `Paddle-Signature`; upsert                         |
| **QuickBooks Online** | customers, vendors, accounts, items, classes, departments, invoices, estimates, sales receipts, credit memos, payments, bills, bill payments, purchases, purchase orders; employees, journal entries (optional) | OAuth 2.0 (company id from the redirect) | `Metadata.LastUpdatedTime`; deletions via Change Data Capture (30 days) | `intuit-signature`; refetch and delete (own Intuit app) |
| **Xero**          | contacts, accounts, items, invoices and bills, credit notes, payments, bank transactions, purchase orders, quotes; manual journals (optional) | OAuth 2.0 (granular read scopes)         | `If-Modified-Since` on `UpdatedDateUTC`               | `x-xero-signature`; refetch (own Xero app)         |
| **NetSuite**      | subsidiaries, departments, classes, locations, accounts, customers, vendors, items, transactions; employees, contacts, transaction lines (optional) | OAuth 2.0 (REST web services)            | SuiteQL on `lastmodifieddate`, paged by key           | none (scheduled)                                   |
| **Zendesk**       | tickets, users, organizations, groups                                                                                             | OAuth 2.0, API token                     | Incremental export APIs                               | Zendesk events, signed; refetch and delete         |
| **Intercom**      | contacts, companies, conversations, admins, tags                                                                                  | OAuth 2.0, access token                  | Search APIs on `updated_at` (contacts, conversations) | `X-Hub-Signature` (HMAC-SHA1); upsert and delete   |
| **ServiceNow**    | any table; by default incident, problem, change_request, sys_user, cmdb_ci, kb_knowledge                                          | Basic, OAuth 2.0                         | `sys_updated_on`                                      | none (scheduled)                                   |
| **Jira**          | issues, projects, users                                                                                                           | OAuth 2.0 (3LO), email + API token       | JQL on `updated`, in the user's time zone             | Signed admin webhooks; refetch and delete          |
| **Notion**        | pages, databases, users                                                                                                           | OAuth 2.0, internal integration secret   | `last_edited_time` (search API)                       | `X-Notion-Signature`; refetch and delete           |
| **Google Sheets** | one stream per tab of the spreadsheet                                                                                             | OAuth 2.0 (`spreadsheets.readonly`)      | Full refresh                                          | none                                               |
| **Airtable**      | one stream per table of the base, linked records as relations                                                                     | OAuth 2.0, personal access token         | When the table has a "Last modified time" field      | none                                               |
| **Salesloft**     | people, accounts, cadences, calls, users; emails (optional)                                                                       | OAuth 2.0, API key                       | `updated_at[gt]`                                      | none                                               |
| **Lemon Squeezy**  | stores, customers, products, variants, orders, subscriptions; license keys (optional, key dropped)                                | API key                                  | Full refresh                                          | `X-Signature`; upsert                              |
| **Planhat**       | companies, endusers, licenses, users; conversations (optional)                                                                    | API token                                | Full refresh                                          | none                                               |
| **Gong**          | calls, users; transcripts (optional, personal data)                                                                               | Access key + secret, OAuth 2.0           | `fromDateTime` window with a 2-day lookback           | none                                               |
| **Fireflies**     | transcripts, users                                                                                                                | API key                                  | `fromDate`                                            | none                                               |
| **Linear**        | issues, projects, teams, users, cycles; comments (optional)                                                                       | OAuth 2.0 (`read`), personal API key     | `updatedAt` (GraphQL)                                 | `Linear-Signature`; refetch and delete             |
| **Asana**         | workspaces, projects, tasks, users; sections (optional)                                                                           | OAuth 2.0, personal access token         | `modified_since` per project                          | none                                               |
| **ClickUp**       | spaces, folders, lists, tasks, users                                                                                              | Personal token                           | `date_updated_gt`                                     | none                                               |
| **monday.com**    | boards, items (column values flattened), users                                                                                    | OAuth 2.0, API token                     | Full refresh                                          | none                                               |
| **Trello**        | boards, lists, cards, members; actions (optional)                                                                                 | API key + token                          | Actions only (`since`)                                | none                                               |
| **YouTrack**      | issues (custom fields flattened), projects, users                                                                                 | Permanent token                          | `updated` with a 1-day lookback                       | none                                               |
| **Sentry**        | projects, issues; releases (optional)                                                                                             | Auth token                               | `lastSeen` (last 90 days)                             | none                                               |
| **Confluence**    | spaces, pages (body as plain text); blog posts (optional)                                                                         | OAuth 2.0 (3LO), email + API token       | Last-modified, newest first                           | none                                               |
| **DocuSign**      | envelopes, recipients, users; templates (optional)                                                                                | OAuth 2.0 (production or developer)      | `from_date` / `modified_from_date`                    | none                                               |
| **Loopio**        | library entries, projects, users                                                                                                  | OAuth 2.0 (PKCE)                         | `lastUpdatedDate`                                     | none                                               |
| **PostHog**       | persons, cohorts, feature flags; insights, dashboards, events (optional)                                                          | Personal API key                         | Insights (`last_modified_at`), events (`after`)       | none                                               |
| **Brevo**         | contacts, lists, email campaigns; companies, deals (optional)                                                                     | API key                                  | `modifiedSince`                                       | none                                               |
| **Sensor Tower** (beta) | apps, estimates; rankings (optional), for the apps and countries you list                                                   | API token                                | Estimates by date                                     | none                                               |
| **Similarweb** (beta)   | domains and monthly traffic per domain you list                                                                             | API key                                  | Latest available month                                | none                                               |
| **Semrush** (beta)      | domain overview; organic keywords (optional), for the domains you list                                                      | API key                                  | Full refresh (spends API units)                       | none                                               |
| **Trustpilot** (beta)   | business units and their reviews                                                                                            | API key                                  | Review creation date, newest first                    | none                                               |

Labels carry a provider prefix (`HUBSPOT_CONTACT`, `STRIPE_INVOICE`,
`SF_ACCOUNT`, `ZENDESK_TICKET`, …); people can rename them per connection.
Connectors marked beta query paid market-intelligence APIs for the items you
list; every run spends the vendor's API units.

### Push templates

Zapier, Make and n8n move other tools' events rather than hold data, so they
are not pull connectors: `pushTemplates` describes how each posts records into
a RushDB webhook (push) connection.

### Logos

Every connector, push template and agent database has its official logo in
`logos/` (sources in `logos/SOURCES.md`). Catalog entries and push templates
carry it as `logo`, a `data:image/svg+xml` URI for an `<img src>`;
`connectorLogo(id)` returns the SVG markup.

## Field doctrine (personal data)

`detectPii(name, samples)` flags fields that look personal, by name (email,
phone, national and tax ids, cards, bank accounts, birth dates, addresses,
IPs, credentials, compensation, health) and by value (emails, Luhn-valid
cards, IBANs, SSNs, phones, IPs). `profileFields(records)` turns sample
records into a review: type, coverage, finding, a masked example and a
suggested action. The person's choices become a `FieldPolicy`:

- `auto` (not reviewed): every field passes except the ones whose name looks
  personal.
- `allowlist` (reviewed): only included and hashed fields pass; fields that
  appear later are held back for review.

`applyFieldPolicy(properties, policy, hashKey)` enforces it on every batch.
Hashed fields become a keyed SHA-256: the same value hashed with the same key
(one per RushDB project) is equal, so records still join across sources, but
the value can't be read back.

## On-prem databases: `rushdb-agent`

`rushdb-agent` (this package's binary, also a Docker image) syncs PostgreSQL,
MySQL, MongoDB and ClickHouse from inside your network: outbound HTTPS only,
read-only sessions, columns you list, and the field doctrine applied before
anything leaves. See [docs/agent.md](docs/agent.md).

```bash
npx -p @rushdb/connectors rushdb-agent init > rushdb-agent.yaml
npx -p @rushdb/connectors rushdb-agent check
```

## Contributing

New connectors and fixes are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
first, and use the "New connector" issue template to propose one. Report
security problems as described in [SECURITY.md](SECURITY.md).

```bash
pnpm install
pnpm test          # vitest
pnpm types:check   # tsc --noEmit
pnpm build         # tsup → dist/
```

## License

[Apache-2.0](LICENSE). The logos in `logos/` are trademarks of their owners,
used only to identify the services the connectors talk to; they are not
covered by this license.
