# db-schema-migrations adversarial harness

Executable attacks against the Supabase schema (`supabase/migrations/*.sql`)
on a throwaway `postgres:16` with hosted-like default privileges
(`supabase/tests/shim_auth.sql`) and every migration applied in order. The
scenarios run as the `authenticated` role with a forged
`request.jwt.claim.sub`, exactly like `supabase/tests/security_regression.sql`.

Nothing here touches production; `run_attack.sh` only ever talks to a local
docker container. Every scenario runs inside one transaction that is rolled
back, so the container can be reused across runs.

```sh
./supabase/tests/attack/setup_db.sh          # docker: pickle-attack-db, port 55432
./supabase/tests/attack/run_attack.sh        # every scenario; exit = number BROKEN
./supabase/tests/attack/run_attack.sh s6 x1  # a subset
```

Each scenario prints `OBSERVED ...` lines with the raw values it measured and
ends with either `<id>: HELD` (psql exit 0) or an `ERROR: <id> BROKEN: [...]`
raised from a `do` block listing every assertion that failed (psql exit 3).
Logs land in `$ATTACK_OUT` (default `artifacts/attack-db/`).

| id  | file                                      | attack                                                                                                                  | result on 4d812e1a |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------ |
| S1  | `s1_cascade_delete_scale.sql`             | `EXPLAIN (ANALYZE, BUFFERS) DELETE FROM auth.users` at 5,000 shots × 6 phases; FK index audit; rank-trigger cost bound  | BROKEN             |
| S2  | `s2_search_path_hijack.sql`               | `pg_temp.profiles` + `search_path=pg_temp,public` around `complete_onboarding()`                                        | HELD               |
| S3  | `s3_orphan_finalized_permit.sql`          | owner inserts `finalized/scored` permits with no shot                                                                   | HELD               |
| S4  | `s4_three_direct_reserved_permits.sql`    | owner inserts 3 reserved permits; edge clamp arithmetic; sync all three                                                 | HELD               |
| S5  | `s5_reopen_finalized_permit.sql`          | at 2 scored, rewind finalized permits to reserved                                                                       | HELD               |
| S6  | `s6_permit_reuse_after_reset.sql`         | reserve → scored sync → rewind permit → second scored sync on the same permit                                           | BROKEN             |
| S7  | `s7_truncate_privileges.sql`              | `TRUNCATE` as `authenticated`; TRUNCATE/TRIGGER/REFERENCES grant survey                                                 | BROKEN             |
| X1  | `x1_concurrent_reserve_and_sync.sh`       | two sessions racing `reserve_analysis_permit` / `apply_synced_shot`; rollback mid-flight                                | HELD               |
| X2  | `x2_cron_sweeps_and_clock_skew.sql`       | pg_cron sweep bodies at 100k permits; 25h-old and future-dated permits; purge SQL                                       | HELD               |
| X3  | `x3_malformed_unicode_huge_denial.sql`    | anon denial, no-claim calls, atomic write failure, 128/129-char keys, emoji, RTL, 5,000 phases, 200× replays, 1970/2100 | HELD               |
| X4  | `x4_account_deletion_identity_ledger.sql` | delete account → ledger survives → same Apple subject re-created stays paywalled; dead-uid RPCs; linked identities      | HELD               |

Local `postgres:16` has no `pg_cron`; X2 executes the sweep SQL bodies
directly, so the schedule installation itself stays UNKNOWN here.
