import { describe, expect, it } from "vitest";
import type { Measurement, PhaseSpan, PoseFrame } from "@pickle/shared-types";
import type { StrokeEvent } from "@pickle/vision-contracts";
import { PoseGeometryFeatureExtractor } from "../../src/featureExtractor.js";
import { GeometricPhaseSegmenter } from "../../src/phaseSegmenter.js";
import { generateSwing } from "@pickle/evaluation";

/**
 * ADJ-VG-04 — phase outer spans must be bounded by MEASURED pose frames, not
 * by the requested stroke window.
 *
 * apps/mobile/src/analysis/runCaptureAnalysis.ts analyses an imported clip
 * with `trigger.imported-full-clip` = {startMs: 0, endMs: clip.durationMs}.
 * When the pose frames only cover the swing, echoing the window into
 * `ready.startMs` / `recover.endMs` turns `recovery_time_ms` (a scored
 * target, 0-1000ms in @pickle/scoring v1) into "clip length minus swing".
 */

const stroke = (window: {
  startMs: number;
  endMs: number;
  peakMs: number | null;
}): StrokeEvent => ({
  startMs: window.startMs,
  endMs: window.endMs,
  contactMs: window.peakMs,
  shotTypeHypothesis: null,
  confidence: 0.9,
});

const IMPORTED_CLIP_MS = 60_000;

function firstAndLast(frames: readonly PoseFrame[]): { firstMs: number; lastMs: number } {
  const timestamps = frames.map((frame) => frame.timestampMs);
  return { firstMs: Math.min(...timestamps), lastMs: Math.max(...timestamps) };
}

async function segment(
  frames: PoseFrame[],
  window: { startMs: number; endMs: number; peakMs: number | null },
): Promise<PhaseSpan[]> {
  const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
  const result = await segmenter.segmentPhases(frames, [], stroke(window));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("segmentation failed");
  return result.value;
}

async function measure(
  frames: PoseFrame[],
  phases: PhaseSpan[],
): Promise<Map<string, Measurement>> {
  const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: 1 });
  const measured = await extractor.extractMeasurements({
    poseFrames: frames,
    paddleFrames: [],
    phases,
    shotType: "forehand_drive",
    handedness: "right",
    cameraView: "side",
  });
  expect(measured.ok, JSON.stringify(measured)).toBe(true);
  if (!measured.ok) throw new Error("feature extraction failed");
  return new Map(measured.value.map((entry) => [entry.metricKey, entry]));
}

describe("ADJ-VG-04 phaseSegmenter/featureExtractor: outer spans echo the requested window, inflating recovery_time_ms", () => {
  it("every phase span lies within [first measured frame, last measured frame] for a window wider than the frames", async () => {
    const swing = generateSwing();
    const { firstMs, lastMs } = firstAndLast(swing.frames);
    const phases = await segment(swing.frames, {
      startMs: 0,
      endMs: IMPORTED_CLIP_MS,
      peakMs: null,
    });
    for (const span of phases) {
      expect(span.startMs, JSON.stringify(span)).toBeGreaterThanOrEqual(firstMs);
      expect(span.endMs, JSON.stringify(span)).toBeLessThanOrEqual(lastMs);
      expect(span.representativeMs, JSON.stringify(span)).toBeGreaterThanOrEqual(span.startMs);
      expect(span.representativeMs, JSON.stringify(span)).toBeLessThanOrEqual(span.endMs);
    }
  });

  it("recover.endMs is bounded by the last measured frame", async () => {
    const swing = generateSwing();
    const { lastMs } = firstAndLast(swing.frames);
    const phases = await segment(swing.frames, {
      startMs: 0,
      endMs: IMPORTED_CLIP_MS,
      peakMs: null,
    });
    const recover = phases.find((span) => span.key === "recover")!;
    expect(recover.endMs, JSON.stringify(recover)).toBeLessThanOrEqual(lastMs);
  });

  it("ready.startMs is bounded by the first measured frame when the window starts earlier", async () => {
    const swing = generateSwing();
    // Pose only starts 500ms into the clip; the window still starts at 0.
    const late = swing.frames.map((frame) => ({ ...frame, timestampMs: frame.timestampMs + 500 }));
    const { firstMs } = firstAndLast(late);
    const phases = await segment(late, { startMs: 0, endMs: IMPORTED_CLIP_MS, peakMs: null });
    const ready = phases.find((span) => span.key === "ready")!;
    expect(ready.startMs, JSON.stringify(ready)).toBeGreaterThanOrEqual(firstMs);
  });

  it("recovery_time_ms cannot exceed the measured pose coverage", async () => {
    const swing = generateSwing();
    const { lastMs } = firstAndLast(swing.frames);
    const phases = await segment(swing.frames, {
      startMs: 0,
      endMs: IMPORTED_CLIP_MS,
      peakMs: null,
    });
    const follow = phases.find((span) => span.key === "follow_through")!;
    const byKey = await measure(swing.frames, phases);
    const recovery = byKey.get("recovery_time_ms");
    expect(recovery).toBeDefined();
    expect(recovery!.value, JSON.stringify(recovery)).toBeLessThanOrEqual(lastMs - follow.endMs);
  });

  it("recovery_time_ms is never greater than lastFrame - followSpan.endMs even when the phases claim more", async () => {
    const swing = generateSwing();
    const { lastMs } = firstAndLast(swing.frames);
    const phases = await segment(swing.frames, swing.window);
    // Phases handed to the extractor by another producer may still echo a
    // wide window; the extractor must bound the metric by measured frames.
    const inflated = phases.map((span) =>
      span.key === "recover" ? { ...span, endMs: IMPORTED_CLIP_MS } : span,
    );
    const follow = inflated.find((span) => span.key === "follow_through")!;
    const byKey = await measure(swing.frames, inflated);
    const recovery = byKey.get("recovery_time_ms");
    expect(recovery).toBeDefined();
    expect(recovery!.value, JSON.stringify(recovery)).toBeLessThanOrEqual(lastMs - follow.endMs);
  });

  it("withholds recovery_time_ms when no measured frame follows follow-through", async () => {
    const swing = generateSwing();
    const phases = await segment(swing.frames, swing.window);
    const follow = phases.find((span) => span.key === "follow_through")!;
    // Drop every frame after follow-through: recovery was never observed.
    const truncated = swing.frames.filter((frame) => frame.timestampMs <= follow.endMs);
    const byKey = await measure(truncated, phases);
    expect(byKey.get("recovery_time_ms")).toBeUndefined();
    // Control: the untruncated frames do measure a recovery.
    const control = await measure(swing.frames, phases);
    expect(control.get("recovery_time_ms")).toBeDefined();
  });

  it("a 60s imported-clip window yields the same phases and recovery_time_ms as a tight window over the same frames", async () => {
    const swing = generateSwing();
    const tight = await segment(swing.frames, swing.window);
    const imported = await segment(swing.frames, {
      startMs: 0,
      endMs: IMPORTED_CLIP_MS,
      peakMs: swing.window.peakMs,
    });
    expect(imported).toEqual(tight);

    const tightRecovery = (await measure(swing.frames, tight)).get("recovery_time_ms");
    const importedRecovery = (await measure(swing.frames, imported)).get("recovery_time_ms");
    expect(tightRecovery).toBeDefined();
    expect(importedRecovery).toEqual(tightRecovery);
  });
});
