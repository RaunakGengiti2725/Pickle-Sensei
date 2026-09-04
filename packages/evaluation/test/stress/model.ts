/**
 * Seeded randomized model checker for the `@pickle/evaluation` public API.
 *
 * A sequence is a list of ACTIONS generated up front from one 32-bit seed
 * (so it is replayable and shrinkable), applied one at a time to a `State`
 * that owns every input the public API consumes:
 *
 *   - metric inputs (classification / timing / paired scores / calibration)
 *   - a baseline + candidate `RegressionSummary` pair and a `ToleranceConfig`
 *     (seeded from the COMMITTED `datasets/reports/regression/baseline.json`
 *     and `regression.tolerances.json` — never edited on disk)
 *   - a real-benchmark manifest (structure only; `declaredStroke` is a fixed
 *     placeholder, no labels are fabricated)
 *   - synthetic swing generator overrides (the generator is explicitly
 *     synthetic and stamps its own provenance)
 *
 * After EVERY action `checkInvariants` re-derives every public output and
 * asserts the invariants documented in the source (metrics.ts, compare.ts,
 * summarySchema.ts, tolerances.ts, realBenchmark.ts, swingGenerator.ts,
 * benchmark.ts) and in AGENTS.md / docs/EVALUATION.md:
 *
 *   I1  no NaN / ±Infinity anywhere in a public output (except the one
 *       documented sentinel in `regressionViolations`, checked separately)
 *   I2  abstention is first-class: a `null` metric is never coerced to a
 *       number — its comparison status is one of measurement_lost /
 *       newly_measured / unmeasured_both with `delta === null`
 *   I3  comparator exit code ⇔ report contents (3 ⇔ non-comparable,
 *       1 ⇔ regressions, 0 otherwise); informational metrics never fail;
 *       per-metric status matches the table in compare.ts
 *   I4  `summary.metrics === flattenBenchMetrics(summary.benches)` and the
 *       summary survives a JSON round-trip through `validateRegressionSummary`
 *   I5  invalid documents are REJECTED by the validators (near-legal probes)
 *   I6  metric reports are bounded ([0,1] rates, ±1 correlations, n bookkeeping)
 *       and order-invariant
 *   I7  player-grouped splits are deterministic and independent of case order
 *   I8  synthetic swings are finite, monotone in time, provenance-stamped and
 *       deterministic; mirroring is an involution
 *   I9  determinism: the same seed yields an identical per-step trace digest
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_PROVENANCES,
  CALIBRATION_MIN_SAMPLES,
  REAL_BENCHMARK_SCHEMA_VERSION,
  SYNTHETIC_PRODUCER,
  assignSplits,
  calibrationReport,
  classificationReport,
  compareSummaries,
  flattenBenchMetrics,
  formatCompareReport,
  generateSwing,
  generateSwingSequence,
  identityDifferences,
  meanAbsoluteError,
  mirrorFrames,
  pearsonCorrelation,
  regressionViolations,
  reportBanner,
  spearmanCorrelation,
  splitForPlayer,
  timingReport,
  validateRealBenchmarkManifest,
  validateRegressionSummary,
  validateToleranceConfig,
  type BenchRecord,
  type BenchmarkReport,
  type BoundaryTimingCase,
  type CalibrationCase,
  type ClassificationCase,
  type MetricComparisonStatus,
  type MetricDirection,
  type MetricTolerance,
  type PairedScores,
  type RealBenchmarkCase,
  type RealBenchmarkManifest,
  type RegressionSummary,
  type SwingTruth,
  type ToleranceConfig,
} from "../../src/index.js";
import { SeededRng, canonicalJson, digest } from "./seededRng.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const COMMITTED_BASELINE = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
const COMMITTED_TOLERANCES = join(REPO_ROOT, "packages/evaluation/regression.tolerances.json");

export const MIN_SEQUENCE_LENGTH = 5;
export const MAX_SEQUENCE_LENGTH = 60;

export class InvariantError extends Error {
  readonly invariant: string;
  readonly detail: unknown;
  constructor(invariant: string, message: string, detail?: unknown) {
    super(`${invariant}: ${message}`);
    this.name = "InvariantError";
    this.invariant = invariant;
    this.detail = detail;
  }
}

function assert(condition: boolean, invariant: string, message: string, detail?: unknown): void {
  if (!condition) throw new InvariantError(invariant, message, detail);
}

// ---------------------------------------------------------------------------
// Committed fixtures
// ---------------------------------------------------------------------------

let committedCache: { baseline: RegressionSummary; config: ToleranceConfig } | null = null;

/** The committed baseline summary + tolerance config, validated once. */
export function committedFixtures(): { baseline: RegressionSummary; config: ToleranceConfig } {
  if (committedCache) return committedCache;
  const baselineRaw: unknown = JSON.parse(readFileSync(COMMITTED_BASELINE, "utf8"));
  const configRaw: unknown = JSON.parse(readFileSync(COMMITTED_TOLERANCES, "utf8"));
  const baseline = validateRegressionSummary(baselineRaw);
  if (!baseline.ok) {
    throw new InvariantError(
      "I5.committed_baseline",
      `committed baseline failed validation: ${baseline.failure.message}`,
    );
  }
  const config = validateToleranceConfig(configRaw);
  if (!config.ok) {
    throw new InvariantError(
      "I5.committed_tolerances",
      `committed tolerances failed validation: ${config.failure.message}`,
    );
  }
  committedCache = { baseline: baseline.value, config: config.value };
  return committedCache;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  classification: ClassificationCase[];
  pairs: PairedScores[];
  timing: BoundaryTimingCase[];
  calibration: CalibrationCase[];
  binCount: number;
  baseline: RegressionSummary;
  candidate: RegressionSummary;
  config: ToleranceConfig;
  manifest: RealBenchmarkManifest;
  swing: Partial<SwingTruth>;
  mustNotDegrade: string[];
  /** Fixed placeholder so no label is ever fabricated in manifests. */
  readonly strokePlaceholder: "stress_unlabeled";
}

const STRESS_MANIFEST_ID = "stress-synthetic-manifest";

export function initialState(start: "committed" | "minimal"): State {
  const committed = committedFixtures();
  let baseline: RegressionSummary;
  let config: ToleranceConfig;
  if (start === "committed") {
    baseline = clone(committed.baseline);
    config = clone(committed.config);
  } else {
    const bench: BenchRecord = {
      id: "stress_bench",
      title: "Stress bench",
      kind: "in_process",
      command: "stress()",
      cwd: "packages/evaluation",
      status: "ok",
      exitCode: null,
      wallClockMs: 1,
      inputs: ["datasets/reports/regression/baseline.json"],
      caveats: ["Linux replay proxy"],
      error: null,
      metrics: { rate: 0.5, count: 10, median_ms: null },
      labels: {},
    };
    baseline = {
      ...clone(committed.baseline),
      runId: "stress-baseline",
      benches: [bench],
      metrics: flattenBenchMetrics([bench]),
      caveats: ["stress"],
    };
    config = {
      ...clone(committed.config),
      metrics: {
        "stress_bench.rate": {
          direction: "higher_is_better",
          absoluteTolerance: 0.01,
          rationale: "stress",
        },
        "stress_bench.count": {
          direction: "informational",
          absoluteTolerance: 0,
          rationale: "stress",
        },
        "stress_bench.median_ms": {
          direction: "lower_is_better",
          absoluteTolerance: 5,
          rationale: "stress",
        },
      },
    };
  }
  return {
    classification: [],
    pairs: [],
    timing: [],
    calibration: [],
    binCount: 10,
    baseline,
    candidate: clone(baseline),
    config,
    manifest: {
      schemaVersion: REAL_BENCHMARK_SCHEMA_VERSION,
      id: STRESS_MANIFEST_ID,
      version: "0.0.0-stress",
      createdAtIso: "2026-01-01T00:00:00.000Z",
      provenance: "consented_first_party",
      splitRatios: { train: 0.7, val: 0.15, test: 0.15 },
      cases: [],
    },
    swing: {},
    mustNotDegrade: [],
    strokePlaceholder: "stress_unlabeled",
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Side = "baseline" | "candidate";

export type Action =
  | { kind: "metrics.addClassification"; n: number; alphabet: number; agree: number }
  | {
      kind: "metrics.addPairs";
      n: number;
      mode: "random" | "constant" | "linear" | "ties" | "anti" | "large";
    }
  | { kind: "metrics.addTiming"; n: number; spread: number }
  | { kind: "metrics.addCalibration"; n: number; mode: "uniform" | "edges" | "constant" }
  | { kind: "metrics.setBinCount"; binCount: number }
  | { kind: "metrics.invalidCalibrationProbe"; value: "nan" | "neg" | "over" | "inf" }
  | { kind: "metrics.clear"; which: "classification" | "pairs" | "timing" | "calibration" }
  | {
      kind: "summary.addBench";
      side: Side;
      suffix: number;
      benchKind: "in_process" | "subprocess";
      metricCount: number;
      nullEvery: number;
    }
  | {
      kind: "summary.setMetric";
      side: Side;
      benchIndex: number;
      keyIndex: number;
      newKey: boolean;
      value: "null" | "same" | "nudge" | "jump" | "boundary" | "negative" | "zero";
      magnitude: number;
    }
  | { kind: "summary.dropMetric"; side: Side; benchIndex: number; keyIndex: number }
  | { kind: "summary.failBench"; side: Side; benchIndex: number }
  | { kind: "summary.removeBench"; side: Side; benchIndex: number }
  | { kind: "summary.setDirty"; side: Side; dirty: boolean }
  | { kind: "summary.setContractVersion"; side: Side; version: number }
  | { kind: "summary.setRunner"; side: Side; node: string }
  | { kind: "summary.setModelVersion"; side: Side; key: string; value: string }
  | { kind: "summary.resetCandidate" }
  | {
      kind: "summary.invalidProbe";
      probe:
        | "nanMetric"
        | "infMetric"
        | "evidenceClass"
        | "metricsMismatch"
        | "duplicateBench"
        | "failedWithMetrics"
        | "badGitSha"
        | "extraKey"
        | "emptyBenches"
        | "inProcessExitCode"
        | "badMetricKey"
        | "negativeWallClock";
    }
  | {
      kind: "tolerance.set";
      keyIndex: number;
      direction: MetricDirection;
      tolerance: number;
    }
  | { kind: "tolerance.remove"; keyIndex: number }
  | { kind: "tolerance.setPolicy"; policy: "informational" | "fail" }
  | { kind: "tolerance.setLost"; lost: boolean }
  | {
      kind: "tolerance.invalidProbe";
      probe: "negativeTolerance" | "nanTolerance" | "badDirection" | "emptyRationale" | "badPolicy";
    }
  | { kind: "manifest.addCases"; n: number; players: number }
  | { kind: "manifest.setRatios"; a: number; b: number }
  | {
      kind: "manifest.invalidProbe";
      probe: "syntheticProvenance" | "badRatios" | "duplicateCase" | "badHash" | "missingId";
    }
  | { kind: "swing.setOverrides"; overrides: Partial<SwingTruth> }
  | { kind: "violations.select"; count: number; includeUnknown: boolean };

const FPS_CHOICES = [24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120, 240];

function randomSwingOverrides(rng: SeededRng): Partial<SwingTruth> {
  const overrides: Partial<SwingTruth> = {};
  if (rng.bool(0.6)) overrides.torsoLength = round(rng.float(0.08, 0.35), 4);
  if (rng.bool(0.5)) overrides.stanceWidthRatio = round(rng.float(0.8, 2.2), 3);
  if (rng.bool(0.5)) overrides.kneeFlexionDeg = round(rng.float(0, 90), 2);
  if (rng.bool(0.5)) overrides.contactForwardNorm = round(rng.float(-0.2, 1.2), 3);
  if (rng.bool(0.5)) overrides.contactHeightRatio = round(rng.float(0.05, 1.2), 3);
  if (rng.bool(0.5)) overrides.backswingLengthNorm = round(rng.float(0, 1.5), 3);
  if (rng.bool(0.5)) overrides.swingDipNorm = round(rng.float(0, 0.5), 3);
  if (rng.bool(0.5)) overrides.shoulderTurnDeg = round(rng.float(0, 90), 2);
  if (rng.bool(0.5)) overrides.handed = rng.pick(["right", "left"] as const);
  if (rng.bool(0.6)) overrides.fps = rng.pick(FPS_CHOICES);
  for (const key of ["readyMs", "backswingMs", "accelerateMs", "followMs", "recoverMs"] as const) {
    if (rng.bool(0.4)) overrides[key] = rng.int(50, 1200);
  }
  return overrides;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** One generated step: the action plus the RNG seed its application draws
 *  from, so removing other steps (shrinking) never changes this one. */
export interface Step {
  rngSeed: number;
  action: Action;
}

/** Generates a legal / near-legal action sequence of length 5..60 from a seed. */
export function generateActions(seed: number): { start: "committed" | "minimal"; steps: Step[] } {
  const rng = new SeededRng(seed);
  const start = rng.bool(0.5) ? "committed" : "minimal";
  const length = rng.int(MIN_SEQUENCE_LENGTH, MAX_SEQUENCE_LENGTH);
  const steps: Step[] = [];
  for (let step = 0; step < length; step += 1) {
    const rngSeed = rng.int(0, 0xffffffff);
    steps.push({ rngSeed, action: generateAction(rng) });
  }
  return { start, steps };
}

const DIRECTIONS: readonly MetricDirection[] = [
  "higher_is_better",
  "lower_is_better",
  "informational",
];

function generateAction(rng: SeededRng): Action {
  const roll = rng.next();
  const side: Side = rng.bool(0.75) ? "candidate" : "baseline";
  if (roll < 0.08) {
    return {
      kind: "metrics.addClassification",
      n: rng.int(1, 40),
      alphabet: rng.int(1, 5),
      agree: rng.float(0, 1),
    };
  }
  if (roll < 0.14) {
    return {
      kind: "metrics.addPairs",
      n: rng.int(1, 30),
      mode: rng.pick(["random", "constant", "linear", "ties", "anti", "large"] as const),
    };
  }
  if (roll < 0.18)
    return { kind: "metrics.addTiming", n: rng.int(1, 30), spread: rng.float(0, 500) };
  if (roll < 0.24) {
    return {
      kind: "metrics.addCalibration",
      n: rng.int(1, 40),
      mode: rng.pick(["uniform", "edges", "constant"] as const),
    };
  }
  if (roll < 0.26) return { kind: "metrics.setBinCount", binCount: rng.int(1, 25) };
  if (roll < 0.28) {
    return {
      kind: "metrics.invalidCalibrationProbe",
      value: rng.pick(["nan", "neg", "over", "inf"] as const),
    };
  }
  if (roll < 0.3) {
    return {
      kind: "metrics.clear",
      which: rng.pick(["classification", "pairs", "timing", "calibration"] as const),
    };
  }
  if (roll < 0.35) {
    return {
      kind: "summary.addBench",
      side,
      suffix: rng.int(0, 9),
      benchKind: rng.pick(["in_process", "subprocess"] as const),
      metricCount: rng.int(0, 6),
      nullEvery: rng.int(0, 4),
    };
  }
  if (roll < 0.5) {
    return {
      kind: "summary.setMetric",
      side,
      benchIndex: rng.int(0, 1_000),
      keyIndex: rng.int(0, 1_000),
      newKey: rng.bool(0.15),
      value: rng.pick(["null", "same", "nudge", "jump", "boundary", "negative", "zero"] as const),
      magnitude: rng.float(0, 1),
    };
  }
  if (roll < 0.54) {
    return {
      kind: "summary.dropMetric",
      side,
      benchIndex: rng.int(0, 1_000),
      keyIndex: rng.int(0, 1_000),
    };
  }
  if (roll < 0.57) return { kind: "summary.failBench", side, benchIndex: rng.int(0, 1_000) };
  if (roll < 0.59) return { kind: "summary.removeBench", side, benchIndex: rng.int(0, 1_000) };
  if (roll < 0.61) return { kind: "summary.setDirty", side, dirty: rng.bool() };
  if (roll < 0.62) return { kind: "summary.setContractVersion", side, version: rng.int(1, 3) };
  if (roll < 0.64) {
    return { kind: "summary.setRunner", side, node: rng.pick(["v22.23.2", "v22.12.0", "v24.1.0"]) };
  }
  if (roll < 0.66) {
    return {
      kind: "summary.setModelVersion",
      side,
      key: rng.pick(["contactEstimator", "strokeHeuristic", "stressModel"]),
      value: `v${rng.int(1, 9)}.${rng.int(0, 9)}`,
    };
  }
  if (roll < 0.68) return { kind: "summary.resetCandidate" };
  if (roll < 0.72) {
    return {
      kind: "summary.invalidProbe",
      probe: rng.pick([
        "nanMetric",
        "infMetric",
        "evidenceClass",
        "metricsMismatch",
        "duplicateBench",
        "failedWithMetrics",
        "badGitSha",
        "extraKey",
        "emptyBenches",
        "inProcessExitCode",
        "badMetricKey",
        "negativeWallClock",
      ] as const),
    };
  }
  if (roll < 0.79) {
    return {
      kind: "tolerance.set",
      keyIndex: rng.int(0, 1_000),
      direction: rng.pick(DIRECTIONS),
      tolerance: rng.pick([0, 0.001, 0.01, 0.05, 1, 5, 50]),
    };
  }
  if (roll < 0.82) return { kind: "tolerance.remove", keyIndex: rng.int(0, 1_000) };
  if (roll < 0.84) {
    return { kind: "tolerance.setPolicy", policy: rng.pick(["informational", "fail"] as const) };
  }
  if (roll < 0.86) return { kind: "tolerance.setLost", lost: rng.bool() };
  if (roll < 0.88) {
    return {
      kind: "tolerance.invalidProbe",
      probe: rng.pick([
        "negativeTolerance",
        "nanTolerance",
        "badDirection",
        "emptyRationale",
        "badPolicy",
      ] as const),
    };
  }
  if (roll < 0.92) return { kind: "manifest.addCases", n: rng.int(1, 12), players: rng.int(1, 6) };
  if (roll < 0.93) return { kind: "manifest.setRatios", a: rng.float(0, 1), b: rng.float(0, 1) };
  if (roll < 0.95) {
    return {
      kind: "manifest.invalidProbe",
      probe: rng.pick([
        "syntheticProvenance",
        "badRatios",
        "duplicateCase",
        "badHash",
        "missingId",
      ] as const),
    };
  }
  if (roll < 0.98) return { kind: "swing.setOverrides", overrides: randomSwingOverrides(rng) };
  return { kind: "violations.select", count: rng.int(0, 6), includeUnknown: rng.bool(0.3) };
}

// ---------------------------------------------------------------------------
// Applying actions
// ---------------------------------------------------------------------------

function summaryOf(state: State, side: Side): RegressionSummary {
  return side === "baseline" ? state.baseline : state.candidate;
}

function hex(rng: SeededRng, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) out += rng.int(0, 15).toString(16);
  return out;
}

function metricKeys(state: State): string[] {
  return [
    ...new Set([...Object.keys(state.baseline.metrics), ...Object.keys(state.candidate.metrics)]),
  ].sort();
}

function resync(summary: RegressionSummary): void {
  summary.metrics = flattenBenchMetrics(summary.benches);
}

/** Applies one action. Probe actions assert their own expectation (I5). */
export function applyAction(state: State, action: Action, rng: SeededRng): void {
  switch (action.kind) {
    case "metrics.addClassification": {
      const labels = ["dink", "drive", "serve", "volley", "lob"].slice(0, action.alphabet);
      for (let index = 0; index < action.n; index += 1) {
        const truth = rng.pick(labels);
        const predicted = rng.bool(action.agree) ? truth : rng.pick(labels);
        state.classification.push({ truth, predicted });
      }
      return;
    }
    case "metrics.addPairs": {
      const base = state.pairs.length;
      for (let index = 0; index < action.n; index += 1) {
        const truth = round(rng.float(0, 100), 2);
        let predicted: number;
        switch (action.mode) {
          case "random":
            predicted = round(rng.float(0, 100), 2);
            break;
          case "constant":
            predicted = 42;
            break;
          case "linear":
            predicted = round(truth * 0.5 + 10, 4);
            break;
          case "ties":
            predicted = Math.round(truth / 25) * 25;
            break;
          case "anti":
            predicted = round(100 - truth, 2);
            break;
          case "large":
            predicted = round(rng.float(-1e6, 1e6), 1);
            break;
        }
        state.pairs.push({
          truth: action.mode === "ties" ? Math.round(truth / 25) * 25 : truth,
          predicted,
        });
      }
      assert(state.pairs.length === base + action.n, "I6.pairs", "pairs not appended");
      return;
    }
    case "metrics.addTiming": {
      for (let index = 0; index < action.n; index += 1) {
        const truthMs = rng.int(0, 10_000);
        state.timing.push({
          truthMs,
          predictedMs: round(truthMs + rng.float(-action.spread, action.spread), 1),
        });
      }
      return;
    }
    case "metrics.addCalibration": {
      for (let index = 0; index < action.n; index += 1) {
        let confidence: number;
        switch (action.mode) {
          case "uniform":
            confidence = round(rng.float(0, 1), 4);
            break;
          case "edges":
            confidence = rng.pick([0, 1, 0.1, 0.5, 0.9, 0.999999, 1e-9]);
            break;
          case "constant":
            confidence = 0.7;
            break;
        }
        state.calibration.push({ confidence, correct: rng.bool(confidence) });
      }
      return;
    }
    case "metrics.setBinCount":
      state.binCount = action.binCount;
      return;
    case "metrics.invalidCalibrationProbe": {
      const value =
        action.value === "nan"
          ? Number.NaN
          : action.value === "neg"
            ? -0.01
            : action.value === "over"
              ? 1.01
              : Number.POSITIVE_INFINITY;
      let threw = false;
      try {
        calibrationReport(
          [...state.calibration, { confidence: value, correct: true }],
          state.binCount,
        );
      } catch {
        threw = true;
      }
      assert(threw, "I5.calibration_confidence", `calibrationReport accepted confidence ${value}`);
      return;
    }
    case "metrics.clear":
      state[action.which] = [];
      return;
    case "summary.addBench": {
      const summary = summaryOf(state, action.side);
      const id = `stress_${action.benchKind === "subprocess" ? "sub" : "proc"}_${action.suffix}`;
      if (summary.benches.some((bench) => bench.id === id)) return;
      const metrics: Record<string, number | null> = {};
      for (let index = 0; index < action.metricCount; index += 1) {
        const isNull = action.nullEvery > 0 && index % action.nullEvery === action.nullEvery - 1;
        metrics[`m${index}`] = isNull ? null : round(rng.float(0, 100), 3);
      }
      summary.benches.push({
        id,
        title: `Stress ${id}`,
        kind: action.benchKind,
        command: action.benchKind === "subprocess" ? "tsx stress.ts" : "stress()",
        cwd: "packages/evaluation",
        status: "ok",
        exitCode: action.benchKind === "subprocess" ? 0 : null,
        wallClockMs: rng.int(0, 5_000),
        inputs: ["datasets/reports/regression/baseline.json"],
        caveats: [],
        error: null,
        metrics,
        labels: { stress: "true" },
      });
      resync(summary);
      return;
    }
    case "summary.setMetric": {
      const summary = summaryOf(state, action.side);
      const bench = summary.benches[action.benchIndex % summary.benches.length];
      if (!bench || bench.status === "failed") return;
      const keys = Object.keys(bench.metrics);
      const key =
        action.newKey || keys.length === 0
          ? `stress_metric_${action.keyIndex % 7}`
          : (keys[action.keyIndex % keys.length] as string);
      const other = summaryOf(state, action.side === "baseline" ? "candidate" : "baseline");
      const otherBench = other.benches.find((entry) => entry.id === bench.id);
      const reference = otherBench?.metrics[key] ?? bench.metrics[key] ?? null;
      const tolerance = state.config.metrics[`${bench.id}.${key}`]?.absoluteTolerance ?? 0;
      let next: number | null;
      switch (action.value) {
        case "null":
          next = null;
          break;
        case "same":
          next = reference;
          break;
        case "zero":
          next = 0;
          break;
        case "negative":
          next = -round(action.magnitude * 10, 3);
          break;
        case "nudge":
          next = (reference ?? 0) + (action.magnitude - 0.5) * tolerance;
          break;
        case "boundary":
          next = (reference ?? 0) + (action.magnitude < 0.5 ? tolerance : -tolerance);
          break;
        case "jump":
          next =
            (reference ?? 0) + (action.magnitude - 0.5) * 2 * Math.max(1, Math.abs(reference ?? 1));
          break;
      }
      bench.metrics[key] = next;
      resync(summary);
      return;
    }
    case "summary.dropMetric": {
      const summary = summaryOf(state, action.side);
      const bench = summary.benches[action.benchIndex % summary.benches.length];
      if (!bench) return;
      const keys = Object.keys(bench.metrics);
      if (keys.length === 0) return;
      delete bench.metrics[keys[action.keyIndex % keys.length] as string];
      resync(summary);
      return;
    }
    case "summary.failBench": {
      const summary = summaryOf(state, action.side);
      const bench = summary.benches[action.benchIndex % summary.benches.length];
      if (!bench) return;
      bench.status = "failed";
      bench.error = "stress: injected failure";
      bench.metrics = {};
      bench.labels = {};
      if (bench.kind === "subprocess") bench.exitCode = 1;
      resync(summary);
      return;
    }
    case "summary.removeBench": {
      const summary = summaryOf(state, action.side);
      if (summary.benches.length <= 1) return;
      summary.benches.splice(action.benchIndex % summary.benches.length, 1);
      resync(summary);
      return;
    }
    case "summary.setDirty":
      summaryOf(state, action.side).provenance.gitDirty = action.dirty;
      return;
    case "summary.setContractVersion":
      summaryOf(state, action.side).contractVersion = action.version;
      return;
    case "summary.setRunner":
      summaryOf(state, action.side).runner.node = action.node;
      return;
    case "summary.setModelVersion":
      summaryOf(state, action.side).provenance.modelVersions[action.key] = action.value;
      return;
    case "summary.resetCandidate":
      state.candidate = clone(state.baseline);
      return;
    case "summary.invalidProbe":
      runSummaryProbe(state, action.probe);
      return;
    case "tolerance.set": {
      const keys = metricKeys(state);
      if (keys.length === 0) return;
      const key = keys[action.keyIndex % keys.length] as string;
      state.config.metrics[key] = {
        direction: action.direction,
        absoluteTolerance: action.tolerance,
        rationale: "stress-set tolerance",
      };
      return;
    }
    case "tolerance.remove": {
      const keys = Object.keys(state.config.metrics).sort();
      if (keys.length === 0) return;
      delete state.config.metrics[keys[action.keyIndex % keys.length] as string];
      return;
    }
    case "tolerance.setPolicy":
      state.config.unlistedMetricPolicy = action.policy;
      return;
    case "tolerance.setLost":
      state.config.lostMeasurementIsRegression = action.lost;
      return;
    case "tolerance.invalidProbe":
      runToleranceProbe(state, action.probe);
      return;
    case "manifest.addCases": {
      for (let index = 0; index < action.n; index += 1) {
        const ordinal = state.manifest.cases.length;
        state.manifest.cases.push({
          caseId: `stress-case-${ordinal}`,
          videoSha256: hex(rng, 64),
          poseSequenceSha256: hex(rng, 64),
          playerId: `player-${rng.int(0, action.players - 1)}`,
          declaredStroke: state.strokePlaceholder,
          annotationPath: `stress/annotations/${ordinal}.json`,
        });
      }
      return;
    }
    case "manifest.setRatios": {
      const cut1 = Math.min(action.a, action.b);
      const cut2 = Math.max(action.a, action.b);
      const train = round(cut1, 6);
      const val = round(cut2 - cut1, 6);
      const test = round(1 - train - val, 6);
      state.manifest.splitRatios = { train, val, test };
      return;
    }
    case "manifest.invalidProbe":
      runManifestProbe(state, action.probe, rng);
      return;
    case "swing.setOverrides":
      state.swing = action.overrides;
      return;
    case "violations.select": {
      const keys = metricKeys(state);
      const chosen = new Set<string>();
      for (let index = 0; index < action.count && keys.length > 0; index += 1) {
        chosen.add(keys[rng.int(0, keys.length - 1)] as string);
      }
      if (action.includeUnknown) chosen.add("stress.unknown_metric");
      state.mustNotDegrade = [...chosen].sort();
      return;
    }
  }
}

function expectInvalid(
  result: { ok: true } | { ok: false; failure: { code: string; message: string } },
  invariant: string,
  probe: string,
  codes: readonly string[],
): void {
  assert(!result.ok, invariant, `${probe}: validator accepted an invalid document`);
  if (!result.ok) {
    assert(
      codes.includes(result.failure.code),
      invariant,
      `${probe}: rejected with unexpected code ${result.failure.code} (${result.failure.message}); expected one of ${codes.join(", ")}`,
    );
  }
}

function runSummaryProbe(
  state: State,
  probe: Extract<Action, { kind: "summary.invalidProbe" }>["probe"],
): void {
  const raw = clone(state.candidate) as unknown as Record<string, unknown>;
  const benches = raw.benches as Array<Record<string, unknown>>;
  const first = benches[0] as Record<string, unknown>;
  const firstMetrics = first.metrics as Record<string, unknown>;
  const flat = raw.metrics as Record<string, unknown>;
  const firstId = first.id as string;
  let codes: string[];
  switch (probe) {
    case "nanMetric":
      // JSON cannot carry NaN, so the probe mutates the in-memory object.
      firstMetrics.stress_nan = Number.NaN;
      flat[`${firstId}.stress_nan`] = Number.NaN;
      if (first.status === "failed") codes = ["metric_value", "bench_failed_metrics"];
      else codes = ["metric_value"];
      break;
    case "infMetric":
      firstMetrics.stress_inf = Number.POSITIVE_INFINITY;
      flat[`${firstId}.stress_inf`] = Number.POSITIVE_INFINITY;
      codes =
        first.status === "failed" ? ["metric_value", "bench_failed_metrics"] : ["metric_value"];
      break;
    case "evidenceClass":
      (raw.provenance as Record<string, unknown>).evidenceClass = "apple_device_truth";
      codes = ["provenance_evidence_class"];
      break;
    case "metricsMismatch":
      flat["stress_phantom.metric"] = 1;
      codes = ["summary_metrics_mismatch"];
      break;
    case "duplicateBench":
      benches.push(clone(first));
      codes = ["summary_bench_duplicate"];
      break;
    case "failedWithMetrics":
      first.status = "failed";
      first.error = "stress";
      if (first.kind === "subprocess") first.exitCode = 1;
      if (Object.keys(firstMetrics).length === 0) {
        firstMetrics.stress = 1;
        flat[`${firstId}.stress`] = 1;
      }
      codes = ["bench_failed_metrics"];
      break;
    case "badGitSha":
      (raw.provenance as Record<string, unknown>).gitSha = "1fb0efd7";
      codes = ["provenance_git_sha"];
      break;
    case "extraKey":
      raw.stressExtra = true;
      codes = ["summary_unknown_key"];
      break;
    case "emptyBenches":
      raw.benches = [];
      codes = ["summary_benches_empty"];
      break;
    case "inProcessExitCode":
      first.kind = "in_process";
      first.exitCode = 0;
      codes = ["bench_exit_code"];
      break;
    case "badMetricKey":
      firstMetrics["bad key!"] = 1;
      flat[`${firstId}.bad key!`] = 1;
      codes = first.status === "failed" ? ["metric_key", "bench_failed_metrics"] : ["metric_key"];
      break;
    case "negativeWallClock":
      first.wallClockMs = -1;
      codes = ["bench_wall_clock"];
      break;
  }
  expectInvalid(validateRegressionSummary(raw), "I5.summary_probe", probe, codes);
}

function runToleranceProbe(
  state: State,
  probe: Extract<Action, { kind: "tolerance.invalidProbe" }>["probe"],
): void {
  const raw = clone(state.config) as unknown as Record<string, unknown>;
  const metrics = raw.metrics as Record<string, Record<string, unknown>>;
  let codes: string[];
  switch (probe) {
    case "negativeTolerance":
      metrics["stress.neg"] = {
        direction: "higher_is_better",
        absoluteTolerance: -1,
        rationale: "x",
      };
      codes = ["tolerance_value"];
      break;
    case "nanTolerance":
      metrics["stress.nan"] = {
        direction: "higher_is_better",
        absoluteTolerance: Number.NaN,
        rationale: "x",
      };
      codes = ["tolerance_value"];
      break;
    case "badDirection":
      metrics["stress.dir"] = { direction: "sideways", absoluteTolerance: 0, rationale: "x" };
      codes = ["tolerance_direction"];
      break;
    case "emptyRationale":
      metrics["stress.rat"] = {
        direction: "lower_is_better",
        absoluteTolerance: 0,
        rationale: "   ",
      };
      codes = ["tolerance_rationale"];
      break;
    case "badPolicy":
      raw.unlistedMetricPolicy = "ignore";
      codes = ["tolerances_unlisted_policy"];
      break;
  }
  expectInvalid(validateToleranceConfig(raw), "I5.tolerance_probe", probe, codes);
}

function runManifestProbe(
  state: State,
  probe: Extract<Action, { kind: "manifest.invalidProbe" }>["probe"],
  rng: SeededRng,
): void {
  const raw = clone(state.manifest) as unknown as Record<string, unknown>;
  const cases = raw.cases as Array<Record<string, unknown>>;
  const template: RealBenchmarkCase = {
    caseId: "stress-probe",
    videoSha256: hex(rng, 64),
    poseSequenceSha256: hex(rng, 64),
    playerId: "player-probe",
    declaredStroke: state.strokePlaceholder,
    annotationPath: "stress/probe.json",
  };
  let codes: string[];
  switch (probe) {
    case "syntheticProvenance":
      raw.provenance = "synthetic";
      codes = ["real_benchmark.invalid_provenance"];
      break;
    case "badRatios":
      raw.splitRatios = { train: 0.7, val: 0.2, test: 0.2 };
      codes = ["real_benchmark.invalid_split"];
      break;
    case "duplicateCase":
      cases.push({ ...template }, { ...template });
      codes = ["real_benchmark.duplicate_case"];
      break;
    case "badHash":
      cases.push({ ...template, videoSha256: "not-a-sha" });
      codes = ["real_benchmark.corrupt_case"];
      break;
    case "missingId":
      raw.id = "";
      codes = ["real_benchmark.missing_id"];
      break;
  }
  expectInvalid(validateRealBenchmarkManifest(raw), "I5.manifest_probe", probe, codes);
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function walkNumbers(
  value: unknown,
  path: string,
  onNumber: (n: number, at: string) => void,
): void {
  if (typeof value === "number") {
    onNumber(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkNumbers(item, `${path}[${index}]`, onNumber));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      walkNumbers(item, `${path}.${key}`, onNumber);
    }
  }
}

function assertAllFinite(value: unknown, where: string): void {
  walkNumbers(value, where, (n, at) => {
    assert(Number.isFinite(n), "I1.finite", `non-finite number ${String(n)} at ${at}`);
  });
}

function inUnit(value: number | null, slack = 1e-9): boolean {
  return value === null || (value >= -slack && value <= 1 + slack);
}

function checkMetrics(state: State, rng: SeededRng): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // classificationReport ----------------------------------------------------
  const report = classificationReport(state.classification);
  assertAllFinite(report, "classificationReport");
  assert(
    report.caseCount === state.classification.length,
    "I6.classification.n",
    "caseCount mismatch",
  );
  assert(
    inUnit(report.accuracy),
    "I6.classification.accuracy",
    `accuracy ${report.accuracy} outside [0,1]`,
  );
  assert(
    inUnit(report.macroF1),
    "I6.classification.macroF1",
    `macroF1 ${report.macroF1} outside [0,1]`,
  );
  let supportSum = 0;
  let confusionSum = 0;
  for (const entry of report.perClass) {
    supportSum += entry.support;
    assert(
      inUnit(entry.precision) && inUnit(entry.recall) && inUnit(entry.f1),
      "I6.classification.perClass",
      `per-class rate outside [0,1] for ${entry.label}`,
      entry,
    );
    assert(
      (entry.precision === null) === !state.classification.some((c) => c.predicted === entry.label),
      "I6.classification.precision_null",
      `precision null-ness wrong for ${entry.label}`,
    );
    assert(
      (entry.recall === null) === (entry.support === 0),
      "I6.classification.recall_null",
      `recall null-ness wrong for ${entry.label}`,
    );
  }
  for (const row of Object.values(report.confusion)) {
    for (const n of Object.values(row)) confusionSum += n;
  }
  assert(
    supportSum === report.caseCount,
    "I6.classification.support",
    `support sum ${supportSum} != ${report.caseCount}`,
  );
  assert(
    confusionSum === report.caseCount,
    "I6.classification.confusion",
    `confusion sum ${confusionSum} != ${report.caseCount}`,
  );
  const labels = report.perClass.map((entry) => entry.label);
  assert(
    labels.join() === [...labels].sort().join(),
    "I6.classification.sorted",
    "perClass not sorted by label",
  );
  const shuffled = classificationReport(rng.shuffle(state.classification));
  assert(
    canonicalJson(shuffled) === canonicalJson(report),
    "I6.classification.order_invariant",
    "classificationReport depends on case order",
  );
  out.classification = report;

  // timingReport ------------------------------------------------------------
  const timing = timingReport(state.timing);
  const within = [0, 10, 50, 100, 500, 1_000, Number.POSITIVE_INFINITY].map((t) =>
    timing.withinTolerance(t),
  );
  assertAllFinite(
    { mean: timing.meanAbsoluteErrorMs, median: timing.medianAbsoluteErrorMs, within },
    "timingReport",
  );
  assert(timing.caseCount === state.timing.length, "I6.timing.n", "caseCount mismatch");
  assert(
    timing.meanAbsoluteErrorMs >= 0 && timing.medianAbsoluteErrorMs >= 0,
    "I6.timing.nonnegative",
    "negative error",
  );
  for (let index = 1; index < within.length; index += 1) {
    assert(
      (within[index] as number) >= (within[index - 1] as number),
      "I6.timing.monotone",
      "withinTolerance not monotone in tolerance",
      within,
    );
  }
  assert(
    within.every((w) => inUnit(w)),
    "I6.timing.unit",
    "withinTolerance outside [0,1]",
    within,
  );
  assert(
    within[within.length - 1] === (state.timing.length === 0 ? 0 : 1),
    "I6.timing.infinite",
    "withinTolerance(Infinity) must be 1 for non-empty input (0 when empty)",
  );
  if (state.timing.length > 0) {
    const errors = state.timing.map((c) => Math.abs(c.predictedMs - c.truthMs));
    const lo = Math.min(...errors);
    const hi = Math.max(...errors);
    assert(
      timing.medianAbsoluteErrorMs >= lo - 1e-9 && timing.medianAbsoluteErrorMs <= hi + 1e-9,
      "I6.timing.median_bounds",
      "median outside [min,max]",
    );
    assert(
      timing.meanAbsoluteErrorMs >= lo - 1e-9 && timing.meanAbsoluteErrorMs <= hi + 1e-9,
      "I6.timing.mean_bounds",
      "mean outside [min,max]",
    );
  }
  out.timing = { ...timing, within };

  // paired scores -----------------------------------------------------------
  const mae = meanAbsoluteError(state.pairs);
  const pearson = pearsonCorrelation(state.pairs);
  const spearman = spearmanCorrelation(state.pairs);
  assertAllFinite({ mae, pearson, spearman }, "pairedScores");
  assert(mae >= 0, "I6.pairs.mae", `negative MAE ${mae}`);
  assert(
    pearson === null || Math.abs(pearson) <= 1 + 1e-9,
    "I6.pairs.pearson_bound",
    `pearson ${pearson} outside [-1,1]`,
  );
  assert(
    spearman === null || Math.abs(spearman) <= 1 + 1e-9,
    "I6.pairs.spearman_bound",
    `spearman ${spearman} outside [-1,1]`,
  );
  if (state.pairs.length < 2) {
    assert(
      pearson === null && spearman === null,
      "I6.pairs.small_n",
      "correlation must be null for n < 2",
    );
  }
  const swapped = pearsonCorrelation(
    state.pairs.map((p) => ({ truth: p.predicted, predicted: p.truth })),
  );
  assert(
    (pearson === null && swapped === null) ||
      (pearson !== null && swapped !== null && Math.abs(pearson - swapped) < 1e-9),
    "I6.pairs.pearson_symmetric",
    `pearson not symmetric: ${pearson} vs ${swapped}`,
  );
  const monotone = spearmanCorrelation(
    state.pairs.map((p) => ({ truth: p.truth, predicted: 2 * p.predicted + 1 })),
  );
  assert(
    (spearman === null && monotone === null) ||
      (spearman !== null && monotone !== null && Math.abs(spearman - monotone) < 1e-9),
    "I6.pairs.spearman_monotone",
    `spearman changed under a monotone transform: ${spearman} vs ${monotone}`,
  );
  out.pairs = { mae, pearson, spearman };

  // calibrationReport -------------------------------------------------------
  const calibration = calibrationReport(state.calibration, state.binCount);
  assertAllFinite(calibration, "calibrationReport");
  assert(calibration.n === state.calibration.length, "I6.calibration.n", "n mismatch");
  assert(
    inUnit(calibration.expectedCalibrationError),
    "I6.calibration.ece",
    `ECE ${calibration.expectedCalibrationError} outside [0,1]`,
  );
  assert(calibration.bins.length === state.binCount, "I6.calibration.bins", "bin count mismatch");
  let binTotal = 0;
  for (const bin of calibration.bins) {
    binTotal += bin.count;
    assert(bin.lower < bin.upper, "I6.calibration.bin_edges", "bin edges not increasing", bin);
    if (bin.count > 0) {
      assert(
        bin.meanConfidence >= bin.lower - 1e-9 && bin.meanConfidence <= bin.upper + 1e-9,
        "I6.calibration.bin_mean",
        `meanConfidence ${bin.meanConfidence} outside bin [${bin.lower}, ${bin.upper}]`,
      );
      assert(
        inUnit(bin.empiricalAccuracy),
        "I6.calibration.bin_accuracy",
        "empiricalAccuracy outside [0,1]",
      );
    } else {
      assert(
        bin.meanConfidence === 0 && bin.empiricalAccuracy === 0,
        "I6.calibration.empty_bin",
        "empty bin must report 0/0",
      );
    }
  }
  assert(
    binTotal === calibration.n,
    "I6.calibration.bin_total",
    `bin counts ${binTotal} != n ${calibration.n}`,
  );
  const distinct = new Set(state.calibration.map((c) => c.confidence)).size;
  const expectWarnings =
    (calibration.n === 0 ? 1 : 0) +
    (calibration.n > 0 && calibration.n < CALIBRATION_MIN_SAMPLES ? 1 : 0) +
    (calibration.n > 0 && distinct === 1 ? 1 : 0);
  assert(
    calibration.warnings.length === expectWarnings,
    "I6.calibration.warnings",
    `expected ${expectWarnings} warnings, got ${calibration.warnings.length}`,
    calibration.warnings,
  );
  out.calibration = calibration;

  return out;
}

/** Independent re-derivation of the per-metric table in compare.ts (doc comment lines 4-17). */
function oracleMetric(
  baseline: number | null | undefined,
  candidate: number | null | undefined,
  tolerance: MetricTolerance | null,
  config: ToleranceConfig,
): { status: MetricComparisonStatus; failing: boolean } {
  const informational = tolerance?.direction === "informational";
  const judged = tolerance ? !informational : config.unlistedMetricPolicy === "fail";
  if (baseline === undefined) return { status: "missing_in_baseline", failing: false };
  if (candidate === undefined) return { status: "missing_in_candidate", failing: judged };
  if (baseline === null && candidate === null) return { status: "unmeasured_both", failing: false };
  if (baseline === null) return { status: "newly_measured", failing: false };
  if (candidate === null) {
    return { status: "measurement_lost", failing: judged && config.lostMeasurementIsRegression };
  }
  if (!tolerance) {
    return config.unlistedMetricPolicy === "fail"
      ? { status: "unlisted", failing: true }
      : { status: "informational", failing: false };
  }
  if (informational) return { status: "informational", failing: false };
  const delta = candidate - baseline;
  if (delta === 0) return { status: "unchanged", failing: false };
  if (Math.abs(delta) <= tolerance.absoluteTolerance)
    return { status: "within_tolerance", failing: false };
  const good = tolerance.direction === "higher_is_better" ? delta > 0 : delta < 0;
  return good ? { status: "improved", failing: false } : { status: "regressed", failing: true };
}

function checkSummaries(state: State): Record<string, unknown> {
  for (const side of ["baseline", "candidate"] as const) {
    const summary = summaryOf(state, side);
    assert(
      canonicalJson(summary.metrics) === canonicalJson(flattenBenchMetrics(summary.benches)),
      "I4.flatten",
      `${side}.metrics != flattenBenchMetrics(benches)`,
    );
    const roundTrip = validateRegressionSummary(JSON.parse(JSON.stringify(summary)));
    assert(
      roundTrip.ok,
      "I4.roundtrip",
      `${side} failed validation after JSON round-trip: ${roundTrip.ok ? "" : roundTrip.failure.message}`,
    );
    if (roundTrip.ok) {
      assert(
        canonicalJson(roundTrip.value) === canonicalJson(summary),
        "I4.roundtrip_identity",
        `${side} changed through validate()`,
      );
    }
    assertAllFinite(summary, `${side}.summary`);
  }
  const configRoundTrip = validateToleranceConfig(JSON.parse(JSON.stringify(state.config)));
  assert(
    configRoundTrip.ok,
    "I4.config_roundtrip",
    `tolerance config failed validation: ${configRoundTrip.ok ? "" : configRoundTrip.failure.message}`,
  );

  const report = compareSummaries(state.baseline, state.candidate, state.config);
  const again = compareSummaries(state.baseline, state.candidate, state.config);
  assert(
    canonicalJson(report) === canonicalJson(again),
    "I9.compare_deterministic",
    "compareSummaries is not deterministic",
  );
  assertAllFinite(report, "compareReport");

  const diffs = identityDifferences(state.baseline, state.candidate, state.config);
  const nonComparable = diffs.some((d) => d.severity === "non_comparable");
  const expectNonComparable =
    state.baseline.contractVersion !== state.candidate.contractVersion ||
    state.config.contractVersion !== state.candidate.contractVersion ||
    state.baseline.provenance.evidenceClass !== state.candidate.provenance.evidenceClass;
  assert(
    nonComparable === expectNonComparable,
    "I3.non_comparable",
    `non_comparable=${nonComparable} expected ${expectNonComparable}`,
    diffs,
  );
  assert(
    report.comparable === !nonComparable,
    "I3.comparable",
    "comparable flag disagrees with identity differences",
  );
  assert([0, 1, 3].includes(report.exitCode), "I3.exit_domain", `exit code ${report.exitCode}`);
  assert((report.exitCode === 3) === !report.comparable, "I3.exit3", "exit 3 ⇔ non-comparable");

  const text = formatCompareReport(state.baseline, state.candidate, report);
  assert(
    !/\bNaN\b|Infinity|undefined/.test(text),
    "I1.format",
    "formatted report contains NaN/Infinity/undefined",
  );
  const expectResult =
    report.exitCode === 3
      ? "NON-COMPARABLE (exit 3)"
      : report.exitCode === 1
        ? "(exit 1)"
        : "(exit 0)";
  assert(
    text.includes(expectResult),
    "I3.format_result",
    `RESULT line does not match exit code ${report.exitCode}`,
  );

  if (report.comparable) {
    assert(
      (report.exitCode === 1) === report.regressions.length > 0,
      "I3.exit1",
      "exit 1 ⇔ regressions",
    );
    const benchFailing = report.benches.filter((b) => b.failing).length;
    const metricFailing = report.metrics.filter((m) => m.failing).length;
    assert(
      report.regressions.length === benchFailing + metricFailing,
      "I3.regressions_count",
      "regressions list != failing benches + failing metrics",
    );
    const unionKeys = [
      ...new Set([...Object.keys(state.baseline.metrics), ...Object.keys(state.candidate.metrics)]),
    ].sort();
    assert(
      report.metrics.map((m) => m.metric).join("\n") === unionKeys.join("\n"),
      "I3.metric_keys",
      "metric key set/order != sorted union",
    );
    let countSum = 0;
    for (const n of Object.values(report.counts)) countSum += n;
    assert(
      countSum === report.metrics.length,
      "I3.counts_sum",
      "counts do not sum to metric count",
    );
    const benchStatus = new Map(report.benches.map((b) => [b.benchId, b.status]));
    for (const metric of report.metrics) {
      const base =
        metric.metric in state.baseline.metrics ? state.baseline.metrics[metric.metric] : undefined;
      const cand =
        metric.metric in state.candidate.metrics
          ? state.candidate.metrics[metric.metric]
          : undefined;
      const expected = oracleMetric(
        base,
        cand,
        state.config.metrics[metric.metric] ?? null,
        state.config,
      );
      const benchId = metric.metric.slice(0, metric.metric.indexOf("."));
      const bench = benchStatus.get(benchId);
      if (
        expected.status === "missing_in_candidate" &&
        (bench === "failed_in_candidate" ||
          bench === "failed_in_both" ||
          bench === "missing_in_candidate")
      ) {
        expected.failing = false;
      }
      assert(
        metric.status === expected.status,
        "I3.metric_status",
        `${metric.metric}: status ${metric.status}, oracle ${expected.status}`,
        metric,
      );
      assert(
        metric.failing === expected.failing,
        "I3.metric_failing",
        `${metric.metric}: failing ${metric.failing}, oracle ${expected.failing}`,
        metric,
      );
      if (metric.tolerance?.direction === "informational") {
        assert(
          !metric.failing,
          "I3.informational_never_fails",
          `${metric.metric} informational but failing`,
        );
      }
      if (base === undefined || cand === undefined) {
        assert(
          metric.delta === null,
          "I2.missing_delta",
          `${metric.metric}: delta for a missing metric must be null`,
        );
      } else if (base === null || cand === null) {
        assert(
          metric.delta === null &&
            ["measurement_lost", "newly_measured", "unmeasured_both"].includes(metric.status),
          "I2.abstention",
          `${metric.metric}: null measurement coerced (status ${metric.status}, delta ${String(metric.delta)})`,
        );
      }
      if (typeof base === "number" && typeof cand === "number") {
        assert(
          metric.delta === cand - base,
          "I3.delta",
          `${metric.metric}: delta ${String(metric.delta)} != ${cand - base}`,
        );
      }
    }
    for (const bench of report.benches) {
      const a = state.baseline.benches.find((b) => b.id === bench.benchId);
      const b = state.candidate.benches.find((entry) => entry.id === bench.benchId);
      const expectedStatus = !b
        ? "missing_in_candidate"
        : !a
          ? "new_in_candidate"
          : a.status === "failed" && b.status === "failed"
            ? "failed_in_both"
            : b.status === "failed"
              ? "failed_in_candidate"
              : a.status === "failed"
                ? "failed_in_baseline"
                : "ok";
      assert(
        bench.status === expectedStatus,
        "I3.bench_status",
        `${bench.benchId}: ${bench.status} expected ${expectedStatus}`,
      );
      const expectedFailing =
        expectedStatus === "missing_in_candidate" ||
        expectedStatus === "failed_in_both" ||
        expectedStatus === "failed_in_candidate" ||
        (expectedStatus === "new_in_candidate" && b?.status === "failed");
      assert(
        bench.failing === expectedFailing,
        "I3.bench_failing",
        `${bench.benchId}: failing ${bench.failing} expected ${expectedFailing}`,
      );
    }
    // A summary compared with itself never regresses on metrics that are listed.
    const self = compareSummaries(state.candidate, state.candidate, state.config);
    const selfFailing = self.metrics.filter((m) => m.failing);
    assert(
      selfFailing.every((m) => m.status === "unlisted"),
      "I3.self_compare",
      "self-comparison reports a failing listed metric",
      selfFailing,
    );
    assert(
      self.metrics.every((m) =>
        ["unchanged", "unmeasured_both", "informational", "unlisted"].includes(m.status),
      ),
      "I3.self_compare_status",
      "self-comparison produced a delta status",
      self.counts,
    );
  }

  // regressionViolations (benchmark.ts) -------------------------------------
  const asReport = (summary: RegressionSummary): BenchmarkReport => ({
    benchmark: {
      id: summary.runId,
      version: String(summary.contractVersion),
      task: "regression",
      provenance: "synthetic",
      caseCount: summary.benches.length,
      notes: "stress",
    },
    evaluatedAtIso: summary.generatedAtIso,
    subject: "stress@1",
    metrics: summary.metrics,
    abstainedCaseIds: Object.entries(summary.metrics)
      .filter(([, v]) => v === null)
      .map(([k]) => k),
  });
  const baselineReport = asReport(state.baseline);
  const candidateReport = asReport(state.candidate);
  const violations = regressionViolations(baselineReport, candidateReport, state.mustNotDegrade);
  const banner = reportBanner(baselineReport);
  assert(
    banner.startsWith("[SYNTHETIC]"),
    "I8.banner",
    "synthetic report banner must be tagged SYNTHETIC",
  );
  for (const violation of violations) {
    assert(
      state.mustNotDegrade.includes(violation.metric),
      "I3.violations_subset",
      `violation for unlisted metric ${violation.metric}`,
    );
    assert(
      typeof baselineReport.metrics[violation.metric] === "number",
      "I3.violations_baseline",
      `violation on non-numeric baseline ${violation.metric}`,
    );
    const next = candidateReport.metrics[violation.metric];
    if (typeof next === "number") {
      assert(
        Number.isFinite(violation.candidate) && next < violation.baseline - 1e-9,
        "I3.violations_numeric",
        `violation without degradation for ${violation.metric}`,
        violation,
      );
    } else {
      // Documented sentinel (benchmark.ts:78): a missing candidate is reported as NaN.
      assert(
        Number.isNaN(violation.candidate),
        "I3.violations_sentinel",
        `expected NaN sentinel for missing candidate ${violation.metric}`,
      );
    }
  }
  for (const metric of state.mustNotDegrade) {
    const base = baselineReport.metrics[metric];
    const next = candidateReport.metrics[metric];
    const shouldViolate =
      typeof base === "number" && (typeof next !== "number" || next < base - 1e-9);
    assert(
      violations.some((v) => v.metric === metric) === shouldViolate,
      "I3.violations_complete",
      `violation presence wrong for ${metric}`,
      { base, next },
    );
  }

  return {
    exitCode: report.exitCode,
    counts: report.counts,
    regressions: report.regressions,
    warnings: report.warnings.length,
    violations: violations.map((v) => ({ metric: v.metric, missing: Number.isNaN(v.candidate) })),
    identity: diffs,
  };
}

function checkManifest(state: State, rng: SeededRng): Record<string, unknown> {
  const validated = validateRealBenchmarkManifest(JSON.parse(JSON.stringify(state.manifest)));
  assert(
    validated.ok,
    "I5.manifest_valid",
    `legal manifest rejected: ${validated.ok ? "" : validated.failure.message}`,
  );
  assert(
    state.manifest.provenance !== ("synthetic" as string),
    "I7.provenance",
    "manifest provenance drifted to synthetic",
  );
  assert(
    BENCHMARK_PROVENANCES.includes(state.manifest.provenance),
    "I7.provenance_domain",
    "unknown provenance",
  );
  const splits = assignSplits(state.manifest);
  const byPlayer = new Map<string, string>();
  for (const entry of splits) {
    assert(
      ["train", "val", "test"].includes(entry.split),
      "I7.split_domain",
      `split ${entry.split}`,
    );
    const direct = splitForPlayer(state.manifest.id, entry.playerId, state.manifest.splitRatios);
    assert(
      direct === entry.split,
      "I7.split_direct",
      `assignSplits != splitForPlayer for ${entry.caseId}`,
    );
    const seen = byPlayer.get(entry.playerId);
    assert(
      seen === undefined || seen === entry.split,
      "I7.player_grouped",
      `player ${entry.playerId} in two splits`,
    );
    byPlayer.set(entry.playerId, entry.split);
  }
  const shuffled = assignSplits({ ...state.manifest, cases: rng.shuffle(state.manifest.cases) });
  const shuffledMap = new Map(shuffled.map((entry) => [entry.caseId, entry.split]));
  for (const entry of splits) {
    assert(
      shuffledMap.get(entry.caseId) === entry.split,
      "I7.order_invariant",
      `split of ${entry.caseId} depends on case order`,
    );
  }
  for (const player of byPlayer.keys()) {
    assert(
      splitForPlayer(state.manifest.id, player, { train: 1, val: 0, test: 0 }) === "train",
      "I7.all_train",
      "ratio {1,0,0} must yield train",
    );
    assert(
      splitForPlayer(state.manifest.id, player, { train: 0, val: 0, test: 1 }) === "test",
      "I7.all_test",
      "ratio {0,0,1} must yield test",
    );
    assert(
      splitForPlayer(state.manifest.id, player, { train: 0, val: 1, test: 0 }) === "val",
      "I7.all_val",
      "ratio {0,1,0} must yield val",
    );
  }
  return {
    cases: splits.length,
    players: byPlayer.size,
    splits: splits.map((entry) => entry.split),
  };
}

function checkSwing(state: State): Record<string, unknown> {
  const swing = generateSwing(state.swing);
  const again = generateSwing(state.swing);
  assert(
    canonicalJson(swing) === canonicalJson(again),
    "I9.swing_deterministic",
    "generateSwing is not deterministic",
  );
  assertAllFinite(swing, "generateSwing");
  assert(swing.frames.length > 0, "I8.frames", "no frames generated");
  let previous = -1;
  for (const [index, frame] of swing.frames.entries()) {
    assert(
      frame.timestampMs >= previous,
      "I8.monotone_time",
      `timestamps not monotone at frame ${index}`,
    );
    previous = frame.timestampMs;
    assert(
      frame.landmarks.length === 13,
      "I8.landmarks",
      `frame ${index} has ${frame.landmarks.length} landmarks`,
    );
    for (const mark of frame.landmarks) {
      assert(
        mark.x > -1 && mark.x < 2 && mark.y > -1 && mark.y < 2,
        "I8.landmark_bounds",
        `landmark ${mark.name} at (${mark.x}, ${mark.y}) far outside the image`,
        { frame: index },
      );
    }
  }
  const truth = {
    readyMs: 400,
    backswingMs: 450,
    accelerateMs: 250,
    followMs: 320,
    recoverMs: 550,
    fps: 60,
    ...state.swing,
  };
  const durationMs =
    truth.readyMs + truth.backswingMs + truth.accelerateMs + truth.followMs + truth.recoverMs;
  assert(
    swing.clip.durationMs === durationMs,
    "I8.duration",
    `clip.durationMs ${swing.clip.durationMs} != ${durationMs}`,
  );
  assert(
    swing.window.peakMs === truth.readyMs + truth.backswingMs + truth.accelerateMs,
    "I8.peak",
    "window.peakMs != contact instant",
  );
  assert(
    swing.window.startMs === 0 && swing.window.endMs === durationMs,
    "I8.window",
    "window bounds",
  );
  const expectedFrames = Math.floor(durationMs / (1000 / truth.fps)) + 1;
  assert(
    Math.abs(swing.frames.length - expectedFrames) <= 1,
    "I8.frame_count",
    `frames ${swing.frames.length} vs expected ${expectedFrames}`,
  );
  assert(
    (swing.frames[swing.frames.length - 1] as { timestampMs: number }).timestampMs <= durationMs,
    "I8.last_frame",
    "last frame after clip end",
  );

  const sequence = generateSwingSequence(state.swing);
  assert(
    canonicalJson(sequence.sequence.producedBy) === canonicalJson(SYNTHETIC_PRODUCER),
    "I8.provenance",
    "sequence not stamped with SYNTHETIC_PRODUCER",
  );
  assert(
    sequence.sequence.frames.length === swing.frames.length,
    "I8.sequence_frames",
    "sequence frame count != skeleton frame count",
  );
  sequence.sequence.frames.forEach((frame, index) => {
    assert(
      frame.frameIndex === index,
      "I8.frame_index",
      `frameIndex ${frame.frameIndex} at ${index}`,
    );
  });
  assertAllFinite(sequence, "generateSwingSequence");

  const mirrored = mirrorFrames(swing.frames);
  const back = mirrorFrames(mirrored);
  assert(mirrored.length === swing.frames.length, "I8.mirror_length", "mirror changed frame count");
  swing.frames.forEach((frame, index) => {
    const m = mirrored[index] as typeof frame;
    const b = back[index] as typeof frame;
    frame.landmarks.forEach((mark, markIndex) => {
      const mm = m.landmarks[markIndex] as typeof mark;
      const bb = b.landmarks[markIndex] as typeof mark;
      assert(
        Math.abs(mm.x - (1 - mark.x)) < 1e-12 && mm.y === mark.y,
        "I8.mirror_x",
        `mirror x wrong for ${mark.name}`,
      );
      const swappedName = mark.name.startsWith("left_")
        ? mark.name.replace("left_", "right_")
        : mark.name.startsWith("right_")
          ? mark.name.replace("right_", "left_")
          : mark.name;
      assert(mm.name === swappedName, "I8.mirror_name", `mirror name ${mm.name} for ${mark.name}`);
      assert(
        bb.name === mark.name && Math.abs(bb.x - mark.x) < 1e-12 && bb.y === mark.y,
        "I8.mirror_involution",
        `mirror∘mirror != id for ${mark.name}`,
      );
    });
  });
  return {
    frames: swing.frames.length,
    peakMs: swing.window.peakMs,
    firstWrist: swing.frames[0]?.landmarks[10],
  };
}

/** Runs every invariant and returns a digestable snapshot of the outputs. */
export function checkInvariants(state: State, rng: SeededRng): Record<string, unknown> {
  return {
    metrics: checkMetrics(state, rng),
    summaries: checkSummaries(state),
    manifest: checkManifest(state, rng),
    swing: checkSwing(state),
  };
}

// ---------------------------------------------------------------------------
// Sequence execution
// ---------------------------------------------------------------------------

export interface StepTrace {
  step: number;
  action: string;
  digest: string;
}

export interface SequenceOutcome {
  seed: number;
  start: "committed" | "minimal";
  length: number;
  ok: boolean;
  steps: number;
  trace: StepTrace[];
  traceDigest: string;
  failure: null | {
    step: number;
    action: Action;
    invariant: string;
    message: string;
    detail: unknown;
    stack: string | null;
  };
}

export function executeSequence(
  seed: number,
  start: "committed" | "minimal",
  steps: readonly Step[],
): SequenceOutcome {
  const state = initialState(start);
  const trace: StepTrace[] = [];
  let failure: SequenceOutcome["failure"] = null;
  for (const [index, step] of steps.entries()) {
    try {
      applyAction(state, step.action, new SeededRng(step.rngSeed));
      const snapshot = checkInvariants(state, new SeededRng((step.rngSeed ^ 0x5bd1e995) >>> 0));
      trace.push({ step: index, action: step.action.kind, digest: digest(snapshot) });
    } catch (error) {
      const invariant = error instanceof InvariantError ? error.invariant : "crash";
      failure = {
        step: index,
        action: step.action,
        invariant,
        message: error instanceof Error ? error.message : String(error),
        detail: error instanceof InvariantError ? error.detail : null,
        stack: error instanceof Error ? (error.stack ?? null) : null,
      };
      break;
    }
  }
  return {
    seed,
    start,
    length: steps.length,
    ok: failure === null,
    steps: trace.length,
    trace,
    traceDigest: digest(trace),
    failure,
  };
}

export function runSeed(seed: number): SequenceOutcome {
  const { start, steps } = generateActions(seed);
  return executeSequence(seed, start, steps);
}

/**
 * ddmin-style shrink: drops chunks of steps while the SAME invariant keeps
 * failing. Returns the smallest failing step list found.
 */
export function shrinkFailure(
  seed: number,
  start: "committed" | "minimal",
  steps: readonly Step[],
  invariant: string,
): Step[] {
  return shrinkSteps(steps, (candidate) => {
    const outcome = executeSequence(seed, start, candidate);
    return !outcome.ok && outcome.failure?.invariant === invariant;
  });
}

export function shrinkSteps(
  steps: readonly Step[],
  stillFails: (candidate: Step[]) => boolean,
): Step[] {
  let current = [...steps];
  let chunk = Math.max(1, Math.floor(current.length / 2));
  while (chunk >= 1 && current.length > 1) {
    let removedAny = false;
    for (let index = 0; index + chunk <= current.length;) {
      const candidate = [...current.slice(0, index), ...current.slice(index + chunk)];
      if (candidate.length > 0 && stillFails(candidate)) {
        current = candidate;
        removedAny = true;
      } else {
        index += chunk;
      }
    }
    if (!removedAny) chunk = Math.floor(chunk / 2);
  }
  return current;
}
