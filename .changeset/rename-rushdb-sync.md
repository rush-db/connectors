---
'@rushdb/connectors': minor
---

**BREAKING:** `rushdb-agent` is now `rushdb-sync`, the on-prem database sync. The command, the Docker image, the config file and its environment variable are renamed, and the old names no longer work:

| Before | Now |
| --- | --- |
| `rushdb-agent` command (`dist/rushdb-agent.cjs`) | `rushdb-sync` (`dist/rushdb-sync.cjs`) |
| `ghcr.io/rush-db/rushdb-agent` | `ghcr.io/rush-db/rushdb-sync` |
| `rushdb-agent.yaml`, `/etc/rushdb-agent.yaml` in the image | `rushdb-sync.yaml`, `/etc/rushdb-sync.yaml` |
| `RUSHDB_AGENT_CONFIG` | `RUSHDB_SYNC_CONFIG` |

To upgrade:

1. **Docker image:** replace `ghcr.io/rush-db/rushdb-agent` with `ghcr.io/rush-db/rushdb-sync` in `docker run` commands, compose files and manifests. The old image is no longer published and will be removed, so its tags will stop pulling.
2. **Config file:** rename `rushdb-agent.yaml` to `rushdb-sync.yaml`. In Docker, mount it at `/etc/rushdb-sync.yaml` (`-v …/rushdb-sync.yaml:/etc/rushdb-sync.yaml:ro`); a mount at `/etc/rushdb-agent.yaml` is no longer read.
3. **Environment:** rename `RUSHDB_AGENT_CONFIG` to `RUSHDB_SYNC_CONFIG`; the old variable is no longer read.
4. **Command:** run `rushdb-sync` instead of `rushdb-agent` (scripts, systemd units, cron). Global installs: `npm install -g @rushdb/connectors@0.2.0` removes the old command.
5. **Token variable (optional):** the samples now use `${RUSHDB_SYNC_TOKEN}`. It is only a name your config refers to, so a config that keeps `${RUSHDB_AGENT_TOKEN}` works unchanged.

Unchanged: the package `@rushdb/connectors` and its `@rushdb/connectors/agent` subpath, the token (`rag_…`) and the wire protocol. Logs are now prefixed `[rushdb-sync]`, requests send `User-Agent: rushdb-sync/<version>`, and the reported version follows the package version. The guide moved to `docs/sync.md`.
