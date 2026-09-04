# xc_rsm_c — seeded randomized state-machine campaign

Adversarial, replayable randomized testing of the production edge function
(`supabase/functions/api/index.ts`) — router, `authenticate()`, auth cache
(`cache.ts`) and fixed-window rate limiter (`rateLimit.ts`) — under random
request interleavings, clock skew and cache expiry. No hosted Supabase, no
provider credentials, no production code changes.

## What runs

- The REAL `index.ts` is imported (its `Deno.serve` handler is captured), once
  as a Redis-less "solo" isolate and three times as Upstash-backed isolates
  `c1..c3` that share one fake Redis — the shape of a scaled deployment.
  `cache.ts` / `rateLimit.ts` are re-materialised per isolate so each one has
  its own L1 memory and rate-limit fallback (`edgeIsolates.ts`).
- `fakeSupabase.ts` is a stateful GoTrue + PostgREST + Upstash stand-in:
  provider ID-token exchange, refresh rotation, `scope=local` logout,
  session revocation (a revoked session's bearer fails `getUser` like
  `session_not_found`), injectable 5xx faults, and a per-call gate that parks
  Auth responses so the harness controls completion order.
- `virtualClock.ts` replaces `Date.now()` process-wide: forward jumps across
  rate-limit windows and cache expiry, plus backward skew.
- `model.ts` is the reference oracle (401/429 semantics, cache TTL rules,
  fixed-window buckets). `campaign.ts` draws every decision from `prng.ts`
  (seeded sfc32) and runs three phases per seed:
  - **A** sequential, solo isolate, bit-exact comparison against the oracle;
  - **B** up to 16 concurrent requests on one isolate with randomised Auth
    completion order (logout / verify / refresh races);
  - **C** concurrent requests spread across the three Redis-backed isolates.

Every request record carries seed, idx, PRNG draw count, phase, isolate, IP,
route, bearer kind, SAFE token reference (never the token), virtual
timestamps, expected vs observed, upstream call state and a replay command.

Replay is exact: `deterministicDigest.ts` swaps `crypto.subtle.digest` for a
synchronous `node:crypto` hash behind a settled promise, so the auth-cache
key hashes in `cache.ts` no longer resolve in worker-pool order and the whole
interleaving of phases B/C is a function of the seed alone (checked: two
processes running seed 3000/3002/3006 produced identical per-request
`idx:phase:route:kind:isolate:status:virtualTime:reason` traces). A seed
must run in a fresh process — isolates are shared and never reset.

## Commands

```sh
cd supabase/functions/api/__wf__

# full campaign: seeds 3000-3099, >= 2000 requests each, all artifacts
deno run -A --no-check --config deno.json xc_rsm_c/scripts/run_campaign.ts \
  --seeds 3000-3099 --min-requests 2000 --out /tmp/xc-rsm-c

# replay one failure (seed + request idx from failures.jsonl)
deno run -A --no-check --config deno.json xc_rsm_c/scripts/run_campaign.ts \
  --seeds 3001 --focus 2732 --out /tmp/xc-rsm-c-focus

# invariants pinned inside `deno task test` (auto-discovered)
deno test -A --no-check --config deno.json xc_rsm_c/xc_rsm_c_invariants_test.ts

# deterministic bug reproductions (fail on purpose; NOT auto-discovered)
deno test -A --no-check --config deno.json xc_rsm_c/repros/logout_cache_repro.ts
deno test -A --no-check --config deno.json xc_rsm_c/repros/upstream_5xx_repro.ts
```

Artifacts written by `run_campaign.ts`: `campaign.log`, `seeds.jsonl` /
`seeds.json` (per-seed tables), `summary.json`, `matrices.json`
(truth × status, bearer kind × status, refusal reason × status, upstream
fault × status, per phase), `failures.jsonl` (one replayable record per
invariant violation), `failure-groups.json`, `heap.json`, and the edge
access log of one seed. Exit code is 1 when any hard invariant failed.

## Invariants

| id                            | meaning                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| MODEL_EXACT                   | phase A response equals the oracle (status, headers, error code)         |
| EXPIRED_BEARER_REFUSED        | an expired bearer never yields anything but 401 (or a 429 lock)          |
| UNKNOWN_BEARER_REFUSED        | garbage / forged / foreign-issuer bearers never authenticate             |
| REVOKED_SESSION_REFUSED       | a bearer whose session was logged out before launch is never authorized  |
| RATE_LIMIT_RESPONSE_SHAPE     | every 429 carries Retry-After, RateLimit-Limit/Remaining, no-store       |
| IP_BUDGET / AUTHFAIL_*        | per-IP and auth-failure windows close at exactly `limit`                 |
| USER_BUDGET / REFRESH_BUDGET  | per-user and anonymous refresh windows close at exactly `limit`          |
| REFRESH_ROTATION              | a rotated-away refresh token is refused                                  |
| UPSTREAM_5XX_NOT_AUTH_FAILURE | (soft) an Auth 5xx must not be reported as 401 / charged as auth failure |

`REVOKED_SESSION_REFUSED` and `UPSTREAM_5XX_NOT_AUTH_FAILURE` fail on the
current `index.ts`; see `repros/` for the minimal deterministic cases.
