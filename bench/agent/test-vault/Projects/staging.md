# Staging environment

The staging database is Postgres 16 behind PgBouncer. The app connects through PgBouncer on port 6432, never
directly to Postgres on 5432, because direct connections ran out during the load test.

Staging is rebuilt from the production backup every Sunday night.
