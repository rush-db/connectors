# Connector spec reference

A connector spec is JSON (or a TypeScript object) validated by
`connectorSpecSchema` in `src/spec.ts`. `parseConnectorSpec(input)` validates
one and also checks that every relation and webhook route names a stream that
exists. Defaults below are applied by the parser.

```jsonc
{
  "id": "acme",
  "name": "Acme",
  "version": 1,
  "category": "crm",
  "description": "Accounts and contacts from Acme.",
  "docsUrl": "https://developer.acme.example/api",
  "auth": [ /* auth methods, the first is the default */ ],
  "config": { /* per-connection settings */ },
  "baseUrl": "https://{{config.region}}.api.acme.example",
  "headers": { "Acme-Version": "2024-01-01" },
  "rateLimit": { "requestsPerSecond": 5 },
  "test": { "request": { "path": "/v1/me" }, "account": "$.company.name" },
  "streams": { /* name → stream */ },
  "webhooks": { /* optional */ }
}
```

## Top level

| Field                | Type                       | Notes                                                                                                                                     |
| -------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | string                     | `^[a-z][a-z0-9-]*$`. Stable: connections refer to it.                                                                                     |
| `name`               | string                     | Display name.                                                                                                                             |
| `version`            | integer, default `1`       | Bump when stored state from an older spec would be read wrongly.                                                                          |
| `category`           | enum                       | `crm`, `billing`, `support`, `itsm`, `project-management`, `knowledge`, `spreadsheet`, `database`, `custom`.                              |
| `description`        | string                     | One sentence for the catalog.                                                                                                             |
| `docsUrl`            | URL, optional              | The provider's API reference.                                                                                                             |
| `auth`               | array, at least one        | Accepted auth methods; the first is the default. See [Auth](#auth).                                                                       |
| `config`             | record, optional           | Settings a person enters per connection. See [Config](#config).                                                                           |
| `baseUrl`            | template                   | Prefix of every relative request path. May use `{{config.*}}` and `{{credentials.*}}`.                                                    |
| `headers`            | record, optional           | Sent on every request (API version pins).                                                                                                 |
| `rateLimit`          | object                     | See [Rate limit](#rate-limit).                                                                                                            |
| `test`               | object, optional           | `{ request, account? }`: a cheap authenticated request; `account` is a JSONPath to a label for the connected account.                     |
| `streams`            | record                     | Stream name → stream. May be empty when a `discover` hook supplies them.                                                                  |
| `webhooks`           | object, optional           | See [Webhooks](#webhooks).                                                                                                                |
| `starterDefinitions` | array, optional            | `{ kind: 'metric' \| 'filter', name, description, label?, sql }`: definitions a platform may offer once the connector is set up.          |

## Templates

Strings in `baseUrl`, `request.path`, `request.query`, `request.body`,
`request.headers` and OAuth URLs are templates.

| Placeholder                     | Value                                                                       |
| ------------------------------- | --------------------------------------------------------------------------- |
| `{{config.<key>}}`              | A config value of the connection.                                           |
| `{{credentials.<field>}}`       | A token-response field kept with `keepTokenFields` (Salesforce `instance_url`) or a redirect parameter kept with `keepCallbackParams` (QuickBooks `realmId`). |
| `{{cursor}}`                    | The stored incremental watermark, after the lookback.                       |

Filters: `{{cursor|unix}}` (seconds), `unixMs`, `iso`, `date` (`YYYY-MM-DD`),
`sqlDatetime` (`YYYY-MM-DD HH:mm:ss` UTC), `urlencode`, `json`. Date-times
without a zone are read as UTC.

A string that is exactly one placeholder keeps the value's type
(`"{{cursor|unix}}"` → `1704067200`). A placeholder that resolves to nothing
drops the query parameter or body field holding it, so a request can carry an
incremental filter that disappears on a full read. In `baseUrl` and paths a
missing value is an error.

## JSONPath

A safe subset: `$`, `.key`, `['key']`, `["key"]`, `[0]`, `[-1]`, `[*]`, `.*`.
No filters, recursion or scripts. `records: "$"` means the body is the array.

## Auth

Every method may set `baseUrl` to use a different API host when connected
that way (Atlassian OAuth goes through `api.atlassian.com/ex/jira/{cloudId}`,
site tokens to the site itself).

### `oauth2`

```json
{
  "type": "oauth2",
  "authorizeUrl": "https://{{config.subdomain}}.zendesk.com/oauth/authorizations/new",
  "tokenUrl": "https://{{config.subdomain}}.zendesk.com/oauth/tokens",
  "scopes": ["read"],
  "scopeSeparator": " ",
  "pkce": true,
  "clientAuth": "body",
  "authorizeParams": { "access_type": "offline" },
  "keepTokenFields": ["instance_url"],
  "header": "Authorization",
  "prefix": "Bearer "
}
```

| Field             | Default           | Notes                                                                       |
| ----------------- | ----------------- | --------------------------------------------------------------------------- |
| `scopes`          | `[]`              | Read-only scopes only.                                                      |
| `scopeSeparator`  | `" "`             |                                                                             |
| `pkce`            | `true`            | S256 challenge on the authorize URL.                                        |
| `clientAuth`      | `body`            | `basic` sends the client credentials as HTTP basic at the token endpoint.  |
| `authorizeParams` | none              | Extra authorize query parameters.                                           |
| `keepTokenFields` | none              | Token-response fields to keep, readable as `{{credentials.<field>}}`.       |
| `keepCallbackParams` | none           | Query parameters of the authorization redirect to keep (QuickBooks `realmId`), readable as `{{credentials.<param>}}`. |
| `header`/`prefix` | `Authorization`/`Bearer ` | Where the access token goes.                                        |

### `bearer`

`{ "type": "bearer", "label": "API token", "help": "…", "header": "Authorization", "prefix": "Bearer " }`

### `basic`

`{ "type": "basic", "usernameLabel": "Email address followed by /token", "passwordLabel": "API token", "help": "…" }`

### `apiKey`

`{ "type": "apiKey", "label": "API token", "in": "header", "name": "x-api-token", "prefix": "" }`; `in` may be `query`.

### `none`

`{ "type": "none" }`

## Config

```json
"config": {
  "subdomain": { "label": "Subdomain", "placeholder": "acme", "help": "The part before .zendesk.com." },
  "environment": {
    "label": "Environment",
    "type": "select",
    "options": [{ "value": "api.paddle.com", "label": "Live" }, { "value": "sandbox-api.paddle.com", "label": "Sandbox" }],
    "default": "api.paddle.com"
  },
  "tables": { "label": "Tables", "type": "list", "required": false, "default": "incident,problem" }
}
```

| Field         | Default  | Notes                                       |
| ------------- | -------- | ------------------------------------------- |
| `label`       | required |                                             |
| `type`        | `string` | `string`, `url`, `select`, `list`.          |
| `required`    | `true`   |                                             |
| `help`, `placeholder`, `default` | none | `options` for `select`.     |

## Rate limit

```json
"rateLimit": { "requestsPerSecond": 5, "retryOn": [429, 500, 502, 503, 504], "maxRetries": 5, "retryAfterHeader": "Retry-After" }
```

Requests are spaced to `requestsPerSecond`. Retryable statuses are retried
with exponential backoff, or after the seconds (or HTTP date) in
`retryAfterHeader`. A 401 triggers one OAuth token refresh.

## Streams

```json
"invoices": {
  "label": "STRIPE_INVOICE",
  "description": "Invoices.",
  "request": { "method": "GET", "path": "/v1/invoices", "query": { "limit": 100 }, "headers": {} },
  "records": "$.data",
  "id": "$.id",
  "pagination": { "type": "lastId", "param": "starting_after", "hasMore": "$.has_more" },
  "incremental": { "cursorField": "$.updated", "format": "unix", "request": { "query": { "updated[gt]": "{{cursor|unix}}" } } },
  "fields": { "omit": ["object", "lines"], "types": { "total": "cents", "created": "unix" } },
  "relations": [{ "type": "BILLED_TO", "target": "customers", "field": "customer" }],
  "deleted": { "path": "$.deleted", "value": true },
  "optional": false
}
```

| Field         | Notes                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------- |
| `label`       | Default graph label, `UPPER_SNAKE_CASE` with a provider prefix.                          |
| `request`     | `method` (`GET` default, or `POST`), `path`, `query`, `body`, `headers`; all templates.  |
| `records`     | JSONPath to the array of records in the response.                                       |
| `id`          | JSONPath to the record's id. Records without an id are skipped.                          |
| `pagination`  | See below. Default `{ "type": "none" }`.                                                  |
| `incremental` | See below. Without it every run reads in full.                                           |
| `fields`      | Property mapping, see below.                                                             |
| `relations`   | See below.                                                                               |
| `deleted`     | A record is a tombstone when the value at `path` equals `value` (default `true`).        |
| `optional`    | Off by default when a person sets up the connection (high volume or sensitive).          |

### Pagination

| `type`       | Fields                                                                                           | Behaviour                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `none`       |                                                                                                  | One request.                                                                                |
| `cursor`     | `next` (JSONPath), `param`, `in` (`query`/`body`), `hasMore?`, `done?`                           | Sends the token from `next` as `param` until it is empty or repeats, `hasMore` is false or `done` is true. In the body, a dotted `param` sets a nested field (`pagination.starting_after`). |
| `lastId`     | `param`, `idPath` (default `$.id`), `hasMore?`, `in`                                             | Sends the last record's id (`starting_after`). Without `hasMore`, stops on an empty page.   |
| `offset`     | `param`, `limitParam?`, `limit` (100), `start` (0), `in`, `hasMore?`                             | Adds the number of records read; stops on a short page.                                     |
| `page`       | `param`, `sizeParam?`, `size` (100), `start` (1), `in`, `hasMore?`                               | Counts pages; stops on a short page.                                                        |
| `linkHeader` |                                                                                                  | Follows `Link: <…>; rel="next"`.                                                            |
| `nextUrl`    | `next` (JSONPath), `done?`                                                                       | Follows a full or relative URL from the body (Zendesk `after_url` with `done: "$.end_of_stream"`). |

Next-page URLs must stay on the base URL's origin; a URL elsewhere stops the
read with an error rather than sending credentials there.

### Incremental

```json
"incremental": {
  "cursorField": "$.updated_at",
  "format": "iso",
  "request": { "query": { "start_time": "{{cursor|unix}}" } },
  "pagination": { "type": "cursor", "next": "$.next", "param": "after", "in": "body" },
  "lookbackSeconds": 60
}
```

| Field             | Default | Notes                                                                                                   |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `cursorField`     |         | JSONPath to the record's last-modified value. The highest value seen becomes the stored cursor.        |
| `format`          | `iso`   | `iso`, `unix`, `unixMs`, `date`: the format `{{cursor}}` has after the lookback.                       |
| `request`         | none    | Merged over the stream request once a cursor exists (query, headers and body merge; path and method replace). |
| `pagination`      | none    | Replaces the stream pagination once a cursor exists (a search endpoint that pages differently).        |
| `lookbackSeconds` | `60`    | Re-read this much before the cursor.                                                                    |

The cursor advances only on the last batch of a run, because providers do not
page in modification order; earlier batches store the page position so an
interrupted run resumes where it stopped. A full read (`{ full: true }`)
ignores the cursor.

### Fields

```json
"fields": {
  "flatten": ["$.properties"],
  "pick": ["email", "name"],
  "omit": ["associations"],
  "rename": { "external_id": "user_external_id" },
  "types": { "amount": "cents", "created": "unix", "closedate": "datetime" },
  "nestedDepth": 2
}
```

Mapping order: `flatten` merges nested objects into the top level; every key
becomes a `snake_case` property; nested objects become `parent_child`
properties down to `nestedDepth` (0–4, default 2) and deeper ones JSON
strings; arrays of scalars stay arrays, arrays of objects become JSON. Then
`pick`, `omit` (an omitted key drops all the `key_*` properties it would have
become), and `types`. Names in `rename`, `pick`, `omit` and `types` are
matched after conversion to `snake_case`. `id` is dropped and the provider id
is stored as `external_id`.

| Type       | Conversion                                    |
| ---------- | --------------------------------------------- |
| `string`   | `String(value)`                               |
| `number`   | Number, or `null` when not numeric            |
| `boolean`  | `true`, `"true"`, `"1"`, `"yes"` → `true`     |
| `datetime` | Any parseable date → ISO 8601 (no zone = UTC) |
| `unix`     | Seconds → ISO 8601                            |
| `unixMs`   | Milliseconds → ISO 8601                       |
| `cents`    | Minor units → major units (`1999` → `19.99`)  |
| `json`     | JSON string                                   |

### Relations

```json
"relations": [
  { "type": "WORKS_AT", "target": "companies", "path": "$.associations.companies.results[*].id" },
  { "type": "BILLED_TO", "target": "customers", "field": "customer" },
  { "type": "MANAGES", "target": "users", "path": "$.reports[*]", "direction": "in" }
]
```

Each relation has exactly one of:

- `path`: JSONPath into the raw record (one id or many, objects with an `id`,
  `accountId` or `value` are reduced to it). The record gets `links` to those
  ids in `target`.
- `field`: a mapped property holding the target's id (Stripe `customer`). The
  property keeps the bare id even when the provider expanded the object; the
  platform registers it as a relationship pattern instead of returning links.

`direction` is `out` (default) or `in`. `target` must be a stream of the same
connector.

## Webhooks

```json
"webhooks": {
  "signature": { "scheme": "stripe" },
  "events": "$[*]",
  "type": "$.type",
  "typeSuffix": "$.meta.action",
  "id": "$.id",
  "object": "$.data.object",
  "objectId": "$.objectId",
  "routes": {
    "customer.deleted": { "stream": "customers", "action": "delete" },
    "customer.*": { "stream": "customers", "action": "upsert" }
  },
  "setup": "Stripe Dashboard → Developers → Webhooks → Add endpoint …"
}
```

| Field        | Notes                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `signature`  | See below.                                                                                                    |
| `events`     | JSONPath to the events when one delivery carries many (HubSpot). Default: the body is one event.             |
| `type`       | JSONPath to the event type.                                                                                   |
| `typeSuffix` | Appended to the type with a dot, for providers that split it (Pipedrive `meta.entity` + `meta.action`).       |
| `idSuffix`   | Appended to the id with a colon, for providers without an event id (QuickBooks entity `id` + `lastUpdated`).   |
| `id`         | JSONPath to the event id, for deduplication.                                                                  |
| `object`     | JSONPath to the changed object. Mapped with the route's stream spec on `upsert`.                              |
| `objectId`   | JSONPath to the changed object's id when the event carries no object.                                         |
| `routes`     | Event type → `{ stream, action }`. `action`: `upsert` (default), `delete`, `refetch`. `*` matches any run of characters; an exact type wins, then the longest matching pattern. Unrouted types are dropped. An `upsert` without an object becomes a `refetch`. |
| `setup`      | Instructions shown to the person: where to register the webhook, which events, where the secret comes from.   |

### Signature schemes

| `scheme`       | Fields                                                                                  | Verifies                                                                                         |
| -------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `none`         |                                                                                         | Nothing. Use only when the provider offers no way to authenticate deliveries.                    |
| `hmacSha256`   | `header`, `encoding` (`hex`/`base64`), `prefix`, `timestampHeader?`, `algorithm` (`sha256`/`sha1`) | HMAC of the raw body (or `timestamp + body`), compared in constant time with the header minus `prefix`. |
| `stripe`       |                                                                                         | `Stripe-Signature: t=…,v1=…` over `t.body`, within the tolerance (default 300 s).                |
| `paddle`       |                                                                                         | `Paddle-Signature: ts=…;h1=…` over `ts:body`, within the tolerance.                              |
| `hubspotV3`    |                                                                                         | `X-HubSpot-Signature-v3`: base64 HMAC of method + URL + body + timestamp, within the tolerance.  |
| `sharedSecret` | `header`                                                                                | The header equals the secret, as is, as `Bearer <secret>`, or as HTTP basic credentials `user:password`. |
