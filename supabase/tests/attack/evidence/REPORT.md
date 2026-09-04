# db-schema-migrations — adversarial pass 3/3 (tester #1)

Baseline `4d812e1aa699014cc0521fd92fde66908043aaa8`. Plane: cloud (Linux, docker `postgres:16.15`).
Harness: `supabase/tests/attack/` (new files only) on branch `devin/attack-db-schema-migrations-1`.
Migrations are byte-identical between the baseline and `origin/main` (`git diff --stat origin/main 4d812e1a -- supabase/migrations` → empty), so every finding below is **regression: no** (pre-existing).

## Results

| id  | attack                                                                                  | result |
| --- | --------------------------------------------------------------------------------------- | ------ |
| S1  | `EXPLAIN (ANALYZE, BUFFERS) DELETE FROM auth.users` @ 5,000 shots × 6 phases            | BROKEN |
| S2  | `pg_temp.profiles` + `search_path=pg_temp,public` around `complete_onboarding()`        | HELD   |
| S3  | owner inserts `finalized/scored` permit with no shot                                    | HELD   |
| S4  | owner inserts three reserved permits directly                                           | HELD   |
| S5  | at 2 scored, rewind finalized permit to reserved                                        | HELD   |
| S6  | rewind a spent permit and sync a second scored shot through it                          | BROKEN |
| S7  | `TRUNCATE public.shots` as `authenticated`; TRUNCATE/TRIGGER/REFERENCES survey          | BROKEN |
| X1  | concurrent reserve / sync races, rollback mid-flight                                    | HELD   |
| X2  | pg_cron sweep bodies @ 100k permits, 25h-old + future-dated permits, purges             | HELD*  |
| X3  | anon/no-claim denial, atomic failures, 128/129-char keys, emoji/RTL, 5k phases, replays | HELD   |
| X4  | account deletion vs identity ledger, dead-uid RPCs, linked identities                   | HELD   |

\* `pg_cron` is not in the `postgres:16` image; the three sweep statements were executed directly. Schedule installation is UNKNOWN locally.

Commands + exit codes: `summary.json`. Raw per-scenario logs: `<id>_*.log` (every `OBSERVED` line is a value read from the database).

## Findings

### F1 · P0 · `authenticated` can TRUNCATE client tables (cross-user data loss despite RLS)

- files: `supabase/migrations/20260831160000_defense_in_depth.sql:49-100` (revokes only INSERT/UPDATE/DELETE), `supabase/tests/shim_auth.sql:57-64` (hosted default privileges = GRANT ALL), `supabase/migrations/20260902130000_shots_delete_revoke.sql:16`
- repro: `./supabase/tests/attack/setup_db.sh && ./supabase/tests/attack/run_attack.sh s7` → exit 1 (log: `s7_truncate_privileges.log`)
- observed: `TRUNCATE public.shots` as `authenticated` fails only on the FK dependency (`0A000 cannot truncate a table referenced in a foreign key constraint`), never on privilege; `TRUNCATE public.shots CASCADE` **SUCCEEDED** and wiped every user (shots 2→0, shot_phases 12→0, captures 1→0) while RLS showed the attacker exactly 1 shot; `TRUNCATE public.billing_entitlements` **SUCCEEDED** (1→0) even though INSERT/UPDATE/DELETE are revoked there. `authenticated` holds TRUNCATE, TRIGGER and REFERENCES on 15 tables: account_deletion_requests, analysis_feedback, analysis_permits, billing_entitlements, captures, consent_records, evaluation_trials, player_rank_state, profiles, sessions, shot_checkpoints, shot_measurements, shot_phases, shots, user_saved_drills — including TRUNCATE-but-not-DELETE on 10 of them. `anon` holds none. Service-only tables (`free_rating_ledger`, `webhook_events`) correctly deny (42501). TRIGGER is not directly weaponisable today (no trigger-returning function is executable by client roles → `42501 permission denied for function public.set_updated_at`); REFERENCES only reaches temp tables (`42P16`).
- expected: `42501 permission denied` for every TRUNCATE; no TRUNCATE/TRIGGER/REFERENCES on any client table.
- decision: add a new migration `revoke truncate, trigger, references on all tables in schema public from anon, authenticated;` plus `alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;` and pin it in `security_regression.sql`. TRUNCATE bypasses RLS and row-level DELETE revokes by design in PostgreSQL, so this is the only fix.
- regression: no (identical on `origin/main`)
- VERIFIED locally against the hosted-like default privileges that `shim_auth.sql` documents; the production project's actual ACLs were not read (off-limits).

### F2 · P1 · account deletion cascades do sequential scans and O(n) rank recomputes per deleted shot

- files: `supabase/migrations/20260829120000_progress_data.sql:173-174` (`captures.session_id`, `captures.shot_id` `ON DELETE SET NULL` with no index), `supabase/migrations/20260902000000_account_deletion_feedback.sql:24` (`account_deletion_feedback.user_id` SET NULL, no index), `supabase/migrations/20260902130100_cascade_user_indexes.sql:14-20` (covers only shot_phases/shot_measurements/analysis_feedback), `supabase/migrations/20260829150000_player_rank.sql:184-186` (`shots_player_rank_refresh` row trigger fires on DELETE), `supabase/migrations/20260831130000_form_weighted_rank.sql:120-201` (`recompute_player_rank` re-aggregates all remaining shots)
- repro: `./supabase/tests/attack/run_attack.sh s1` → exit 1 (log: `s1_cascade_delete_scale.log`)
- observed (5,000 shots, 30,000 phases/measurements/checkpoints, 5,000 captures, ~10k background captures): `DELETE FROM auth.users` = 2,940 ms; `captures_shot_id_fkey` RI trigger = 1,447 ms over 5,000 calls via **Seq Scan** on `captures`; `captures_session_id_fkey` also Seq Scan; `shots_player_rank_refresh` = 1,315 ms (44.7 % of the delete), per-call cost 40 µs @ 500 shots → 263 µs @ 5,000 shots (6.5×, bound in the test 3×). Control run with temporary indexes on `captures(shot_id)`/`captures(session_id)`: `captures_shot_id_fkey` 1,447 → 18.6 ms, total 2,940 → 1,023 ms; remaining cost is the rank trigger. The audit test (`db_migrations_rls_indexes.audit.test.ts`) uses 1 shot and cannot see either.
- expected: every child-side FK column of a deletable parent indexed (no Seq Scan in RI checks); rank refresh cost bounded per delete (skip on DELETE when the owner row is being cascaded, or recompute once per statement).
- regression: no

### F3 · P2 · a spent permit rewound to `reserved` authorises another scored shot (permit ↔ shot never linked)

- files: `supabase/migrations/20260902150000_free_rating_identity_ledger.sql:408-409` (`apply_synced_shot` only checks `v_permit.status <> 'reserved'`), `supabase/migrations/20260831160000_defense_in_depth.sql:69` (owner may UPDATE `status`, `outcome`), `supabase/migrations/20260829120000_progress_data.sql` (no `permit_id` on `shots`, no `shot_id` on `analysis_permits`)
- repro: `./supabase/tests/attack/run_attack.sh s6` → exit 1 (log: `s6_permit_reuse_after_reset.log`)
- observed: `reserve=accepted`, `sync_1=accepted`, permit `finalized/scored`; owner `UPDATE analysis_permits SET status='reserved', outcome=null`; `sync_2_same_permit=accepted` (permit finalized/scored again). The free cap still held: `sync_3_same_permit=access.paywall_required`, final `scored_shots=2 ledger=2`; a low-confidence sync through the rewound permit is also accepted; a premium owner produced 10 scored shots off ONE permit. `columns_linking_shots_to_permit=(none)`.
- expected: refused (`access.permit_not_reserved` or a dedicated code) — a permit should authorise at most one shot; a `permit_id` on `shots` (unique) or `shot_id` on `analysis_permits` would make the state machine checkable.
- impact: free-tier monetisation is NOT bypassed (lifetime ledger backstop holds); permit accounting/audit trail is corruptible by the owner, and any future logic that trusts permit state (analytics, refunds, rate budgets) is off.
- regression: no

## Verified OK (HELD)

See `summary.json` → `scenarios`, and the `X*` logs; highlights:

- S2: `pg_temp.profiles` shadowing under `search_path=pg_temp,public` — real `public.profiles` row flipped to onboarding-complete; shadowed `now()` ineffective; direct `updated_at` write denied; client roles cannot CREATE in `public`.
- S3: orphan `finalized/scored` permits (single, bulk, unicode/oversized outcomes) — `scored_count=0`, ledger unchanged; a real reserve+sync then counts once.
- S4: three hand-inserted reserved permits — raw `reserved_count=3`, edge arithmetic clamps to `reserved=2 availableToReserve=0 canStartRating=false`; `reserve_analysis_permit=access.paywall_required`; syncing all three → accepted, accepted, `access.paywall_required`; replay of #1 idempotent; replay of #3 `permit_not_reserved`.
- S5: reopening finalized permits at 2 scored — paywall stays closed, clamp holds, low_confidence still syncs.
- X1: two concurrent reserves → 1 accepted + `paywall_required`, exactly 1 reserved permit; two concurrent scored syncs at 1 scored → 1 accepted + `paywall_required`, ledger=2; rollback mid-flight releases the advisory lock and the waiting reservation proceeds.
- X2: 100k-permit sweep uses `analysis_permits_reserved_created_idx` (Index Scan, 31 ms); 2,000 stale released, 100 fresh preserved; 25h-old permit lazily expired on sync (`access.permit_expired`); future-dated permits are consumed by the free cap; purge SQL for deletion requests / webhook events correct.
- X3: anon → 42501 on all five RPCs; authenticated without claim → `auth.required`, zero rows; scored-without-score and 65-char phase key fail atomically (`shot.write_failed:*`, 0 rows, permit still reserved); 128-emoji key accepted, 129-char key `23514`; 64-emoji shot_type stored (256 octets), 65 rejected; RTL override accepted verbatim; cross-user session `shot.session_not_found`; 200× shot and reserve replays all idempotent; capturedAt 1970/2100 accepted; 5,000-phase low_confidence shot accepted without moving the cap.
- X4: after `DELETE FROM auth.users` every account-owned row is gone (feedback kept with `user_id NULL`), `free_rating_ledger=2` survives; same Apple subject re-created → `scored_count=2`, reserve `paywall_required`, hand permit `paywall_required`, abstention still syncs; dead-uid sync `permit_not_found`, dead-uid reserve raises `23503` (no row written); linked Apple+Google identities both credited; `authenticated` denied on ledger table and hash fn (42501); no-identity account: shot accepted, ledger row 0 (documented known limit).
- Canonical: `./supabase/tests/run_rls_tests.sh` → ALL CASES PASSED (exit 0); `__wf__` db_migrations tests 6 passed / 0 failed (exit 0); `pnpm format:check`, `pnpm lint`, `pnpm typecheck` → exit 0.
