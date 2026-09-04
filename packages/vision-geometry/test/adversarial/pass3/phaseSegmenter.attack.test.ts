import { describe, expect, it } from "vitest";
import type { PhaseSpan, PoseFrame } from "@pickle/shared-types";
import { GeometricPhaseSegmenter } from "../../../src/phaseSegmenter.js";
import {
  bumpSteps,
  FRAME_MS,
  framesFromSteps,
  seededRandom,
  stroke,
} from "./support/wristFrames.js";

/**
 * Adversarial pass 3 — scenarios 5, 6, 7 (+ extras): GeometricPhaseSegmenter
 * under twin peaks, oversized windows, flat/short input and corrupt numbers.
 *
 * `it.fails` marks reproductions of findings against 4d812e1a (see the
 * FINDING comment on each); flip to `it` once production is fixed.
 */

const PHASE_ORDER = ["ready", "prepare", "accelerate", "contact", "follow_through", "recover"];

function assertOrderedContiguous(spans: readonly PhaseSpan[]): void {
  expect(spans.map((span) => span.key)).toEqual(PHASE_ORDER);
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    expect(Number.isFinite(span.startMs)).toBe(true);
    expect(Number.isFinite(span.endMs)).toBe(true);
    expect(span.endMs).toBeGreaterThanOrEqual(span.startMs);
    expect(span.representativeMs).toBeGreaterThanOrEqual(span.startMs);
    expect(span.representativeMs).toBeLessThanOrEqual(span.endMs);
    if (index > 0) expect(span.startMs).toBe(spans[index - 1]!.endMs);
  }
}

async function segment(
  frames: PoseFrame[],
  window: { startMs: number; endMs: number; contactMs?: number | null },
  aspectRatio = 1,
) {
  const segmenter = new GeometricPhaseSegmenter({ aspectRatio });
  return segmenter.segmentPhases(
    frames,
    [],
    stroke(window.startMs, window.endMs, window.contactMs ?? null),
  );
}

/** 61 frames (0..1000 ms at 60 fps). */
const oneSecondClip = (centers: readonly number[]): PoseFrame[] =>
  framesFromSteps(bumpSteps(61, centers));

describe("GeometricPhaseSegmenter — two identical peaks 400 ms apart (attack pass 3 / S5)", () => {
  // Peaks centred on frames 18 (300 ms) and 42 (700 ms): exactly 24 frames = 400 ms apart,
  // bit-identical triangular bumps.
  const twinPeaks = oneSecondClip([18, 42]);

  it("HELD: phases stay ordered and contiguous; contact maps to ONE peak, byte-identical on rerun", async () => {
    const first = await segment(twinPeaks, { startMs: 0, endMs: 1000 });
    const second = await segment(twinPeaks, { startMs: 0, endMs: 1000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    assertOrderedContiguous(first.value);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const contact = first.value.find((span) => span.key === "contact")!;
    // Contact lands on exactly ONE of the two peaks (never between them).
    const nearFirst = Math.abs(contact.representativeMs - 300) <= FRAME_MS;
    const nearSecond = Math.abs(contact.representativeMs - 700) <= FRAME_MS;
    expect(nearFirst !== nearSecond).toBe(true);
    // VERIFIED on 4d812e1a: the SECOND peak's raw sample at 683.33 ms wins. The
    // smoothed values are 1.86328124999999955591 (idx 16) vs 1.86328125000000044409
    // (idx 41) — the tie between physically identical bumps is decided by
    // ulp-level rounding of `(i+1)·FRAME_MS − (i−1)·FRAME_MS`, not by any rule.
    expect(contact.representativeMs).toBeCloseTo(683.3333333333334, 9);
  });

  it("HELD: 25 rapid repeats on a fresh segmenter each time are byte-identical", async () => {
    const reference = JSON.stringify(await segment(twinPeaks, { startMs: 0, endMs: 1000 }));
    const results = await Promise.all(
      Array.from({ length: 25 }, () => segment(twinPeaks, { startMs: 0, endMs: 1000 })),
    );
    for (const result of results) expect(JSON.stringify(result)).toBe(reference);
  });

  it("HELD: a contact hint on the second peak selects it deterministically; a hint on the first keeps the first", async () => {
    const onSecond = await segment(twinPeaks, { startMs: 0, endMs: 1000, contactMs: 700 });
    const onFirst = await segment(twinPeaks, { startMs: 0, endMs: 1000, contactMs: 300 });
    expect(onSecond.ok && onFirst.ok).toBe(true);
    if (!onSecond.ok || !onFirst.ok) return;
    assertOrderedContiguous(onSecond.value);
    assertOrderedContiguous(onFirst.value);
    const secondContact = onSecond.value.find((span) => span.key === "contact")!;
    const firstContact = onFirst.value.find((span) => span.key === "contact")!;
    expect(Math.abs(secondContact.representativeMs - 700)).toBeLessThanOrEqual(FRAME_MS);
    expect(Math.abs(firstContact.representativeMs - 300)).toBeLessThanOrEqual(FRAME_MS);
    expect(
      JSON.stringify(await segment(twinPeaks, { startMs: 0, endMs: 1000, contactMs: 700 })),
    ).toBe(JSON.stringify(onSecond));
  });

  // FINDING (P3): contactIndex (phaseSegmenter.ts:229-240) documents "snap the
  // recorded contact hint to the nearest LOCAL SPEED MAXIMUM when one exists
  // within 120 ms; the global peak wins otherwise". The implementation takes
  // the largest sample within ±120 ms whether or not it is a local maximum, so
  // a hint in the trough between two peaks (500 ms) puts contact on the rising
  // slope at 666.67 ms — a point that is neither peak nor the global maximum.
  it.fails(
    "BROKEN: a hint in the trough (500 ms, no local max within 120 ms) must fall back to a real peak",
    async () => {
      const result = await segment(twinPeaks, { startMs: 0, endMs: 1000, contactMs: 500 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const contact = result.value.find((span) => span.key === "contact")!;
      const nearFirst = Math.abs(contact.representativeMs - 300) <= FRAME_MS;
      const nearSecond = Math.abs(contact.representativeMs - 700) <= FRAME_MS;
      expect(nearFirst || nearSecond).toBe(true);
    },
  );

  it("evidence: trough hint → contact at 666.67 ms on the slope (raw speed 1.79 vs peak 2.17)", async () => {
    const result = await segment(twinPeaks, { startMs: 0, endMs: 1000, contactMs: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    assertOrderedContiguous(result.value);
    const contact = result.value.find((span) => span.key === "contact")!;
    expect(contact.representativeMs).toBeCloseTo(666.6666666666667, 9);
  });

  it("HELD: mirrored input (peaks at 18/42 vs 42/18 construction order) is order-stable", async () => {
    const mirrored = oneSecondClip([42, 18]);
    expect(JSON.stringify(mirrored)).toBe(JSON.stringify(twinPeaks));
    const a = await segment(twinPeaks, { startMs: 0, endMs: 1000 });
    const b = await segment(mirrored, { startMs: 0, endMs: 1000 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("GeometricPhaseSegmenter — window [0, 60000] over a 1 s clip (attack pass 3 / S6)", () => {
  const clip = oneSecondClip([30]);

  it("HELD: the oversized window still segments (frames inside are used), phases ordered", async () => {
    const result = await segment(clip, { startMs: 0, endMs: 60000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    assertOrderedContiguous(result.value);
    const contact = result.value.find((span) => span.key === "contact")!;
    expect(Math.abs(contact.representativeMs - 500)).toBeLessThanOrEqual(FRAME_MS);
  });

  // FINDING (P2): phaseSegmenter.ts:182 and :193 take the OUTER span bounds
  // from stroke.startMs / stroke.endMs (the requested window), not from the
  // first/last MEASURED frame. With a [0, 60000] request over a 1 s clip the
  // `recover` phase is reported as 1000→60000 ms — 59 s of phase with no
  // frame behind it — contradicting the module's "no invented frames" contract
  // (phaseSegmenter.ts:18) and feeding analyzeCapture.ts per-phase windows.
  it.fails("BROKEN: spans must clamp to measured frames (recover.endMs ≤ last frame)", async () => {
    const result = await segment(clip, { startMs: 0, endMs: 60000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recover = result.value.find((span) => span.key === "recover")!;
    expect(recover.endMs).toBeLessThanOrEqual(1000);
  });

  it.fails(
    "BROKEN: spans must clamp to measured frames (ready.startMs ≥ first frame)",
    async () => {
      const result = await segment(clip, { startMs: -60000, endMs: 60000 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ready = result.value.find((span) => span.key === "ready")!;
      expect(ready.startMs).toBeGreaterThanOrEqual(0);
    },
  );

  it("evidence: the requested bounds are echoed verbatim — 59 s of recover, 60 s of ready", async () => {
    const result = await segment(clip, { startMs: -60000, endMs: 60000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ready = result.value.find((span) => span.key === "ready")!;
    const recover = result.value.find((span) => span.key === "recover")!;
    expect(ready.startMs).toBe(-60000);
    expect(recover.endMs).toBe(60000);
    expect(recover.endMs - recover.startMs).toBeGreaterThan(59000);
    // Inner boundaries ARE measured — only the two outer edges extrapolate.
    for (const span of result.value.slice(1, 5)) {
      expect(span.startMs).toBeGreaterThanOrEqual(0);
      expect(span.endMs).toBeLessThanOrEqual(1000 + FRAME_MS);
    }
  });

  it("HELD: a window that is [start,end] of the clip exactly yields spans inside [0, 1000]", async () => {
    const result = await segment(clip, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.startMs).toBe(0);
    expect(result.value[5]!.endMs).toBe(1000);
  });
});

describe("GeometricPhaseSegmenter — exactly 6 flat frames (attack pass 3 / S7)", () => {
  it("HELD: 6 frames at constant wrist speed abstain with low_confidence (no six zero-length phases)", async () => {
    const flat = framesFromSteps([4, 4, 4, 4, 4, 4]);
    expect(flat).toHaveLength(6);
    const result = await segment(flat, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("phase.no_distinct_stroke");
  });

  it("HELD: 6 perfectly stationary frames (speed 0) abstain too, not a division into six empties", async () => {
    const still = framesFromSteps([0, 0, 0, 0, 0, 0]);
    const result = await segment(still, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("phase.no_distinct_stroke");
  });

  it("HELD: 5 frames abstain with phase.too_few_pose_frames; 6 with the wrist hidden → wrist_not_tracked", async () => {
    const five = framesFromSteps(bumpSteps(5, [2]));
    const result = await segment(five, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("phase.too_few_pose_frames");

    const hidden = framesFromSteps(bumpSteps(6, [3])).map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((entry) => ({ ...entry, visibility: 0.1 })),
    }));
    const hiddenResult = await segment(hidden, { startMs: 0, endMs: 1000 });
    expect(hiddenResult.ok).toBe(false);
    if (!hiddenResult.ok) expect(hiddenResult.failure.code).toBe("phase.wrist_not_tracked");
  });

  it("HELD: 60 flat frames (long idle) abstain identically", async () => {
    const result = await segment(framesFromSteps(Array.from({ length: 61 }, () => 3)), {
      startMs: 0,
      endMs: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("phase.no_distinct_stroke");
  });
});

describe("GeometricPhaseSegmenter — corrupt numbers and unusual input (attack pass 3 / extra)", () => {
  const clip = oneSecondClip([30]);

  it("HELD: unsorted (reversed) frames fed directly abstain instead of producing spans", async () => {
    const result = await segment([...clip].reverse(), { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("low_confidence");
  });

  it("HELD: a NaN wrist coordinate on one frame never throws and never leaks NaN into span times", async () => {
    const corrupted = clip.map((frame, index) =>
      index === 30
        ? { ...frame, landmarks: frame.landmarks.map((entry) => ({ ...entry, x: Number.NaN })) }
        : frame,
    );
    const result = await segment(corrupted, { startMs: 0, endMs: 1000 });
    if (result.ok) {
      for (const span of result.value) {
        expect(Number.isFinite(span.startMs)).toBe(true);
        expect(Number.isFinite(span.endMs)).toBe(true);
        expect(Number.isFinite(span.representativeMs)).toBe(true);
      }
    } else {
      expect(result.failure.kind).toBe("low_confidence");
    }
  });

  // FINDING (P3): trackingConfidence (phaseSegmenter.ts:243-246) clamps with
  // Math.min/Math.max, which pass NaN straight through. ONE frame with
  // confidence NaN makes every PhaseSpan.confidence NaN while the result is
  // still `ok`.
  it.fails(
    "BROKEN: a single NaN frame confidence must not produce ok spans with NaN confidence",
    async () => {
      const corrupted = clip.map((frame, index) =>
        index === 10 ? { ...frame, confidence: Number.NaN } : frame,
      );
      const result = await segment(corrupted, { startMs: 0, endMs: 1000 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const span of result.value) expect(Number.isFinite(span.confidence)).toBe(true);
    },
  );

  it("evidence: NaN confidence propagates to all six spans", async () => {
    const corrupted = clip.map((frame, index) =>
      index === 10 ? { ...frame, confidence: Number.NaN } : frame,
    );
    const result = await segment(corrupted, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.every((span) => Number.isNaN(span.confidence))).toBe(true);
  });

  it("HELD: aspectRatio NaN / +Infinity / 0 (0-height or 0-width clip) all abstain with low_confidence", async () => {
    for (const [aspectRatio, code] of [
      [Number.NaN, "phase.wrist_not_tracked"],
      [Number.POSITIVE_INFINITY, "phase.wrist_not_tracked"],
      [0, "phase.no_distinct_stroke"],
    ] as const) {
      const result = await segment(clip, { startMs: 0, endMs: 1000 }, aspectRatio);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe("low_confidence");
        expect(result.failure.code).toBe(code);
      }
    }
  });

  it("HELD: a negative aspectRatio (mirrored x) segments identically to the positive one", async () => {
    const positive = await segment(clip, { startMs: 0, endMs: 1000 }, 1);
    const negative = await segment(clip, { startMs: 0, endMs: 1000 }, -1);
    expect(JSON.stringify(negative)).toBe(JSON.stringify(positive));
  });

  it("HELD: seeded jitter (seed 0xa77ac) on a clean swing keeps phases ordered and contact within 2 frames of 500 ms", async () => {
    const random = seededRandom(0xa77ac);
    for (let trial = 0; trial < 20; trial += 1) {
      const jittered = clip.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((entry) => ({
          ...entry,
          x: entry.x + (random() - 0.5) * 0.004,
          y: entry.y + (random() - 0.5) * 0.004,
        })),
      }));
      const result = await segment(jittered, { startMs: 0, endMs: 1000 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      assertOrderedContiguous(result.value);
      const contact = result.value.find((span) => span.key === "contact")!;
      expect(Math.abs(contact.representativeMs - 500)).toBeLessThanOrEqual(2 * FRAME_MS);
    }
  });

  // FINDING (P3): phaseSegmenter.ts:66-73 recomputes movingAverage(rawSpeeds, 5)
  // for EVERY sample (O(n²)). The frame gate admits clips up to 10 min
  // (FRAME_THRESHOLDS.maxDurationMs); a 2000-frame (33 s @60 fps) window
  // already costs seconds. Timings are logged, the assertion is only the
  // superlinear shape so the test is not machine-speed dependent.
  it("evidence: smoothing is superlinear — doubling n more than doubles time (timings logged)", async () => {
    const time = async (n: number): Promise<number> => {
      const frames = framesFromSteps(bumpSteps(n, [Math.floor(n / 2)], { halfWidth: 12 }));
      const started = performance.now();
      const result = await segment(frames, { startMs: 0, endMs: n * FRAME_MS });
      expect(result.ok).toBe(true);
      if (result.ok) assertOrderedContiguous(result.value);
      return performance.now() - started;
    };
    await time(250); // warm-up
    const t1000 = await time(1000);
    const t2000 = await time(2000);
    const t4000 = await time(4000);
    console.log(
      `[pass3] segmentPhases timings ms: n=1000 ${t1000.toFixed(0)}, n=2000 ${t2000.toFixed(0)}, n=4000 ${t4000.toFixed(0)}`,
    );
    expect(t4000).toBeGreaterThan(t1000 * 2);
  }, 180_000);

  it("HELD: unicode / unknown landmark names and empty landmark arrays abstain without throwing", async () => {
    const weird = clip.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((entry) => ({
        ...entry,
        name: "手首😀" as typeof entry.name,
      })),
    }));
    const result = await segment(weird, { startMs: 0, endMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("phase.wrist_not_tracked");

    const empty = clip.map((frame) => ({ ...frame, landmarks: [] }));
    const emptyResult = await segment(empty, { startMs: 0, endMs: 1000 });
    expect(emptyResult.ok).toBe(false);
  });
});
