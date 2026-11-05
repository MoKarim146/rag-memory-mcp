# Payments (PayLoop)

## Overview

We use PayLoop hosted checkout. The API creates a checkout session, the customer pays on PayLoop's page, and PayLoop calls our webhook when the payment succeeds or fails. Card data never reaches our server.

## Endpoints we use

- POST /v2/checkout/sessions to create a session. We send the order id as client_reference.
- POST /v2/refunds for full refunds.
- POST /v2/payments/{id}/partial-refunds for partial refunds. The amount is in pence, and the sum of partial refunds cannot exceed the original capture.

## Limits

- Rate limit: the PayLoop API allows 60 requests per minute per API key. Our peak is far below that, but the refund retry job must back off on HTTP 429.
- PayLoop retries webhook delivery for 3 days with exponential backoff.

## Webhooks

- Endpoint: /api/payloop/webhook
- Every webhook is signed with HMAC-SHA256 in the PayLoop-Signature header. We verify it with the webhook secret from the environment, never from the database.
- The webhook secret must be rotated every 90 days. Last rotation: 2 September 2026.
- Events can arrive out of order. We store payloop_event_id with a unique index and ignore duplicates.

## Testing

- In the sandbox, the test card ending 0077 always succeeds and the test card ending 0002 is always declined.
- The sandbox does not support partial refunds on the same day as the payment. Test partial refunds against payments from yesterday.
