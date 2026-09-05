Playbook: Pickle Sensei — Bug (!bug)

## Overview

Fix a defect in RaunakGengiti2725/Pickle-Sensei by reproducing it first, proving the root cause, pinning it with a regression test, then fixing and re-verifying on the correct plane. A fix without a failing-then-passing test is not done.

## What's Needed From User

- Symptom, where it was observed (iPhone app, admin web, local API, edge fn, bench), and any request id / log line / screenshot / crash report.
- App build/commit if known. If it is an iOS runtime symptom, note that only the M4 runner can reproduce it.

## Procedure

1. Classify the surface using `docs/devin/DIAGNOSTICS.md` §0 (production edge fn vs legacy local API vs mobile vs design-only SQL views) — mixing these up is the main way to diagnose the wrong thing.
2. Reproduce deterministically: unit/contract test, `tools/diagnostics/edge_error_taxonomy.ts`, `tools/diagnostics/local_api_probe.mjs`, the Playwright smoke, a bench, or — for Apple runtime — `scripts/mac-full-verify.sh --remote` with a targeted XCTest. Record the exact failing command and output.
3. Follow the evidence to the root cause (correlate `x-request-id`, access-log line, error code; `git log -S` for the introducing change). Write the root cause in one sentence with the file:line.
4. Write a regression test that FAILS on current code and encodes the desired behaviour (mobile `__tests__`, edge `__wf__`, package `test/`, RLS matrix `supabase/tests`, or bench fixture — never a fabricated label).
5. Fix the cause (not the symptom). Keep the diff minimal; do not refactor around it.
6. Run the regression test, then the pre-pr-verification Skill (`scripts/verify-cloud.sh --tier pr`); if the bug is Apple-side, run the macos-verification Skill and cite the `.xcresult`/launch artifacts.
7. If the fix touches analysis/CV, run `bench:regression` + `bench:compare` against the committed baseline and report the delta.
8. Open the PR: symptom, reproduction command, root cause, regression test name, fix, verification results. Link the request id / log evidence if any.
9. Watch CI and Devin Review; fix root causes only.

## Specifications

- Regression test exists, fails before / passes after (show both runs).
- Root cause stated with evidence; no "probably".
- CI green; Mac evidence attached when the bug is Apple-side.

## Delegation

For a bug that resists reproduction after two honest attempts, switch to !hard-debug (parallel independent diagnoses).

## Ask the User When

- The bug is only observable in production (Supabase Dashboard logs / device) and cannot be reproduced locally — ask for the specific log lines / request ids rather than guessing.
- The correct behaviour is ambiguous or contradicts `AGENTS.md`.

## Forbidden Actions

- Fixing by deleting/`skip`ping tests, widening try/catch, swallowing errors, weakening RLS/grants, hardcoding outputs, or editing applied migrations.
- Declaring the bug fixed without executing the reproduction after the fix.

## Stop Conditions

- BLOCKED if reproduction needs production access or a device you do not have; report exactly what evidence is needed.
