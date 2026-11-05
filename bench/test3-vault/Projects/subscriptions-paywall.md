# Subscriptions and paywall

TrailMate Plus is sold through the App Store and Google Play. RevenueCat sits in front of both stores and tells our backend who is subscribed through a webhook at /webhooks/revenuecat.

## What Plus unlocks

- Every region instead of one.
- Offline maps for the whole country.
- Unlimited route history (free users keep the last 10 routes).

## Prices and trial

See the decision log for the current numbers. The trial and yearly price changed in September.

## Paywall rules

- The paywall is shown at most once per day, never during a recording.
- "Restore purchases" is on the paywall and in Settings.
- Students do not get a discount yet. Ines wants to test it in 2027.

## Webhook

RevenueCat signs every webhook with a shared secret in the Authorization header. The backend rejects webhooks without it and logs only the event type and the anonymous app user id.
