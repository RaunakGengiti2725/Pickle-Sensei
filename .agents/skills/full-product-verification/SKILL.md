---
name: full-product-verification
description: Prove the whole Pickle Sensei product on both execution planes — every Linux gate (scripts/verify-cloud.sh --tier full) plus the real Apple run on the M4 runner (scripts/mac-full-verify.sh --remote) — via scripts/verify-all.sh. Use at the end of a multi-workstream session, before merging cross-cutting changes (schema + edge fn + mobile), for nightly QA, or whenever "everything still works" must be stated as fact.
---

# Full product verification

`scripts/verify-all.sh` = Linux gates, then Apple gates. Both must pass; the
Mac half is never silently skipped (only `--no-mac`, which prints that Apple
claims are unverified).

## Procedure

```bash
cd /home/ubuntu/repos/Pickle-Sensei
git status --short            # must be clean: the Mac builds the pushed commit
docker compose up -d postgres postgres-test
set -o pipefail
scripts/verify-all.sh 2>&1 | tee /tmp/verify-all.log; echo "exit=${PIPESTATUS[0]}"
```

Options: `--cloud-args "--tier pr"` for the CI subset, `--no-mac` when the
change provably touches no Apple path (state this explicitly in the PR).
`--mac-args` are honoured only when the script runs ON a Mac; the remote
path always runs the full default Mac set.

Duration: Linux ~10–20 min (rls/mobile dominate); Mac 30–90 min and it may
queue behind another run (single physical runner).

## Evidence to collect

- `artifacts/verify-cloud/<UTC>/summary.json` — `ok: true`, all stages
  `passed` (`deps format lint typecheck test db mobile ml edge rls security admin release`).
- `artifacts/mac-full-verify/<run-id>/mac-full-verify-*/summary.json` —
  `ok: true`; plus `swift-native-xcresult-summary.txt` (test counts),
  `swing-lab-extract-summary.txt` (poses detected > 0),
  `launch/launch-summary.txt` (app alive, no crash/fatal JS),
  `run.json` (GitHub run URL to link).
- `security` stage: `passed` requires `scripts/security-scan.sh`; if it
  reports `unavailable`, say so — it is not a pass.

Paste the two stage tables (or the run URLs) in the PR/report. Do not
summarise as "all green" without them.

## Interpreting mixed results

| Linux | Mac | Meaning |
|---|---|---|
| pass | pass | product verified on both planes for this commit |
| pass | fail in `swift-native` | perception/native regression or clip/tooling issue — read `vision-core-*.log`, `swing-lab-extract-summary.txt`; Linux tests cannot see this |
| pass | fail in `ios-app` | app build/pods/bundle/launch — `xcodebuild-build.log`, `pod-install.log`, `launch/` |
| fail | any | fix Linux first (`pre-pr-verification`), then re-run everything; a Mac pass on a Linux-failing commit is not a release candidate |
| pass | queued for hours | runner busy/offline — `gh run list --workflow mac-full-verify.yml`; if the runner shows offline in GitHub → tell the user (only they can wake the Mac) |

## Not covered (say so when it matters)

- Real Apple/Google sign-in, StoreKit purchases, push notifications, camera
  capture on a physical iPhone — human/device steps.
- Production Supabase state (dashboard settings, pg_cron, deployed edge fn
  version) — requires linked CLI/dashboard access.
- Load behaviour (`tools/loadtest/`, k6) — separate, non-deterministic.

## Forbidden

- `--no-mac` for a change under `native/`, `apps/mobile/ios/`, or mobile
  native deps.
- Re-running a failed stage in isolation and reporting the isolated pass as
  the product verdict — re-run the whole entry point.
- Treating `skipped`/`unavailable` as passed.
