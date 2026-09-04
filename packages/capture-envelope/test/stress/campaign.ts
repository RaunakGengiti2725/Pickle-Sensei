import {
  ENVELOPE_DIMENSIONS,
  type EnvelopeDimension,
  type EnvelopeStatus,
} from "@pickle/shared-types";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  G08_BYPASS_FAMILIES,
  G08_CAPTURE_LABELS,
  G08_DOWNSTREAM_OUTCOMES,
  G08_LABEL_SCHEMA_VERSION,
  classifyDimension,
  clippedPixelFraction,
  computeG08Metrics,
  computeG08MetricsByFamily,
  evaluateCaptureEnvelope,
  evaluateG08Promotion,
  evidenceSufficient,
  laplacianVariance,
  meanAbsDiff,
  meanLuma,
  spatialStd,
  validateG08LabelFile,
  type CaptureEnvelopeMeasurements,
  type DimensionThreshold,
  type EnvelopeBand,
  type G08EvalRow,
} from "../../src/index.js";
import {
  DIMENSION_SOURCES,
  MEASUREMENT_FIELDS,
  STATUS_RANK,
  bandShape,
  checkVerdict,
  expectedStatus,
  isUsableNumber,
  type LooseMeasurements,
  type MeasurementField,
} from "./envelopeModel.js";
import {
  checkMetrics,
  checkPromotion,
  checkValidation,
  modelSufficient,
  type LooseLabel,
} from "./g08Model.js";
import {
  FRAME_PATTERNS,
  approxEqual,
  buildFrame,
  modelClippedFraction,
  modelLaplacianVariance,
  modelMeanAbsDiff,
  modelMeanLuma,
  modelSpatialStd,
  type FramePattern,
  type SyntheticFrame,
} from "./pixelModel.js";
import { Rng, fnv1a, stableJson } from "./prng.js";

/**
 * Seeded randomized long-run campaign over the capture-envelope public API.
 *
 * A sequence is 5–60 concrete actions (every parameter materialised at
 * generation time so a recorded sequence replays without the RNG). Each
 * action drives one public entry point and is model-checked against the
 * independent oracles in envelopeModel / pixelModel / g08Model immediately
 * afterwards. Actions carry a tier:
 *   legal      — inputs inside the declared TypeScript contract
 *   near_legal — inputs a JS caller can still pass (Infinity, undefined,
 *                numeric strings, mismatched frame lengths, supersedes
 *                cycles); the contract's "never a fabricated pass" and
 *                "no NaN/Infinity in outputs" invariants are still expected.
 *
 * Replay: `runSequence(generateSequence(seed))`.
 */

export type Tier = "legal" | "near_legal";

export type ValueKind =
  | "in_supported"
  | "in_degraded"
  | "in_unsupported"
  | "boundary_exact"
  | "boundary_just_outside"
  | "zero"
  | "negative"
  | "huge"
  | "tiny"
  | "null"
  | "nan"
  | "pos_infinity"
  | "neg_infinity"
  | "undefined"
  | "numeric_string"
  | "text_string"
  | "boolean";

export interface EnvSetAction {
  kind: "env.set";
  tier: Tier;
  field: MeasurementField;
  valueKind: ValueKind;
  /** Finite payload when valueKind needs one (JSON-safe). */
  value: number | null;
}
export interface EnvResetAction {
  kind: "env.reset";
  tier: Tier;
  preset: "all_supported" | "all_null" | "degraded_mix";
}
export interface EnvEvaluateAction {
  kind: "env.evaluate";
  tier: Tier;
}
export interface EnvClassifyAction {
  kind: "env.classify";
  tier: Tier;
  dimension: EnvelopeDimension;
  valueKind: ValueKind;
  value: number | null;
  /** Positive delta for the monotonicity probe. */
  delta: number;
}
export interface PixelFrameAction {
  kind: "pixel.frame";
  tier: Tier;
  width: number;
  height: number;
  pattern: FramePattern;
  frameSeed: number;
}
export interface PixelDiffAction {
  kind: "pixel.diff";
  tier: Tier;
  a: number;
  b: number;
}
export type LabelMutation =
  | "valid"
  | "valid_supersedes_prev"
  | "unsafe_without_notes"
  | "ambiguous_ws_notes"
  | "machine_annotator"
  | "bad_family"
  | "bad_capture"
  | "duplicate_id"
  | "negative_start"
  | "zero_duration"
  | "nan_start"
  | "bad_date"
  | "supersedes_missing"
  | "supersedes_self"
  | "supersedes_cycle_pair"
  | "empty_annotator"
  | "candidate_number";
export interface G08LabelAction {
  kind: "g08.label";
  tier: Tier;
  mutation: LabelMutation;
  family: (typeof G08_BYPASS_FAMILIES)[number];
  capture: (typeof G08_CAPTURE_LABELS)[number];
  downstream: (typeof G08_DOWNSTREAM_OUTCOMES)[number];
  sessionKey: string;
}
export interface G08RowAction {
  kind: "g08.row";
  tier: Tier;
  pool: "incumbent" | "candidate";
  family: (typeof G08_BYPASS_FAMILIES)[number];
  capture: (typeof G08_CAPTURE_LABELS)[number];
  downstream: (typeof G08_DOWNSTREAM_OUTCOMES)[number];
  envelopeOverall: Exclude<EnvelopeStatus, "NOT_MEASURED">;
  sessionKey: string;
}

export type Action =
  | EnvSetAction
  | EnvResetAction
  | EnvEvaluateAction
  | EnvClassifyAction
  | PixelFrameAction
  | PixelDiffAction
  | G08LabelAction
  | G08RowAction;

export interface Violation {
  step: number;
  action: Action["kind"];
  tier: Tier;
  /** Stable identifier used for minimisation / grouping. */
  code: string;
  message: string;
}

export interface SequenceRun {
  violations: Violation[];
  traceHash: string;
  steps: number;
}

export const MIN_LENGTH = 5;
export const MAX_LENGTH = 60;

const NEAR_LEGAL_VALUE_KINDS: ReadonlySet<ValueKind> = new Set<ValueKind>([
  "pos_infinity",
  "neg_infinity",
  "undefined",
  "numeric_string",
  "text_string",
  "boolean",
]);

const VALUE_KIND_WEIGHTS: Record<ValueKind, number> = {
  in_supported: 18,
  in_degraded: 12,
  in_unsupported: 12,
  boundary_exact: 10,
  boundary_just_outside: 10,
  zero: 4,
  negative: 4,
  huge: 3,
  tiny: 3,
  null: 10,
  nan: 5,
  pos_infinity: 2,
  neg_infinity: 2,
  undefined: 2,
  numeric_string: 1,
  text_string: 1,
  boolean: 1,
};

const ACTION_WEIGHTS = {
  "env.set": 30,
  "env.reset": 3,
  "env.evaluate": 12,
  "env.classify": 12,
  "pixel.frame": 12,
  "pixel.diff": 6,
  "g08.label": 12,
  "g08.row": 13,
} as const;

const LABEL_MUTATION_WEIGHTS: Record<LabelMutation, number> = {
  valid: 40,
  valid_supersedes_prev: 10,
  unsafe_without_notes: 4,
  ambiguous_ws_notes: 3,
  machine_annotator: 4,
  bad_family: 3,
  bad_capture: 3,
  duplicate_id: 4,
  negative_start: 3,
  zero_duration: 3,
  nan_start: 2,
  bad_date: 3,
  supersedes_missing: 4,
  supersedes_self: 3,
  supersedes_cycle_pair: 3,
  empty_annotator: 3,
  candidate_number: 3,
};

const NEAR_LEGAL_MUTATIONS: ReadonlySet<LabelMutation> = new Set<LabelMutation>([
  "supersedes_self",
  "supersedes_cycle_pair",
  "nan_start",
]);

const SESSION_KEYS = ["s-a", "s-b", "s-c", "s-d", "s-e"] as const;

function fieldDimension(field: MeasurementField): EnvelopeDimension {
  for (const dimension of ENVELOPE_DIMENSIONS) {
    if (DIMENSION_SOURCES[dimension].includes(field)) return dimension;
  }
  throw new Error(`no dimension for ${field}`);
}

function bandSpan(band: EnvelopeBand): { lo: number; hi: number } {
  const lo = band.min ?? (band.max ?? 0) - 1000;
  const hi = band.max ?? (band.min ?? 0) + 1000;
  return { lo, hi };
}

/** Materialise a finite payload for a value kind (null for non-finite / non-number kinds). */
function samplePayload(rng: Rng, dimension: EnvelopeDimension, kind: ValueKind): number | null {
  const threshold: DimensionThreshold = CAPTURE_ENVELOPE_THRESHOLDS[dimension];
  const supported = bandSpan(threshold.supported);
  const degraded = bandSpan(threshold.degraded);
  const roundTo = (v: number) => Math.round(v * 1e6) / 1e6;
  switch (kind) {
    case "in_supported":
      return roundTo(rng.float(supported.lo, supported.hi));
    case "in_degraded": {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const v = roundTo(rng.float(degraded.lo, degraded.hi));
        if (expectedStatus(v, threshold) === "DEGRADED") return v;
      }
      return threshold.degraded.min ?? threshold.degraded.max ?? 0;
    }
    case "in_unsupported": {
      const below = threshold.degraded.min !== undefined;
      const above = threshold.degraded.max !== undefined;
      const goBelow = below && (!above || rng.chance(0.5));
      if (goBelow) {
        const min = threshold.degraded.min ?? 0;
        return roundTo(min - rng.float(0.000001, Math.abs(min) + 10));
      }
      const max = threshold.degraded.max ?? 0;
      return roundTo(max + rng.float(0.000001, Math.abs(max) + 10));
    }
    case "boundary_exact":
    case "boundary_just_outside": {
      const edges = [
        threshold.supported.min,
        threshold.supported.max,
        threshold.degraded.min,
        threshold.degraded.max,
      ].filter((v): v is number => v !== undefined);
      const edge = rng.pick(edges);
      if (kind === "boundary_exact") return edge;
      const eps = Math.max(Math.abs(edge) * Number.EPSILON * 2, Number.MIN_VALUE);
      return rng.chance(0.5) ? edge + eps : edge - eps;
    }
    case "zero":
      return 0;
    case "negative":
      return -roundTo(rng.float(0.000001, 5000));
    case "huge":
      return rng.pick([1e9, 1e12, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]);
    case "tiny":
      return rng.pick([Number.MIN_VALUE, 1e-300, 1e-9]);
    case "numeric_string":
      return roundTo(rng.float(supported.lo, supported.hi));
    default:
      return null;
  }
}

/** Turn a recorded (kind, payload) into the JS value fed to the unit. */
export function materialise(kind: ValueKind, value: number | null): unknown {
  switch (kind) {
    case "null":
      return null;
    case "nan":
      return Number.NaN;
    case "pos_infinity":
      return Number.POSITIVE_INFINITY;
    case "neg_infinity":
      return Number.NEGATIVE_INFINITY;
    case "undefined":
      return undefined;
    case "numeric_string":
      return String(value);
    case "text_string":
      return "not-a-number";
    case "boolean":
      return true;
    default:
      return value;
  }
}

const SUPPORTED_FIXTURE: CaptureEnvelopeMeasurements = {
  frameWidthPx: 1920,
  frameHeightPx: 1080,
  avgFrameRateFps: 30,
  brightnessMeanLuma: 120,
  brightnessStdLuma: 10,
  laplacianVarianceMedian: 300,
  meanAbsFrameDiff: 8,
  denoiseSurvivalRatio: 0.6,
  clippedPixelFraction: 0.05,
  contrastNormalizedFrameDiff: 0.1,
  frameIntervalCv: 0.05,
  clipDurationMs: 5000,
  playerPixelHeightFraction: 0.4,
  playerMeanJointVisibility: 0.8,
};

const DEGRADED_MIX: CaptureEnvelopeMeasurements = {
  ...SUPPORTED_FIXTURE,
  avgFrameRateFps: 20,
  brightnessMeanLuma: 50,
  laplacianVarianceMedian: 60,
  playerPixelHeightFraction: null,
};

export function generateSequence(seed: number): Action[] {
  const rng = new Rng(seed);
  const length = rng.int(MIN_LENGTH, MAX_LENGTH);
  const actions: Action[] = [];
  let frames = 0;
  let labels = 0;
  for (let index = 0; index < length; index += 1) {
    let kind = rng.weighted(ACTION_WEIGHTS);
    if (kind === "pixel.diff" && frames === 0) kind = "pixel.frame";
    switch (kind) {
      case "env.set": {
        const field = rng.pick(MEASUREMENT_FIELDS);
        const valueKind = rng.weighted(VALUE_KIND_WEIGHTS);
        actions.push({
          kind,
          tier: NEAR_LEGAL_VALUE_KINDS.has(valueKind) ? "near_legal" : "legal",
          field,
          valueKind,
          value: samplePayload(rng, fieldDimension(field), valueKind),
        });
        break;
      }
      case "env.reset":
        actions.push({
          kind,
          tier: "legal",
          preset: rng.pick(["all_supported", "all_null", "degraded_mix"] as const),
        });
        break;
      case "env.evaluate":
        actions.push({ kind, tier: "legal" });
        break;
      case "env.classify": {
        const dimension = rng.pick(ENVELOPE_DIMENSIONS);
        const valueKind = rng.weighted(VALUE_KIND_WEIGHTS);
        actions.push({
          kind,
          tier: NEAR_LEGAL_VALUE_KINDS.has(valueKind) ? "near_legal" : "legal",
          dimension,
          valueKind,
          value: samplePayload(rng, dimension, valueKind),
          delta: rng.pick([Number.EPSILON * 64, 0.001, 1, 1000]),
        });
        break;
      }
      case "pixel.frame": {
        const shape = rng.weighted({ normal: 70, degenerate: 20, empty: 10 } as const);
        const width =
          shape === "normal" ? rng.int(3, 40) : shape === "degenerate" ? rng.int(1, 2) : 0;
        const height =
          shape === "normal" ? rng.int(3, 40) : shape === "degenerate" ? rng.int(1, 40) : 0;
        actions.push({
          kind,
          tier: "legal",
          width,
          height,
          pattern: rng.pick(FRAME_PATTERNS),
          frameSeed: rng.int(1, 0x7fffffff),
        });
        frames += 1;
        break;
      }
      case "pixel.diff": {
        actions.push({
          kind,
          tier: "legal",
          a: rng.int(0, frames - 1),
          b: rng.int(0, frames - 1),
        });
        break;
      }
      case "g08.label": {
        let mutation = rng.weighted(LABEL_MUTATION_WEIGHTS);
        if (labels === 0 && (mutation === "valid_supersedes_prev" || mutation === "duplicate_id")) {
          mutation = "valid";
        }
        actions.push({
          kind,
          tier: NEAR_LEGAL_MUTATIONS.has(mutation) ? "near_legal" : "legal",
          mutation,
          family: rng.pick(G08_BYPASS_FAMILIES),
          capture: rng.pick(G08_CAPTURE_LABELS),
          downstream: rng.pick(G08_DOWNSTREAM_OUTCOMES),
          sessionKey: rng.pick(SESSION_KEYS),
        });
        labels += mutation === "supersedes_cycle_pair" ? 2 : 1;
        break;
      }
      case "g08.row":
        actions.push({
          kind,
          tier: "legal",
          pool: rng.chance(0.5) ? "incumbent" : "candidate",
          family: rng.pick(G08_BYPASS_FAMILIES),
          capture: rng.pick(G08_CAPTURE_LABELS),
          downstream: rng.pick(G08_DOWNSTREAM_OUTCOMES),
          envelopeOverall: rng.pick(["SUPPORTED", "DEGRADED", "UNSUPPORTED"] as const),
          sessionKey: rng.pick(SESSION_KEYS),
        });
        break;
    }
  }
  return actions;
}

interface State {
  m: LooseMeasurements;
  frames: SyntheticFrame[];
  labelFile: { schemaVersion: string; provenance: string; labels: LooseLabel[] };
  labelCounter: number;
  rows: { incumbent: G08EvalRow[]; candidate: G08EvalRow[] };
}

function freshState(): State {
  return {
    m: { ...SUPPORTED_FIXTURE },
    frames: [],
    labelFile: {
      schemaVersion: G08_LABEL_SCHEMA_VERSION,
      provenance: "stress harness — synthetic in-memory records, never written to disk",
      labels: [],
    },
    labelCounter: 0,
    rows: { incumbent: [], candidate: [] },
  };
}

function snapshotInput(m: LooseMeasurements): string {
  return stableJson(MEASUREMENT_FIELDS.map((field) => [field, m[field]]));
}

function applyEnvelope(
  state: State,
  step: number,
  action: Action,
  trace: unknown[],
  out: Violation[],
): void {
  const m = state.m;
  const before = snapshotInput(m);
  const verdict = evaluateCaptureEnvelope(m as unknown as CaptureEnvelopeMeasurements);
  const again = evaluateCaptureEnvelope(m as unknown as CaptureEnvelopeMeasurements);
  const verdictJson = stableJson(verdict);
  trace.push(verdictJson);
  const tier = inputTier(m);
  if (verdictJson !== stableJson(again)) {
    out.push(
      violation(step, action, tier, "env.nondeterministic", "same input, different verdict"),
    );
  }
  if (snapshotInput(m) !== before) {
    out.push(
      violation(
        step,
        action,
        tier,
        "env.mutates_input",
        "evaluateCaptureEnvelope mutated its input",
      ),
    );
  }
  for (const message of checkVerdict(m, verdict)) {
    out.push(violation(step, action, tier, codeFor(message), message));
  }
}

function inputTier(m: LooseMeasurements): Tier {
  for (const field of MEASUREMENT_FIELDS) {
    const v = m[field];
    if (v === null) continue;
    if (typeof v !== "number") return "near_legal";
    if (!Number.isNaN(v) && !Number.isFinite(v)) return "near_legal";
  }
  return "legal";
}

function codeFor(message: string): string {
  if (message.startsWith("non-finite")) return "env.nonfinite_output";
  if (message.startsWith("notMeasured")) return "env.not_measured_mismatch";
  if (message.startsWith("overallWithCoverage")) return "env.coverage_mismatch";
  if (message.startsWith("overall")) return "env.overall_mismatch";
  if (message.includes(": status ")) return "env.status_mismatch";
  if (message.includes("NOT_MEASURED must carry")) return "env.measured_not_null";
  if (message.includes(": measured ")) return "env.measured_mismatch";
  return "env.contract";
}

function violation(
  step: number,
  action: Action,
  tier: Tier,
  code: string,
  message: string,
): Violation {
  return { step, action: action.kind, tier, code, message };
}

function applyClassify(
  step: number,
  action: EnvClassifyAction,
  trace: unknown[],
  out: Violation[],
): void {
  const threshold: DimensionThreshold = CAPTURE_ENVELOPE_THRESHOLDS[action.dimension];
  const value = materialise(action.valueKind, action.value);
  const status = classifyDimension(value as number | null, threshold);
  trace.push([action.dimension, stableJson(value), status]);
  const expected = expectedStatus(value, threshold);
  if (status !== expected) {
    out.push(
      violation(
        step,
        action,
        action.tier,
        "classify.oracle",
        `${action.dimension}: classifyDimension(${stableJson(value)}) = ${status}, model expects ${expected}`,
      ),
    );
  }
  if (isUsableNumber(value) && Number.isFinite(value)) {
    const shape = bandShape(threshold);
    const higher = classifyDimension(value + action.delta, threshold);
    trace.push(higher);
    if (shape === "min" && STATUS_RANK[higher] > STATUS_RANK[status]) {
      out.push(
        violation(
          step,
          action,
          action.tier,
          "classify.monotonic",
          `${action.dimension}: raising ${value} by ${action.delta} worsened ${status} -> ${higher}`,
        ),
      );
    }
    if (shape === "max" && STATUS_RANK[higher] < STATUS_RANK[status]) {
      out.push(
        violation(
          step,
          action,
          action.tier,
          "classify.monotonic",
          `${action.dimension}: raising ${value} by ${action.delta} improved ${status} -> ${higher}`,
        ),
      );
    }
  }
}

function applyFrame(
  state: State,
  step: number,
  action: PixelFrameAction,
  trace: unknown[],
  out: Violation[],
): void {
  const frame = buildFrame(new Rng(action.frameSeed), action.width, action.height, action.pattern);
  state.frames.push(frame);
  const luma = meanLuma(frame.data);
  const std = spatialStd(frame.data);
  const lap = laplacianVariance(frame.data, frame.width, frame.height);
  const clipped = clippedPixelFraction(state.frames.map((f) => f.data));
  trace.push([luma, std, lap, clipped]);
  const checks: Array<[string, number | null, number | null]> = [
    ["pixel.meanLuma", luma, modelMeanLuma(frame)],
    ["pixel.spatialStd", std, modelSpatialStd(frame)],
    ["pixel.laplacianVariance", lap, modelLaplacianVariance(frame)],
    ["pixel.clippedPixelFraction", clipped, modelClippedFraction(state.frames)],
  ];
  for (const [code, actual, expected] of checks) {
    if (actual === null || expected === null) {
      if (actual !== expected) {
        out.push(
          violation(
            step,
            action,
            "legal",
            code,
            `${code}: ${String(actual)} vs model ${String(expected)}`,
          ),
        );
      }
      continue;
    }
    if (!approxEqual(actual, expected, 1e-9, 1e-6)) {
      out.push(violation(step, action, "legal", code, `${code}: ${actual} vs model ${expected}`));
    }
  }
  if (!(luma >= 0 && luma <= 255))
    out.push(violation(step, action, "legal", "pixel.range", `meanLuma ${luma} outside [0,255]`));
  if (!(std >= 0))
    out.push(violation(step, action, "legal", "pixel.range", `spatialStd ${std} negative`));
  if (!(lap >= 0))
    out.push(violation(step, action, "legal", "pixel.range", `laplacianVariance ${lap} negative`));
  if (clipped !== null && !(clipped >= 0 && clipped <= 1)) {
    out.push(
      violation(
        step,
        action,
        "legal",
        "pixel.range",
        `clippedPixelFraction ${clipped} outside [0,1]`,
      ),
    );
  }
}

function applyDiff(
  state: State,
  step: number,
  action: PixelDiffAction,
  trace: unknown[],
  out: Violation[],
): void {
  const a = state.frames[action.a];
  const b = state.frames[action.b];
  if (!a || !b) return;
  const sameShape = a.data.length === b.data.length;
  const tier: Tier = sameShape ? "legal" : "near_legal";
  const forward = meanAbsDiff(a.data, b.data);
  const backward = meanAbsDiff(b.data, a.data);
  trace.push([forward, backward]);
  if (sameShape) {
    const expected = modelMeanAbsDiff(a, b);
    if (!approxEqual(forward, expected, 1e-9, 1e-6)) {
      out.push(
        violation(step, action, tier, "pixel.meanAbsDiff", `${forward} vs model ${expected}`),
      );
    }
    if (forward !== backward) {
      out.push(
        violation(step, action, tier, "pixel.meanAbsDiff_symmetry", `${forward} != ${backward}`),
      );
    }
    if (action.a === action.b && forward !== 0) {
      out.push(violation(step, action, tier, "pixel.meanAbsDiff_self", `self diff ${forward}`));
    }
  } else if (!Number.isFinite(forward) || !Number.isFinite(backward)) {
    out.push(
      violation(
        step,
        action,
        tier,
        "pixel.meanAbsDiff_nonfinite",
        `meanAbsDiff on ${a.data.length}px vs ${b.data.length}px frames returned ${forward} / ${backward}`,
      ),
    );
  }
}

function buildLabel(state: State, action: G08LabelAction, suffix = ""): LooseLabel {
  state.labelCounter += 1;
  const labelId = `stress-label-${String(state.labelCounter).padStart(4, "0")}${suffix}`;
  return {
    labelId,
    candidateId: null,
    clip: "datasets/stress/synthetic-in-memory.mp4",
    windowMs: { startMs: 250, durationMs: 1500 },
    sessionKey: action.sessionKey,
    family: action.family,
    capture: action.capture,
    downstream: action.downstream,
    annotatorKind: "human",
    annotator: "stress-harness-synthetic",
    labeledAtIso: "2026-01-01T00:00:00.000Z",
    notes: `synthetic ${action.capture} window used only to exercise the validator`,
  };
}

function applyLabel(
  state: State,
  step: number,
  action: G08LabelAction,
  trace: unknown[],
  out: Violation[],
): void {
  const file = state.labelFile;
  const previous = file.labels[file.labels.length - 1];
  const previousId =
    previous && typeof previous.labelId === "string" ? previous.labelId : undefined;
  const record = buildLabel(state, action);
  switch (action.mutation) {
    case "valid":
      break;
    case "valid_supersedes_prev":
      if (previousId !== undefined) record.supersedesLabelId = previousId;
      break;
    case "unsafe_without_notes":
      record.capture = "UNSAFE";
      record.notes = "";
      break;
    case "ambiguous_ws_notes":
      record.capture = "AMBIGUOUS";
      record.notes = "   \n\t";
      break;
    case "machine_annotator":
      record.annotatorKind = "machine";
      break;
    case "bad_family":
      record.family = "motion_blurr";
      break;
    case "bad_capture":
      record.capture = "safe";
      break;
    case "duplicate_id":
      if (previousId !== undefined) record.labelId = previousId;
      break;
    case "negative_start":
      record.windowMs = { startMs: -1, durationMs: 1000 };
      break;
    case "zero_duration":
      record.windowMs = { startMs: 0, durationMs: 0 };
      break;
    case "nan_start":
      record.windowMs = { startMs: Number.NaN, durationMs: 1000 };
      break;
    case "bad_date":
      record.labeledAtIso = "yesterday-ish";
      break;
    case "supersedes_missing":
      record.supersedesLabelId = "stress-label-does-not-exist";
      break;
    case "supersedes_self":
      record.supersedesLabelId = record.labelId as string;
      break;
    case "supersedes_cycle_pair": {
      const partner = buildLabel(state, action);
      record.supersedesLabelId = partner.labelId as string;
      partner.supersedesLabelId = record.labelId as string;
      file.labels.push(partner);
      break;
    }
    case "empty_annotator":
      record.annotator = "";
      break;
    case "candidate_number":
      record.candidateId = 42;
      break;
  }
  file.labels.push(record);

  const parsed: unknown = JSON.parse(JSON.stringify(file));
  const result = validateG08LabelFile(parsed);
  const second = validateG08LabelFile(parsed);
  trace.push([result.valid, result.errors.length, result.effective.map((r) => r.labelId)]);
  const modelInput = JSON.parse(JSON.stringify(file)) as {
    schemaVersion: unknown;
    provenance: unknown;
    labels: unknown[];
  };
  const { legal, nearLegal } = checkValidation(modelInput, result, second);
  for (const message of legal)
    out.push(violation(step, action, action.tier, "g08.validator", message));
  for (const message of nearLegal) {
    out.push(violation(step, action, "near_legal", "g08.supersedes_cycle_accepted", message));
  }
}

function applyRow(
  state: State,
  step: number,
  action: G08RowAction,
  trace: unknown[],
  out: Violation[],
): void {
  const rows = state.rows[action.pool];
  rows.push({
    labelId: `stress-row-${rows.length + 1}`,
    family: action.family,
    sessionKey: action.sessionKey,
    capture: action.capture,
    downstream: action.downstream,
    envelopeOverall: action.envelopeOverall,
  });
  const incumbent = computeG08Metrics(state.rows.incumbent);
  const candidate = computeG08Metrics(state.rows.candidate);
  for (const message of checkMetrics(state.rows.incumbent, incumbent)) {
    out.push(violation(step, action, "legal", "g08.metrics", message));
  }
  for (const message of checkMetrics(state.rows.candidate, candidate)) {
    out.push(violation(step, action, "legal", "g08.metrics", message));
  }
  const incByFamily = computeG08MetricsByFamily(state.rows.incumbent);
  const candByFamily = computeG08MetricsByFamily(state.rows.candidate);
  let familyTotal = 0;
  for (const family of G08_BYPASS_FAMILIES) {
    familyTotal += candByFamily[family].n;
    const inc = incByFamily[family];
    const cand = candByFamily[family];
    const sufficient = evidenceSufficient(cand);
    if (sufficient.sufficient !== modelSufficient(cand)) {
      out.push(
        violation(
          step,
          action,
          "legal",
          "g08.evidence",
          `${family}: evidenceSufficient ${String(sufficient.sufficient)} != model`,
        ),
      );
    }
    if (sufficient.sufficient !== (sufficient.reasons.length === 0)) {
      out.push(
        violation(
          step,
          action,
          "legal",
          "g08.evidence",
          `${family}: sufficient flag inconsistent with reasons`,
        ),
      );
    }
    const verdict = evaluateG08Promotion(family, inc, cand);
    trace.push([family, verdict.decidable, verdict.promote]);
    for (const message of checkPromotion(inc, cand, verdict, family)) {
      out.push(violation(step, action, "legal", "g08.promotion", `${family}: ${message}`));
    }
    const self = evaluateG08Promotion(family, cand, cand);
    if (self.decidable) {
      const fs = cand.falseSafeRate.rate ?? 0;
      const fr = cand.falseRejectRate.rate ?? 0;
      const expectedSelf = fs <= 0.2 && fr <= 0.2;
      if (self.promote !== expectedSelf) {
        out.push(
          violation(
            step,
            action,
            "legal",
            "g08.promotion_self",
            `${family}: candidate vs itself promote=${String(self.promote)}, model ${String(expectedSelf)}`,
          ),
        );
      }
    }
  }
  if (familyTotal !== candidate.n) {
    out.push(
      violation(
        step,
        action,
        "legal",
        "g08.metrics",
        `byFamily total ${familyTotal} != n ${candidate.n}`,
      ),
    );
  }
}

export function runSequence(actions: Action[]): SequenceRun {
  const state = freshState();
  const trace: unknown[] = [];
  const violations: Violation[] = [];
  actions.forEach((action, step) => {
    switch (action.kind) {
      case "env.set":
        if (action.valueKind === "undefined") delete state.m[action.field];
        else state.m[action.field] = materialise(action.valueKind, action.value);
        applyEnvelope(state, step, action, trace, violations);
        break;
      case "env.reset":
        state.m =
          action.preset === "all_supported"
            ? { ...SUPPORTED_FIXTURE }
            : action.preset === "degraded_mix"
              ? { ...DEGRADED_MIX }
              : (Object.fromEntries(MEASUREMENT_FIELDS.map((f) => [f, null])) as LooseMeasurements);
        applyEnvelope(state, step, action, trace, violations);
        break;
      case "env.evaluate":
        applyEnvelope(state, step, action, trace, violations);
        break;
      case "env.classify":
        applyClassify(step, action, trace, violations);
        break;
      case "pixel.frame":
        applyFrame(state, step, action, trace, violations);
        break;
      case "pixel.diff":
        applyDiff(state, step, action, trace, violations);
        break;
      case "g08.label":
        applyLabel(state, step, action, trace, violations);
        break;
      case "g08.row":
        applyRow(state, step, action, trace, violations);
        break;
    }
  });
  return { violations, traceHash: fnv1a(stableJson(trace)), steps: actions.length };
}

/**
 * ddmin-style minimisation: shrink the action list while the same violation
 * code still fires. Deterministic (replays recorded actions, no RNG).
 */
export function minimise(actions: Action[], code: string, budget = 400): Action[] {
  const fires = (subset: Action[]) => runSequence(subset).violations.some((v) => v.code === code);
  let current = actions;
  let runs = 0;
  let granularity = 2;
  while (current.length >= 2 && runs < budget) {
    const chunk = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length && runs < budget; start += chunk) {
      const complement = [...current.slice(0, start), ...current.slice(start + chunk)];
      runs += 1;
      if (complement.length > 0 && fires(complement)) {
        current = complement;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return current;
}

/**
 * HELD — every invariant held on every step and the seed replayed identically.
 * HELD_WITH_NEAR_LEGAL_FINDINGS — legal-tier invariants held; one or more
 *   near-legal actions produced a contract deviation (recorded per code).
 * BROKEN — a legal-tier invariant failed or the seed did not replay identically.
 */
export type Outcome = "HELD" | "HELD_WITH_NEAR_LEGAL_FINDINGS" | "BROKEN";

export interface SequenceOutcome {
  seed: number;
  length: number;
  outcome: Outcome;
  deterministic: boolean;
  traceHash: string;
  legalViolations: number;
  nearLegalViolations: number;
  codes: string[];
  violations: Violation[];
}

export interface MinimisedFailure {
  seed: number;
  code: string;
  tier: Tier;
  originalLength: number;
  minimisedLength: number;
  actions: Action[];
  message: string;
}

export interface CampaignReport {
  harness: "capture-envelope randomized-seeded";
  plane: "linux_node_pure";
  seeds: { from: number; to: number };
  sequences: number;
  scenariosExecuted: number;
  lengthRange: { min: number; max: number };
  actionCounts: Record<Action["kind"], number>;
  tierCounts: Record<Tier, number>;
  held: number;
  heldWithNearLegalFindings: number;
  broken: number;
  nonDeterministic: number[];
  violationsByCode: Record<string, { count: number; seeds: number[]; tier: Tier; sample: string }>;
  failingSeeds: number[];
  minimised: MinimisedFailure[];
  table: SequenceOutcome[];
}

export function runCampaign(from: number, count: number, minimiseBudget = 400): CampaignReport {
  const table: SequenceOutcome[] = [];
  const actionCounts = Object.fromEntries(Object.keys(ACTION_WEIGHTS).map((k) => [k, 0])) as Record<
    Action["kind"],
    number
  >;
  const tierCounts: Record<Tier, number> = { legal: 0, near_legal: 0 };
  const violationsByCode: CampaignReport["violationsByCode"] = {};
  const nonDeterministic: number[] = [];
  let scenariosExecuted = 0;
  let minLen = Number.POSITIVE_INFINITY;
  let maxLen = 0;

  for (let seed = from; seed < from + count; seed += 1) {
    const actions = generateSequence(seed);
    const replay = generateSequence(seed);
    const first = runSequence(actions);
    const second = runSequence(replay);
    scenariosExecuted += first.steps;
    minLen = Math.min(minLen, actions.length);
    maxLen = Math.max(maxLen, actions.length);
    for (const action of actions) {
      actionCounts[action.kind] += 1;
      tierCounts[action.tier] += 1;
    }
    const deterministic =
      stableJson(actions) === stableJson(replay) &&
      first.traceHash === second.traceHash &&
      stableJson(first.violations) === stableJson(second.violations);
    if (!deterministic) nonDeterministic.push(seed);
    const codes = [...new Set(first.violations.map((v) => v.code))].sort();
    for (const v of first.violations) {
      const entry = (violationsByCode[v.code] ??= {
        count: 0,
        seeds: [],
        tier: v.tier,
        sample: v.message,
      });
      entry.count += 1;
      if (!entry.seeds.includes(seed)) entry.seeds.push(seed);
    }
    const legalViolations = first.violations.filter((v) => v.tier === "legal").length;
    const outcome: Outcome =
      legalViolations > 0 || !deterministic
        ? "BROKEN"
        : first.violations.length > 0
          ? "HELD_WITH_NEAR_LEGAL_FINDINGS"
          : "HELD";
    table.push({
      seed,
      length: actions.length,
      outcome,
      deterministic,
      traceHash: first.traceHash,
      legalViolations,
      nearLegalViolations: first.violations.filter((v) => v.tier === "near_legal").length,
      codes,
      violations: first.violations,
    });
  }

  const minimised: MinimisedFailure[] = [];
  for (const [code, entry] of Object.entries(violationsByCode)) {
    const seed = entry.seeds[0];
    if (seed === undefined) continue;
    const actions = generateSequence(seed);
    const shrunk = minimise(actions, code, minimiseBudget);
    const run = runSequence(shrunk);
    const hit = run.violations.find((v) => v.code === code);
    minimised.push({
      seed,
      code,
      tier: entry.tier,
      originalLength: actions.length,
      minimisedLength: shrunk.length,
      actions: shrunk,
      message: hit?.message ?? entry.sample,
    });
  }

  const failingSeeds = table.filter((row) => row.outcome === "BROKEN").map((row) => row.seed);
  const nearLegal = table.filter((row) => row.outcome === "HELD_WITH_NEAR_LEGAL_FINDINGS").length;
  return {
    harness: "capture-envelope randomized-seeded",
    plane: "linux_node_pure",
    seeds: { from, to: from + count - 1 },
    sequences: table.length,
    scenariosExecuted,
    lengthRange: { min: minLen, max: maxLen },
    actionCounts,
    tierCounts,
    held: table.length - failingSeeds.length - nearLegal,
    heldWithNearLegalFindings: nearLegal,
    broken: failingSeeds.length,
    nonDeterministic,
    violationsByCode,
    failingSeeds,
    minimised,
    table,
  };
}
