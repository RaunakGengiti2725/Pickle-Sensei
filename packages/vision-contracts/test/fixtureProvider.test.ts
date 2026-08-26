import { afterEach, describe, expect, it } from "vitest";
import { createFixtureVisionProviderSet } from "../src/index.js";
import type { VideoClipRef } from "../src/index.js";

const clip: VideoClipRef = {
  uri: "fixture://forehand-demo",
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

const originalEnv = process.env["PICKLE_ENV"];
afterEach(() => {
  if (originalEnv === undefined) delete process.env["PICKLE_ENV"];
  else process.env["PICKLE_ENV"] = originalEnv;
});

describe("FixtureVisionProvider guardrails (directive §5)", () => {
  it("REFUSES to construct in production builds", () => {
    process.env["PICKLE_ENV"] = "production";
    expect(() => createFixtureVisionProviderSet("forehand_drive")).toThrow(/production/i);
  });

  it("tags every emitted artifact as fixture — nothing can masquerade as real inference", async () => {
    process.env["PICKLE_ENV"] = "development";
    const set = createFixtureVisionProviderSet("forehand_drive");
    expect(set.source).toBe("fixture");
    expect(set.pose.source).toBe("fixture");
    expect(set.paddle.source).toBe("fixture");
    expect(set.stroke.source).toBe("fixture");

    const strokes = await set.stroke.detectStrokes(clip);
    expect(strokes.ok).toBe(true);
    if (!strokes.ok) return;
    const stroke = strokes.value[0];
    expect(stroke).toBeDefined();
    if (!stroke) return;

    const pose = await set.pose.extractPose(clip, { startMs: 0, endMs: 2000 });
    const paddle = await set.paddle.detectPaddle(clip, { startMs: 0, endMs: 2000 });
    expect(pose.ok && paddle.ok).toBe(true);
    if (!pose.ok || !paddle.ok) return;

    const phases = await set.phase.segmentPhases(pose.value, paddle.value, stroke);
    expect(phases.ok).toBe(true);
    if (!phases.ok) return;

    const measurements = await set.features.extractMeasurements({
      poseFrames: pose.value,
      paddleFrames: paddle.value,
      phases: phases.value,
      shotType: "forehand_drive",
      handedness: "right",
      cameraView: "side",
    });
    expect(measurements.ok).toBe(true);
    if (!measurements.ok) return;
    for (const m of measurements.value) {
      expect(m.source).toBe("fixture");
    }
  });

  it("returns a typed failure — not invented data — for unsupported shot types", async () => {
    process.env["PICKLE_ENV"] = "development";
    const set = createFixtureVisionProviderSet("volley");
    const measurements = await set.features.extractMeasurements({
      poseFrames: [],
      paddleFrames: [],
      phases: [],
      shotType: "volley",
      handedness: "right",
      cameraView: "side",
    });
    expect(measurements.ok).toBe(false);
    if (measurements.ok) return;
    expect(measurements.failure.code).toBe("vision.features.unsupported_shot");
  });

  it("returns a typed corrupted_media failure for a too-short clip", async () => {
    process.env["PICKLE_ENV"] = "development";
    const set = createFixtureVisionProviderSet("forehand_drive");
    const result = await set.stroke.detectStrokes({ ...clip, durationMs: 200 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("corrupted_media");
  });

  it("is deterministic per clip/shot — repeated calls agree exactly", async () => {
    process.env["PICKLE_ENV"] = "development";
    const set = createFixtureVisionProviderSet("dink");
    const args = {
      poseFrames: [],
      paddleFrames: [],
      phases: [],
      shotType: "dink" as const,
      handedness: "right" as const,
      cameraView: "side" as const,
    };
    const a = await set.features.extractMeasurements(args);
    const b = await set.features.extractMeasurements(args);
    expect(a).toEqual(b);
  });
});
