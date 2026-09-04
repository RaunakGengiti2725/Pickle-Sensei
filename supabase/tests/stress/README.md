# Concurrency stress harness — `db-deletion-consent`

Seeded, replayable concurrency campaigns against the account-deletion / consent
unit: `public.account_deletion_requests`, `public.account_deletion_feedback`,
`public.consent_records`, `public.account_external_credentials`, and the
`auth.users → public.profiles → owned rows` cascade.

New files only; nothing here modifies production code, migrations, or the
existing `supabase/tests/security_regression.sql` matrix (which stays the
functional source of truth — this harness attacks the _interleavings_ that a
single-session matrix cannot express).

## Run

```bash
# throwaway postgres:16 on 127.0.0.1:5499 with shim_auth.sql + every migration
./supabase/tests/stress/setup_stress_db.sh

# fast default (24 iterations, suite-safe, < 1s)
node supabase/tests/stress/deletion_consent_concurrency.mjs

# full campaign
STRESS_ITER=600 STRESS_OUT=/tmp/stress/rc.json \
  node supabase/tests/stress/deletion_consent_concurrency.mjs

# SERIALIZABLE actors (40001 retried, retries counted)
STRESS_ITER=600 STRESS_ISOLATION=serializable STRESS_OUT=/tmp/stress/ser.json \
  node supabase/tests/stress/deletion_consent_concurrency.mjs

# replay exactly one iteration
STRESS_REPLAY=3706727369 STRESS_ONLY=request_vs_delete \
  node supabase/tests/stress/deletion_consent_concurrency.mjs
```

Exit code: `0` every executed iteration HELD, `1` at least one BROKEN (or a
short run), `2` harness/setup failure.

| env                   | default                                         | meaning                                         |
| --------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `STRESS_DB_URL`       | `postgres://postgres:x@127.0.0.1:5499/postgres` | target DB                                       |
| `STRESS_ITER`         | `24`                                            | iterations (campaigns use 600+)                 |
| `STRESS_SEED`         | `1`                                             | master seed; iteration seed = `sha256(seed:i)`  |
| `STRESS_OUT`          | —                                               | write the full seed → outcome JSON table here   |
| `STRESS_REPLAY`       | —                                               | comma-separated iteration seeds to replay       |
| `STRESS_ONLY`         | —                                               | restrict to one scenario (RNG stream unchanged) |
| `STRESS_ISOLATION`    | `read_committed`                                | `serializable` for SERIALIZABLE actors          |
| `STRESS_POOL`         | `24`                                            | concurrent sessions                             |
| `STRESS_ITER_WALL_MS` | `30000`                                         | per-iteration wall-time bound (hang/deadlock)   |

Every iteration provisions two fresh users (Apple/Google identities through the
shim's `handle_new_user` trigger), drives one scenario as `Promise.all` bursts
of independent sessions, asserts, then drops both users.

## Actors

Each concurrent operation gets its own session and transaction:

- `authenticated` — `set local role authenticated` +
  `request.jwt.claim.sub` (what PostgREST does; RLS applies).
- `service_role` — the edge function's admin plane.
- `owner` — the migration owner, i.e. what `auth.admin.deleteUser()` and the FK
  cascades run as.

Each transaction sets `lock_timeout = 5s` and `statement_timeout = 15s`, so a
deadlock or lock convoy surfaces as `40P01` / `55P03` / `57014` instead of
hanging; those states fail the iteration unless the scenario explicitly allows
a deletion race (`23503`) or an RLS denial (`42501`).

## Scenarios

| scenario                    | interleaving                                                                                | invariants                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `request_rearm_burst`       | N concurrent PostgREST-shaped re-arm upserts, one user                                      | exactly one row, no lost update (surviving challenge == last applied), challenge live |
| `request_two_actors`        | two users re-arm while one tries cross-user select/update/delete/owner-reassign             | per-user row counts, no cross-user write or read, denials are `42501`                 |
| `consent_burst`             | grant/withdraw appends across scopes + UPDATE/DELETE/cross-user/null-owner attacks          | row count == successful appends, append-only, owner-pinned, fold deterministic        |
| `request_vs_delete`         | request writes + consent + exit survey racing `delete from auth.users`                      | cascade removes owned rows, surveys survive anonymized, losers fail `23503` only      |
| `external_credentials_race` | service-role capture/checkpoint/revoke/clear (+ optional cascade, + client read)            | ≤1 row, `token ⇔ captured_at`, client `42501`, revoked state == last applied write    |
| `double_confirm`            | two devices race delete-confirm, then a stale bearer re-arms                                | exactly one delete lands, stale write fails closed                                    |
| `clock_skew_probe`          | backdated `created_at`, far-future / inverted `expires_at`                                  | records what the schema accepts (see the repro `.sql` next door)                      |
| `survey_burst`              | duplicate survey submissions + owner read / cross-user / null-owner / UPDATE / owner DELETE | write-only for clients, append-only even for the owner plane                          |

Behaviours that are ambiguous rather than wrong are recorded as per-iteration
`observations` (e.g. `created_at` ordering vs commit ordering in the consent
fold, a bootstrap capture re-arming `apple_revoked_at`) instead of being
asserted either way.

`repro_deletion_request_clock_skew.sql` is the standalone SQL repro for the
`clock_skew_probe` observation.
