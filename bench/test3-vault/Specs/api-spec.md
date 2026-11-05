# Backend API

All endpoints are Supabase edge functions under https://api.trailmate.example/v1. The app sends the user's Supabase JWT in the Authorization header.

| Method | Path | Purpose |
|---|---|---|
| GET | /trails?near=lat,lon&radius_km=10 | Trails near a point, uses PostGIS |
| GET | /trails/{id} | One trail with its points |
| POST | /routes | Upload a recorded route |
| POST | /routes/{id}/share | Create a share link, valid 30 days |
| POST | /emergency/start | Start emergency share, returns the live map link |
| POST | /emergency/position | Send a new position during emergency share |
| POST | /webhooks/revenuecat | Subscription events from RevenueCat |

## Limits

- 60 requests per minute per user; emergency endpoints are exempt.
- Route uploads are limited to 50,000 points (about 70 hours at one point every 5 seconds).

## Errors

Errors return JSON with a code and a message. Code TM-429 means rate limited; the app waits and retries with backoff.

```json
{ "code": "TM-404", "message": "Trail not found" }
```
