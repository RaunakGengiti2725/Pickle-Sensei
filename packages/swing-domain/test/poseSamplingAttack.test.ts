import { describe, expect, it } from "vitest";
import { frameGrid, sampleGapAt } from "../src/index.js";

/**
 * Adversarial pins for the frame-grid sampling helpers introduced by the
 * XCF-08/09/10 fix (471c05b7). Every stream below has ZERO dropped frames
 * around the reference — a gap detector must not report a gap.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uniformTimestamps(count: number, intervalMs: number, startMs = 0): number[] {
  return Array.from({ length: count }, (_, index) => startMs + index * intervalMs);
}

/** Per-frame uniform jitter of ±amplitude, kept strictly monotone. */
function jitter(timestamps: readonly number[], seed: number, amplitudeMs: number): number[] {
  const rng = mulberry32(seed);
  const out: number[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const raw = (timestamps[index] ?? 0) + (rng() * 2 - 1) * amplitudeMs;
    const previous = out[index - 1];
    out.push(previous !== undefined && raw <= previous ? previous + 1e-3 : raw);
  }
  return out;
}

describe("sampleGapAt — streams with no dropped frames must never read as sparse", () => {
  it("frame rate halving mid-clip (60 → 30 fps): a reference inside the uniformly 30 fps half is bracketed by ADJACENT frames", () => {
    // 2 s at 60 fps, then 2 s at 30 fps — exactly what a thermally throttled
    // capture delivers. No frame around the reference was dropped: the
    // sampling density there is one frame every 33.3 ms, uniformly.
    const first = uniformTimestamps(120, 1000 / 60, 0);
    const second = uniformTimestamps(60, 1000 / 30, 2000);
    const timestamps = [...first, ...second];
    const referenceMs = 3000 + 1000 / 60; // midway between two adjacent 30 fps frames
    const gap = sampleGapAt(timestamps, referenceMs);
    expect(gap).not.toBeNull();
    // Adjacent measured frames bracket the reference → gap of one frame step.
    // Candidate reads the 60 fps half as THE grid (seed = median of the
    // smaller half of the deltas) and reports the 30 fps half as every
    // other frame missing: gapFrames 2 → strokeHeuristicLite abstains with
    // sampling.sparse_event_window on 44/45 synthetic 60 fps swings
    // (base 4d812e1a commits 43/45 of the same inputs).
    expect(gap!.gapFrames).toBeLessThanOrEqual(1.5);
  });

  it("a pure 30 fps stream and the 30 fps half of a 60→30 stream are the same local sampling: identical gap reading", () => {
    const pure = uniformTimestamps(60, 1000 / 30, 2000);
    const mixed = [...uniformTimestamps(120, 1000 / 60, 0), ...pure];
    const referenceMs = 3000 + 1000 / 60;
    const pureGap = sampleGapAt(pure, referenceMs);
    const mixedGap = sampleGapAt(mixed, referenceMs);
    expect(pureGap).not.toBeNull();
    expect(mixedGap).not.toBeNull();
    expect(mixedGap!.gapFrames).toBe(pureGap!.gapFrames);
  });

  it("uniform 30 fps stream with ±0.3-frame monotone timestamp jitter (no frame dropped) never reads a gap > 1.5 frames at any reference", () => {
    // frameGrid's contract: "per-delta jitter below half an interval leaves
    // the step counts unchanged". Independent PER-FRAME jitter of ±0.3
    // frame makes a per-delta error of up to 0.6 frame, so some deltas
    // round to 2 steps and a fully sampled stream grows phantom gaps.
    const interval = 1000 / 30;
    const clean = uniformTimestamps(90, interval);
    const violations: Array<{ seed: number; referenceMs: number; gapFrames: number }> = [];
    for (let seed = 1; seed <= 50; seed += 1) {
      const jittered = jitter(clean, seed, 0.3 * interval);
      const grid = frameGrid(jittered);
      expect(grid).not.toBeNull();
      // No frame was dropped: consecutive steps must all be exactly one.
      for (let index = 1; index < grid!.steps.length; index += 1) {
        const step = (grid!.steps[index] ?? 0) - (grid!.steps[index - 1] ?? 0);
        if (step !== 1) {
          violations.push({ seed, referenceMs: jittered[index] ?? 0, gapFrames: step });
        }
      }
      for (let index = 5; index < 85; index += 1) {
        const referenceMs = (index + 0.5) * interval;
        const gap = sampleGapAt(jittered, referenceMs);
        if (gap !== null && gap.gapFrames > 1.5) {
          violations.push({ seed, referenceMs, gapFrames: gap.gapFrames });
        }
      }
    }
    expect(violations, JSON.stringify(violations.slice(0, 10))).toEqual([]);
  });
});
