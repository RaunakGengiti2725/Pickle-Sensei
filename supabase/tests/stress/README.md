# Boundary / malformed-input stress campaign — free-rating ledger unit

Target: `public.free_rating_ledger`, `public.lifetime_scored_count()` /
`public.identity_scored_count()`, the `record_scored_shot_in_ledger()` and
`inherit_free_rating_ledger()` triggers, `reject_ledger_mutation()`, and the
scored-shot write gate — driven through the real database boundary
(`apply_synced_shot(jsonb)`, `reserve_analysis_permit(text)`, direct table DML
from `anon` / `authenticated` / `service_role`, and `auth.identities` churn).

```
./supabase/tests/stress/run_boundary_malformed.sh              # 60 seeds, suite-sized
STRESS_ITER=3200 STRESS_WORKERS=8 STRESS_POOL_FREE=40 \
  STRESS_POOL_PREMIUM=20 ./supabase/tests/stress/run_boundary_malformed.sh
STRESS_SEEDS=8,367,203 STRESS_REPEAT=10 ./supabase/tests/stress/run_boundary_malformed.sh
```

Disposable `postgres:16` container only (never a hosted project). The runner
applies `supabase/tests/shim_auth.sql`, every `supabase/migrations/*.sql` in
lexical order, then `boundary_malformed_ledger.sql`, seeds a pool of free and
premium users with linked identities, and runs the seeds across parallel psql
sessions (autocommit, READ COMMITTED) so workers interleave on shared users.

Every iteration is a pure function of its seed: `stress_bm.run_one(seed, w, i)`
replays it. Env knobs are documented at the top of the runner; the default is
small enough to live in the suite.

Verdicts: `HELD` (invariant held), `BROKEN` (product failure — fails the run),
`RAISED:<sqlstate>` (the call raised instead of returning a categorical status,
and nothing was written — reported, does not fail the run),
`COLLISION` (two generated identities share a ledger hash; `STRESS_STRICT=1`
makes it fail), `HARNESS_ERROR`.

Artifacts per run: `results.jsonl` (one JSON row per seed), `report.json`,
`invariants.json` (end-of-campaign whole-database invariants), `non_held.csv`,
`summary.json`, `run.log`, `worker_*.{sql,log}`.

`repro_rpc_raw_raise.sql` is the standalone reproduction of the three
pre-guard cast raises and the two `reserve_analysis_permit` insert raises; run
it with `docker exec -i <container> psql -U postgres -X -q -f -` against a
container left up by `STRESS_KEEP=1`.
