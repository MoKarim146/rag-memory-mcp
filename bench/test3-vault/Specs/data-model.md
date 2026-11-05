# Data model (Supabase / Postgres)

| Table | Main columns | Notes |
|---|---|---|
| profiles | id, display_name, created_at | One row per user, id matches auth.users |
| trails | id, name, region, geom (LineString), length_km, ascent_m | Public data, read-only for users |
| routes | id, user_id, geom, started_at, ended_at, visibility | visibility is private or link, private by default |
| route_shares | route_id, token, expires_at | Share links, 30 days |
| emergency_sessions | id, user_id, started_at, ends_at, last_position | Live map for emergency share |
| push_tokens | user_id, token, last_success_at | Deleted after 90 days without success |

Row level security is on for every table. A test in the backend repo fails the build if it is off for any table.

Spatial index: GiST on trails.geom and routes.geom.
