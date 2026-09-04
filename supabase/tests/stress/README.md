# supabase/tests/stress

Stress harnesses that drive the SAME schema `run_rls_tests.sh` asserts against
(`tests/shim_auth.sql` + every `supabase/migrations/*.sql` in order) from
parallel sessions, with seeded inputs so every iteration is replayable from its
seed alone. New files only — nothing here changes a migration, an existing test
or production code.

## Database

```bash
./supabase/tests/stress/setup_db.sh      # postgres:16 on :5499, shim + migrations
docker rm -f pickle-stress-db            # tear down
```

`STRESS_PG_CONTAINER` / `STRESS_PG_PORT` override the container name and port.

## db_drills_saved_boundary.mjs — `public.user_saved_drills` + grants

Boundary/malformed-input campaign against the bookmarks table and the grants an
`authenticated` session holds on it. Each iteration opens a transaction, becomes
`authenticated` (or `anon`) with `set local request.jwt.claim.sub` +
`request.jwt.claims`, runs ONE randomized operation (insert, insert with a
client-supplied `saved_at`, PostgREST-style upsert, update of `slug`, update of
`saved_at`, delete, select, the same three as a cross-user attempt, an anon
insert, a slug taken out of a malformed JSON body, and a malformed JWT
principal), reads back what actually persisted, classifies, then rolls back — so
workers never contaminate one another and the campaign is idempotent.

Generators cover malformed/truncated JSON, wrong types, prototype-pollution
keys (`__proto__`, `constructor`, `prototype`), NaN/±Infinity/-0/1e309/64-bit
overflow, null bytes, 64KB and 1MB strings against the 120-char cap, byte vs
codepoint vs grapheme boundaries (emoji ZWJ sequences), Unicode normalization
pairs (NFC/NFD), homoglyphs, RTL/Bidi controls, newline anchor-bypass attempts,
path traversal and SQL/regex metacharacters in slugs, future schema-version
columns, empty strings/arrays/objects, and non-finite or out-of-range
timestamps.

```bash
node supabase/tests/stress/db_drills_saved_boundary.mjs                 # 240 iterations (suite default)
STRESS_ITER=3200 STRESS_OUT=/tmp/campaign.json \
  node supabase/tests/stress/db_drills_saved_boundary.mjs               # full campaign
STRESS_REPLAY=drills-saved-boundary:143 STRESS_REPLAY_TIMES=10 \
  node supabase/tests/stress/db_drills_saved_boundary.mjs               # replay one seed 10x
```

| env                   | default                     | meaning                               |
| --------------------- | --------------------------- | ------------------------------------- |
| `STRESS_ITER`         | `240`                       | iterations (seeds `<campaign>:<i>`)   |
| `STRESS_WORKERS`      | `6`                         | concurrent pg sessions                |
| `STRESS_SEED`         | `drills-saved-boundary`     | campaign prefix (whole run is a seed) |
| `STRESS_PG_URL`       | `…@127.0.0.1:5499/postgres` | target cluster                        |
| `STRESS_OUT`          | _(off)_                     | write `{summary, results}` JSON       |
| `STRESS_REPLAY`       | _(off)_                     | comma-separated seeds to replay       |
| `STRESS_REPLAY_TIMES` | `1`                         | repeats per replayed seed             |

Verdicts: HELD = a typed SQLSTATE rejection with nothing persisted, or an
accepted write whose persisted row satisfies every invariant. BROKEN = an
untyped/internal error, a lost connection, or an accepted write that violates
one of them:

- `i1` `slug` matches `user_saved_drills_slug_bounds`
- `i2` the persisted `user_id` is the JWT subject (no cross-user write)
- `i3` `saved_at` is finite and inside `[2000-01-01, 2100-01-01)`
- `i4` the string the API would return for `saved_at` is `Date.parse`-able,
  which is what `apps/mobile/src/training/api.ts` `isIso()` requires

Exit codes: 0 = every iteration HELD, 1 = at least one BROKEN, 2 = setup
failure.

## repro_saved_at_unbounded.sql

Minimized SQL for the `i3`/`i4` failures the campaign found (client-writable,
unbounded `saved_at`; table-wide client UPDATE grant). Run instructions are in
the file header.
