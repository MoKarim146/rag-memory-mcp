---
tags: [context]
---
# Main Context

Fake demo memory for the third benchmark set. Every company, person, number and hostname is invented.

## The product

TrailMate is a hiking app for iPhone and Android. Hikers download a trail, follow it offline, record their own routes and share them with friends. The free version covers one region at a time; TrailMate Plus unlocks every region, offline maps for the whole country and route history.

The team also maintains the website of Brightside Studio, the design agency two of us work at. That project lives under Website/ and has nothing to do with TrailMate.

## Team

- Ines Duarte: product, design, App Store and Play Store listings.
- Kofi Mensah: mobile developer (React Native).
- Sam Whitlock: backend and infrastructure, part time.
- AI assistants (Claude, ChatGPT, Gemini) keep session notes under Sessions/.

## Stack

| Part | Choice | Since |
|---|---|---|
| App | React Native with Expo (managed workflow) | March 2026 |
| Maps | Mapbox vector tiles, downloaded per region | June 2026 (was MapTiler) |
| Backend | Supabase (Postgres, auth, storage) in the Frankfurt region | June 2026 (was Firebase) |
| Payments | RevenueCat in front of the App Store and Google Play | July 2026 |
| Crash reports | Sentry, self-hosted on the backend server | April 2026 |

## Rules of thumb

- Everything must work with no signal. Hikers lose coverage after the car park.
- Battery matters more than polish. Recording a route must use under 5 percent battery per hour on a 2022 mid-range phone.
- No selling or sharing of location data, ever. It is in the privacy policy and in our pitch.
- Plain, friendly copy. No jargon like "GPX" in the main screens; say "route file".
