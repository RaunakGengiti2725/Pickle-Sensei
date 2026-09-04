import { describe, expect, it } from "vitest";
import {
  evaluateFrameAnalyzability,
  FRAME_ANALYZABILITY_REASONS,
  FRAME_THRESHOLDS,
  type FrameStats,
} from "../../../src/frameAnalyzability.js";

/**
 * Adversarial pass 3 — scenario 4: evaluateFrameAnalyzability on degenerate
 * containers (single frame, zero duration, extreme aspect) plus corrupt
 * (NaN / negative) statistics.
 *
 * `it.fails` marks reproductions of findings against 4d812e1a (see the
 * FINDING comment on each); flip to `it` once production is fixed.
 */

/** A healthy 60-frame, 1 s, square, moving, well-exposed clip. */
function healthy(overrides: Partial<FrameStats> = {}): FrameStats {
  return {
    frameCount: 60,
    durationMs: 1000,
    width: 100,
    height: 100,
    interFrameDiffs: Array.from({ length: 59 }, () => 5),
    spatialLumaStd: Array.from({ length: 60 }, () => 40),
    letterboxRowFraction: 0,
    ...overrides,
  };
}

const count = (reasons: readonly string[], reason: string): number =>
  reasons.filter((entry) => entry === reason).length;

describe("evaluateFrameAnalyzability — degenerate containers (attack pass 3 / S4)", () => {
  it("HELD: healthy control clip is analyzable with no reasons", () => {
    const report = evaluateFrameAnalyzability(healthy());
    expect(report.analyzable).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it("HELD: a 1-frame clip emits single_frame_clip exactly once and is not analyzable", () => {
    const report = evaluateFrameAnalyzability(
      healthy({ frameCount: 1, durationMs: 33, interFrameDiffs: [], spatialLumaStd: [40] }),
    );
    expect(report.analyzable).toBe(false);
    expect(count(report.reasons, "single_frame_clip")).toBe(1);
    // Not double-reported through the still-image / duration branches.
    expect(report.reasons).toEqual(["single_frame_clip"]);
    for (const reason of report.reasons) expect(FRAME_ANALYZABILITY_REASONS).toContain(reason);
  });

  it("HELD: a 0-frame clip is rejected (single_frame_clip) and does not emit solid_color_frames", () => {
    const report = evaluateFrameAnalyzability(
      healthy({ frameCount: 0, durationMs: 0, interFrameDiffs: [], spatialLumaStd: [] }),
    );
    expect(report.analyzable).toBe(false);
    expect(count(report.reasons, "single_frame_clip")).toBe(1);
    expect(report.reasons).not.toContain("solid_color_frames");
  });

  it("HELD: a 20:1 and a 1:20 source aspect each emit implausible_aspect_ratio exactly once", () => {
    for (const source of [
      { width: 2000, height: 100 },
      { width: 100, height: 2000 },
    ]) {
      const report = evaluateFrameAnalyzability(healthy({ source }));
      expect(report.analyzable).toBe(false);
      expect(count(report.reasons, "implausible_aspect_ratio")).toBe(1);
      expect(report.reasons).toEqual(["implausible_aspect_ratio"]);
      expect(report.notEvaluated).not.toContain("source_aspect_ratio");
    }
  });

  it("HELD: 4:1 exactly is allowed, 4.0001:1 is rejected (boundary is strict)", () => {
    expect(
      evaluateFrameAnalyzability(healthy({ source: { width: 400, height: 100 } })).reasons,
    ).toEqual([]);
    expect(
      evaluateFrameAnalyzability(healthy({ source: { width: 40001, height: 10000 } })).reasons,
    ).toEqual(["implausible_aspect_ratio"]);
  });

  it("HELD: a 499 ms clip emits duration_too_short exactly once; 500 ms passes", () => {
    const short = evaluateFrameAnalyzability(healthy({ durationMs: 499 }));
    expect(short.analyzable).toBe(false);
    expect(short.reasons).toEqual(["duration_too_short"]);
    expect(evaluateFrameAnalyzability(healthy({ durationMs: 500 })).reasons).toEqual([]);
    expect(FRAME_THRESHOLDS.minDurationMs).toBe(500);
  });

  // FINDING (P3): frameAnalyzability.ts:150 requires `durationMs > 0` before
  // testing minDurationMs, treating 0 as "unknown" (documented at :17). A clip
  // whose container reports 0 duration therefore passes the frame gate with
  // analyzable=true and NO reason, and so does a NEGATIVE duration.
  it.fails(
    "BROKEN: a 0-duration clip must emit duration_too_short once with analyzable=false",
    () => {
      const report = evaluateFrameAnalyzability(healthy({ durationMs: 0 }));
      expect(report.analyzable).toBe(false);
      expect(count(report.reasons, "duration_too_short")).toBe(1);
    },
  );

  it("evidence: 0 and negative durations are reported analyzable with zero reasons", () => {
    for (const durationMs of [0, -1, -60000]) {
      const report = evaluateFrameAnalyzability(healthy({ durationMs }));
      expect(report.analyzable).toBe(true);
      expect(report.reasons).toEqual([]);
      expect(report.notEvaluated).not.toContain("duration");
    }
  });

  it("HELD: every emitted reason is in the closed set and appears at most once (all-bad clip)", () => {
    const report = evaluateFrameAnalyzability({
      frameCount: 60,
      durationMs: 100,
      width: 10,
      height: 10,
      interFrameDiffs: Array.from({ length: 59 }, () => 0),
      spatialLumaStd: Array.from({ length: 60 }, () => 0),
      letterboxRowFraction: 0.9,
      borderRing: { temporalStd: 0, meanLuma: 0 },
      bottomFrozenComponents: [{ size: 100, lumaStd: 50 }],
      source: { width: 5000, height: 100 },
      decode: { errorCount: 3, expectedFrameCount: 600 },
    });
    expect(report.analyzable).toBe(false);
    const seen = new Set<string>();
    for (const reason of report.reasons) {
      expect(FRAME_ANALYZABILITY_REASONS).toContain(reason);
      expect(seen.has(reason)).toBe(false);
      seen.add(reason);
    }
    // still_image_video suppresses the overlay reason by design.
    expect(report.reasons).toContain("still_image_video");
    expect(report.reasons).not.toContain("static_overlay_suspected");
  });
});

describe("evaluateFrameAnalyzability — corrupt statistics (attack pass 3 / extra)", () => {
  it("HELD: all-NaN stats with empty arrays are rejected (frozen fraction defaults to 1)", () => {
    const report = evaluateFrameAnalyzability({
      frameCount: Number.NaN,
      durationMs: Number.NaN,
      width: Number.NaN,
      height: Number.NaN,
      interFrameDiffs: [],
      spatialLumaStd: [],
      letterboxRowFraction: Number.NaN,
      source: { width: Number.NaN, height: Number.NaN },
    });
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toEqual(["still_image_video"]);
  });

  // FINDING (P3): with NaN frameCount / durationMs / letterboxRowFraction but
  // otherwise healthy per-frame arrays, every threshold comparison is false
  // (frameAnalyzability.ts:147-179) and the gate reports analyzable=true while
  // its own `stats` block carries NaN.
  it.fails("BROKEN: NaN scalar statistics must not be reported analyzable", () => {
    const report = evaluateFrameAnalyzability(
      healthy({
        frameCount: Number.NaN,
        durationMs: Number.NaN,
        letterboxRowFraction: Number.NaN,
        source: { width: Number.NaN, height: Number.NaN },
      }),
    );
    expect(report.analyzable).toBe(false);
  });

  it("evidence: NaN scalars → analyzable=true with NaN in the returned stats", () => {
    const report = evaluateFrameAnalyzability(
      healthy({ frameCount: Number.NaN, durationMs: Number.NaN, letterboxRowFraction: Number.NaN }),
    );
    expect(report.analyzable).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(Number.isNaN(report.stats.frameCount)).toBe(true);
    expect(Number.isNaN(report.stats.durationMs)).toBe(true);
  });

  it("HELD: NaN inter-frame diffs do not count as frozen and never throw", () => {
    const report = evaluateFrameAnalyzability(
      healthy({ interFrameDiffs: Array.from({ length: 59 }, () => Number.NaN) }),
    );
    expect(report.analyzable).toBe(true);
    expect(Number.isNaN(report.stats.medianInterFrameDiff)).toBe(true);
  });
});
