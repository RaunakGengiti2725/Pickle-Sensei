# supabase/tests/stress

Concurrency stress harnesses for the database layer. They run against a
DISPOSABLE local Postgres only — never a hosted project.

## db-pg-cron-sweeps × concurrency

`cron_sweeps_concurrency.mjs` races the three maintenance jobs scheduled in
`supabase/migrations/20260831000000_scale_and_security.sql`
(`expire-stale-analysis-permits`, `purge-expired-deletion-requests`,
`purge-old-webhook-events`) against live writes: permit reservation via
`reserve_analysis_permit`, shot syncs via `apply_synced_shot`, permit
finalization, deletion-request upserts/reads and RevenueCat webhook logging.

The statements are not re-typed: the harness parses the `cron.schedule(...)`
bodies out of the migration and executes exactly those strings as the owner
role. Stock `postgres:16` has no pg_cron, so the scheduler itself is out of
scope (`report.json` records `env.pgCronInstalled`); what runs here is the SQL
each job would run.

Each iteration is a pure function of its seed: two fresh users, seeded permit /
deletion / webhook ages (including buckets that straddle the 24h, 1-day and
90-day boundaries mid-burst), then a `Promise.all` burst of lanes that all wait
on one barrier — duplicate sweeps, duplicate applies, apply-during-sweep,
rollback mid-call, two actors on the same permit row, and clock skew via
per-lane `pg_sleep` delays. Lanes hold independent connections and
transactions; `authenticated` lanes set `role` + `request.jwt.claim.sub` so RLS
applies as it does in production. After the burst each sweep runs twice more,
modelling pg_cron's next tick.

Invariants (`I1`–`I13`, see `checkInvariants`): no lane error, deadlock or
statement timeout; free accounts never exceed two lifetime scored ratings and
the identity ledger agrees; sweeps only ever collect rows past their retention
window, and collect every row that is; sweeps are idempotent modulo the clock;
accepted applies persist exactly one shot and consume their permit; rejected
applies leave nothing behind; a finalized permit is never re-expired; no lost
update on a permit row; reservation idempotency keys never mint twins; user B
can neither read nor consume user A's rows and cannot read `webhook_events`.

### Run

```bash
./supabase/tests/stress/pg_up.sh            # disposable postgres:16 + shim + all migrations
STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
  node supabase/tests/stress/cron_sweeps_concurrency.mjs
./supabase/tests/stress/pg_up.sh down
```

Exit code is 0 only if every iteration HELD. `report.json` (seed → inputs,
lanes, sweep counts, final state, outcome) and `failures.json` land in
`STRESS_OUT`.

| env / flag                | default                                     | meaning                                                   |
| ------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `STRESS_PG_URL`           | —                                           | required; disposable database                             |
| `STRESS_ITER`             | `20`                                        | iterations (campaigns use 600; keep the default small)    |
| `STRESS_SEED`             | `20260904`                                  | campaign base seed                                        |
| `STRESS_OUT`              | `artifacts/stress/db-pg-cron-sweeps/latest` | report directory                                          |
| `STRESS_SERIALIZABLE=1`   | off                                         | run the sweep lanes SERIALIZABLE (retries 40001, bounded) |
| `STRESS_NONCE`            | per-run                                     | reuse a run's identity subjects (ledger state)            |
| `STRESS_MUTANT`           | none                                        | harness self-check, see below                             |
| `--seed <n> --repeat <k>` | —                                           | replay one seed k times                                   |

### Self-check

`STRESS_MUTANT` breaks the harness's own copy of one statement (never the
migration) and must be caught by exactly one invariant — proof that a green
campaign means something:

| mutant                     | breaks                                 | expected failure       |
| -------------------------- | -------------------------------------- | ---------------------- |
| `permit-sweep-1h`          | permit sweep collects after 1h         | `I3.sweep_only_stale`  |
| `deletion-sweep-0d`        | deletion purge drops the 1-day grace   | `I9.retention_grace`   |
| `webhook-sweep-1d`         | webhook retention drops to 1 day       | `I13.retention_window` |
| `finalize-no-status-guard` | finalize without `status = 'reserved'` | `I6.finalize_once`     |
