# Adversarial harnesses — `security-secrets-deps`

Executable attacks against the secret-scanning, dependency-audit and lockfile
gates, written against commit `4d812e1aa699014cc0521fd92fde66908043aaa8`.
Each script exits **0 only when every protection it probes HELD** and **1 when
any check is BROKEN**, so they double as regression tests once a gap is closed.
Nothing here changes production code, commits to the repository, or contacts a
production system; every planted "secret" is a deterministic synthetic string
derived from the recorded seed.

```bash
# from the repo root; artifacts default to artifacts/attack-security-secrets-deps/<scenario>/
tools/attack-security-secrets-deps/s1_gitleaks_cache_tamper.sh
tools/attack-security-secrets-deps/s2_audit_blackhole.sh
tools/attack-security-secrets-deps/s3_mobile_lockfile_drift.sh     # slow: runs verify-cloud --only deps
tools/attack-security-secrets-deps/s4_lockfile_integrity_flip.sh
tools/attack-security-secrets-deps/s5_resolved_url_provenance.sh
tools/attack-security-secrets-deps/s8_gitleaks_ruleset_probe.sh
tools/attack-security-secrets-deps/s9_python_dep_surface.sh
# S6/S7 (services/api auth) — needs the docker postgres_test service:
(cd services/api && DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test \
  npx vitest run test/attack-security-secrets-deps.test.ts)
```

`ATTACK_ARTIFACTS=<dir>` relocates the artifact root. Each run writes
`<scenario>/verdict.txt` (`HELD|BROKEN|<check>|exit=<n>|<log>|<summary>` lines).

| Script                                 | Attack                                                                                                                               | Result at 4d812e1a                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s1_gitleaks_cache_tamper.sh`          | append a byte to the cached gitleaks; same-version impostor in the cache; impostor on `PATH`                                         | BROKEN ×3 — `reports_version` is the only check on a cached/`PATH` binary; an impostor answering `8.30.1` turns the security stage green with a planted key in the tree                                       |
| `s2_audit_blackhole.sh`                | proxy that 503s / resets `/-/npm/v1/security/*`; `npm audit --omit=dev`, `pnpm audit --prod`; pipeline coverage                      | clients HELD (exit 1); BROKEN — no verify-cloud/CI stage runs any audit (`npm ci --no-audit`), so neither an outage nor a real advisory can fail the pipeline                                                 |
| `s3_mobile_lockfile_drift.sh`          | bump `zustand` range in `apps/mobile/package.json` without regenerating the lockfile                                                 | `npm ci --dry-run` / `npm ci` HELD (EUSAGE exit 1); BROKEN — `verify-cloud --only deps` passes because `npm ci` is skipped whenever `apps/mobile/node_modules` exists                                         |
| `s4_lockfile_integrity_flip.sh`        | flip one sha512 in `apps/mobile/package-lock.json` and one in `pnpm-lock.yaml`                                                       | HELD ×2 — `EINTEGRITY` and `ERR_PNPM_TARBALL_INTEGRITY`                                                                                                                                                       |
| `s5_resolved_url_provenance.sh`        | `resolved` → `http://`; `resolved` → attacker host serving a tarball whose sha512 matches the rewritten `integrity`                  | BROKEN ×3 — npm installs the attacker tarball; nothing in the repo lints lockfile provenance                                                                                                                  |
| `attack-security-secrets-deps.test.ts` | S6: `DevTokenVerifier` under `PICKLE_ENV=production`; S7: `ADMIN_AUTH_SUBJECTS=''` + admin-claim dev token → `PUT /v1/admin/flags/x` | HELD — 14/14 (throws in production/staging; 403 `auth.admin_not_authorized`, also under 25 concurrent requests, whitespace/comma parsing, exact-match subjects, Unicode secret lengths)                       |
| `s8_gitleaks_ruleset_probe.sh`         | plant JWT / AWS / Stripe / generic keys inside every path-scoped allowlist of `.gitleaks.toml`; tracked `.env`                       | BROKEN ×6 — every `paths`+`regexes` allowlist without `targetRules` skips the WHOLE FILE in `gitleaks dir` mode (v8.30.1 `sources/common.go shouldSkipPath`); `condition = "AND"` alone does not fix dir mode |
| `s9_python_dep_surface.sh`             | is there anything for `pip audit` to audit?                                                                                          | no manifest, pipeline installs nothing (HELD); BROKEN — `tools/paddle-lab`, `tools/latency-bench`, `datasets/experiments` import torch/transformers/mediapipe/rfdetr/cv2 with no manifest to audit or pin     |

`advisory-blackhole-proxy.mjs` is the registry reverse proxy used by S2
(`--mode 503|reset|hang`, blocks only `/-/npm/v1/security/*`, logs every
request as JSON lines).
