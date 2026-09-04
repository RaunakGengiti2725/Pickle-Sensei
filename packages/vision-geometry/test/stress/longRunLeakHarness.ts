import { performance } from "node:perf_hooks";
import v8 from "node:v8";
import vm from "node:vm";
import type { PoseFrame, ShotTypeSlug } from "@pickle/shared-types";
import { MVP_SHOT_TYPES } from "@pickle/shared-types";
import type { BallObservation, PoseSequence } from "@pickle/swing-domain";
import type { VideoClipRef, VisionProviderSet } from "@pickle/vision-contracts";
import { analyzeClip } from "@pickle/analysis-pipeline";
import { generateSwing, type SwingTruth } from "@pickle/evaluation";
import { createFixtureVisionProviderSet } from "../../../vision-contracts/test/support/fixtureProvider.js";
import {
  assessPaddleTrackIdentity,
  classifyStroke,
  createGeometryProviderSet,
  detectOfflineStrokeWindow,
  estimateContact,
  evaluateCaptureQuality,
  evaluateFrameAnalyzability,
  FRAME_ANALYZABILITY_REASONS,
  GEOMETRY_BUNDLE_VERSION,
  GeometryBiomechanicsExtractor,
  paddleOwnershipFromHandAffinity,
  type FrameStats,
  type HeuristicPaddleObservation,
} from "../../src/index.js";

/**
 * LONG-RUN LEAK stress harness for @pickle/vision-geometry + @pickle/vision-contracts.
 *
 * One process invokes every public surface of the unit N times (N = STRESS_ITER,
 * small default so this lives in the suite). Each iteration is driven by a
 * seeded RNG (mulberry32) so it is replayable from its seed alone: the seed
 * picks a parametric synthetic swing (the committed `generateSwing` skeleton,
 * provenance "synthetic"), a degradation mode (jitter / frame dropout /
 * truncation / frozen tracker / clean), and the auxiliary tracks (ball, paddle,
 * foreign paddle, frame stats). No labels are fabricated — property checks only:
 *   - determinism: the same seed produces byte-identical JSON on a second run
 *   - finite outputs: no NaN / ±Infinity anywhere in any returned structure
 *   - bounded abstention: every abstention carries a failure code; degraded
 *     inputs that violate the documented floors (< 6 frames in window, frozen
 *     skeleton) must abstain rather than score
 *   - cancellation: the unit exposes no async cancellation surface (all
 *     providers resolve synchronously-wrapped promises; `analyzeClip` takes no
 *     AbortSignal) — recorded as NOT_APPLICABLE, never claimed as a pass
 * Every SAMPLE_EVERY iterations the harness forces GC and records heap, RSS,
 * active handles/requests, active resource types and process listener counts,
 * and at the end fits a least-squares heap slope (percent per 100 iterations)
 * plus an invocation-time drift ratio.
 */

export const SAMPLE_EVERY = 50;
export const DEFAULT_STRESS_ITER = 60;
/** Lens rule: monotone heap slope above this (% per 100 iterations) is a finding. */
export const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
/** Late-window median invocation time may not exceed the early window by this factor. */
export const TIME_DRIFT_LIMIT_RATIO = 1.5;
/** Warm-up iterations excluded from the heap-slope fit (JIT, module caches, ICs). */
const SLOPE_WARMUP_ITERATIONS = 100;

export type DegradationMode = "clean" | "jitter" | "dropout" | "truncated" | "frozen";

export interface IterationOutcome {
  seed: number;
  iteration: number;
  mode: DegradationMode;
  handed: "right" | "left";
  fps: number;
  frameCount: number;
  durationMs: number;
  deterministic: boolean;
  finite: boolean;
  nonFinitePaths: string[];
  pipeline: { ok: boolean; code: string | null; resultKind: string | null; score: number | null };
  fixturePipeline: { ok: boolean; code: string | null; source: string | null };
  offlineWindow: { ok: boolean; code: string | null };
  contact: { status: string; confidence: number | null };
  stroke: { label: string; depth: number; confidence: number };
  identity: { verdict: string };
  ownership: { confidence: number | null; samplesMeasured: number | null };
  captureQuality: { analyzable: boolean; reasons: string[] };
  frameAnalyzability: { analyzable: boolean; reasons: string[]; unknownReasons: string[] };
  biomechanics: { ok: boolean; code: string | null; measurements: number };
  /** Property violations detected on this iteration (empty = HELD). */
  violations: string[];
}

export interface ResourceSample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  activeHandles: number;
  activeRequests: number;
  activeResources: Record<string, number>;
  processListeners: number;
  elapsedMs: number;
}

export interface CampaignSummary {
  iterations: number;
  seedBase: number;
  gcSource: "expose-gc-flag" | "v8-runtime-flag";
  retainOutcomes: boolean;
  sampleEvery: number;
  heap: {
    baselineHeapUsed: number;
    finalHeapUsed: number;
    slopeBytesPer100: number | null;
    slopePctPer100: number | null;
    monotoneIncreaseFraction: number | null;
    samplesUsed: number;
    exceeded: boolean;
  };
  handles: {
    baseline: Pick<
      ResourceSample,
      "activeHandles" | "activeRequests" | "activeResources" | "processListeners"
    >;
    final: Pick<
      ResourceSample,
      "activeHandles" | "activeRequests" | "activeResources" | "processListeners"
    >;
    returnedToBaseline: boolean;
  };
  timing: {
    earlyMedianMs: number;
    lateMedianMs: number;
    driftRatio: number;
    exceeded: boolean;
    totalMs: number;
  };
  properties: {
    deterministicAll: boolean;
    finiteAll: boolean;
    nonDeterministicSeeds: number[];
    nonFiniteSeeds: number[];
    violationSeeds: number[];
    abstention: {
      pipelineAbstainRateClean: number;
      pipelineAbstainRateDegraded: number;
      truncatedScored: number[];
      frozenScored: number[];
      codes: Record<string, number>;
    };
    cancellation: "not_applicable_no_async_cancellation_surface";
  };
}

export interface CampaignResult {
  meta: {
    unit: "pkg-vision-geometry-contracts";
    lens: "long-run-leak";
    bundleVersion: string;
    node: string;
    startedAtIso: string;
    finishedAtIso: string;
  };
  summary: CampaignSummary;
  samples: ResourceSample[];
  outcomes: IterationOutcome[];
}

// ─── Seeded RNG ────────────────────────────────────────────────────────────

/** mulberry32 — tiny, well-distributed, replayable from a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uniform(rng: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[index] as T;
}

/** Box–Muller gaussian from two uniforms. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─── Seeded synthetic scenario ─────────────────────────────────────────────

export interface Scenario {
  seed: number;
  mode: DegradationMode;
  truth: Partial<SwingTruth>;
  frames: PoseFrame[];
  clip: VideoClipRef;
  window: { startMs: number; endMs: number; peakMs: number };
  sequence: PoseSequence;
  shotType: ShotTypeSlug;
  ball: BallObservation[] | null;
  paddleCenters: Array<{ timestampMs: number; x: number; y: number }> | null;
  paddleForeign: boolean;
  frameStats: FrameStats;
}

function sequenceFrom(frames: PoseFrame[], clip: VideoClipRef): PoseSequence {
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "synthetic.swing-generator",
      modelVersion: "synthetic-swing-1",
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
    },
    video: { width: clip.width, height: clip.height, fps: clip.fps },
    frames: frames.map((frame, index) => ({
      frameIndex: index,
      timestampMs: frame.timestampMs,
      confidence: frame.confidence,
      landmarks: frame.landmarks.map((mark) => ({
        name: mark.name,
        x: mark.x,
        y: mark.y,
        visibility: mark.visibility,
      })),
    })),
  };
}

function wristTrack(
  frames: readonly PoseFrame[],
  handed: "right" | "left",
): Array<{ timestampMs: number; x: number; y: number }> {
  const name = handed === "right" ? "right_wrist" : "left_wrist";
  const out: Array<{ timestampMs: number; x: number; y: number }> = [];
  for (const frame of frames) {
    const mark = frame.landmarks.find((entry) => entry.name === name);
    if (mark) out.push({ timestampMs: frame.timestampMs, x: mark.x, y: mark.y });
  }
  return out;
}

/** Builds the fully seeded scenario for `seed`. Pure: same seed → same scenario. */
export function buildScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const handed: "right" | "left" = rng() < 0.5 ? "right" : "left";
  const fps = pick(rng, [30, 60] as const);
  const truth: Partial<SwingTruth> = {
    torsoLength: uniform(rng, 0.12, 0.3),
    stanceWidthRatio: uniform(rng, 1.0, 1.8),
    kneeFlexionDeg: uniform(rng, 15, 50),
    contactForwardNorm: uniform(rng, 0.2, 0.6),
    contactHeightRatio: uniform(rng, 0.25, 1.3),
    backswingLengthNorm: uniform(rng, 0.4, 1.2),
    swingDipNorm: uniform(rng, 0.02, 0.25),
    shoulderTurnDeg: uniform(rng, 20, 80),
    handed,
    fps,
    readyMs: Math.round(uniform(rng, 250, 600)),
    backswingMs: Math.round(uniform(rng, 300, 600)),
    accelerateMs: Math.round(uniform(rng, 150, 350)),
    followMs: Math.round(uniform(rng, 200, 450)),
    recoverMs: Math.round(uniform(rng, 300, 700)),
  };
  const swing = generateSwing(truth);
  const modeRoll = rng();
  const mode: DegradationMode =
    modeRoll < 0.5
      ? "clean"
      : modeRoll < 0.7
        ? "jitter"
        : modeRoll < 0.85
          ? "dropout"
          : modeRoll < 0.93
            ? "truncated"
            : "frozen";

  let frames: PoseFrame[] = swing.frames.map((frame) => ({
    ...frame,
    landmarks: frame.landmarks.map((mark) => ({ ...mark })),
  }));
  if (mode === "jitter") {
    const sigma = uniform(rng, 0.002, 0.02);
    frames = frames.map((frame) => ({
      ...frame,
      confidence: Math.min(1, Math.max(0, frame.confidence - uniform(rng, 0, 0.3))),
      landmarks: frame.landmarks.map((mark) => ({
        ...mark,
        x: mark.x + sigma * gaussian(rng),
        y: mark.y + sigma * gaussian(rng),
        visibility: Math.min(1, Math.max(0, mark.visibility - uniform(rng, 0, 0.4))),
      })),
    }));
  } else if (mode === "dropout") {
    const dropRate = uniform(rng, 0.1, 0.4);
    frames = frames.filter(() => rng() >= dropRate);
  } else if (mode === "truncated") {
    // Fewer than the documented 6-frame floor inside the stroke window.
    frames = frames.slice(0, Math.floor(uniform(rng, 0, 6)));
  } else if (mode === "frozen") {
    const still = frames[Math.floor(uniform(rng, 0, frames.length))] ?? frames[0];
    frames = frames.map((frame) =>
      still
        ? {
            ...frame,
            landmarks: still.landmarks.map((mark) => ({ ...mark })),
          }
        : frame,
    );
  }

  const clip: VideoClipRef = {
    uri: `synthetic://stress/${seed}`,
    durationMs: swing.clip.durationMs,
    fps: swing.clip.fps,
    width: swing.clip.width,
    height: swing.clip.height,
  };
  const sequence = sequenceFrom(frames, clip);
  const shotType = pick(rng, MVP_SHOT_TYPES);

  const wrist = wristTrack(frames, handed);
  const withBall = rng() < 0.5;
  const ball: BallObservation[] | null = withBall
    ? Array.from({ length: 12 }, (_, index) => {
        const t = swing.window.peakMs - 220 + index * 40;
        const nearest = wrist.reduce(
          (best, point) =>
            Math.abs(point.timestampMs - swing.window.peakMs) <
            Math.abs(best.timestampMs - swing.window.peakMs)
              ? point
              : best,
          wrist[0] ?? { timestampMs: 0, x: 0.5, y: 0.5 },
        );
        const progress = (t - swing.window.peakMs) / 40;
        return {
          frameIndex: index,
          timestampMs: t,
          x: nearest.x + (handed === "right" ? 1 : -1) * progress * 0.03,
          y: nearest.y - Math.abs(progress) * 0.004,
          confidence: uniform(rng, 0.4, 0.95),
        };
      })
    : null;

  const paddleRoll = rng();
  const paddleForeign = paddleRoll >= 0.6 && paddleRoll < 0.8;
  const paddleCenters =
    paddleRoll < 0.6
      ? wrist.map((point) => ({
          timestampMs: point.timestampMs,
          x: point.x + 0.05 * (handed === "right" ? 1 : -1),
          y: point.y - 0.03,
        }))
      : paddleForeign
        ? wrist.map((point, index) => ({
            timestampMs: point.timestampMs,
            x: 0.15 + 0.002 * Math.sin(index / 7),
            y: 0.55 + 0.002 * Math.cos(index / 5),
          }))
        : null;

  const frameCount = Math.max(1, Math.floor(uniform(rng, 1, 400)));
  const frameStats: FrameStats = {
    frameCount,
    durationMs: rng() < 0.1 ? 0 : Math.round(uniform(rng, 100, 20_000)),
    width: Math.round(uniform(rng, 64, 1920)),
    height: Math.round(uniform(rng, 64, 1920)),
    interFrameDiffs: Array.from({ length: Math.max(0, frameCount - 1) }, () =>
      rng() < 0.3 ? uniform(rng, 0, 0.02) : uniform(rng, 0.02, 40),
    ),
    spatialLumaStd: Array.from({ length: frameCount }, () =>
      rng() < 0.1 ? uniform(rng, 0, 2) : uniform(rng, 2, 80),
    ),
    letterboxRowFraction: rng() < 0.2 ? uniform(rng, 0.4, 1) : uniform(rng, 0, 0.4),
  };
  if (rng() < 0.5) {
    frameStats.borderRing = { temporalStd: uniform(rng, 0, 5), meanLuma: uniform(rng, 0, 255) };
  }
  if (rng() < 0.5) {
    frameStats.bottomFrozenComponents = Array.from(
      { length: Math.floor(uniform(rng, 0, 4)) },
      () => ({ size: Math.floor(uniform(rng, 1, 40)), lumaStd: uniform(rng, 0, 40) }),
    );
  }
  if (rng() < 0.5) {
    frameStats.source = {
      width: Math.round(uniform(rng, 16, 4096)),
      height: Math.round(uniform(rng, 16, 4096)),
    };
  }
  if (rng() < 0.5) {
    frameStats.decode = {
      errorCount: Math.floor(uniform(rng, 0, 5)),
      expectedFrameCount: rng() < 0.2 ? null : Math.round(frameCount * uniform(rng, 0.5, 1.2)),
    };
  }

  return {
    seed,
    mode,
    truth,
    frames,
    clip,
    window: swing.window,
    sequence,
    shotType,
    ball,
    paddleCenters,
    paddleForeign,
    frameStats,
  };
}

// ─── Property helpers ──────────────────────────────────────────────────────

/** Collects JSON paths of every non-finite number in `value` (NaN, ±Infinity). */
export function findNonFinite(value: unknown, path = "$", out: string[] = []): string[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(path);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findNonFinite(entry, `${path}[${index}]`, out));
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      findNonFinite(entry, `${path}.${key}`, out);
    }
  }
  return out;
}

/** Stable serialization: sorted keys, NaN/Infinity kept visible (JSON.stringify would null them). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "number" && !Number.isFinite(entry)) return `__nonfinite:${String(entry)}`;
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
        sorted[key] = (entry as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return entry;
  });
}

// ─── Unit invocation (everything the seed drives) ──────────────────────────

interface Invocation {
  outputs: Record<string, unknown>;
  outcome: Omit<
    IterationOutcome,
    "iteration" | "durationMs" | "deterministic" | "finite" | "nonFinitePaths" | "violations"
  >;
}

function providerSetFor(scenario: Scenario): VisionProviderSet {
  return createGeometryProviderSet({
    poseFrames: scenario.frames,
    poseModelVersion: "apple-vision-bodypose-1",
    trigger: {
      modelVersion: "temporal-stroke-heuristic-2",
      startMs: scenario.window.startMs,
      endMs: scenario.window.endMs,
      peakMotionMs: scenario.window.peakMs,
      confidence: 0.88,
    },
    video: { width: scenario.clip.width, height: scenario.clip.height },
  });
}

async function invokeUnit(scenario: Scenario): Promise<Invocation> {
  const handed = scenario.truth.handed ?? "right";
  const options = {
    analysisId: `stress-${scenario.seed}`,
    sessionId: null,
    shotType: scenario.shotType,
    handedness: handed,
    cameraView: "side" as const,
    appVersion: "0.1.0",
    modelBundleVersion: GEOMETRY_BUNDLE_VERSION,
    capturedAtIso: "2026-09-04T00:00:00.000Z",
  };

  // Geometry providers through the real pipeline ("mount" the provider set, run, drop it).
  const providers = providerSetFor(scenario);
  const pipeline = await analyzeClip(providers, scenario.clip, options);

  // vision-contracts: the deterministic fixture provider set through the same pipeline.
  const fixtureProviders = createFixtureVisionProviderSet(scenario.shotType);
  const fixturePipeline = await analyzeClip(fixtureProviders, scenario.clip, options);

  const offlineWindow = detectOfflineStrokeWindow(scenario.sequence);
  const window = offlineWindow.ok
    ? {
        startMs: offlineWindow.value.startMs,
        endMs: offlineWindow.value.endMs,
        peakMotionMs: offlineWindow.value.peakMotionMs,
      }
    : {
        startMs: scenario.window.startMs,
        endMs: scenario.window.endMs,
        peakMotionMs: scenario.window.peakMs,
      };

  const wrists = wristTrack(scenario.frames, handed);
  const paddleSpeeds = scenario.paddleCenters
    ? scenario.paddleCenters.slice(1).map((point, index) => {
        const prev = scenario.paddleCenters![index]!;
        const dt = Math.max(1, point.timestampMs - prev.timestampMs) / 1000;
        return {
          timestampMs: point.timestampMs,
          value: Math.hypot(point.x - prev.x, point.y - prev.y) / dt,
        };
      })
    : null;

  const ownership = paddleOwnershipFromHandAffinity({
    sequence: scenario.sequence,
    paddleCenters: scenario.paddleCenters,
    targetWrists: wrists,
  });

  const contact = estimateContact({
    sequence: scenario.sequence,
    window,
    ballObservations: scenario.ball,
    paddleSpeeds,
    paddleCenters: scenario.paddleCenters,
    targetWrists: wrists,
    strokeFamily: null,
    includeFusionKernels: scenario.seed % 2 === 0,
    paddleIdentityGate: scenario.seed % 3 === 0,
    paddleOwnershipConfidence: ownership?.confidence ?? null,
    ownershipConditionedPosterior: scenario.seed % 5 === 0,
  });

  const heuristicPaddle: HeuristicPaddleObservation[] | null = scenario.paddleCenters
    ? scenario.paddleCenters.map((point) => ({
        timestampMs: point.timestampMs,
        center: { x: point.x, y: point.y },
      }))
    : null;
  const stroke = classifyStroke({
    sequence: scenario.sequence,
    window: { startMs: window.startMs, endMs: window.endMs },
    contactMs: contact.status === "estimated" ? contact.estimatedContactMs : null,
    eventPeakMs: window.peakMotionMs,
    handedness: handed,
    paddle: heuristicPaddle,
    paddleSpeeds,
    wristSpeeds: null,
  });

  const identity = assessPaddleTrackIdentity({
    paddleCenters: scenario.paddleCenters ?? [],
    targetWristTracks: [wrists],
    aspect: scenario.clip.width / scenario.clip.height,
    torsoSpan: scenario.truth.torsoLength ?? 0.2,
  });

  const captureQuality = evaluateCaptureQuality(scenario.sequence);
  const frameAnalyzability = evaluateFrameAnalyzability(scenario.frameStats);

  const biomechanics = pipeline.ok
    ? await new GeometryBiomechanicsExtractor().extract({
        pose: scenario.sequence,
        paddle: null,
        phases: pipeline.value.phases,
        shotType: scenario.shotType,
        handedness: handed,
        cameraView: "side",
      })
    : null;

  const knownFrameReasons = new Set<string>(FRAME_ANALYZABILITY_REASONS);
  return {
    outputs: {
      pipeline,
      fixturePipeline,
      offlineWindow,
      contact,
      stroke,
      identity,
      ownership,
      captureQuality,
      frameAnalyzability,
      biomechanics,
    },
    outcome: {
      seed: scenario.seed,
      mode: scenario.mode,
      handed,
      fps: scenario.clip.fps,
      frameCount: scenario.frames.length,
      pipeline: {
        ok: pipeline.ok,
        code: pipeline.ok ? null : pipeline.failure.code,
        resultKind: pipeline.ok ? pipeline.value.resultKind : null,
        score: pipeline.ok ? pipeline.value.overallScore : null,
      },
      fixturePipeline: {
        ok: fixturePipeline.ok,
        code: fixturePipeline.ok ? null : fixturePipeline.failure.code,
        source: fixturePipeline.ok ? fixturePipeline.value.source : null,
      },
      offlineWindow: {
        ok: offlineWindow.ok,
        code: offlineWindow.ok ? null : offlineWindow.failure.code,
      },
      contact: {
        status: contact.status,
        confidence: contact.status === "estimated" ? contact.confidence : null,
      },
      stroke: { label: stroke.label, depth: stroke.taxonomyDepth, confidence: stroke.confidence },
      identity: { verdict: identity.verdict },
      ownership: {
        confidence: ownership?.confidence ?? null,
        samplesMeasured: ownership?.samplesMeasured ?? null,
      },
      captureQuality: { analyzable: captureQuality.analyzable, reasons: captureQuality.reasons },
      frameAnalyzability: {
        analyzable: frameAnalyzability.analyzable,
        reasons: frameAnalyzability.reasons,
        unknownReasons: frameAnalyzability.reasons.filter((r) => !knownFrameReasons.has(r)),
      },
      biomechanics: {
        ok: biomechanics?.ok ?? false,
        code: biomechanics && !biomechanics.ok ? biomechanics.failure.code : null,
        measurements: biomechanics?.ok ? biomechanics.value.length : 0,
      },
    },
  };
}

function checkProperties(
  scenario: Scenario,
  first: Invocation,
  second: Invocation,
): Pick<IterationOutcome, "deterministic" | "finite" | "nonFinitePaths" | "violations"> {
  const violations: string[] = [];
  const a = stableStringify(first.outputs);
  const b = stableStringify(second.outputs);
  const deterministic = a === b;
  if (!deterministic) violations.push("non_deterministic_for_same_seed");

  const nonFinitePaths = findNonFinite(first.outputs);
  const finite = nonFinitePaths.length === 0;
  if (!finite) violations.push("non_finite_output");

  const o = first.outcome;
  if (!o.pipeline.ok && (o.pipeline.code === null || o.pipeline.code.length === 0)) {
    violations.push("pipeline_abstained_without_code");
  }
  if (
    o.pipeline.ok &&
    o.pipeline.score !== null &&
    (o.pipeline.score < 0 || o.pipeline.score > 10)
  ) {
    violations.push("pipeline_score_out_of_range");
  }
  if (o.pipeline.ok && o.pipeline.resultKind === "scored" && o.pipeline.score === null) {
    violations.push("scored_without_score");
  }
  if (o.pipeline.ok && o.pipeline.resultKind === "low_confidence" && o.pipeline.score !== null) {
    violations.push("low_confidence_with_score");
  }
  if (scenario.mode === "truncated" && o.pipeline.ok) {
    violations.push("truncated_input_scored");
  }
  if (scenario.mode === "frozen" && o.pipeline.ok && o.pipeline.resultKind === "scored") {
    violations.push("frozen_input_scored");
  }
  if (!o.fixturePipeline.ok) violations.push("fixture_pipeline_failed");
  if (o.fixturePipeline.ok && o.fixturePipeline.source !== "fixture") {
    violations.push("fixture_source_laundered");
  }
  if (o.contact.confidence !== null && (o.contact.confidence < 0 || o.contact.confidence > 1)) {
    violations.push("contact_confidence_out_of_range");
  }
  if (o.stroke.confidence < 0 || o.stroke.confidence > 1) {
    violations.push("stroke_confidence_out_of_range");
  }
  if (
    o.ownership.confidence !== null &&
    (o.ownership.confidence < 0 || o.ownership.confidence > 1)
  ) {
    violations.push("ownership_confidence_out_of_range");
  }
  if (!o.captureQuality.analyzable && o.captureQuality.reasons.length === 0) {
    violations.push("capture_quality_rejected_without_reason");
  }
  if (!o.frameAnalyzability.analyzable && o.frameAnalyzability.reasons.length === 0) {
    violations.push("frame_analyzability_rejected_without_reason");
  }
  if (o.frameAnalyzability.unknownReasons.length > 0) {
    violations.push("frame_analyzability_unknown_reason_code");
  }
  return { deterministic, finite, nonFinitePaths, violations };
}

// ─── Resource sampling ─────────────────────────────────────────────────────

type GcFn = () => void;

interface ProcessInternals {
  _getActiveHandles?: () => unknown[];
  _getActiveRequests?: () => unknown[];
  getActiveResourcesInfo?: () => string[];
}

/** Uses `--expose-gc` when present; otherwise flips the V8 runtime flag (same collector). */
export function resolveGc(): { gc: GcFn; source: CampaignSummary["gcSource"] } {
  const exposed = (globalThis as { gc?: GcFn }).gc;
  if (typeof exposed === "function") return { gc: exposed, source: "expose-gc-flag" };
  v8.setFlagsFromString("--expose-gc");
  const runtimeGc = vm.runInNewContext("gc") as GcFn;
  return { gc: runtimeGc, source: "v8-runtime-flag" };
}

function sampleResources(iteration: number, gc: GcFn, startedAt: number): ResourceSample {
  gc();
  gc();
  const memory = process.memoryUsage();
  const internals = process as unknown as ProcessInternals;
  const resources: Record<string, number> = {};
  for (const kind of internals.getActiveResourcesInfo?.() ?? []) {
    resources[kind] = (resources[kind] ?? 0) + 1;
  }
  const processListeners = process
    .eventNames()
    .reduce((sum, name) => sum + process.listenerCount(name), 0);
  return {
    iteration,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    rss: memory.rss,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    activeHandles: internals._getActiveHandles?.().length ?? -1,
    activeRequests: internals._getActiveRequests?.().length ?? -1,
    activeResources: resources,
    processListeners,
    elapsedMs: performance.now() - startedAt,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Least-squares slope of heapUsed against iteration, in bytes per 100 iterations. */
export function heapSlope(samples: readonly ResourceSample[]): {
  slopeBytesPer100: number | null;
  slopePctPer100: number | null;
  monotoneIncreaseFraction: number | null;
  samplesUsed: number;
} {
  const fit = samples.filter((sample) => sample.iteration >= SLOPE_WARMUP_ITERATIONS);
  if (fit.length < 3) {
    return {
      slopeBytesPer100: null,
      slopePctPer100: null,
      monotoneIncreaseFraction: null,
      samplesUsed: fit.length,
    };
  }
  const n = fit.length;
  const meanX = fit.reduce((sum, s) => sum + s.iteration, 0) / n;
  const meanY = fit.reduce((sum, s) => sum + s.heapUsed, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const sample of fit) {
    sxy += (sample.iteration - meanX) * (sample.heapUsed - meanY);
    sxx += (sample.iteration - meanX) ** 2;
  }
  const slopePerIteration = sxx > 0 ? sxy / sxx : 0;
  const slopeBytesPer100 = slopePerIteration * 100;
  const reference = fit[0]!.heapUsed;
  let increases = 0;
  for (let index = 1; index < fit.length; index++) {
    if (fit[index]!.heapUsed > fit[index - 1]!.heapUsed) increases += 1;
  }
  return {
    slopeBytesPer100,
    slopePctPer100: reference > 0 ? (slopeBytesPer100 / reference) * 100 : null,
    monotoneIncreaseFraction: increases / (fit.length - 1),
    samplesUsed: fit.length,
  };
}

function handleView(
  sample: ResourceSample,
): Pick<
  ResourceSample,
  "activeHandles" | "activeRequests" | "activeResources" | "processListeners"
> {
  return {
    activeHandles: sample.activeHandles,
    activeRequests: sample.activeRequests,
    activeResources: sample.activeResources,
    processListeners: sample.processListeners,
  };
}

// ─── Campaign ──────────────────────────────────────────────────────────────

export interface CampaignOptions {
  iterations: number;
  seedBase: number;
  /**
   * Keep every IterationOutcome for the seed → outcome table (default). When
   * false only violating outcomes are kept, so the heap samples measure the
   * unit alone and not the harness's own growing result table.
   */
  retainOutcomes?: boolean;
  onProgress?: (iteration: number, sample: ResourceSample) => void;
}

export function seedFor(seedBase: number, iteration: number): number {
  return (seedBase + iteration * 0x9e3779b1) >>> 0;
}

/** Runs one iteration for `seed` twice and reports the outcome (replay entry point). */
export async function runSeed(seed: number, iteration = 0): Promise<IterationOutcome> {
  const scenario = buildScenario(seed);
  const startedAt = performance.now();
  const first = await invokeUnit(scenario);
  const second = await invokeUnit(buildScenario(seed));
  const durationMs = (performance.now() - startedAt) / 2;
  const props = checkProperties(scenario, first, second);
  return { ...first.outcome, iteration, durationMs, ...props };
}

export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
  const { gc, source } = resolveGc();
  const startedAtIso = new Date().toISOString();
  const startedAt = performance.now();
  const retain = options.retainOutcomes ?? true;
  const samples: ResourceSample[] = [];
  const outcomes: IterationOutcome[] = [];
  const durations = new Float64Array(options.iterations);
  const codes: Record<string, number> = {};
  const nonDeterministicSeeds: number[] = [];
  const nonFiniteSeeds: number[] = [];
  const violationSeeds: number[] = [];
  const truncatedScored: number[] = [];
  const frozenScored: number[] = [];
  let executed = 0;
  let cleanCount = 0;
  let cleanAbstained = 0;
  let degradedCount = 0;
  let degradedAbstained = 0;

  const baseline = sampleResources(0, gc, startedAt);
  samples.push(baseline);

  for (let iteration = 1; iteration <= options.iterations; iteration++) {
    const seed = seedFor(options.seedBase, iteration);
    const o = await runSeed(seed, iteration);
    executed += 1;
    durations[iteration - 1] = o.durationMs;
    if (!o.deterministic) nonDeterministicSeeds.push(seed);
    if (!o.finite) nonFiniteSeeds.push(seed);
    if (o.violations.length > 0) violationSeeds.push(seed);
    if (o.mode === "truncated" && o.pipeline.ok) truncatedScored.push(seed);
    if (o.mode === "frozen" && o.pipeline.ok && o.pipeline.resultKind === "scored") {
      frozenScored.push(seed);
    }
    if (!o.pipeline.ok && o.pipeline.code) {
      codes[o.pipeline.code] = (codes[o.pipeline.code] ?? 0) + 1;
    }
    if (o.pipeline.ok && o.pipeline.resultKind === "low_confidence") {
      codes["scoring.abstain"] = (codes["scoring.abstain"] ?? 0) + 1;
    }
    const abstained = !o.pipeline.ok || o.pipeline.resultKind === "low_confidence";
    if (o.mode === "clean" || o.mode === "jitter") {
      cleanCount += 1;
      if (abstained) cleanAbstained += 1;
    } else {
      degradedCount += 1;
      if (abstained) degradedAbstained += 1;
    }
    if (retain || o.violations.length > 0) outcomes.push(o);
    if (iteration % SAMPLE_EVERY === 0 || iteration === options.iterations) {
      const sample = sampleResources(iteration, gc, startedAt);
      samples.push(sample);
      options.onProgress?.(iteration, sample);
    }
  }

  const final = samples[samples.length - 1]!;
  const slope = heapSlope(samples);
  const windowSize = Math.max(1, Math.floor(executed * 0.2));
  const earlyMedianMs = median(Array.from(durations.subarray(0, windowSize)));
  const lateMedianMs = median(Array.from(durations.subarray(executed - windowSize, executed)));
  const driftRatio = earlyMedianMs > 0 ? lateMedianMs / earlyMedianMs : 1;

  const returnedToBaseline =
    final.activeHandles === baseline.activeHandles &&
    final.activeRequests === baseline.activeRequests &&
    final.processListeners === baseline.processListeners &&
    stableStringify(final.activeResources) === stableStringify(baseline.activeResources);

  const summary: CampaignSummary = {
    iterations: executed,
    seedBase: options.seedBase,
    gcSource: source,
    retainOutcomes: retain,
    sampleEvery: SAMPLE_EVERY,
    heap: {
      baselineHeapUsed: baseline.heapUsed,
      finalHeapUsed: final.heapUsed,
      ...slope,
      exceeded:
        slope.slopePctPer100 !== null && slope.slopePctPer100 > HEAP_SLOPE_LIMIT_PCT_PER_100,
    },
    handles: {
      baseline: handleView(baseline),
      final: handleView(final),
      returnedToBaseline,
    },
    timing: {
      earlyMedianMs,
      lateMedianMs,
      driftRatio,
      exceeded: driftRatio > TIME_DRIFT_LIMIT_RATIO,
      totalMs: performance.now() - startedAt,
    },
    properties: {
      deterministicAll: nonDeterministicSeeds.length === 0,
      finiteAll: nonFiniteSeeds.length === 0,
      nonDeterministicSeeds,
      nonFiniteSeeds,
      violationSeeds,
      abstention: {
        pipelineAbstainRateClean: cleanCount > 0 ? cleanAbstained / cleanCount : 0,
        pipelineAbstainRateDegraded: degradedCount > 0 ? degradedAbstained / degradedCount : 0,
        truncatedScored,
        frozenScored,
        codes,
      },
      cancellation: "not_applicable_no_async_cancellation_surface",
    },
  };

  return {
    meta: {
      unit: "pkg-vision-geometry-contracts",
      lens: "long-run-leak",
      bundleVersion: GEOMETRY_BUNDLE_VERSION,
      node: process.version,
      startedAtIso,
      finishedAtIso: new Date().toISOString(),
    },
    summary,
    samples,
    outcomes,
  };
}

export function readStressIterations(): number {
  const raw = process.env["STRESS_ITER"];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STRESS_ITER;
}

export function readRetainOutcomes(): boolean {
  return process.env["STRESS_RETAIN"] !== "0";
}

export function readSeedBase(): number {
  const raw = process.env["STRESS_SEED"];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : 0x5eed_0001;
}
