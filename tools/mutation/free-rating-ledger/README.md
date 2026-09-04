# Free-rating identity ledger — mutation testing harness

Execution-based mutation testing for the lifetime free-rating enforcement
introduced by `supabase/migrations/20260902150000_free_rating_identity_ledger.sql`
(`identity_scored_count()`, `lifetime_scored_count()`, `access_state()`,
`reserve_analysis_permit()`, the `apply_synced_shot()` backstop, the ledger
trigger/backfill, grants/RLS, advisory locks) and for the edge-side access
arithmetic in `supabase/functions/api/index.ts` (`accessPayload()`).

Nothing under `supabase/` is modified: every mutant is applied to a SCRATCH
copy under `artifacts/mutation/free-rating-ledger/<run-id>/scratch/<mutant>/`.

## Run

```bash
cd tools/mutation/free-rating-ledger
MUT_SEED=20260904 deno task run            # full matrix (Docker postgres:16 required)
MUT_FILTER='S36_|S45_' deno task run       # subset by id regex
MUT_ONLY=ts deno task run                  # edge (TypeScript) family only
```

Environment knobs: `MUT_SEED` (replayable probe inputs), `MUT_FILTER`,
`MUT_ONLY=sql|ts`, `MUT_PG_PORT` (default 55499), `MUT_OUT`, `MUT_KEEP_DB=1`
(leave the container + per-mutant databases for inspection), `MUT_DENO`.

## What runs per mutant

SQL mutants (`mutants_sql.ts`, ids `S01`…`S53`) — one database each inside a
single throwaway `postgres:16` container, loaded exactly like
`supabase/tests/run_rls_tests.sh` (`shim_auth.sql` + every migration in
order, with the ledger migration replaced by the mutant):

| stage                 | suite (unmodified, pre-existing)                                     | decides verdict |
| --------------------- | -------------------------------------------------------------------- | --------------- |
| `migrate`             | the migration chain itself                                           | yes             |
| `edge_live`           | `__wf__/be-edge-routes-shots-rank.test.ts` via `PICKLE_AUDIT_PG_URL` | yes             |
| `security_regression` | `supabase/tests/security_regression.sql` (A…J9) via psql             | yes             |
| `edge_static`         | `__wf__/db_migrations_rls_indexes.test.ts` on the scratch chain      | yes             |
| probes P1–P6, P8–P10  | `probes.ts` (new, this campaign)                                     | reported only   |
| `backfill_probe` P7   | pre-ledger chain → seed history → apply mutated ledger migration     | reported only   |

TS mutants (`mutants_ts.ts`, ids `T01`…`T14`) — scratch copy of
`supabase/functions/api/` with `index.ts` mutated; the edge black-box suite
(every `__wf__` test that does not need Postgres) runs against it. Failures in
the new `__wf__/free_rating_access_payload.test.ts` are reported separately
from failures in pre-existing tests.

Verdict rules: `KILLED` iff a pre-existing suite fails (or the mutated chain
does not apply). Otherwise `SURVIVED`; `caught_by_new_probes` lists which of
the additive probes/tests catch it. A mutant whose `find` text is not present
exactly once aborts the run (`HARNESS_ERROR`) instead of silently testing the
unmutated code.

## Probes (deterministic; all inputs derive from `MUT_SEED`)

- P1 `reserve_race_two_keys` — two connections, different idempotency keys, at
  1 scored; the second must block on the per-user advisory lock and get
  `access.paywall_required`; exactly one `reserved` permit.
- P2 `sync_race_two_permits` — two reserved permits at 1 scored, concurrent
  `apply_synced_shot`; the second must be refused by the backstop and its
  permit released with `outcome='free_limit_exceeded'`.
- P3 `grants_and_rls` — `authenticated`/`anon` cannot read the ledger, call
  the hash helper, the trigger writer, or `identity_scored_count()`'s
  internals; RLS on, no policies, no client grants.
- P4 `inherited_ledger_above_cap` — a fresh account whose identity hash has 5
  in the ledger must see `scored_count=5`, be refused a permit, and be refused
  a forged permit sync.
- P5 `lapsed_premium_not_premium` — an expired entitlement row is not premium
  at the SQL decision points.
- P6 `update_to_scored_increments_once` — a `low_confidence → scored`
  result_kind update increments the ledger exactly once.
- P7 `backfill_pre_existing_scored_shots` — history created BEFORE the ledger
  migration is backfilled (abstentions ignored) and survives account deletion.
- P8 `active_premium_bypasses_backstop` — an unexpired entitlement at ledger 5
  reserves AND syncs a scored shot (the backstop must honour premium) and the
  ledger still records it (6).
- P9 `multi_identity_counts_by_max` — Apple + Google identities on one account
  with ledgers 1/0 count as 1 (max); one scored shot lifts both rows to 2.
- P10 `stale_reserved_permit_ignored` — a reserved permit older than 24h does
  not occupy the last free slot.

## Outputs (`artifacts/mutation/free-rating-ledger/<run-id>/`)

- `results.json` — per mutant: id, target, description, diff path, every
  stage's command / exit / duration / log path / parsed failures, probe
  results with their seeds, `killed_by_existing`, `caught_by_new_probes`,
  verdict; plus `meta` (seed, commit, replay command) and `summary`.
- `matrix.md` — human-readable killed/survived matrix.
- `mutants/<id>.diff`, `mutants/<id>.sql` — the exact mutated source.
- `logs/<id>/<stage>.log` — raw stdout/stderr of every stage.

Committed copies of completed runs live in `results/<run-id>/` (scratch
directories and the full mutated `.sql` copies excluded — the `.diff` files
are kept; `results.json` / `matrix.md` are prettier-formatted so the root
`format:check` gate passes, content unchanged).

Runs on commit `4d812e1a`:

- `full-seed20260904` — the complete campaign (53 SQL + 14 TS mutants).
- `race-seed7`, `race-seed99` — the advisory-lock mutants (S36, S45) replayed
  at two more seeds to show the P1/P2 race probes are deterministic.
