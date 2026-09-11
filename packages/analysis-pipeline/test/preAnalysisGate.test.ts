import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  evaluateCaptureQuality,
  evaluateFrameAnalyzability,
  type FrameStats,
} from "@pickle/vision-geometry";
import {
  ADVISORY_GATE_REASONS,
  BLOCKING_GATE_REASONS,
  captureQualityLimitingFactors,
  evaluatePreAnalysisGate,
  preAnalysisGate,
} from "../src/index.js";

function frameStats(overrides: Partial<FrameStats> = {}): FrameStats {
  return {
    frameCount: 90,
    durationMs: 3000,
    width: 64,
    height: 36,
    interFrameDiffs: Array.from({ length: 89 }, () => 8),
    spatialLumaStd: Array.from({ length: 90 }, () => 40),
    letterboxRowFraction: 0,
    ...overrides,
  };
}

describe("preAnalysisGate", () => {
  it("passes a moving, textured clip with a plausible person", () => {
    const { sequence } = generateSwingSequence();
    const decision = evaluatePreAnalysisGate({
      frame: evaluateFrameAnalyzability(frameStats()),
      pose: sequence,
      poseQuality: evaluateCaptureQuality(sequence),
    });
    expect(decision.analyzable).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it("abstains typed corrupted_media on a still-image clip", () => {
    const frame = evaluateFrameAnalyzability(
      frameStats({ interFrameDiffs: Array.from({ length: 89 }, () => 0.01) }),
    );
    const result = preAnalysisGate({ frame, pose: null, poseQuality: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("corrupted_media");
    expect(result.failure.code).toBe("capture.not_analyzable.still_image_video");
  });

  it("abstains low_confidence when no person was found", () => {
    const { sequence } = generateSwingSequence();
    const empty = { ...sequence, frames: [] };
    const result = preAnalysisGate({
      frame: evaluateFrameAnalyzability(frameStats()),
      pose: empty,
      poseQuality: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("capture.not_analyzable.no_person_found");
  });

  it("lets a person at implausible scale through as a DISCLOSED degraded read (advisory, not blocking)", () => {
    // pre-analysis-gate-3 (2026-09-10): a small/close player is degraded but
    // measurable. The reason is recorded, travels with the analysis as a
    // capture_quality limiting factor and caps its presentation; it no longer
    // withholds the read.
    const { sequence } = generateSwingSequence();
    const shrunk = {
      ...sequence,
      frames: sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) => ({
          ...mark,
          x: mark.x * 0.02,
          y: mark.y * 0.02,
        })),
      })),
    };
    const input = {
      frame: evaluateFrameAnalyzability(frameStats()),
      pose: shrunk,
      poseQuality: evaluateCaptureQuality(shrunk),
    };
    const decision = evaluatePreAnalysisGate(input);
    expect(decision.analyzable).toBe(false);
    expect(decision.blocking).toBe(false);
    expect(decision.reasons).toContain("person_implausible_scale");
    expect(decision.advisories).toEqual(decision.reasons);
    expect(captureQualityLimitingFactors(decision)).toContain(
      "capture_quality:person_implausible_scale",
    );
    const result = preAnalysisGate(input);
    expect(result.ok).toBe(true);
  });

  it("classifies every measured reason as blocking or advisory, never neither", () => {
    for (const reason of [
      "no_person_found",
      "torso_not_measured",
      "too_few_pose_frames",
      "insufficient_fps",
    ]) {
      expect(BLOCKING_GATE_REASONS.has(reason), reason).toBe(true);
      expect(ADVISORY_GATE_REASONS.has(reason), reason).toBe(false);
    }
    for (const reason of [
      "body_not_fully_visible",
      "person_implausible_scale",
      "tracking_dropout_gap",
      "stroke_window_tracking_gap",
      "low_pose_confidence",
    ]) {
      expect(ADVISORY_GATE_REASONS.has(reason), reason).toBe(true);
      expect(BLOCKING_GATE_REASONS.has(reason), reason).toBe(false);
    }
  });

  it("blocks when a blocking reason accompanies advisory ones, naming the blocking reason", () => {
    const { sequence } = generateSwingSequence();
    // Torso hidden on every frame: nothing body-relative can be measured.
    const torsoless = {
      ...sequence,
      frames: sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.filter(
          (mark) => !mark.name.endsWith("shoulder") && !mark.name.endsWith("hip"),
        ),
      })),
    };
    const result = preAnalysisGate({
      frame: null,
      pose: torsoless,
      poseQuality: evaluateCaptureQuality(torsoless),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("capture.not_analyzable.torso_not_measured");
    const decision = result.failure.cause as { blocking: boolean; advisories: string[] };
    expect(decision.blocking).toBe(true);
    expect(decision.advisories).toContain("body_not_fully_visible");
  });

  it("reports unmeasured signals as notEvaluated, never as passes of the opposite", () => {
    const decision = evaluatePreAnalysisGate({ frame: null, pose: null, poseQuality: null });
    expect(decision.analyzable).toBe(true);
    expect(decision.notEvaluated).toEqual(
      expect.arrayContaining(["frame_statistics", "pose_presence", "pose_capture_quality"]),
    );
  });
});
