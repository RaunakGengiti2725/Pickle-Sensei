# Evaluation — how we answer "did this change make Pickle Sensei smarter?"

This document maps the evaluation system that already exists in the repository
and describes the one canonical regression path built on top of it
(`packages/evaluation` → `bench:regression` / `bench:compare`). Nothing here is
a claim about product quality: every number this system produces is a
per-case count over a tiny public-source corpus, replayed on Linux from
committed artifacts. Abstentions are outcomes, not errors, and `null` means
"not measurable in this run", never zero.

Evidence labels used below:

- **VERIFIED** — executed in this repository on Ubuntu 22.04 (Node v22.23.2,
  pnpm 10.15.1) on 2026-09-04 with the exact command shown. Note: `package.json`
  `engines` declares Node `>=20 <21`; the machine ran Node 22. Everything
  passed under Node 22, but CI runs Node 20 — treat that as a known discrepancy.
- **INFERRED** — read from code / manifests, not executed.
- **UNKNOWN** — could not be established from the repository.

---

## 1. Canonical regression path (owned by `packages/evaluation`)

```
pnpm --filter @pickle/evaluation bench:regression            # writes datasets/reports/regression/<timestamp>.json
pnpm --filter @pickle/evaluation bench:compare <baseline.json> <candidate.json> [--tolerances <path>] [--json]
pnpm --filter @pickle/evaluation test                        # vitest: schema, tolerances, compare, runner
```

Typical loop:

```
git checkout origin/main && pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/base
git checkout my-branch  && pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/cand
pnpm --filter @pickle/evaluation bench:compare /tmp/base/<ts>.json /tmp/cand/<ts>.json
```

The committed reference is `datasets/reports/regression/baseline.json`
(produced from a clean `origin/main` worktree — see §1.5 and
`datasets/reports/regression/README.md`). Relative paths given to
`bench:compare` / `--out-dir` resolve against the directory `pnpm` was invoked
from (pnpm's `INIT_CWD`), so repo-relative paths work. Do not put `--`
between the script name and its flags (pnpm 10 forwards it literally and the
CLI rejects it), and use `pnpm -s` when redirecting `--json` output so pnpm's
banner stays out of the file. `--run-id` must be a single filename component
(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`).

### 1.1 What `bench:regression` runs

Only benches that are **deterministic and Linux-runnable today**, using
artifacts already committed under `datasets/`. Nine benches, in this order
(wall clocks are VERIFIED from the run that produced `baseline.json`; see the
`benches[].wallClockMs` field there for the authoritative numbers):

| bench id               | kind       | existing entry point it wraps                                         | what it measures                                                                                | approx. wall clock |
| ---------------------- | ---------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------ |
| `stroke_heuristic`     | in-process | `runStrokeHeuristicBench()` (`swing-lab/src/strokeHeuristicBench.ts`) | stroke classification L1 (overhead/swing) and L2 (family) — correct / wrong / abstained         | ~60 ms             |
| `contact_replay`       | in-process | `replayAll()` (`vision-geometry/eval/contactGoldReplay.ts`)           | contact estimation: coverage, abstention, strict/acceptable hits, median/p75/p90 error          | ~45 ms             |
| `event_bounds_e13`     | in-process | `runE13EventBoundsEval()` (`swing-lab/src/e13EventBoundsEval.ts`)     | stroke segmentation on 3 bundles: proposed_ok / mis-bounded / missed, start/end error           | ~10 ms             |
| `event_recall`         | subprocess | `tsx src/eventRecallBench.ts`                                         | stroke segmentation recall over DEV gold target events, contact-inside rate, false-in-non-event | ~180 ms            |
| `completion_bench`     | subprocess | `tsx src/eventCompletionBench.ts`                                     | analysis completion: fixed 1.5 s post-roll vs adaptive settle against gold event ends           | ~170 ms            |
| `ownership_dual_frame` | in-process | `runBench(false, false)` (`swing-lab/src/ownershipBench.ts`)          | paddle ownership (target vs other) per method, accuracy / accuracy-when-answering / coverage    | ~65 ms             |
| `ball_hard_slice`      | subprocess | `tsx src/ballHardSliceEval.ts <scratch>.json`                         | ball tracking under occlusion slices: hits / misses / wrong-location / abstained / violations   | ~450 ms            |
| `phase_gold_d3_05`     | subprocess | `tsx ../../datasets/experiments/wave-d3/d3-05-measure-gold.ts`        | phase segmentation: segmented vs abstained, anchored and anchor-free                            | ~165 ms            |
| `coach_gates`          | in-process | `runCoachGates()` (`swing-lab/src/coachGates.ts`)                     | coaching consistency: frozen release-gate spec PASS / FAIL / NOT_EVALUABLE counts               | <1 ms              |

Whole run including provenance collection: 1385 ms in the baseline run, 1187 ms
in the PR-branch determinism check (VERIFIED, `totalWallClockMs`).
All nine are cheap enough for every CI run; none needs nightly scheduling.

Design constraints the runner enforces (`src/regression/run.ts`, `benches.ts`):

- **One output per invocation.** Several wrapped scripts write timestamped
  files into `datasets/**` themselves (e.g. `event-recall-<ts>.json`,
  `completion-<ts>.json`). The runner snapshots the directory, consumes exactly
  the one new file, and deletes it, or redirects the script's `--out` to a
  scratch directory that is removed afterwards. The working tree is left as it
  was found (VERIFIED: `git status --short` unchanged after a full run).
- **No fabricated metrics.** A bench that throws, or a subprocess that exits
  non-zero, becomes `status: "failed"` with the error text and an empty metric
  map; the summary is still written and the process exits 1.
- **Abstention-preserving.** Metrics are copied from the benches as reported;
  ratios with a zero denominator are `null`.
- **Schema-validated before writing.** `validateRegressionSummary` (mirrored
  by the committed JSON Schema `packages/evaluation/regression.summary.schema.json`)
  must accept the document or the run aborts with exit 2.

### 1.2 Summary document (schema v1, contract `pickle-sensei-linux-regression`)

```jsonc
{
  "schemaVersion": 1,
  "contract": "pickle-sensei-linux-regression",
  "contractVersion": 1,
  "runId": "2026-09-04T02-24-36.147Z",
  "generatedAtIso": "…",
  "runner": { "node": "v22.23.2", "platform": "linux", "arch": "x64" },
  "provenance": {
    "gitSha": "<40 hex>",
    "gitBranch": "main" | null,
    "gitDirty": false,   // tracked modifications, or untracked files under datasets/ outside reports/
    "datasetsTreeSha": "<sha1 of the datasets/ listing at HEAD minus reports/>",
    "datasetReleases": [{ "releaseDir", "releaseId", "datasetId", "manifestSha256" }],
    "modelVersions": { "contactEstimator": "contact-evidence-4.4", "strokeHeuristic": "stroke-heuristic-7 (uncalibrated)", … },
    "evidenceClass": "linux_replay_proxy"
  },
  "benches": [{ "id", "title", "kind", "command", "cwd" /* repo-relative */, "status", "exitCode", "wallClockMs", "inputs", "caveats", "error", "metrics", "labels" }],
  "metrics": { "<benchId>.<metric>": number | null },   // flattened, must equal the union of benches[].metrics
  "caveats": [ … ],
  "totalWallClockMs": 1166
}
```

`modelVersions` is collected from the exported version constants of
`@pickle/swing-domain`, `@pickle/vision-geometry`, `@pickle/swing-lab` and the
frozen coach-gates spec id (`collectModelVersions()` in `benches.ts`), so a
change to any estimator/proposer/tracker version shows up in the provenance
even if the metric values happen not to move.

### 1.3 `bench:compare` semantics

Tolerances live in `packages/evaluation/regression.tolerances.json`
(`configVersion: 1`, same contract id/version as the summary). Every metric the
nine benches currently emit is listed with a `direction`
(`higher_is_better` | `lower_is_better` | `informational`), an
`absoluteTolerance`, and a one-line `rationale`. Unlisted metrics are governed
by `unlistedMetricPolicy` (`"fail"` in the committed config — a new metric
must be classified before it can pass), and a metric that was a number in the
baseline and `null` in the candidate is a regression when
`lostMeasurementIsRegression` is true (committed: true).

Per-metric statuses:

| status                 | meaning                                                                        | fails?            |
| ---------------------- | ------------------------------------------------------------------------------ | ----------------- |
| `improved`             | moved in the good direction by more than the tolerance                         | no                |
| `regressed`            | moved in the bad direction by more than the tolerance                          | **yes**           |
| `within_tolerance`     | moved, but within the declared tolerance                                       | no                |
| `unchanged`            | identical value                                                                | no                |
| `informational`        | direction `informational` (corpus sizes, denominators) — reported, never fails | no                |
| `measurement_lost`     | number → `null`                                                                | per config        |
| `newly_measured`       | `null` → number — reported as a warning, never counted as an improvement       | no                |
| `unmeasured_both`      | `null` in both                                                                 | no                |
| `missing_in_candidate` | metric key absent from candidate (guarded metrics fail)                        | **yes** if listed |
| `missing_in_baseline`  | metric key new in candidate                                                    | no                |
| `unlisted`             | present in both but not in the tolerance file                                  | per policy        |

Bench-level: a bench `failed` or `missing` in the candidate fails the
comparison, including one that also failed in the baseline
(`failed_in_both` — a persistent failure never reads as clean); a bench that
failed in the baseline but recovered does not.

Identity checks: contract id/version, schema version and `evidenceClass`
mismatches make the pair **non-comparable** (exit 3, no metric table).
Differences in `datasetsTreeSha`, `datasetReleases`, `runner.*` or a dirty
tree on either side are printed as **CONFOUND** warnings (the comparison still runs
— you decide whether the delta is the code or the data). Different `gitSha`
and different `modelVersions.*` are the expected kind of change and are
listed for the record.

Exit codes: `0` clean, `1` regressions beyond declared tolerances, `2` usage
or invalid input (either document fails schema validation), `3` non-comparable.

### 1.4 Tests

`packages/evaluation/test/regressionSummary.test.ts`,
`regressionCompare.test.ts`, `regressionRun.test.ts` (VERIFIED:
`pnpm --filter @pickle/evaluation test` → 5 files, 61 tests passed). They pin:
every schema failure code (missing/malformed provenance, non-hex SHAs, bench
kind ↔ exitCode coupling, failed-bench-with-metrics, flattened-view mismatch),
the JSON Schema staying in lock-step with the validator's key/enum lists
(unknown keys rejected at every closed object), run-id validation, untracked
dataset inputs marking the tree dirty, the
committed tolerance file validating, tolerance boundary behaviour in both
directions, lost/new measurements, unlisted policy, bench failure handling,
non-comparability, confound classification, report formatting, and an
end-to-end `run → compare` on the real `contact_replay` bench in an isolated
output directory.

### 1.5 Baseline

`datasets/reports/regression/baseline.json` is a verbatim `bench:regression`
summary produced from a clean, detached `git worktree` of `origin/main` at
`7c034aa00ea3c4ff0e63c3b84b548cec8d62c96f` (`gitDirty: false`, `gitBranch:
null`), with the runner sources copied in as untracked files because the runner
did not exist on that commit. The exact command, exit code, wall clocks, Node
version caveat and the determinism check against the PR branch (all 200
metrics identical, `bench:compare` exit 0) are recorded in
`datasets/reports/regression/README.md`. Regenerate it only from a clean
checkout and commit the new document alongside the change that intentionally
moved a metric. Never edit numbers in it by hand.

---

## 2. Map of the existing evaluation system

`packages/swing-lab` holds 97 `src/*.ts` scripts; the ones below are the
measurement/bench entry points (the remainder are acquisition, annotation,
export, mining and report tooling). Wall clocks are VERIFIED from a
one-off probe on 2026-09-04 (each script run once via
`pnpm exec tsx …` from `packages/swing-lab`, exit code 0 unless noted).

Classification key: **D** = deterministic + Linux-runnable (replays committed
artifacts); **S** = Linux-runnable but slow; **M** = Mac/device-only (needs
Apple Vision, a Swift build, gitignored videos or an iPhone).

| command (from `packages/swing-lab` unless noted)                  | class         | measures                                                                                                                                                                                                                                                                                                                                                                                                    | inputs                                                                                                                          | writes                                                                                                                                                                                 | wall      |
| ----------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `tsx src/eventRecallBench.ts`                                     | D             | stroke-event recall vs gold target events (`PROPOSED_OK` / `MIS_BOUNDED` / `MISSED`), contact-inside rate                                                                                                                                                                                                                                                                                                   | `datasets/corpus/bundles/*/annotation/*events*.json`, committed wrist series                                                    | `datasets/experiments/wave-e/event-recall-<ts>.json` (side effect)                                                                                                                     | 0.8 s     |
| `tsx src/ownershipBench.ts [--apply-corrections] --out …`         | D             | target/other paddle attribution per method on human-labeled dual frames                                                                                                                                                                                                                                                                                                                                     | dual-paddle frame labels, committed pose (17 of 38 frames)                                                                      | `--out` path                                                                                                                                                                           | 0.9 s     |
| `tsx src/ballHardSliceEval.ts <out.json>`                         | D             | ball tracking on occlusion slices (observed / entering / occluded / reacquired / uncertain)                                                                                                                                                                                                                                                                                                                 | `datasets/experiments/wave-e/e12-ball-hard-slices/manifest.json`                                                                | `<out.json>`                                                                                                                                                                           | 1.2 s     |
| `tsx ../../datasets/experiments/wave-h/h14-contact-replay-run.ts` | D             | contact-gold replay (same engine as `contact_replay`)                                                                                                                                                                                                                                                                                                                                                       | wave-a gold contact events, pose, oracle ball                                                                                   | **overwrites** `datasets/experiments/wave-h/h14-contact-replay-linux-proxy.json`                                                                                                       | 1.0 s     |
| `tsx ../../datasets/experiments/wave-d3/d3-05-measure-gold.ts`    | D             | phase segmentation anchored vs anchor-free (segmented/total)                                                                                                                                                                                                                                                                                                                                                | wave-a gold phase boundaries + pose                                                                                             | stdout only                                                                                                                                                                            | 0.8 s     |
| `tsx src/strokeTaxonomyBench.ts`                                  | D             | gold-label coverage by taxonomy level; **prediction side has no data** (canonical runs need macOS pose extraction)                                                                                                                                                                                                                                                                                          | `devin-visual-v4-waveD2-events.json` labels; `datasets/paddle-bench/runs/` (absent on Linux)                                    | stdout only                                                                                                                                                                            | 0.7 s     |
| `tsx src/eventCompletionBench.ts`                                 | D             | fixed vs adaptive analysis-completion policy against gold event ends                                                                                                                                                                                                                                                                                                                                        | event + phase labels, wrist speed series                                                                                        | `datasets/completion-bench/completion-<ts>.json` (side effect)                                                                                                                         | 0.9 s     |
| `tsx src/coachGates.ts`                                           | D             | frozen coach release gates                                                                                                                                                                                                                                                                                                                                                                                  | `datasets/coach-review/gates/coach-gates.v1.json`, coach reviews (0 files)                                                      | **overwrites** `datasets/coach-review/gates/coach-gates-latest-report.json`                                                                                                            | 0.9 s     |
| `tsx src/scoreStability.ts`                                       | D             | score stability across perturbations (h04)                                                                                                                                                                                                                                                                                                                                                                  | committed run artifacts                                                                                                         | **overwrites** `datasets/experiments/wave-g2/h04-score-stability-report.json`                                                                                                          | 0.8 s     |
| `tsx src/coverageRisk.ts`                                         | D             | coverage/risk curves vs confidence threshold (e07)                                                                                                                                                                                                                                                                                                                                                          | committed cascade artifacts                                                                                                     | **overwrites** `datasets/experiments/wave-e/e07-coverage-risk.json`                                                                                                                    | 0.8 s     |
| `tsx src/silentFailureRetro.ts`                                   | D             | silent-failure retrospective over committed cascade runs (all 0/3 dev)                                                                                                                                                                                                                                                                                                                                      | `datasets/cascade/*.json`                                                                                                       | **overwrites** `datasets/experiments/wave-e/e07-silent-failure-retro.json`                                                                                                             | 0.7 s     |
| `tsx src/learningCurve.ts`                                        | D             | leave-one-out recall vs n labeled cases (reports UNSTABLE at n=3)                                                                                                                                                                                                                                                                                                                                           | gold labels                                                                                                                     | **overwrites** `datasets/corpus/learning-curves.json`                                                                                                                                  | 0.8 s     |
| `tsx src/paddleBench.ts`                                          | D             | paddle detection scoring of committed candidate files vs labels; prints coverage gaps                                                                                                                                                                                                                                                                                                                       | `datasets/paddle-bench/labels`, committed candidates                                                                            | `datasets/paddle-bench/results/paddle-bench-<ts>.json` (side effect)                                                                                                                   | 0.8 s     |
| `tsx src/ballBench.ts`                                            | D             | ball detection scoring vs labels; prints coverage gaps                                                                                                                                                                                                                                                                                                                                                      | `datasets/ball-bench/`                                                                                                          | `datasets/ball-bench/results/ball-bench-<ts>.json` (side effect)                                                                                                                       | 0.7 s     |
| `tsx src/targetAcquisitionBench.ts run`                           | D/**M**       | target acquisition (lock rate, lock-correct rate, post-lock stability) over 301 replay cases (59 verified) — **0 cases scored on Linux** because it reads `datasets/corpus/runs/<rec>/people.json`, which is gitignored (Mac-regenerated); the committed 2026-08-29 result scored 54 verified cases                                                                                                         | `datasets/ta-bench/cases.json` + gitignored canonical runs                                                                      | `datasets/ta-bench/results/ta-bench-<ts>.json` (side effect)                                                                                                                           | 0.8 s     |
| `tsx src/cascadeWaterfall.ts`                                     | D             | cascade silent-failure contract v1.1 — 0/0 trials on Linux (no canonical runs)                                                                                                                                                                                                                                                                                                                              | canonical runs (absent on Linux)                                                                                                | `datasets/cascade/cascade-<ts>.json` (side effect)                                                                                                                                     | 0.8 s     |
| `tsx src/e13EventBoundsEval.ts`                                   | D             | event bounds on 3 bundles (same engine as `event_bounds_e13`)                                                                                                                                                                                                                                                                                                                                               | D2-07 gold events, wrist series                                                                                                 | **overwrites** `datasets/experiments/wave-e/e13-event-bounds-eval-report.json`                                                                                                         | 0.8 s     |
| `tsx src/oodNegativesMeasure.ts`                                  | D             | frame-analyzability gate on the 11 real OOD negatives (tennis ×2, badminton, table tennis ×2, squash, racquetball, empty court, crowd, interview, title card) — all 11 pass the pose-free gate (`gateOk=true`)                                                                                                                                                                                              | `datasets/ood/registry.json` `items`, `negatives/`                                                                              | **overwrites** `datasets/experiments/wave-d/d08-ood-measurements.json`                                                                                                                 | 8.8 s     |
| `tsx src/oodGateWaveE.ts`                                         | D             | pose-free OOD gate over the full OOD corpus: 11 real + 9 derived probes (corrupt bytes, truncated, garbage, still image, still-image video, test graphics, extreme tall/wide) — 8 of 20 rejected, all rejections are derived probes                                                                                                                                                                         | `datasets/ood/registry.json` `items` + `derivedItems`                                                                           | **overwrites** `datasets/experiments/wave-e/e11-ood-gate-measurements.json` (only `measuredAt` changed on re-run)                                                                      | 8.5 s     |
| `tsx src/oodSpeedGapMeasure.ts`                                   | **S**         | OOD speed-gap measurements (26 measurements)                                                                                                                                                                                                                                                                                                                                                                | `datasets/ood/`                                                                                                                 | **overwrites** `datasets/experiments/wave-f/f10-speed-gap-measurements.json`                                                                                                           | **367 s** |
| `tsx src/modelHealthReview.ts`                                    | D             | model-health review roll-up (JSON + Markdown)                                                                                                                                                                                                                                                                                                                                                               | committed reports                                                                                                               | `datasets/reports/model-health/model-health-review-<date>.{json,md}` (side effect)                                                                                                     | 0.8 s     |
| `tsx src/datasetReport.ts`                                        | D             | corpus stroke/handedness/environment coverage report                                                                                                                                                                                                                                                                                                                                                        | corpus                                                                                                                          | stdout only                                                                                                                                                                            | 0.7 s     |
| `tsx src/corpusCheck.ts`                                          | D             | corpus invariants (677 files, 0 parse failures, 0 violations)                                                                                                                                                                                                                                                                                                                                               | `datasets/corpus/`                                                                                                              | stdout only                                                                                                                                                                            | 1.3 s     |
| `pnpm --filter @pickle/vision-geometry eval`                      | D             | 4 vitest eval files: contact gold replay + g05/f09 posterior eval; fails when the committed e02/g05 artifact disagrees with the fresh run or `wrongMarkers`/`medianErrorMs` regress past the committed record (ceilings only via `acceptedRegressions` for the live estimator version). Regenerate the committed artifacts with `PICKLE_EVAL_ACCEPT_ARTIFACTS=1 pnpm --filter @pickle/vision-geometry eval` | wave-a gold, committed `datasets/experiments/wave-e/e02-contact-gold-replay-metrics.json`, `wave-g/g05-f09-posterior-eval.json` | gitignored `artifacts/vision-geometry-eval/{e02-contact-gold-replay-metrics,g05-f09-posterior-eval}.json`; committed `datasets/` artifacts only under `PICKLE_EVAL_ACCEPT_ARTIFACTS=1` | 1.5 s     |
| `pnpm --filter @pickle/evaluation test`                           | D             | synthetic fixture metrics + real-benchmark loader tests (+ regression suite, this PR)                                                                                                                                                                                                                                                                                                                       | fixtures                                                                                                                        | none                                                                                                                                                                                   | 1.3 s     |
| `pnpm lab:regen` / `tsx src/benchRegen.ts`                        | **M**         | regenerates canonical runs (`datasets/paddle-bench/runs/`, gitignored) with Apple Vision pose                                                                                                                                                                                                                                                                                                               | gitignored videos                                                                                                               | gitignored runs                                                                                                                                                                        | n/a       |
| `tsx src/analyzeVideo.ts`, `src/mineVideo.ts`, `src/engine/*`     | **M**/network | video analysis, acquisition, mining — need videos/ffmpeg/network; not measurement                                                                                                                                                                                                                                                                                                                           | —                                                                                                                               | —                                                                                                                                                                                      | n/a       |
| `tools/mac-bench/run-mac-bench.sh` (`@pickle/mac-bench`)          | **M**         | on-device-equivalent cascade: latency, memory, crash/failure, paddle detector (DFINE via torch MPS) — see `tools/mac-bench/RUNBOOK.md`, `ARTIFACTS_REQUIRED.md`                                                                                                                                                                                                                                             | gitignored videos, HF weights, Swift build, macOS 14+                                                                           | `tools/mac-bench/results/`                                                                                                                                                             | not run   |

Not run, by rule: anything under `tools/mac-bench`, `pnpm lab:regen`, and
iOS/Xcode work (`.github/workflows/macos-verify.yml`, self-hosted M4 runner).

**Why the regression runner wraps only nine of these.** The other **D** scripts
either duplicate an included engine (`h14-contact-replay-run.ts`,
`e13EventBoundsEval.ts`), report corpus availability rather than model
behaviour (`datasetReport`, `corpusCheck`, `learningCurve`, `modelHealthReview`),
currently have zero scoreable trials on Linux (`cascadeWaterfall`,
`targetAcquisitionBench`, `strokeTaxonomyBench` prediction side), or are
derived roll-ups of committed artifacts rather than fresh measurements
(`coverageRisk`, `silentFailureRetro`, `scoreStability`). `paddleBench` /
`ballBench` are candidates for inclusion once their committed candidate files
are regenerated from a versioned detector — today they score whatever
candidate JSON is committed, which is not tied to a code version the
comparison could attribute a delta to. `oodGateWaveE` (8.5 s, 20 items,
reject count is a scoreable metric) is the most useful next addition;
`oodSpeedGapMeasure` (367 s) belongs in nightly, not CI.

### 2.1 Datasets and gold (what the benches read)

All numbers INFERRED from `datasets/releases/*/manifest.json`, `datasets/holdouts/ledger.json`,
`datasets/pickleball/registry.json` and DATA_CARDs.

| release                                                                        | contents                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pickle-sensei-datasets@v2`                                                    | 20 sources, 26 recordings (17 root), 12 sessions, ≈62.9 min root footage; 5 annotated cases; 10 gold target events; gold frames: 78 paddle, 83 other-paddle, 22 ball, 5 contact estimates, 5 stroke labels, 25 phase boundaries, 16 event labels; 199 Tier-C candidate events (**not labels**) |
| `pickle-real-v0.3`                                                             | 8 unique sources, 13 files, 7 sessions, 5 annotated cases, 5 target events; no silver labels                                                                                                                                                                                                   |
| `pickle-real-v0.1`, `v0.2`, `paddle-distill-v0.1`, `pickle-sensei-datasets@v1` | earlier immutable releases; recorded in provenance so a comparison notices if any manifest changes                                                                                                                                                                                             |

Splits (`splits-v1`, unit = session): dev 11 sessions, val 1, locked_test 1
(`afn-vic-2025`), shadow 2. Holdout ledger (`holdout-rotation-v1`): `wm-dink-01`
and `afn-vic-rally1` are `LOCKED_TEST` → `RETIRED_TO_REGRESSION`. The wrapped
benches exclude held-out cases themselves (INFERRED from the code paths of
`contactGoldReplay`, `ownershipBench`, `eventRecallBench`, `coachGates`; the
regression runner calls `ownershipBench` with `includeHeldOut=false`).

Licensing / consent (INFERRED from manifests): 20 training-eligible sources,
0 rights-quarantined, per-modality rights recorded per source. Eligible source
licenses in `datasets/pickleball/registry.json` are CC BY 3.0 (YouTube page
license field) and U.S. federal public domain (DVIDS, VA, VOA); entries whose
license reads "Mixed", "None declared", CC BY-NC-SA or a public-domain mark
assessed FALSE sit in the registry's `quarantinedUnknownRights` list with
`quarantined_*` / `excluded_*` statuses and are not among the 20. **Zero first-party recordings and zero consent records exist in the
repository**; first-party intake verifies an external append-only consent
ledger at runtime. Single annotator across all GOLD labels; 0 expert coaches
(fault taxonomy and drill library are unvalidated drafts).

### 2.2 Product taxonomy used by the benches

Stroke labels come from `STROKE_TAXONOMY_VERSION = "pickleball-taxonomy-v2"`
(`@pickle/swing-domain`): 61 techniques across the serve, return, groundstroke,
drop/reset, dink, volley, attack/counter, overhead/lob and specialty families.
Side, spin, direction, court zone, contact state, intent and rally outcome are
orthogonal attributes, not extra classes. Annotation outcomes include
`unknown_technique`, `no_stroke`, `partial` and `aborted`; the classifiers
return scored-or-abstain results and the benches count abstentions separately.
No bench in this document invents a label outside that taxonomy.

---

## 3. Metric-by-metric: measurable today vs needs labels

"Measurable" means a Linux bench in §1.1 produces a number from gold labels
that exist. "Proxy" means the number exists but its input is not the shipped
device pipeline (committed Apple Vision pose from macOS, oracle ball, absent
paddle track).

| metric                      | status today                                                                                                                                                                                                                                                                                              | where / what's missing                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| analysis completion         | **measurable (proxy)** — `completion_bench`: fixed vs adaptive end-error / recovery-lost over n=11 gold event ends                                                                                                                                                                                        | needs more event-end labels; no on-device timing                                                                                               |
| player detection / tracking | **Mac-gated** — gold exists (`datasets/ta-bench/cases.json`: 301 replay windows with `trueTrackId`, 59 verified) but `targetAcquisitionBench` scores 0 cases on Linux because the `people.json` tracks it replays live in gitignored `datasets/corpus/runs/`; no per-frame player-box gold                | regenerate canonical runs (Mac, `pnpm lab:regen`) or commit the track files; per-frame identity labels for doubles rallies                     |
| pose quality                | **not measurable** — pose is Apple Vision output committed as-is; no keypoint gold                                                                                                                                                                                                                        | needs keypoint annotations or an agreed pose-quality proxy; device-only capture                                                                |
| stroke segmentation         | **measurable (proxy)** — `event_recall` (16 gold events, recall + contact-inside), `event_bounds_e13` (5 target events, start/end median error)                                                                                                                                                           | tiny n; other-owner rows are structurally misses                                                                                               |
| stroke classification       | **partially measurable (proxy)** — `stroke_heuristic`: 18 evaluable of 29 labels; L1 3 correct / 0 wrong / 14 abstained; L2 2 / 1 / 8 (7 gold unknown). `strokeTaxonomyBench` prediction side has **no runs on Linux**                                                                                    | needs stroke labels across the 61 techniques (currently 6 L3 techniques present) and canonical runs (Mac)                                      |
| paddle detection            | **partially measurable** — `paddleBench` scores committed candidate files against 78+83 paddle frames; `ownership_dual_frame` scores attribution on 38 dual frames (17 with pose). Not in the regression set (see §2)                                                                                     | detector candidates must be regenerated from a versioned detector (Mac/`tools/paddle-lab`) to attribute deltas to code                         |
| contact estimation          | **measurable (proxy)** — `contact_replay`: 10 target events, coverage / abstention / strict (≤66 ms) / acceptable (≤132 ms) hits / median-p75-p90 error                                                                                                                                                   | oracle ball, no paddle; 10 events                                                                                                              |
| temporal accuracy           | **measurable (proxy)** — contact error ms (`contact_replay`), event start/end error ms (`event_bounds_e13`), completion end error (`completion_bench`); `phase_gold_d3_05` counts segmented/abstained only, **no boundary timing**                                                                        | phase boundary timing needs a script that scores the 25 committed phase boundaries in ms                                                       |
| confidence calibration      | **not measurable** — every version string says `uncalibrated`; `contact_replay.high_confidence_violations` and `stroke_heuristic.confidently_wrong` are the only calibration-adjacent counts; `coverageRisk` curves exist on committed cascade data                                                       | needs far more labeled decisions than 10–30 to fit or test calibration                                                                         |
| coaching consistency        | **measurable as a gate, not a score** — `coach_gates`: 17 gates, 3 PASS / 0 FAIL / 14 NOT_EVALUABLE, `RELEASE_BLOCKED` with 0 active coaches                                                                                                                                                              | needs coach reviews (`datasets/coach-review/`) from real coaches; `coachAgreement.ts` has no data                                              |
| latency                     | **Mac/device-only** — `tools/mac-bench` and the iOS harness (`IPHONE_HARNESS.md`); not run here                                                                                                                                                                                                           | self-hosted M4 runner / device                                                                                                                 |
| crash / failure rate        | **Mac/device-only** for the real pipeline; on Linux, `cascadeWaterfall` reports 0/0 trials (no canonical runs), `oodNegativesMeasure` shows the frame-analyzability gate passes OOD negatives (`gateOk=true` on all 5 listed) although the OOD policy says every clip should end in no confident analysis | canonical runs (Mac); a scored OOD-reject rate (the expected outcome is uniform per `datasets/ood/registry.json` policy) instead of a printout |
| memory                      | **Mac/device-only** — `tools/mac-bench`; nothing on Linux                                                                                                                                                                                                                                                 | device                                                                                                                                         |

---

## 4. Human labeling still required

Grounded in what the corpus reports about itself (`datasetReport.ts`,
`paddleBench.ts` / `ballBench.ts` coverage-gap output, `learningCurve.ts`,
release manifests — all VERIFIED output on 2026-09-04):

**Stroke families (v3 labels present vs missing, from `datasetReport`):**

- present: `BACKHAND_VOLLEY`, `OVERHEAD`, `FOREHAND_DRIVE`, `FOREHAND_VOLLEY`,
  `SERVE`, `BACKHAND_DINK`
- **missing entirely:** `BACKHAND_DRIVE`, `RETURN`, `FOREHAND_DINK`, `DROP`,
  `RESET`, `SPEEDUP`
- L3 (61-technique) coverage in the D2 event labels is 6 techniques
  (`punch_volley_backhand` ×3, `punch_volley_forehand` ×2, `overhead_smash` ×2,
  `drop_serve_forehand`, `drive_forehand`, `block_volley_backhand`) with 19 of
  29 labels `unknown` at L3 — i.e. **forehand vs backhand, serve vs return,
  dink, volley and overhead each have single-digit or zero labeled examples**.
  `learningCurve.ts` reports the leave-one-out recall interval spans 0.58 at
  n=3: no reliability claim is possible until each family has enough labeled
  cases to make that interval narrow.
- Handedness: right-handed only; **left-handed coverage missing**.

**Capture conditions:**

- Camera angles: paddle-bench reports "no true side view labeled
  (front-oblique + rear only)". Baseline/behind-the-court and true side views
  need labels.
- Low light: "no low-light footage" (paddle-bench), "no low-light labels"
  (ball-bench), environment = outdoor daylight + indoor gym only
  (`datasetReport`).
- Motion blur: "no deliberate motion-blur stress case" (paddle-bench).
- Partial visibility / occlusion: ball occlusion coverage is "paddle- and
  body-occlusion only"; "no net-crossing occlusion sequence labeled"; bounce
  events adjacent to labels are unlabeled. Player partially out of frame is
  not a labeled scenario anywhere.
- Multi-player: 38 dual-paddle frames exist (ownership bench) but only 17 have
  committed pose. Target-acquisition windows exist (301, of which 59 verified,
  291 tagged `multi_player`) but score on Linux only if the gitignored
  `people.json` tracks are regenerated on a Mac; there are no per-frame
  player-box labels.
- No-player / non-sport footage: `datasets/ood/` has 11 rights-cleared
  negatives (other racket sports, empty court, crowd, interview, title card).
  The policy is uniform — every OOD clip must end in no confident analysis — so
  the label exists implicitly; what is missing is a bench that scores the
  reject rate (the frame-analyzability gate currently prints `gateOk=true` for
  them).
- Corrupted media: `datasets/ood/derived/` has 9 synthetic files
  (corrupt bytes, truncated, garbage, still image, still-image video, test
  graphics, extreme tall/wide). `oodGateWaveE.ts` measures them and
  `packages/swing-lab/test/oodDerivedNegatives.test.ts` locks the measured
  verdicts (pose-free signals only; pose-conditioned rejects are Mac-only). No
  real-world variable-frame-rate or zero-length uploads are represented.

**Labels needed to unlock the "not measurable" rows of §3:** per-frame
target-player identity (tracking), any pose keypoint gold or agreed proxy (pose
quality), coach reviews from active coaches (coaching consistency), and
calibration-scale volumes of scored decisions (confidence calibration). Contact
and phase labels exist at 5–25 items each; phase **boundary timing** is labeled
but no script scores it in ms yet.

**Annotation process gaps:** one annotator, no second-annotator agreement
measurement, zero expert coaches. Second-annotator passes on the existing gold
are as valuable as new labels.

---

## 5. Gold-corpus scaffolding

Inspected: `ml/annotations/annotation.schema.json`, `ml/datasets/manifest.schema.json`,
their validators and `ml/scripts/test_*.py` (17 tests). The annotation schema
already covers the outcome states (`unknown_technique`, `no_stroke`,
`partial`, `aborted`) and orthogonal attributes; the dataset manifest schema
already requires consent terms, rights review, provenance, human review and
athlete-group splits per record. No schema or validator gap was found that the §4 labeling
work would need, so **no new files were added under `ml/`** — duplicating the
schemas would have been worse than leaving them alone. The concrete gap is
label _volume_, not label _schema_.

---

## 6. Verification record for this document's claims

Run on 2026-09-04, Ubuntu 22.04, Node v22.23.2 (engines declare `>=20 <21`),
pnpm 10.15.1, exit code 0 for each:

- `pnpm --filter @pickle/evaluation typecheck`
- `pnpm --filter @pickle/evaluation test` — 5 files, 54 tests
- `pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/regression-probe` — 9/9 benches ok, 200 metrics, 1166 ms
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck` — see the PR description
  for the exact output of the final run
- Per-script probe wall clocks in §2: one run each via `pnpm exec tsx <script>`
  from `packages/swing-lab`; the tree was restored after each probe.

Mac/device numbers (latency, memory, crash rate, on-device pose) were **not**
produced and are not claimed anywhere in this document.
