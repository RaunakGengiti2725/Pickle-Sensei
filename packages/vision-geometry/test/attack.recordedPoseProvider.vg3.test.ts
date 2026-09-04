import { describe, expect, it } from "vitest";
import type { PoseFrame } from "@pickle/shared-types";
import type { VideoClipRef } from "@pickle/vision-contracts";
import { RecordedPoseProvider, createGeometryProviderSet } from "../src/index.js";

/**
 * Adversarial probe of the VG-3 fix (RecordedPoseProvider drops non-finite
 * timestamps before sorting). Every assertion is against an explicit
 * reference model; where the input carries only finite timestamps the
 * reference IS the pre-fix implementation, so any divergence is a regression.
 */

const clip: VideoClipRef = {
  uri: "recorded://attack",
  durationMs: 1000,
  fps: 60,
  width: 100,
  height: 100,
};

function frame(timestampMs: number, tag: number): PoseFrame {
  return {
    timestampMs,
    space: "normalized-image",
    confidence: 1,
    landmarks: [{ name: "right_wrist", x: tag, y: 0.5, visibility: 0.9 }],
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pre-fix implementation (4d812e1a providers.ts:27,34-46), verbatim semantics. */
function legacyExtract(
  frames: readonly PoseFrame[],
  window: { startMs: number; endMs: number },
): PoseFrame[] {
  const sorted = [...frames].sort((a, b) => a.timestampMs - b.timestampMs);
  return sorted.filter((f) => f.timestampMs >= window.startMs && f.timestampMs <= window.endMs);
}

/** Intended post-fix semantics: finite survivors, stable ascending, inclusive window. */
function referenceExtract(
  frames: readonly PoseFrame[],
  window: { startMs: number; endMs: number },
): PoseFrame[] {
  const finite = frames.filter((f) => Number.isFinite(f.timestampMs));
  // Insertion sort: trivially stable, no reliance on the engine's sort.
  const sorted: PoseFrame[] = [];
  for (const f of finite) {
    let i = sorted.length;
    while (i > 0 && sorted[i - 1]!.timestampMs > f.timestampMs) i -= 1;
    sorted.splice(i, 0, f);
  }
  return sorted.filter((f) => f.timestampMs >= window.startMs && f.timestampMs <= window.endMs);
}

async function extract(frames: readonly PoseFrame[], window: { startMs: number; endMs: number }) {
  return new RecordedPoseProvider({ frames, poseModelVersion: "attack" }).extractPose(clip, window);
}

function expectSameFrames(actual: readonly PoseFrame[], expected: readonly PoseFrame[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    // Identity, not structural equality: catches stability violations between
    // duplicate-timestamp frames that would compare equal structurally.
    expect(actual[i]).toBe(expected[i]);
  }
}

const SPECIAL_TIMESTAMPS = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  0,
  -0,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  5e-324,
  Number.EPSILON,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  2 ** 53,
  2 ** 53 + 2,
  1e308,
  -1e308,
];

function randomTimestamp(random: () => number): number {
  const roll = random();
  if (roll < 0.15) return SPECIAL_TIMESTAMPS[Math.floor(random() * SPECIAL_TIMESTAMPS.length)]!;
  if (roll < 0.4) return Math.floor(random() * 70) * (1000 / 60); // 60 fps grid, duplicates likely
  if (roll < 0.55) return Math.floor(random() * 1200) - 100; // integers incl. negatives
  return random() * 1300 - 150;
}

function randomWindow(random: () => number): { startMs: number; endMs: number } {
  const roll = random();
  if (roll < 0.05) return { startMs: Number.NaN, endMs: 1000 };
  if (roll < 0.1) return { startMs: 0, endMs: Number.NaN };
  if (roll < 0.15) return { startMs: Number.NEGATIVE_INFINITY, endMs: Number.POSITIVE_INFINITY };
  if (roll < 0.2) return { startMs: 500, endMs: 100 }; // inverted
  const a = random() * 1300 - 150;
  const b = random() * 1300 - 150;
  return { startMs: Math.min(a, b), endMs: Math.max(a, b) };
}

describe("VG-3 attack: RecordedPoseProvider vs reference models", () => {
  it("fuzz 3000 seeds: output is exactly the stable-sorted finite survivors in the window (or too_few)", async () => {
    const random = mulberry32(0x5eed ^ 0xa77ac);
    let okCount = 0;
    let tooFew = 0;
    for (let seed = 0; seed < 3000; seed += 1) {
      const count = Math.floor(random() * 80);
      const frames: PoseFrame[] = [];
      for (let i = 0; i < count; i += 1) frames.push(frame(randomTimestamp(random), i));
      const snapshot = [...frames];
      const window = randomWindow(random);
      const expected = referenceExtract(frames, window);
      const result = await extract(frames, window);
      // Input never mutated (order or identity).
      expectSameFrames(frames, snapshot);
      if (expected.length < 6) {
        expect(result.ok, `seed ${seed}`).toBe(false);
        if (!result.ok) expect(result.failure.code).toBe("pose.too_few_recorded_frames");
        tooFew += 1;
        continue;
      }
      expect(result.ok, `seed ${seed}`).toBe(true);
      if (!result.ok) continue;
      expectSameFrames(result.value, expected);
      okCount += 1;
    }
    expect(okCount).toBeGreaterThan(200);
    expect(tooFew).toBeGreaterThan(200);
  });

  it("fuzz 3000 seeds, finite-only inputs: byte-identical to the pre-fix implementation (no regression)", async () => {
    const random = mulberry32(0xbaadf00d);
    let compared = 0;
    for (let seed = 0; seed < 3000; seed += 1) {
      const count = Math.floor(random() * 80);
      const frames: PoseFrame[] = [];
      for (let i = 0; i < count; i += 1) {
        let ts = randomTimestamp(random);
        while (!Number.isFinite(ts)) ts = randomTimestamp(random);
        frames.push(frame(ts, i));
      }
      const window = randomWindow(random);
      const legacy = legacyExtract(frames, window);
      const result = await extract(frames, window);
      if (legacy.length < 6) {
        expect(result.ok, `seed ${seed}`).toBe(false);
        continue;
      }
      expect(result.ok, `seed ${seed}`).toBe(true);
      if (!result.ok) continue;
      expectSameFrames(result.value, legacy);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(500);
  });

  it("finite extremes sort ascending: -MAX_VALUE .. MAX_VALUE with subnormals and ±0 (comparator overflow to ±Infinity is fine)", async () => {
    const values = [
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      5e-324,
      -5e-324,
      0,
      -0,
      1e308,
      -1e308,
      Number.MIN_VALUE,
      Number.MAX_SAFE_INTEGER,
    ];
    const frames = values.map((v, i) => frame(v, i));
    const result = await extract(frames, {
      startMs: Number.NEGATIVE_INFINITY,
      endMs: Number.POSITIVE_INFINITY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectSameFrames(
      result.value,
      referenceExtract(frames, { startMs: -Infinity, endMs: Infinity }),
    );
    const ts = result.value.map((f) => f.timestampMs);
    for (let i = 1; i < ts.length; i += 1) expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!);
    // -0 and 0 compare equal; input order (0 then -0) must be preserved.
    const zeros = result.value.filter((f) => f.timestampMs === 0);
    expect(zeros.map((f) => f.landmarks[0]!.x)).toEqual([4, 5]);
  });

  it("±Infinity timestamps are dropped, matching pre-fix window semantics (they never fell inside a finite window)", async () => {
    const clean = Array.from({ length: 10 }, (_, i) => frame(i * 10, i));
    const frames = [
      frame(Number.POSITIVE_INFINITY, 100),
      ...clean,
      frame(Number.NEGATIVE_INFINITY, 101),
      frame(Number.POSITIVE_INFINITY, 102),
    ];
    const window = { startMs: 0, endMs: 100 };
    const result = await extract(frames, window);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectSameFrames(result.value, clean);
    // Pre-fix would have produced the same in-window set for a finite window.
    expectSameFrames(result.value, legacyExtract(frames, window));
  });

  it("an infinite window with only ±Infinity extras still excludes them (behaviour change vs pre-fix is limited to non-finite frames)", async () => {
    const clean = Array.from({ length: 6 }, (_, i) => frame(i * 10, i));
    const frames = [
      ...clean,
      frame(Number.POSITIVE_INFINITY, 99),
      frame(Number.NEGATIVE_INFINITY, 98),
    ];
    const window = { startMs: Number.NEGATIVE_INFINITY, endMs: Number.POSITIVE_INFINITY };
    const result = await extract(frames, window);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectSameFrames(result.value, clean);
  });

  it("NaN-heavy input: 6 finite survivors among 200 NaN frames pass the >=6 rule in ascending order; 5 do not", async () => {
    const random = mulberry32(0xc0ffee);
    const finite6 = Array.from({ length: 6 }, (_, i) => frame(i * 16.67, i));
    const build = (finite: PoseFrame[]) => {
      const frames = [...finite];
      for (let i = 0; i < 200; i += 1) frames.push(frame(Number.NaN, 1000 + i));
      for (let i = frames.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [frames[i], frames[j]] = [frames[j]!, frames[i]!];
      }
      return frames;
    };
    const ok6 = await extract(build(finite6), { startMs: 0, endMs: 1000 });
    expect(ok6.ok).toBe(true);
    if (ok6.ok) expectSameFrames(ok6.value, finite6);

    const fail5 = await extract(build(finite6.slice(0, 5)), { startMs: 0, endMs: 1000 });
    expect(fail5.ok).toBe(false);
    if (!fail5.ok) expect(fail5.failure.code).toBe("pose.too_few_recorded_frames");
  });

  it("window boundaries stay inclusive after the fix and a frame exactly on both edges counts", async () => {
    const frames = [
      frame(100, 0),
      frame(200, 1),
      frame(150, 2),
      frame(120, 3),
      frame(180, 4),
      frame(160, 5),
    ];
    const inclusive = await extract([frame(Number.NaN, 9), ...frames], {
      startMs: 100,
      endMs: 200,
    });
    expect(inclusive.ok).toBe(true);
    if (inclusive.ok)
      expect(inclusive.value.map((f) => f.timestampMs)).toEqual([100, 120, 150, 160, 180, 200]);
    const exclusiveStart = await extract(frames, { startMs: 100.000001, endMs: 200 });
    expect(exclusiveStart.ok).toBe(false);
  });

  it("frozen / readonly input arrays and frames are accepted and never mutated", async () => {
    const frames = Object.freeze(
      [
        frame(500, 0),
        frame(Number.NaN, 1),
        frame(100, 2),
        frame(300, 3),
        frame(200, 4),
        frame(400, 5),
        frame(0, 6),
      ].map((f) => Object.freeze(f)),
    );
    const before = [...frames];
    const result = await extract(frames, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((f) => f.timestampMs)).toEqual([0, 100, 200, 300, 400, 500]);
    expectSameFrames(frames, before);
  });

  it("concurrent extractPose calls on one provider with different windows are independent and return fresh arrays", async () => {
    const frames = [
      frame(Number.NaN, 99),
      ...Array.from({ length: 61 }, (_, i) => frame(i * (1000 / 60), i)).reverse(),
    ];
    const provider = new RecordedPoseProvider({ frames, poseModelVersion: "attack" });
    const windows = [
      { startMs: 0, endMs: 1010 },
      { startMs: 0, endMs: 100 },
      { startMs: 500, endMs: 1010 },
      { startMs: 0, endMs: 1010 },
    ];
    const results = await Promise.all(windows.map((w) => provider.extractPose(clip, w)));
    for (const [i, result] of results.entries()) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expectSameFrames(result.value, referenceExtract(frames, windows[i]!));
    }
    const first = results[0]!;
    const last = results[3]!;
    if (first.ok && last.ok) {
      expect(first.value).not.toBe(last.value);
      first.value.reverse();
      const again = await provider.extractPose(clip, windows[0]!);
      expect(again.ok).toBe(true);
      if (again.ok) expectSameFrames(again.value, referenceExtract(frames, windows[0]!));
    }
  });

  it("through createGeometryProviderSet: a reversed sidecar with NaN frames yields ascending pose frames for the pipeline", async () => {
    const clean = Array.from({ length: 61 }, (_, i) => frame(i * (1000 / 60), i));
    const poseFrames = [frame(Number.NaN, 200), ...[...clean].reverse(), frame(Number.NaN, 201)];
    const set = createGeometryProviderSet({
      poseFrames,
      poseModelVersion: "apple-vision-bodypose-1",
      trigger: {
        modelVersion: "trigger-1",
        startMs: 0,
        endMs: 1010,
        peakMotionMs: 500,
        confidence: 0.9,
      },
      video: { width: 1080, height: 1920 },
    });
    const result = await set.pose.extractPose(clip, { startMs: 0, endMs: 1010 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectSameFrames(result.value, clean);
  });

  it("stability under large duplicate runs: 500 frames sharing 3 timestamps keep input order (engine sort must be stable)", async () => {
    const frames: PoseFrame[] = [];
    for (let i = 0; i < 500; i += 1) frames.push(frame([300, 100, 200][i % 3]!, i));
    frames.splice(250, 0, frame(Number.NaN, -1));
    const result = await extract(frames, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectSameFrames(result.value, referenceExtract(frames, { startMs: 0, endMs: 1000 }));
  });
});
