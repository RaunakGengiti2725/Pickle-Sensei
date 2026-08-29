# mac-bench — single-command Mac/iPhone benchmark harness

One command on a Mac produces one versioned, comparable results document for
the whole perception pipeline. Built on Linux (Wave D, D10); the macOS
execution path is **UNVERIFIED-HERE** — it has never been executed on a Mac by
the workstream that wrote it. Everything runnable on Linux (schema validation,
latency statistics, sample harvesting, result assembly, result comparison) is
unit-tested here: `pnpm --filter @pickle/mac-bench test`.

## The one command (macOS only)

```
tools/mac-bench/run-mac-bench.sh [--warm N] [--cases id1,id2,…] [--skip-regen]
```

It fails fast with a precise message on Linux (and on a Mac missing any
prerequisite — see `ARTIFACTS_REQUIRED.md`). In order it:

1. builds the Swift extractor (`native/swing-lab`, release);
2. runs a COLD timing pass (fresh scratch dirs, purged python bytecode
   caches, full extraction — one run per case);
3. regenerates the canonical runs via `pnpm lab:regen --exec <cases>` (the
   versioned, identity-verified regeneration every bench reads — rule 18);
4. runs N WARM timing passes (full end-to-end runs into scratch dirs; caches
   warm, extraction still real);
5. runs `pnpm lab:cascade` (strict cascade + usable-result-v1 +
   silent-failure-v1) over the canonical runs;
6. exports `tools/mac-bench/results/mac-bench-<unix-ms>.json`
   (mac-bench-results-v1), with raw samples beside it as
   `mac-bench-<unix-ms>.samples.jsonl`.

Canonical run dirs are only ever written by `lab:regen` (step 3). All timing
runs write to scratch dirs; cold runs purge only their own scratch dir.

## Results schema: `mac-bench-results-v1`

Defined and validated in `src/resultsSchema.ts` (the TypeScript types are the
normative schema; `validateMacBenchResults` is the executable check,
fixture-tested in `test/resultsSchema.test.ts`). Top-level shape:

| field                     | meaning                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`           | `"mac-bench-results-v1"` — changes only by re-versioning                                                                                                     |
| `generatedAtIso`          | when the document was assembled                                                                                                                              |
| `host`                    | platform, OS version, hardware model, node version, python version                                                                                           |
| `provenance`              | git commit, branch, `dirtyWorkingTree` (a dirty tree is disclosed, not hidden)                                                                               |
| `plan`                    | case IDs benched + cold/warm iteration counts                                                                                                                |
| `extractor`               | whether the Swift extractor built, build wall time, binary path                                                                                              |
| `stages[]`                | per-stage latency: `cold`/`warm` each summarized as P50/P90/P95/min/max/mean with `sampleCount`, plus raw `samples[]`                                        |
| `cascade`                 | counters copied VERBATIM from the `lab:cascade` JSON (strict survival, usable-result-v1, silent-failure-v1, per-stage unconditional/conditional) — or `null` |
| `cascadeUnmeasuredReason` | required non-empty when `cascade` is `null` (absence is explained, never zeroed)                                                                             |
| `notes[]`                 | free-form disclosures                                                                                                                                        |

Stage vocabulary: `e2e` (wall time around the whole analyze invocation) plus
the pipeline's own `report.json` timings — `poseExtract`, `playerTrack`,
`eventPrePass`, `paddleDetect`, `paddleTrack`, `ballCandidates`, `ballTrack`,
`eventIsolation`, `fusionAnalysis` — and `cascade`. A stage the pipeline did
not reach is absent, never 0.

Cold/warm semantics are documented once, in the `src/runCase.ts` header, and
referenced from the exported document's notes. Percentiles are nearest-rank
(`src/latencyStats.ts`); with small n the summary's `sampleCount` says so —
do not read a P95 over 3 samples as a stable estimate.

## Comparing runs

```
pnpm --filter @pickle/mac-bench compare -- <old-results.json> <new-results.json> [--out report.json]
```

`src/compareResults.ts` emits a `mac-bench-compare-v1` report with a
`verdict` of `OK` / `REGRESSION` / `NOT_COMPARABLE`:

- cascade: any drop in strict survival, usable results, or per-stage counts,
  or any RISE in silent failures → regression. Contract re-versions
  (`usable-result-v2`, …) → `NOT_COMPARABLE`, never silently compared.
- latency: warm/cold P50 or P95 must grow by BOTH >10% and >50ms to count as
  a regression (both gates versioned in the file, not tunable per run).
- dirty working trees, differing case lists, and one-sided stages/cascade
  become caveats; improvements are listed but never offset a regression.
- exit code is non-zero on `REGRESSION`/`NOT_COMPARABLE` so CI can gate on it.

## iPhone harness

See `IPHONE_HARNESS.md` (spec) — device evidence is BLOCKED_EXTERNAL until
physical iPhone hardware exists. The mobile-side export contract
(`pickle.device-bench.v1`: thermal/FPS/memory series + per-capture telemetry
already emitted by the existing capture hooks) lives in
`apps/mobile/src/camera/deviceBench.ts` and is jest-tested on Linux.
