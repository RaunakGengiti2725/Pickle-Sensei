Playbook: Pickle Sensei — Architecture Decision (!architecture)

## Overview

Analyse alternatives and trade-offs for a structural change in RaunakGengiti2725/Pickle-Sensei BEFORE any implementation, producing a decision record the user can accept or reject. Output is a document (and optionally a throwaway spike branch), not a product PR.

## What's Needed From User

- The problem or capability to be designed and the constraints that matter (latency, on-device vs server, privacy, cost, App Store rules, release timeline).
- Whether a time-boxed spike is allowed (default: yes, on a branch that is never merged).

## Procedure

1. Ground in the real system: read the relevant Knowledge notes, `AGENTS.md`, `REVIEW.md`, `docs/devin/OPERATING_SYSTEM.md`, `docs/devin/DIAGNOSTICS.md`, `docs/EVALUATION.md`, and the actual code paths involved (mobile stores, edge fn routes, migrations, native Vision modules). List the invariants the design MUST keep (durable sessions, on-device pose, generic 5xx, RLS matrix, model version bumps, iPhone-only portrait, Apple/Google sign-in only).
2. State the problem in measurable terms and the decision criteria (correctness, privacy, latency on device, verification cost on M4 vs Linux, migration risk, operability/diagnosability, effort in Devin sessions).
3. Enumerate ≥2 genuinely different alternatives including "do nothing / minimal". For each: how it works, what changes where (packages/files), data-contract and migration impact, failure modes, how it would be tested on each plane, how it would be measured (bench metric, telemetry event, XCTest).
4. Where uncertainty is material, run a time-boxed spike or a benchmark rather than arguing (e.g. a `bench:regression` candidate, a Deno contract test, a Swift micro-benchmark on the M4 runner). Record commands and numbers.
5. Optionally spawn 2 Managed Devins to argue competing alternatives independently against the same criteria; integrate, reject unevidenced claims.
6. Write `docs/decisions/<yyyymmdd>-<slug>.md` (create the folder if absent): context, criteria, alternatives with trade-offs, evidence, recommendation, rollout/rollback plan, verification plan (which stages/Skills prove it), open questions.
7. Present the recommendation and the one or two decisions only the user can make; do not begin implementation until the user chooses.

## Specifications

- Decision record committed on a branch/PR marked docs-only; spike branches clearly labelled and never merged.
- Every trade-off claim is either sourced to code/docs or measured; no speculative performance claims.
- Verification plan maps to existing gates (`scripts/verify-cloud.sh`, `scripts/mac-full-verify.sh`, bench compare).

## Delegation

Competing-alternative Managed Devins when the choice is expensive to reverse; a reviewer child to challenge the recommendation before it is presented.

## Ask the User When

- Criteria weights are business decisions (pricing, App Store policy, privacy posture, timeline).
- An alternative requires production infrastructure changes or new third-party services.

## Forbidden Actions

- Starting the implementation in this playbook; merging spike code; changing applied migrations; inventing requirements the architecture does not support.

## Stop Conditions

- Stop after the decision record and the user-facing decision list are delivered.
