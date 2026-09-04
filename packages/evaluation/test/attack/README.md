# Adversarial tests — regression runner / comparator (pass 3, 2026-09-04)

Executable attacks against `packages/evaluation` at commit `4d812e1a`. They
run with the package suite (`pnpm --filter @pickle/evaluation test`) and
need the real checkout: the runner tests spawn `tsx src/regression/cli.ts`
and temporarily create files under `datasets/` that they always remove.

Convention: `it(...)` pins behaviour that HELD; `it.fails(...)` pins the
behaviour the tool SHOULD have and documents a reproduced gap — it turns red
(and must be flipped to `it`) the moment the gap is fixed.

| Scenario                                                                   | File                              | Result                                                     |
| -------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| S1 concurrent runs → strays → `gitDirty` + `CONFOUND provenance.gitDirty`  | `regressionAttackRunner.test.ts`  | HELD (race reproduced; runner leaves both files behind)    |
| S2 Node 20 vs Node 22 candidate, 200 metrics                               | `scripts/node-major-compare.sh`   | HELD — 0/200 moved, only `CONFOUND runner.node`            |
| S3 untracked `datasets/gold/` flips `gitDirty`, tree sha stable            | `regressionAttackRunner.test.ts`  | HELD                                                       |
| S4 nested vs flattened metric disagreement                                 | `regressionAttackCompare.test.ts` | HELD — exit 2, `summary.metrics must equal the flattened…` |
| S5 `evidenceClass != linux_replay_proxy`                                   | `regressionAttackCompare.test.ts` | HELD — exit 2 on either side                               |
| S6 10 MB label string                                                      | `regressionAttackCompare.test.ts` | accepted, ~250 ms; 100 MB also accepted (unbounded)        |
| S7 `status: ok` + `exitCode: 137`                                          | `regressionAttackCompare.test.ts` | BROKEN — accepted by validator, runner, comparator         |
| extra: same `--run-id` concurrent runs both succeed (TOCTOU)               | `regressionAttackRunner.test.ts`  | BROKEN                                                     |
| extra: SIGTERM mid-bench orphans a report in `datasets/`                   | `regressionAttackRunner.test.ts`  | BROKEN                                                     |
| extra: label / command / cwd / inputs drift invisible to compare           | `regressionAttackCompare.test.ts` | gap (documented)                                           |
| extra: dirty caveat says "uncommitted tracked changes" for untracked input | `regressionAttackRunner.test.ts`  | gap (wording)                                              |

```sh
pnpm --filter @pickle/evaluation test -- test/attack
test/attack/scripts/node-major-compare.sh "$(nvm which 20)" /tmp/attack/s2n20 cand20
```
