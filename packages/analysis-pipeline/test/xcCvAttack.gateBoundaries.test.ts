/**
 * XC-CV-1 adversarial attack — boundary and ordering variants of the changed
 * gate code (captureQuality thresholds + fps rounding tolerance,
 * preAnalysisGate reason propagation, stroke-window continuity) and the
 * library-level seam the fix left open.
 *
 * Everything here is deterministic synthetic pose data replayed through the
 * production functions. Cases marked `EXPECTED FAIL on f702f0f8` are the
 * breaks; the rest pin the boundaries the fix relies on and MUST pass.
 */
import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";
import { evaluateCaptureQuality, QUALITY_THRESHOLDS } from "@pickle/vision-geometry";
import {
  evaluatePreAnalysisGate,
  preAnalysisGate,
  strokeWindowTrackingGapMs,
  STROKE_WINDOW_TRACKING,
} from "../src/preAnalysisGate.js";
import { farCameraFixtures, controlFixtures } from "./xcCvAbstention/fixtures.js";
import { runFixture } from "./xcCvAbstention/harness.js";

const TORSO = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"] as const;

/** A tracked, full-body skeleton at `torso` image height, `frames` frames spaced `stepMs`. */
function syntheticSequence(options: {
  frames: number;
  stepMs: number;
  torso?: number;
  startMs?: number;
  confidence?: number;
  timestamps?: (index: number) => number;
}): PoseSequence {
  const { frames, stepMs, torso = 0.2, startMs = 0, confidence = 0.95 } = options;
  const names = [
    "head",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
  ];
  const hipY = 0.55;
  const shoulderY = hipY - torso;
  const y: Record<string, number> = {
    head: shoulderY - torso * 0.35,
    left_shoulder: shoulderY,
    right_shoulder: shoulderY,
    left_elbow: shoulderY + torso * 0.45,
    right_elbow: shoulderY + torso * 0.45,
    left_wrist: shoulderY + torso * 0.9,
    right_wrist: shoulderY + torso * 0.9,
    left_hip: hipY,
    right_hip: hipY,
    left_knee: hipY + torso * 0.9,
    right_knee: hipY + torso * 0.9,
    left_ankle: hipY + torso * 1.8,
    right_ankle: hipY + torso * 1.8,
  };
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "pose.apple-vision",
      runtime: "vision_framework",
      executionTarget: "on_device",
      modelVersion: "apple-vision-bodypose-1",
      artifactHash: null,
    },
    video: { width: 1080, height: 1080, fps: 1000 / stepMs },
    frames: Array.from({ length: frames }, (_, i) => ({
      frameIndex: i,
      timestampMs: options.timestamps ? options.timestamps(i) : startMs + i * stepMs,
      confidence,
      landmarks: names.map((name) => ({
        name,
        x: name.startsWith("left_") ? 0.45 : name.startsWith("right_") ? 0.55 : 0.5,
        y: y[name]!,
        visibility: 0.9,
      })),
    })),
  } as PoseSequence;
}

describe("captureQuality thresholds — exact boundaries (changed in the fix: minEffectiveFps 24→15, 1 ms rounding tolerance)", () => {
  it("minFrames: 24 frames pass, 23 frames are too_few_pose_frames", () => {
    expect(
      evaluateCaptureQuality(syntheticSequence({ frames: 24, stepMs: 33 })).reasons,
    ).not.toContain("too_few_pose_frames");
    expect(evaluateCaptureQuality(syntheticSequence({ frames: 23, stepMs: 33 })).reasons).toContain(
      "too_few_pose_frames",
    );
  });

  it("torso band: 0.08 and 0.6 are inside; just below/above are refused", () => {
    const at = (torso: number) =>
      evaluateCaptureQuality(syntheticSequence({ frames: 60, stepMs: 33, torso }));
    expect(at(QUALITY_THRESHOLDS.minTorsoLengthNorm).reasons).not.toContain(
      "player_too_small_in_frame",
    );
    expect(at(QUALITY_THRESHOLDS.minTorsoLengthNorm - 1e-4).reasons).toContain(
      "player_too_small_in_frame",
    );
    expect(at(QUALITY_THRESHOLDS.maxTorsoLengthNorm).reasons).not.toContain(
      "player_too_close_or_cropped",
    );
    expect(at(QUALITY_THRESHOLDS.maxTorsoLengthNorm + 1e-4).reasons).toContain(
      "player_too_close_or_cropped",
    );
  });

  it("dropout gap: exactly 700 ms passes, 701 ms is tracking_dropout_gap", () => {
    const withGap = (gapMs: number) =>
      syntheticSequence({
        frames: 60,
        stepMs: 33,
        timestamps: (i) => (i < 30 ? i * 33 : 29 * 33 + gapMs + (i - 30) * 33),
      });
    expect(evaluateCaptureQuality(withGap(QUALITY_THRESHOLDS.maxGapMs)).reasons).not.toContain(
      "tracking_dropout_gap",
    );
    expect(evaluateCaptureQuality(withGap(QUALITY_THRESHOLDS.maxGapMs + 1)).reasons).toContain(
      "tracking_dropout_gap",
    );
  });

  it("fps floor with the 1 ms rounding tolerance: 61 frames over 4001 ms (14.996 fps measured) pass; over 4002 ms they are insufficient_fps", () => {
    const span = (durationMs: number) =>
      syntheticSequence({
        frames: 61,
        stepMs: 66,
        timestamps: (i) => Math.round((i * durationMs) / 60),
      });
    // upper bound = 60_000 / (4001 - 1) = 15.0 → exactly at the floor: not refused.
    const tolerated = evaluateCaptureQuality(span(4001));
    expect(tolerated.stats.effectiveFps).toBeLessThan(QUALITY_THRESHOLDS.minEffectiveFps);
    expect(tolerated.reasons).not.toContain("insufficient_fps");
    // upper bound = 60_000 / 4001 < 15 → refused.
    expect(evaluateCaptureQuality(span(4002)).reasons).toContain("insufficient_fps");
  });

  it("the tolerance never exceeds 1 ms: a clip whose stamps are 2 ms too slow for the floor is refused", () => {
    // 31 frames over 2002 ms: measured 14.985 fps, upper bound 30_000/2001 = 14.99 → refused.
    const seq = syntheticSequence({
      frames: 31,
      stepMs: 66,
      timestamps: (i) => Math.round((i * 2002) / 30),
    });
    expect(evaluateCaptureQuality(seq).reasons).toContain("insufficient_fps");
  });

  it("clock skew / time base: a sidecar whose stamps start at 10^7 ms is judged by span, not by absolute time", () => {
    const shifted = syntheticSequence({ frames: 60, stepMs: 33, startMs: 10_000_000 });
    const report = evaluateCaptureQuality(shifted);
    expect(report.analyzable).toBe(true);
    expect(report.stats.effectiveFps).toBeGreaterThan(29);
  });

  it("two-frame degenerate clip: a 1 ms span is too few frames, not a division artefact", () => {
    const report = evaluateCaptureQuality(syntheticSequence({ frames: 2, stepMs: 1 }));
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("too_few_pose_frames");
    expect(Number.isFinite(report.stats.effectiveFps)).toBe(true);
  });
});

describe("preAnalysisGate — reason propagation and stroke-window continuity (changed in the fix)", () => {
  it("every library reason the report can emit surfaces as a typed abstention, mapped to low_confidence when pose-only", () => {
    const cases: Array<[PoseSequence, string]> = [
      [syntheticSequence({ frames: 10, stepMs: 33 }), "too_few_pose_frames"],
      [syntheticSequence({ frames: 40, stepMs: 100 }), "insufficient_fps"],
      [syntheticSequence({ frames: 60, stepMs: 33, torso: 0.02 }), "person_implausible_scale"],
      [syntheticSequence({ frames: 60, stepMs: 33, torso: 0.7 }), "person_implausible_scale"],
      [syntheticSequence({ frames: 60, stepMs: 33, confidence: 0.1 }), "low_pose_confidence"],
    ];
    for (const [sequence, reason] of cases) {
      const input = { frame: null, pose: sequence, poseQuality: evaluateCaptureQuality(sequence) };
      const decision = evaluatePreAnalysisGate(input);
      expect(decision.analyzable, reason).toBe(false);
      expect(decision.reasons, reason).toContain(reason);
      const typed = preAnalysisGate(input);
      expect(typed.ok, reason).toBe(false);
      if (typed.ok) continue;
      expect(typed.failure.kind, reason).toBe("low_confidence");
      expect(typed.failure.code, reason).toBe(`capture.not_analyzable.${decision.reasons[0]}`);
      expect(typed.failure.message, reason).toContain(reason);
    }
  });

  it("stroke window gap boundary: a 150 ms hole passes, 151 ms is refused; the window edges count", () => {
    const seq = syntheticSequence({ frames: 61, stepMs: 25 }); // 0..1500 ms
    const hole = (fromMs: number, toMs: number): PoseSequence => ({
      ...seq,
      frames: seq.frames.map((f) =>
        f.timestampMs > fromMs && f.timestampMs < toMs
          ? {
              ...f,
              landmarks: f.landmarks.map((m) =>
                (TORSO as readonly string[]).includes(m.name) ? { ...m, visibility: 0.1 } : m,
              ),
            }
          : f,
      ),
    });
    const window = { windowStartMs: 300, windowEndMs: 1200 };
    // frames at 500 and 650 tracked; 525..625 hidden → gap 150.
    expect(strokeWindowTrackingGapMs(hole(500, 650), window)).toBe(STROKE_WINDOW_TRACKING.maxGapMs);
    expect(
      evaluatePreAnalysisGate({
        frame: null,
        pose: hole(500, 650),
        poseQuality: evaluateCaptureQuality(seq),
        stroke: window,
      }).analyzable,
    ).toBe(true);
    // 500 and 675 tracked → gap 175 > 150.
    expect(strokeWindowTrackingGapMs(hole(500, 675), window)).toBe(175);
    expect(
      evaluatePreAnalysisGate({
        frame: null,
        pose: hole(500, 675),
        poseQuality: evaluateCaptureQuality(seq),
        stroke: window,
      }).reasons,
    ).toContain("stroke_window_tracking_gap");
    // Lead-in: first tracked frame inside the window at 475 → 175 from the window start.
    expect(strokeWindowTrackingGapMs(hole(299, 475), window)).toBe(175);
    // Tail: last tracked frame at 1025 → 175 to the window end.
    expect(strokeWindowTrackingGapMs(hole(1025, 1201), window)).toBe(175);
  });

  it("stroke window with NO tracked torso at all is refused with the whole window as the gap; inverted/empty windows are not evaluated", () => {
    const seq = syntheticSequence({ frames: 61, stepMs: 25 });
    const blind: PoseSequence = {
      ...seq,
      frames: seq.frames.map((f) => ({
        ...f,
        landmarks: f.landmarks.map((m) =>
          (TORSO as readonly string[]).includes(m.name) ? { ...m, visibility: 0.1 } : m,
        ),
      })),
    };
    expect(strokeWindowTrackingGapMs(blind, { windowStartMs: 300, windowEndMs: 900 })).toBe(600);
    expect(strokeWindowTrackingGapMs(seq, { windowStartMs: 900, windowEndMs: 300 })).toBeNull();
    expect(strokeWindowTrackingGapMs(seq, { windowStartMs: 300, windowEndMs: 300 })).toBeNull();
    const notEvaluated = evaluatePreAnalysisGate({
      frame: null,
      pose: seq,
      poseQuality: evaluateCaptureQuality(seq),
      stroke: { windowStartMs: 900, windowEndMs: 300 },
    });
    expect(notEvaluated.analyzable).toBe(true);
    expect(notEvaluated.notEvaluated).toContain("stroke_window_tracking");
  });

  it("visibility exactly at minVisibility (0.3) counts as tracked; 0.29 does not", () => {
    const seq = syntheticSequence({ frames: 61, stepMs: 25 });
    const withVis = (v: number): PoseSequence => ({
      ...seq,
      frames: seq.frames.map((f) => ({
        ...f,
        landmarks: f.landmarks.map((m) =>
          (TORSO as readonly string[]).includes(m.name) ? { ...m, visibility: v } : m,
        ),
      })),
    });
    const window = { windowStartMs: 300, windowEndMs: 900 };
    expect(strokeWindowTrackingGapMs(withVis(STROKE_WINDOW_TRACKING.minVisibility), window)).toBe(
      25,
    );
    expect(strokeWindowTrackingGapMs(withVis(0.29), window)).toBe(600);
  });

  it("frame ordering does not matter to the continuity measure only when frames are sorted — unsorted input is the parser's job, not the gate's", () => {
    const seq = syntheticSequence({ frames: 61, stepMs: 25 });
    const shuffled: PoseSequence = { ...seq, frames: [...seq.frames].reverse() };
    // Reverse order makes every consecutive difference negative; the largest
    // gap must still be the (positive) edge distance, never a negative number.
    const gap = strokeWindowTrackingGapMs(shuffled, { windowStartMs: 300, windowEndMs: 900 });
    expect(gap).not.toBeNull();
    expect(gap!).toBeGreaterThanOrEqual(0);
  });
});

describe("library-level seam the caller-side fix leaves open (original XC-CV-1 repro, reduced)", () => {
  it("control fixture still scores at normal confidence through analyzeCapture", async () => {
    const control = controlFixtures()[0]!;
    const row = await runFixture(control);
    expect(row.outcome).toBe("scored_normal");
    expect(row.libraryQuality.analyzable).toBe(true);
  });

  it("EXPECTED FAIL on f702f0f8 — analyzeCapture returns a normal-confidence numeric score for every far-camera fixture its own quality gate calls unanalyzable", async () => {
    const leaks: string[] = [];
    for (const fixture of farCameraFixtures(2)) {
      const row = await runFixture(fixture);
      if (!row.libraryQuality.analyzable && row.outcome === "scored_normal") {
        leaks.push(
          `${fixture.id}: score ${row.overallScore} @${row.analysisConfidence} [${row.libraryQuality.reasons.join(",")}]`,
        );
      }
    }
    // Observed on f702f0f8: every non-rejected far_camera row leaks (e.g.
    // far-torso-0.02: 9.7 @0.875 [player_too_small_in_frame]).
    expect(leaks).toEqual([]);
  });
});
