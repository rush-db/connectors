# Contributing

Thanks for helping. Most contributions are new connectors or fixes to existing
ones; this guide covers how to write one that we can review and ship quickly.

```bash
pnpm install
pnpm test          # every test must pass
pnpm types:check
pnpm build
```

Propose a new connector with the "New connector" issue template before you
start, so nobody builds the same one twice.

## How a connector is built

### 1. Spec first

A connector is a spec (`src/spec.ts`, reference in
[docs/spec-reference.md](docs/spec-reference.md)): auth methods, config
fields, base URL, rate limit, a test request, streams and webhooks. Write as
much as you can as spec. A spec is data: it can be reviewed line by line,
validated, shown in a catalog and run without trusting anyone's code.

Create `src/connectors/<id>.ts`:

```ts
import { defineConnector } from '../types'

export const acme = defineConnector({
  spec: {
    id: 'acme',
    name: 'Acme',
    category: 'crm',
    description: 'Accounts and contacts from Acme.',
    docsUrl: 'https://developer.acme.example/api',
    auth: [{ type: 'bearer', label: 'API token', help: 'Settings → API → New read-only token.' }],
    baseUrl: 'https://api.acme.example',
    rateLimit: { requestsPerSecond: 5 },
    test: { request: { path: '/v1/me' }, account: '$.company.name' },
    streams: {
      accounts: {
        label: 'ACME_ACCOUNT',
        request: { path: '/v1/accounts', query: { limit: 100 } },
        records: '$.data',
        id: '$.id',
        pagination: { type: 'cursor', next: '$.next_cursor', param: 'cursor' },
        incremental: {
          cursorField: '$.updated_at',
          request: { query: { updated_since: '{{cursor|iso}}' } }
        }
      }
    }
  }
})
```

Then register it in `src/connectors/index.ts` (catalog order matters: append
unless told otherwise) and add a row to the catalog table in `README.md`.

If the spec cannot express something the provider needs, prefer an additive,
generic change to the spec and runtime (a new optional field, a new pagination
kind) that other connectors can use too. Open an issue to discuss it first.

### 2. Hooks only when a spec cannot say it

Built-in connectors may add code hooks (`ConnectorHooks` in `src/types.ts`):

| Hook        | Use it for                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------- |
| `discover`  | Streams that depend on the account: Salesforce objects, Airtable tables, spreadsheet tabs.  |
| `read`      | Reads a spec cannot describe: SOQL, a search API with a result cap, newest-first feeds.     |
| `transform` | Reshaping a record before mapping: rich text to plain text, typed property values.          |
| `test`      | A connection check that needs more than one request.                                         |

Hooks are reviewed as code that runs inside RushDB, so keep them small, pure
where possible, and covered by tests. A `read` hook returns `undefined` to let
the generic reader handle a stream, and yields `{ records, state }` batches.
Set `state.cursor` on each batch explicitly: to the newest value seen when the
provider returns records oldest-first, or to the previous cursor until the
last batch when it returns them newest-first. Hooks receive the authenticated
HTTP client (`ctx.http`); never call `fetch` directly.

Custom connectors that people create in RushDB are specs only. Hooks exist
only for connectors in this repository.

### 3. Read-only, always

- Request read scopes only. If the provider has no read-only scope (Salesforce
  `api`, HubSpot `tickets`), say so in a comment and in the auth `help` text,
  and tell people to connect a read-only user.
- API-key and token auth methods carry `help` text explaining how to create a
  key with read permissions only.
- Hooks only read. No `POST` that changes data at the provider (`POST` is fine
  for search endpoints).

### 4. Correct incremental reads

Incremental reads must never skip a change:

- The cursor must be a **modification** time. A `created` filter misses every
  later change; read in full instead and document why (see `stripe.ts`).
- Set `lookbackSeconds` when the provider's clock, index or filter granularity
  can lag (minute-precision filters need at least 60).
- Mark tombstones with `deleted` when the provider reports deletions.
- When the provider's API cannot do it, read in full and say so in a comment.

## Naming

- **Connector id**: lower-case kebab (`google-sheets`).
- **Stream names**: plural `snake_case` nouns (`payment_intents`).
- **Labels**: `UPPER_SNAKE_CASE`, singular, with a provider prefix:
  `HUBSPOT_CONTACT`, `STRIPE_INVOICE`, `SF_ACCOUNT`, `ZENDESK_TICKET`.
- **Relation types**: `UPPER_SNAKE_CASE` verbs that read left to right from the
  record that holds the reference: `WORKS_AT`, `BILLED_TO`, `OWNED_BY`,
  `BELONGS_TO`, `ASSIGNED_TO`, `REQUESTED_BY`, `CHILD_OF`, `IN_PROJECT`.
  Reuse an existing type when the meaning is the same.
- Property names are produced by the mapper (`snake_case`); use `rename` only
  to avoid a clash (for example a provider field called `external_id`, which
  the mapper reserves for the provider id).

## Logo

Add the provider's official logo as `logos/<id>.svg`, then run `pnpm logos` to
embed it (`src/logos.generated.ts`; `test/logos.test.ts` fails until you do).

- Take it from the provider's brand or press kit, or their own site. Prefer the
  square symbol over the wordmark: it renders at 24–40 px. Never redraw a logo.
- Full colour, as the brand shows it on a light background.
- Static and local: a `viewBox`, no fixed `width`/`height`, no `<script>`,
  event handlers, `<foreignObject>`, `<image>`, or links and `url()` outside
  the file. Prefix gradient, clip-path and class ids with `<id>-` so many logos
  can share a page. At most 30 KB.
- Add a row to `logos/SOURCES.md` with the source URL.

## Tests

Add `test/connectors/<id>.test.ts`. Use `createMockFetch` and `noSleep` from
`src/testing`, and the helpers in `test/helpers.ts`.

### Fixtures

- Start from real responses, then sanitize them: **no personal data, no real
  names, emails, phone numbers, addresses, ids, tokens or company names**. Use
  `example.com` addresses and made-up ids.
- Trim fixtures to the fields the test needs plus a few that exercise the
  mapping (a nested object, an array, a timestamp, an amount).
- Never commit credentials, even revoked ones.

### Checklist

- [ ] `parseConnectorSpec(spec)` passes and lists the expected streams.
- [ ] `runtime.test()` works and returns the account label when the spec has one.
- [ ] A backfill over **two pages** of at least one stream yields mapped records
      with the expected label, properties (types converted, nested values
      flattened) and links.
- [ ] An incremental run sends the cursor in the provider's format, with the
      lookback applied, and stores the new cursor on the last batch.
- [ ] Webhooks, when defined: a correctly signed delivery verifies, a tampered
      one does not, and `parseWebhook` routes each event type you declared
      (upsert, delete, refetch).
- [ ] Every hook is exercised.

## Review checklist

Reviewers check, and authors can check first:

- [ ] Base URLs, OAuth URLs and scopes match the provider's current official docs (link them in the PR).
- [ ] Scopes and key permissions are read-only, or the gap is documented.
- [ ] Per-account hosts come from `config` fields with help text, never free-form URLs where a subdomain will do.
- [ ] `rateLimit` matches the provider's published limits.
- [ ] Incremental reads use a modification time and cannot skip changes; deletions are handled or documented.
- [ ] Labels and relation types follow the naming rules.
- [ ] `logos/<id>.svg` is the provider's official mark, listed in `logos/SOURCES.md`, and `pnpm logos` was run.
- [ ] No hooks where the spec suffices; hooks never call `fetch` directly or write to the provider.
- [ ] `webhooks.setup` explains how to register the webhook and where the signing secret comes from.
- [ ] Fixtures contain no personal data or credentials.
- [ ] `pnpm test`, `pnpm types:check` and `pnpm build` pass.
- [ ] A changeset describes the change (`pnpm changeset`).

## Changesets and releases

Run `pnpm changeset` and describe the change for users. A new connector or
a new optional spec field is a `minor`; a fix is a `patch`. A change that
breaks existing specs or the runtime API needs a discussion first. Merging the
"version packages" pull request publishes to npm.

## Commits

Conventional commits: `feat(hubspot): …`, `fix(runtime): …`, `docs: …`.
