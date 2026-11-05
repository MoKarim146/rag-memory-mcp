# Deployment

## Layout on the VPS

- Code: /srv/fernhill/releases/<timestamp>/, with /srv/fernhill/current pointing at the live release.
- Database: /srv/fernhill/data/fernhill.db (SQLite, WAL mode), replicated by Litestream.
- Services: systemd units fernhill-api and fernhill-api-staging. Caddy serves the SvelteKit build and proxies /api to the Fastify service on port 3100 (staging on 3101).

## Deploying

1. Merge to main and wait for CI.
2. Run scripts/deploy.sh from a laptop. It builds, copies a new release folder with rsync, runs database migrations, points current at the new folder and runs systemctl restart fernhill-api.
3. Check /api/health, and place a test order with the sandbox card on staging first.

## Rolling back

Point the current symlink back to the previous folder under releases/ and restart the service. Migrations are written to be backwards compatible for one release, so the old code still runs against the new schema.

## Backups

Litestream streams the WAL to object storage every second and takes a snapshot every 24 hours. Restore drill done on 10 October 2026: restoring yesterday's database took 4 minutes.

## TLS

Caddy gets certificates automatically. The staging site is behind basic auth so search engines do not index it.
