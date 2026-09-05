/**
 * Runs adversarial pose fixtures through the SAME TypeScript stages the
 * shipping iOS analysis path uses (apps/mobile/src/analysis/runCaptureAnalysis.ts
 * → apps/mobile/src/vision/providers.ts `createFusionProviders` →
 * packages/analysis-pipeline `analyzeCapture`):
 *
 *   1. sidecar parse  — serializePoseSequence → parsePoseSequence (the
 *      mobile sidecar reader; hard validation, no repair);
 *   2. fusion         — analyzeCapture with the production provider bundle
 *      (GeometricPhaseSegmenter, GeometryBiomechanicsExtractor,
 *      Sm1TechniqueScorer, CheckpointThresholdFaultDetector,
 *      EngineUncertaintyEstimator, PriorityCoachingRanker, and the
 *      heuristic hierarchical classifier exactly as mobile adapts it).
 *
 * Also recorded per row: the verdict of the library pose-quality gate
 * `evaluateCaptureQuality` from @pickle/vision-geometry, computed here
 * independently of the pipeline. runCaptureAnalysis.ts runs it (via
 * evaluatePreAnalysisGate) before analyzeCapture, and analyzeCapture enforces
 * it again at the engine boundary; logging it beside the fusion outcome keeps
 * the gap between "what the library refuses" and "what was scored" measurable
 * (it must be zero for analyzable=false rows).
 *
 * Nothing here touches native code, Apple Vision, or the device: the pose
 * inputs are synthetic or committed sidecars, and every row records that.
 */
import { performance } from "node:perf_hooks";
import { ok } from "@pickle/shared-types";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { parsePoseSequence, serializePoseSequence, unavailable } from "@pickle/swing-domain";
import {
  classifyStroke,
  evaluateCaptureQuality,
  GeometricPhaseSegmenter,
  GeometryBiomechanicsExtractor,
} from "@pickle/vision-geometry";
import {
  analyzeCapture,
  type FusionProviders,
  type IHierarchicalStrokeClassifier,
} from "../../src/index.js";
import type { Fixture } from "./fixtures.js";

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

/**
 * Mirrors apps/mobile/src/vision/providers.ts HeuristicHierarchicalStrokeClassifier:
 * the classifier logic is the production `classifyStroke`; only the
 * descriptor is harness-local (the model-registry entry
 * stroke.heuristic-hierarchical@stroke-heuristic-7).
 */
class MobileEquivalentHierarchicalClassifier implements IHierarchicalStrokeClassifier {
  public readonly descriptor = {
    providerId: "stroke.heuristic-hierarchical",
    modelVersion: "stroke-heuristic-7",
    runtime: "deterministic" as const,
    executionTarget: "on_device" as const,
    artifactHash: null,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
  };

  public async classify(
    input: Parameters<IHierarchicalStrokeClassifier["classify"]>[0],
  ): ReturnType<IHierarchicalStrokeClassifier["classify"]> {
    return ok(
      classifyStroke({
        sequence: input.pose,
        window: input.window,
        contactMs: input.contactMs,
        eventPeakMs: input.eventPeakMs,
        handedness: input.handedness,
        paddle: null,
        paddleSpeeds: null,
        wristSpeeds: null,
      }),
    );
  }
}

export function mobileEquivalentProviders(): FusionProviders {
  return {
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    autoStrokeClassifier: new MobileEquivalentHierarchicalClassifier(),
    shadowScorers: [],
  };
}

export type Stage = "sidecar_parse" | "fusion";
export type Outcome = "rejected" | "abstained" | "scored_lower_confidence" | "scored_normal";
export type Verdict =
  | "honest"
  | "confident_wrong"
  | "lower_confidence_wrong"
  | "control_ok"
  | "control_failed"
  | "info";

export interface RowResult {
  id: string;
  family: Fixture["family"];
  seed: number | null;
  params: Fixture["params"];
  description: string;
  declared: string | null;
  expected: Fixture["expected"];
  frames: number;
  /** Frame-to-frame torso-centre displacement (normalized units); a body
   * jumping between people shows up as a large max jump. */
  torsoJump: { maxNorm: number; p95Norm: number; framesOverTenPercent: number };
  /** Library gate verdict, computed independently of the pipeline for the gap analysis. */
  libraryQuality: {
    analyzable: boolean;
    reasons: string[];
    medianTorsoLengthNorm: number;
    meanFrameConfidence: number;
  };
  stage: Stage;
  outcome: Outcome;
  failureCode: string | null;
  failureMessage: string | null;
  resultKind: string | null;
  overallScore: number | null;
  analysisConfidence: number | null;
  presentation: string | null;
  guidance: string | null;
  limitingFactors: string[];
  checkpointScores: Record<string, number | null>;
  strokeResolution: string | null;
  disagreement: string | null;
  /** Where the pipeline placed contact, and the measured pose frames nearest to it (ms). */
  contactMs: number | null;
  nearestFrameToContactMs: number | null;
  phases: Array<{
    key: string;
    startMs: number;
    representativeMs: number;
    endMs: number;
    confidence: number;
  }>;
  /** The exact message the app's "Nothing was rated." error surface would show. */
  userFacingMessage: string | null;
  durationMs: number;
  verdict: Verdict;
}

function verdictFor(expected: Fixture["expected"], outcome: Outcome): Verdict {
  if (expected === "control_scored")
    return outcome === "scored_normal" ? "control_ok" : "control_failed";
  if (expected === "informational") return "info";
  if (outcome === "scored_normal") return "confident_wrong";
  if (outcome === "scored_lower_confidence") return "lower_confidence_wrong";
  return "honest";
}

function torsoJumpStats(sequence: Fixture["sequence"]): RowResult["torsoJump"] {
  const centres: Array<{ x: number; y: number }> = [];
  for (const frame of sequence.frames) {
    const pts = frame.landmarks.filter(
      (mark) =>
        mark.name === "left_shoulder" ||
        mark.name === "right_shoulder" ||
        mark.name === "left_hip" ||
        mark.name === "right_hip",
    );
    if (pts.length < 2) continue;
    centres.push({
      x: pts.reduce((sum, mark) => sum + mark.x, 0) / pts.length,
      y: pts.reduce((sum, mark) => sum + mark.y, 0) / pts.length,
    });
  }
  const jumps: number[] = [];
  for (let index = 1; index < centres.length; index += 1) {
    const a = centres[index - 1];
    const b = centres[index];
    if (!a || !b) continue;
    jumps.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  jumps.sort((x, y) => x - y);
  return {
    maxNorm: jumps.length ? (jumps[jumps.length - 1] ?? 0) : 0,
    p95Norm: jumps.length
      ? (jumps[Math.min(jumps.length - 1, Math.floor(jumps.length * 0.95))] ?? 0)
      : 0,
    framesOverTenPercent: jumps.filter((jump) => jump > 0.1).length,
  };
}

let counter = 0;

export async function runFixture(
  fixture: Fixture,
  providers: FusionProviders = mobileEquivalentProviders(),
): Promise<RowResult> {
  const started = performance.now();
  const libraryReport = evaluateCaptureQuality(fixture.sequence);
  const libraryQuality = {
    analyzable: libraryReport.analyzable,
    reasons: libraryReport.reasons,
    medianTorsoLengthNorm: libraryReport.stats.medianTorsoLengthNorm,
    meanFrameConfidence: libraryReport.stats.meanFrameConfidence,
  };
  const common = {
    id: fixture.id,
    family: fixture.family,
    seed: fixture.seed,
    params: fixture.params,
    description: fixture.description,
    declared: fixture.declared,
    expected: fixture.expected,
    frames: fixture.sequence.frames.length,
    torsoJump: torsoJumpStats(fixture.sequence),
    libraryQuality,
  };

  // Stage 1: the mobile sidecar reader.
  const parsed = parsePoseSequence(serializePoseSequence(fixture.sequence), {
    providerId: fixture.sequence.producedBy.providerId,
    runtime: fixture.sequence.producedBy.runtime,
    executionTarget: fixture.sequence.producedBy.executionTarget,
    artifactHash: fixture.sequence.producedBy.artifactHash,
  });
  if (!parsed.ok) {
    return {
      ...common,
      stage: "sidecar_parse",
      outcome: "rejected",
      failureCode: parsed.failure.code,
      failureMessage: parsed.failure.message,
      resultKind: null,
      overallScore: null,
      analysisConfidence: null,
      presentation: null,
      guidance: null,
      limitingFactors: [],
      checkpointScores: {},
      strokeResolution: null,
      disagreement: null,
      contactMs: null,
      nearestFrameToContactMs: null,
      phases: [],
      userFacingMessage: parsed.failure.message,
      durationMs: performance.now() - started,
      verdict: verdictFor(fixture.expected, "rejected"),
    };
  }

  // Stage 2: the fusion engine with the production provider bundle.
  counter += 1;
  const result = await analyzeCapture(
    providers,
    {
      captureId: `capture-${fixture.id}`,
      pose: parsed.value,
      paddle: unavailable("paddle_detector_not_installed"),
      ball: unavailable("ball_tracker_not_installed"),
      trigger: {
        startMs: fixture.trigger.startMs,
        endMs: fixture.trigger.endMs,
        peakMotionMs: fixture.trigger.peakMotionMs,
        confidence: 0.9,
        producedBy: TRIGGER_MODEL,
      },
      stroke: { declared: fixture.declared, predicted: null },
      handedness: fixture.handedness,
      cameraView: "side",
      capturedAtIso: "2026-09-04T00:00:00.000Z",
    },
    {
      analysisId: `analysis-${counter}`,
      sessionId: null,
      appVersion: "harness",
      modelBundleVersion: "xc-cv-abstention-harness",
      nowIso: () => "2026-09-04T00:00:00.000Z",
      makeId: () => `run-${counter}-${++counter}`,
    },
  );
  const durationMs = performance.now() - started;
  if (!result.ok) {
    return {
      ...common,
      stage: "fusion",
      outcome: "rejected",
      failureCode: result.failure.code,
      failureMessage: result.failure.message,
      resultKind: null,
      overallScore: null,
      analysisConfidence: null,
      presentation: null,
      guidance: null,
      limitingFactors: [],
      checkpointScores: {},
      strokeResolution: null,
      disagreement: null,
      contactMs: null,
      nearestFrameToContactMs: null,
      phases: [],
      userFacingMessage: result.failure.message,
      durationMs,
      verdict: verdictFor(fixture.expected, "rejected"),
    };
  }
  const record = result.value;
  const scored = record.result;
  const outcome: Outcome =
    scored === null || scored.resultKind === "low_confidence"
      ? "abstained"
      : record.uncertainty.presentation === "lower_confidence"
        ? "scored_lower_confidence"
        : "scored_normal";
  const checkpointScores: Record<string, number | null> = {};
  for (const checkpoint of scored?.checkpoints ?? [])
    checkpointScores[checkpoint.key] = checkpoint.score;
  const contactMs = scored?.timestamps.contactMs ?? null;
  let nearestFrameToContactMs: number | null = null;
  if (contactMs !== null) {
    for (const frame of fixture.sequence.frames) {
      const delta = Math.abs(frame.timestampMs - contactMs);
      if (nearestFrameToContactMs === null || delta < nearestFrameToContactMs)
        nearestFrameToContactMs = delta;
    }
  }
  return {
    ...common,
    stage: "fusion",
    outcome,
    failureCode: null,
    failureMessage: null,
    resultKind: scored?.resultKind ?? null,
    overallScore: scored?.overallScore ?? null,
    analysisConfidence: record.uncertainty.analysisConfidence,
    presentation: record.uncertainty.presentation,
    guidance: scored?.guidance ?? null,
    limitingFactors: record.uncertainty.limitingFactors,
    checkpointScores,
    strokeResolution: JSON.stringify(record.strokeResolution),
    disagreement: record.strokeIntent.disagreement
      ? JSON.stringify(record.strokeIntent.disagreement)
      : null,
    contactMs,
    nearestFrameToContactMs,
    phases: (scored?.phases ?? []).map((span) => ({
      key: span.key,
      startMs: span.startMs,
      representativeMs: span.representativeMs,
      endMs: span.endMs,
      confidence: span.confidence,
    })),
    userFacingMessage: outcome === "abstained" ? (scored?.guidance ?? null) : null,
    durationMs,
    verdict: verdictFor(fixture.expected, outcome),
  };
}

export interface FamilyMatrixRow {
  family: string;
  rows: number;
  rejected_parse: number;
  rejected_fusion: number;
  abstained: number;
  scored_lower_confidence: number;
  scored_normal: number;
  confident_wrong: number;
  lower_confidence_wrong: number;
  control_failed: number;
}

export function familyMatrix(rows: RowResult[]): FamilyMatrixRow[] {
  const byFamily = new Map<string, FamilyMatrixRow>();
  for (const row of rows) {
    const entry = byFamily.get(row.family) ?? {
      family: row.family,
      rows: 0,
      rejected_parse: 0,
      rejected_fusion: 0,
      abstained: 0,
      scored_lower_confidence: 0,
      scored_normal: 0,
      confident_wrong: 0,
      lower_confidence_wrong: 0,
      control_failed: 0,
    };
    entry.rows += 1;
    if (row.outcome === "rejected") {
      if (row.stage === "sidecar_parse") entry.rejected_parse += 1;
      else entry.rejected_fusion += 1;
    } else entry[row.outcome] += 1;
    if (row.verdict === "confident_wrong") entry.confident_wrong += 1;
    if (row.verdict === "lower_confidence_wrong") entry.lower_confidence_wrong += 1;
    if (row.verdict === "control_failed") entry.control_failed += 1;
    byFamily.set(row.family, entry);
  }
  return [...byFamily.values()];
}

/** Failure-code histogram: which rejection reasons the pipeline actually emits. */
export function codeHistogram(rows: RowResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key =
      row.outcome === "rejected"
        ? `${row.stage}:${row.failureCode ?? "?"}`
        : `${row.outcome}${row.presentation ? `:${row.presentation}` : ""}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
