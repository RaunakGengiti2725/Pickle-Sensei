# Edge Function perf harness (`perf-edge-latency-n1`)

In-process benchmark of the REAL `supabase/functions/api/index.ts` handler
against emulated upstreams. Every outbound `fetch` the handler makes is
recorded and classified (`supabase_auth`, `supabase_rest`, `redis`,
`revenuecat`, `other`) and attributed to the request that made it via
`AsyncLocalStorage`, so per-route round trips are exact counts, not estimates.

Files:

- `perfHarness.ts` — boots `index.ts` through a captured `Deno.serve`, emulates
  Supabase Auth, PostgREST (tables, RPCs, `offset`/`limit` paging, upserts),
  RevenueCat, Upstash Redis (REST pipeline subset) and records bytes + calls.
  Redis on/off and per-class injected latency are process-level options.
- `perfScenarios.ts` — 47 deterministic route scenarios (seeded users, UUIDs,
  tokens, payloads; N-scaling for `shots:sync` and evaluation trials; cache
  hit / L1-miss / L2-hit / 2 500-row pagination variants).
- `perf_edge_latency_bench.ts` — runner: p50/p95/p99 latency, hot and per-class
  round-trip distributions, request/response/upstream byte sizes, forced-GC
  heap deltas, status counts, replayable failure records (seed + user index +
  full request body), console error/warn counts.
- `perf_round_trips.test.ts` — one request per scenario pins the upstream call
  matrix (runs under the canonical `deno task test`).
- `perf_summarize.ts` — renders JSON outputs into `results/SUMMARY.md`.
- `run_matrix.sh` — the 2×2 matrix (redis off/on × latency zero/simulated),
  one process per mode (Redis wiring and the L1 cache are module state).
- `results/` — raw outputs from the run described in SUMMARY.md.

Run:

```bash
cd supabase/functions/api/__wf__
deno test -A --no-check --config deno.json perf/perf_round_trips.test.ts
bash perf/run_matrix.sh 1000 perf-edge-latency-n1
deno run -A --v8-flags=--expose-gc --config deno.json perf/perf_edge_latency_bench.ts \
  --redis off --latency zero --requests 1000 --scenario shots-sync-50 --out /tmp/one.json
```

Reading the numbers: latencies are handler wall time in one Deno process with
zero or INJECTED upstream latency (`SIMULATED_LATENCY` in `perfHarness.ts`:
auth 60 ms, PostgREST 20 ms, Redis 3 ms, RevenueCat 150 ms). They are not
measurements of the hosted platform; the round-trip counts and payload sizes
are exact for this commit, and the simulated column shows how the sequential
chain multiplies whatever the real per-call latency is. "hot" round trips =
Supabase Auth + PostgREST + RevenueCat; Redis is reported separately.
