# Stress harnesses — `db-billing-webhook-tables`

Seeded, replayable stress campaigns for the two service-only billing tables:
`public.billing_entitlements` and `public.webhook_events`. Nothing here touches
production code or the applied migrations; every file is additive.

## Lens `boundary-malformed`

| File                           | Purpose                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `boundary_malformed.mjs`       | node-pg harness: seeded RNG, 5 scenario families, parallel sessions, JSON seed→outcome table, `--replay <seed>`.                  |
| `boundary_malformed_repro.sql` | Exact `psql` repros of every boundary observation, asserted (`ON_ERROR_STOP`), fully rolled back. Doubles as a regression pin.    |
| `run_boundary_malformed.sh`    | Throwaway `postgres:16` on `:5499` (or `PGURL`), shim + all migrations, then the SQL repros and the harness. Small default (200). |

### Run

```sh
./supabase/tests/stress/run_boundary_malformed.sh                    # 200 iterations, default seed
STRESS_ITER=3000 STRESS_SEED=7 STRESS_PARALLEL=16 ./supabase/tests/stress/run_boundary_malformed.sh
node supabase/tests/stress/boundary_malformed.mjs --replay 465363499  # one iteration, exact inputs
```

Environment: `PGURL` (default `postgres://postgres:x@localhost:5499/postgres`),
`STRESS_ITER` (200), `STRESS_SEED` (20260904), `STRESS_PARALLEL` (8),
`STRESS_OUT` (`supabase/tests/stress/out/boundary_malformed.json`).

Iteration `i` of master seed `M` uses a per-iteration seed derived from `(M, i)`;
each row of the JSON table records that seed, the generated inputs (tagged), the
outcome, the SQLSTATE and any violated invariant, so any row can be replayed in
isolation with `--replay <seed>` regardless of concurrency.

### Scenarios and invariants

- `webhook_insert` — service_role inserts a generated `(id, event_type, app_user_id, payload)`
  in a transaction. Invariants: rejection is a typed SQLSTATE in `22xxx`/`23xxx`/`54xxx`
  and writes no row; acceptance stores the id byte-for-byte and replays are a no-op
  under `on conflict (id) do nothing` (the idempotency key).
- `billing_upsert` — service_role upserts a generated `(user_id, premium, product_key, expires_at)`.
  Invariants: exactly one row per user, never a row for an unknown user, product_key
  round-trips (after UTF-8 well-forming), typed rejection otherwise.
- `rls_probe` — `set local role authenticated|anon` + `request.jwt.claim.sub` /
  `request.jwt.claims` set to generated (often malformed) subjects. Invariants:
  authenticated sees only its own `billing_entitlements` row; every write to
  `billing_entitlements` and every statement on `webhook_events` is `42501`; malformed
  subjects fail the uuid cast (`22P02`) or see nothing.
- `concurrency` — N parallel sessions (READ COMMITTED and SERIALIZABLE) racing the same
  idempotency key / user. Invariants: exactly one row survives, first writer wins,
  malformed payloads in the race never write.
- `sweep` — the `purge-old-webhook-events` statement is extracted verbatim from
  `20260831000000_scale_and_security.sql` and executed against rows planted around the
  90-day boundary (`epoch`, `-infinity`, `infinity`, max timestamptz, ±1 s). Invariant:
  exactly the strictly-older rows are deleted.

Input families (102 tags): truncated / trailing-garbage / BOM / single-quote JSON,
`NaN`/`Infinity`/`-0`/`1e100000`/`1e200000`, `\u0000` escapes and raw NUL bytes, lone
surrogates, `__proto__`/`constructor`/`prototype` keys, `../../etc/passwd` ids, SQL-ish
text, RTL override, 64 KiB–1 MiB strings, 20 000-codepoint single-grapheme strings,
NFC/NFD pairs, braced / upper-case / dash-less uuids, whitespace-padded booleans,
timestamps with nanoseconds / year 294277 / `+99:00` offsets, future `schema_version`
values, empty arrays and objects, 100 000-deep nesting.

### Known, accepted behaviour (not findings)

- No length cap exists on any column of either table; the only limit is the
  `webhook_events` primary-key btree (incompressible ids ≥ ~2 700 bytes → `54000`).
  A 65 536-byte `event_type` and a 1 MiB payload string are stored. Bounding is the
  edge function's job (`readBody` caps the request body).
- `id` is compared byte-wise: NFC and NFD spellings of the same text are distinct
  idempotency keys.
- `-0` is stored as `0`; `1e100000` is stored as a 100 001-digit numeric.
- pg_cron is not available in the local `postgres:16` image, so the purge job is never
  scheduled locally; the harness executes its SQL body directly.
