# Model Handoff

Last updated by Claude on 30 October 2026.

## Where we are

- Full refunds work on staging. Partial refunds are the next job: the API needs the PayLoop partial refund call, and the admin screen needs a way to pick which items to refund.
- The Welsh launch is waiting on the translator for allergen labels and email templates. Checkout copy is done and merged.
- The basket button contrast fix is in review on Priya's branch fix/basket-contrast. It blocks launch.

## Watch out for

- PayLoop sandbox webhooks sometimes arrive out of order. The handler must be idempotent on payloop_event_id.
- Do not run the menu import against production without a dry run first: scripts/import-menu.ts --dry-run.
- Staging and production share the VPS. Restart only fernhill-api-staging when testing.

## Suggested next steps

1. Implement partial refunds (Projects/payments.md has the API notes).
2. Rerun the load test after refunds land and compare with the October baseline.
3. Ask Leo about Saturday deliveries to CF5 at the next weekly call.
