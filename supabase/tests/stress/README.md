# supabase/tests/stress — concurrency stress harness (db-billing-webhook-tables)

Real-Postgres interleaving campaign for the service-only billing tables
(`public.billing_entitlements`, `public.webhook_events`) and the permit/ledger
paths that read them. Nothing here touches a hosted project: the harness refuses
any non-loopback `STRESS_PG_URL` and the production project id.

```
./run_db_billing_webhook_concurrency.sh                  # STRESS_ITER=3 → 21 rounds, ~5s, suite-friendly
STRESS_ITER=80 ./run_db_billing_webhook_concurrency.sh   # campaign: 7 scenarios × 80 rounds = 560 interleavings
STRESS_ROUND_SEED=<seed> STRESS_FILTER=S5 ./run_db_billing_webhook_concurrency.sh   # replay one round
```

Every round is a pure function of its seed (xorshift PRNG → user ids, event ids,
verdicts, clock skew, lane jitter, cancel lanes). Each scenario writes
`<out>/<scenario>.json` with a `seedTable` (seed → HELD / BROKEN /
BROKEN(known-gap)), per-lane inputs, server-side start/end timestamps and the
exact replay command. Wall time per burst is bounded (`STRESS_WALL_MS`, default
20 s) so a deadlock or lost lane is a failure, not a hang.

| scenario                                  | what contends                                                                           | hard invariants                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| S1 `webhook_same_event_id`                | N deliveries of one event id (edge seen-check + `on conflict do nothing`), cancel lanes | exactly one audit row, zero lane errors, bounded wall                                     |
| S2 `webhook_mixed_ids_sweep`              | duplicate + fresh ids under the 90-day purge, anon/authenticated probes                 | one row per id, purge only removes old rows, clients always 42501                         |
| S3 `entitlement_same_user_upsert_skew`    | N verdicts (±clock skew) for user A, user B present, cancel lanes                       | one row per user, no torn row, cancelled verdicts never persist, `access_state()` agrees  |
| S4 `entitlement_upsert_vs_cascade_delete` | upserts racing `delete from auth.users`                                                 | no orphan row (FK 23503 or cascade), bystander intact                                     |
| S5 `premium_flip_during_reserve_apply`    | premium→free flip during reserve/apply bursts, bystander reader                         | no rating after the flip commit, shots = permits = ledger, flip not lost, no double spend |
| S6 `permit_sweep_vs_apply_boundary`       | cron expiry sweep vs `apply_synced_shot` on permits straddling 24 h, two users          | every permit ends finalized or released, scored ≤ 2 per free user, contract verdicts only |
| S7 `entitlement_rls_under_writes`         | authenticated/anon probes while service role rewrites both rows                         | own-row reads only, every client write 42501, webhook_events unreadable                   |

Known gaps (recorded as `BROKEN(known-gap)`, do not fail the suite, have
deterministic repros under `repro/`):

- S3 `newest_verdict_wins`: the entitlement upsert is last-committer-wins; an
  older verdict can overwrite a newer one (`repro/repro_entitlement_lost_update.sh`).
- S5 `no_transient_write_failed_on_premium_flip`: `apply_synced_shot()` reads
  premium, then the shots BEFORE INSERT trigger re-reads it in a new snapshot; a
  flip committed in between yields `shot.write_failed:42501` with the permit
  left reserved until the retry (`repro/repro_apply_premium_flip_toctou.sh`).
- S1 observation `lanesThatPassedSeenCheck`: concurrent duplicate deliveries all
  pass the read-then-write replay check (`repro/repro_webhook_seen_check_race.sh`).

`STRESS_STRICT=1` promotes known gaps to failures.
