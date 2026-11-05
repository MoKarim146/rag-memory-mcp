# Backend switch meeting, 2 June 2026

Present: Ines, Kofi, Sam.

Sam showed the Firebase bill for May: £212, up from £38 in April, almost all document reads from trail pages. Projected £600 a month by the summer.

Options discussed:
1. Stay on Firebase and cache aggressively in the app.
2. Move to Supabase (Postgres, PostGIS, flat pricing).
3. Run our own Postgres on a VPS.

We chose Supabase in the Frankfurt region. Sam estimated two weeks for the move including a week of writing to both backends. Kofi raised that passwords cannot be exported from Firebase; we will ask users to set a new password.

Also agreed to move the maps from MapTiler to Mapbox, because Mapbox offline packs are smaller.
