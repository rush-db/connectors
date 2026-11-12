---
name: New connector
about: Propose a connector for a SaaS tool, or offer to build one
title: 'Connector: <provider>'
labels: connector-request
---

## Provider

- Name and website:
- API reference URL:
- Category (crm, billing, support, itsm, project-management, knowledge, spreadsheet, database, custom):

## Why

What would you do with this data in a knowledge graph? Which questions should it answer?

## Records

Which objects should become streams, and how do they relate? For example:
"tickets → requester (users), tickets → organization".

| Stream | Endpoint | Relations |
| ------ | -------- | --------- |
|        |          |           |

## API details (as far as you know)

- Authentication (OAuth 2.0 with read-only scopes? API token? Which header?):
- Per-account host (subdomain, instance, region)?
- Pagination style (cursor, offset, page, Link header, next URL):
- Incremental reads (an `updated_since` filter, a search API, an export/changes endpoint)?
- Deletions (tombstones, a deleted flag, a deleted-records endpoint)?
- Webhooks (event types, signature scheme, how they are registered)?
- Rate limits:

## Building it

- [ ] I would like to build this connector (see CONTRIBUTING.md)
- [ ] I can test it against a real account and provide sanitized fixtures

Never paste credentials or real customer data in this issue.
