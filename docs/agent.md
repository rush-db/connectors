# rushdb-agent: on-prem databases

`rushdb-agent` syncs PostgreSQL, MySQL / MariaDB, MongoDB and ClickHouse into RushDB from **inside your network**. RushDB never connects to your databases and never sees their credentials: the agent reads with a read-only user and pushes mapped records out over HTTPS to one host, the RushDB API you configure (RushDB Cloud, or your own RushDB server on the same network).

## Security model

| Concern | How the agent handles it |
| --- | --- |
| Inbound access | None. No listening port; outbound HTTPS to one URL only. |
| Database credentials | Read from the environment on your host (`${PG_URL}`); never sent anywhere. |
| What is read | Only the sources and streams in your config, and only the `columns` you list (recommended). |
| What is sent | Records mapped locally, after the stream's **field doctrine**: excluded fields are dropped and hashed fields hashed on your host, before anything leaves. Fields nobody reviewed that look like personal data (email, phone, IDs, cards, IBAN, birth dates, addresses, IPs, credentials) are dropped by default. |
| Field review | `rushdb-agent fields` reports field names, types and PII findings so a person can set the doctrine in RushDB. It never sends values, not even masked. |
| Writes to your database | Impossible by construction: read-only sessions (`default_transaction_read_only`, `SET SESSION TRANSACTION READ ONLY`, ClickHouse `readonly=1`, MongoDB secondary reads) on top of a read-only user. |
| RushDB credential | One agent token per connection (`rag_…`), shown once, stored hashed. It can write that connection's batches and read its settings, nothing else; rotate it in RushDB at any time. |
| Proof of what left | `dry-run` prints the next records exactly as they would be sent. `auditLog: /var/log/rushdb-agent.jsonl` keeps a local log of every run and batch (counts only). |
| Supply chain | Apache-2.0 source in this repository; the container runs as a non-root user and works with a read-only filesystem. Pin the image by digest. |
| Corporate TLS | Set `NODE_EXTRA_CA_CERTS=/path/ca.pem` to trust your proxy or private CA. |

## Set up

1. In RushDB: **Data sources → Connect a source → On-prem databases**. Copy the agent token (shown once).
2. Create a read-only user for each database (below).
3. Write `rushdb-agent.yaml` (`rushdb-agent init` prints a sample) and keep secrets in the environment.
4. `rushdb-agent check` (connects to every source and to RushDB; changes nothing).
5. `rushdb-agent fields`, then review the fields of each stream in RushDB: keep, drop or hash each one. That becomes the stream's doctrine for every later batch; fields that appear later are held back until reviewed.
6. `rushdb-agent dry-run` to see exactly what would be sent.
7. `rushdb-agent run` (as a service). The interval is set in RushDB; **Sync now** there is picked up within `pollSeconds`.

```bash
docker run -d --name rushdb-agent --restart unless-stopped --read-only --cap-drop ALL \
  -e RUSHDB_AGENT_TOKEN -e CLICKHOUSE_URL \
  -v /etc/rushdb-agent.yaml:/etc/rushdb-agent.yaml:ro \
  ghcr.io/rush-db/rushdb-agent:0.1.0 run
```

Without Docker: `npm install -g @rushdb/connectors` plus the driver you need (`pg`, `mysql2`, `mongodb` or `@clickhouse/client`), then `rushdb-agent run --config rushdb-agent.yaml`.

## Configuration

```yaml
rushdb:
  url: https://api.rushdb.com          # or your RushDB server
  token: ${RUSHDB_AGENT_TOKEN}
  # allowInsecure: true                 # only for http:// to a RushDB on your private network
pollSeconds: 30
auditLog: /var/log/rushdb-agent.jsonl   # optional, counts only

sources:
  - name: warehouse                     # stream ids are <source>.<stream>
    type: clickhouse                    # postgres | mysql | mongodb | clickhouse
    url: ${CLICKHOUSE_URL}
    database: analytics
    streams:
      - name: accounts
        label: ACCOUNT                  # the label in RushDB
        table: accounts                 # or query: SELECT … (wrapped as a subquery) / collection: (MongoDB)
        id: account_id                  # unique and stable
        cursor: updated_at              # grows when a row changes; omit to re-read everything each cycle
        columns: [account_id, name, plan, region, updated_at]   # only these leave the host
        deleted: { column: is_deleted, value: 1 }               # soft-delete flag → deletion in RushDB
        batchSize: 1000
      - name: invoices
        label: INVOICE
        query: SELECT invoice_id, account_id, amount, status, updated_at FROM invoices FINAL
        id: invoice_id
        cursor: updated_at
        relations:
          - { type: BILLED_TO, target: warehouse.accounts, field: account_id }
```

### How rows are read

Each page is a keyset query: rows after the last `(cursor, id)` seen, ordered by them, so a page never skips or repeats a row even when many share a cursor value, and an interrupted run resumes at its checkpoint (RushDB stores it only after the batch is written). Records get stable ids from (connection, stream, id), so re-reads update instead of duplicating.

- **ClickHouse** has no change log a CDC tool can follow: use an `updated_at` or the version column of a `ReplacingMergeTree` as the cursor, and `FINAL` in a `query` when you need merged rows.
- **PostgreSQL / MySQL / MongoDB**: the agent is the simple, outbound-only path. For sub-second change capture use `debezium-server-rushdb` (logical replication, binlog, change streams) instead.
- Index the cursor and id columns (`(updated_at, id)`) on large tables.
- Hard deletes are not visible to a polling reader: use a soft-delete column, or re-read without a cursor.

## Read-only users

PostgreSQL:
```sql
CREATE ROLE rushdb_reader LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE app TO rushdb_reader;
GRANT USAGE ON SCHEMA public TO rushdb_reader;
GRANT SELECT ON public.accounts, public.invoices TO rushdb_reader;   -- only what you sync
ALTER ROLE rushdb_reader SET default_transaction_read_only = on;
```

MySQL / MariaDB:
```sql
CREATE USER 'rushdb_reader'@'10.%' IDENTIFIED BY '…';
GRANT SELECT ON app.accounts TO 'rushdb_reader'@'10.%';
GRANT SELECT ON app.invoices TO 'rushdb_reader'@'10.%';
```

ClickHouse:
```sql
CREATE USER rushdb_reader IDENTIFIED WITH sha256_password BY '…' SETTINGS readonly = 1;
GRANT SELECT ON analytics.accounts TO rushdb_reader;
GRANT SELECT ON analytics.invoices TO rushdb_reader;
```

MongoDB:
```js
db.getSiblingDB('admin').createUser({
  user: 'rushdb_reader', pwd: '…',
  roles: [{ role: 'read', db: 'app' }]
})
```

## Commands

| Command | What it does |
| --- | --- |
| `init` | Print a sample configuration. |
| `check` | Connect to every source and to RushDB; change nothing. |
| `fields` | Profile fields locally and report names, types and PII findings to RushDB (no values). |
| `dry-run` | Print the next records of each stream as they would be sent, after the doctrine. Sends nothing. |
| `once [--full]` | One sync cycle, then exit (cron-friendly). `--full` ignores checkpoints. |
| `run` | Keep syncing. |
