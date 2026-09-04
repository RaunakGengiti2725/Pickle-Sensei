import { describe, expect, it } from "vitest";
import {
  evaluateFrameAnalyzability,
  FRAME_ANALYZABILITY_REASONS,
  FRAME_THRESHOLDS,
  type FrameStats,
} from "../src/index.js";

/**
 * Structural audit (pass 1) — frameAnalyzability has no in-package unit test.
 * Pins the documented inclusive/exclusive edges of FRAME_THRESHOLDS and the
 * behaviour on non-finite / negative container metadata.
 */

function clean(overrides: Partial<FrameStats> = {}): FrameStats {
  const frameCount = 60;
  return {
    frameCount,
    durationMs: 2000,
    width: 320,
    height: 180,
    interFrameDiffs: Array.from({ length: frameCount - 1 }, () => 3.5),
    spatialLumaStd: Array.from({ length: frameCount }, () => 40),
    letterboxRowFraction: 0.05,
    borderRing: { temporalStd: 12, meanLuma: 110 },
    bottomFrozenComponents: [],
    source: { width: 1920, height: 1080 },
    decode: { errorCount: 0, expectedFrameCount: frameCount },
    ...overrides,
  };
}

describe("audit: evaluateFrameAnalyzability — control and closed reason set", () => {
  it("clean synthetic stats are analyzable with nothing unevaluated that was supplied", () => {
    const report = evaluateFrameAnalyzability(clean());
    expect(report.analyzable).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(report.notEvaluated).not.toContain("static_border_frame");
    expect(report.notEvaluated).not.toContain("static_overlay_suspected");
    expect(report.notEvaluated).not.toContain("source_aspect_ratio");
    expect(report.notEvaluated).not.toContain("decode_integrity");
  });

  it("every emitted reason is in the published closed set", () => {
    const worst = evaluateFrameAnalyzability({
      frameCount: 1,
      durationMs: 100,
      width: 320,
      height: 180,
      interFrameDiffs: [],
      spatialLumaStd: [0],
      letterboxRowFraction: 1,
      borderRing: { temporalStd: 0, meanLuma: 0 },
      bottomFrozenComponents: [{ size: 100, lumaStd: 50 }],
      source: { width: 10000, height: 10 },
      decode: { errorCount: 5, expectedFrameCount: 100 },
    });
    expect(worst.analyzable).toBe(false);
    for (const reason of worst.reasons) {
      expect(FRAME_ANALYZABILITY_REASONS).toContain(reason);
    }
  });
});

describe("audit: evaluateFrameAnalyzability — threshold edges", () => {
  it("exactly minFrames frames is not a single-frame clip; one fewer is", () => {
    const at = evaluateFrameAnalyzability(
      clean({
        frameCount: FRAME_THRESHOLDS.minFrames,
        interFrameDiffs: [3.5],
        spatialLumaStd: [40, 40],
        decode: { errorCount: 0, expectedFrameCount: FRAME_THRESHOLDS.minFrames },
      }),
    );
    expect(at.reasons).not.toContain("single_frame_clip");
    const below = evaluateFrameAnalyzability(
      clean({
        frameCount: FRAME_THRESHOLDS.minFrames - 1,
        interFrameDiffs: [],
        spatialLumaStd: [40],
        decode: { errorCount: 0, expectedFrameCount: 1 },
      }),
    );
    expect(below.reasons).toContain("single_frame_clip");
  });

  it("exactly minDurationMs is accepted; 1ms less is too short; 0 means unreported", () => {
    expect(
      evaluateFrameAnalyzability(clean({ durationMs: FRAME_THRESHOLDS.minDurationMs })).reasons,
    ).not.toContain("duration_too_short");
    expect(
      evaluateFrameAnalyzability(clean({ durationMs: FRAME_THRESHOLDS.minDurationMs - 1 })).reasons,
    ).toContain("duration_too_short");
    expect(evaluateFrameAnalyzability(clean({ durationMs: 0 })).reasons).not.toContain(
      "duration_too_short",
    );
  });

  it("exactly maxDurationMs is accepted; 1ms more is implausibly long", () => {
    expect(
      evaluateFrameAnalyzability(clean({ durationMs: FRAME_THRESHOLDS.maxDurationMs })).reasons,
    ).not.toContain("duration_implausibly_long");
    expect(
      evaluateFrameAnalyzability(clean({ durationMs: FRAME_THRESHOLDS.maxDurationMs + 1 })).reasons,
    ).toContain("duration_implausibly_long");
  });

  it("frozen-pair diff exactly at frozenPairMaxDiff counts as frozen; fraction exactly 0.5 is a still image", () => {
    const n = 60;
    const half = Array.from({ length: n - 1 }, (_, i) =>
      i < Math.ceil((n - 1) / 2) ? FRAME_THRESHOLDS.frozenPairMaxDiff : 3.5,
    );
    const frozenFraction =
      half.filter((d) => d <= FRAME_THRESHOLDS.frozenPairMaxDiff).length / half.length;
    expect(frozenFraction).toBeGreaterThanOrEqual(FRAME_THRESHOLDS.stillImageMinFrozenFraction);
    expect(evaluateFrameAnalyzability(clean({ interFrameDiffs: half })).reasons).toContain(
      "still_image_video",
    );

    const under = Array.from({ length: n - 1 }, (_, i) =>
      i < Math.floor((n - 1) / 2) - 1 ? FRAME_THRESHOLDS.frozenPairMaxDiff : 3.5,
    );
    expect(evaluateFrameAnalyzability(clean({ interFrameDiffs: under })).reasons).not.toContain(
      "still_image_video",
    );

    const justAbove = Array.from(
      { length: n - 1 },
      () => FRAME_THRESHOLDS.frozenPairMaxDiff + 1e-9,
    );
    expect(evaluateFrameAnalyzability(clean({ interFrameDiffs: justAbove })).reasons).not.toContain(
      "still_image_video",
    );
  });

  it("median spatial std exactly solidColorMaxStd is solid color; just above is not", () => {
    expect(
      evaluateFrameAnalyzability(
        clean({
          spatialLumaStd: Array.from({ length: 60 }, () => FRAME_THRESHOLDS.solidColorMaxStd),
        }),
      ).reasons,
    ).toContain("solid_color_frames");
    expect(
      evaluateFrameAnalyzability(
        clean({
          spatialLumaStd: Array.from(
            { length: 60 },
            () => FRAME_THRESHOLDS.solidColorMaxStd + 1e-9,
          ),
        }),
      ).reasons,
    ).not.toContain("solid_color_frames");
  });

  it("letterbox fraction exactly letterboxMaxFraction is dominant", () => {
    expect(
      evaluateFrameAnalyzability(
        clean({ letterboxRowFraction: FRAME_THRESHOLDS.letterboxMaxFraction }),
      ).reasons,
    ).toContain("letterbox_dominant");
    expect(
      evaluateFrameAnalyzability(
        clean({ letterboxRowFraction: FRAME_THRESHOLDS.letterboxMaxFraction - 1e-9 }),
      ).reasons,
    ).not.toContain("letterbox_dominant");
  });

  it("aspect exactly maxAspectRatio (and its inverse) is accepted; beyond is implausible", () => {
    const r = FRAME_THRESHOLDS.maxAspectRatio;
    expect(
      evaluateFrameAnalyzability(clean({ source: { width: r * 100, height: 100 } })).reasons,
    ).not.toContain("implausible_aspect_ratio");
    expect(
      evaluateFrameAnalyzability(clean({ source: { width: 100, height: r * 100 } })).reasons,
    ).not.toContain("implausible_aspect_ratio");
    expect(
      evaluateFrameAnalyzability(clean({ source: { width: r * 100 + 1, height: 100 } })).reasons,
    ).toContain("implausible_aspect_ratio");
    expect(
      evaluateFrameAnalyzability(clean({ source: { width: 100, height: r * 100 + 1 } })).reasons,
    ).toContain("implausible_aspect_ratio");
  });

  it("decoded fraction exactly minDecodedFrameFraction with errors is accepted; below is a deficit", () => {
    const expected = 100;
    const atFraction = FRAME_THRESHOLDS.minDecodedFrameFraction * expected;
    const mk = (frameCount: number) =>
      clean({
        frameCount,
        interFrameDiffs: Array.from({ length: frameCount - 1 }, () => 3.5),
        spatialLumaStd: Array.from({ length: frameCount }, () => 40),
        decode: { errorCount: 1, expectedFrameCount: expected },
      });
    expect(evaluateFrameAnalyzability(mk(atFraction)).reasons).not.toContain(
      "decoded_frame_deficit",
    );
    expect(evaluateFrameAnalyzability(mk(atFraction - 1)).reasons).toContain(
      "decoded_frame_deficit",
    );
    expect(evaluateFrameAnalyzability(mk(atFraction - 1)).reasons).not.toContain(
      "undecodable_media",
    );
    expect(
      evaluateFrameAnalyzability(
        clean({
          frameCount: 0,
          interFrameDiffs: [],
          spatialLumaStd: [],
          decode: { errorCount: 1, expectedFrameCount: expected },
        }),
      ).reasons,
    ).toContain("undecodable_media");
  });

  it("overlay component at exactly the size and contrast floors is suspected; still-image suppresses it", () => {
    const at = clean({
      bottomFrozenComponents: [
        {
          size: FRAME_THRESHOLDS.overlayMinComponentSize,
          lumaStd: FRAME_THRESHOLDS.overlayMinComponentLumaStd,
        },
      ],
    });
    expect(evaluateFrameAnalyzability(at).reasons).toContain("static_overlay_suspected");
    const under = clean({
      bottomFrozenComponents: [
        {
          size: FRAME_THRESHOLDS.overlayMinComponentSize - 1,
          lumaStd: FRAME_THRESHOLDS.overlayMinComponentLumaStd,
        },
        {
          size: FRAME_THRESHOLDS.overlayMinComponentSize,
          lumaStd: FRAME_THRESHOLDS.overlayMinComponentLumaStd - 1,
        },
      ],
    });
    expect(evaluateFrameAnalyzability(under).reasons).not.toContain("static_overlay_suspected");
    const still = evaluateFrameAnalyzability({
      ...at,
      interFrameDiffs: Array.from({ length: 59 }, () => 0),
    });
    expect(still.reasons).toContain("still_image_video");
    expect(still.reasons).not.toContain("static_overlay_suspected");
  });
});

describe("audit: evaluateFrameAnalyzability — non-finite and negative container metadata", () => {
  it("a negative container duration is not silently accepted as a plausible single-stroke clip", () => {
    const report = evaluateFrameAnalyzability(clean({ durationMs: -2000 }));
    expect(report.analyzable, JSON.stringify(report.reasons)).toBe(false);
  });

  it("NaN duration / frameCount / letterbox fraction never yields analyzable=true", () => {
    for (const stats of [
      clean({ durationMs: Number.NaN }),
      clean({ frameCount: Number.NaN }),
      clean({ letterboxRowFraction: Number.NaN }),
    ]) {
      const report = evaluateFrameAnalyzability(stats);
      expect(report.analyzable, JSON.stringify(stats.durationMs) + "/" + stats.frameCount).toBe(
        false,
      );
    }
  });

  it("all-NaN inter-frame diffs (undecodable luma) are not treated as a moving scene", () => {
    const report = evaluateFrameAnalyzability(
      clean({ interFrameDiffs: Array.from({ length: 59 }, () => Number.NaN) }),
    );
    expect(report.analyzable).toBe(false);
  });
});
