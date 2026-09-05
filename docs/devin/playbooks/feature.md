Playbook: Pickle Sensei — Feature (!feature)

## Overview

Ship a feature in RaunakGengiti2725/Pickle-Sensei with executable evidence on the plane(s) it touches: discover → implement → verify → review → evidence. Facts come from the repo Knowledge notes, `AGENTS.md`, `REVIEW.md`, `docs/devin/OPERATING_SYSTEM.md`; procedures from the repo Skills in `.agents/skills/`.

## What's Needed From User

- The feature description and the user-visible acceptance criteria.
- Whether Apple-side behaviour (native/, apps/mobile/ios, Vision/CoreML/AVFoundation, simulator) is in scope — if unstated, decide from the files touched.
- Explicit go-ahead if the feature needs a Supabase migration/edge deploy, App Store config, or copy changes governed by `docs/APP_STORE_SUBMISSION.md`.

## Procedure

1. Read `AGENTS.md`, `REVIEW.md`, and the Knowledge notes for the areas touched; locate existing tests pinning current behaviour (`apps/mobile/__tests__`, `supabase/functions/api/__wf__`, `packages/*/test`).
2. Write the acceptance criteria as a checklist in the PR draft BEFORE coding; list which verification stages prove each one.
3. Implement on a `devin/<ts>-<slug>` branch following existing patterns (design tokens, edge fn contract, migrations as NEW files, `x-request-id`/generic 5xx invariants).
4. Add or update tests for every behaviour change; a behaviour change to an estimator/heuristic bumps its version constant.
5. Run the pre-pr-verification Skill: `scripts/verify-cloud.sh --tier pr` (and `--tier full` if the change crosses schema + edge fn + mobile); attach `artifacts/verify-cloud/<ts>/summary.json` facts to the PR.
6. If Apple paths changed, run the macos-verification Skill (`scripts/mac-full-verify.sh --remote`) and wait for the real M4 artifacts; never infer iOS behaviour on Linux.
7. If analysis/CV code changed, run `pnpm --filter @pickle/evaluation bench:regression` and `bench:compare datasets/reports/regression/baseline.json <candidate>` and report the delta (exit code + regressions/improvements).
8. Open the PR with: what changed and why, the acceptance checklist with the stage/test proving each item, exact commands run and results, and known gaps.
9. Read Devin Review findings on the PR; fix high-severity or cheap in-scope items, escalate anything that contradicts the user's instruction.
10. Watch CI (`verify`, `mobile`, `edge`, `supabase-security`, plus `Mac Full Verify` if triggered) until green; fix root causes, never weaken gates.

## Specifications

- PR exists, CI green, every acceptance item mapped to executable evidence (test name, stage, or artifact).
- No skipped/unavailable stage is reported as passed; Mac claims only from `artifacts/mac-full-verify/<run>/`.
- Evidence deliverables: PR description with commands + results; `summary.json` facts; bench compare output when analysis changed.

## Delegation

Spawn Managed Devins (non-overlapping file ownership, explicit acceptance criteria) only when the feature splits into independent parts, e.g. edge fn contract vs mobile client vs admin-web. For important or risky changes add an INDEPENDENT REVIEWER (reviews without trusting the implementation) and an ADVERSARIAL TESTER (tries to break it) — see `docs/devin/OPERATING_SYSTEM.md` §Ultra coordinator.

## Ask the User When

- The feature requires production mutation (migration push, edge deploy, secrets), App Store/RevenueCat config, or user-facing copy.
- Acceptance criteria conflict with `AGENTS.md`/Knowledge hard rules (iPhone-only, Apple/Google sign-in only, on-device pose, no accuracy claims).

## Forbidden Actions

- Editing applied migrations; adding `|| true`; disabling/deleting tests; mocking production behaviour to pass; committing secrets; pnpm inside `apps/mobile`; claiming Mac results from Linux; deploying or touching Supabase project ucqnaiwqwjtgvlduiuib.

## Stop Conditions

- Stop and report BLOCKED when a required gate cannot run (M4 runner offline, missing credential) instead of skipping it silently.
- Stop when CI is green and the PR evidence is complete; do not expand scope.
