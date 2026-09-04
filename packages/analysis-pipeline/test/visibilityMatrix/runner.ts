import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import type { Measurement } from "@pickle/shared-types";
import { unavailable, type PoseSequence } from "@pickle/swing-domain";
import {
  evaluateCaptureQuality,
  GeometricPhaseSegmenter,
  GeometryBiomechanicsExtractor,
  type CaptureQualityReport,
} from "@pickle/vision-geometry";
import {
  analyzeCapture,
  evaluatePreAnalysisGate,
  type CaptureAnalysisRecord,
  type FusionProviders,
  type PreAnalysisGateDecision,
} from "../../src/index.js";
import type { ScenarioCase } from "./scenarios.js";

/**
 * Runs one synthesized case through the SAME stages the shipping app runs
 * (apps/mobile/src/analysis/runCaptureAnalysis.ts → analyzeCapture with the
 * on-device provider bundle from apps/mobile/src/vision/providers.ts) and,
 * beside it, through the committed pose-quality gates the app does NOT call
 * today (evaluateCaptureQuality → evaluatePreAnalysisGate), so the matrix
 * can show where the gates and the scoring path disagree.
 */

export type FusionOutcome =
  | { kind: "failed"; failureKind: string; code: string; message: string }
  | { kind: "abstained_partial"; strokeResolution: string }
  | {
      kind: "low_confidence";
      analysisConfidence: number;
      limitingFactors: string[];
      measurementCount: number;
    }
  | {
      kind: "scored";
      overallScore: number;
      analysisConfidence: number;
      presentation: "normal" | "lower_confidence";
      limitingFactors: string[];
      measurementCount: number;
      contactMs: number | null;
    };

export interface MetricError {
  metricKey: string;
  unit: string;
  measured: number;
  confidence: number;
  /** Same metric measured on the untouched reference stream (null = reference omitted it). */
  reference: number | null;
  /** |measured − reference| relative to max(|reference|, unit floor); null when no reference. */
  relDeviation: number | null;
  /** Synthetic ground truth when the generator defines one for this metric. */
  truth: number | null;
  relErrorVsTruth: number | null;
}

export interface CaseResult {
  scenarioId: string;
  seed: number;
  expectation: ScenarioCase["expectation"];
  params: ScenarioCase["params"];
  frames: number;
  fps: number;
  handedness: string;
  quality: {
    analyzable: boolean;
    reasons: string[];
    medianTorsoLengthNorm: number;
    fullBodyFrameRate: number;
    meanFrameConfidence: number;
    largestGapMs: number;
  };
  preGate: { analyzable: boolean; reasons: string[]; notEvaluated: string[] };
  fusion: FusionOutcome;
  /** Same seed's untouched reference stream through the same pipeline. */
  reference: {
    outcome: FusionOutcome["kind"];
    overallScore: number | null;
    analysisConfidence: number | null;
    contactMs: number | null;
  };
  /** Deviation of the degraded score from the clean reference (null when either abstained). */
  scoreDelta: number | null;
  /** Degraded contact phase timestamp minus the reference's (null when either is absent). */
  contactShiftMs: number | null;
  /** Every reported metric, compared with the reference stream and with synthetic truth. */
  metricErrors: MetricError[];
  /** Hard invariant breaches (see violationsFor). */
  violations: string[];
  /** Soft observations recorded for the tables, never asserted (see diagnosticsFor). */
  diagnostics: string[];
  durationMs: number;
}

export function shippingProviders(): FusionProviders {
  return {
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    autoStrokeClassifier: null,
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

let counter = 0;

async function runFusion(
  sequence: PoseSequence,
  scenario: ScenarioCase,
): Promise<{ outcome: FusionOutcome; record: CaptureAnalysisRecord | null }> {
  const result = await analyzeCapture(
    shippingProviders(),
    {
      captureId: `visibility-${scenario.scenarioId}-${scenario.seed}`,
      pose: sequence,
      paddle: unavailable("paddle_detector_not_installed"),
      ball: unavailable("ball_tracker_not_installed"),
      trigger: {
        startMs: scenario.window.startMs,
        endMs: scenario.window.endMs,
        peakMotionMs: scenario.peakHintMs,
        confidence: 0.9,
        producedBy: TRIGGER_MODEL,
      },
      stroke: { declared: "forehand_drive", predicted: null },
      handedness: scenario.handedness,
      cameraView: "side",
      capturedAtIso: "2026-09-04T00:00:00.000Z",
    },
    {
      analysisId: `analysis-${++counter}`,
      sessionId: null,
      appVersion: "matrix",
      modelBundleVersion: "on-device-fusion-1",
      nowIso: () => "2026-09-04T00:00:00.000Z",
      makeId: () => `run-${++counter}`,
    },
  );
  if (!result.ok) {
    return {
      outcome: {
        kind: "failed",
        failureKind: result.failure.kind,
        code: result.failure.code,
        message: result.failure.message,
      },
      record: null,
    };
  }
  const record = result.value;
  if (!record.result) {
    return {
      outcome: { kind: "abstained_partial", strokeResolution: record.strokeResolution.kind },
      record,
    };
  }
  if (record.result.resultKind !== "scored" || record.result.overallScore === null) {
    return {
      outcome: {
        kind: "low_confidence",
        analysisConfidence: record.uncertainty.analysisConfidence,
        limitingFactors: record.uncertainty.limitingFactors,
        measurementCount: record.result.measurements.length,
      },
      record,
    };
  }
  const contact = record.result.phases.find((phase) => phase.key === "contact");
  return {
    outcome: {
      kind: "scored",
      overallScore: record.result.overallScore,
      analysisConfidence: record.uncertainty.analysisConfidence,
      presentation: record.uncertainty.presentation === "normal" ? "normal" : "lower_confidence",
      limitingFactors: record.uncertainty.limitingFactors,
      measurementCount: record.result.measurements.length,
      contactMs: contact ? contact.representativeMs : null,
    },
    record,
  };
}

/**
 * Relative-deviation floors per unit so a near-zero reference value does not
 * turn sensor noise into an infinite relative error.
 */
const UNIT_FLOOR: Record<string, number> = {
  normalized: 0.1,
  ratio: 0.1,
  deg: 5,
  ms: 50,
};

function metricErrors(
  measurements: readonly Measurement[],
  referenceMeasurements: readonly Measurement[],
  truth: ScenarioCase["truth"],
): MetricError[] {
  const truthByMetric: Record<string, number> = {
    contact_height_ratio: truth.contactHeightRatio,
    contact_forward_of_hip_norm: truth.contactForwardNorm,
    knee_flexion_deg: truth.kneeFlexionDeg,
    stance_width_ratio: truth.stanceWidthRatio,
    backswing_length_norm: truth.backswingLengthNorm,
    shoulder_turn_deg: truth.shoulderTurnDeg,
  };
  const errors: MetricError[] = [];
  for (const measurement of measurements) {
    const reference =
      referenceMeasurements.find((entry) => entry.metricKey === measurement.metricKey) ?? null;
    const floor = UNIT_FLOOR[measurement.unit] ?? 0.1;
    const expected = truthByMetric[measurement.metricKey] ?? null;
    errors.push({
      metricKey: measurement.metricKey,
      unit: measurement.unit,
      measured: measurement.value,
      confidence: measurement.confidence,
      reference: reference ? reference.value : null,
      relDeviation: reference
        ? Math.abs(measurement.value - reference.value) / Math.max(Math.abs(reference.value), floor)
        : null,
      truth: expected,
      relErrorVsTruth:
        expected !== null
          ? Math.abs(measurement.value - expected) / Math.max(Math.abs(expected), floor)
          : null,
    });
  }
  return errors;
}

function summarizeQuality(report: CaptureQualityReport): CaseResult["quality"] {
  return {
    analyzable: report.analyzable,
    reasons: [...report.reasons],
    medianTorsoLengthNorm: report.stats.medianTorsoLengthNorm,
    fullBodyFrameRate: report.stats.fullBodyFrameRate,
    meanFrameConfidence: report.stats.meanFrameConfidence,
    largestGapMs: report.stats.largestGapMs,
  };
}

function summarizeGate(decision: PreAnalysisGateDecision): CaseResult["preGate"] {
  return {
    analyzable: decision.analyzable,
    reasons: [...decision.reasons],
    notEvaluated: [...decision.notEvaluated],
  };
}

/**
 * Invariants checked per case. Each id names one concrete failure mode; the
 * list in `violations` is what the matrix test asserts on.
 *
 *  scored_when_must_abstain
 *      No analyzable player stroke in the tracked keypoints, yet a score
 *      (any presentation) was produced → confident wrong score.
 *  confident_when_must_not_be_confident
 *      Degraded body; a score was produced with presentation "normal"
 *      (analysisConfidence ≥ 0.8) → uncertainty path did not fire.
 *  confident_score_on_pose_quality_reject
 *      The committed pose-quality gate rejects this stream, yet the
 *      shipping scoring path scored it with presentation "normal".
 *  abstained_on_clean_control
 *      The clean control did not score — the harness baseline is broken or
 *      the pipeline regressed.
 */
function violationsFor(
  scenario: ScenarioCase,
  quality: CaseResult["quality"],
  fusion: FusionOutcome,
): string[] {
  const violations: string[] = [];
  const scored = fusion.kind === "scored";
  const confident = fusion.kind === "scored" && fusion.presentation === "normal";
  if (scenario.expectation === "must_abstain" && scored) {
    violations.push("scored_when_must_abstain");
  }
  if (scenario.expectation === "must_not_be_confident" && confident) {
    violations.push("confident_when_must_not_be_confident");
  }
  if (!quality.analyzable && confident) {
    violations.push("confident_score_on_pose_quality_reject");
  }
  if (scenario.expectation === "must_score" && !scored) {
    violations.push("abstained_on_clean_control");
  }
  return violations;
}

/**
 * Soft observations (never asserted; they describe how the score moved).
 *
 *  confident_metric_deviation
 *      Presentation "normal" while a reported metric deviates > 25 % from the
 *      SAME seed's clean reference measurement and still carries measurement
 *      confidence ≥ 0.8 — the uncertainty model did not see the change.
 *  score_moved_over_1pt
 *      Scored, and |overallScore − reference| > 1.0 on the 10-point scale.
 *  contact_shifted_over_100ms
 *      Scored, and the contact phase moved > 100 ms from the reference's.
 */
function diagnosticsFor(
  fusion: FusionOutcome,
  errors: readonly MetricError[],
  scoreDelta: number | null,
  contactShiftMs: number | null,
): string[] {
  const diagnostics: string[] = [];
  const confident = fusion.kind === "scored" && fusion.presentation === "normal";
  if (
    confident &&
    errors.some(
      (error) =>
        error.relDeviation !== null && error.relDeviation > 0.25 && error.confidence >= 0.8,
    )
  ) {
    diagnostics.push("confident_metric_deviation");
  }
  if (scoreDelta !== null && Math.abs(scoreDelta) > 1) diagnostics.push("score_moved_over_1pt");
  if (contactShiftMs !== null && Math.abs(contactShiftMs) > 100) {
    diagnostics.push("contact_shifted_over_100ms");
  }
  return diagnostics;
}

export async function runCase(scenario: ScenarioCase): Promise<CaseResult> {
  const startedAt = performance.now();
  const qualityReport = evaluateCaptureQuality(scenario.sequence);
  const quality = summarizeQuality(qualityReport);
  const preGate = summarizeGate(
    evaluatePreAnalysisGate({ frame: null, pose: scenario.sequence, poseQuality: qualityReport }),
  );
  const [degraded, reference] = await Promise.all([
    runFusion(scenario.sequence, scenario),
    runFusion(scenario.reference, scenario),
  ]);
  const referenceScore =
    reference.outcome.kind === "scored" ? reference.outcome.overallScore : null;
  const referenceConfidence =
    reference.outcome.kind === "scored" || reference.outcome.kind === "low_confidence"
      ? reference.outcome.analysisConfidence
      : null;
  const referenceContact = reference.outcome.kind === "scored" ? reference.outcome.contactMs : null;
  const degradedScore = degraded.outcome.kind === "scored" ? degraded.outcome.overallScore : null;
  const degradedContact = degraded.outcome.kind === "scored" ? degraded.outcome.contactMs : null;
  const errors = degraded.record?.result
    ? metricErrors(
        degraded.record.result.measurements,
        reference.record?.result?.measurements ?? [],
        scenario.truth,
      )
    : [];
  const scoreDelta =
    referenceScore !== null && degradedScore !== null ? degradedScore - referenceScore : null;
  const contactShiftMs =
    referenceContact !== null && degradedContact !== null
      ? degradedContact - referenceContact
      : null;
  return {
    scenarioId: scenario.scenarioId,
    seed: scenario.seed,
    expectation: scenario.expectation,
    params: scenario.params,
    frames: scenario.sequence.frames.length,
    fps: scenario.sequence.video.fps,
    handedness: scenario.handedness,
    quality,
    preGate,
    fusion: degraded.outcome,
    reference: {
      outcome: reference.outcome.kind,
      overallScore: referenceScore,
      analysisConfidence: referenceConfidence,
      contactMs: referenceContact,
    },
    scoreDelta,
    contactShiftMs,
    metricErrors: errors,
    violations: violationsFor(scenario, quality, degraded.outcome),
    diagnostics: diagnosticsFor(degraded.outcome, errors, scoreDelta, contactShiftMs),
    durationMs: performance.now() - startedAt,
  };
}
