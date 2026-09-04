# db-rank concurrency stress harness

Unit under test: `public.player_rank_state`, `recompute_player_rank`,
`player_rank_tier`, `handle_shot_rank_refresh` (plus the RPCs that drive them:
`apply_synced_shot`, `reserve_analysis_permit`, `finalize_analysis_permit`).
Lens: concurrency — Promise.all bursts of independent Postgres transactions from a
seeded scheduler; two users minimum; READ COMMITTED everywhere, SERIALIZABLE in
`serializable_burst`; RLS probed from `set local role authenticated` +
`set local request.jwt.claim.sub`.

Everything runs against a disposable `postgres:16` container (`pg_up.sh`: shim
`supabase/tests/shim_auth.sql` + every `supabase/migrations/*.sql` in order).
Nothing here talks to a hosted project.

## Run

```sh
./supabase/tests/stress/db-rank/run.sh                    # STRESS_ITER=2 per scenario (suite default, ~2s)
STRESS_ITER=60 ./supabase/tests/stress/db-rank/run.sh     # campaign: 660 iterations / ~3.4k lanes
STRESS_REPLAY=<scenario>:<seed> ./supabase/tests/stress/db-rank/run.sh
STRESS_SEED=<n> …                                         # campaign seed (default 20260904)
STRESS_ONLY=a,b …                                         # subset of scenarios
STRESS_KEEP_DB=1 …                                        # leave the container up (STRESS_PG_URL printed)
```

Iteration seed = `fnv1a("<scenario>:<campaignSeed>:<i>")`; the seed fixes users,
payloads, lane mix and the burst order (`Rng`). Wall-clock interleaving is the
real scheduler's, so a seed's outcome is a rate, not a constant — replay a seed
10× to measure it. Every run writes `results.json` (seed → outcome table),
`results.full.json` (per-lane rows, SQLSTATEs, notes) and `summary.json` to
`$STRESS_OUT_DIR` (default `artifacts/stress-db-rank/<utc>/`). Exit code ≠ 0
when any iteration violates an invariant — the harness is meant to FAIL while
the findings below are open.

## Scenarios (each iteration = one seeded burst)

| scenario                            | actors                     | what races                                                                       |
| ----------------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| burst_two_users_distinct_shots      | 2 users, authenticated     | RPC bursts, distinct shot ids, both users at once                                |
| duplicate_replay_same_shot          | authenticated              | same payload N× in parallel + call-during-call replays                           |
| two_actors_same_shot_id             | 2 users                    | same shot id claimed by both users at once                                       |
| serializable_burst                  | authenticated              | RPC bursts under `isolation level serializable`                                  |
| rpc_vs_direct_low_confidence_insert | authenticated              | RPC scored writes vs direct `insert` of low_confidence rows (client grant path)  |
| owner_direct_scored_inserts         | owner / no JWT             | direct scored inserts for one user (service-role path)                           |
| account_delete_vs_sync              | auth admin + authenticated | `delete from auth.users` cascade during in-flight syncs                          |
| session_delete_vs_sync              | authenticated              | `delete from public.sessions` (`on delete set null` → rank trigger) during syncs |
| cancel_during_call                  | authenticated              | `statement_timeout` cancels the RPC mid-flight, then retry                       |
| rls_rank_visibility                 | 2 users                    | cross-user reads/writes of `player_rank_state`, `recompute_player_rank` EXECUTE  |
| reserve_vs_apply_free_limit         | free user                  | reserve/apply bursts against the 2-lifetime-free-ratings limit                   |

Invariants: `no_duplicate_rows`, `idempotent_replay`, `no_double_spend`,
`no_over_issue`, `permits_settled_once`, `identity_ledger_matches_scored`,
`abstentions_always_accepted`, `winner_lanes_accepted`, `loser_lanes_conflict`,
`all_lanes_committed`, `rank_state_matches_committed_rows` (TS oracle
`computePlayerRank` over the committed rows), `stored_state_not_stale` (stored
row == fresh `recompute_player_rank`), `sql_recompute_matches_ts_oracle`,
`technique_view_matches_oracle`, `no_deadlock` (no 40P01 / 55P03),
`bounded_wall_time`, `rls_state_visibility`, `rls_view_visibility`,
`rls_cross_user_isolation`, `rank_objects_client_readonly`,
`no_orphans_after_delete`, `session_cascade_applied`,
`cancel_keeps_permit_reserved`, `known_outcomes`.

## Deterministic SQL repros (two psql sessions, exit 1 = BROKEN)

```sh
PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres ./supabase/tests/stress/db-rank/repro_owner_direct_lost_update.sh
PG_URL=… ./supabase/tests/stress/db-rank/repro_stale_rank_lost_update.sh
PG_URL=… ./supabase/tests/stress/db-rank/repro_account_delete_deadlock.sh
```

- `repro_owner_direct_lost_update.sh` — minimal root cause: two writers that do
  not hold `access_lock_key(uid)` each run `recompute_player_rank()` in their
  own READ COMMITTED transaction; the second aggregates a snapshot without the
  first's row, blocks on the first's `player_rank_state` row in
  `insert … on conflict do update`, then overwrites the newer state.
- `repro_stale_rank_lost_update.sh` — the same lost update through a
  client-reachable path: an authenticated `delete from public.sessions`
  (`shots.session_id on delete set null` fires `handle_shot_rank_refresh`)
  overlapping an authenticated `apply_synced_shot`.
- `repro_account_delete_deadlock.sh` — `apply_synced_shot` (advisory lock →
  permit `for update` → `shots` insert, which key-share-locks the `profiles`
  row) vs `delete from auth.users` (cascade: `profiles` row X-lock → permits
  delete blocks on the permit row) → SQLSTATE 40P01, the deletion is the
  victim.

`lib_psql_sessions.sh` drives the two sessions (host `psql`, or `psql` inside
the `pg_up.sh` container when the host has none).
