# On-call runbook

## The site is down

1. Check systemctl status fernhill-api on the VPS.
2. Check the Caddy log with journalctl -u caddy for certificate errors.
3. If the last deploy is to blame, roll back (see Projects/deployment.md).

## Orders are stuck in "pending payment"

PayLoop webhooks may be failing. Check the webhook log in the PayLoop dashboard, then the API log for signature errors. A wrong webhook secret after a rotation is the usual cause.

## The job queue stalls

Emails and webhook retries stop going out. Run npm run queue:drain on the VPS from /srv/fernhill/current. It processes stuck jobs once and prints any that have failed three times.

## The disk is filling up

An alert fires at 80 percent. Old releases under /srv/fernhill/releases can be deleted; keep the last five.
