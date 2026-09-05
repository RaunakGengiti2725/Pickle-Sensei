# Stress campaign — `POST /v1/sessions/:id/finalize` (the "end session" route)

Lens: **failure injection + load**. Real Edge Function handler (`../index.ts`)
booted in-process with Supabase Auth, PostgREST, Upstash and RevenueCat
replaced by seeded fakes; database semantics re-run against a disposable
`postgres:16` with every migration applied. No production code, test or
migration is modified by this campaign — these files are additive.

Note on the unit name: the assignment called the route `POST /v1/sessions/:id (end)`.
The router, the implementation (`finalizeSession`) and the mobile caller
(`apps/mobile/src/data/api.ts finalizeSession`) all use
`POST /v1/sessions/:id/finalize`; `POST /v1/sessions/:id` and
`POST /v1/sessions/:id/end` are 404 (`F57`, `F58`).

## Files

| file                                | what it does                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stress_end_session_harness.ts`     | boots the real handler, attributes every upstream `fetch` to a request id, seeded PRNG, fault scripts (`status`/`raw`/`throw`/`hang`/`delay`), latency + heap helpers, JSON writers                      |
| `stress_end_session_faults.test.ts` | **F00–F62**: 63 fault cases across Auth / PostgREST select / PostgREST update / RevenueCat / route input, plus the PostgREST no-deadline probe and a 10× flake re-run                                    |
| `stress_end_session_redis.test.ts`  | **R00–R25 (+R11b)**: 27 Upstash fault cases in a Redis-enabled isolate (HTTP errors, malformed 200 bodies, hang, socket, partial replies, revocation marker, poisoned/corrupt L2)                        |
| `stress_end_session_load.test.ts`   | **L1** ≥1000 seeded requests (p50/p95/p99, status + Supabase-round-trip histograms) · **L2** concurrent duplicate delivery · **L3** 20k distinct users vs the 5 000-entry L1 auth cache (GC-forced heap) |
| `stress_end_session_pg.test.ts`     | **PG1–PG5** against docker `postgres:16` + all migrations: idempotent replay, 16-lane duplicate delivery, cross-tenant/anon isolation, column-level grants, shots/permits/free-rating ledger untouched   |

Slow knobs (small defaults so the suite stays fast): `STRESS_ITER` (default
1000), `STRESS_USERS` (default 2000; campaign ran 20000), `STRESS_SEED`
(default 20260905), `STRESS_OUT_DIR` (default `artifacts/stress-end-session/latest/`,
git-ignored). Every row in every JSON table carries its seed and an exact
`--filter` replay command.

## Commands (all exit 0 on the campaign run)

```sh
cd supabase/functions/api/__wf__
deno task test                                                     # canonical suite incl. these files
STRESS_OUT_DIR=out/faults deno test -A --no-check --config deno.json stress_end_session_faults.test.ts
STRESS_OUT_DIR=out/redis  deno test -A --no-check --config deno.json stress_end_session_redis.test.ts
STRESS_ITER=1000 STRESS_USERS=20000 STRESS_OUT_DIR=out/load \
  deno test -A --no-check --v8-flags=--expose-gc --config deno.json stress_end_session_load.test.ts
XC_PG_CONTAINER=pickle-stress-pg XC_PG_PORT=55434 ./xc_pg_up.sh    # disposable postgres:16 + 21 migrations
XC_PG_URL=postgres://postgres:pg@127.0.0.1:55434/postgres STRESS_ITER=1000 STRESS_OUT_DIR=out/pg \
  deno test -A --no-check --config deno.json stress_end_session_pg.test.ts
```

`--v8-flags=--expose-gc` matters for L3: without it the heap delta includes
garbage (40 MB at 2 000 users) and the retained-memory assertion is skipped.

## Findings reproduced (seeded; details in the JSON tables)

| id                             | severity | observed                                                                                                                                                                                                                                                  |
| ------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `F33`, `F35`                   | P2       | a 2xx PostgREST select body without an `ended_at` field (or a non-object body) is treated as "already ended" → **HTTP 200 with no UPDATE**: the outbox marks the finalize done while the row stays open on the server                                     |
| `F25`, `F29`, `pg_no_deadline` | P2       | PostgREST GET 503 / socket failure → postgrest-js retries 1 s/2 s/4 s (4 upstream attempts, ≈7.0 s) before the 503 surfaces; a hung PostgREST holds the request open indefinitely (no AbortSignal on the route's DB calls; Auth is bounded to 6 s)        |
| `R11`, `R11b`                  | P2       | a reached Upstash that answers a **string** in the revocation-marker slot (`GET auth:revoked:*`) is read as "revoked" → 401 "The session is no longer valid. Sign in again."; the marker is copied into L1 for 60 s so the refusal outlives the bad reply |
| `R13`, `R25`                   | P2       | a hanging Upstash costs 1.2 s **per sequential Redis call**: 6 calls cold / 4 warm → every request takes ≈7.2 s / ≈4.8 s (still 200; the mobile client times out at 20 s)                                                                                 |
| `L2`, `PG2`                    | P3       | concurrent duplicate deliveries all read `ended_at IS NULL` and each issue an UPDATE (16 lanes → 16 writes, last writer wins; stamps differ by ms). Final state is correct and nothing is double-spent; the update carries no `ended_at is null` guard    |

Everything else HELD — see the JSON tables for the exact status / typed code /
outbox class / round-trip counts per case.
