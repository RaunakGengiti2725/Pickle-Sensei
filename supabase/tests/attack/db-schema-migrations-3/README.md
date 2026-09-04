# Adversarial pass #3 — `db-schema-migrations`

Executable attacks against the 17 Supabase migrations at `4d812e1a`, run on a
throwaway `postgres:16` (Docker) with `supabase/tests/shim_auth.sql` + every
migration applied in lexical order. Nothing here touches production.

```
./supabase/tests/attack/db-schema-migrations-3/run.sh            # boot + all scenarios
./supabase/tests/attack/db-schema-migrations-3/run.sh s3_concurrent_apply x3_direct_insert_bypass
ATTACK_SKIP_BOOT=1 ./supabase/tests/attack/db-schema-migrations-3/run.sh s7_premium_flip_under_lock
```

Each scenario clones the template DB (`create database … template tpl`) so
scenarios never share state. Output: `artifacts/attack-db-schema-migrations-3/latest/`
(`<scenario>.log`, per-session `.out` files for the concurrency tests, `results.json`).
Exit code 0 ⇔ every scenario printed `SCENARIO HELD`.

| script                            | scenario                                                                               | verdict @4d812e1a                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `s1_migration_rerun.sh`           | re-run `20260902150000_free_rating_identity_ledger.sql` on a populated DB              | HELD (S1b: re-run re-credits a service-role-reassigned shot — informational) |
| `s2_permit_boundary.sh`           | permit at `now()-24h+1s` crossing `access_state()`→`apply_synced_shot`                 | HELD                                                                         |
| `s3_concurrent_apply.sh`          | two `apply_synced_shot` sessions on the advisory lock at lifetime=1 (+ 8-way stampede) | HELD                                                                         |
| `s4_identity_reappears.sh`        | same Google subject under a new `auth.identities.id`                                   | HELD                                                                         |
| `s5_service_role_result_flip.sh`  | service-role `low_confidence`→`scored`; repeat is a no-op                              | HELD (S5b: flip-flop double-credits — informational)                         |
| `s6_service_role_user_move.sh`    | service-role `shots.user_id`→bob; ranks both, ledger not credited                      | HELD                                                                         |
| `s7_premium_flip_under_lock.sh`   | `premium=false` flipped while a reserve waits on the lock                              | HELD                                                                         |
| `x1_detail_rows_owner_drift.sh`   | own: detail rows keep the OLD `user_id` after a shot move                              | BROKEN                                                                       |
| `x2_premium_expiry_frozen_now.sh` | own: `expires_at` lapsing during a lock wait is not seen (`now()` is tx-frozen)        | BROKEN (P3)                                                                  |
| `x3_direct_insert_bypass.sh`      | own: `authenticated` direct `INSERT` into `public.shots` skips permit + paywall        | BROKEN                                                                       |
