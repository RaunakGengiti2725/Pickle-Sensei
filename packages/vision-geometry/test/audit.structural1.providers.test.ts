import { describe, expect, it } from "vitest";
import { analyzeClip } from "@pickle/analysis-pipeline";
import type { VideoClipRef } from "@pickle/vision-contracts";
import { generateSwing } from "@pickle/evaluation";
import {
  createGeometryProviderSet,
  GEOMETRY_BUNDLE_VERSION,
  RecordedPoseProvider,
  RecordedTriggerStrokeDetector,
} from "../src/index.js";

/**
 * Structural audit (pass 1) — provider assembly and recorded providers.
 *
 * Contract under test: invalid video dimensions must not silently alter
 * geometry (createGeometryProviderSet documents the height<=0 → aspect 1
 * fallback; a zero/NaN WIDTH has no documented handling), and recorded
 * trigger windows that are not real intervals must be typed failures.
 */

const OPTIONS = {
  analysisId: "audit-1",
  sessionId: null,
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
  appVersion: "0.1.0",
  modelBundleVersion: GEOMETRY_BUNDLE_VERSION,
  capturedAtIso: "2026-08-27T18:00:00.000Z",
};

function buildWith(video: { width: number; height: number }) {
  const swing = generateSwing();
  const clip: VideoClipRef = {
    uri: swing.clip.uri,
    durationMs: swing.clip.durationMs,
    fps: swing.clip.fps,
    width: video.width,
    height: video.height,
  };
  const providers = createGeometryProviderSet({
    poseFrames: swing.frames,
    poseModelVersion: "apple-vision-bodypose-1",
    trigger: {
      modelVersion: "temporal-stroke-heuristic-2",
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      peakMotionMs: swing.window.peakMs,
      confidence: 0.88,
    },
    video,
  });
  return { swing, clip, providers };
}

describe("audit: createGeometryProviderSet — invalid video dimensions", () => {
  it("control: nominal square video scores with stance width near constructed truth", async () => {
    const { clip, providers } = buildWith({ width: 1080, height: 1080 });
    const result = await analyzeClip(providers, clip, OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stance = result.value.measurements.find((m) => m.metricKey === "stance_width_ratio");
    expect(stance).toBeDefined();
    expect(stance!.value).toBeGreaterThan(1.0);
  });

  it("width 0 (height > 0) must not produce a scored 'real' analysis whose x-geometry is collapsed", async () => {
    const { clip, providers } = buildWith({ width: 0, height: 1080 });
    const result = await analyzeClip(providers, clip, OPTIONS);
    if (!result.ok) {
      // Typed abstention is acceptable.
      expect(result.failure.kind).toBe("low_confidence");
      return;
    }
    // If it scores, every reported measurement must still be a real
    // measurement — stance width cannot be 0 for a wide synthetic stance.
    const stance = result.value.measurements.find((m) => m.metricKey === "stance_width_ratio");
    if (stance) expect(stance.value).toBeGreaterThan(0.5);
    expect(result.value.resultKind === "scored" && stance?.value === 0).toBe(false);
  });

  it("NaN width must not produce a scored analysis", async () => {
    const { clip, providers } = buildWith({ width: Number.NaN, height: 1080 });
    const result = await analyzeClip(providers, clip, OPTIONS);
    if (result.ok) {
      expect(result.value.resultKind).not.toBe("scored");
      for (const measurement of result.value.measurements) {
        expect(Number.isFinite(measurement.value)).toBe(true);
      }
    } else {
      expect(result.failure.kind).toBe("low_confidence");
    }
  });

  it("height 0 falls back to aspect 1 (documented) and matches the square-video analysis", async () => {
    const square = buildWith({ width: 1080, height: 1080 });
    const zeroHeight = buildWith({ width: 1080, height: 0 });
    const a = await analyzeClip(square.providers, square.clip, OPTIONS);
    const b = await analyzeClip(zeroHeight.providers, zeroHeight.clip, OPTIONS);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.measurements).toEqual(a.value.measurements);
  });
});

describe("audit: RecordedTriggerStrokeDetector — window validity", () => {
  const base = {
    triggerModelVersion: "temporal-stroke-heuristic-2",
    peakMotionMs: 1000,
    confidence: 0.8,
  };
  const clip: VideoClipRef = { uri: "x", durationMs: 3000, fps: 60, width: 1, height: 1 };

  it("rejects an inverted window (documented)", async () => {
    const detector = new RecordedTriggerStrokeDetector({ ...base, startMs: 2000, endMs: 1000 });
    const result = await detector.detectStrokes(clip);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty window (documented)", async () => {
    const detector = new RecordedTriggerStrokeDetector({ ...base, startMs: 1000, endMs: 1000 });
    const result = await detector.detectStrokes(clip);
    expect(result.ok).toBe(false);
  });

  it("rejects a NaN window instead of emitting a StrokeEvent with NaN bounds", async () => {
    const detector = new RecordedTriggerStrokeDetector({
      ...base,
      startMs: Number.NaN,
      endMs: Number.NaN,
    });
    const result = await detector.detectStrokes(clip);
    expect(result.ok).toBe(false);
  });

  it("rejects a window with a NaN end", async () => {
    const detector = new RecordedTriggerStrokeDetector({
      ...base,
      startMs: 500,
      endMs: Number.NaN,
    });
    const result = await detector.detectStrokes(clip);
    expect(result.ok).toBe(false);
  });
});

describe("audit: RecordedPoseProvider — frame hygiene", () => {
  const clip: VideoClipRef = { uri: "x", durationMs: 3000, fps: 60, width: 1, height: 1 };
  const frame = (timestampMs: number) => ({
    timestampMs,
    space: "normalized-image" as const,
    confidence: 0.9,
    landmarks: [{ name: "right_wrist" as const, x: 0.5, y: 0.5, visibility: 0.9 }],
  });

  it("returns frames sorted regardless of input order", async () => {
    const provider = new RecordedPoseProvider({
      frames: [frame(300), frame(100), frame(500), frame(200), frame(400), frame(0), frame(600)],
      poseModelVersion: "p",
    });
    const result = await provider.extractPose(clip, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((f) => f.timestampMs)).toEqual([0, 100, 200, 300, 400, 500, 600]);
  });

  it("excludes NaN-timestamp frames from every window", async () => {
    const provider = new RecordedPoseProvider({
      frames: [0, 100, 200, 300, 400, 500, 600].map(frame).concat([frame(Number.NaN)]),
      poseModelVersion: "p",
    });
    const result = await provider.extractPose(clip, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.every((f) => Number.isFinite(f.timestampMs))).toBe(true);
  });

  it("does not let duplicate-timestamp frames satisfy the 6-frame minimum on their own", async () => {
    const provider = new RecordedPoseProvider({
      frames: [frame(100), frame(100), frame(100), frame(100), frame(100), frame(100), frame(100)],
      poseModelVersion: "p",
    });
    const result = await provider.extractPose(clip, { startMs: 0, endMs: 1000 });
    // Seven copies of one instant are one measured moment; the provider's
    // "at least 6 recorded frames" floor exists to guarantee temporal
    // coverage. Either a typed failure or a de-duplicated result is honest.
    if (result.ok) {
      expect(new Set(result.value.map((f) => f.timestampMs)).size).toBeGreaterThanOrEqual(6);
    } else {
      expect(result.failure.code).toBe("pose.too_few_recorded_frames");
    }
  });
});
