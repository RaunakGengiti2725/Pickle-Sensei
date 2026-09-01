# Load tests (k6)

Load-testing suite for the production API (the `api` Supabase Edge Function).
Run these before launch and after any backend change that touches the hot
path (auth, access, sync, rank/progress).

## Install k6

```sh
brew install k6        # macOS
# or: https://k6.io/docs/get-started/installation/
```

## Scripts

| Script          | Auth needed | What it proves                                                                                                        |
| --------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `smoke.js`      | none        | Public endpoints stay fast + correct under concurrency; limiter answers 429s with `Retry-After`, never 5xx.           |
| `auth-abuse.js` | none        | Token stuffing yields only 401/429; after the per-IP failure budget the limiter blocks WITHOUT hitting Supabase Auth. |
| `user-flow.js`  | real token  | The app's launch/read mix (bootstrap → access → rank → progress → drills) under N concurrent users.                   |

```sh
BASE=https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api

k6 run -e BASE_URL=$BASE tools/loadtest/smoke.js
k6 run -e BASE_URL=$BASE tools/loadtest/auth-abuse.js
k6 run -e BASE_URL=$BASE -e TOKEN=<google-id-token> -e VUS=20 tools/loadtest/user-flow.js
```

## Reading results

- **Thresholds** are the pass/fail contract: `server_errors rate<0.01` (the
  backend never melts into 5xx under load) and p95 latency budgets.
- **429s are success, not failure**, in these tests: they demonstrate the
  rate limiter shedding load deliberately. `user-flow.js` reports them in the
  `rate_limited` metric. All VUs share one token/user, so heavy VU counts
  exercising per-user limits is expected; real traffic spreads across users.
- Latency p95 on cold isolates includes edge cold-start; re-run once warm for
  steady-state numbers.

## Scale posture (why this holds at 100k+ users)

- Edge Functions scale horizontally (isolates per region) with no server
  state: sessions, counters, and caches live in Upstash Redis when
  configured, so any instance can serve any request.
- Verified auth sessions are cached (~10 min) — Supabase Auth sees ~1 exchange
  per user per 10 minutes, not one per request.
- The access computation is one RPC round trip; shot sync is one atomic RPC
  per shot with a single batched replay lookup; rank/progress responses are
  cached with write-time invalidation.
- Postgres carries partial indexes matching the hot counters exactly, and
  pg_cron does housekeeping off the request path.

## Safety

These scripts hit production. `smoke.js`/`auth-abuse.js` touch no user data
and stay within tiny request budgets (≤ ~2 rps). `user-flow.js` writes
nothing (reads + an idempotent bootstrap) but authenticates as the account
whose token you supply — use a dedicated test account.
