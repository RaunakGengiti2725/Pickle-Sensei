import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  evaluateCaptureEnvelope,
  type CaptureEnvelopeMeasurements,
} from "@pickle/capture-envelope";
import {
  analyzeCapture,
  preAnalysisGate,
  type CaptureAnalysisInput,
  type CaptureAnalysisRecord,
  type FusionProviders,
} from "@pickle/analysis-pipeline";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import type { EnvelopeVerdict, OperationFailure, ShotTypeSlug } from "@pickle/shared-types";
import {
  parsePoseSequence,
  serializePoseSequence,
  unavailable,
  type PoseSequence,
} from "@pickle/swing-domain";
import {
  evaluateCaptureQuality,
  evaluateFrameAnalyzability,
  FRAME_THRESHOLDS,
  GeometricPhaseSegmenter,
  GeometryBiomechanicsExtractor,
  QUALITY_THRESHOLDS,
} from "@pickle/vision-geometry";
import type { CellSpec } from "./shapes.js";
import { SYNTH_VERSION, synthesizeCapture, type SynthCapture } from "./synth.js";

/**
 * One matrix cell = one synthetic capture pushed through every Linux-
 * runnable stage of the media → analysis path, with the outcome classified
 * as exactly one of: `scored` | `abstained` | `failed` | `threw`, and a set
 * of invariant checks that turn "silent partial success" into a named
 * violation with the replayable `CellSpec` attached.
 *
 * Stages (in the order the mobile path would run them):
 *   1. sidecar round trip      serializePoseSequence → parsePoseSequence
 *   2. capture envelope        evaluateCaptureEnvelope (+ the mobile
 *                              UNSUPPORTED block from runCaptureAnalysis.ts)
 *   3. frame gate              evaluateFrameAnalyzability
 *   4. pose quality            evaluateCaptureQuality
 *   5. pre-analysis gate       preAnalysisGate({frame, pose, poseQuality})
 *   6. fusion                  analyzeCapture with the production provider
 *                              catalog (createFusionProviders, declared route)
 *   7. determinism             analyzeCapture again on the same input
 */

export const HARNESS_VERSION = "xc-matrix-media-1-harness-2";
export const DECLARED_STROKE: ShotTypeSlug = "forehand_drive";

export type OutcomeKind = "scored" | "abstained" | "failed" | "threw" | "not_run";

/**
 * Per-cell compute budgets. `analyzeCapture` cost grows super-linearly with
 * the number of pose frames inside the trigger window (see the scaling probe
 * in xcMatrixMedia1.scaling.test.ts); cells above `fusionFrameBudget` record
 * `not_run` with the budget named — an explicit, counted skip, never a pass.
 * The determinism re-run doubles fusion cost, so it is bounded separately.
 */
export interface CellBudget {
  fusionFrameBudget: number;
  determinismFrameBudget: number;
}

export const DEFAULT_BUDGET: Record<"pr" | "full", CellBudget> = {
  pr: { fusionFrameBudget: 4_000, determinismFrameBudget: 1_500 },
  full: { fusionFrameBudget: 16_000, determinismFrameBudget: 3_000 },
};

/**
 * What the user would see for this cell on each shipping entry point
 * (apps/mobile/src/analysis/runCaptureAnalysis.ts `runCaptureAnalysisCore`):
 *  - guided capture (AnalyzeScreen.tsx:873): `attemptCaptureEnvelope` →
 *    UNSUPPORTED blocks; then sidecar parse; then analyzeCapture.
 *  - imported video (AnalyzeScreen.tsx:880 passes `captureEnvelope: null`):
 *    sidecar parse; then analyzeCapture over the whole clip. No envelope,
 *    frame-analyzability, capture-quality or pre-analysis gate runs.
 * Neither entry point calls preAnalysisGate / evaluateFrameAnalyzability /
 * evaluateCaptureQuality (grep apps/mobile/src: no references).
 */
export type Delivery =
  "quality_blocked" | "unavailable" | "scored" | "low_confidence" | "threw" | "not_run";

export interface StageFailure {
  kind: OperationFailure["kind"];
  code: string;
  message: string;
}

export interface CellResult {
  harnessVersion: string;
  synthVersion: string;
  spec: CellSpec;
  input: {
    poseFrameCount: number;
    videoFrameCount: number;
    clipDurationMs: number;
    aspectRatio: number;
    trigger: SynthCapture["trigger"];
    swingWindow: SynthCapture["swingWindow"];
    outOfFrameLandmarkFraction: number;
    /** Bytes of the serialized sidecar the parser had to accept. */
    sidecarBytes: number;
  };
  sidecar: { ok: boolean; failure: StageFailure | null };
  envelope: {
    overall: EnvelopeVerdict["overall"];
    overallWithCoverage: EnvelopeVerdict["overallWithCoverage"];
    unsupported: string[];
    degraded: string[];
    notMeasured: string[];
    /** Mirror of apps/mobile/src/analysis/runCaptureAnalysis.ts:185 (`overall === 'UNSUPPORTED'`). */
    mobileWouldBlock: boolean;
  };
  frameGate: { analyzable: boolean; reasons: string[]; notEvaluated: string[] };
  poseQuality: {
    analyzable: boolean;
    reasons: string[];
    stats: ReturnType<typeof evaluateCaptureQuality>["stats"];
  };
  preGate: {
    ok: boolean;
    analyzable: boolean;
    reasons: string[];
    failure: StageFailure | null;
    /**
     * The pose-quality report refused (any reason) but the composite gate
     * passed. By contract the composite gate only lifts the implausible-
     * scale reasons out of captureQuality; this flags every other refusal
     * the gate lets through so the report can count them.
     */
    qualityRefusedButGatePassed: boolean;
  };
  fusion: {
    outcome: OutcomeKind;
    /** Pose frames inside the trigger window — what analyzeCapture actually iterates. */
    windowFrames: number;
    /** Set when outcome is `not_run`; names the budget that was exceeded. */
    skipped: string | null;
    failure: StageFailure | null;
    thrown: string | null;
    resultKind: "scored" | "low_confidence" | null;
    overallScore: number | null;
    analysisConfidence: number | null;
    presentation: string | null;
    modelRuns: Array<{ task: string; status: string; code: string | null }>;
    phases: Array<{ key: string; startMs: number; endMs: number; representativeMs: number }>;
    contactMs: number | null;
    measurementCount: number;
    checkpointCount: number;
    limitingFactors: string[];
    guidance: string | null;
    durationMs: number;
    heapUsedDeltaBytes: number;
    rssAfterBytes: number;
  };
  determinism: { checked: boolean; identical: boolean; skipped: string | null };
  delivery: {
    guided: Delivery;
    /** null for swing_window cells: imports always analyze the whole clip. */
    imported: Delivery | null;
  };
  violations: Violation[];
}

export interface Violation {
  invariant: string;
  detail: string;
}

export function productionProviders(): FusionProviders {
  return {
    // Mirrors apps/mobile/src/vision/providers.ts createFusionProviders
    // (declared route): aspectRatio is hard-coded to 1 there.
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    shadowScorers: [],
  };
}

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};
const IMPORTED_TRIGGER_MODEL = {
  providerId: "trigger.imported-full-clip",
  modelVersion: "imported-full-clip-1",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

function toStageFailure(failure: OperationFailure): StageFailure {
  return { kind: failure.kind, code: failure.code, message: failure.message };
}

function deterministicOptions(spec: CellSpec) {
  let counter = 0;
  return {
    analysisId: `analysis-${spec.seed}`,
    sessionId: null,
    appVersion: "xc-matrix",
    modelBundleVersion: "on-device-fusion-1",
    nowIso: () => "2026-09-04T00:00:00.000Z",
    makeId: () => `run-${spec.seed}-${++counter}`,
    captureEnvelopeThresholdsVersion: null,
  };
}

function buildInput(
  spec: CellSpec,
  capture: SynthCapture,
  pose: PoseSequence,
): CaptureAnalysisInput {
  return {
    captureId: `capture-${spec.seed}`,
    pose,
    paddle: unavailable("paddle_detector_not_installed"),
    ball: unavailable("ball_tracker_not_installed"),
    trigger: {
      startMs: capture.trigger.startMs,
      endMs: capture.trigger.endMs,
      peakMotionMs: capture.trigger.peakMotionMs,
      confidence: spec.trigger === "swing_window" ? 0.9 : 1,
      producedBy: spec.trigger === "swing_window" ? TRIGGER_MODEL : IMPORTED_TRIGGER_MODEL,
    },
    stroke: { declared: DECLARED_STROKE, predicted: null },
    declaredCanonical: null,
    handedness: spec.handed,
    cameraView: "side",
    capturedAtIso: "2026-09-04T00:00:00.000Z",
  };
}

/** Deep scan for non-finite numbers; returns JSON paths of offenders (capped). */
export function findNonFiniteNumbers(value: unknown, path = "$", out: string[] = []): string[] {
  if (out.length >= 20) return out;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(path);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findNonFiniteNumbers(entry, `${path}[${index}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      findNonFiniteNumbers(entry, `${path}.${key}`, out);
    }
  }
  return out;
}

function deliveryFor(outcome: OutcomeKind): Delivery {
  switch (outcome) {
    case "threw":
      return "threw";
    case "failed":
      return "unavailable";
    case "scored":
      return "scored";
    case "abstained":
      return "low_confidence";
    case "not_run":
      return "not_run";
  }
}

export async function runCell(
  spec: CellSpec,
  budget: CellBudget = DEFAULT_BUDGET.full,
): Promise<CellResult> {
  const capture = synthesizeCapture(spec);
  const violations: Violation[] = [];

  // ── 1. sidecar round trip ────────────────────────────────────────────────
  const sidecarJson = serializePoseSequence(capture.sequence);
  const parsed = parsePoseSequence(sidecarJson, {
    providerId: "pose.apple-vision",
    runtime: "vision_framework",
    executionTarget: "on_device",
    artifactHash: null,
  });
  const sidecar = {
    ok: parsed.ok,
    failure: parsed.ok ? null : toStageFailure(parsed.failure),
  };
  const degenerateContainer =
    !Number.isFinite(spec.resolution.width) ||
    !Number.isFinite(spec.resolution.height) ||
    spec.resolution.width <= 0 ||
    spec.resolution.height <= 0;
  if (degenerateContainer && parsed.ok) {
    violations.push({
      invariant: "sidecar_rejects_degenerate_video",
      detail: `parsePoseSequence accepted video ${spec.resolution.width}x${spec.resolution.height}`,
    });
  }
  if (!degenerateContainer && !parsed.ok) {
    violations.push({
      invariant: "sidecar_round_trip",
      detail: `parsePoseSequence rejected a sequence serializePoseSequence produced: ${parsed.failure.code}`,
    });
  }
  if (parsed.ok && parsed.value.frames.length !== capture.sequence.frames.length) {
    violations.push({
      invariant: "sidecar_round_trip",
      detail: `frame count changed across round trip: ${capture.sequence.frames.length} → ${parsed.value.frames.length}`,
    });
  }
  const pose = parsed.ok ? parsed.value : capture.sequence;

  // ── 2. capture envelope ──────────────────────────────────────────────────
  const verdict = evaluateCaptureEnvelope(capture.envelope);
  const envelope = {
    overall: verdict.overall,
    overallWithCoverage: verdict.overallWithCoverage,
    unsupported: verdict.dimensions
      .filter((d) => d.status === "UNSUPPORTED")
      .map((d) => d.dimension),
    degraded: verdict.dimensions.filter((d) => d.status === "DEGRADED").map((d) => d.dimension),
    notMeasured: [...verdict.notMeasured],
    mobileWouldBlock: verdict.overall === "UNSUPPORTED",
  };
  checkEnvelopeOracle(capture.envelope, verdict, violations);

  // ── 3./4./5. gates ───────────────────────────────────────────────────────
  const frameReport = evaluateFrameAnalyzability(capture.frameStats);
  const qualityReport = evaluateCaptureQuality(pose);
  const gate = preAnalysisGate({ frame: frameReport, pose, poseQuality: qualityReport });
  checkGateOracle(spec, capture, frameReport, qualityReport, gate, violations);

  // ── 6. fusion ────────────────────────────────────────────────────────────
  const input = buildInput(spec, capture, pose);
  const windowFrames = pose.frames.filter(
    (f) => f.timestampMs >= input.trigger.startMs && f.timestampMs <= input.trigger.endMs,
  ).length;
  const skipped =
    windowFrames > budget.fusionFrameBudget
      ? `over_fusion_frame_budget(${windowFrames}>${budget.fusionFrameBudget})`
      : null;
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  let record: CaptureAnalysisRecord | null = null;
  let failure: StageFailure | null = null;
  let thrown: string | null = null;
  if (skipped === null) {
    try {
      const result = await analyzeCapture(productionProviders(), input, deterministicOptions(spec));
      if (result.ok) record = result.value;
      else failure = toStageFailure(result.failure);
    } catch (error) {
      thrown = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }
  const durationMs = performance.now() - started;
  const memory = process.memoryUsage();

  let outcome: OutcomeKind;
  if (skipped !== null) outcome = "not_run";
  else if (thrown !== null) outcome = "threw";
  else if (failure !== null) outcome = "failed";
  else if (record && record.result && record.result.resultKind === "scored") outcome = "scored";
  else outcome = "abstained";

  if (thrown !== null) {
    violations.push({
      invariant: "no_exception_escapes_analyzeCapture",
      detail: thrown,
    });
  }
  if (record) checkRecordInvariants(capture, input, record, violations);

  // ── 7. determinism ───────────────────────────────────────────────────────
  let determinism: CellResult["determinism"] = { checked: false, identical: false, skipped: null };
  if (skipped !== null) {
    determinism.skipped = skipped;
  } else if (windowFrames > budget.determinismFrameBudget) {
    determinism.skipped = `over_determinism_frame_budget(${windowFrames}>${budget.determinismFrameBudget})`;
  } else if (thrown === null) {
    const again = await analyzeCapture(
      productionProviders(),
      input,
      deterministicOptions(spec),
    ).catch(() => null);
    const first = JSON.stringify(record ?? failure);
    const second =
      again === null
        ? null
        : JSON.stringify(again.ok ? again.value : toStageFailure(again.failure));
    determinism = { checked: true, identical: first === second, skipped: null };
    if (first !== second) {
      violations.push({
        invariant: "deterministic_for_identical_input",
        detail:
          "second analyzeCapture run on the identical input produced a different record/failure",
      });
    }
  }

  const fusionDelivery = deliveryFor(outcome);
  const guided: Delivery = envelope.mobileWouldBlock
    ? "quality_blocked"
    : !parsed.ok
      ? "unavailable"
      : fusionDelivery;
  const imported: Delivery | null =
    spec.trigger === "full_clip" ? (!parsed.ok ? "unavailable" : fusionDelivery) : null;

  return {
    harnessVersion: HARNESS_VERSION,
    synthVersion: SYNTH_VERSION,
    spec,
    input: {
      poseFrameCount: capture.sequence.frames.length,
      videoFrameCount: capture.videoFrameCount,
      clipDurationMs: capture.clipDurationMs,
      aspectRatio: spec.resolution.width / spec.resolution.height,
      trigger: capture.trigger,
      swingWindow: capture.swingWindow,
      outOfFrameLandmarkFraction: capture.outOfFrameLandmarkFraction,
      sidecarBytes: Buffer.byteLength(sidecarJson),
    },
    sidecar,
    envelope,
    frameGate: {
      analyzable: frameReport.analyzable,
      reasons: [...frameReport.reasons],
      notEvaluated: [...frameReport.notEvaluated],
    },
    poseQuality: {
      analyzable: qualityReport.analyzable,
      reasons: [...qualityReport.reasons],
      stats: qualityReport.stats,
    },
    preGate: {
      ok: gate.ok,
      analyzable: gate.ok ? gate.value.analyzable : false,
      reasons: gate.ok ? [...gate.value.reasons] : [],
      failure: gate.ok ? null : toStageFailure(gate.failure),
      qualityRefusedButGatePassed: gate.ok && !qualityReport.analyzable,
    },
    fusion: {
      outcome,
      windowFrames,
      skipped,
      failure,
      thrown,
      resultKind: record?.result?.resultKind ?? null,
      overallScore: record?.result?.overallScore ?? null,
      analysisConfidence: record?.result?.analysisConfidence ?? null,
      presentation: record?.uncertainty.presentation ?? null,
      modelRuns: (record?.modelRuns ?? []).map((run) => ({
        task: run.task,
        status: run.status,
        code: run.failure?.code ?? null,
      })),
      phases: (record?.result?.phases ?? []).map((p) => ({
        key: p.key,
        startMs: p.startMs,
        endMs: p.endMs,
        representativeMs: p.representativeMs,
      })),
      contactMs: record?.result?.timestamps.contactMs ?? null,
      measurementCount: record?.result?.measurements.length ?? 0,
      checkpointCount: record?.result?.checkpoints.length ?? 0,
      limitingFactors: [...(record?.uncertainty.limitingFactors ?? [])],
      guidance: record?.result?.guidance ?? null,
      durationMs,
      heapUsedDeltaBytes: memory.heapUsed - heapBefore,
      rssAfterBytes: memory.rss,
    },
    determinism,
    delivery: { guided, imported },
    violations,
  };
}

/**
 * Envelope oracle: the threshold table is the contract, so every shape axis
 * must land in the band the table defines. Pixel dimensions are null here
 * and must therefore be NOT_MEASURED, never a status.
 */
function checkEnvelopeOracle(
  m: CaptureEnvelopeMeasurements,
  verdict: EnvelopeVerdict,
  violations: Violation[],
): void {
  const byDim = new Map(verdict.dimensions.map((d) => [d.dimension, d.status]));
  const expectBand = (
    dimension: string,
    value: number | null,
    threshold: {
      supported: { min?: number; max?: number };
      degraded: { min?: number; max?: number };
    },
  ) => {
    const actual = byDim.get(dimension as never);
    let expected: string;
    if (value === null || !Number.isFinite(value)) expected = "NOT_MEASURED";
    else if (inBand(value, threshold.supported)) expected = "SUPPORTED";
    else if (inBand(value, threshold.degraded)) expected = "DEGRADED";
    else expected = "UNSUPPORTED";
    if (actual !== expected) {
      violations.push({
        invariant: "envelope_matches_threshold_table",
        detail: `${dimension}: value=${String(value)} expected ${expected} got ${String(actual)}`,
      });
    }
  };
  const shortSide =
    m.frameWidthPx !== null && m.frameHeightPx !== null
      ? Math.min(m.frameWidthPx, m.frameHeightPx)
      : null;
  expectBand("resolution", shortSide, CAPTURE_ENVELOPE_THRESHOLDS.resolution);
  expectBand("frame_rate", m.avgFrameRateFps, CAPTURE_ENVELOPE_THRESHOLDS.frame_rate);
  expectBand("clip_duration", m.clipDurationMs, CAPTURE_ENVELOPE_THRESHOLDS.clip_duration);
  expectBand("timing_stability", m.frameIntervalCv, CAPTURE_ENVELOPE_THRESHOLDS.timing_stability);
  expectBand(
    "player_pixel_height",
    m.playerPixelHeightFraction,
    CAPTURE_ENVELOPE_THRESHOLDS.player_pixel_height,
  );
  expectBand(
    "player_visibility",
    m.playerMeanJointVisibility,
    CAPTURE_ENVELOPE_THRESHOLDS.player_visibility,
  );
  for (const dim of ["brightness", "motion_blur", "camera_motion"] as const) {
    if (byDim.get(dim) !== "NOT_MEASURED") {
      violations.push({
        invariant: "envelope_null_is_not_measured",
        detail: `${dim} classified as ${String(byDim.get(dim))} with a null measurement`,
      });
    }
  }
  const measured = verdict.dimensions.filter((d) => d.status !== "NOT_MEASURED");
  const worst = measured.some((d) => d.status === "UNSUPPORTED")
    ? "UNSUPPORTED"
    : measured.some((d) => d.status === "DEGRADED")
      ? "DEGRADED"
      : "SUPPORTED";
  if (verdict.overall !== worst) {
    violations.push({
      invariant: "envelope_overall_is_worst_measured",
      detail: `overall=${verdict.overall} but worst measured dimension=${worst}`,
    });
  }
  if (verdict.notMeasured.length > 0 && verdict.overallWithCoverage === "SUPPORTED") {
    violations.push({
      invariant: "envelope_coverage_never_plain_supported_with_gaps",
      detail: `overallWithCoverage=SUPPORTED with notMeasured=${verdict.notMeasured.join(",")}`,
    });
  }
}

function inBand(value: number, band: { min?: number; max?: number }): boolean {
  if (band.min !== undefined && value < band.min) return false;
  if (band.max !== undefined && value > band.max) return false;
  return true;
}

/**
 * Gate oracle on the SHAPE axes: frame count, duration, aspect, fps. These
 * follow directly from FRAME_THRESHOLDS / QUALITY_THRESHOLDS; anything else
 * (content defects) is out of scope for this matrix.
 */
function checkGateOracle(
  spec: CellSpec,
  capture: SynthCapture,
  frame: ReturnType<typeof evaluateFrameAnalyzability>,
  quality: ReturnType<typeof evaluateCaptureQuality>,
  gate: ReturnType<typeof preAnalysisGate>,
  violations: Violation[],
): void {
  const expectReason = (
    present: boolean,
    reasons: readonly string[],
    reason: string,
    who: string,
  ) => {
    if (present && !reasons.includes(reason)) {
      violations.push({
        invariant: `${who}_emits_${reason}`,
        detail: `expected ${reason}; got [${reasons.join(",")}]`,
      });
    }
    if (!present && reasons.includes(reason)) {
      violations.push({
        invariant: `${who}_no_spurious_${reason}`,
        detail: `unexpected ${reason} for this shape`,
      });
    }
  };
  const stats = capture.frameStats;
  const fewFrames = stats.frameCount < FRAME_THRESHOLDS.minFrames;
  expectReason(fewFrames, frame.reasons, "single_frame_clip", "frame_gate");
  expectReason(
    !fewFrames && stats.durationMs > 0 && stats.durationMs < FRAME_THRESHOLDS.minDurationMs,
    frame.reasons,
    "duration_too_short",
    "frame_gate",
  );
  expectReason(
    !fewFrames && stats.durationMs > FRAME_THRESHOLDS.maxDurationMs,
    frame.reasons,
    "duration_implausibly_long",
    "frame_gate",
  );
  const aspect = spec.resolution.width / spec.resolution.height;
  const implausibleAspect =
    Number.isFinite(aspect) &&
    spec.resolution.width > 0 &&
    spec.resolution.height > 0 &&
    (aspect > FRAME_THRESHOLDS.maxAspectRatio || aspect < 1 / FRAME_THRESHOLDS.maxAspectRatio);
  expectReason(implausibleAspect, frame.reasons, "implausible_aspect_ratio", "frame_gate");

  const poseFrames = capture.sequence.frames.length;
  expectReason(
    poseFrames < QUALITY_THRESHOLDS.minFrames,
    quality.reasons,
    "too_few_pose_frames",
    "pose_quality",
  );
  const fpsTooLow =
    quality.stats.effectiveFps > 0 &&
    quality.stats.effectiveFps < QUALITY_THRESHOLDS.minEffectiveFps;
  expectReason(fpsTooLow, quality.reasons, "insufficient_fps", "pose_quality");

  // Composite-gate contract (analysis-pipeline/src/preAnalysisGate.ts):
  // refuse when the frame report refuses, when the pose is empty, or when
  // captureQuality carries an implausible-scale reason; pass otherwise.
  // Other captureQuality reasons (too_few_pose_frames, insufficient_fps,
  // dropout…) are deliberately NOT lifted — recorded per cell as
  // `qualityRefusedButGatePassed`, not as a violation.
  const implausibleScale = quality.reasons.some(
    (r) => r === "player_too_small_in_frame" || r === "player_too_close_or_cropped",
  );
  const componentRefused =
    !frame.analyzable || capture.sequence.frames.length === 0 || implausibleScale;
  if (gate.ok && componentRefused) {
    violations.push({
      invariant: "pre_gate_fails_closed",
      detail: `frame.analyzable=${frame.analyzable} poseFrames=${capture.sequence.frames.length} implausibleScale=${implausibleScale} but gate ok`,
    });
  }
  if (gate.ok && (!gate.value.analyzable || gate.value.reasons.length > 0)) {
    violations.push({
      invariant: "pre_gate_ok_means_no_reasons",
      detail: `gate ok with analyzable=${gate.value.analyzable} reasons=[${gate.value.reasons.join(",")}]`,
    });
  }
  if (!gate.ok && !componentRefused) {
    violations.push({
      invariant: "pre_gate_no_spurious_refusal",
      detail: `gate failed ${gate.failure.code} while both components were analyzable`,
    });
  }
}

/**
 * Record-level invariants: the result must be COMPLETE when it claims to be
 * a score, and every abstention must be explicit and explained.
 */
function checkRecordInvariants(
  capture: SynthCapture,
  input: CaptureAnalysisInput,
  record: CaptureAnalysisRecord,
  violations: Violation[],
): void {
  const nonFinite = findNonFiniteNumbers(record);
  if (nonFinite.length > 0) {
    violations.push({
      invariant: "record_has_no_non_finite_numbers",
      detail: nonFinite.join(", "),
    });
  }
  const result = record.result;
  if (result === null) {
    if (record.uncertainty.presentation !== "abstain") {
      violations.push({
        invariant: "null_result_is_explicit_abstention",
        detail: `result null but presentation=${record.uncertainty.presentation}`,
      });
    }
    return;
  }
  const clipStart = 0;
  const clipEnd = capture.clipDurationMs;
  for (const phase of result.phases) {
    if (phase.startMs > phase.endMs) {
      violations.push({
        invariant: "phases_ordered",
        detail: `${phase.key} start ${phase.startMs} > end ${phase.endMs}`,
      });
    }
    if (
      phase.representativeMs < phase.startMs - 1e-6 ||
      phase.representativeMs > phase.endMs + 1e-6
    ) {
      violations.push({
        invariant: "phase_representative_inside_span",
        detail: `${phase.key} representative ${phase.representativeMs} outside [${phase.startMs}, ${phase.endMs}]`,
      });
    }
    if (phase.startMs < input.trigger.startMs - 1e-6 || phase.endMs > input.trigger.endMs + 1e-6) {
      violations.push({
        invariant: "phases_inside_trigger_window",
        detail: `${phase.key} [${phase.startMs}, ${phase.endMs}] outside trigger [${input.trigger.startMs}, ${input.trigger.endMs}]`,
      });
    }
    if (phase.startMs < clipStart - 1e-6 || phase.endMs > clipEnd + 1e-6) {
      violations.push({
        invariant: "phases_inside_clip",
        detail: `${phase.key} [${phase.startMs}, ${phase.endMs}] outside clip [0, ${clipEnd}]`,
      });
    }
  }
  for (let i = 1; i < result.phases.length; i += 1) {
    const previous = result.phases[i - 1]!;
    const current = result.phases[i]!;
    if (current.startMs < previous.endMs - 1e-6) {
      violations.push({
        invariant: "phases_non_overlapping",
        detail: `${current.key} starts ${current.startMs} before ${previous.key} ends ${previous.endMs}`,
      });
    }
  }
  if (result.timestamps.contactMs !== null) {
    const c = result.timestamps.contactMs;
    if (c < input.trigger.startMs - 1e-6 || c > input.trigger.endMs + 1e-6) {
      violations.push({
        invariant: "contact_inside_trigger_window",
        detail: `contactMs ${c} outside [${input.trigger.startMs}, ${input.trigger.endMs}]`,
      });
    }
  }

  if (result.resultKind === "scored") {
    if (result.overallScore === null || result.overallScore < 0 || result.overallScore > 10) {
      violations.push({
        invariant: "scored_has_bounded_overall_score",
        detail: `overallScore=${String(result.overallScore)}`,
      });
    }
    if (record.uncertainty.presentation === "abstain") {
      violations.push({
        invariant: "scored_is_not_abstain",
        detail: "resultKind scored while uncertainty.presentation=abstain",
      });
    }
    const core = ["phase_segmentation", "biomechanics_extraction", "technique_scoring"];
    for (const task of core) {
      const runs = record.modelRuns.filter((run) => run.task === task);
      if (runs.length === 0) {
        violations.push({
          invariant: "scored_has_core_model_runs",
          detail: `no model run recorded for ${task}`,
        });
      } else if (!runs.some((run) => run.status === "succeeded")) {
        violations.push({
          invariant: "scored_core_runs_succeeded",
          detail: `${task} runs: ${runs.map((run) => run.status).join(",")}`,
        });
      }
    }
    if (result.measurements.length === 0) {
      violations.push({
        invariant: "scored_has_measurements",
        detail: "resultKind scored with zero measurements",
      });
    }
    if (result.checkpoints.length === 0) {
      violations.push({
        invariant: "scored_has_checkpoints",
        detail: "resultKind scored with zero checkpoints",
      });
    }
    const windowFrames = capture.sequence.frames.filter(
      (f) => f.timestampMs >= input.trigger.startMs && f.timestampMs <= input.trigger.endMs,
    ).length;
    if (windowFrames < 6) {
      violations.push({
        invariant: "scored_requires_min_window_frames",
        detail: `scored with only ${windowFrames} pose frames inside the trigger window`,
      });
    }
    for (const run of record.modelRuns) {
      if (run.status !== "succeeded" && run.failure === null) {
        violations.push({
          invariant: "non_succeeded_run_carries_failure",
          detail: `${run.task} status=${run.status} without failure`,
        });
      }
    }
  } else {
    if (result.overallScore !== null) {
      violations.push({
        invariant: "low_confidence_has_null_score",
        detail: `low_confidence result carries overallScore=${result.overallScore}`,
      });
    }
    if (!result.guidance && record.uncertainty.limitingFactors.length === 0) {
      violations.push({
        invariant: "abstention_is_explained",
        detail: "low_confidence result without guidance or limitingFactors",
      });
    }
  }
}
