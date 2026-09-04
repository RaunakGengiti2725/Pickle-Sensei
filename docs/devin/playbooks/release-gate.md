Playbook: Pickle Sensei — Release Gate (!release_gate — macro; referred to as !release-gate in docs)

## Overview

Full release-readiness verification of a RaunakGengiti2725/Pickle-Sensei release candidate on BOTH planes, producing a go/no-go note with artifacts — without performing any release action (no archive, upload, TestFlight, App Store submission, `supabase db push`, or `functions deploy`). The procedure lives in the repo Skill `release-verification`; this playbook fixes the objective, evidence, and stop rules.

## What's Needed From User

- The release-candidate branch/commit and intended `CFBundleShortVersionString` / `CFBundleVersion`.
- The last shipped tag/commit (for the user-facing copy diff) if not discoverable from git tags / `infra/release/release-manifest.json`.

## Procedure

1. Confirm the RC commit is pushed and matches the PR/branch under review; record `git rev-parse HEAD`.
2. Invoke the `release-verification` Skill and run Linux in full: `scripts/verify-cloud.sh --tier full` (adds `security`, `admin`, `e2e`, `release` to the PR tier). Keep `artifacts/verify-cloud/<ts>/summary.json`.
3. Run the real Apple gate via the `macos-verification` Skill: `scripts/mac-full-verify.sh --remote`; require `summary.json` `ok: true`, `.xcresult` for macOS + iOS Simulator XCTest, Vision extraction summary, unsigned Release app build with `main.jsbundle`, launch/crash summary clean, and `PickleSensei-Info.plist` showing the intended version/build.
4. Run the analysis regression check: `pnpm --filter @pickle/evaluation bench:regression` then `bench:compare datasets/reports/regression/baseline.json <candidate>`; exit must be 0 with confounds explained.
5. Check version consistency (pbxproj MARKETING_VERSION / CURRENT_PROJECT_VERSION, `apps/mobile/package.json`, `infra/release/release-manifest.json`, `docs/APP_STORE_SUBMISSION.md`) and run `node tools/release/check-release-manifest.mjs`.
6. Walk `docs/PRELAUNCH_CHECKLIST.md` §1–8; mark each item `verified (command/artifact)`, `human-only`, or `BLOCKED`. Never tick an item you did not execute or observe.
7. Scan user-facing copy changed since the last release for the hard rules (no Android / Google Play / guest mode / Live Court / DUPR / competitor names / accuracy percentages / superlatives); inspect each hit.
8. Re-read `REVIEW.md` release-boundary rules and `docs/devin/SECURITY_BOUNDARIES.md` §remaining unknowns; list the production settings that cannot be verified from the repo (Dashboard config, pg_cron, secrets set) as human-only.
9. Write `docs/RELEASE_READINESS_<date>.md` following the existing one: verdict GO / NO-GO, per-gate results with artifact paths and commit SHAs, human-only items, blockers. Open a docs-only PR with it.

## Specifications

- Verdict is GO only if: Linux full tier all passed (no skipped stage counted as pass), Mac `ok: true` with artifacts, bench compare exit 0, versions consistent, no forbidden copy, security scan clean.
- Deliverables: readiness note PR, `summary.json` (Linux), `artifacts/mac-full-verify/<run>/` contents referenced by run URL, bench compare output.
- Every human-only step is named with the exact action and the document that authorises it.

## Delegation

An independent reviewer may re-run steps 2–4 from a fresh session and must reach the same verdict before GO is reported; disagreement = NO-GO until resolved.

## Ask the User When

- The verdict is GO: the release actions themselves (archive/upload/submit/deploy) require the user's explicit go-ahead per `docs/APP_STORE_SUBMISSION.md` and `docs/RELEASE_OPERATIONS.md`.
- Version numbers or store copy need a decision.

## Forbidden Actions

- Any release/deploy/submission action; editing tolerances or skipping stages to reach GO; claiming Mac results without the workflow artifacts; enabling Family Sharing / Made for Kids / external TestFlight / App Store submission.

## Stop Conditions

- Stop at the readiness note; hand the release actions to the user.
- BLOCKED if the M4 runner is offline (Apple evidence is mandatory for GO).
