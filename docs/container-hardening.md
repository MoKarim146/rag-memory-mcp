# Container Hardening

The production image is designed to run compiled JavaScript from `dist/`, not `tsx watch`.

## Defaults

- `NODE_ENV=production`.
- Non-root runtime user `10001:10001`.
- Memory directory mounted at `/memory`.
- Healthcheck calls `/health` every 30 seconds.
- No file watchers, polling loops, background jobs, or startup full-vault scan are added.
- Search runs only when an MCP client calls `search_memory`. The first search builds an in-memory index; each later
  search re-reads only notes whose size or change time changed. The index is never written to disk, so the
  read-only root file system is fine.

## Compose Hardening

`docker-compose.yml` keeps the container local by publishing the port on `127.0.0.1` only. It also enables:

- `read_only: true`.
- Writable `/tmp` via tmpfs.
- Named writable volume for `/memory`.
- `cap_drop: [ALL]`.
- `no-new-privileges:true`.
- `init: true`.
- CPU limit of `0.50`.
- Memory limit of `512m`.

## Memory Data

Do not bake real vault data into the image. Mount a dedicated memory directory or Docker volume at `/memory`.

For public demos, use fake data only. For production, use a dedicated memory directory rather than an entire private Obsidian vault.

## Large Vaults

Search is bounded (at most 10 results, 500-character queries) and runs on demand. On a synthetic vault of 4,730 notes, building the index took about 2 seconds on one CPU core and used roughly 22 MB of extra memory (RAG_RESULTS.md). Keep `AI_MEMORY_DIR` narrow.

## What was tested

Checked on 5 November 2026 with Docker Engine 29.9.2 and Docker Compose 5.6.1 on Linux, using the base image
`node:22-alpine` (digest `sha256:fe4f6d74…99914`, Node.js 22.23.4):

- `docker-compose.yml` as committed started the image; the health check turned healthy and `/health` answered.
- The container ran as user 10001, with a read-only root file system (writing to `/app` failed), all capabilities
  dropped, `no-new-privileges`, 512 MB of memory and half a CPU.
- The server created the five main notes in the `/memory` volume; all 8 tools answered over HTTP on
  `127.0.0.1:8787`; a decision written through `add_decision` came back in `search_memory`; a request with a foreign
  `Origin` header was refused (403).

**The build was not tested exactly as committed.** The machine reached the internet only through a proxy that
containers cannot use directly, and Docker Hub refused anonymous pulls (rate limit). So the base image came from
Google's Docker Hub mirror (`mirror.gcr.io/library/node:22-alpine`, the same image), and the build ran with
`--network host`, the proxy passed as build arguments, and the proxy's certificate added before the two `npm ci`
steps. Nothing else in the `Dockerfile` changed. A build on an ordinary machine, and Docker on macOS or Windows,
were not tested.

