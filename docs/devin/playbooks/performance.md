Playbook: Pickle Sensei — Performance (!performance)

## Overview

Improve latency, throughput, memory, or CV accuracy in RaunakGengiti2725/Pickle-Sensei with evidence: baseline → profile → competing solutions → identical benchmark → select the winner. Nothing is "faster" or "smarter" until the same benchmark says so.

## What's Needed From User

- The target (edge fn route, sync path, analysis stage, classifier, mobile render path) and the metric that matters (p50/p95 ms, MB, accuracy/recall on which bench).
- The plane where truth lives: Linux (edge fn, packages, benches) or Apple (Vision/CoreML/AVFoundation/UI — only the M4 runner counts).

## Procedure

1. Establish the baseline on a clean commit: analysis → `pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/perf-baseline` (200 metrics incl. per-bench `durationMs`); edge fn → `tools/loadtest/` k6 script or a Deno micro-benchmark under `__wf__`; Apple → `scripts/mac-full-verify.sh --remote` and the native/swing-lab Vision extraction timings in its summary. Record machine, commit, and command.
2. Profile before changing anything (Node `--cpu-prof`, Deno `--inspect`, Instruments/`xctrace` on the M4 runner, or per-stage timing already in bench summaries). Name the hotspot with numbers.
3. Design ≥2 independent approaches. For hard problems spawn one Managed Devin per approach with the identical brief, identical benchmark command, and a "do not touch other approaches' files" rule; each returns branch + numbers + how to reproduce.
4. Run the identical benchmark on every candidate yourself (`bench:compare <baseline> <candidate> --json` for analysis; same k6/xctrace invocation otherwise). Reject candidates you cannot reproduce.
5. Pick the winner by the declared metric AND no regressions elsewhere (bench compare exit 0 with no new regressions; memory not worse; tests green). Ties go to the simpler diff.
6. If model/estimator behaviour changed, bump its version constant in packages/swing-lab and note it in the PR; if the accepted baseline should move, regenerate it per `datasets/reports/regression/README.md` in a separate commit with the compare output.
7. Run the pre-pr-verification Skill (`scripts/verify-cloud.sh --tier pr`, `--tier full` if load/e2e relevant) and Mac verification for Apple-side changes.
8. Open the PR with before/after tables, exact commands, machine info, the losing approaches and why, and the compare JSON.

## Specifications

- Baseline and candidate measured with the same command on the same class of machine; numbers in the PR.
- No fabricated labels or synthetic "gold"; accuracy claims only from committed gold via `bench:compare`.
- Deliverables: PR, benchmark outputs (attach or paste), optional baseline regeneration commit.

## Delegation

Competing Managed Devins for each approach; an independent reviewer that re-runs the winner's benchmark before merge.

## Ask the User When

- The trade-off is accuracy vs latency (product call), or the change needs a new model artifact / provider.

## Forbidden Actions

- Comparing numbers from different machines or commands; cherry-picking runs; changing tolerances in `regression.tolerances.json` to make a candidate pass; deleting slow tests.

## Stop Conditions

- Stop when the winner is merged with reproducible numbers, or report that no approach beat the baseline (that is a valid outcome).
