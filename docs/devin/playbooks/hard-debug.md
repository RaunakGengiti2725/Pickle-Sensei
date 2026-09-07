Playbook: Pickle Sensei — Hard Debug (!hard_debug — macro; referred to as !hard-debug in docs)

## Overview

For defects that resisted a normal !bug attempt (flaky, cross-plane, or unexplained): run 2–3 INDEPENDENT diagnoses in parallel with no shared hypothesis, compare their evidence, fix the cause the evidence supports, then have an adversarial tester try to break the fix.

## What's Needed From User

- Everything from !bug (symptom, surface, logs/request ids/crash reports) plus what has already been tried and ruled out.

## Procedure

1. Freeze the facts: write `debug-brief.md` (symptom, exact reproduction attempts + outputs, surfaces involved, commit range). No hypotheses in it.
2. Build the missing observability FIRST if the symptom cannot be observed: add a structured log line/error code, a diagnostic probe under `tools/diagnostics/`, or a fixture — following `docs/devin/DIAGNOSTICS.md` privacy rules (no user ids, IPs, bodies, tokens).
3. Spawn 2–3 Managed Devins with the identical brief and disjoint mandates (e.g. A: data/DB/RLS path; B: edge fn/auth/network path; C: mobile/native/state path — route the native one to the M4 runner via `scripts/mac-full-verify.sh --remote`). Each must return: root-cause claim, the executable evidence (command + output), confidence, and what would falsify it. They must not edit shared files.
4. Compare: reject any diagnosis that has no executable evidence or contradicts another's evidence; rerun the decisive experiment yourself.
5. Write the regression test from the winning diagnosis (fails before the fix), then implement the fix minimally.
6. Spawn an ADVERSARIAL TESTER with the fix branch and the brief: its goal is to make the bug (or a sibling) reappear — race conditions, cancellation, background/foreground, network failure, malformed input, RLS denied paths. It reports concrete failing cases or "no break found after N attempts" with the list of attempts.
7. Address every adversarial finding with a test, then run the pre-pr-verification Skill (`--tier full` when in doubt) and Mac verification if any Apple path was involved.
8. Open the PR with the brief, the competing diagnoses and why each was accepted/rejected, the regression test, adversarial results, and verification artifacts.

## Specifications

- Root cause demonstrated by an experiment that fails before and passes after.
- At least one adversarial pass with a written attempt list.
- Any new diagnostic tooling is committed and documented in `docs/devin/DIAGNOSTICS.md`.

## Delegation

Always (this playbook is the delegation pattern). Give children explicit acceptance criteria and "do not edit" file lists. Use Ultra/Dynamic Workflows (`.devin/skills/ultra-coordinator/workflow.py`) when there are ≥3 diagnoses plus an adversarial stage.

## Ask the User When

- Reproduction needs production logs (Supabase Dashboard), a physical device, or a credential: ask for the exact artifact.

## Forbidden Actions

- Merging a fix that passes only because a test was weakened or a code path was mocked.
- Declaring "flaky" without evidence of the nondeterminism source.
- Sharing one child's hypothesis with another before comparison.

## Stop Conditions

- Stop when the adversarial tester cannot break the fix and CI is green.
- BLOCKED when every diagnosis needs an artifact only the user can provide.
