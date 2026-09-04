# Stress harnesses (`supabase/tests/stress/`)

Additive, opt-in concurrency harnesses that drive the schema in
`supabase/migrations/` against a throwaway `postgres:16` container. They never
touch the hosted project and never modify an applied migration. The
correctness matrix stays `../run_rls_tests.sh`; these harnesses hunt for
races the matrix cannot express.

## `db-drills-saved` — `public.user_saved_drills` + grants, concurrency lens

```bash
# small default: 56 iterations, ~1 min including container bring-up
./supabase/tests/stress/run_saved_drills_concurrency.sh

# full campaign (100 iterations per scenario, ~3 min)
STRESS_ITER=1700 STRESS_SEED=20260904 ./supabase/tests/stress/run_saved_drills_concurrency.sh
```

Environment knobs: `STRESS_ITER` (iterations), `STRESS_SEED` (base seed),
`STRESS_PORT` (host port, default 5499), `STRESS_OUT` (JSON report path).

The wrapper starts the container, applies `../shim_auth.sql` + every
`supabase/migrations/*.sql` in lexical order, raises `max_connections`, then
runs `saved_drills_concurrency.mjs` through the workspace `pg` client (no new
dependency). Each iteration picks its scenario and its interleaving from a
scenario-scoped seed derived by SHA-256 from the base seed, so any single
iteration replays on its own:

```bash
PICKLE_STRESS_PG_URL=postgres://postgres:x@127.0.0.1:5499/postgres \
  node supabase/tests/stress/saved_drills_concurrency.mjs --iter 1 --seed <seed from the report>
```

Requests are shaped like the Edge Function's: `set role authenticated` plus a
`request.jwt.claim.sub` for the acting user, one statement per implicit
transaction (PostgREST semantics), matching
`supabase/functions/api/index.ts` `saveDrill` / `unsaveDrill` /
`listSavedDrills`. Explicit transactions appear only where a scenario is
about transaction behaviour, and those scenarios say so.

Scored invariants: no duplicate `(user_id, slug)` rows, save idempotency
(`saved_at` never moves on a repeat save), no lost update, no cross-user read
or write, no orphan row after an account delete, hostile slugs always
rejected, and no deadlock or statement timeout on any API-shaped path within
the wall bound. Transaction-batched deadlocks and SERIALIZABLE
`40001` retries are recorded as rates (`perScenario[...].notes`) rather than
scored, because no route batches saves or asks for SERIALIZABLE today — they
are hazard telemetry for future routes.

## `repro_saved_drills_races.mjs`

Timing-free, step-ordered repros of the two behaviours the campaign surfaces
(saveDrill's split upsert/read-back returning 503 when a concurrent unsave
lands in the gap; opposite-order batched saves deadlocking). Exit 0 means both
reproduced.

```bash
PICKLE_STRESS_PG_URL=postgres://postgres:x@127.0.0.1:5499/postgres \
  node supabase/tests/stress/repro_saved_drills_races.mjs
```
