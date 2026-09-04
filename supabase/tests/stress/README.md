# apply_synced_shot concurrency stress harness

Seeded, replayable concurrency campaign for the sync write path:
`public.apply_synced_shot(jsonb)`, the `enforce_scored_shot_permit` table gate,
`reserve_analysis_permit`, and the `shots` / `shot_phases` / `shot_measurements`
/ `shot_checkpoints` rows they write. Every lane is a real independent
connection to a disposable `postgres:16` that has the auth shim plus every
`supabase/migrations/*.sql` applied in order — the same evidence shape as
`supabase/tests/run_rls_tests.sh`. It never points at a hosted project.

## Run

```bash
./stress_pg_up.sh                         # disposable postgres:16 on 127.0.0.1:5499
STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres deno task test
./stress_pg_up.sh down
```

`deno task test` runs a small default campaign (20 iterations) so it can live
in the suite; without `STRESS_PG_URL` the test is ignored (an ignored run is
NOT a pass — the campaign is the evidence). Larger campaigns:

```bash
STRESS_PG_URL=… STRESS_ITER=600 deno task campaign                      # READ COMMITTED (the hosted RPC isolation)
STRESS_PG_URL=… STRESS_ITER=600 STRESS_SEED=777 STRESS_SERIALIZABLE_PCT=40 deno task campaign
```

Knobs: `STRESS_ITER`, `STRESS_SEED`, `STRESS_REPLAY=<iter>` (exact single-iteration
replay), `STRESS_ONLY=<scenario prefix>`, `STRESS_LANES`, `STRESS_TIMEOUT_MS`,
`STRESS_RERUN_FAILED` (default 10 — flake rate per failing seed),
`STRESS_SERIALIZABLE_PCT`, `STRESS_OUT_DIR` (writes `summary.json`,
`results.json`, `failures.json`). Every iteration derives its whole schedule
(lane count, ops, arrival delays, hold times, rollbacks, cancels, isolation)
from `mix32(baseSeed, iter)`, and every record carries the command that replays
it alone.

## Scenarios

`A` duplicate calls (same shot, same permit) · `B` same shot, distinct permits ·
`C` distinct shots, one permit · `D` over-issued free limit · `E` reserve vs
apply for the last free slot · `F` two users on the same shot id · `G` two
independent users · `H` abstention vs scored · `I` cancel during call
(`pg_cancel_backend` mid-flight) · `J` account deleted mid request · `K` clock
skew / permit age · `L` permit status tamper · `M` session deleted mid request ·
`N` direct `shots` insert vs the RPC · `O` detail rows written directly ·
`P` mixed storm (three users, rotated-identity and no-`sub` calls).

Global invariants asserted on every iteration: bounded wall time, no deadlock /
lock timeout, no unexpected SQLSTATE, no committed `shot.write_failed` for a
well-formed payload, free ratings never exceed the lifetime allowance, identity
ledger == scored rows == rank state == `access_state().scored_count`, one permit
finalized per scored row, no permanent rejection for a shot the server already
holds for that caller, and no detail row attached to another user's shot.

## Reproductions

`repro/` holds the minimized, deterministic scripts (exit 1 = the defect
reproduces):

- `cross_user_detail_attach.sh` — an authenticated user attaches
  `shot_phases` / `shot_measurements` / `shot_checkpoints` rows to another
  user's `shot_id` (campaign scenario `O`).
- `delete_user_vs_apply_deadlock.ts` — `apply_synced_shot` deadlocks (40P01)
  with the account-deletion cascade; the loser is sometimes the deletion, which
  leaves the account and its rows behind (campaign scenario `J`).
- `serializable_stale_snapshot_replay.ts` — a same-user replay whose snapshot
  predates the stored shot gets the permanent `shot.id_conflict` under
  SERIALIZABLE where READ COMMITTED answers `accepted`.
- `serializable_permit_over_issue.ts` — the advisory-lock re-count in
  `reserve_analysis_permit` reads the transaction snapshot, so a
  non-READ-COMMITTED caller can hold a third live free permit.

The two SERIALIZABLE scripts describe behaviour of the SQL under an isolation
level the hosted PostgREST RPC path does not use; they are recorded as isolation
limits of the advisory-lock-then-recheck pattern, not as hosted defects.
