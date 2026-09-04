import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { BallObservation, PoseSequence } from "@pickle/swing-domain";
import { estimateContact, evaluateCaptureQuality } from "../src/index.js";

/**
 * Structural audit (pass 1) — estimateContact / evaluateCaptureQuality.
 *
 * Every test here encodes an EXPECTED contract taken from the module's own
 * documentation (I1: landmarks below visibility 0.3 are skipped; I7: a ball
 * turn far from every measured target reference cannot create/confirm
 * contact; capture quality reasons are measured, not order-dependent). A
 * failing test is a reproduced defect on the audited commit, not a tuning
 * opinion.
 */

/** The far-side ball track from the existing "gates ball turns" fixture:
 * a sharp turn at peak-280ms, ~2.5 torso spans from the target. */
function farSideBall(peakMs: number): BallObservation[] {
  return Array.from({ length: 10 }, (_, index) => {
    const t = peakMs - 400 + index * 30;
    const before = index <= 4;
    return {
      frameIndex: index,
      timestampMs: t,
      x: before ? 0.15 + index * 0.03 : 0.27 - (index - 4) * 0.03,
      y: 0.15,
      confidence: 0.8,
    };
  });
}

/** Inject an UNMEASURED (visibility 0) left-wrist landmark at `point` into
 * every frame within ±band of `tMs`. Vision emits all joints with a
 * confidence; a zero-confidence joint carries no positional information. */
function withGhostWrist(
  sequence: PoseSequence,
  tMs: number,
  point: { x: number; y: number },
  bandMs: number,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      Math.abs(frame.timestampMs - tMs) <= bandMs
        ? {
            ...frame,
            landmarks: frame.landmarks.map((mark) =>
              mark.name === "left_wrist"
                ? { ...mark, x: point.x, y: point.y, visibility: 0 }
                : mark,
            ),
          }
        : frame,
    ),
  };
}

describe("audit: estimateContact — zero-visibility landmarks must carry no evidence (I1/I7)", () => {
  it("control: far-side turn with no ghost wrist is rejected (baseline behaviour)", () => {
    const { sequence, window } = generateSwingSequence();
    const targetWrists = Array.from({ length: 60 }, (_, index) => ({
      timestampMs: window.startMs + index * 30,
      x: 0.6,
      y: 0.7,
    }));
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: farSideBall(window.peakMs),
      targetWrists,
    });
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(estimate.supportingEvidence.map((signal) => signal.signal)).not.toContain(
      "ball_direction_change",
    );
    expect(estimate.ballConfirmed).toBe(false);
  });

  it("a visibility-0 wrist landmark at the far-side turn point must NOT tether the turn", () => {
    const { sequence, window } = generateSwingSequence();
    const turnMs = window.peakMs - 280; // index 4 of farSideBall
    const ghosted = withGhostWrist(sequence, turnMs, { x: 0.27, y: 0.15 }, 100);
    const targetWrists = Array.from({ length: 60 }, (_, index) => ({
      timestampMs: window.startMs + index * 30,
      x: 0.6,
      y: 0.7,
    }));
    const estimate = estimateContact({
      sequence: ghosted,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: farSideBall(window.peakMs),
      targetWrists,
    });
    // Same contract as the control: the ghost carries no measurement.
    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(estimate.supportingEvidence.map((signal) => signal.signal)).not.toContain(
      "ball_direction_change",
    );
    expect(estimate.ballConfirmed).toBe(false);
    expect(Math.abs(estimate.estimatedContactMs - window.peakMs)).toBeLessThanOrEqual(60);
  });

  it("a visibility-0 wrist must not turn a 'ball observed away from target' abstention into a confirmed contact", () => {
    const { sequence, window } = generateSwingSequence();
    // Existing fixture: the far-side ball is visible exactly when motion peaks
    // → estimator abstains ("refutes contact"). The only change here is an
    // unmeasured (visibility 0) wrist landmark sitting at the ball.
    const ball: BallObservation[] = Array.from({ length: 10 }, (_, index) => {
      const t = window.peakMs - 150 + index * 30;
      const before = index <= 4;
      return {
        frameIndex: index,
        timestampMs: t,
        x: before ? 0.15 + index * 0.03 : 0.27 - (index - 4) * 0.03,
        y: 0.15,
        confidence: 0.8,
      };
    });
    const paddleSpeeds = Array.from({ length: 40 }, (_, index) => {
      const t = window.peakMs - 400 + index * 20;
      return { timestampMs: t, value: Math.max(0, 2.4 - Math.abs(t - window.peakMs) / 90) };
    });
    const args = {
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: ball,
      paddleSpeeds,
    };
    const control = estimateContact({ ...args, sequence });
    expect(control.status).toBe("abstained");

    const ghosted = estimateContact({
      ...args,
      sequence: withGhostWrist(sequence, window.peakMs - 30, { x: 0.27, y: 0.15 }, 200),
    });
    expect(ghosted.status).toBe("abstained");
  });

  it("a visibility-0 wrist near the ball must not change the estimate vs the control (no targetWrists)", () => {
    const { sequence, window } = generateSwingSequence();
    const turnMs = window.peakMs - 280;
    const control = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: farSideBall(window.peakMs),
    });
    const ghosted = estimateContact({
      sequence: withGhostWrist(sequence, turnMs, { x: 0.27, y: 0.15 }, 100),
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: farSideBall(window.peakMs),
    });
    expect(ghosted).toEqual(control);
  });
});

describe("audit: estimateContact — input hygiene", () => {
  it("is independent of ball / paddle sample order", () => {
    const { sequence, window } = generateSwingSequence();
    const ball: BallObservation[] = Array.from({ length: 14 }, (_, index) => {
      const t = window.peakMs - 180 + index * 30;
      const before = t <= window.peakMs;
      return {
        frameIndex: index,
        timestampMs: t,
        x: before
          ? 0.9 - ((t - (window.peakMs - 180)) / 180) * 0.3
          : 0.6 + ((t - window.peakMs) / 180) * 0.3,
        y: before
          ? 0.4 + ((t - (window.peakMs - 180)) / 180) * 0.15
          : 0.55 - ((t - window.peakMs) / 180) * 0.2,
        confidence: 0.8,
      };
    });
    const paddleSpeeds = Array.from({ length: 40 }, (_, index) => {
      const t = window.peakMs - 400 + index * 20;
      return { timestampMs: t, value: Math.max(0, 2.4 - Math.abs(t - window.peakMs) / 90) };
    });
    const paddleCenters = paddleSpeeds.map((sample) => ({
      timestampMs: sample.timestampMs,
      x: 0.6,
      y: 0.55,
    }));
    const args = {
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
    };
    const ordered = estimateContact({
      ...args,
      ballObservations: ball,
      paddleSpeeds,
      paddleCenters,
    });
    const shuffled = estimateContact({
      ...args,
      ballObservations: [...ball].reverse(),
      paddleSpeeds: [...paddleSpeeds].reverse(),
      paddleCenters: [...paddleCenters].reverse(),
    });
    expect(shuffled).toEqual(ordered);
  });

  it("never emits a non-finite confidence or moment when a ball sample carries NaN confidence", () => {
    const { sequence, window } = generateSwingSequence();
    const ball: BallObservation[] = Array.from({ length: 14 }, (_, index) => {
      const t = window.peakMs - 180 + index * 30;
      const before = t <= window.peakMs;
      return {
        frameIndex: index,
        timestampMs: t,
        x: before
          ? 0.9 - ((t - (window.peakMs - 180)) / 180) * 0.3
          : 0.6 + ((t - window.peakMs) / 180) * 0.3,
        y: before
          ? 0.4 + ((t - (window.peakMs - 180)) / 180) * 0.15
          : 0.55 - ((t - window.peakMs) / 180) * 0.2,
        confidence: index === 6 ? Number.NaN : 0.8,
      };
    });
    const estimate = estimateContact({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
      ballObservations: ball,
    });
    if (estimate.status === "estimated") {
      expect(Number.isFinite(estimate.confidence)).toBe(true);
      expect(Number.isFinite(estimate.estimatedContactMs)).toBe(true);
      expect(estimate.confidence).toBeLessThanOrEqual(1);
      expect(estimate.confidence).toBeGreaterThanOrEqual(0);
    }
  });

  it("clamps ball confidence above 1 rather than amplifying evidence", () => {
    const { sequence, window } = generateSwingSequence();
    const make = (confidence: number): BallObservation[] =>
      Array.from({ length: 14 }, (_, index) => {
        const t = window.peakMs - 180 + index * 30;
        const before = t <= window.peakMs;
        return {
          frameIndex: index,
          timestampMs: t,
          x: before
            ? 0.9 - ((t - (window.peakMs - 180)) / 180) * 0.3
            : 0.6 + ((t - window.peakMs) / 180) * 0.3,
          y: before
            ? 0.4 + ((t - (window.peakMs - 180)) / 180) * 0.15
            : 0.55 - ((t - window.peakMs) / 180) * 0.2,
          confidence,
        };
      });
    const args = {
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
    };
    const unit = estimateContact({ ...args, ballObservations: make(1) });
    const over = estimateContact({ ...args, ballObservations: make(5) });
    expect(over).toEqual(unit);
  });
});

describe("audit: evaluateCaptureQuality — order independence and boundaries", () => {
  it("reports the same verdict for a dropout capture whether frames arrive sorted or reversed", () => {
    const { sequence } = generateSwingSequence();
    // Carve a ~1 s hole in the middle (a real tracking dropout).
    const holeStart = sequence.frames[40]!.timestampMs;
    const frames = sequence.frames.filter(
      (frame) => frame.timestampMs < holeStart || frame.timestampMs >= holeStart + 1000,
    );
    const sorted = evaluateCaptureQuality({ ...sequence, frames });
    expect(sorted.analyzable).toBe(false);
    expect(sorted.reasons).toContain("tracking_dropout_gap");

    const reversed = evaluateCaptureQuality({ ...sequence, frames: [...frames].reverse() });
    expect(reversed.analyzable).toBe(sorted.analyzable);
    expect(reversed.reasons).toEqual(sorted.reasons);
    expect(reversed.stats.durationMs).toBe(sorted.stats.durationMs);
    expect(reversed.stats.effectiveFps).toBe(sorted.stats.effectiveFps);
  });

  it("exactly 24 frames is enough; 23 is too few (inclusive floor)", () => {
    const { sequence } = generateSwingSequence();
    const at24 = evaluateCaptureQuality({ ...sequence, frames: sequence.frames.slice(0, 24) });
    expect(at24.reasons).not.toContain("too_few_pose_frames");
    const at23 = evaluateCaptureQuality({ ...sequence, frames: sequence.frames.slice(0, 23) });
    expect(at23.reasons).toContain("too_few_pose_frames");
  });

  it("a gap of exactly 700ms is not a dropout; 701ms is", () => {
    const { sequence } = generateSwingSequence();
    const cut = (gapMs: number) => {
      const anchor = sequence.frames[40]!.timestampMs;
      const kept = sequence.frames.filter(
        (frame) => frame.timestampMs <= anchor || frame.timestampMs >= anchor + gapMs,
      );
      // Force the first kept frame after the hole to sit exactly gapMs later.
      const afterIndex = kept.findIndex((frame) => frame.timestampMs > anchor);
      const shift = kept[afterIndex]!.timestampMs - (anchor + gapMs);
      return kept.map((frame, index) =>
        index >= afterIndex ? { ...frame, timestampMs: frame.timestampMs - shift } : frame,
      );
    };
    const exact = evaluateCaptureQuality({ ...sequence, frames: cut(700) });
    expect(exact.stats.largestGapMs).toBe(700);
    expect(exact.reasons).not.toContain("tracking_dropout_gap");
    const over = evaluateCaptureQuality({ ...sequence, frames: cut(701) });
    expect(over.stats.largestGapMs).toBe(701);
    expect(over.reasons).toContain("tracking_dropout_gap");
  });
});
