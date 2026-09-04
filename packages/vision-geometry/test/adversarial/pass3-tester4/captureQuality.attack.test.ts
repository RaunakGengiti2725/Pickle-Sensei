import { describe, expect, it } from "vitest";
import type { PoseFrame } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";
import { POSE_SEQUENCE_FORMAT, POSE_SEQUENCE_SCHEMA_VERSION } from "@pickle/swing-domain";
import { evaluateCaptureQuality, QUALITY_THRESHOLDS } from "../../../src/index.js";
import { exactTorsoFrames, seededRandom, timestampsEvery } from "./support/attackFixtures.js";

/**
 * ADVERSARIAL PASS 3 / TESTER 4 — evaluateCaptureQuality.
 *  S8: absurd fps (48 frames within 10ms) and monotonically decreasing
 *      timestamps → a SPECIFIC reason code, finite stats.
 *  S9: exact inclusive/exclusive boundaries of QUALITY_THRESHOLDS.
 *
 * `it.fails` = reproduced BROKEN expectation; the following `observed:` case
 * pins the actual behaviour as evidence.
 */

const STEP_60FPS = 1000 / 60;

function sequenceOf(frames: PoseFrame[]): PoseSequence {
  return {
    schemaVersion: POSE_SEQUENCE_SCHEMA_VERSION,
    format: POSE_SEQUENCE_FORMAT,
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "attack.fixture",
      modelVersion: "tester4",
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
    },
    video: { width: 1080, height: 1920, fps: 60 },
    frames: frames.map((frame, frameIndex) => ({
      frameIndex,
      timestampMs: frame.timestampMs,
      confidence: frame.confidence,
      landmarks: frame.landmarks.map((mark) => ({ ...mark })),
    })),
  };
}

function bodyAt(timestamps: readonly number[], torsoLength = 0.2): PoseSequence {
  return sequenceOf(exactTorsoFrames({ torsoLength, timestamps }));
}

function finiteStats(report: ReturnType<typeof evaluateCaptureQuality>): string[] {
  return Object.entries(report.stats)
    .filter(([, value]) => !Number.isFinite(value))
    .map(([key, value]) => `${key}=${String(value)}`);
}

describe("S8 absurd timestamps: 48 frames within 10ms, and monotonically decreasing", () => {
  const within10ms = Array.from({ length: 48 }, (_, index) => (index * 10) / 47);

  it("control: 48 frames at 60fps with a 0.2 torso are analyzable with no reasons", () => {
    const report = evaluateCaptureQuality(bodyAt(timestampsEvery(STEP_60FPS, 48)));
    expect(report.analyzable).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(finiteStats(report)).toEqual([]);
  });

  it("48 frames within 10ms: every stat is finite (no Infinity/NaN fps)", () => {
    const report = evaluateCaptureQuality(bodyAt(within10ms));
    expect(finiteStats(report)).toEqual([]);
    expect(report.stats.effectiveFps).toBe(4700);
    expect(report.stats.durationMs).toBe(10);
  });

  it.fails(
    "48 frames within 10ms (4700 fps, a 10ms clip) → NOT analyzable, with a specific reason code",
    () => {
      const report = evaluateCaptureQuality(bodyAt(within10ms));
      expect(report.analyzable).toBe(false);
      expect(report.reasons.length).toBeGreaterThan(0);
    },
  );

  it("observed: 48 frames within 10ms is reported ANALYZABLE with zero reasons at effectiveFps 4700 (evidence for the P2 above)", () => {
    const report = evaluateCaptureQuality(bodyAt(within10ms));
    expect(report.analyzable).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(report.stats.effectiveFps).toBe(4700);
  });

  it.fails(
    "48 frames with IDENTICAL timestamps (duration 0) → NOT analyzable with a specific reason (not a silent fps 0)",
    () => {
      const report = evaluateCaptureQuality(bodyAt(Array.from({ length: 48 }, () => 1000)));
      expect(report.analyzable).toBe(false);
    },
  );

  it("observed: identical timestamps → analyzable:true, effectiveFps 0, durationMs 0, reasons [] (the `effectiveFps > 0` guard swallows it)", () => {
    const report = evaluateCaptureQuality(bodyAt(Array.from({ length: 48 }, () => 1000)));
    expect(report.analyzable).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(report.stats.effectiveFps).toBe(0);
    expect(report.stats.durationMs).toBe(0);
  });

  it.fails(
    "monotonically decreasing timestamps (48 frames, 60fps reversed) → NOT analyzable with a specific reason code",
    () => {
      const reversed = timestampsEvery(STEP_60FPS, 48).reverse();
      const report = evaluateCaptureQuality(bodyAt(reversed));
      expect(report.analyzable).toBe(false);
      expect(report.reasons.length).toBeGreaterThan(0);
    },
  );

  it("observed: reversed timestamps → analyzable:true, reasons [], durationMs NEGATIVE, effectiveFps 0, largestGapMs 0 (evidence for the P2 above)", () => {
    const reversed = timestampsEvery(STEP_60FPS, 48).reverse();
    const report = evaluateCaptureQuality(bodyAt(reversed));
    expect(finiteStats(report)).toEqual([]);
    expect(report.analyzable).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(report.stats.durationMs).toBeLessThan(0);
    expect(report.stats.effectiveFps).toBe(0);
    expect(report.stats.largestGapMs).toBe(0);
  });

  it.fails(
    "reversed timestamps with a real 2s dropout inside → tracking_dropout_gap must still be reported",
    () => {
      const forward = [
        ...timestampsEvery(STEP_60FPS, 24),
        ...timestampsEvery(STEP_60FPS, 24, 2400),
      ];
      const reversed = [...forward].reverse();
      const report = evaluateCaptureQuality(bodyAt(reversed));
      expect(report.reasons).toContain("tracking_dropout_gap");
    },
  );

  it("observed: a 2s dropout hides completely when timestamps run backwards (negative deltas never raise largestGapMs)", () => {
    const forward = [...timestampsEvery(STEP_60FPS, 24), ...timestampsEvery(STEP_60FPS, 24, 2400)];
    expect(evaluateCaptureQuality(bodyAt(forward)).reasons).toContain("tracking_dropout_gap");
    const report = evaluateCaptureQuality(bodyAt([...forward].reverse()));
    expect(report.reasons).not.toContain("tracking_dropout_gap");
    expect(report.stats.largestGapMs).toBe(0);
  });

  it("shuffled (seed 0x7e57e4) timestamps: stats stay finite; the order-dependence of the verdict is recorded", () => {
    const random = seededRandom(0x7e57e4);
    const ordered = timestampsEvery(STEP_60FPS, 48);
    const shuffled = [...ordered];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
    }
    const report = evaluateCaptureQuality(bodyAt(shuffled));
    expect(finiteStats(report)).toEqual([]);
    expect(report.stats.frameCount).toBe(48);
  });

  it("NaN timestamps: stats must not contain NaN — pinned as observed (durationMs/effectiveFps/largestGapMs)", () => {
    const withNaN = timestampsEvery(STEP_60FPS, 48);
    withNaN[10] = Number.NaN;
    const report = evaluateCaptureQuality(bodyAt(withNaN));
    // Recorded behaviour: a NaN in the middle does not reach duration (first/last
    // only) but does poison Math.max → largestGapMs becomes NaN.
    expect(Number.isFinite(report.stats.durationMs)).toBe(true);
    expect(Number.isNaN(report.stats.largestGapMs)).toBe(true);
    expect(report.analyzable).toBe(true);
  });

  it("huge input: 200k frames (~55 min @60fps) evaluates in bounded time with finite stats", () => {
    const started = performance.now();
    const report = evaluateCaptureQuality(bodyAt(timestampsEvery(STEP_60FPS, 200_000)));
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(finiteStats(report)).toEqual([]);
    expect(report.analyzable).toBe(true);
  });

  it("empty sequence → not analyzable with too_few_pose_frames + torso_not_measured, finite stats", () => {
    const report = evaluateCaptureQuality(bodyAt([]));
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("too_few_pose_frames");
    expect(report.reasons).toContain("torso_not_measured");
    expect(finiteStats(report)).toEqual([]);
  });
});

describe("S9 QUALITY_THRESHOLDS exact boundaries", () => {
  it("pins the constants this suite is written against", () => {
    expect(QUALITY_THRESHOLDS).toEqual({
      minFrames: 24,
      minEffectiveFps: 24,
      minMeanFrameConfidence: 0.35,
      minFullBodyFrameRate: 0.5,
      minTorsoLengthNorm: 0.08,
      maxTorsoLengthNorm: 0.6,
      maxGapMs: 700,
    });
  });

  it("frames: exactly 24 passes, exactly 23 fails (minFrames inclusive at 24)", () => {
    const at24 = evaluateCaptureQuality(bodyAt(timestampsEvery(STEP_60FPS, 24)));
    expect(at24.reasons).not.toContain("too_few_pose_frames");
    expect(at24.analyzable).toBe(true);
    const at23 = evaluateCaptureQuality(bodyAt(timestampsEvery(STEP_60FPS, 23)));
    expect(at23.reasons).toContain("too_few_pose_frames");
    expect(at23.analyzable).toBe(false);
  });

  it("gap: exactly 700ms passes, exactly 701ms fails (maxGapMs inclusive at 700)", () => {
    const build = (gapMs: number) => [
      ...timestampsEvery(20, 30),
      ...timestampsEvery(20, 30, 29 * 20 + gapMs),
    ];
    const at700 = evaluateCaptureQuality(bodyAt(build(700)));
    expect(at700.stats.largestGapMs).toBe(700);
    expect(at700.reasons).not.toContain("tracking_dropout_gap");
    expect(at700.analyzable).toBe(true);
    const at701 = evaluateCaptureQuality(bodyAt(build(701)));
    expect(at701.stats.largestGapMs).toBe(701);
    expect(at701.reasons).toContain("tracking_dropout_gap");
  });

  it("torso: exactly 0.08 passes (minTorsoLengthNorm inclusive), one ulp below fails", () => {
    const timestamps = timestampsEvery(STEP_60FPS, 48);
    const at = evaluateCaptureQuality(bodyAt(timestamps, 0.08));
    expect(at.stats.medianTorsoLengthNorm).toBe(0.08);
    expect(at.reasons).not.toContain("player_too_small_in_frame");
    expect(at.analyzable).toBe(true);
    const below = evaluateCaptureQuality(bodyAt(timestamps, 0.08 - Number.EPSILON * 0.08));
    expect(below.stats.medianTorsoLengthNorm).toBeLessThan(0.08);
    expect(below.reasons).toContain("player_too_small_in_frame");
  });

  it("torso: exactly 0.6 passes (maxTorsoLengthNorm inclusive), one ulp above fails", () => {
    const timestamps = timestampsEvery(STEP_60FPS, 48);
    const at = evaluateCaptureQuality(bodyAt(timestamps, 0.6));
    expect(at.stats.medianTorsoLengthNorm).toBe(0.6);
    expect(at.reasons).not.toContain("player_too_close_or_cropped");
    const above = evaluateCaptureQuality(bodyAt(timestamps, 0.6 + Number.EPSILON));
    expect(above.stats.medianTorsoLengthNorm).toBeGreaterThan(0.6);
    expect(above.reasons).toContain("player_too_close_or_cropped");
  });

  it("torso too-small and too-close are mutually exclusive (else-if chain): only one torso reason ever appears", () => {
    for (const torso of [0, 0.01, 0.08, 0.3, 0.6, 0.61, 5]) {
      const report = evaluateCaptureQuality(bodyAt(timestampsEvery(STEP_60FPS, 48), torso));
      const torsoReasons = report.reasons.filter(
        (reason) =>
          reason === "player_too_small_in_frame" || reason === "player_too_close_or_cropped",
      );
      expect(torsoReasons.length, `torso ${torso}`).toBeLessThanOrEqual(1);
    }
  });

  it("fps: exactly 24.0 passes (minEffectiveFps inclusive), 23.999… fails", () => {
    // 25 frames spanning exactly 1000ms → (25-1)*1000/1000 = 24 fps exactly.
    const exact = evaluateCaptureQuality(bodyAt(timestampsEvery(1000 / 24, 25)));
    expect(exact.stats.effectiveFps).toBeCloseTo(24, 12);
    expect(exact.reasons).not.toContain("insufficient_fps");
    const exactInts = evaluateCaptureQuality(
      bodyAt(Array.from({ length: 25 }, (_, index) => Math.round((index * 1000) / 24))),
    );
    expect(exactInts.stats.effectiveFps).toBe(24);
    expect(exactInts.reasons).not.toContain("insufficient_fps");
    const below = evaluateCaptureQuality(
      bodyAt(
        Array.from(
          { length: 25 },
          (_, index) => Math.round((index * 1000) / 24) + (index === 24 ? 1 : 0),
        ),
      ),
    );
    expect(below.stats.effectiveFps).toBeLessThan(24);
    expect(below.reasons).toContain("insufficient_fps");
  });

  it.fails(
    "mean frame confidence: 48 frames each EXACTLY 0.35 must pass the inclusive threshold (mean of identical values is the value)",
    () => {
      const timestamps = timestampsEvery(STEP_60FPS, 48);
      const at = evaluateCaptureQuality(
        sequenceOf(exactTorsoFrames({ torsoLength: 0.2, timestamps, confidence: 0.35 })),
      );
      expect(at.stats.meanFrameConfidence).toBe(0.35);
      expect(at.reasons).not.toContain("low_pose_confidence");
    },
  );

  it("observed: naive summation drifts — mean(48 × 0.35) = 0.34999999999999987 → low_pose_confidence fires at the exact threshold; 12 frames does not (frame-count dependent verdict)", () => {
    const at48 = evaluateCaptureQuality(
      sequenceOf(
        exactTorsoFrames({
          torsoLength: 0.2,
          timestamps: timestampsEvery(STEP_60FPS, 48),
          confidence: 0.35,
        }),
      ),
    );
    expect(at48.stats.meanFrameConfidence).toBeLessThan(0.35);
    expect(at48.stats.meanFrameConfidence).toBeCloseTo(0.35, 12);
    expect(at48.reasons).toContain("low_pose_confidence");
    expect(at48.analyzable).toBe(false);
    // 12 frames: no drift → passes (too_few_pose_frames is the only reason).
    const at12 = evaluateCaptureQuality(
      sequenceOf(
        exactTorsoFrames({
          torsoLength: 0.2,
          timestamps: timestampsEvery(STEP_60FPS, 12),
          confidence: 0.35,
        }),
      ),
    );
    expect(at12.stats.meanFrameConfidence).toBeGreaterThanOrEqual(0.35);
    expect(at12.reasons).not.toContain("low_pose_confidence");
    // Sweep: for n in 1..300 the drift below 0.35 occurs at these frame counts
    // (deterministic IEEE-754 left-fold), including the whole 15..50 band.
    const drifting: number[] = [];
    for (let count = 1; count <= 300; count += 1) {
      const report = evaluateCaptureQuality(
        sequenceOf(
          exactTorsoFrames({
            torsoLength: 0.2,
            timestamps: timestampsEvery(STEP_60FPS, count),
            confidence: 0.35,
          }),
        ),
      );
      if (report.reasons.includes("low_pose_confidence")) drifting.push(count);
    }
    expect(drifting).toContain(24);
    expect(drifting).toContain(48);
    expect(drifting).not.toContain(12);
    expect(drifting).not.toContain(60);
  });

  it("mean frame confidence: 0.35 − ulp on every frame fails (the strict side of the threshold is correct)", () => {
    const below = evaluateCaptureQuality(
      sequenceOf(
        exactTorsoFrames({
          torsoLength: 0.2,
          timestamps: timestampsEvery(STEP_60FPS, 48),
          confidence: 0.35 - Number.EPSILON,
        }),
      ),
    );
    expect(below.reasons).toContain("low_pose_confidence");
  });

  it("full-body rate: exactly 0.5 (24 of 48 frames) passes, 23 of 48 fails", () => {
    const timestamps = timestampsEvery(STEP_60FPS, 48);
    const withHidden = (hiddenFrames: number) =>
      sequenceOf(
        exactTorsoFrames({ torsoLength: 0.2, timestamps }).map((frame, index) =>
          index < hiddenFrames
            ? {
                ...frame,
                landmarks: frame.landmarks.map((mark) =>
                  mark.name === "left_ankle" ? { ...mark, visibility: 0.1 } : mark,
                ),
              }
            : frame,
        ),
      );
    const half = evaluateCaptureQuality(withHidden(24));
    expect(half.stats.fullBodyFrameRate).toBe(0.5);
    expect(half.reasons).not.toContain("body_not_fully_visible");
    const under = evaluateCaptureQuality(withHidden(25));
    expect(under.stats.fullBodyFrameRate).toBeLessThan(0.5);
    expect(under.reasons).toContain("body_not_fully_visible");
  });

  it("core-joint visibility: exactly 0.3 counts as visible (inclusive), 0.3 − ulp does not", () => {
    const timestamps = timestampsEvery(STEP_60FPS, 48);
    const withVisibility = (visibility: number) =>
      sequenceOf(exactTorsoFrames({ torsoLength: 0.2, timestamps, visibility }));
    expect(evaluateCaptureQuality(withVisibility(0.3)).stats.fullBodyFrameRate).toBe(1);
    expect(
      evaluateCaptureQuality(withVisibility(0.3 - Number.EPSILON)).stats.fullBodyFrameRate,
    ).toBe(0);
  });

  it("torso length is measured regardless of landmark visibility (visibility 0 hips still contribute) — pinned as observed", () => {
    const timestamps = timestampsEvery(STEP_60FPS, 48);
    const report = evaluateCaptureQuality(
      sequenceOf(exactTorsoFrames({ torsoLength: 0.2, timestamps, visibility: 0 })),
    );
    expect(report.stats.medianTorsoLengthNorm).toBe(0.2);
    expect(report.reasons).not.toContain("torso_not_measured");
    expect(report.reasons).toContain("body_not_fully_visible");
  });
});
