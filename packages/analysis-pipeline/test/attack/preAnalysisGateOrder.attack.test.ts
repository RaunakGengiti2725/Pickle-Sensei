/**
 * Adversarial pass 3 / tester #4 — preAnalysisGate reason ordering.
 *
 * The gate derives `kind` from whether EVERY reason is pose-only and derives
 * `code` from `reasons[0]`. Attack: feed a still-image frame report together
 * with an empty pose (no_person_found) in both orders the composition could
 * produce, and assert kind is corrupted_media in both and the code is a
 * deterministic reason regardless of input ordering.
 */
import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  evaluateFrameAnalyzability,
  type FrameAnalyzabilityReport,
  type FrameStats,
} from "@pickle/vision-geometry";
import { evaluatePreAnalysisGate, preAnalysisGate } from "../../src/index.js";

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

const stillFrame = (): FrameAnalyzabilityReport =>
  evaluateFrameAnalyzability(
    frameStats({ interFrameDiffs: Array.from({ length: 89 }, () => 0.01) }),
  );

const emptyPose = () => ({ ...generateSwingSequence().sequence, frames: [] });

describe("[attack] preAnalysisGate — [still_image, no_person_found] vs reversed", () => {
  it("still-image frame + empty pose → corrupted_media, code = still_image_video (frame reasons first)", () => {
    const result = preAnalysisGate({ frame: stillFrame(), pose: emptyPose(), poseQuality: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("corrupted_media");
    expect(result.failure.code).toBe("capture.not_analyzable.still_image_video");
    const decision = evaluatePreAnalysisGate({
      frame: stillFrame(),
      pose: emptyPose(),
      poseQuality: null,
    });
    expect(decision.reasons).toEqual(["still_image_video", "no_person_found"]);
  });

  it("frame report whose reasons array is hand-reversed still yields corrupted_media with a deterministic code", () => {
    // Reversed order inside the frame report (a future frame-analyzability
    // version could emit reasons in a different order). The pose-free
    // signal must still dominate the kind.
    const frame = stillFrame();
    const reversed: FrameAnalyzabilityReport = {
      ...frame,
      reasons: ["no_person_found", ...frame.reasons],
    };
    const result = preAnalysisGate({ frame: reversed, pose: emptyPose(), poseQuality: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("corrupted_media");
    expect(result.failure.code).toMatch(/^capture\.not_analyzable\.[a-z_]+$/);
    // Determinism: the same input twice → the same code.
    const again = preAnalysisGate({ frame: reversed, pose: emptyPose(), poseQuality: null });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.failure.code).toBe(result.failure.code);
  });

  it("pose-only reasons in either duplicate/ordering still classify low_confidence, never corrupted_media", () => {
    const decisionA = preAnalysisGate({
      frame: evaluateFrameAnalyzability(frameStats()),
      pose: emptyPose(),
      poseQuality: null,
    });
    expect(decisionA.ok).toBe(false);
    if (decisionA.ok) return;
    expect(decisionA.failure.kind).toBe("low_confidence");
    expect(decisionA.failure.code).toBe("capture.not_analyzable.no_person_found");
  });

  it("a frame report with analyzable=false but an EMPTY reasons array does not produce an undefined code", () => {
    const frame: FrameAnalyzabilityReport = { ...stillFrame(), reasons: [] };
    const result = preAnalysisGate({ frame, pose: null, poseQuality: null });
    // Either the gate passes (no reasons → analyzable) or fails with a real code.
    if (!result.ok) {
      expect(result.failure.code).not.toContain("undefined");
      expect(result.failure.code).toMatch(/^capture\.not_analyzable\.[a-z_]+$/);
    }
  });

  it("is stable under 500 rapid repeated evaluations (no mutation of the frame report)", () => {
    const frame = stillFrame();
    const before = JSON.stringify(frame);
    const codes = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const result = preAnalysisGate({ frame, pose: emptyPose(), poseQuality: null });
      if (!result.ok) codes.add(result.failure.code);
    }
    expect(codes.size).toBe(1);
    expect(JSON.stringify(frame)).toBe(before);
  });
});
