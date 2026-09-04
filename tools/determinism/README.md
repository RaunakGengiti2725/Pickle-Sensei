# Determinism harness

Replayable checks for "does the verifier / test suite give the same answer twice?".
Nothing here modifies tests or product code; every script only runs existing
suites with a recorded seed and writes machine-readable results.

| Script                     | What it runs                                                                                                              | Output                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `clean-state.sh`           | Resets docker volumes, jest/vite/tsc caches, playwright output (`--fresh-mobile` also drops `apps/mobile/node_modules`)   | —                                                                   |
| `verify-cloud-twice.sh`    | `clean-state.sh` + `scripts/verify-cloud.sh --tier <t> --start-services --fresh-deps`, N times                            | `run-<i>/summary.json`, `console.log`, `exit-code.txt`, `diff.json` |
| `diff-summaries.mjs`       | Stage-by-stage status + timing diff of two or more `summary.json`                                                         | JSON (`--table` for humans); exit 1 if any stage status differs     |
| `jest-randomize-matrix.sh` | `apps/mobile`: `npx jest --ci --silent --randomize --seed=<s> --json` per seed                                            | `jest-seed-<s>.{json,log,exit}`, `matrix.json`                      |
| `deno-shuffle-matrix.sh`   | `supabase/functions/api/__wf__`: `deno test -A --no-check --config deno.json --shuffle=<s> --junit-path=…` per seed       | `deno-seed-<s>.{xml,log,exit}`, `matrix.json`                       |
| `vitest-shuffle-matrix.sh` | Every workspace package: `vitest run --sequence.shuffle.files [--sequence.shuffle.tests] --sequence.seed=<s>` per seed    | `seed-<s>/<package>.json`, `seed-<s>.{log,exit}`, `matrix.json`     |
| `matrix-report.mjs`        | Joins per-seed results (jest JSON / JUnit XML / vitest JSON dirs) into one matrix; lists every test whose outcome differs | JSON (`--table` for humans); exit 1 if any test is unstable         |

Replay a single unstable test with the exact seed printed in `matrix.json`:

```bash
# mobile
(cd apps/mobile && CI=true npx jest --ci --randomize --seed=<s> <path/to/test>)
# edge fn
(cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json --shuffle=<s> .)
# workspace package
pnpm --filter <pkg> exec vitest run --sequence.shuffle.files --sequence.shuffle.tests --sequence.seed=<s>
```

`--files-only` on the vitest matrix shuffles only the file order; comparing it with the
default (files + tests) run separates cross-file coupling (shared DB rows, module-level
state) from intra-file "step N needs step N-1" coupling.

Requirements: Docker services (`docker compose up -d postgres postgres_test redis elasticmq`)
for the verify-cloud and vitest matrices, `apps/mobile/node_modules` (`npm ci`) for jest,
`deno` on PATH for the edge matrix. Default output root is `artifacts/determinism/`
(override with `PICKLE_DETERMINISM_OUT` or `--out`).
