# Rate-limit / abuse adversarial harnesses (edge function)

Executable probes against `supabase/functions/api/{rateLimit,cache,http,index}.ts`.
Nothing here touches a hosted project: Redis is the repo's `fakeUpstash`, Supabase
Auth is a local stub, and `index.ts` is loaded in-process the same way
`__wf__/index_preauth_test.ts` does. Every run is deterministic (LCG seed
`0x5eed_1337` = `1592595255`) and writes a JSON table under
`artifacts/xc-rate-limit-dos/`.

```bash
export PATH=$HOME/.deno/bin:$PATH            # Deno 2.x
cd <repo root>

# 100k distinct rate-limit keys (short / 1 KiB / 8 KiB / 32 KiB ids) + 100k cache keys,
# heap sampled with an exposed GC; ~1 min
deno run -A --v8-flags=--expose-gc tools/adversarial/rate-limit-dos/heap_flood.ts

# clientIp() identity matrix: cf-connecting-ip / X-Forwarded-For shapes → rate-limit key
deno run -A tools/adversarial/rate-limit-dos/clientip_matrix.ts

# fixed-window boundary bursts, Retry-After sweeps, Redis 500 / hang / flap / key flood
deno run -A tools/adversarial/rate-limit-dos/limiter_attacks.ts

# the REAL handler: co-tenant lockout, spoofed-identity flood erasing a lockout,
# oversized identities, Retry-After headers on every 429 shape
deno run -A --no-check tools/adversarial/rate-limit-dos/handler_abuse.ts

# run tools/loadtest/auth-abuse.js (k6) against the real handler on Linux
deno run -A --no-check tools/adversarial/rate-limit-dos/serve_local_edge.ts &
k6 run -e BASE_URL=http://127.0.0.1:8000 tools/loadtest/auth-abuse.js
```

`--no-check` on the two files that import `index.ts` matches the repo's edge test
task: `index.ts` carries the 20 documented pre-existing untyped-supabase-client
errors (AGENTS.md); the harness files themselves type-check clean
(`deno check --config tools/adversarial/rate-limit-dos/deno.json …` reports only
`index.ts` locations).

## What the runs showed (Linux, Deno 2.9.6, commit 4d812e1a)

| probe | result |
| --- | --- |
| memory-fallback map at its 20 000-entry cap, 8 KiB ids | +158.7 MiB retained (8 319 B/key) |
| same, 32 KiB ids (largest identity `index.ts` accepted) | +627.4 MiB retained (32 897 B/key) |
| 100k distinct ids, any size | every live window wiped at 20 000 keys; a locked-out canary was re-allowed 5× per 100k |
| real handler, 10 000 requests with rotating `cf-connecting-ip` | victim's 30/300 s auth-failure lockout erased mid-window (429 → 401) in 0.49 s |
| real handler, 30 bad tokens from one address | every other caller on that address gets 429 on `/v1/me`, bootstrap and refresh for the rest of the 300 s window |
| clientIp() | 10/16 header shapes yield an attacker-chosen identity when the gateway does not stamp `cf-connecting-ip`; 0 `rl:`/`auth:` key-namespace collisions |
| Redis HTTP 500 | 1.4 ms/call, memory fallback still enforces the limit (does NOT fail open globally) |
| Redis blackhole | 1 201 ms/call → ≈4.8 s added per authenticated request (4 L2 calls, no breaker) |
| Redis flap (online → 500 → online, 2 isolates) | 90 auth failures accepted in one 300 s window against a limit of 30 |
| Retry-After (1 800 samples over 60/300/3 600 s windows) | always 1 ≤ value ≤ window, ≤ 0.999 s overshoot, never still blocked after waiting |
| fixed-window boundary | exactly 2× the limit crosses a bucket edge (documented fixed-window property) |
| cache.ts L1, 100k keys | +0.88 MiB; MEMORY_MAX_ENTRIES=5 000 eviction holds |
| `tools/loadtest/auth-abuse.js` vs local real handler | passes: 30×401 (30 Auth calls) then 91×429 with 0 further Auth calls |
