# database-2 stress adjudication — reproductions

Reproduction-only material for the `database-2` adjudication (Postgres
RPCs/tables/RLS/pg_cron under concurrency and malformed input) against
baseline `1fb0efd7f3157060af4c61342f5102e068d2ddc5`. Nothing here is part of
CI and nothing here touches production; every script targets the throwaway
`postgres:16` container from `pg_up.sh` (shim + hosted `auth.uid()` overlay +
every migration, exactly like `supabase/tests/run_rls_tests.sh`).

```bash
./supabase/tests/stress_adjudication/database-2/pg_up.sh      # → pickle-adj-pg on :5499
export ADJ_PG_CONTAINER=pickle-adj-pg STRESS_PG_CONTAINER=pickle-adj-pg
export ADJ_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres
```

| id | what | command | defect present when |
| --- | --- | --- | --- |
| DB2-1..5 | cross-user FK attachment, non-finite detail numerics, `saved_at` writable/unbounded, view DML 55000, entitlement last-writer-wins | `docker exec pickle-adj-pg psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/stress_adjudication/database-2/repro_single_session.sql` | exit 0 with `REPRODUCED` notices (each block RAISES once fixed) |
| DB2-6 | account deletion ⟂ `apply_synced_shot()` deadlock (deterministic) | `./supabase/tests/stress_adjudication/database-2/repro_deletion_deadlock.sh` | exit 0 |
| DB2-6 | same, seeded campaign (tester harness) | `STRESS_PG_URL=$ADJ_PG_URL STRESS_SCENARIO=deletion_during_requests STRESS_ITER_SEED=1778835764 node supabase/tests/stress_adjudication/database-2/from_testers/rls_concurrency_stress.mjs` | `FAIL … deadlock_detected` (8/10 replays here) |
| DB2-7 | late-linked identity ledger race (0 lifetime count) | `STRESS_PG_URL=reuse ./supabase/tests/stress_adjudication/database-2/from_testers/repro_identity_link_ledger_race.sh` | exit 1 (`REPRO CONFIRMED`) |
| P3 | session finalize lost update | `./supabase/tests/stress_adjudication/database-2/from_testers/repro_finalize_lost_update.sh` | exit 1 (`BROKEN`) |
| P3 | premium-flip TOCTOU → `shot.write_failed:42501` | `./supabase/tests/stress_adjudication/database-2/from_testers/repro_apply_premium_flip_toctou.sh` | exit 0 (`REPRODUCED`) |
| P3 | `saveDrill` read-back gap → 503 | `PICKLE_STRESS_PG_URL=$ADJ_PG_URL node supabase/tests/stress_adjudication/database-2/from_testers/repro_saved_drills_races.mjs` | `R1 reproduced: true` |

`from_testers/` holds the tester repro scripts verbatim (only the repo-root
path resolution was adjusted for the new location) from
`devin/stress-db-billing-webhook-tables-concurrency`,
`devin/stress-db-rls-matrix-concurrency`,
`devin/stress-db-sessions-captures-concurrency` and
`devin/stress-db-drills-saved-concurrency`.
