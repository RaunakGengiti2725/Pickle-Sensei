import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  evaluateCaptureQuality,
  evaluateFrameAnalyzability,
  type FrameStats,
} from "@pickle/vision-geometry";
import { evaluatePreAnalysisGate, preAnalysisGate } from "../src/index.js";

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

  it("abstains on a person at implausible scale", () => {
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
    const result = preAnalysisGate({
      frame: evaluateFrameAnalyzability(frameStats()),
      pose: shrunk,
      poseQuality: evaluateCaptureQuality(shrunk),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("capture.not_analyzable.person_implausible_scale");
  });

  it("reports unmeasured signals as notEvaluated, never as passes of the opposite", () => {
    const decision = evaluatePreAnalysisGate({ frame: null, pose: null, poseQuality: null });
    expect(decision.analyzable).toBe(true);
    expect(decision.notEvaluated).toEqual(
      expect.arrayContaining(["frame_statistics", "pose_presence", "pose_capture_quality"]),
    );
  });
});
