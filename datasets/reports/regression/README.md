# datasets/reports/regression

Machine-readable Linux regression summaries written by
`pnpm --filter @pickle/evaluation bench:regression` (schema:
`packages/evaluation/regression.summary.schema.json`; semantics:
`docs/EVALUATION.md` §1). One file per invocation, named `<runId>.json`.

## baseline.json

`baseline.json` is the accepted reference that `bench:compare` is run against.
It is a verbatim runner output — never edited by hand. Provenance of the
committed document:

- Measured code: `origin/main` at `7c034aa00ea3c4ff0e63c3b84b548cec8d62c96f`
  ("Create mac-smoke-test.yml"), checked out as a detached `git worktree` with
  `git status --porcelain` empty (`provenance.gitDirty: false`,
  `provenance.gitBranch: null`). Dependencies installed in that worktree with
  `pnpm install --frozen-lockfile --offline` against the `origin/main` lockfile.
- Runner code: `packages/evaluation/src/regression/*.ts` from the PR that added
  this directory, copied into the worktree as untracked files (the runner did
  not exist on `origin/main`; untracked files do not affect `gitDirty`). The
  runner only orchestrates; every metric comes from `origin/main`'s
  `packages/swing-lab`, `packages/vision-geometry` and `datasets/**`.
- Exact command (cwd = worktree root):

  ```sh
  packages/swing-lab/node_modules/.bin/tsx packages/evaluation/src/regression/cli.ts run \
    --out-dir <repo>/datasets/reports/regression --run-id baseline
  ```

  Exit code 0. Runner-reported `totalWallClockMs: 1382`. `git status
  --porcelain` in the worktree was identical before and after the run.
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
moved a metric:

```sh
git status --porcelain --untracked-files=no   # must be empty
rm datasets/reports/regression/baseline.json  # the runner refuses to overwrite
pnpm --filter @pickle/evaluation bench:regression --run-id baseline
```
