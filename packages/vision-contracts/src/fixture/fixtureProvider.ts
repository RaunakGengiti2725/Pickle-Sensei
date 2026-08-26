import type {
  Measurement,
  PhaseSpan,
  PoseFrame,
  PaddleFrame,
  Result,
  ShotTypeSlug,
} from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import type {
  IFeatureExtractor,
  IPaddleDetector,
  IPhaseSegmenter,
  IPoseProvider,
  IStrokeDetector,
  StrokeEvent,
  VideoClipRef,
  VisionProviderSet,
} from "../contracts.js";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DEVELOPMENT FIXTURE PROVIDER — NOT AI, NOT INFERENCE, NOT PRODUCTION CODE
 * ═══════════════════════════════════════════════════════════════════════════
 * Emits deterministic synthetic data so product surfaces can be built before
 * the native vision runtime exists (directive §5/§61/§64). Guarantees:
 *   1. Construction throws in production builds (PICKLE_ENV === "production").
 *   2. Every artifact is tagged source:"fixture"; the tag persists end-to-end
 *      so no screen can present fixture output as real analysis.
 *   3. Output is deterministic per (clip uri, shot type) — no randomness.
 */

const FIXTURE_VERSION = "fixture-1";

function assertNotProduction(): void {
  const env = globalThis.process?.env?.["PICKLE_ENV"] ?? globalThis.process?.env?.["NODE_ENV"];
  if (env === "production") {
    throw new Error(
      "FixtureVisionProvider must never be constructed in a production build (directive §5).",
    );
  }
}

/** Deterministic pseudo-variation from a string seed (no Math.random). */
function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

/**
 * Fixture stroke profiles: a "flawed" forehand with late contact (matches the
 * blueprint's canonical coaching example) and reasonable defaults for the
 * other MVP shots. Values are inputs to the REAL scoring engine — the score
 * itself is never fabricated.
 */
const FIXTURE_MEASUREMENTS: Partial<Record<ShotTypeSlug, Array<[string, number]>>> = {
  forehand_drive: [
    ["paddle_ready_height_ratio", 0.42],
    ["stance_width_ratio", 1.35],
    ["knee_flexion_deg", 28],
    ["shoulder_turn_deg", 38],
    ["paddle_set_height_ratio", 0.38],
    ["backswing_length_norm", 0.95],
    ["hip_shoulder_lag_ms", 70],
    ["weight_transfer_norm", 0.3],
    ["path_low_to_high_slope", 0.35],
    ["contact_forward_of_hip_norm", 0.12], // late — the canonical demo fault
    ["contact_height_ratio", 0.4],
    ["wrist_angle_variance_deg", 7],
    ["follow_through_length_norm", 0.8],
    ["recovery_time_ms", 700],
  ],
  dink: [
    ["paddle_ready_height_ratio", 0.45],
    ["stance_width_ratio", 1.4],
    ["knee_flexion_deg", 35],
    ["shoulder_turn_deg", 12],
    ["paddle_set_forward_norm", 0.3],
    ["backswing_length_norm", 0.2],
    ["weight_transfer_norm", 0.12],
    ["path_low_to_high_slope", 0.2],
    ["contact_forward_of_hip_norm", 0.35],
    ["contact_height_ratio", 0.2],
    ["wrist_angle_variance_deg", 4],
    ["follow_through_length_norm", 0.25],
    ["recovery_time_ms", 500],
  ],
  third_shot_drop: [
    ["paddle_ready_height_ratio", 0.4],
    ["stance_width_ratio", 1.35],
    ["knee_flexion_deg", 32],
    ["shoulder_turn_deg", 22],
    ["paddle_set_height_ratio", 0.25],
    ["backswing_length_norm", 0.4],
    ["weight_transfer_norm", 0.2],
    ["path_low_to_high_slope", 0.38],
    ["contact_forward_of_hip_norm", 0.3],
    ["contact_height_ratio", 0.25],
    ["wrist_angle_variance_deg", 5],
    ["follow_through_length_norm", 0.45],
    ["recovery_time_ms", 600],
  ],
  serve: [
    ["paddle_ready_height_ratio", 0.3],
    ["stance_width_ratio", 1.3],
    ["knee_flexion_deg", 25],
    ["shoulder_turn_deg", 45],
    ["paddle_set_height_ratio", 0.2],
    ["backswing_length_norm", 0.7],
    ["hip_shoulder_lag_ms", 80],
    ["weight_transfer_norm", 0.35],
    ["path_low_to_high_slope", 0.55],
    ["contact_forward_of_hip_norm", 0.45],
    ["contact_height_ratio", 0.25],
    ["wrist_angle_variance_deg", 8],
    ["follow_through_length_norm", 0.85],
    ["recovery_time_ms", 800],
  ],
};

const FIXTURE_PHASES: PhaseSpan[] = [
  { key: "ready", startMs: 0, representativeMs: 150, endMs: 300, confidence: 0.93 },
  { key: "prepare", startMs: 300, representativeMs: 500, endMs: 700, confidence: 0.91 },
  { key: "accelerate", startMs: 700, representativeMs: 850, endMs: 1000, confidence: 0.9 },
  { key: "contact", startMs: 1000, representativeMs: 1040, endMs: 1090, confidence: 0.88 },
  { key: "follow_through", startMs: 1090, representativeMs: 1250, endMs: 1400, confidence: 0.9 },
  { key: "recover", startMs: 1400, representativeMs: 1700, endMs: 2000, confidence: 0.87 },
];

class FixturePoseProvider implements IPoseProvider {
  readonly modelVersion = FIXTURE_VERSION;
  readonly source = "fixture" as const;
  async extractPose(
    clip: VideoClipRef,
    window: { startMs: number; endMs: number },
  ): Promise<Result<PoseFrame[]>> {
    const frames: PoseFrame[] = [];
    const stepMs = 1000 / 30;
    for (let t = window.startMs; t <= window.endMs; t += stepMs) {
      frames.push({
        timestampMs: Math.round(t),
        space: "normalized-image",
        confidence: 0.92,
        landmarks: [
          { name: "left_shoulder", x: 0.45, y: 0.35, visibility: 0.95 },
          { name: "right_shoulder", x: 0.55, y: 0.35, visibility: 0.95 },
          { name: "left_hip", x: 0.46, y: 0.55, visibility: 0.93 },
          { name: "right_hip", x: 0.54, y: 0.55, visibility: 0.93 },
          { name: "right_wrist", x: 0.62, y: 0.5, visibility: 0.9 },
        ],
      });
    }
    void clip;
    return ok(frames);
  }
}

class FixturePaddleDetector implements IPaddleDetector {
  readonly modelVersion = FIXTURE_VERSION;
  readonly source = "fixture" as const;
  async detectPaddle(
    clip: VideoClipRef,
    window: { startMs: number; endMs: number },
  ): Promise<Result<PaddleFrame[]>> {
    const frames: PaddleFrame[] = [];
    const stepMs = 1000 / 30;
    for (let t = window.startMs; t <= window.endMs; t += stepMs) {
      frames.push({
        timestampMs: Math.round(t),
        space: "normalized-image",
        bbox: { x: 0.6, y: 0.45, width: 0.08, height: 0.1 },
        keypoints: {
          handleEnd: { x: 0.61, y: 0.53 },
          throat: { x: 0.62, y: 0.5 },
          center: { x: 0.64, y: 0.48 },
          tip: { x: 0.66, y: 0.45 },
        },
        confidence: 0.88,
      });
    }
    void clip;
    return ok(frames);
  }
}

class FixtureStrokeDetector implements IStrokeDetector {
  readonly modelVersion = FIXTURE_VERSION;
  readonly source = "fixture" as const;
  private readonly shotType: ShotTypeSlug;
  constructor(shotType: ShotTypeSlug) {
    this.shotType = shotType;
  }
  async detectStrokes(clip: VideoClipRef): Promise<Result<StrokeEvent[]>> {
    if (clip.durationMs < 500) {
      return fail(
        failure(
          "corrupted_media",
          "vision.stroke.clip_too_short",
          "Clip too short to contain a stroke.",
        ),
      );
    }
    return ok([
      {
        startMs: 0,
        endMs: Math.min(2000, clip.durationMs),
        contactMs: 1040,
        shotTypeHypothesis: this.shotType,
        confidence: 0.9,
      },
    ]);
  }
}

class FixturePhaseSegmenter implements IPhaseSegmenter {
  readonly modelVersion = FIXTURE_VERSION;
  readonly source = "fixture" as const;
  async segmentPhases(): Promise<Result<PhaseSpan[]>> {
    return ok(FIXTURE_PHASES.map((p) => ({ ...p })));
  }
}

class FixtureFeatureExtractor implements IFeatureExtractor {
  readonly version = FIXTURE_VERSION;
  async extractMeasurements(input: {
    shotType: ShotTypeSlug;
    poseFrames: PoseFrame[];
  }): Promise<Result<Measurement[]>> {
    const table = FIXTURE_MEASUREMENTS[input.shotType];
    if (!table) {
      return fail(
        failure(
          "unsupported_device",
          "vision.features.unsupported_shot",
          `No fixture profile for shot type ${input.shotType}; the fixture provider does not invent data.`,
        ),
      );
    }
    const jitterSeed = seedFrom(input.shotType + ":" + String(input.poseFrames.length));
    const measurements: Measurement[] = table.map(([metricKey, value]) => ({
      metricKey,
      // ±2% deterministic variation so repeated fixture reps are not identical.
      value: value * (0.98 + 0.04 * seedFrom(metricKey + String(jitterSeed))),
      confidence: 0.9,
      unit: metricKey.endsWith("_deg")
        ? ("degrees" as const)
        : metricKey.endsWith("_ms")
          ? ("ms" as const)
          : ("normalized" as const),
      source: "fixture",
    }));
    return ok(measurements);
  }
}

export function createFixtureVisionProviderSet(shotType: ShotTypeSlug): VisionProviderSet {
  assertNotProduction();
  return {
    source: "fixture",
    pose: new FixturePoseProvider(),
    paddle: new FixturePaddleDetector(),
    stroke: new FixtureStrokeDetector(shotType),
    phase: new FixturePhaseSegmenter(),
    features: new FixtureFeatureExtractor(),
    ball: null,
  };
}
