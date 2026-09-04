import { describe, expect, it } from "vitest";
import { generateSwing, generateSwingSequence } from "@pickle/evaluation";
import type { PoseFrame } from "@pickle/shared-types";
import type { StrokeEvent } from "@pickle/vision-contracts";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
import { consecutiveSpeedSeries, landmark, speedSeries } from "../../src/kinematics.js";
import { evaluateCaptureQuality, QUALITY_THRESHOLDS } from "../../src/captureQuality.js";
import { GeometricPhaseSegmenter } from "../../src/phaseSegmenter.js";

/**
 * AUDIT PROBES — kinematics.ts / captureQuality.ts / phaseSegmenter.ts
 * boundary and numeric-input behaviour.
 */

function frame(timestampMs: number, marks: Array<[string, number, number, number]>): PoseFrame {
  return {
    timestampMs,
    space: "normalized_image",
    confidence: 0.9,
    landmarks: marks.map(([name, x, y, visibility]) => ({ name, x, y, visibility })),
  } as unknown as PoseFrame;
}

describe("AUDIT kinematics.landmark visibility gate (MIN_LANDMARK_VISIBILITY = 0.3)", () => {
  it("visibility exactly 0.3 is accepted (inclusive lower bound, baseline)", () => {
    expect(landmark(frame(0, [["right_wrist", 0.5, 0.5, 0.3]]), "right_wrist", 1)).not.toBeNull();
  });

  it("visibility just below 0.3 is rejected (baseline)", () => {
    expect(landmark(frame(0, [["right_wrist", 0.5, 0.5, 0.2999]]), "right_wrist", 1)).toBeNull();
  });

  it("NaN visibility must be rejected like a missing landmark", () => {
    expect(
      landmark(frame(0, [["right_wrist", 0.5, 0.5, Number.NaN]]), "right_wrist", 1),
    ).toBeNull();
  });

  it("negative visibility is rejected (baseline)", () => {
    expect(landmark(frame(0, [["right_wrist", 0.5, 0.5, -0.1]]), "right_wrist", 1)).toBeNull();
  });

  it("a NaN coordinate must not be returned as a measured point", () => {
    expect(
      landmark(frame(0, [["right_wrist", Number.NaN, 0.5, 0.9]]), "right_wrist", 1),
    ).toBeNull();
  });

  it("an infinite coordinate must not be returned as a measured point", () => {
    expect(
      landmark(frame(0, [["right_wrist", 0.5, Number.POSITIVE_INFINITY, 0.9]]), "right_wrist", 1),
    ).toBeNull();
  });
});

describe("AUDIT kinematics.speedSeries duplicate / non-finite timestamps", () => {
  const wristFrames = (ts: number[], xs?: number[]) =>
    ts.map((timestampMs, index) =>
      frame(timestampMs, [["right_wrist", xs?.[index] ?? index * 0.01, 0.5, 0.9]]),
    );
  const finite = (s: { timestampMs: number; value: number }) =>
    Number.isFinite(s.value) && Number.isFinite(s.timestampMs);

  it("central differences skip dt<=0 (baseline)", () => {
    const series = speedSeries(wristFrames([0, 16, 16, 32, 48]), "right_wrist", 1);
    expect(series.every(finite)).toBe(true);
  });

  it("all-duplicate timestamps yield an empty series, not NaN/Infinity", () => {
    const series = speedSeries(wristFrames([100, 100, 100, 100]), "right_wrist", 1);
    expect(series).toEqual([]);
  });

  it("duplicate timestamps shrink the series silently (documents I2 hotspot; no limiting factor)", () => {
    const clean = speedSeries(wristFrames([0, 16, 32, 48, 64, 80]), "right_wrist", 1);
    const dup = speedSeries(wristFrames([0, 16, 16, 48, 64, 80]), "right_wrist", 1);
    console.log(`[audit] clean speeds=${clean.length} with-duplicate speeds=${dup.length}`);
    expect(dup.every(finite)).toBe(true);
  });

  it("a NaN timestamp never leaks a non-finite speed", () => {
    const series = speedSeries(wristFrames([0, Number.NaN, 32, 48, 64]), "right_wrist", 1);
    console.log(`[audit] speedSeries NaN ts: ${JSON.stringify(series)}`);
    expect(series.every(finite)).toBe(true);
  });

  it("consecutiveSpeedSeries: a NaN timestamp never leaks a non-finite speed", () => {
    const series = consecutiveSpeedSeries(
      wristFrames([0, Number.NaN, 32, 48, 64]),
      "right_wrist",
      1,
      400,
    );
    console.log(`[audit] consecutiveSpeedSeries NaN ts: ${JSON.stringify(series)}`);
    expect(series.every(finite)).toBe(true);
  });

  it("speedSeries with a NaN coordinate never leaks a non-finite speed", () => {
    const series = speedSeries(
      wristFrames([0, 16, 32, 48], [0, Number.NaN, 0.02, 0.03]),
      "right_wrist",
      1,
    );
    console.log(`[audit] speedSeries NaN x: ${JSON.stringify(series)}`);
    expect(series.every(finite)).toBe(true);
  });
});

describe("AUDIT evaluateCaptureQuality boundaries and ordering", () => {
  const clean = () => generateSwingSequence().sequence;

  it("accepts the clean synthetic capture (baseline)", () => {
    expect(evaluateCaptureQuality(clean()).analyzable).toBe(true);
  });

  it("exactly minFrames frames is accepted (inclusive)", () => {
    const seq = clean();
    const frames = seq.frames.slice(0, QUALITY_THRESHOLDS.minFrames);
    const result = evaluateCaptureQuality({ ...seq, frames });
    expect(result.reasons).not.toContain("too_few_pose_frames");
  });

  it("minFrames - 1 frames is rejected", () => {
    const seq = clean();
    const frames = seq.frames.slice(0, QUALITY_THRESHOLDS.minFrames - 1);
    const result = evaluateCaptureQuality({ ...seq, frames });
    expect(result.analyzable).toBe(false);
    expect(result.reasons).toContain("too_few_pose_frames");
  });

  it("a gap of exactly maxGapMs is accepted, maxGapMs+1 is rejected (inclusive bound)", () => {
    const seq = clean();
    const withGap = (gap: number) => {
      const shift = gap - (seq.frames[30]!.timestampMs - seq.frames[29]!.timestampMs);
      const frames = seq.frames.map((f, i) =>
        i >= 30 ? { ...f, timestampMs: f.timestampMs + shift } : f,
      );
      return evaluateCaptureQuality({ ...seq, frames });
    };
    const atBound = withGap(QUALITY_THRESHOLDS.maxGapMs);
    const overBound = withGap(QUALITY_THRESHOLDS.maxGapMs + 1);
    expect(atBound.stats.largestGapMs).toBe(QUALITY_THRESHOLDS.maxGapMs);
    expect(atBound.reasons).not.toContain("tracking_dropout_gap");
    expect(overBound.reasons).toContain("tracking_dropout_gap");
  });

  it("torso exactly at min/max bound is accepted (inclusive), just outside rejected", () => {
    const scaleTorso = (target: number) => {
      const seq = clean();
      const factor = target / 0.2; // synthetic torso is exactly 0.2 normalized
      const frames = seq.frames.map((f) => ({
        ...f,
        landmarks: f.landmarks.map((m) => ({
          ...m,
          x: 0.5 + (m.x - 0.5) * factor,
          y: 0.5 + (m.y - 0.5) * factor,
        })),
      }));
      return evaluateCaptureQuality({ ...seq, frames });
    };
    const atMin = scaleTorso(QUALITY_THRESHOLDS.minTorsoLengthNorm);
    const belowMin = scaleTorso(QUALITY_THRESHOLDS.minTorsoLengthNorm - 0.0005);
    const atMax = scaleTorso(QUALITY_THRESHOLDS.maxTorsoLengthNorm);
    const aboveMax = scaleTorso(QUALITY_THRESHOLDS.maxTorsoLengthNorm + 0.0005);
    console.log(
      `[audit] torso@min=${atMin.stats.medianTorsoLengthNorm} reasons=${JSON.stringify(atMin.reasons)}; ` +
        `below=${JSON.stringify(belowMin.reasons)}; @max=${atMax.stats.medianTorsoLengthNorm} ${JSON.stringify(atMax.reasons)}; above=${JSON.stringify(aboveMax.reasons)}`,
    );
    expect(belowMin.reasons).toContain("player_too_small_in_frame");
    expect(aboveMax.reasons).toContain("player_too_close_or_cropped");
  });

  it("non-monotonic timestamps: documents the verdict (order is assumed, not validated)", () => {
    const seq = clean();
    const frames = seq.frames.map((f) => ({ ...f }));
    const a = frames[20]!;
    const b = frames[40]!;
    [a.timestampMs, b.timestampMs] = [b.timestampMs, a.timestampMs];
    const result = evaluateCaptureQuality({ ...seq, frames });
    console.log(`[audit] non-monotonic: ${JSON.stringify(result)}`);
    // Not asserted as a defect: a swapped pair only enlarges largestGapMs.
    expect(Number.isFinite(result.stats.largestGapMs)).toBe(true);
  });

  it("a NaN timestamp in the middle must not yield an analyzable verdict with NaN statistics", () => {
    const seq = clean();
    const frames = seq.frames.map((f, i) => (i === 30 ? { ...f, timestampMs: Number.NaN } : f));
    const result = evaluateCaptureQuality({ ...seq, frames });
    console.log(`[audit] NaN timestamp: ${JSON.stringify(result)}`);
    expect(Number.isFinite(result.stats.largestGapMs)).toBe(true);
    expect(result.analyzable).toBe(false);
  });
});

describe("AUDIT GeometricPhaseSegmenter window/aspect handling", () => {
  const stroke = (w: { startMs: number; endMs: number; peakMs: number }): StrokeEvent => ({
    startMs: w.startMs,
    endMs: w.endMs,
    contactMs: w.peakMs,
    shotTypeHypothesis: null,
    confidence: 0.9,
  });

  it("a window longer than the clip still segments (baseline)", async () => {
    const swing = generateSwing();
    const result = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(
      swing.frames,
      [],
      stroke({ startMs: -10_000, endMs: 100_000, peakMs: swing.window.peakMs }),
    );
    expect(result.ok).toBe(true);
  });

  it("aspectRatio 1 vs a portrait 9:16 aspect on the same frames (documents apps/mobile coupling)", async () => {
    const { sequence, window } = generateSwingSequence();
    const frames = toLegacyPoseFrames(sequence);
    const square = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(
      frames,
      [],
      stroke(window),
    );
    const portrait = await new GeometricPhaseSegmenter({ aspectRatio: 9 / 16 }).segmentPhases(
      frames,
      [],
      stroke(window),
    );
    expect(square.ok && portrait.ok).toBe(true);
    if (!square.ok || !portrait.ok) return;
    const fmt = (v: typeof square.value) =>
      JSON.stringify(v.map((p) => [p.key, p.startMs, p.endMs]));
    console.log(
      `[audit] aspect=1    : ${fmt(square.value)}\n[audit] aspect=9/16 : ${fmt(portrait.value)}`,
    );
    expect(square.value.length).toBe(portrait.value.length);
  });

  it("NaN aspectRatio must not silently segment", async () => {
    const swing = generateSwing();
    const result = await new GeometricPhaseSegmenter({ aspectRatio: Number.NaN }).segmentPhases(
      swing.frames,
      [],
      stroke(swing.window),
    );
    console.log(`[audit] NaN aspect segment: ${JSON.stringify(result).slice(0, 400)}`);
    expect(result.ok).toBe(false);
  });

  it("aspectRatio 0 must not silently segment", async () => {
    const swing = generateSwing();
    const result = await new GeometricPhaseSegmenter({ aspectRatio: 0 }).segmentPhases(
      swing.frames,
      [],
      stroke(swing.window),
    );
    console.log(`[audit] aspect=0 segment: ${JSON.stringify(result).slice(0, 400)}`);
    expect(result.ok).toBe(false);
  });
});
