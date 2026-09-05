# Adjudication reproductions — `security-secrets-deps`

Independent reproductions written while adjudicating the auditor reports for
this area at `4d812e1aa699014cc0521fd92fde66908043aaa8`. Nothing here is wired
into `pnpm test` or CI and nothing changes production code. Each script exits
**0 when the gate HELD** (the defect is fixed) and **1 when BROKEN** (the
defect reproduces), **2 on setup failure** — so they double as regression tests
for the fixes. Every planted "secret" is random per run, never printed, and
lives only in a throwaway clone that is deleted on exit; reports are written to
`~/adjudication-artifacts/security-secrets-deps/` (override with `ADJ_OUT`).

```sh
tools/adjudication/security-secrets-deps/r1_gitleaks_allowlists.sh     # ~30 s
tools/adjudication/security-secrets-deps/r2_scanner_binary_trust.sh    # ~20 s
tools/adjudication/security-secrets-deps/r3_history_scope.sh           # ~30 s
tools/adjudication/security-secrets-deps/r4_deps_stage_skip.sh         # ~1-2 min (root pnpm install in a clone)
tools/adjudication/security-secrets-deps/r5_dependency_audit_absent.sh # needs registry access
K6=/path/to/k6 tools/adjudication/security-secrets-deps/r6_k6_smoke_dead_target.sh   # 60 s
tools/adjudication/security-secrets-deps/r7_edge_suite_shuffle.sh      # ~1 min
```

| Script | Reproduces at 4d812e1a                                                                                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `r1`   | 16 of 17 planted files are missed by BOTH `--tree` and `--history`: every `paths` allowlist in `.gitleaks.toml` (gitignored env files, build/dep dirs, media/model extensions, and the four `paths`+`regexes` allowlists without `targetRules`) exempts the whole file. |
| `r2`   | `GITLEAKS_BIN=/bin/true`, a same-version impostor in `SECURITY_SCAN_CACHE`, and a same-version impostor on `PATH` all turn a tree with a planted canary green (exit 0); a malformed `.gitleaks.toml` (gitleaks exit 2) is reported as exit 1 ("findings").              |
| `r3`   | default `--history` (no `--log-opts`) fails a clean HEAD because of a canary on an unrelated branch; a `--depth 1` clone passes with the canary one commit behind HEAD.                                                                                                 |
| `r4`   | `verify-cloud.sh --only deps` exits 0 on a drifted `apps/mobile/package.json` that `npm ci --dry-run` rejects (EUSAGE), because `npm ci` is skipped when `node_modules` exists.                                                                                         |
| `r5`   | no gate runs `pnpm audit`/`npm audit`; `apps/mobile` `npm audit --omit=dev` reports 9 high + 11 moderate.                                                                                                                                                               |
| `r6`   | `k6 run tools/loadtest/smoke.js` exits 0 against `127.0.0.1:9` with `http_req_failed` = 100 % and every functional check failing.                                                                                                                                       |
| `r7`   | `deno test --shuffle=1                                                                                                                                                                                                                                                  | 2   | 3`fails 2–4`account_routes.test.ts`cases (401 where 400/429 expected) while`deno task test` passes. |
