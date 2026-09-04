import { describe, expect, it } from "vitest";
import {
  parsePoseSequence,
  resolveStroke,
  serializePoseSequence,
  toLegacyPoseFrames,
  type PoseSequence,
} from "../../src/index.js";

/**
 * EXECUTION AUDIT HARNESS (pkg-analysis-pipeline, pass 2) — @pickle/swing-domain.
 * New file only. serialization.ts is documented as "the single reader and
 * writer" of the pose-sequence sidecar. These cases check whether the WRITER
 * can emit a sidecar the READER rejects (a durable capture the app can never
 * re-analyze), plus stroke-resolution edge inputs.
 */

const PRODUCER = {
  providerId: "pose.apple-vision",
  runtime: "vision_framework" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

function sequence(overrides: Partial<PoseSequence> = {}): PoseSequence {
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: { ...PRODUCER, modelVersion: "apple-vision-bodypose-1" },
    video: { width: 1080, height: 1920, fps: 60 },
    frames: [
      {
        frameIndex: 0,
        timestampMs: 0,
        confidence: 0.92,
        landmarks: [{ name: "right_wrist", x: 0.5, y: 0.4, visibility: 0.9 }],
      },
      {
        frameIndex: 1,
        timestampMs: 17,
        confidence: 0.93,
        landmarks: [{ name: "right_wrist", x: 0.51, y: 0.39, visibility: 0.9 }],
      },
    ],
    ...overrides,
  };
}

describe("AUDIT pose-sequence writer/reader symmetry", () => {
  it("a NaN landmark coordinate serializes as null and the reader then rejects the whole sidecar", () => {
    const poisoned = sequence();
    poisoned.frames[1]!.landmarks[0]!.x = Number.NaN;
    const wire = serializePoseSequence(poisoned);
    expect(wire).toContain('"x":null');
    const parsed = parsePoseSequence(wire, PRODUCER);
    // Documented behaviour: the reader refuses. The audit point is that the
    // writer accepted it silently — nothing upstream of the sidecar learns
    // that this capture is unreadable until the next analysis attempt.
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("pose_sequence.corrupt_landmark");
  });

  it("a NaN frame confidence serializes as null → reader rejects with corrupt_frame", () => {
    const poisoned = sequence();
    poisoned.frames[0]!.confidence = Number.NaN;
    const parsed = parsePoseSequence(serializePoseSequence(poisoned), PRODUCER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("pose_sequence.corrupt_frame");
  });

  it("duplicate timestamps (stale/repeated frame) written by the producer are rejected on read", () => {
    const stale = sequence();
    stale.frames[1]!.timestampMs = stale.frames[0]!.timestampMs;
    const parsed = parsePoseSequence(serializePoseSequence(stale), PRODUCER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("pose_sequence.non_monotonic");
  });

  it("empty frames array round-trips as a valid (empty) sequence — emptiness is the consumer's problem", () => {
    const parsed = parsePoseSequence(serializePoseSequence(sequence({ frames: [] })), PRODUCER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frames).toEqual([]);
    expect(toLegacyPoseFrames(parsed.value)).toEqual([]);
  });

  it("out-of-range visibility/confidence (>1, <0) are accepted by the reader unchanged", () => {
    const odd = sequence();
    odd.frames[0]!.confidence = 7;
    odd.frames[0]!.landmarks[0]!.visibility = -3;
    const parsed = parsePoseSequence(serializePoseSequence(odd), PRODUCER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frames[0]!.confidence).toBe(7);
    expect(parsed.value.frames[0]!.landmarks[0]!.visibility).toBe(-3);
  });

  it("non-monotonic frameIndex with monotonic timestamps is accepted (only t is checked)", () => {
    const odd = sequence();
    odd.frames[1]!.frameIndex = 0;
    const parsed = parsePoseSequence(serializePoseSequence(odd), PRODUCER);
    expect(parsed.ok).toBe(true);
  });

  it("very large sidecar (20k frames) parses without stack/heap blow-up and stays lossless", () => {
    const frames = Array.from({ length: 20_000 }, (_, i) => ({
      frameIndex: i,
      timestampMs: i * 16.667,
      confidence: 0.9,
      landmarks: [
        { name: "right_wrist", x: 0.5, y: 0.4, visibility: 0.9 },
        { name: "left_wrist", x: 0.4, y: 0.4, visibility: 0.9 },
      ],
    }));
    const big = sequence({ frames });
    const parsed = parsePoseSequence(serializePoseSequence(big), PRODUCER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frames).toHaveLength(20_000);
    expect(parsed.value).toEqual(big);
  });
});

const nanPrediction = {
  shotType: "forehand_drive" as const,
  confidence: Number.NaN,
  alternatives: [],
  producedBy: { ...PRODUCER, providerId: "classifier.audit", modelVersion: "audit-nan" },
};

describe("AUDIT resolveStroke — non-finite prediction confidence", () => {
  it("NaN prediction confidence with a declared stroke falls back to the declaration", () => {
    const resolution = resolveStroke(
      {
        declared: "backhand_drive",
        predicted: nanPrediction,
      },
      { predictionConfidenceThreshold: 0.7 },
    );
    expect(resolution.kind).toBe("declared");
  });

  it("NaN prediction confidence without a declaration resolves to unresolved (never predicted)", () => {
    const resolution = resolveStroke(
      {
        declared: null,
        predicted: nanPrediction,
      },
      { predictionConfidenceThreshold: 0.7 },
    );
    expect(resolution.kind).toBe("unresolved");
  });
});
