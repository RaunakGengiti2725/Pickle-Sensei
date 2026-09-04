import { describe, expect, it } from "vitest";
import {
  evaluateFrameAnalyzability,
  FRAME_ANALYZABILITY_REASONS,
  FRAME_THRESHOLDS,
  type FrameStats,
} from "../../src/frameAnalyzability.js";

/**
 * AUDIT PROBES — frameAnalyzability.ts (no in-package unit tests exist at
 * 4d812e1a). Checks the closed reason set, threshold inclusivity, and the
 * "not evaluated is not a pass" rule for degenerate optional inputs.
 */

function cleanStats(overrides: Partial<FrameStats> = {}): FrameStats {
  const n = 60;
  return {
    frameCount: n,
    durationMs: 2000,
    width: 1080,
    height: 1920,
    interFrameDiffs: Array.from({ length: n - 1 }, () => 0.08),
    spatialLumaStd: Array.from({ length: n }, () => 40),
    letterboxRowFraction: 0.05,
    ...overrides,
  };
}

describe("AUDIT evaluateFrameAnalyzability", () => {
  it("clean stats are analyzable with the optional stages reported as notEvaluated (baseline)", () => {
    const r = evaluateFrameAnalyzability(cleanStats());
    expect(r.analyzable).toBe(true);
    expect(r.notEvaluated).toEqual(
      expect.arrayContaining([
        "static_border_frame",
        "static_overlay_suspected",
        "source_aspect_ratio",
        "decode_integrity",
      ]),
    );
  });

  it("every emitted reason belongs to the closed FRAME_ANALYZABILITY_REASONS set", () => {
    const bad = evaluateFrameAnalyzability(
      cleanStats({
        frameCount: 1,
        durationMs: 100,
        interFrameDiffs: [0],
        spatialLumaStd: [0],
        letterboxRowFraction: 1,
        borderRing: { temporalStd: 0, meanLuma: 0 },
        source: { width: 10, height: 1 },
        decode: { errorCount: 3, expectedFrameCount: 100 },
        bottomFrozenComponents: [{ size: 100, lumaStd: 50 }],
      }),
    );
    for (const reason of bad.reasons) {
      expect(FRAME_ANALYZABILITY_REASONS).toContain(reason);
    }
    expect(bad.analyzable).toBe(false);
  });

  it("threshold inclusivity: frozenPairMaxDiff, solidColorMaxStd, letterboxMaxFraction, maxAspectRatio", () => {
    const frozenAt = evaluateFrameAnalyzability(
      cleanStats({
        interFrameDiffs: Array.from({ length: 59 }, () => FRAME_THRESHOLDS.frozenPairMaxDiff),
      }),
    );
    expect(frozenAt.reasons).toContain("still_image_video");
    const solidAt = evaluateFrameAnalyzability(
      cleanStats({
        spatialLumaStd: Array.from({ length: 60 }, () => FRAME_THRESHOLDS.solidColorMaxStd),
      }),
    );
    expect(solidAt.reasons).toContain("solid_color_frames");
    const letterboxAt = evaluateFrameAnalyzability(
      cleanStats({ letterboxRowFraction: FRAME_THRESHOLDS.letterboxMaxFraction }),
    );
    expect(letterboxAt.reasons).toContain("letterbox_dominant");
    const aspectAt = evaluateFrameAnalyzability(
      cleanStats({ source: { width: FRAME_THRESHOLDS.maxAspectRatio * 100, height: 100 } }),
    );
    expect(aspectAt.reasons).not.toContain("implausible_aspect_ratio");
    const aspectOver = evaluateFrameAnalyzability(
      cleanStats({ source: { width: FRAME_THRESHOLDS.maxAspectRatio * 100 + 1, height: 100 } }),
    );
    expect(aspectOver.reasons).toContain("implausible_aspect_ratio");
  });

  it("duration exactly minDurationMs is accepted; one ms less is rejected", () => {
    expect(
      evaluateFrameAnalyzability(cleanStats({ durationMs: FRAME_THRESHOLDS.minDurationMs }))
        .reasons,
    ).not.toContain("duration_too_short");
    expect(
      evaluateFrameAnalyzability(cleanStats({ durationMs: FRAME_THRESHOLDS.minDurationMs - 1 }))
        .reasons,
    ).toContain("duration_too_short");
  });

  it("a source block with non-positive dimensions must be reported as not evaluated (not silently passed)", () => {
    const r = evaluateFrameAnalyzability(cleanStats({ source: { width: 0, height: 0 } }));
    console.log(`[audit] source 0x0 → ${JSON.stringify(r)}`);
    expect(r.reasons.length > 0 || r.notEvaluated.includes("source_aspect_ratio")).toBe(true);
  });

  it("a source block with NaN dimensions must be reported as not evaluated (not silently passed)", () => {
    const r = evaluateFrameAnalyzability(
      cleanStats({ source: { width: Number.NaN, height: 1920 } }),
    );
    console.log(`[audit] source NaN → ${JSON.stringify(r)}`);
    expect(r.reasons.length > 0 || r.notEvaluated.includes("source_aspect_ratio")).toBe(true);
  });

  it("durationMs 0 (unknown) with many frames must not silently pass the duration gates", () => {
    const r = evaluateFrameAnalyzability(cleanStats({ durationMs: 0 }));
    console.log(`[audit] duration 0 → ${JSON.stringify(r)}`);
    expect(r.reasons.length > 0 || r.notEvaluated.some((entry) => /duration/.test(entry))).toBe(
      true,
    );
  });

  it("NaN inter-frame statistics must not yield an analyzable verdict", () => {
    const r = evaluateFrameAnalyzability(
      cleanStats({
        interFrameDiffs: Array.from({ length: 59 }, () => Number.NaN),
        spatialLumaStd: Array.from({ length: 60 }, () => Number.NaN),
      }),
    );
    console.log(`[audit] NaN stats → ${JSON.stringify(r)}`);
    expect(r.analyzable).toBe(false);
  });
});
