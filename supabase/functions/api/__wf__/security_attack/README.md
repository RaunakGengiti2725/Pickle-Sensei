# Auth attack harness (`security-auth-attack-1`)

Execution-based adversarial suite against the REAL edge handler
(`supabase/functions/api/index.ts`, captured through `Deno.serve`), backed by a
stateful, cryptographically verifying fake Supabase Auth / PostgREST / Upstash
(`fakeSupabase.ts`: RS256 provider ID tokens pinned to issuer/audience/kid,
HS256 access tokens pinned to the project secret, live sessions, refresh
rotation with family revocation, `scope=local` logout). No production or hosted
Supabase resource is touched; every key/secret is generated per run and never
printed.

Files (new only — production code and existing tests are untouched):

- `jwt.ts` — base64url, HS256/RS256 sign+verify, seeded RNG, segment mutation.
- `fakeSupabase.ts` — the fake upstream, with per-call upstream log.
- `attackHarness.ts` — loads `index.ts` behind the fake, `callEdge`, artifacts.
- `token_forgery_matrix.test.ts` — alg:none, stripped/garbled/borrowed
  signatures, wrong secret, rogue RSA key, alg confusion, issuer/audience/kid
  spoofing, expiry edge cases, altered claims, malformed shapes, seeded fuzz
  (x3 authenticated routes), bootstrap forgeries, base64url signature alias.
- `session_lifecycle_attack.test.ts` — replay, cold-cache concurrency,
  refresh rotation / reuse / family revocation, logout-then-reuse (exact,
  sibling, TOCTOU race), transitional provider-token branch, expiry, deleted
  account.
- `cache_poisoning_attack.test.ts` — `auth:<sha256>` key characterization
  (100k / 250k samples), namespace crossover, forged L2 row, L1/L2 divergence
  after remote revocation, eviction pressure.

## Run

```bash
cd supabase/functions/api/__wf__
AUTH_ATTACK_ARTIFACT_DIR=/tmp/auth-attack deno test -A --no-check --config deno.json security_attack/
# scaled, replayable (seed drives every fuzz mutation / hash sample)
AUTH_ATTACK_SEED=7 AUTH_ATTACK_FUZZ=3000 AUTH_ATTACK_HASHES=250000 AUTH_ATTACK_REPLAY=1000 \
  AUTH_ATTACK_ARTIFACT_DIR=/tmp/auth-attack-seed7 deno test -A --no-check --config deno.json security_attack/
```

Defaults: `AUTH_ATTACK_SEED=20260904`, `AUTH_ATTACK_FUZZ=600`,
`AUTH_ATTACK_HASHES=100000`, `AUTH_ATTACK_REPLAY=200`. `deno task test` in
`__wf__` picks the suite up as well.

Artifacts (JSON): `forgery_matrix.json` (every attempt with route, status,
upstream calls, safe token fingerprint, and for fuzz cases the exact mutated
segment/position/char), `bootstrap_forgery.json`, `signature_alias.json`,
`session_lifecycle.json`, `hash_collision.json`, `cache_namespace.json`,
`l2_forged_entry.json`, `l1_divergence.json`, `eviction_pressure.json`.

Tests named `REPRO (defect)` assert the CURRENT (defective) behaviour so the
repro is executable; fixing the defect will flip them, which is the intended
signal. The rate limiter's 429 is recorded separately and is never counted as
an auth verdict.
