import { describe, expect, it } from "vitest";
import type { PoseFrame } from "@pickle/shared-types";
import type { VideoClipRef } from "@pickle/vision-contracts";
import { pathLength, speedSeries } from "../../../src/kinematics.js";
import { GeometricPhaseSegmenter } from "../../../src/phaseSegmenter.js";
import { RecordedPoseProvider } from "../../../src/providers.js";
import {
  bumpSteps,
  framesFromSteps,
  seededRandom,
  stroke,
  wristFrame,
} from "./support/wristFrames.js";

/**
 * Adversarial pass 3 — scenarios 2 and 3: RecordedPoseProvider under
 * duplicate, reversed and NaN timestamps.
 *
 * `it.fails` marks reproductions of findings against 4d812e1a (see the
 * FINDING comment on each); flip to `it` once production is fixed.
 */

const clip: VideoClipRef = {
  uri: "attack-pass3",
  durationMs: 1000,
  fps: 60,
  width: 100,
  height: 100,
};
// 60 × (1000/60) = 1000.0000000000001 in IEEE-754, so the window end is padded past the last frame.
const WINDOW = { startMs: 0, endMs: 1010 };

/** 61 frames at 60 fps (0..1000 ms), one clean wrist-speed peak at frame 30. */
const cleanSwing = (): PoseFrame[] => framesFromSteps(bumpSteps(61, [30]));

const timestamps = (frames: readonly PoseFrame[]): number[] =>
  frames.map((frame) => frame.timestampMs);

const inversions = (frames: readonly PoseFrame[]): number => {
  let count = 0;
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index]!.timestampMs < frames[index - 1]!.timestampMs) count += 1;
  }
  return count;
};

function shuffledWithNaN(base: readonly PoseFrame[], seed: number, nanCount: number): PoseFrame[] {
  const random = seededRandom(seed);
  const frames = [...base];
  for (let index = 0; index < nanCount; index += 1) {
    frames.push(wristFrame(Number.NaN, random(), random()));
  }
  for (let index = frames.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [frames[index], frames[swap]] = [frames[swap]!, frames[index]!];
  }
  return frames;
}

function shiftedDuplicate(frame: PoseFrame, dx: number): PoseFrame {
  return {
    ...frame,
    landmarks: frame.landmarks.map((entry) => ({ ...entry, x: entry.x + dx })),
  };
}

function assertOrderedContiguous(spans: readonly { startMs: number; endMs: number }[]): void {
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    expect(span.endMs).toBeGreaterThanOrEqual(span.startMs);
    if (index > 0) expect(span.startMs).toBeCloseTo(spans[index - 1]!.endMs, 9);
  }
}

describe("RecordedPoseProvider — duplicate timestamps (attack pass 3 / S2)", () => {
  const base = cleanSwing();
  // Frames 25..35 duplicated at the SAME timestamp with the wrist shifted +0.05.
  const duplicates = base.slice(25, 36).map((frame) => shiftedDuplicate(frame, 0.05));
  const provider = new RecordedPoseProvider({
    frames: [...base, ...duplicates],
    poseModelVersion: "attack",
  });

  it("HELD: sort is stable — same-timestamp frames keep input order and none are dropped", async () => {
    const result = await provider.extractPose(clip, WINDOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(base.length + duplicates.length);
    for (let index = 1; index < result.value.length; index += 1) {
      expect(result.value[index]!.timestampMs).toBeGreaterThanOrEqual(
        result.value[index - 1]!.timestampMs,
      );
    }
    // For each duplicated timestamp the original (input-earlier) frame comes first.
    for (const duplicate of duplicates) {
      const pair = result.value.filter((frame) => frame.timestampMs === duplicate.timestampMs);
      expect(pair).toHaveLength(2);
      expect(pair[0]!.landmarks[0]!.x).toBeLessThan(pair[1]!.landmarks[0]!.x);
    }
  });

  it("HELD: speedSeries never divides by dt=0 (all samples finite)", async () => {
    const result = await provider.extractPose(clip, WINDOW);
    if (!result.ok) throw new Error("expected frames");
    const speeds = speedSeries(result.value, "right_wrist", 1);
    expect(speeds.length).toBeGreaterThan(0);
    for (const sample of speeds) expect(Number.isFinite(sample.value)).toBe(true);

    // Triple duplicate: prev/next share a timestamp → dt=0 → sample skipped, not Infinity.
    const triple = [
      wristFrame(0, 0.1, 0.5),
      wristFrame(100, 0.2, 0.5),
      wristFrame(100, 0.4, 0.5),
      wristFrame(100, 0.6, 0.5),
      wristFrame(200, 0.7, 0.5),
    ];
    const tripleSpeeds = speedSeries(triple, "right_wrist", 1);
    for (const sample of tripleSpeeds) expect(Number.isFinite(sample.value)).toBe(true);
    expect(tripleSpeeds.some((sample) => sample.timestampMs === 100)).toBe(true);
    expect(tripleSpeeds).toHaveLength(2); // the middle 100 ms sample (dt=0) is skipped
  });

  it("HELD: the segmenter still returns ordered, contiguous phases", async () => {
    const result = await provider.extractPose(clip, WINDOW);
    if (!result.ok) throw new Error("expected frames");
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const first = await segmenter.segmentPhases(result.value, [], stroke(0, 1000, null));
    const second = await segmenter.segmentPhases(result.value, [], stroke(0, 1000, null));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.map((span) => span.key)).toEqual([
      "ready",
      "prepare",
      "accelerate",
      "contact",
      "follow_through",
      "recover",
    ]);
    assertOrderedContiguous(first.value);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  // FINDING (P3): pathLength (kinematics.ts:177-183) sums the displacement
  // between two frames that share a timestamp — a zero-time "teleport" — so a
  // duplicated timestamp with different landmarks inflates path length
  // (0.918 vs 0.289 here, 3.2×) and swingingWrist / backswing features with it.
  it.fails("BROKEN: pathLength must not count displacement across a dt=0 pair", async () => {
    const result = await provider.extractPose(clip, WINDOW);
    if (!result.ok) throw new Error("expected frames");
    const withDuplicates = pathLength(result.value, "right_wrist", 0, 1000, 1);
    const withoutDuplicates = pathLength(base, "right_wrist", 0, 1000, 1);
    expect(withDuplicates).toBeCloseTo(withoutDuplicates, 6);
  });

  // FINDING (P3, same root cause): the central difference across a same-ts pair
  // attributes the +0.05 jump to a single 16.7 ms interval, inflating the raw
  // speed maximum (3.47 vs 2.17 units/s here).
  it.fails("BROKEN: a dt=0 displacement must not inflate the wrist speed profile", async () => {
    const result = await provider.extractPose(clip, WINDOW);
    if (!result.ok) throw new Error("expected frames");
    const maxWith = Math.max(...speedSeries(result.value, "right_wrist", 1).map((s) => s.value));
    const maxWithout = Math.max(...speedSeries(base, "right_wrist", 1).map((s) => s.value));
    expect(maxWith).toBeLessThanOrEqual(maxWithout * 1.05);
  });

  it("evidence: exact magnitudes of the dt=0 inflation", async () => {
    const result = await provider.extractPose(clip, WINDOW);
    if (!result.ok) throw new Error("expected frames");
    const withDuplicates = pathLength(result.value, "right_wrist", 0, 1000, 1);
    const withoutDuplicates = pathLength(base, "right_wrist", 0, 1000, 1);
    // 11 duplicates × (0.05 jump out + 0.05 jump back) ≈ 1.1 − one 0.05 at the tail edge.
    expect(withDuplicates - withoutDuplicates).toBeGreaterThan(0.6);
    expect(withoutDuplicates).toBeCloseTo(0.2890625, 12);
  });
});

describe("RecordedPoseProvider — reversed order plus a NaN timestamp (attack pass 3 / S3)", () => {
  const base = cleanSwing();

  it("HELD: reverse-ordered input (no NaN) is returned ascending and complete", async () => {
    const provider = new RecordedPoseProvider({
      frames: [...base].reverse(),
      poseModelVersion: "attack",
    });
    const result = await provider.extractPose(clip, WINDOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(timestamps(result.value)).toEqual(timestamps(base));
  });

  it("HELD: the NaN-timestamp frame itself is always excluded and never counts toward the ≥6 rule", async () => {
    const reversed = [...base].reverse();
    reversed.splice(20, 0, wristFrame(Number.NaN, 0.123, 0.456));
    const provider = new RecordedPoseProvider({ frames: reversed, poseModelVersion: "attack" });
    const result = await provider.extractPose(clip, WINDOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(base.length);
    expect(result.value.some((frame) => Number.isNaN(frame.timestampMs))).toBe(false);

    const five = [...base.slice(0, 5).reverse(), wristFrame(Number.NaN, 0.5, 0.5)];
    const fiveResult = await new RecordedPoseProvider({
      frames: five,
      poseModelVersion: "attack",
    }).extractPose(clip, WINDOW);
    expect(fiveResult.ok).toBe(false);
    if (!fiveResult.ok) {
      expect(fiveResult.failure.code).toBe("pose.too_few_recorded_frames");
      expect(fiveResult.failure.kind).toBe("low_confidence");
    }
  });

  it("HELD: ascending input with a NaN frame prepended / appended / in the middle stays ascending", async () => {
    for (const position of [0, 30, base.length]) {
      const frames = [...base];
      frames.splice(position, 0, wristFrame(Number.NaN, 0.5, 0.5));
      const provider = new RecordedPoseProvider({ frames, poseModelVersion: "attack" });
      const result = await provider.extractPose(clip, WINDOW);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(timestamps(result.value)).toEqual(timestamps(base));
    }
  });

  // FINDING (P2): providers.ts:47 sorts with `a.timestampMs - b.timestampMs`.
  // A NaN timestamp makes that comparator return NaN (treated as "equal"),
  // which violates the consistency contract of Array.prototype.sort; V8's
  // TimSort then emits a MIS-ORDERED array. The NaN frame is only dropped
  // afterwards by the window filter — the damage to the other frames'
  // order survives, and GeometricPhaseSegmenter / speedSeries never re-sort.
  it.fails(
    "BROKEN: reverse-ordered frames + one NaN timestamp must still come back ascending",
    async () => {
      const frames = [...base].reverse();
      frames.splice(1, 0, wristFrame(Number.NaN, 0.5, 0.5));
      const provider = new RecordedPoseProvider({ frames, poseModelVersion: "attack" });
      const result = await provider.extractPose(clip, WINDOW);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(timestamps(result.value)).toEqual(timestamps(base));
    },
  );

  it.fails(
    "BROKEN: seeded shuffle (seed 0x5eed) + 5 NaN frames must come back ascending",
    async () => {
      const provider = new RecordedPoseProvider({
        frames: shuffledWithNaN(base, 0x5eed, 5),
        poseModelVersion: "attack",
      });
      const result = await provider.extractPose(clip, WINDOW);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(timestamps(result.value)).toEqual(timestamps(base));
    },
  );

  it("evidence: exact misorderings — [1000, 0, 16.7, …] and two interleaved runs (seed 0x5eed)", async () => {
    const frames = [...base].reverse();
    frames.splice(1, 0, wristFrame(Number.NaN, 0.5, 0.5));
    const single = await new RecordedPoseProvider({
      frames,
      poseModelVersion: "attack",
    }).extractPose(clip, WINDOW);
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.value).toHaveLength(base.length);
    expect(inversions(single.value)).toBe(1);
    expect(single.value[0]!.timestampMs).toBeCloseTo(1000, 9);
    expect(single.value[1]!.timestampMs).toBe(0);

    const shuffled = await new RecordedPoseProvider({
      frames: shuffledWithNaN(base, 0x5eed, 5),
      poseModelVersion: "attack",
    }).extractPose(clip, WINDOW);
    expect(shuffled.ok).toBe(true);
    if (!shuffled.ok) return;
    expect(shuffled.value).toHaveLength(base.length);
    expect(inversions(shuffled.value)).toBeGreaterThanOrEqual(1);
    // Same multiset of measured frames, wrong order.
    expect([...timestamps(shuffled.value)].sort((a, b) => a - b)).toEqual(timestamps(base));

    // Control: the identical shuffle WITHOUT NaN frames sorts perfectly.
    const control = await new RecordedPoseProvider({
      frames: shuffledWithNaN(base, 0x5eed, 0),
      poseModelVersion: "attack",
    }).extractPose(clip, WINDOW);
    expect(control.ok).toBe(true);
    if (control.ok) expect(timestamps(control.value)).toEqual(timestamps(base));
  });

  it("evidence: the misordered frames change the downstream segmentation", async () => {
    const clean = await new RecordedPoseProvider({
      frames: base,
      poseModelVersion: "attack",
    }).extractPose(clip, WINDOW);
    const corrupt = await new RecordedPoseProvider({
      frames: shuffledWithNaN(base, 0x5eed, 5),
      poseModelVersion: "attack",
    }).extractPose(clip, WINDOW);
    expect(clean.ok && corrupt.ok).toBe(true);
    if (!clean.ok || !corrupt.ok) return;
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const cleanPhases = await segmenter.segmentPhases(clean.value, [], stroke(0, 1010, null));
    const corruptPhases = await segmenter.segmentPhases(corrupt.value, [], stroke(0, 1010, null));
    expect(JSON.stringify(corruptPhases)).not.toBe(JSON.stringify(cleanPhases));
  });

  it("HELD: an inverted or NaN window yields the too-few-frames abstention, never a throw", async () => {
    const provider = new RecordedPoseProvider({ frames: base, poseModelVersion: "attack" });
    for (const window of [
      { startMs: 1000, endMs: 0 },
      { startMs: Number.NaN, endMs: 1000 },
      { startMs: 0, endMs: Number.NaN },
    ]) {
      const result = await provider.extractPose(clip, window);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("pose.too_few_recorded_frames");
    }
  });
});
