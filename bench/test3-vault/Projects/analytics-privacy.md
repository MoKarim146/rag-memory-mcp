# Analytics and privacy

We use PostHog, self-hosted on the same server as Sentry, with IP addresses discarded.

## What we track

- Screens opened, paywall shown, trial started, subscription started.
- Region downloads (which region, not where the user is).

## What we never track

- Locations or routes. The analytics events have no coordinates at all.
- Contact names or numbers from emergency share.

## Data retention

- Analytics events are deleted after 13 months.
- Deleted accounts: routes and personal data are removed within 30 days, backups roll over within 35 days.
