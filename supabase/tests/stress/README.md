# DB stress harnesses — `db-pg-cron-sweeps` × boundary/malformed input

Seeded, replayable stress campaigns against the Supabase schema on a throwaway
PostgreSQL 16 with pg_cron. Never point these at a hosted project.

## Setup (disposable database)

```bash
docker run -d --name pickle-stress-pg -p 5499:5432 -e POSTGRES_PASSWORD=x postgres:16 \
  postgres -c shared_preload_libraries=pg_cron -c cron.database_name=postgres
# pg_cron: apt-get install postgresql-16-cron inside the container, or run without it —
# the migrations skip schedule creation when the extension is absent and the
# harness falls back to the three sweep statements it reads from the migration.
docker exec -i pickle-stress-pg psql -U postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/shim_auth.sql
for f in supabase/migrations/*.sql; do
  docker exec -i pickle-stress-pg psql -U postgres -v ON_ERROR_STOP=1 -f - < "$f"
done
```

`STRESS_PG_URL` overrides the default `postgres://postgres:x@127.0.0.1:5499/postgres`.

## Campaigns

| harness                  | default | full campaign             | what it drives                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boundary_malformed.mjs` | 150     | `STRESS_ITER=3000 node …` | malformed/truncated JSON, wrong types, prototype-pollution keys, overflow/NaN/±0/Infinity, null bytes, 64 KiB+/1 MiB strings, traversal ids/slugs, future schema versions, unicode NFC/NFD pairs against `apply_synced_shot`, `reserve_analysis_permit`, direct table writes (two users + anon), with the pg_cron sweeps interleaved |
| `sweep_races.mjs`        | 40      | `STRESS_ITER=600 node …`  | the three pg_cron sweeps racing live writes from two authenticated users + service role on separate connections, READ COMMITTED and SERIALIZABLE (40001 retried and counted)                                                                                                                                                         |

Every iteration derives its seed from `STRESS_SEED` (default 20260904) and its
index; `STRESS_REPLAY=<seed>` replays exactly one iteration and prints its
record. Results land in `artifacts/stress/<campaign>-<date>-<n>/seed_outcomes.json`
(one row per seed) and `summary.json`. Exit code is 1 when any seed is BROKEN.

Verdicts: `HELD` (oracle matched), `WEAK` (accepted/rejected as the schema
allows but a documented boundary gap — see `repro/`), `BROKEN` (contract
violation: unexpected write on rejection, wrong status, RLS leak, harness
exception escaping a store).

## `repro/`

Stand-alone psql reproductions of the WEAK boundaries found by the campaign
(`docker exec -i pickle-stress-pg psql -U postgres -f - < repro/<file>.sql`).
Each wraps itself in a rolled-back transaction.
