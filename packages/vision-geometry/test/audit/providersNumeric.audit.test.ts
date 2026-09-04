import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { PoseFrame } from "@pickle/shared-types";
import type { VideoClipRef } from "@pickle/vision-contracts";
import {
  AbsentPaddleDetector,
  createGeometryProviderSet,
  RecordedPoseProvider,
  RecordedTriggerStrokeDetector,
  type RecordedStrokeInput,
} from "../../src/index.js";

/**
 * AUDIT PROBES — providers.ts / index.ts numeric-input handling.
 * Each `it` states the invariant it expects; a failure is a candidate finding.
 */

const clip: VideoClipRef = {
  uri: "audit://clip",
  durationMs: 4000,
  fps: 60,
  width: 1080,
  height: 1920,
};

function legacyFrames(): PoseFrame[] {
  const { sequence } = generateSwingSequence();
  return sequence.frames.map((frame) => ({
    timestampMs: frame.timestampMs,
    space: "normalized_image" as const,
    confidence: frame.confidence,
    landmarks: frame.landmarks.map((mark) => ({ ...mark })),
  })) as unknown as PoseFrame[];
}

describe("AUDIT RecordedTriggerStrokeDetector window validation", () => {
  const make = (startMs: number, endMs: number) =>
    new RecordedTriggerStrokeDetector({
      triggerModelVersion: "audit-trigger",
      startMs,
      endMs,
      peakMotionMs: null,
      confidence: 0.9,
    });

  it("rejects an inverted window (baseline)", async () => {
    const result = await make(1000, 500).detectStrokes(clip);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty window (baseline)", async () => {
    const result = await make(1000, 1000).detectStrokes(clip);
    expect(result.ok).toBe(false);
  });

  it("rejects a NaN start", async () => {
    const result = await make(Number.NaN, 1000).detectStrokes(clip);
    expect(result.ok).toBe(false);
  });

  it("rejects a NaN end", async () => {
    const result = await make(0, Number.NaN).detectStrokes(clip);
    expect(result.ok).toBe(false);
  });

  it("rejects an infinite end", async () => {
    const result = await make(0, Number.POSITIVE_INFINITY).detectStrokes(clip);
    expect(result.ok).toBe(false);
  });
});

describe("AUDIT RecordedPoseProvider frame ordering / timestamps", () => {
  it("replays unsorted frames in ascending order (baseline)", async () => {
    const frames = legacyFrames();
    const shuffled = [...frames].reverse();
    const provider = new RecordedPoseProvider({ frames: shuffled, poseModelVersion: "audit" });
    const result = await provider.extractPose(clip, {
      startMs: frames[0]!.timestampMs,
      endMs: frames[frames.length - 1]!.timestampMs,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ts = result.value.map((f) => f.timestampMs);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("does not silently pass NaN-timestamp frames through the window filter", async () => {
    const frames = legacyFrames();
    const poisoned = frames.map((frame, index) =>
      index % 5 === 0 ? { ...frame, timestampMs: Number.NaN } : frame,
    );
    const provider = new RecordedPoseProvider({ frames: poisoned, poseModelVersion: "audit" });
    const result = await provider.extractPose(clip, {
      startMs: frames[0]!.timestampMs,
      endMs: frames[frames.length - 1]!.timestampMs,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // NaN frames fail both comparisons → filtered; the remaining order must be sound.
    expect(result.value.every((f) => Number.isFinite(f.timestampMs))).toBe(true);
    const ts = result.value.map((f) => f.timestampMs);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });
});

describe("AUDIT createGeometryProviderSet video dimensions", () => {
  const base = (): RecordedStrokeInput => {
    const { sequence, window } = generateSwingSequence();
    return {
      poseFrames: legacyFrames(),
      poseModelVersion: "audit-pose",
      video: { width: sequence.video.width, height: sequence.video.height },
      trigger: {
        modelVersion: "audit-trigger",
        startMs: window.startMs,
        endMs: window.endMs,
        peakMotionMs: window.peakMs,
        confidence: 0.9,
      },
    };
  };

  const aspectOf = (set: ReturnType<typeof createGeometryProviderSet>): number =>
    (set.phase as unknown as { aspectRatio: number }).aspectRatio;

  it("uses width/height when both are valid (baseline)", () => {
    const input = base();
    input.video.width = 1080;
    input.video.height = 1920;
    expect(aspectOf(createGeometryProviderSet(input))).toBeCloseTo(0.5625, 6);
  });

  it("height <= 0 must not silently normalize with aspect 1", () => {
    const input = base();
    input.video.width = 1080;
    input.video.height = 0;
    const aspect = aspectOf(createGeometryProviderSet(input));
    // Either refuse (throw / fail) or at least not claim a square aspect for a
    // portrait clip; a silent 1 is the documented hotspot.
    expect(aspect).not.toBe(1);
  });

  it("width <= 0 must not produce a non-positive aspect ratio", () => {
    const input = base();
    input.video.width = 0;
    input.video.height = 1920;
    const aspect = aspectOf(createGeometryProviderSet(input));
    expect(aspect).toBeGreaterThan(0);
  });

  it("NaN dimensions must not produce a NaN aspect ratio", () => {
    const input = base();
    input.video.width = Number.NaN;
    input.video.height = 1920;
    const aspect = aspectOf(createGeometryProviderSet(input));
    expect(Number.isFinite(aspect)).toBe(true);
  });

  it("Infinity height must not produce a zero aspect ratio", () => {
    const input = base();
    input.video.width = 1080;
    input.video.height = Number.POSITIVE_INFINITY;
    const aspect = aspectOf(createGeometryProviderSet(input));
    expect(aspect).toBeGreaterThan(0);
  });
});

describe("AUDIT AbsentPaddleDetector provenance", () => {
  it("returns ok([]) with source 'real' (documents the encoding; not asserted as a defect)", async () => {
    const detector = new AbsentPaddleDetector();
    const result = await detector.detectPaddle(clip, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(true);
    expect(detector.source).toBe("real");
    expect(detector.modelVersion).toBe("paddle-none-0");
  });
});
