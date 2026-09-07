# datasets/reports/regression

Machine-readable Linux regression summaries written by
`pnpm --filter @pickle/evaluation bench:regression` (schema:
`packages/evaluation/regression.summary.schema.json`; semantics:
`docs/EVALUATION.md` §1). One file per invocation, named `<runId>.json`.

## baseline.json

`baseline.json` is the accepted reference that `bench:compare` is run against.
It is a verbatim runner output — never edited by hand.

### Current document (regenerated with the EVAL-BENCH-01 runner fix)

Regenerated because the fix changed the descriptive text of two benches
(`benches[].command` and `benches[].inputs` for `event_recall` and
`completion_bench`: their reports now go to an explicit `<scratch>` path
instead of a timestamped file under `datasets/**`). No metric moved:
`bench:compare <previous baseline> <this document>` reported
`unchanged=104 informational=96`, 0 improvements, 0 regressions, exit 0, and
all 200 metric values plus every `benches[].metrics` / `labels` map are
byte-identical to the previous document.

- Measured code: `devin/fix-EVAL-BENCH-01-bench-runner` at
  `dfc05f6486bf0ad0ad7547eacafaee33dad97e99` (`provenance.gitDirty: false`,
  `provenance.gitBranch: "devin/fix-EVAL-BENCH-01-bench-runner"`), fresh
  `pnpm install --frozen-lockfile`. Benches still measure the same
  `packages/swing-lab`, `packages/vision-geometry` and `datasets/**` inputs
  as the previous baseline (`provenance.datasetsTreeSha` unchanged).
- Exact command (cwd = repo root, clean tree):

  ```sh
  pnpm -s --filter @pickle/evaluation bench:regression --out-dir /tmp/acc-baseline --run-id baseline
  cp /tmp/acc-baseline/baseline.json datasets/reports/regression/baseline.json
  ```

  Exit code 0. Runner-reported `totalWallClockMs: 1876`. Per-bench wall
  clocks (ms): stroke_heuristic 61, contact_replay 46, event_bounds_e13 12,
  event_recall 236, completion_bench 227, ownership_dual_frame 65,
  ball_hard_slice 981, phase_gold_d3_05 220, coach_gates 0. All nine
  `status: "ok"`; 200 metric keys.
- Environment: Ubuntu 22.04, Node v22.12.0 (`runner.node`), pnpm 9.15.1.
  The repository declares `"node": ">=20 <21"`; comparing against a summary
  produced on another Node version prints the `runner.node` CONFOUND warning
  (informational; the metrics are a pure replay of committed artifacts).

### Previous document (superseded, kept for the record)

- Measured code: `origin/main` at `7c034aa00ea3c4ff0e63c3b84b548cec8d62c96f`
  ("Create mac-smoke-test.yml"), checked out as a detached `git worktree` with
  `git status --porcelain` empty (`provenance.gitDirty: false`,
  `provenance.gitBranch: null`). Dependencies installed in that worktree with
  `pnpm install --frozen-lockfile --offline` against the `origin/main` lockfile.
- Runner code: `packages/evaluation/src/regression/*.ts` from the PR that added
  this directory, copied into the worktree as untracked files (the runner did
  not exist on `origin/main`; untracked files outside `datasets/` do not
  affect `gitDirty` — an untracked file under `datasets/` outside
  `datasets/reports/` does, because bench loaders enumerate those
  directories). The
  runner only orchestrates; every metric comes from `origin/main`'s
  `packages/swing-lab`, `packages/vision-geometry` and `datasets/**`.
- Exact command (cwd = worktree root):

  ```sh
  packages/swing-lab/node_modules/.bin/tsx packages/evaluation/src/regression/cli.ts run \
    --out-dir <repo>/datasets/reports/regression --run-id baseline
  ```

  Exit code 0. Runner-reported `totalWallClockMs: 1157` (last regenerated
  with the runner that records `benches[].cwd` relative to the repository
  root; metrics and provenance were byte-identical to the previous document).
  `git status --porcelain` in the worktree was identical before and after
  the run.
- Per-bench wall clocks (ms): stroke_heuristic 61, contact_replay 44,
  event_bounds_e13 11, event_recall 234, completion_bench 208,
  ownership_dual_frame 72, ball_hard_slice 501, phase_gold_d3_05 228,
  coach_gates 0. All nine `status: "ok"`; 200 metric keys.
- `provenance.datasetsTreeSha` hashes the `datasets/` listing at HEAD
  **excluding `datasets/reports/`**, so committing this baseline (or any
  later summary) does not itself trip the `datasetsTreeSha` CONFOUND
  warning in `bench:compare`; only a change to bench inputs does.
- Environment: Ubuntu 22.04, Node v22.23.2 (`runner.node`), pnpm 10.15.1.
  The repository declares `"node": ">=20 <21"`; the baseline was produced on
  Node 22 and pnpm printed the unsupported-engine warning. Re-running on
  Node 20 is expected to produce identical metrics (pure replay of committed
  artifacts) but has not been verified.
- Determinism check: the same runner executed from the PR branch
  (`--out-dir /tmp/regression-candidate --run-id candidate-check`) produced
  identical values for all 200 metrics; `bench:compare` reported
  `unchanged=104 informational=96`, 0 regressions, exit 0.

### Limitations carried by every summary (`caveats` field)

- `evidenceClass: "linux_replay_proxy"`: benches replay committed artifacts
  (Apple Vision pose captured earlier on macOS, oracle ball tracks, no paddle
  track). These are proxies for the on-device pipeline, not Mac/device results.
- Gold counts are single-digit to low tens per bench; treat every delta as a
  per-case finding, not a rate estimate.
- `null` metric values mean "not measurable in this run", never zero.
  Abstentions are counted separately from misses.

### Regenerating

Only regenerate from a clean checkout of the commit being accepted as the new
reference, and commit the new document alongside the change that intentionally
moved a metric (or, as with the EVAL-BENCH-01 fix, changed a bench's
`command` / `inputs` text — say so here and prove with `bench:compare` that no
metric moved). Write the summary outside the repository and copy it in, so the
tree the runner sees is clean (deleting the old baseline first would itself
mark the tree dirty):

```sh
git status --porcelain --untracked-files=no   # must be empty
git ls-files --others --exclude-standard datasets | grep -v '^datasets/reports/'  # must be empty
pnpm -s --filter @pickle/evaluation bench:regression --out-dir /tmp/baseline --run-id baseline
pnpm -s --filter @pickle/evaluation bench:compare datasets/reports/regression/baseline.json /tmp/baseline/baseline.json
cp /tmp/baseline/baseline.json datasets/reports/regression/baseline.json
```
