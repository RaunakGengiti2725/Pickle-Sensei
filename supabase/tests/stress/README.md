# `supabase/tests/stress` — seeded stress campaigns against the schema

Adversarial, seeded, replayable campaigns that drive the migrated schema
through the same roles the edge function uses (`authenticated` with JWT
claims, `anon`, `service_role`, table owner). They complement
`security_regression.sql` (fixed matrix) with generated boundary inputs.

## db-deletion-consent · boundary / malformed input

Unit: `public.account_deletion_requests`, `public.account_deletion_feedback`,
`public.consent_records`, `public.account_external_credentials` and the
`auth.users → profiles → children` cascades.

```
./supabase/tests/stress/run_db_deletion_consent_stress.sh                 # 300 iterations
STRESS_ITER=3000 STRESS_SEED=20260904 STRESS_OUT=/tmp/results.json \
  ./supabase/tests/stress/run_db_deletion_consent_stress.sh               # full campaign
STRESS_REPLAY=<seed> ./supabase/tests/stress/run_db_deletion_consent_stress.sh
cd supabase/tests/stress && deno task test                                # generator tests (+ DB test when PICKLE_STRESS_PG_URL is set)
```

The script boots `postgres:16` in Docker, installs `tests/shim_auth.sql`,
applies every `migrations/*.sql` in order and runs
`db_deletion_consent_boundary.ts`. Exit 0 = every iteration HELD, exit 1 =
at least one BROKEN iteration (seed, inputs, violations and a psql-ready
repro are in `STRESS_OUT`), exit 2 = environment failure.

Formatting authority is the ROOT prettier (`pnpm format:check`), as for the
rest of `supabase/`; `deno lint` / `deno check` run from this directory.

Environment: `PICKLE_STRESS_PG_URL` (reuse a prepared DB), `STRESS_ITER`
(default 300), `STRESS_SEED` (default 20260904), `STRESS_REPLAY=<seed>`
(single iteration), `STRESS_OUT` (JSON seed → outcome table),
`STRESS_CONCURRENCY` (default 8 workers; parallel scenarios open up to 9
extra sessions each).

### What each iteration does

Every iteration is derived from `iterationSeed(campaignSeed, index)`; its
scenario, users and every generated value come from that one seed.
Transactional scenarios provision two fresh users inside a transaction that
is always rolled back. Parallel scenarios commit on independent sessions and
clean up via `delete from auth.users` (anonymised feedback rows stay behind
by design).

| scenario                    | actor                                       | what is stressed                                                                             |
| --------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `consent_insert`            | authenticated                               | every column of `consent_records`, jsonb `device` parse + 4096-byte cap (live oracle)        |
| `feedback_insert`           | authenticated                               | every column of `account_deletion_feedback`, duplicate/malformed ids, no SELECT grant        |
| `deletion_request_upsert`   | authenticated                               | PostgREST-style upsert incl. `user_id` reassignment, timestamps, other user's row            |
| `credentials_service_write` | service_role                                | token 20..8192 codepoints, token/captured pairing, FK, timestamps                            |
| `credentials_client_probe`  | authenticated / anon                        | every payload (valid or not) answers 42501                                                   |
| `cross_user`                | authenticated                               | select/update/delete/insert-as-other across all four tables, snapshot unchanged              |
| `ledger_mutation`           | authenticated / anon / owner / service_role | update/delete/truncate on append-only ledgers                                                |
| `cascade`                   | owner                                       | delete `auth.users` → children gone, feedback anonymised byte-identical, bystander untouched |
| `parallel_upsert`           | 2..8 sessions                               | concurrent `account_deletion_requests` upserts, READ COMMITTED + SERIALIZABLE                |
| `parallel_delete_race`      | 2..8 sessions + deleter                     | client writes racing account deletion never leave an owned row                               |

Generated value classes (see `generators.ts`): at-cap / cap±1 / 2×cap / 64 KB+
/ 256 KB+ strings measured in codepoints against grapheme clusters (flags,
ZWJ families, Sinhala clusters, combining runs), NUL and C0/C1 controls,
zero-width/bidi, path traversal, injection-ish, lone surrogates, future
versions, NFC/NFD/NFKC normalisation pairs, homoglyph/fullwidth/case
variants of enums, malformed / truncated / prototype-pollution / duplicate-key
/ deeply nested / numeric-overflow / NaN / Infinity / -0 JSON, int32 and
int64 boundaries, hex/octal/binary/underscore integers (PG16 accepts these —
decided by a live oracle), timestamp edge spellings, malformed / nil / other
user's / unknown UUIDs.

### Invariants (a violation = BROKEN)

- **I1** typed, graceful SQLSTATE only: class 22, 23, 54 or 42501. Anything
  else (XX, 08, 57, 40P01, driver exception, dropped connection) is BROKEN.
  40001 under SERIALIZABLE is retryable, not BROKEN.
- **I2** a rejected write leaves the iteration's rows unchanged.
- **I3** the oracle holds: contract-invalid input is rejected, contract-valid
  input is accepted (a false rejection is a 503 in the edge function).
- **I4** accepted rows satisfy the declared caps when re-read as owner and
  round-trip byte-for-byte (unless the input carried a lone surrogate).
- **I5** the connection survives the attempt.
- RLS / role / append-only / cascade / parallel-consistency checks per
  scenario as described above.
