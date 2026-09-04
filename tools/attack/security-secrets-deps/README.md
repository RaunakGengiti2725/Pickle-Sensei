# Adversarial harnesses — `security-secrets-deps` (pass 3)

Executable attacks against the secret-scanning gate, the dependency/lockfile
gates, and the edge function's secret-gated / public surface. Every script is
self-contained, runs on Linux only, contacts no production service, and writes
`results.txt` plus raw logs into its artifact directory (default
`~/attack-artifacts/<scenario>`). Exit code 0 = every check HELD; 1 = at least
one BROKEN check (details in `results.txt`).

| Scenario                                                                   | Command                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| S1 `security-scan.sh --history` on a `--depth 1` clone                     | `s1_shallow_clone_history.sh [OUT]`                           |
| S2 `verify-cloud.sh --only deps` with stale mobile lockfile + node_modules | `s2_stale_mobile_lockfile.sh [OUT]`                           |
| S3 `wf-cache-stampede.js` at CONCURRENCY=200, no Upstash env               | `s3_cache_stampede_no_upstash.sh [OUT]`                       |
| S4/S5/S9 malformed `.gitleaks.toml`, subdirectory gate, custom `sk_` rule  | `s4_s5_s9_gitleaks_gate.sh [OUT]`                             |
| S6/S8 webhook idempotency, WEBHOOK_LIMIT, 503/401/400 matrix               | `deno run -A s6_s8_webhook.ts [OUT]` (uses `webhook_stub.ts`) |
| S7 osv-scanner over the Deno dependency tree                               | `s7_deno_lock_osv.sh [OUT]`                                   |
| S10 `pnpm audit --prod`, mobile `npm audit`, lockfile integrity, python    | `s10_dependency_audits.sh [OUT]`                              |
| S11 debug endpoints, security headers, body caps, per-IP key derivation    | `deno run -A s11_debug_endpoints_defaults.ts [OUT]`           |

Synthetic secrets planted by S1/S4/S9 are generated per run inside throwaway
clones / untracked files and never match a real credential format in use.
`webhook_stub.ts` is a PostgREST-shaped in-memory `webhook_events` table
(the `__wf__/supabase_stub.ts` does not model that table); `/__stub/state`
exposes the rows so the harness can assert exactly-once persistence.
