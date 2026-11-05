# Supabase migration

Moved from Firebase to Supabase between 2 and 16 June 2026.

## Why

Firebase charges per document read. Every trail page read the trail, its points and its reviews, so costs grew with every hiker. Supabase gives us Postgres with PostGIS, so "trails within 10 km" is one query instead of a client-side filter.

## How it went

1. Exported Firebase users with the admin SDK. Passwords could not be exported, so every user got a "set a new password" email on first login after the switch.
2. Imported 3,412 users and 18,905 routes into Supabase.
3. Ran both backends side by side for a week, writing to both.
4. Switched the app to Supabase in release 1.2 on 16 June.

## Problems

- 41 users had signed up with Apple's "hide my email" address; their relay addresses had to be re-linked by hand.
- Row level security was off on the routes table for the first two hours after the switch. No data was exposed (the table was only reachable with the service key), but we now have a test that fails if any table has row level security disabled.
