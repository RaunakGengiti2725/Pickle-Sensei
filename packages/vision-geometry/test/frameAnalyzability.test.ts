import { describe, expect, it } from "vitest";
import {
  evaluateFrameAnalyzability,
  FRAME_ANALYZABILITY_VERSION,
  FRAME_THRESHOLDS,
  type FrameStats,
} from "../src/frameAnalyzability.js";

/**
 * Decode-integrity half of the frame gate, driven by synthetic FrameStats so
 * the branch logic is pinned independently of any ffmpeg build. The
 * ffmpeg-backed counterpart (real truncated Matroska fixtures) lives in
 * swing-lab's frameStats.test.ts.
 */

/** A textured, moving, unlettered clip: every non-decode signal passes. */
function movingStats(frameCount: number, overrides: Partial<FrameStats> = {}): FrameStats {
  return {
    frameCount,
    durationMs: 3000,
    width: 64,
    height: 36,
    interFrameDiffs: Array.from({ length: Math.max(0, frameCount - 1) }, (_, i) => 4 + (i % 5)),
    spatialLumaStd: Array.from({ length: frameCount }, () => 40),
    letterboxRowFraction: 0,
    borderRing: { temporalStd: 12, meanLuma: 110 },
    bottomFrozenComponents: [],
    source: { width: 320, height: 240 },
    ...overrides,
  };
}

describe("frame analyzability: decoded-frame deficit is a count check, not an error-log check", () => {
  const declared = 90;

  it("rejects a clip that decoded 51 of 90 declared frames with zero decoder errors", () => {
    const report = evaluateFrameAnalyzability(
      movingStats(51, { decode: { errorCount: 0, expectedFrameCount: declared } }),
    );
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("decoded_frame_deficit");
    expect(report.reasons).not.toContain("undecodable_media");
  });

  it("rejects a clip that decoded 35 of 90 declared frames with zero decoder errors", () => {
    const report = evaluateFrameAnalyzability(
      movingStats(35, { decode: { errorCount: 0, expectedFrameCount: declared } }),
    );
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("decoded_frame_deficit");
  });

  it("still rejects the deficit when the demuxer did log errors", () => {
    const report = evaluateFrameAnalyzability(
      movingStats(51, { decode: { errorCount: 3, expectedFrameCount: declared } }),
    );
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toEqual(["decoded_frame_deficit"]);
  });

  it("keeps an intact clip (all declared frames decoded, no errors) analyzable", () => {
    const report = evaluateFrameAnalyzability(
      movingStats(declared, { decode: { errorCount: 0, expectedFrameCount: declared } }),
    );
    expect(report.analyzable).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it("tolerates the off-by-one/two frame counts real containers report", () => {
    // Every committed clip measured 2026-09-04 decoded >= 99.2% of its declared
    // frames (e.g. 132/133, 1798/1799); the deficit threshold must not touch them.
    for (const [decoded, expected] of [
      [132, 133],
      [1798, 1799],
      [5899, 5901],
    ] as const) {
      const report = evaluateFrameAnalyzability(
        movingStats(decoded, { decode: { errorCount: 0, expectedFrameCount: expected } }),
      );
      expect(report.reasons, `${decoded}/${expected}`).not.toContain("decoded_frame_deficit");
    }
  });

  it("fires exactly at the declared minDecodedFrameFraction boundary", () => {
    const minimum = Math.ceil(FRAME_THRESHOLDS.minDecodedFrameFraction * declared);
    const atFloor = evaluateFrameAnalyzability(
      movingStats(minimum, { decode: { errorCount: 0, expectedFrameCount: declared } }),
    );
    expect(atFloor.reasons).not.toContain("decoded_frame_deficit");
    const belowFloor = evaluateFrameAnalyzability(
      movingStats(minimum - 1, { decode: { errorCount: 0, expectedFrameCount: declared } }),
    );
    expect(belowFloor.reasons).toContain("decoded_frame_deficit");
  });

  it("keeps undecodable_media for a zero-frame decode with errors, without a deficit reason", () => {
    const report = evaluateFrameAnalyzability(
      movingStats(0, { decode: { errorCount: 1, expectedFrameCount: null } }),
    );
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("undecodable_media");
    expect(report.reasons).toContain("single_frame_clip");
    expect(report.reasons).not.toContain("decoded_frame_deficit");
  });

  it("fails closed when nothing decoded but the container declared frames and no error was logged", () => {
    const report = evaluateFrameAnalyzability(
      movingStats(0, { decode: { errorCount: 0, expectedFrameCount: declared } }),
    );
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("decoded_frame_deficit");
    expect(report.reasons).not.toContain("undecodable_media");
  });

  it("does not claim a deficit when the container declares no frame count", () => {
    const report = evaluateFrameAnalyzability(
      movingStats(20, { decode: { errorCount: 0, expectedFrameCount: null } }),
    );
    expect(report.analyzable).toBe(true);
  });

  it("reports decode integrity as not evaluated when no decode stats were measured", () => {
    const report = evaluateFrameAnalyzability(movingStats(20));
    expect(report.analyzable).toBe(true);
    expect(report.notEvaluated).toContain("decode_integrity");
  });

  it("carries a version bump for the deficit-rule change", () => {
    expect(FRAME_ANALYZABILITY_VERSION).toBe("frame-analyzability-4");
  });
});
