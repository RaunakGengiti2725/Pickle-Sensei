# Adversarial pass #3 — `ci-workflows-scripts` (baseline 4d812e1a)

Executable attacks on `scripts/verify-*.sh`, `scripts/security-scan.sh`,
`tools/devin`, `tools/diagnostics`, `tools/macos-ci` and the workflow YAML.
Nothing here changes production behaviour; every harness exits 0 only when
all of its checks HELD and writes its evidence under
`artifacts/attack-ci-workflows-scripts-3/<scenario>/` (`verdict.txt` lists
`HELD|BROKEN|<check>|exit=N|<artifact>|<summary>` per check).

| Harness                              | Attack                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `s1_api_readiness_json_nokey.sh`     | `api_readiness.sh --json` with no `DEVIN_API_KEY` / unreachable API / typo'd flag                             |
| `s2_probe_unmigrated_db.sh`          | `local_api_probe.mjs --start --with-account` against an empty (un-migrated) Postgres                          |
| `s3_probe_concurrent_start.mjs`      | two concurrent `local_api_probe.mjs --start`; decoy server winning the port race                              |
| `s4_mac_remote_dirty_check.sh`       | `mac-full-verify.sh --remote` dirty-tree check vs untracked/staged/detached HEAD (git/gh shimmed, no Mac run) |
| `s5_security_scan_shallow_clone.sh`  | `security-scan.sh --history` on `git clone --depth 1`; `--log-opts` with unresolvable / empty ranges          |
| `s6_verify_all_cloud_args.sh`        | `verify-all.sh --cloud-args '<malformed>'` forwarding; Apple half after a Linux argument error (shimmed)      |
| `s7_verify_cloud_duplicate_stage.sh` | `verify-cloud.sh --only deps,deps,ml`; no-op deps; fully skipped run; same-second artifact dir collision      |
| `s8_static_workflows_shellcheck.sh`  | shellcheck over the scope, workflow YAML hygiene, `apple-paths-changed.sh` decisions                          |

Run one: `tools/attack-ci-workflows-scripts-3/s5_security_scan_shallow_clone.sh`
(S2 needs the docker-compose Postgres on :5432; S2/S3 start `@pickle/api` on
alternate ports 3101/3102; S5 downloads the pinned gitleaks once).
Shared pieces: `lib.sh` (record/verdict), `pgctl.mjs` (local-only DB
create/drop), `shims/git` + `shims/gh` (log instead of push/dispatch).
