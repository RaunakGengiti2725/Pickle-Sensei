import type { PhaseSpan, PoseFrame, PoseLandmarkName } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
import type { StrokeEvent } from "@pickle/vision-contracts";
import { generateSwing } from "@pickle/evaluation";
import { GeometricPhaseSegmenter } from "../../../../src/index.js";

/**
 * Shared fixtures for adversarial pass 3 / tester 4 (pkg-vision-geometry).
 * Everything here is synthetic and deterministic; no dataset is read.
 */

export const FULL_BODY: readonly PoseLandmarkName[] = [
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
];

export interface ExactTorsoOptions {
  /** Exact shoulder-center → hip-center distance in normalized image units. */
  torsoLength: number;
  /** Frame timestamps (ms). */
  timestamps: readonly number[];
  /** Total horizontal wrist travel over the clip (image units, pre-aspect). */
  wristTravel?: number;
  visibility?: number;
  confidence?: number;
}

/**
 * Standing skeleton whose measured torso length is EXACTLY `torsoLength`:
 * the shoulder line sits at y = 0 and the hip line at y = torsoLength, both
 * centered on x = 0.5, so `hypot(0, torsoLength) === torsoLength` with no
 * floating-point drift. The dominant (right) wrist sweeps left → right so a
 * forward direction is measurable.
 */
export function exactTorsoFrames(options: ExactTorsoOptions): PoseFrame[] {
  const T = options.torsoLength;
  const visibility = options.visibility ?? 0.95;
  const confidence = options.confidence ?? 0.9;
  const travel = options.wristTravel ?? 0.4;
  const first = options.timestamps[0] ?? 0;
  const last = options.timestamps[options.timestamps.length - 1] ?? first;
  const span = Math.max(1, last - first);
  return options.timestamps.map((timestampMs) => {
    const progress = (timestampMs - first) / span;
    const wristX = 0.3 + travel * progress;
    const mark = (name: PoseLandmarkName, x: number, y: number) => ({
      name,
      x,
      y,
      visibility,
    });
    return {
      timestampMs,
      space: "normalized-image" as const,
      confidence,
      landmarks: [
        mark("head", 0.5, -0.35 * T),
        mark("left_shoulder", 0.4, 0),
        mark("right_shoulder", 0.6, 0),
        mark("left_elbow", 0.35, 0.5 * T),
        mark("right_elbow", 0.7, 0.5 * T),
        mark("left_wrist", 0.3, 0.9 * T),
        mark("right_wrist", wristX, 0.9 * T),
        mark("left_hip", 0.45, T),
        mark("right_hip", 0.55, T),
        mark("left_knee", 0.44, T + 0.8 * T),
        mark("right_knee", 0.56, T + 0.8 * T),
        mark("left_ankle", 0.42, T + 1.55 * T),
        mark("right_ankle", 0.58, T + 1.55 * T),
      ],
    };
  });
}

export function timestampsEvery(stepMs: number, count: number, startMs = 0): number[] {
  return Array.from({ length: count }, (_, index) => startMs + index * stepMs);
}

/** Hand-built, well-ordered, non-overlapping six-phase span set over [0, 2000]. */
export function handBuiltPhases(confidence = 0.9): PhaseSpan[] {
  const span = (key: PhaseSpan["key"], startMs: number, endMs: number): PhaseSpan => ({
    key,
    startMs,
    endMs,
    representativeMs: startMs + (endMs - startMs) / 2,
    confidence,
  });
  return [
    span("ready", 0, 400),
    span("prepare", 400, 850),
    span("accelerate", 850, 1090),
    { key: "contact", startMs: 1090, representativeMs: 1100, endMs: 1110, confidence },
    span("follow_through", 1110, 1430),
    span("recover", 1430, 2000),
  ];
}

/** A real synthetic swing plus REAL phases from the geometric segmenter. */
export async function realSwingWithPhases(aspectRatio = 1): Promise<{
  frames: PoseFrame[];
  phases: PhaseSpan[];
  stroke: StrokeEvent;
  clip: { width: number; height: number; fps: number };
}> {
  const swing = generateSwing();
  const stroke: StrokeEvent = {
    startMs: swing.window.startMs,
    endMs: swing.window.endMs,
    contactMs: swing.window.peakMs,
    shotTypeHypothesis: "forehand_drive",
    confidence: 0.88,
  };
  const segmenter = new GeometricPhaseSegmenter({ aspectRatio });
  const phases = await segmenter.segmentPhases(swing.frames, [], stroke);
  if (!phases.ok) throw new Error(`segmenter abstained: ${phases.failure.code}`);
  return { frames: swing.frames, phases: phases.value, stroke, clip: swing.clip };
}

export function legacyFramesOf(sequence: PoseSequence): PoseFrame[] {
  return toLegacyPoseFrames(sequence);
}

/** Every finite-ness violation in a Measurement[] (empty when clean). */
export function nonFiniteMeasurements(
  measurements: ReadonlyArray<{ metricKey: string; value: number; confidence: number }>,
): string[] {
  const bad: string[] = [];
  for (const entry of measurements) {
    if (!Number.isFinite(entry.value)) bad.push(`${entry.metricKey}.value=${String(entry.value)}`);
    if (!Number.isFinite(entry.confidence)) {
      bad.push(`${entry.metricKey}.confidence=${String(entry.confidence)}`);
    }
  }
  return bad;
}

/** Deterministic xorshift32 PRNG so any fuzzing here is replayable. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}
