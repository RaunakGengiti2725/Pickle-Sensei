import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { PoseFrame } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";
import type { VideoClipRef } from "@pickle/vision-contracts";
import {
  GeometricPhaseSegmenter,
  RecordedPoseProvider,
  RecordedTriggerStrokeDetector,
  classifyStroke,
  type HeuristicPaddleObservation,
} from "../src/index.js";
import { evaluateFrameAnalyzability, type FrameStats } from "../src/frameAnalyzability.js";
import { landmark, pathLength } from "../src/kinematics.js";
import {
  bumpSteps,
  framesFromSteps,
  seededRandom,
  stroke,
  wristFrame,
} from "./adversarial/pass3/support/wristFrames.js";

/**
 * ADJUDICATION — pkg-vision-geometry at 4d812e1a.
 *
 * Independent reproduction of the auditor candidates. Every `it` asserts the
 * OBSERVED (defective) behaviour positively so the verbose log is unambiguous
 * evidence that the defect exists at this revision. A fix will make these
 * tests fail; the acceptance criteria in the adjudication report replace them.
 */

const CLIP: VideoClipRef = {
  uri: "adjudicate://clip",
  durationMs: 5000,
  width: 1080,
  height: 1920,
  fps: 60,
};

function paddleAt(
  x: number,
  y: number,
  contactMs: number,
  confidence = 0.9,
): HeuristicPaddleObservation[] {
  return Array.from({ length: 11 }, (_, index) => ({
    timestampMs: contactMs - 200 + index * 40,
    center: { x, y },
    confidence,
  }));
}

function withWristInvisibleAtContact(sequence: PoseSequence, contactMs: number): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      Math.abs(frame.timestampMs - contactMs) <= 8
        ? {
            ...frame,
            landmarks: frame.landmarks.map((mark) =>
              mark.name === "right_wrist" ? { ...mark, visibility: 0.1 } : mark,
            ),
          }
        : frame,
    ),
  };
}

const timestamps = (frames: readonly PoseFrame[]): number[] => frames.map((f) => f.timestampMs);

// ─────────────────────────────────────────────────────────────────────────────
// VG-1 (adversary1 P1): NaN paddle center + wrist invisible → committed side, NaN confidence
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-1 classifyStroke: NaN paddle center with wrist unmeasured at contact", () => {
  const { sequence, window } = generateSwingSequence();
  const blind = withWristInvisibleAtContact(sequence, window.peakMs);

  it("OBSERVED: commits BACKHAND with confidence NaN, contactPointSource paddle", () => {
    const prediction = classifyStroke({
      sequence: blind,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(Number.NaN, 0.5, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    console.log(
      "[VG-1] NaN center →",
      JSON.stringify({
        label: prediction.label,
        confidence: prediction.confidence,
        contactPointSource: prediction.contactPointSource,
        contactPointReliability: prediction.contactPointReliability,
        limitingFactors: prediction.limitingFactors,
      }),
    );
    expect(prediction.label).toBe("BACKHAND");
    expect(Number.isNaN(prediction.confidence)).toBe(true);
    expect(prediction.contactPointSource).toBe("paddle");
    expect(prediction.limitingFactors).toContain("paddle_plausibility_unverified_wrist_invisible");
  });

  it("OBSERVED: {x:+Infinity} center → committed FOREHAND (finite 0.6) from an infinite point", () => {
    const prediction = classifyStroke({
      sequence: blind,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(Number.POSITIVE_INFINITY, 0.5, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    console.log(
      "[VG-1] +Inf center →",
      prediction.label,
      prediction.confidence,
      prediction.contactPointSource,
    );
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.contactPointSource).toBe("paddle");
  });

  it("CONTROL: same NaN center with wrist VISIBLE → wrist used, finite confidence", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(Number.NaN, 0.5, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.contactPointSource).toBe("wrist");
    expect(Number.isFinite(prediction.confidence)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VG-1b (adversary1 P2): out-of-image paddle center accepted (same branch)
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-1b classifyStroke: out-of-image paddle center with wrist unmeasured", () => {
  const { sequence, window } = generateSwingSequence();
  const blind = withWristInvisibleAtContact(sequence, window.peakMs);

  it("OBSERVED: {x:5,y:0.5} → committed FOREHAND from a point outside [0,1]²", () => {
    const prediction = classifyStroke({
      sequence: blind,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(5, 0.5, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    console.log(
      "[VG-1b] {x:5,y:0.5} →",
      JSON.stringify({
        label: prediction.label,
        confidence: prediction.confidence,
        contactPointSource: prediction.contactPointSource,
        contactPointReliability: prediction.contactPointReliability,
        limitingFactors: prediction.limitingFactors,
      }),
    );
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.contactPointSource).toBe("paddle");
    expect(prediction.contactPointReliability).toBe("degraded");
    expect(
      prediction.limitingFactors.some((f) => /out_of_image|not_finite|implausible/.test(f)),
    ).toBe(false);
  });

  it("OBSERVED: {x:-7,y:0.5} → committed BACKHAND (mirror)", () => {
    const prediction = classifyStroke({
      sequence: blind,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(-7, 0.5, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    console.log("[VG-1b] {x:-7,y:0.5} →", prediction.label, prediction.confidence);
    expect(prediction.label).toBe("BACKHAND");
    expect(prediction.contactPointSource).toBe("paddle");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VG-2 (adversary1 P2): classifyStroke never validates its window
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-2 classifyStroke: window is never validated", () => {
  const { sequence, window } = generateSwingSequence();
  const wristSpeeds = Array.from({ length: 20 }, (_, index) => ({
    timestampMs: window.peakMs - 300 + index * 30 + 7,
    value: 1.8,
  }));

  it("OBSERVED: zero-length window → FOREHAND 0.8 with 'speed peak 0.00 u/s' from 0 in-window samples", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.peakMs, endMs: window.peakMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds,
    });
    console.log(
      "[VG-2] zero-length →",
      prediction.label,
      prediction.confidence,
      JSON.stringify(prediction.evidence),
      JSON.stringify(prediction.limitingFactors),
    );
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.evidence.some((line) => line.includes("speed peak 0.00 u/s"))).toBe(true);
    expect(
      prediction.limitingFactors.some((f) => /window|outside/i.test(f) && !/bounce/.test(f)),
    ).toBe(false);
  });

  it("OBSERVED: inverted window (start > end) → committed FOREHAND", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.endMs, endMs: window.startMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds,
    });
    console.log(
      "[VG-2] inverted →",
      prediction.label,
      prediction.confidence,
      JSON.stringify(prediction.limitingFactors),
    );
    expect(prediction.label).toBe("FOREHAND");
  });

  it("OBSERVED: contactMs 800ms after window end → committed FOREHAND, no window limiting factor", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: 0, endMs: 300 },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    console.log(
      "[VG-2] contact outside →",
      window.peakMs,
      prediction.label,
      prediction.confidence,
      JSON.stringify(prediction.limitingFactors),
    );
    expect(window.peakMs).toBeGreaterThan(300);
    expect(prediction.label).toBe("FOREHAND");
    expect(
      prediction.limitingFactors.some((f) => /window|outside/i.test(f) && !/bounce/.test(f)),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VG-3 (adversary3 P2): RecordedPoseProvider mis-orders frames when a NaN timestamp exists
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-3 RecordedPoseProvider: NaN timestamp breaks the sort comparator", () => {
  const clip: VideoClipRef = {
    uri: "adjudicate",
    durationMs: 1000,
    fps: 60,
    width: 100,
    height: 100,
  };
  const WINDOW = { startMs: 0, endMs: 1010 };
  const base = framesFromSteps(bumpSteps(61, [30]));

  it("OBSERVED: reversed 61 frames + one NaN frame → 61 frames returned, first is 1000 then 0 (misordered)", async () => {
    const frames = [...base].reverse();
    frames.splice(1, 0, wristFrame(Number.NaN, 0.5, 0.5));
    const result = await new RecordedPoseProvider({ frames, poseModelVersion: "adj" }).extractPose(
      clip,
      WINDOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ts = timestamps(result.value);
    console.log("[VG-3] first 5 timestamps:", ts.slice(0, 5), "count", ts.length);
    expect(ts.length).toBe(61);
    expect(ts[0]).toBeCloseTo(1000, 9);
    expect(ts[1]).toBe(0);
    expect(ts).not.toEqual(timestamps(base));
  });

  it("CONTROL: reversed 61 frames without NaN → perfectly ascending", async () => {
    const frames = [...base].reverse();
    const result = await new RecordedPoseProvider({ frames, poseModelVersion: "adj" }).extractPose(
      clip,
      WINDOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(timestamps(result.value)).toEqual(timestamps(base));
  });

  it("OBSERVED: single-NaN reversed case → 1 inversion; segmenter output happens to be identical to clean (one swapped edge frame)", async () => {
    const frames = [...base].reverse();
    frames.splice(1, 0, wristFrame(Number.NaN, 0.5, 0.5));
    const corrupt = await new RecordedPoseProvider({ frames, poseModelVersion: "adj" }).extractPose(
      clip,
      WINDOW,
    );
    const clean = await new RecordedPoseProvider({
      frames: [...base].reverse(),
      poseModelVersion: "adj",
    }).extractPose(clip, WINDOW);
    if (!corrupt.ok || !clean.ok) throw new Error("unreachable");
    const seg = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const a = await seg.segmentPhases(corrupt.value, [], stroke(0, 1010));
    const b = await seg.segmentPhases(clean.value, [], stroke(0, 1010));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  function shuffledWithNaN(seed: number, nanCount: number): PoseFrame[] {
    const random = seededRandom(seed);
    const frames = [...base];
    for (let index = 0; index < nanCount; index += 1)
      frames.push(wristFrame(Number.NaN, random(), random()));
    for (let index = frames.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [frames[index], frames[swap]] = [frames[swap]!, frames[index]!];
    }
    return frames;
  }

  it("OBSERVED: seeded shuffle (0x5eed) + 5 NaN frames → ≥1 inversion, same multiset; segmenter output differs from clean", async () => {
    const corrupt = await new RecordedPoseProvider({
      frames: shuffledWithNaN(0x5eed, 5),
      poseModelVersion: "adj",
    }).extractPose(clip, WINDOW);
    const control = await new RecordedPoseProvider({
      frames: shuffledWithNaN(0x5eed, 0),
      poseModelVersion: "adj",
    }).extractPose(clip, WINDOW);
    const clean = await new RecordedPoseProvider({
      frames: base,
      poseModelVersion: "adj",
    }).extractPose(clip, WINDOW);
    if (!corrupt.ok || !clean.ok || !control.ok) throw new Error("unreachable");
    const ts = timestamps(corrupt.value);
    let inversions = 0;
    for (let i = 1; i < ts.length; i += 1) if (ts[i]! < ts[i - 1]!) inversions += 1;
    console.log("[VG-3] shuffled+NaN inversions:", inversions, "first 12:", ts.slice(0, 12));
    expect(ts.length).toBe(61);
    expect(inversions).toBeGreaterThanOrEqual(1);
    expect([...ts].sort((x, y) => x - y)).toEqual(timestamps(base));
    expect(timestamps(control.value)).toEqual(timestamps(base));
    if (!corrupt.ok || !clean.ok) throw new Error("unreachable");
    const seg = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const a = await seg.segmentPhases(corrupt.value, [], stroke(0, 1010));
    const b = await seg.segmentPhases(clean.value, [], stroke(0, 1010));
    console.log("[VG-3] corrupt:", JSON.stringify(a), "\n[VG-3] clean:", JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VG-4 (adversary3 P2): GeometricPhaseSegmenter echoes window bounds beyond measured frames
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-4 GeometricPhaseSegmenter: outer spans extrapolate to the requested window", () => {
  const frames = framesFromSteps(bumpSteps(61, [30]));

  it("OBSERVED: window [0,60000] over a 1 s clip → recover.endMs === 60000", async () => {
    const result = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(
      frames,
      [],
      stroke(0, 60000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recover = result.value.find((s) => s.key === "recover")!;
    console.log("[VG-4] [0,60000] spans:", JSON.stringify(result.value));
    expect(recover.endMs).toBe(60000);
    expect(frames.at(-1)!.timestampMs).toBeLessThan(1001);
  });

  it("OBSERVED: window [-60000,60000] → ready.startMs === -60000", async () => {
    const result = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(
      frames,
      [],
      stroke(-60000, 60000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ready = result.value.find((s) => s.key === "ready")!;
    console.log("[VG-4] [-60000,60000] ready:", JSON.stringify(ready));
    expect(ready.startMs).toBe(-60000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VG-5 (adversary3 P3 candidate): O(n²) smoothing at imported-clip sizes
// (imported clips are capped at 60 s natively → 1800 frames @30fps, 3600 @60fps)
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-5 GeometricPhaseSegmenter: superlinear smoothing cost", () => {
  it("OBSERVED: timings at n=900/1800/3600 (log) — ratio n=3600/n=900 far above linear 4×", async () => {
    const time = async (n: number) => {
      const frames = framesFromSteps(bumpSteps(n, [Math.floor(n / 2)], { halfWidth: 12 }));
      const started = performance.now();
      const result = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(
        frames,
        [],
        stroke(0, n * (1000 / 60)),
      );
      expect(result.ok).toBe(true);
      return performance.now() - started;
    };
    await time(200);
    const t900 = await time(900);
    const t1800 = await time(1800);
    const t3600 = await time(3600);
    console.log(
      `[VG-5] segmentPhases ms: n=900 ${t900.toFixed(0)}, n=1800 ${t1800.toFixed(0)}, n=3600 ${t3600.toFixed(0)}, ratio3600/900=${(t3600 / t900).toFixed(1)}`,
    );
    expect(t3600 / t900).toBeGreaterThan(8);
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// P3 spot-checks (deferred candidates) — confirm they reproduce at all
// ─────────────────────────────────────────────────────────────────────────────
describe("P3 spot-checks", () => {
  it("RecordedTriggerStrokeDetector accepts NaN / +Infinity bounds as ok([event])", async () => {
    const mk = (startMs: number, endMs: number) =>
      new RecordedTriggerStrokeDetector({
        triggerModelVersion: "adj",
        startMs,
        endMs,
        peakMotionMs: null,
        confidence: 0.9,
      });
    const nan = await mk(Number.NaN, 1000).detectStrokes(CLIP);
    const inf = await mk(1000, Number.POSITIVE_INFINITY).detectStrokes(CLIP);
    console.log("[P3] NaN start ok:", nan.ok, "+Inf end ok:", inf.ok);
    expect(nan.ok).toBe(true);
    expect(inf.ok).toBe(true);
  });

  it("landmark() returns a NaN-visibility landmark instead of null", () => {
    const mark = landmark(wristFrame(0, 0.5, 0.5, { visibility: Number.NaN }), "right_wrist", 1);
    console.log("[P3] NaN visibility landmark:", JSON.stringify(mark));
    expect(mark).not.toBeNull();
  });

  it("pathLength counts displacement across dt=0 duplicate-timestamp pairs", () => {
    const base = framesFromSteps(bumpSteps(61, [30]));
    const dup = [...base];
    for (let i = 35; i >= 25; i -= 1) {
      const f = base[i]!;
      dup.splice(i + 1, 0, { ...f, landmarks: f.landmarks.map((m) => ({ ...m, x: m.x + 0.05 })) });
    }
    const clean = pathLength(base, "right_wrist", 0, 1010, 1);
    const inflated = pathLength(dup, "right_wrist", 0, 1010, 1);
    console.log("[P3] pathLength clean", clean, "with duplicates", inflated);
    expect(inflated).toBeGreaterThan(clean * 2);
  });

  it("evaluateFrameAnalyzability passes durationMs 0 / -1 with analyzable=true", () => {
    const stats = (durationMs: number): FrameStats => ({
      frameCount: 60,
      durationMs,
      width: 100,
      height: 100,
      interFrameDiffs: Array.from({ length: 59 }, () => 5),
      spatialLumaStd: Array.from({ length: 60 }, () => 40),
      letterboxRowFraction: 0,
    });
    const zero = evaluateFrameAnalyzability(stats(0));
    const negative = evaluateFrameAnalyzability(stats(-1));
    console.log(
      "[P3] duration 0 →",
      JSON.stringify(zero),
      "\n[P3] duration -1 →",
      JSON.stringify(negative),
    );
    expect(zero.analyzable).toBe(true);
    expect(negative.analyzable).toBe(true);
  });

  it("one NaN frame.confidence → all six spans confidence NaN while ok", async () => {
    const frames = framesFromSteps(bumpSteps(61, [30]));
    frames[10] = { ...frames[10]!, confidence: Number.NaN };
    const result = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(
      frames,
      [],
      stroke(0, 1010),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    console.log(
      "[P3] span confidences:",
      result.value.map((s) => s.confidence),
    );
    expect(result.value.every((s) => Number.isNaN(s.confidence))).toBe(true);
  });
});
