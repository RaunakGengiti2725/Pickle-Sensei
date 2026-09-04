import { describe, expect, it } from "vitest";
import {
  parsePoseSequence,
  serializePoseSequence,
  toLegacyPoseFrames,
  type PoseSequence,
} from "../src/index.js";

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
        landmarks: [
          { name: "right_wrist", x: 0.5, y: 0.4, visibility: 0.9 },
          { name: "left_wrist", x: 0.45, y: 0.42, visibility: 0.8 },
        ],
      },
      {
        frameIndex: 1,
        timestampMs: 17,
        confidence: 0.93,
        landmarks: [
          { name: "right_wrist", x: 0.51, y: 0.39, visibility: 0.9, z: 0.2 },
          { name: "future_extra_joint", x: 0.1, y: 0.1, visibility: 0.5 },
        ],
      },
    ],
    ...overrides,
  };
}

describe("pose sequence serialization", () => {
  it("round-trips losslessly, including optional z and unknown joints", () => {
    const original = sequence();
    const parsed = parsePoseSequence(serializePoseSequence(original), PRODUCER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(original);
  });

  it("rejects unknown future schema versions instead of guessing", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.schemaVersion = 2;
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("pose_sequence.unsupported_schema");
  });

  it("rejects non-monotonic timestamps — temporal order is a hard invariant", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.frames[1].t = 0;
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("pose_sequence.non_monotonic");
  });

  it("rejects corrupted frames and landmarks", () => {
    const corruptFrame = JSON.parse(serializePoseSequence(sequence()));
    corruptFrame.frames[0].c = "high";
    expect(parsePoseSequence(JSON.stringify(corruptFrame), PRODUCER).ok).toBe(false);

    const corruptLandmark = JSON.parse(serializePoseSequence(sequence()));
    corruptLandmark.frames[0].l[0].x = null;
    const parsed = parsePoseSequence(JSON.stringify(corruptLandmark), PRODUCER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("pose_sequence.corrupt_landmark");

    expect(parsePoseSequence("not json at all", PRODUCER).ok).toBe(false);
  });

  it("rejects unknown coordinate systems — space is always explicit", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.coordinateSystem = "vibes";
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("pose_sequence.unknown_coordinate_system");
  });

  it("XC-CV-4: round-trips the additive cadence provenance (observed fps beside the declared nominal)", () => {
    const original = sequence({
      video: {
        width: 608,
        height: 1080,
        fps: 24,
        nominalFps: 12,
        fpsSource: "observed_sample_cadence",
        fpsMismatch: true,
      },
    });
    const wire = JSON.parse(serializePoseSequence(original));
    expect(wire.video).toEqual({
      w: 608,
      h: 1080,
      fps: 24,
      nominalFps: 12,
      fpsSource: "observed_sample_cadence",
      fpsMismatch: true,
    });
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(original);
  });

  it("XC-CV-4: sidecars written before cadence provenance existed still parse with a bare video header", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    expect(Object.keys(wire.video).sort()).toEqual(["fps", "h", "w"]);
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.video).toEqual({ width: 1080, height: 1920, fps: 60 });
  });

  it("XC-CV-4: malformed cadence provenance is rejected, never coerced", () => {
    for (const patch of [
      { nominalFps: "12" },
      { nominalFps: -1 },
      { fpsSource: "guess" },
      { fpsMismatch: "yes" },
    ]) {
      const wire = JSON.parse(serializePoseSequence(sequence()));
      Object.assign(wire.video, patch);
      const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
      expect(parsed.ok, JSON.stringify(patch)).toBe(false);
      if (parsed.ok) return;
      expect(parsed.failure.code).toBe("pose_sequence.invalid_video");
    }
  });

  it("projects to legacy PoseFrames, preserving canonical unknown joints only canonically", () => {
    const legacy = toLegacyPoseFrames(sequence());
    expect(legacy).toHaveLength(2);
    expect(legacy[0]!.space).toBe("normalized-image");
    // The unknown future joint is not projected into the legacy shape…
    expect(legacy[1]!.landmarks.map((l) => l.name)).toEqual(["right_wrist"]);
    // …but survives a canonical round-trip.
    const parsed = parsePoseSequence(serializePoseSequence(sequence()), PRODUCER);
    expect(parsed.ok && parsed.value.frames[1]!.landmarks[1]!.name).toBe("future_extra_joint");
  });
});
