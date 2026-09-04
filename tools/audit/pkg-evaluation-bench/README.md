# pkg-evaluation-bench execution-audit harness

Read-only probes for the Linux regression bench in `packages/evaluation`
(runner, comparator, tolerance config, committed baseline). Nothing here is
wired into CI; the scripts write only under `$AUDIT_OUT` (default
`/tmp/pickle-audit-bench`) and leave `git status --porcelain` empty.

Prerequisites: `pnpm install --frozen-lockfile` at the repo root and one full
candidate run:

```sh
export AUDIT_OUT=/tmp/pickle-audit-bench
pnpm -s --filter @pickle/evaluation bench:regression --out-dir "$AUDIT_OUT/cand" --run-id cand
pnpm -s --filter @pickle/evaluation bench:regression --out-dir "$AUDIT_OUT/cand" --run-id cand2
```

| script                  | what it exercises                                                                                                                                                                                                                                                               | output                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `edge-cases.sh`         | 80 CLI cases: usage errors, run-id and out-dir validation, overwrite refusal, malformed and mutated summaries (26 mutations), tolerance-config variants, partial runs, the `pnpm` wrapper (`-s`, exit-code forwarding). Expected exit code per case is in the trailing comment. | `$AUDIT_OUT/edge-results.txt`, one log per case in `edge/` |
| `concurrency.sh`        | two simultaneous partial runs of the subprocess benches, then a follow-up run to show the stray files flip `gitDirty`; cleans up the strays it caused                                                                                                                           | `$AUDIT_OUT/conc/exits.txt`, `par-a.log`, `par-b.log`      |
| `coherence.py <c> [c2]` | baseline (9 ok benches, no nulls) vs tolerance keys vs candidate keys, provenance equality, determinism of two candidates modulo timing                                                                                                                                         | stdout, exit 1 on any mismatch                             |

Run against `4d812e1aa699014cc0521fd92fde66908043aaa8` (2026-09-04, Node
v22.12.0, pnpm 9.15.1 and 10.15.1): every expected exit code held; the
concurrency probe reproduces `expected exactly one new file … found 2` in both
runs with four untracked files left under `datasets/`.
