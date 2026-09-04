/**
 * randomized-pipeline-D — seeded adversarial harness over the analysis
 * pipeline's segmentation + classification surfaces.
 *
 * Everything here is SYNTHETIC: pose streams come from the committed
 * deterministic swing generator (@pickle/evaluation, provider
 * `synthetic.swing-generator`) and are perturbed with a seeded RNG. No human
 * data, no ground-truth labels are invented — the only "expected" label is
 * the one the synthetic fixture was generated as (a right/left-handed
 * forehand drive, the same fixture the existing analyzeCapture tests rely
 * on), and the harness never asserts a stroke label beyond what that fixture
 * supports.
 *
 * Surfaces exercised (all production code, never modified here):
 *   1. GeometricPhaseSegmenter.segmentPhases   (phase segmentation)
 *   2. classifyStroke (stroke-heuristic-lite)  (hierarchical classification)
 *   3. analyzeCapture (fusion engine)          (declared + AUTO paths)
 *   4. SessionEventEngine                      (streaming event segmentation)
 *
 * Perturbations (per seed, common-random-numbers so ladders are coupled):
 *   - keypoint gaussian noise  (σ in normalized image units)
 *   - landmark dropout         (landmark removed from the frame — never
 *                               filled, matching the canonical "gaps are
 *                               real" contract)
 *   - visibility degradation   (per-landmark visibility + frame confidence)
 *   - frame dropout            (whole frames removed)
 *   - timing jitter            (timestamps perturbed, order preserved)
 *   - frame reordering         (adjacent swaps → NON-monotonic timestamps)
 *
 * The harness only records what the production code returned. Properties
 * are asserted by the vitest suite next to this file; the CLI-style dump
 * (RANDOMIZED_D_OUT) writes the raw per-seed tables for replay.
 */
import { fail, failure, ok, type Result } from "@pickle/shared-types";
import type { Handedness, PoseFrame, PhaseSpan, ShotTypeSlug } from "@pickle/shared-types";
import type { CanonicalPoseFrame, PoseSequence } from "@pickle/swing-domain";
import { unavailable } from "@pickle/swing-domain";
import { generateSwingSequence, type SwingTruth } from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import {
  GeometricPhaseSegmenter,
  GeometryBiomechanicsExtractor,
  classifyStroke,
} from "@pickle/vision-geometry";
import {
  analyzeCapture,
  SessionEventEngine,
  type CaptureAnalysisInput,
  type CaptureAnalysisOptions,
  type FusionProviders,
  type IHierarchicalStrokeClassifier,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../../src/index.js";

// ─── Seeds ────────────────────────────────────────────────────────────────

export const SEED_START = 4000;
export const SEED_END = 4099;
export const SEEDS: readonly number[] = Array.from(
  { length: SEED_END - SEED_START + 1 },
  (_, index) => SEED_START + index,
);

// ─── Seeded RNG (mulberry32 + Box–Muller) ─────────────────────────────────

export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  /** Standard normal. */
  gaussian(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
}

export function makeRng(seed: number): Rng {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = (): number => {
    let u = 0;
    let v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return {
    next,
    gaussian,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + next() * (hi - lo),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error("pick() on an empty list");
      return item;
    },
  };
}

/** Derive a child seed so independent perturbation families never share a stream. */
export function childSeed(seed: number, family: string): number {
  let hash = seed >>> 0;
  for (let index = 0; index < family.length; index += 1) {
    hash = Math.imul(hash ^ family.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

// ─── Scenario (per seed) ──────────────────────────────────────────────────

export interface Scenario {
  seed: number;
  truth: Partial<SwingTruth>;
  handedness: Handedness;
  /** The synthetic fixture is generated as a forehand drive. */
  declared: ShotTypeSlug;
}

export function scenarioForSeed(seed: number): Scenario {
  const rng = makeRng(childSeed(seed, "scenario"));
  const handed: SwingTruth["handed"] = rng.next() < 0.5 ? "right" : "left";
  const fps = rng.pick([30, 60] as const);
  const round = (value: number, digits: number): number => Number(value.toFixed(digits));
  const truth: Partial<SwingTruth> = {
    handed,
    fps,
    torsoLength: round(rng.range(0.16, 0.24), 3),
    stanceWidthRatio: round(rng.range(1.05, 1.7), 3),
    kneeFlexionDeg: round(rng.range(15, 45), 1),
    contactForwardNorm: round(rng.range(0.25, 0.65), 3),
    contactHeightRatio: round(rng.range(0.3, 0.6), 3),
    backswingLengthNorm: round(rng.range(0.55, 1.05), 3),
    swingDipNorm: round(rng.range(0.06, 0.2), 3),
    shoulderTurnDeg: round(rng.range(25, 70), 1),
    readyMs: Math.round(rng.range(300, 550)),
    backswingMs: Math.round(rng.range(350, 600)),
    accelerateMs: Math.round(rng.range(180, 320)),
    followMs: Math.round(rng.range(250, 420)),
    recoverMs: Math.round(rng.range(400, 700)),
  };
  return { seed, truth, handedness: handed, declared: "forehand_drive" };
}

// ─── Perturbations ────────────────────────────────────────────────────────

export interface NoiseLevel {
  level: number;
  /** Gaussian σ on x/y, normalized image units (0..1 frame). */
  sigma: number;
  /** Per-landmark removal probability (nested across levels). */
  landmarkDropout: number;
  /** Mean per-landmark visibility at this level (frame confidence = mean visibility). */
  visibility: number;
}

/**
 * Coupled noise ladder. Each rung strictly adds degradation on every axis so
 * "confidence must not increase with the rung" is a well-posed property.
 * σ = 0.02 is ~2% of the frame (≈ 10% of a 0.2-torso), σ = 0.04 is grossly
 * unusable input and is expected to abstain often.
 */
export const NOISE_LADDER: readonly NoiseLevel[] = [
  { level: 0, sigma: 0, landmarkDropout: 0, visibility: 0.98 },
  { level: 1, sigma: 0.002, landmarkDropout: 0.01, visibility: 0.9 },
  { level: 2, sigma: 0.005, landmarkDropout: 0.03, visibility: 0.8 },
  { level: 3, sigma: 0.01, landmarkDropout: 0.08, visibility: 0.7 },
  { level: 4, sigma: 0.02, landmarkDropout: 0.15, visibility: 0.6 },
  { level: 5, sigma: 0.04, landmarkDropout: 0.3, visibility: 0.45 },
];

/** Position-only ladder: identical σ rungs, NO visibility/dropout change. */
export const POSITION_ONLY_LADDER: readonly NoiseLevel[] = NOISE_LADDER.map((rung) => ({
  ...rung,
  landmarkDropout: 0,
  visibility: 0.98,
}));

/**
 * Common random numbers for one seed: a fixed gaussian field per
 * (frame, landmark) and a fixed uniform per (frame, landmark) so every rung of
 * the ladder is a scaled view of the SAME draw (nested dropout, scaled
 * offsets). Without this, comparing rungs would compare two unrelated noise
 * realisations and monotonicity would be meaningless.
 */
export interface NoiseField {
  dx: number[][];
  dy: number[][];
  dropU: number[][];
  visJitter: number[][];
}

export function noiseField(seed: number, sequence: PoseSequence): NoiseField {
  const rng = makeRng(childSeed(seed, "noise-field"));
  const dx: number[][] = [];
  const dy: number[][] = [];
  const dropU: number[][] = [];
  const visJitter: number[][] = [];
  for (const frame of sequence.frames) {
    const fx: number[] = [];
    const fy: number[] = [];
    const fu: number[] = [];
    const fv: number[] = [];
    for (let index = 0; index < frame.landmarks.length; index += 1) {
      fx.push(rng.gaussian());
      fy.push(rng.gaussian());
      fu.push(rng.next());
      fv.push(rng.range(-0.04, 0.04));
    }
    dx.push(fx);
    dy.push(fy);
    dropU.push(fu);
    visJitter.push(fv);
  }
  return { dx, dy, dropU, visJitter };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function applyNoise(
  sequence: PoseSequence,
  field: NoiseField,
  rung: NoiseLevel,
): PoseSequence {
  const frames: CanonicalPoseFrame[] = sequence.frames.map((frame, frameIndex) => {
    const fx = field.dx[frameIndex] ?? [];
    const fy = field.dy[frameIndex] ?? [];
    const fu = field.dropU[frameIndex] ?? [];
    const fv = field.visJitter[frameIndex] ?? [];
    const landmarks = frame.landmarks.flatMap((mark, markIndex) => {
      if ((fu[markIndex] ?? 1) < rung.landmarkDropout) return [];
      const visibility = clamp01(rung.visibility + (fv[markIndex] ?? 0));
      return [
        {
          name: mark.name,
          x: clamp01(mark.x + rung.sigma * (fx[markIndex] ?? 0)),
          y: clamp01(mark.y + rung.sigma * (fy[markIndex] ?? 0)),
          visibility,
        },
      ];
    });
    const confidence =
      landmarks.length === 0
        ? 0
        : landmarks.reduce((sum, mark) => sum + mark.visibility, 0) / landmarks.length;
    return {
      frameIndex: frame.frameIndex,
      timestampMs: frame.timestampMs,
      landmarks,
      confidence: Number(confidence.toFixed(6)),
    };
  });
  return { ...sequence, frames };
}

/** Remove whole frames with probability p (seeded); frameIndex is preserved (gaps are real). */
export function applyFrameDropout(sequence: PoseSequence, seed: number, p: number): PoseSequence {
  const rng = makeRng(childSeed(seed, `frame-dropout:${p}`));
  const frames = sequence.frames.filter(() => rng.next() >= p);
  return { ...sequence, frames };
}

/**
 * Timing jitter: every timestamp moves by uniform ±jitterMs, then the
 * sequence is kept STRICTLY monotone by clamping each timestamp to be at
 * least 1ms after its predecessor (so this models sensor clock jitter, not
 * reordering — reordering is a separate perturbation).
 */
export function applyTimingJitter(
  sequence: PoseSequence,
  seed: number,
  jitterMs: number,
): PoseSequence {
  const rng = makeRng(childSeed(seed, `timing-jitter:${jitterMs}`));
  let previous = Number.NEGATIVE_INFINITY;
  const frames = sequence.frames.map((frame) => {
    const proposed = frame.timestampMs + rng.range(-jitterMs, jitterMs);
    const timestampMs = Math.max(proposed, previous + 1);
    previous = timestampMs;
    return { ...frame, timestampMs: Number(timestampMs.toFixed(3)) };
  });
  return { ...sequence, frames };
}

/**
 * Swap `swaps` random, non-overlapping adjacent frame pairs → exactly `swaps`
 * timestamp inversions (never monotone again by accident).
 */
export function applyFrameReordering(
  sequence: PoseSequence,
  seed: number,
  swaps: number,
): { sequence: PoseSequence; swappedIndices: number[] } {
  const rng = makeRng(childSeed(seed, `reorder:${swaps}`));
  const frames = [...sequence.frames];
  const swappedIndices: number[] = [];
  const used = new Set<number>();
  let attempts = 0;
  while (swappedIndices.length < swaps && frames.length >= 2 && attempts < swaps * 50) {
    attempts += 1;
    const index = rng.int(frames.length - 1);
    if (used.has(index - 1) || used.has(index) || used.has(index + 1)) continue;
    const a = frames[index];
    const b = frames[index + 1];
    if (a === undefined || b === undefined) continue;
    frames[index] = b;
    frames[index + 1] = a;
    used.add(index);
    swappedIndices.push(index);
  }
  swappedIndices.sort((x, y) => x - y);
  return { sequence: { ...sequence, frames }, swappedIndices };
}

export function isStrictlyMonotone(sequence: PoseSequence): boolean {
  for (let index = 1; index < sequence.frames.length; index += 1) {
    const previous = sequence.frames[index - 1];
    const current = sequence.frames[index];
    if (!previous || !current) return false;
    if (current.timestampMs <= previous.timestampMs) return false;
  }
  return true;
}

// ─── Legacy frame conversion (mirrors the mobile adapter, without importing it) ──

const LEGACY_LANDMARKS = new Set<string>([
  "head",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
]);

export function toLegacyFrames(sequence: PoseSequence): PoseFrame[] {
  return sequence.frames.map((frame) => ({
    timestampMs: frame.timestampMs,
    space: "normalized-image" as const,
    confidence: frame.confidence,
    landmarks: frame.landmarks
      .filter((mark) => LEGACY_LANDMARKS.has(mark.name))
      .map((mark) => ({
        name: mark.name as PoseFrame["landmarks"][number]["name"],
        x: mark.x,
        y: mark.y,
        visibility: mark.visibility,
      })),
  }));
}

// ─── Surface 1: phase segmenter ───────────────────────────────────────────

export interface SegmenterOutcome {
  ok: boolean;
  failureCode: string | null;
  failureKind: string | null;
  phases: Array<{
    key: string;
    startMs: number;
    representativeMs: number;
    endMs: number;
    confidence: number;
  }>;
  contactMs: number | null;
  /** Mean phase confidence (null when abstained). */
  confidence: number | null;
}

/** Same call analyzeCapture makes: the trigger's peak is the contact hint. */
export async function runSegmenter(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number; peakMs: number },
): Promise<SegmenterOutcome> {
  const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
  const result = await segmenter.segmentPhases(toLegacyFrames(sequence), [], {
    startMs: window.startMs,
    endMs: window.endMs,
    contactMs: window.peakMs,
    shotTypeHypothesis: null,
    confidence: 0.9,
  });
  if (!result.ok) {
    return {
      ok: false,
      failureCode: result.failure.code,
      failureKind: result.failure.kind,
      phases: [],
      contactMs: null,
      confidence: null,
    };
  }
  const phases = result.value.map((span: PhaseSpan) => ({
    key: span.key,
    startMs: round3(span.startMs),
    representativeMs: round3(span.representativeMs),
    endMs: round3(span.endMs),
    confidence: round6(span.confidence),
  }));
  const contact = result.value.find((span) => span.key === "contact");
  const confidence =
    result.value.length === 0
      ? null
      : result.value.reduce((sum, span) => sum + span.confidence, 0) / result.value.length;
  return {
    ok: true,
    failureCode: null,
    failureKind: null,
    phases,
    contactMs: contact ? round3(contact.representativeMs) : null,
    confidence: confidence === null ? null : round6(confidence),
  };
}

// ─── Surface 2: hierarchical stroke classifier (heuristic-lite) ───────────

export interface ClassifierOutcome {
  label: string;
  leaf: string | null;
  taxonomyDepth: number;
  confidence: number;
  limitingFactors: string[];
  evidenceCount: number;
  contactPointSource: string | null;
  contactPointReliability: string | null;
}

export function runClassifier(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number; peakMs: number },
  handedness: Handedness,
): ClassifierOutcome {
  const prediction = classifyStroke({
    sequence,
    window: { startMs: window.startMs, endMs: window.endMs },
    contactMs: null,
    eventPeakMs: window.peakMs,
    handedness,
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: null,
  });
  return {
    label: prediction.label,
    leaf: prediction.leaf,
    taxonomyDepth: prediction.taxonomyDepth,
    confidence: round6(prediction.confidence),
    limitingFactors: [...prediction.limitingFactors],
    evidenceCount: prediction.evidence.length,
    contactPointSource: prediction.contactPointSource ?? null,
    contactPointReliability: prediction.contactPointReliability ?? null,
  };
}

/** Production-shaped adapter: the same classifyStroke call the mobile provider makes. */
export function heuristicAutoClassifier(): IHierarchicalStrokeClassifier {
  return {
    descriptor: {
      providerId: "classifier.stroke-heuristic-lite",
      modelVersion: "stroke-heuristic-lite (harness adapter)",
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
    },
    classify: async (input) => {
      try {
        const prediction = classifyStroke({
          sequence: input.pose,
          window: input.window,
          contactMs: input.contactMs,
          eventPeakMs: input.eventPeakMs,
          handedness: input.handedness,
          paddle: null,
          paddleSpeeds: null,
          wristSpeeds: null,
        });
        return ok({
          taxonomyVersion: prediction.taxonomyVersion,
          classifierVersion: prediction.classifierVersion,
          label: prediction.label,
          leaf: prediction.leaf,
          taxonomyDepth: prediction.taxonomyDepth,
          confidence: prediction.confidence,
          evidence: prediction.evidence,
          limitingFactors: prediction.limitingFactors,
        });
      } catch (error) {
        return fail(
          failure(
            "permanent",
            "classifier.threw",
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    },
  };
}

// ─── Surface 3: analyzeCapture ────────────────────────────────────────────

export function fusionProviders(withAuto: boolean): FusionProviders {
  return {
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    shadowScorers: [],
    ...(withAuto ? { autoStrokeClassifier: heuristicAutoClassifier() } : {}),
  };
}

export function captureInputFor(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number; peakMs: number },
  handedness: Handedness,
  declared: ShotTypeSlug | null,
  captureId: string,
): CaptureAnalysisInput {
  return {
    captureId,
    pose: sequence,
    paddle: unavailable("paddle_detector_not_installed"),
    ball: unavailable("ball_tracker_not_installed"),
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.9,
      producedBy: {
        providerId: "trigger.temporal-heuristic",
        modelVersion: "temporal-stroke-heuristic-2",
        runtime: "deterministic",
        executionTarget: "on_device",
        artifactHash: null,
      },
    },
    stroke: { declared, predicted: null },
    handedness,
    cameraView: "side",
    capturedAtIso: "2026-09-04T00:00:00.000Z",
  };
}

export function fixedOptions(analysisId: string): CaptureAnalysisOptions {
  let counter = 0;
  return {
    analysisId,
    sessionId: null,
    appVersion: "0.1.0",
    modelBundleVersion: "randomized-pipeline-D",
    nowIso: () => "2026-09-04T00:00:00.000Z",
    makeId: () => `${analysisId}-run-${++counter}`,
  };
}

export interface CaptureOutcome {
  ok: boolean;
  failureCode: string | null;
  failureKind: string | null;
  /** "scored" | "low_confidence" | "no_result" (record without result) | "failed". */
  outcome: "scored" | "low_confidence" | "no_result" | "failed";
  overallScore: number | null;
  analysisConfidence: number | null;
  presentation: string | null;
  shotType: string | null;
  strokeResolutionKind: string | null;
  predictedLabel: string | null;
  predictedLeaf: string | null;
  predictedConfidence: number | null;
  contactMs: number | null;
  phaseCount: number;
  modelRunStatuses: Record<string, string>;
  limitingFactors: string[];
  crashed: boolean;
}

export async function runCapture(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number; peakMs: number },
  handedness: Handedness,
  declared: ShotTypeSlug | null,
  id: string,
): Promise<CaptureOutcome> {
  const result = await analyzeCapture(
    fusionProviders(declared === null),
    captureInputFor(sequence, window, handedness, declared, `capture-${id}`),
    fixedOptions(`analysis-${id}`),
  );
  if (!result.ok) {
    return {
      ok: false,
      failureCode: result.failure.code,
      failureKind: result.failure.kind,
      outcome: "failed",
      overallScore: null,
      analysisConfidence: null,
      presentation: null,
      shotType: null,
      strokeResolutionKind: null,
      predictedLabel: null,
      predictedLeaf: null,
      predictedConfidence: null,
      contactMs: null,
      phaseCount: 0,
      modelRunStatuses: {},
      limitingFactors: [],
      crashed: result.failure.code.endsWith("provider_crash"),
    };
  }
  const record = result.value;
  const statuses: Record<string, string> = {};
  for (const run of record.modelRuns) statuses[run.task] = run.status;
  const predicted = record.strokeIntent.predictedStroke;
  return {
    ok: true,
    failureCode: null,
    failureKind: null,
    outcome: record.result === null ? "no_result" : record.result.resultKind,
    overallScore: record.result?.overallScore ?? null,
    analysisConfidence: round6(record.uncertainty.analysisConfidence),
    presentation: record.uncertainty.presentation,
    shotType: record.result?.shotType ?? null,
    strokeResolutionKind: record.strokeResolution.kind,
    predictedLabel: predicted?.label ?? null,
    predictedLeaf: predicted?.leaf ?? null,
    predictedConfidence: predicted ? round6(predicted.confidence) : null,
    contactMs: record.result?.timestamps.contactMs ?? null,
    phaseCount: record.result?.phases.length ?? 0,
    modelRunStatuses: statuses,
    limitingFactors: [...record.uncertainty.limitingFactors].sort(),
    crashed: Object.values(statuses).includes("crashed"),
  };
}

// ─── Surface 4: SessionEventEngine ────────────────────────────────────────

export interface StreamSpec {
  seed: number;
  stepMs: number;
  durationMs: number;
  strokes: Array<{ peakMs: number; height: number; halfWidthMs: number }>;
  noiseSigma: number;
}

export function streamSpecForSeed(seed: number): StreamSpec {
  const rng = makeRng(childSeed(seed, "stream"));
  const stepMs = rng.pick([16.667, 33.333, 40] as const);
  const strokeCount = 1 + rng.int(4);
  const strokes: StreamSpec["strokes"] = [];
  let cursor = 900 + rng.range(0, 600);
  for (let index = 0; index < strokeCount; index += 1) {
    strokes.push({
      peakMs: Math.round(cursor),
      height: Number(rng.range(1.0, 4.0).toFixed(3)),
      halfWidthMs: Math.round(rng.range(80, 180)),
    });
    cursor += rng.range(1400, 3200);
  }
  return {
    seed,
    stepMs,
    durationMs: Math.round(cursor + 2500),
    strokes,
    noiseSigma: Number(rng.range(0, 0.12).toFixed(3)),
  };
}

export function wristStream(spec: StreamSpec): SpeedSample[] {
  const rng = makeRng(childSeed(spec.seed, "stream-noise"));
  const series: SpeedSample[] = [];
  for (let t = 0; t <= spec.durationMs; t += spec.stepMs) {
    let value = 0.08;
    for (const bump of spec.strokes) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    value = Math.max(0, value + spec.noiseSigma * rng.gaussian());
    series.push({ timestampMs: Number(t.toFixed(3)), value: Number(value.toFixed(6)) });
  }
  return series;
}

export interface EngineEvent {
  eventId: string;
  startMs: number;
  peakMs: number;
  endMs: number;
  peakSpeed: number;
  closeReason: string;
}

export interface EngineOutcome {
  events: EngineEvent[];
  /** Batch index (into the fed batches; flush = batches.length) in which each event closed. */
  closedInBatch: number[];
  /** Closed-event frontier (max closed endMs) after each batch was processed. */
  frontierAfterBatch: number[];
  droppedLateSamples: number;
  wristSamples: number;
  notes: string[];
  threw: string | null;
}

function summarizeEvents(emitted: readonly SessionStrokeEvent[]): EngineEvent[] {
  return emitted.map((event) => ({
    eventId: event.eventId,
    startMs: round3(event.proposal.startMs),
    peakMs: round3(event.proposal.peakMs),
    endMs: round3(event.proposal.endMs),
    peakSpeed: round6(event.proposal.peakSpeed),
    closeReason: event.closeReason,
  }));
}

/** Feed `batches` in order, then flush. */
export function runEngine(
  batches: readonly (readonly SpeedSample[])[],
  sessionId: string,
): EngineOutcome {
  const engine = new SessionEventEngine({ sessionId, captureMeta: { source: "replay" } });
  const emitted: SessionStrokeEvent[] = [];
  const closedInBatch: number[] = [];
  const frontierAfterBatch: number[] = [];
  let frontier = Number.NEGATIVE_INFINITY;
  const absorb = (closed: SessionStrokeEvent[], batchIndex: number): void => {
    for (const event of closed) {
      emitted.push(event);
      closedInBatch.push(batchIndex);
      frontier = Math.max(frontier, event.proposal.endMs);
    }
  };
  try {
    batches.forEach((batch, batchIndex) => {
      absorb(engine.push({ wrist: batch }), batchIndex);
      frontierAfterBatch.push(frontier);
    });
    absorb(engine.flush(), batches.length);
  } catch (error) {
    return {
      events: summarizeEvents(emitted),
      closedInBatch,
      frontierAfterBatch,
      droppedLateSamples: -1,
      wristSamples: -1,
      notes: [],
      threw: error instanceof Error ? error.message : String(error),
    };
  }
  const snapshot = engine.snapshot();
  return {
    events: summarizeEvents(emitted),
    closedInBatch,
    frontierAfterBatch,
    droppedLateSamples: snapshot.qualityState.droppedLateSamples,
    wristSamples: snapshot.qualityState.wristSamples,
    notes: [...snapshot.qualityState.notes],
    threw: null,
  };
}

export function oneByOne(series: readonly SpeedSample[]): SpeedSample[][] {
  return series.map((sample) => [sample]);
}

export function randomBatches(series: readonly SpeedSample[], seed: number): SpeedSample[][] {
  const rng = makeRng(childSeed(seed, "batches"));
  const batches: SpeedSample[][] = [];
  let index = 0;
  while (index < series.length) {
    const size = 1 + rng.int(12);
    batches.push(series.slice(index, index + size));
    index += size;
  }
  return batches;
}

/** Shuffle samples WITHIN each batch (the engine sorts on insert). */
export function shuffleWithinBatches(
  batches: readonly SpeedSample[][],
  seed: number,
): SpeedSample[][] {
  const rng = makeRng(childSeed(seed, "intra-batch-shuffle"));
  return batches.map((batch) => {
    const copy = [...batch];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = rng.int(index + 1);
      const a = copy[index];
      const b = copy[swap];
      if (a === undefined || b === undefined) continue;
      copy[index] = b;
      copy[swap] = a;
    }
    return copy;
  });
}

/** Sensor-clock jitter on sample timestamps, order preserved (strictly monotone). */
export function jitterSamples(
  series: readonly SpeedSample[],
  seed: number,
  jitterMs: number,
): SpeedSample[] {
  const rng = makeRng(childSeed(seed, `sample-jitter:${jitterMs}`));
  let previous = Number.NEGATIVE_INFINITY;
  return series.map((sample) => {
    const timestampMs = Math.max(
      sample.timestampMs + rng.range(-jitterMs, jitterMs),
      previous + 0.5,
    );
    previous = timestampMs;
    return { timestampMs: Number(timestampMs.toFixed(3)), value: sample.value };
  });
}

/**
 * Deliver a fraction of samples LATE: each chosen sample is removed from its
 * slot and appended `delaySamples` batches later (so it arrives behind
 * newer data — the D-030 late-sample contract says the engine must drop the
 * ones behind its frontier and count them, never rewrite history).
 */
export interface DelayedDelivery {
  /** Same batch count as the input (empty batches kept so indices line up). */
  batches: SpeedSample[][];
  delayed: Array<{ timestampMs: number; fromBatch: number; deliveredInBatch: number }>;
}

export function delaySamples(
  batches: readonly SpeedSample[][],
  seed: number,
  fraction: number,
  delayBatches: number,
): DelayedDelivery {
  const rng = makeRng(childSeed(seed, `late:${fraction}:${delayBatches}`));
  const out: SpeedSample[][] = batches.map(() => []);
  const delayed: DelayedDelivery["delayed"] = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    for (const sample of batches[batchIndex] ?? []) {
      if (rng.next() < fraction) {
        const target = Math.min(out.length - 1, batchIndex + delayBatches);
        out[target]?.push(sample);
        delayed.push({
          timestampMs: sample.timestampMs,
          fromBatch: batchIndex,
          deliveredInBatch: target,
        });
      } else {
        out[batchIndex]?.push(sample);
      }
    }
  }
  return { batches: out, delayed };
}

/**
 * Drops the engine contract predicts for a delayed delivery: a sample is
 * behind the frontier iff its timestamp ≤ the closed-event frontier that
 * stood BEFORE its delivery batch was processed.
 */
export function expectedLateDrops(delivery: DelayedDelivery, outcome: EngineOutcome): number {
  let drops = 0;
  for (const sample of delivery.delayed) {
    const frontierBefore =
      sample.deliveredInBatch === 0
        ? Number.NEGATIVE_INFINITY
        : (outcome.frontierAfterBatch[sample.deliveredInBatch - 1] ?? Number.NEGATIVE_INFINITY);
    if (sample.timestampMs <= frontierBefore) drops += 1;
  }
  return drops;
}

// ─── Utilities ────────────────────────────────────────────────────────────

export function round3(value: number): number {
  return Number(value.toFixed(3));
}

export function round6(value: number): number {
  return Number(value.toFixed(6));
}

/** Deterministic JSON (sorted keys) so equality is structural, not insertion-ordered. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) out[key] = sortKeys(entry);
    return out;
  }
  return value;
}

export function synthesize(scenario: Scenario): {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMs: number };
} {
  return generateSwingSequence(scenario.truth);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export type { Result };
