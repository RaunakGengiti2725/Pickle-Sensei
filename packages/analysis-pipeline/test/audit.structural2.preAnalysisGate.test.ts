import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import { evaluateFrameAnalyzability, type FrameStats } from "@pickle/vision-geometry";
import { preAnalysisGate } from "../src/index.js";

/**
 * STRUCTURAL AUDIT #2 (pass 1) — preAnalysisGate multi-reason reproducers.
 * Failing test = finding; passing test = verified invariant.
 */

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

describe("AUDIT preAnalysisGate — multi-reason kind/code coherence", () => {
  it("G2-A: frame failure + no person ⇒ kind corrupted_media, code from the most-upstream (frame) reason, message lists every reason", () => {
    const frame = evaluateFrameAnalyzability(
      frameStats({ interFrameDiffs: Array.from({ length: 89 }, () => 0.01) }),
    );
    expect(frame.analyzable).toBe(false);
    const { sequence } = generateSwingSequence();
    const result = preAnalysisGate({
      frame,
      pose: { ...sequence, frames: [] },
      poseQuality: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("corrupted_media");
    expect(result.failure.code).toBe(`capture.not_analyzable.${frame.reasons[0]!}`);
    expect(result.failure.message).toContain("no_person_found");
    for (const reason of frame.reasons) expect(result.failure.message).toContain(reason);
  });

  it("G2-B: pose-only failures ⇒ low_confidence; the decision payload keeps every reason (verified invariant)", () => {
    const { sequence } = generateSwingSequence();
    const result = preAnalysisGate({
      frame: evaluateFrameAnalyzability(frameStats()),
      pose: { ...sequence, frames: [] },
      poseQuality: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("capture.not_analyzable.no_person_found");
    expect(result.failure.cause).toMatchObject({
      analyzable: false,
      reasons: ["no_person_found"],
    });
  });
});
