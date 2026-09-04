# Adversarial pass 3 — `pkg-evaluation-bench` (Linux bench plane)

Executable attack scripts against the regression runner / comparator /
tolerances at commit `4d812e1aa699014cc0521fd92fde66908043aaa8`. They are
NOT vitest specs (no `.test.ts` suffix) because most of them run the full
nine-bench regression, spawn pnpm, or deliberately race two runners.

Run one from the repo root (needs `pnpm install --frozen-lockfile` first):

```sh
packages/evaluation/node_modules/.bin/tsx packages/evaluation/test/attack-pass3/<script>.ts
```

Each script prints `HELD`/`BROKEN` per check with observed/expected, writes
`/tmp/attack-pass3/<scenario>.json` (override with `ATTACK_OUT_DIR`) and exits
0 only if every check held. Scripts never modify tracked files; the ones that
plant files under `datasets/` remove exactly what they planted and assert
`git status --short` is unchanged afterwards.

| script                               | attack                                                                                 | result @4d812e1a                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `s1_preexisting_wave_e_file.ts`      | pre-existing `event-recall-<future>.json` (and `-0.json`) in wave-e                    | HELD 8/8                                                                       |
| `s2_measurement_lost.ts`             | guarded/informational metric numeric→null, flattened-only null, all-guarded null       | HELD 9/9                                                                       |
| `s3_tolerances_omitted_key.ts`       | tolerance copy omitting keys, policy `informational`, empty rationale                  | HELD 9/9                                                                       |
| `s4_missing_swing_lab_tsx.ts`        | scratch worktree without `packages/swing-lab/node_modules/.bin/tsx`                    | HELD 11/11                                                                     |
| `s5_jq_roundtrip.ts`                 | `jq .`/`-S`/`-c`, reversed keys, `1.0`/exponent respelling, negative controls          | HELD 15/15                                                                     |
| `s6_pnpm_banner_stdout.ts`           | `--json` without `-s` under pnpm 9.15.1 / 10.15.1 / Node 20                            | HELD 12/12 (banner reproduced both)                                            |
| `s7_concurrent_vitest_and_runner.ts` | vitest ∥ runner (3 rounds); two runners ∥ on one checkout (8 seeded rounds)            | vitest∥runner HELD; runner∥runner BROKEN (6/8 rounds both fail + leak outputs) |
| `s8_extra_adversarial.ts`            | run-id fuzz, corrupt/huge input, tolerance float boundary, EACCES, SIGTERM, clock skew | 30/34 — see findings                                                           |

Findings are reported in the coordinator's structured output (not fixed here;
this branch adds test files only).
