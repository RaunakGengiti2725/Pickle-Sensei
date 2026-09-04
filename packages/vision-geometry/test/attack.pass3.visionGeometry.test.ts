import { describe, expect, it } from "vitest";
import { facingFlipAtContactFixture, generateSwingSequence } from "@pickle/evaluation";
import type { PoseSequence } from "@pickle/swing-domain";
import {
  RecordedTriggerStrokeDetector,
  assessPaddleTrackIdentity,
  classifyStroke,
  type HeuristicPaddleObservation,
  type HeuristicStrokePrediction,
} from "../src/index.js";

/**
 * ADVERSARIAL PASS 3 — pkg-vision-geometry (attack tests, new files only).
 *
 * Every `it` is an executable attack against the abstention contract of the
 * geometry package: invalid/degenerate/corrupt inputs must fail typed or
 * abstain (UNKNOWN / undetermined) with a stated limiting factor — never a
 * confident side, never an empty ok([]), never a NaN carried into a verdict.
 *
 * Tests marked `it.fails` are REPRODUCED DEFECTS at the audited revision: the
 * assertion body states the expected safe behaviour, vitest passes the case
 * only while the defect persists. When production is fixed the case starts
 * failing — drop the `.fails` modifier then.
 */

const CLIP = {
  uri: "attack://clip",
  durationMs: 5000,
  width: 1080,
  height: 1920,
  fps: 60,
} as const;

function trigger(startMs: number, endMs: number) {
  return new RecordedTriggerStrokeDetector({
    triggerModelVersion: "attack-trigger-1",
    startMs,
    endMs,
    peakMotionMs: null,
    confidence: 0.9,
  });
}

function paddleAt(
  x: number,
  y: number,
  contactMs: number,
  confidence?: number,
): HeuristicPaddleObservation[] {
  return Array.from({ length: 11 }, (_, index) => ({
    timestampMs: contactMs - 200 + index * 40,
    center: { x, y },
    ...(confidence === undefined ? {} : { confidence }),
  }));
}

/** Copy of a sequence with a landmark's visibility rewritten by predicate. */
function withVisibility(
  sequence: PoseSequence,
  landmarkName: string,
  visibility: number,
  frameMatches: (timestampMs: number) => boolean = () => true,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      frameMatches(frame.timestampMs)
        ? {
            ...frame,
            landmarks: frame.landmarks.map((mark) =>
              mark.name === landmarkName ? { ...mark, visibility } : mark,
            ),
          }
        : frame,
    ),
  };
}

function committedSide(prediction: HeuristicStrokePrediction): boolean {
  return prediction.label === "FOREHAND" || prediction.label === "BACKHAND";
}

// ─────────────────────────────────────────────────────────────────────────────
// S1 — RecordedTriggerStrokeDetector.detectStrokes window bounds
// ─────────────────────────────────────────────────────────────────────────────
describe("S1 RecordedTriggerStrokeDetector.detectStrokes rejects empty/inverted windows", () => {
  it("startMs > endMs → typed failure, never ok([])", async () => {
    const result = await trigger(2000, 1000).detectStrokes(CLIP);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.failure.code).toBe("stroke.invalid_recorded_window");
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.message.length).toBeGreaterThan(0);
  });

  it("startMs === endMs → typed failure, never ok([])", async () => {
    const result = await trigger(1500, 1500).detectStrokes(CLIP);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.failure.code).toBe("stroke.invalid_recorded_window");
  });

  it("startMs === endMs === 0 (zero-length at origin) → typed failure", async () => {
    const result = await trigger(0, 0).detectStrokes(CLIP);
    expect(result.ok).toBe(false);
  });

  it("negative-span with negative timestamps (clock skew) → typed failure", async () => {
    const result = await trigger(-100, -200).detectStrokes(CLIP);
    expect(result.ok).toBe(false);
  });

  it("rapid interleaved repeats: 200 concurrent calls on one detector are all identical typed failures (stateless)", async () => {
    const detector = trigger(900, 800);
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        detector.detectStrokes({ ...CLIP, uri: `attack://clip-${index}` }),
      ),
    );
    expect(results.every((result) => !result.ok)).toBe(true);
    const codes = new Set(results.map((result) => (result.ok ? "ok" : result.failure.code)));
    expect([...codes]).toEqual(["stroke.invalid_recorded_window"]);
  });

  it("valid window still yields exactly one event (control — the guard is not over-broad)", async () => {
    const result = await trigger(1000, 1600).detectStrokes(CLIP);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.startMs).toBe(1000);
    expect(result.value[0]!.endMs).toBe(1600);
  });

  it("1ms window (smallest legal span) is accepted, not rejected", async () => {
    const result = await trigger(1000, 1001).detectStrokes(CLIP);
    expect(result.ok).toBe(true);
  });

  // REPRODUCED DEFECT (P3): `endMs <= startMs` is the only guard, so a
  // non-finite bound (NaN from a failed parse / clock read) compares false
  // and the detector returns ok([{startMs: NaN, ...}]) — an event whose
  // window cannot be consumed by any downstream stage.
  it.fails("NaN startMs → typed failure (non-finite window is not a window)", async () => {
    const result = await trigger(Number.NaN, 1000).detectStrokes(CLIP);
    expect(result.ok).toBe(false);
  });

  it.fails("NaN endMs → typed failure", async () => {
    const result = await trigger(1000, Number.NaN).detectStrokes(CLIP);
    expect(result.ok).toBe(false);
  });

  it.fails("+Infinity endMs → typed failure", async () => {
    const result = await trigger(1000, Number.POSITIVE_INFINITY).detectStrokes(CLIP);
    expect(result.ok).toBe(false);
  });

  it("observed: non-finite bounds leak into the emitted StrokeEvent (evidence for the P3 above)", async () => {
    const nan = await trigger(Number.NaN, 1000).detectStrokes(CLIP);
    expect(nan.ok).toBe(true);
    if (!nan.ok) throw new Error("unreachable");
    expect(Number.isNaN(nan.value[0]!.startMs)).toBe(true);
    const inf = await trigger(1000, Number.POSITIVE_INFINITY).detectStrokes(CLIP);
    expect(inf.ok).toBe(true);
    if (!inf.ok) throw new Error("unreachable");
    expect(inf.value[0]!.endMs).toBe(Number.POSITIVE_INFINITY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2 — assessPaddleTrackIdentity: anti-correlated paddle, 7 aligned pairs
// ─────────────────────────────────────────────────────────────────────────────
const TORSO = 0.2;

/** Track along +x whose consecutive-step speeds (torso/s) equal `speeds`. */
function trackFromSpeeds(
  startMs: number,
  stepMs: number,
  speeds: readonly number[],
  base = { x: 0.2, y: 0.6 },
) {
  const points = [{ timestampMs: startMs, x: base.x, y: base.y }];
  for (const [index, speed] of speeds.entries()) {
    const previous = points[index]!;
    points.push({
      timestampMs: previous.timestampMs + stepMs,
      x: previous.x + ((speed * TORSO) / 1000) * stepMs,
      y: previous.y,
    });
  }
  return points;
}

function gaussian(tMs: number, centerMs: number, sigmaMs: number): number {
  return Math.exp(-((tMs - centerMs) ** 2) / (2 * sigmaMs * sigmaMs));
}

describe("S2 assessPaddleTrackIdentity with only 7 aligned pairs", () => {
  // Wrist swings (speed profile gaussian, peak 4 torso/s at ~1000ms), sampled
  // every 30ms over 0..2000ms.
  const WRIST_STEP = 30;
  const wristSpeeds = Array.from(
    { length: 66 },
    (_, index) => 4 * gaussian(index * WRIST_STEP + WRIST_STEP / 2, 1000, 80),
  );
  const wrist = trackFromSpeeds(0, WRIST_STEP, wristSpeeds, { x: 0.2, y: 0.6 });

  it("literal scenario: perfectly anti-correlated over exactly 7 aligned pairs (8 paddle points @30ms) → undetermined, synchrony unmeasured", () => {
    // Paddle speed_i = 4 − wristSpeed(t_i) at the 7 paddle sample midpoints
    // (r = −1 exactly if the correlation were computed).
    const paddleStart = 900;
    const paddleSpeeds = Array.from({ length: 7 }, (_, index) => {
      const midpoint = paddleStart + index * WRIST_STEP + WRIST_STEP / 2;
      return 4 - 4 * gaussian(midpoint, 1000, 80);
    });
    const paddle = trackFromSpeeds(paddleStart, WRIST_STEP, paddleSpeeds, { x: 0.7, y: 0.5 });
    expect(paddle).toHaveLength(8);
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(assessment.evidence.paddleSpeedSamples).toBe(7);
    expect(assessment.evidence.targetSynchrony).toBeNull();
    expect(assessment.verdict).toBe("undetermined");
    expect(assessment.verdict).not.toBe("foreign");
    expect(assessment.evidence.notes.length).toBeGreaterThan(0);
  });

  it("control: the same anti-correlation with 8 aligned pairs measures r ≈ −1 (the ≥8 floor is what suppressed it)", () => {
    const paddleStart = 880;
    const paddleSpeeds = Array.from({ length: 8 }, (_, index) => {
      const midpoint = paddleStart + index * WRIST_STEP + WRIST_STEP / 2;
      return 4 - 4 * gaussian(midpoint, 1000, 80);
    });
    const paddle = trackFromSpeeds(paddleStart, WRIST_STEP, paddleSpeeds, { x: 0.7, y: 0.5 });
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(assessment.evidence.paddleSpeedSamples).toBe(8);
    expect(assessment.evidence.targetSynchrony).not.toBeNull();
    expect(assessment.evidence.targetSynchrony!).toBeLessThan(-0.9);
    expect(assessment.verdict).not.toBe("target_consistent");
  });

  // REPRODUCED (P3, documented-invariant mismatch): paddleTrackIdentity.ts
  // L333-334 says "every element measured … any unmeasured element →
  // undetermined, never foreign", but L346 admits `targetSynchrony === null`.
  // A 7-pair anti-correlated paddle whose activity peaks contradict the
  // target's is called FOREIGN with synchrony unmeasured.
  it.fails(
    "7 aligned pairs, anti-correlated with separated activity peaks → undetermined (synchrony unmeasured must block foreign)",
    () => {
      const paddleStart = 350;
      const step = 100;
      const paddleSpeeds = Array.from({ length: 7 }, (_, index) => {
        const midpoint = paddleStart + index * step + step / 2;
        return 4 - 4 * gaussian(midpoint, 1000, 80);
      });
      const paddle = trackFromSpeeds(paddleStart, step, paddleSpeeds, { x: 0.7, y: 0.5 });
      const assessment = assessPaddleTrackIdentity({
        paddleCenters: paddle,
        targetWristTracks: [wrist],
        aspect: 1,
        torsoSpan: TORSO,
      });
      expect(assessment.evidence.paddleSpeedSamples).toBe(7);
      expect(assessment.evidence.targetSynchrony).toBeNull();
      expect(assessment.verdict).toBe("undetermined");
    },
  );

  it("observed: the 7-pair peak-contradiction path returns foreign with targetSynchrony null (evidence for the P3 above)", () => {
    const paddleStart = 350;
    const step = 100;
    const paddleSpeeds = Array.from({ length: 7 }, (_, index) => {
      const midpoint = paddleStart + index * step + step / 2;
      return 4 - 4 * gaussian(midpoint, 1000, 80);
    });
    const paddle = trackFromSpeeds(paddleStart, step, paddleSpeeds, { x: 0.7, y: 0.5 });
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(assessment.verdict).toBe("foreign");
    expect(assessment.evidence.targetSynchrony).toBeNull();
    expect(assessment.evidence.peakSeparationMs!).toBeGreaterThanOrEqual(250);
  });

  it("rapid repeats: 100 identical calls are deterministic (pure function)", () => {
    const paddle = trackFromSpeeds(900, WRIST_STEP, [3, 2, 1, 0.5, 1, 2, 3], { x: 0.7, y: 0.5 });
    const first = JSON.stringify(
      assessPaddleTrackIdentity({
        paddleCenters: paddle,
        targetWristTracks: [wrist],
        aspect: 1,
        torsoSpan: TORSO,
      }),
    );
    for (let index = 0; index < 100; index += 1) {
      const again = JSON.stringify(
        assessPaddleTrackIdentity({
          paddleCenters: [...paddle].reverse(),
          targetWristTracks: [[...wrist].reverse()],
          aspect: 1,
          torsoSpan: TORSO,
        }),
      );
      expect(again).toBe(first);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 — assessPaddleTrackIdentity torsoSpan 0 / NaN / -0.1
// ─────────────────────────────────────────────────────────────────────────────
describe("S3 assessPaddleTrackIdentity invalid torsoSpan", () => {
  const wrist = trackFromSpeeds(
    0,
    30,
    Array.from({ length: 60 }, () => 3),
  );
  const paddle = trackFromSpeeds(
    0,
    30,
    Array.from({ length: 60 }, () => 3),
    { x: 0.3, y: 0.5 },
  );

  for (const torsoSpan of [0, Number.NaN, -0.1, Number.NEGATIVE_INFINITY, -0]) {
    it(`torsoSpan ${String(torsoSpan)} → undetermined with a stated limiting factor`, () => {
      const assessment = assessPaddleTrackIdentity({
        paddleCenters: paddle,
        targetWristTracks: [wrist],
        aspect: 1,
        torsoSpan,
      });
      expect(assessment.verdict).toBe("undetermined");
      expect(assessment.evidence.notes.length).toBeGreaterThan(0);
      expect(assessment.evidence.notes.some((note) => /torso/i.test(note))).toBe(true);
      expect(assessment.evidence.paddleSpeedSamples).toBe(0);
      expect(assessment.evidence.paddlePeak).toBeNull();
      expect(assessment.evidence.targetSynchrony).toBeNull();
    });
  }

  it("torsoSpan +Infinity → undetermined (all speeds collapse to 0) and never foreign", () => {
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: Number.POSITIVE_INFINITY,
    });
    expect(assessment.verdict).toBe("undetermined");
    expect(assessment.evidence.notes.length).toBeGreaterThan(0);
  });

  it("torsoSpan 5e-324 (denormal → speeds overflow to Infinity) never yields a foreign/target_consistent verdict", () => {
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: 5e-324,
    });
    expect(assessment.verdict).toBe("undetermined");
    // Observed: the evidence carries a non-finite peak (Infinity torso/s) —
    // JSON-serializes to null. Recorded, not asserted as a defect: the input
    // is not a physically reachable torso span.
    expect(assessment.evidence.paddlePeak).not.toBeNull();
    expect(Number.isFinite(assessment.evidence.paddlePeak!.torsoPerSec)).toBe(false);
    expect(() => JSON.parse(JSON.stringify(assessment))).not.toThrow();
  });

  it("aspect NaN → never foreign, never target_consistent (NaN speeds cannot support a verdict)", () => {
    const assessment = assessPaddleTrackIdentity({
      paddleCenters: paddle,
      targetWristTracks: [wrist],
      aspect: Number.NaN,
      torsoSpan: TORSO,
    });
    expect(assessment.verdict).toBe("undetermined");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S4 — facing consensus across a one-frame shoulder crossing at contact
// ─────────────────────────────────────────────────────────────────────────────
describe("S4 classifyStroke facing consensus vs one-frame shoulder crossing", () => {
  const fixture = facingFlipAtContactFixture();
  const frameMs = 1000 / 60; // generator runs at 60fps
  const contactMs = fixture.window.peakMs;

  function classifyAt(referenceMs: number, sequence: PoseSequence = fixture.sequence) {
    return classifyStroke({
      sequence,
      window: { startMs: fixture.window.startMs, endMs: fixture.window.endMs },
      contactMs: referenceMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: fixture.wristSpeeds,
    });
  }

  it("precondition: exactly one frame (the contact frame) has inverted shoulder order", () => {
    const inverted = fixture.sequence.frames.filter((frame) => {
      const left = frame.landmarks.find((mark) => mark.name === "left_shoulder")!;
      const right = frame.landmarks.find((mark) => mark.name === "right_shoulder")!;
      return right.x < left.x;
    });
    expect(inverted).toHaveLength(1);
    expect(Math.abs(inverted[0]!.timestampMs - contactMs)).toBeLessThanOrEqual(15);
  });

  it("side is FOREHAND and stable at contactMs − 1 frame, contactMs, contactMs + 1 frame", () => {
    const labels = [-frameMs, 0, frameMs].map((delta) => classifyAt(contactMs + delta));
    for (const prediction of labels) {
      expect(prediction.label).toBe("FOREHAND");
      expect(prediction.taxonomyDepth).toBe(2);
    }
    const atContact = classifyAt(contactMs);
    expect(atContact.limitingFactors).toContain("facing_sign_at_reference_overridden_by_consensus");
    expect(labels[0]!.limitingFactors).not.toContain(
      "facing_sign_at_reference_overridden_by_consensus",
    );
  });

  it("sweep: every reference within contactMs ± 1 frame in 1ms steps keeps the same side", () => {
    const labels = new Set<string>();
    for (let delta = -Math.floor(frameMs); delta <= Math.floor(frameMs); delta += 1) {
      labels.add(classifyAt(contactMs + delta).label);
    }
    expect([...labels]).toEqual(["FOREHAND"]);
  });

  it("the crossing frame never changes the label: ±3 frames in 1ms steps, flipped vs un-flipped sequence agree at every reference", () => {
    // Control: the identical swing WITHOUT the shoulder flip. Any label the
    // flipped fixture yields that the clean sequence does not is a facing
    // artefact. (The clean swing itself crosses the midline ~3 frames before
    // contact, so BACKHAND/UNKNOWN there is geometry, not facing.)
    const clean = generateSwingSequence();
    expect(clean.window.peakMs).toBe(contactMs);
    for (let delta = -3 * frameMs; delta <= 3 * frameMs; delta += 1) {
      const flipped = classifyAt(contactMs + delta);
      const control = classifyAt(contactMs + delta, clean.sequence);
      expect(flipped.label, `delta ${delta.toFixed(1)}ms`).toBe(control.label);
    }
  });

  it("wide crossing (shoulders fully swapped, separation 0.14u) at contact only → consensus still wins", () => {
    const { sequence, window } = generateSwingSequence();
    const swapped: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) => {
        if (Math.abs(frame.timestampMs - window.peakMs) > 8) return frame;
        const left = frame.landmarks.find((mark) => mark.name === "left_shoulder")!;
        const right = frame.landmarks.find((mark) => mark.name === "right_shoulder")!;
        return {
          ...frame,
          landmarks: frame.landmarks.map((mark) =>
            mark.name === "left_shoulder"
              ? { ...mark, x: right.x }
              : mark.name === "right_shoulder"
                ? { ...mark, x: left.x }
                : mark,
          ),
        };
      }),
    };
    const at = classifyStroke({
      sequence: swapped,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(at.label).toBe("FOREHAND");
    expect(at.limitingFactors).toContain("facing_sign_at_reference_overridden_by_consensus");
  });

  it("three consecutive crossed frames centered on contact → consensus (22/25 rear) still holds the side", () => {
    const { sequence, window } = generateSwingSequence();
    const crossed: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) => {
        if (Math.abs(frame.timestampMs - window.peakMs) > frameMs + 1) return frame;
        return {
          ...frame,
          landmarks: frame.landmarks.map((mark) =>
            mark.name === "left_shoulder"
              ? { ...mark, x: 0.52 }
              : mark.name === "right_shoulder"
                ? { ...mark, x: 0.48 }
                : mark,
          ),
        };
      }),
    };
    for (const delta of [-frameMs, 0, frameMs]) {
      const prediction = classifyStroke({
        sequence: crossed,
        window: { startMs: window.startMs, endMs: window.endMs },
        contactMs: window.peakMs + delta,
        handedness: "right",
        paddle: null,
        paddleSpeeds: null,
        wristSpeeds: null,
      });
      expect(prediction.label).toBe("FOREHAND");
    }
  });

  it("when the crossing dominates (>1/3 of votes inverted) the classifier degrades instead of flipping to BACKHAND", () => {
    const { sequence, window } = generateSwingSequence();
    // Invert 11 of the 25 voting frames (±200ms @60fps): 14/25 = 0.56 < 2/3
    // both ways → no consensus; nearest frame (inverted) decides, degraded.
    const crossed: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) => {
        if (Math.abs(frame.timestampMs - window.peakMs) > 5 * frameMs + 1) return frame;
        const left = frame.landmarks.find((mark) => mark.name === "left_shoulder")!;
        const right = frame.landmarks.find((mark) => mark.name === "right_shoulder")!;
        return {
          ...frame,
          landmarks: frame.landmarks.map((mark) =>
            mark.name === "left_shoulder"
              ? { ...mark, x: right.x }
              : mark.name === "right_shoulder"
                ? { ...mark, x: left.x }
                : mark,
          ),
        };
      }),
    };
    const prediction = classifyStroke({
      sequence: crossed,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    // Documented behaviour: single-frame fallback, capped confidence.
    if (committedSide(prediction)) {
      expect(prediction.limitingFactors).toContain(
        "facing_consensus_unavailable_single_frame_shoulder_order",
      );
      expect(prediction.confidence).toBeLessThanOrEqual(0.6);
    } else {
      expect(prediction.label).toBe("UNKNOWN");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S5 — corrupt paddle centers ({x:NaN,y:0.5}, {x:5,y:-3})
// ─────────────────────────────────────────────────────────────────────────────
describe("S5 classifyStroke with corrupt paddle centers", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs };

  for (const center of [
    { x: Number.NaN, y: 0.5 },
    { x: 5, y: -3 },
    { x: 0.5, y: Number.NaN },
    { x: Number.POSITIVE_INFINITY, y: 0.5 },
    { x: -7, y: 0.5 },
  ]) {
    it(`center ${JSON.stringify(center)} with a visible wrist → wrist fallback (contactPointSource 'wrist'), never a paddle-sourced contact`, () => {
      const prediction = classifyStroke({
        sequence,
        window: windowArg,
        contactMs: window.peakMs,
        handedness: "right",
        paddle: paddleAt(center.x, center.y, window.peakMs, 0.9),
        paddleSpeeds: null,
        wristSpeeds: null,
      });
      expect(prediction.contactPointSource).toBe("wrist");
      expect(prediction.limitingFactors).toContain("paddle_point_implausible_used_wrist");
      expect(prediction.label).not.toBe("OVERHEAD");
      expect(Number.isFinite(prediction.confidence)).toBe(true);
      // Reliability is decided by the WRIST's visibility (0.95 here) — the
      // paddle corruption is recorded as a limiting factor, not as
      // reliability. Pinned so a change in that policy is visible.
      expect(prediction.contactPointReliability).toBe("strong");
    });

    it(`center ${JSON.stringify(center)} with a LOW-visibility wrist (0.3) at contact → wrist fallback AND degraded reliability`, () => {
      const dim = withVisibility(
        sequence,
        "right_wrist",
        0.3,
        (t) => Math.abs(t - window.peakMs) <= 8,
      );
      const prediction = classifyStroke({
        sequence: dim,
        window: windowArg,
        contactMs: window.peakMs,
        handedness: "right",
        paddle: paddleAt(center.x, center.y, window.peakMs, 0.9),
        paddleSpeeds: null,
        wristSpeeds: null,
      });
      expect(prediction.contactPointSource).toBe("wrist");
      expect(prediction.contactPointReliability).toBe("degraded");
      expect(prediction.limitingFactors).toContain("paddle_point_implausible_used_wrist");
      expect(prediction.limitingFactors).toContain("wrist_low_visibility_at_contact");
      expect(Number.isFinite(prediction.confidence)).toBe(true);
    });
  }

  // REPRODUCED DEFECT (P1): when the dominant wrist is NOT measured at the
  // contact frame (visibility < 0.25) and the paddle track is "trusted"
  // (confidence ≥ 0.3), strokeHeuristicLite.ts L597-604 adopts the paddle
  // center WITHOUT any finiteness/range check. A {x:NaN} center flows into
  // offset (L871) → NaN sideMargin → every abstention comparison is false →
  // the classifier COMMITS "BACKHAND" with confidence NaN.
  it.fails(
    "{x:NaN,y:0.5} with the wrist invisible at contact → UNKNOWN with a limiting factor (never a committed side)",
    () => {
      const blind = withVisibility(
        sequence,
        "right_wrist",
        0.1,
        (t) => Math.abs(t - window.peakMs) <= 8,
      );
      const prediction = classifyStroke({
        sequence: blind,
        window: windowArg,
        contactMs: window.peakMs,
        handedness: "right",
        paddle: paddleAt(Number.NaN, 0.5, window.peakMs, 0.9),
        paddleSpeeds: null,
        wristSpeeds: null,
      });
      expect(committedSide(prediction)).toBe(false);
      expect(Number.isFinite(prediction.confidence)).toBe(true);
    },
  );

  it("observed: NaN paddle center + wrist invisible at contact → committed BACKHAND with NaN confidence (evidence for the P1 above)", () => {
    const blind = withVisibility(
      sequence,
      "right_wrist",
      0.1,
      (t) => Math.abs(t - window.peakMs) <= 8,
    );
    const prediction = classifyStroke({
      sequence: blind,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(Number.NaN, 0.5, window.peakMs, 0.9),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("BACKHAND");
    expect(prediction.contactPointSource).toBe("paddle");
    expect(Number.isNaN(prediction.confidence)).toBe(true);
  });

  // REPRODUCED DEFECT (P2): same unverified-plausibility branch, but an
  // out-of-image center {x:5,y:0.5} (normalized coords must lie in [0,1])
  // is accepted as the contact point and yields a committed side ~32
  // shoulder-widths off the midline at the degraded cap.
  it.fails(
    "{x:5,y:0.5} (outside the image) with the wrist invisible at contact → UNKNOWN, not a committed side",
    () => {
      const blind = withVisibility(
        sequence,
        "right_wrist",
        0.1,
        (t) => Math.abs(t - window.peakMs) <= 8,
      );
      const prediction = classifyStroke({
        sequence: blind,
        window: windowArg,
        contactMs: window.peakMs,
        handedness: "right",
        paddle: paddleAt(5, 0.5, window.peakMs, 0.9),
        paddleSpeeds: null,
        wristSpeeds: null,
      });
      expect(committedSide(prediction)).toBe(false);
    },
  );

  it("observed: {x:5,y:0.5} + invisible wrist → committed FOREHAND from a point 30+ shoulder-widths outside the frame (evidence for the P2 above)", () => {
    const blind = withVisibility(
      sequence,
      "right_wrist",
      0.1,
      (t) => Math.abs(t - window.peakMs) <= 8,
    );
    const prediction = classifyStroke({
      sequence: blind,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(5, 0.5, window.peakMs, 0.9),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.contactPointSource).toBe("paddle");
    expect(prediction.limitingFactors).toContain("paddle_plausibility_unverified_wrist_invisible");
  });

  it("{x:5,y:-3} with the wrist invisible at contact → abstains (skeleton-quiet OVERHEAD contradiction catches it)", () => {
    const blind = withVisibility(
      sequence,
      "right_wrist",
      0.1,
      (t) => Math.abs(t - window.peakMs) <= 8,
    );
    const prediction = classifyStroke({
      sequence: blind,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(5, -3, window.peakMs, 0.9),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(committedSide(prediction)).toBe(false);
    expect(prediction.label).toBe("UNKNOWN");
  });

  it("paddle observation with NaN timestamp is never selected as the near-contact observation", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: [{ timestampMs: Number.NaN, center: { x: 0.9, y: 0.1 }, confidence: 0.9 }],
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.contactPointSource).toBe("wrist");
    expect(prediction.limitingFactors).toContain("paddle_not_tracked_at_contact");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S6 — handedness 'left' vs a right-wrist swing with the left wrist unseen
// ─────────────────────────────────────────────────────────────────────────────
describe("S6 classifyStroke handedness cross-check (declared left, right wrist swings)", () => {
  const { sequence, window } = generateSwingSequence(); // right-hand swing
  const windowArg = { startMs: window.startMs, endMs: window.endMs };

  it("left wrist visibility 0 for the whole window → abstains (no mirrored side)", () => {
    const blindLeft = withVisibility(sequence, "left_wrist", 0);
    const prediction = classifyStroke({
      sequence: blindLeft,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "left",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(committedSide(prediction)).toBe(false);
    // With the declared wrist NEVER measured, the earlier attribution gate
    // (rival unmeasured) fires before the handedness cross-check can — the
    // abstention is still explicit and names the unmeasured rival.
    expect(prediction.limitingFactors).toContain(
      "dominant_wrist_attribution_unverifiable_rival_unmeasured",
    );
    expect(prediction.evidence.some((line) => line.includes("0 measured frames"))).toBe(true);
  });

  it("left wrist dimly visible (0.3) but static while the right wrist swings → abstains via the handedness cross-check", () => {
    const dimLeft = withVisibility(sequence, "left_wrist", 0.3);
    const prediction = classifyStroke({
      sequence: dimLeft,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "left",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "declared_handedness_contradicted_by_dominant_motion_wrist",
    );
  });

  it("left wrist visible in only 2 frames (sparse) → abstains via the sparse-declared-wrist gate", () => {
    let seen = 0;
    const sparse: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) => {
        const near = Math.abs(frame.timestampMs - window.peakMs) <= 200;
        const keep = near && seen < 2;
        if (keep) seen += 1;
        return {
          ...frame,
          landmarks: frame.landmarks.map((mark) =>
            mark.name === "left_wrist" ? { ...mark, visibility: keep ? 0.9 : 0 } : mark,
          ),
        };
      }),
    };
    const prediction = classifyStroke({
      sequence: sparse,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "left",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain(
      "declared_wrist_too_sparsely_measured_under_handedness_contradiction",
    );
  });

  it("a trusted paddle riding the RIGHT wrist does not rescue the mirrored side under a LEFT declaration", () => {
    const dimLeft = withVisibility(sequence, "left_wrist", 0.3);
    const contactFrame = sequence.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs)
        ? frame
        : best,
    );
    const wrist = contactFrame.landmarks.find((mark) => mark.name === "right_wrist")!;
    const prediction = classifyStroke({
      sequence: dimLeft,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "left",
      paddle: paddleAt(wrist.x + 0.02, wrist.y - 0.02, window.peakMs, 0.95),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(committedSide(prediction)).toBe(false);
    expect(prediction.limitingFactors).toContain(
      "declared_handedness_contradicted_by_dominant_motion_wrist",
    );
  });

  it("control: the same fixture under the CORRECT (right) declaration commits FOREHAND", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("FOREHAND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S7 — degenerate window / contact outside the window
// ─────────────────────────────────────────────────────────────────────────────
describe("S7 classifyStroke window validity", () => {
  const { sequence, window } = generateSwingSequence();
  // Speed samples every 30ms, offset 7ms from the contact instant so a
  // zero-length window at contactMs contains NO sample.
  const wristSpeeds = Array.from({ length: 20 }, (_, index) => ({
    timestampMs: window.peakMs - 300 + index * 30 + 7,
    value: 1.8,
  }));

  // REPRODUCED DEFECT (P2): classifyStroke never validates `window`. The
  // window is consulted only to filter speed samples (L518-521, L931-934);
  // a zero-length window therefore filters EVERY sample out and the
  // classifier still commits a side, reporting "speed peak 0.00 u/s (slow
  // swing)" as evidence from zero in-window samples.
  it.fails("window.startMs === window.endMs → UNKNOWN with a limiting factor, not a side", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.peakMs, endMs: window.peakMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds,
    });
    expect(committedSide(prediction)).toBe(false);
    expect(prediction.limitingFactors.length).toBeGreaterThan(0);
  });

  it("observed: zero-length window → committed FOREHAND with a 0.00 u/s 'slow swing' evidence line from 0 in-window samples (evidence for the P2 above)", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.peakMs, endMs: window.peakMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds,
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.evidence.some((line) => line.includes("speed peak 0.00 u/s"))).toBe(true);
    expect(
      prediction.limitingFactors.some((factor) => /window/i.test(factor) && !/bounce/.test(factor)),
    ).toBe(false);
  });

  it.fails("inverted window (startMs > endMs) → UNKNOWN with a limiting factor, not a side", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.endMs, endMs: window.startMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds,
    });
    expect(committedSide(prediction)).toBe(false);
  });

  // REPRODUCED DEFECT (P2): a contact reference OUTSIDE the declared event
  // window is classified as if it were inside — no `contactMs ∈ [start,end]`
  // check exists, so a mis-associated trigger/contact pair yields a
  // confident side for a moment the window never covered.
  it.fails(
    "contactMs outside the window (window covers only the ready phase) → UNKNOWN with a limiting factor",
    () => {
      const prediction = classifyStroke({
        sequence,
        window: { startMs: 0, endMs: 300 }, // ready phase only; contact at 1100
        contactMs: window.peakMs,
        handedness: "right",
        paddle: null,
        paddleSpeeds: null,
        wristSpeeds: null,
      });
      expect(committedSide(prediction)).toBe(false);
      expect(prediction.limitingFactors.length).toBeGreaterThan(0);
    },
  );

  it("observed: contact 800ms after the window end is classified as FOREHAND with no window-related limiting factor (evidence for the P2 above)", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: 0, endMs: 300 },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.limitingFactors.some((factor) => /window|outside/i.test(factor))).toBe(false);
  });

  it("contactMs with no pose frame within 80ms (reference far outside the recording) → UNKNOWN no_pose_frame_near_contact", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.endMs + 5000,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("no_pose_frame_near_contact");
  });

  it("contactMs NaN → UNKNOWN (NaN never matches a frame)", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: Number.NaN,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("no_pose_frame_near_contact");
  });

  it("eventPeakMs ±Infinity with contactMs null → UNKNOWN", () => {
    for (const reference of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const prediction = classifyStroke({
        sequence,
        window: { startMs: window.startMs, endMs: window.endMs },
        contactMs: null,
        eventPeakMs: reference,
        handedness: "right",
        paddle: null,
        paddleSpeeds: null,
        wristSpeeds: null,
      });
      expect(prediction.label).toBe("UNKNOWN");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extras — huge inputs, corrupt frames, unicode landmark names
// ─────────────────────────────────────────────────────────────────────────────
describe("extras: robustness of classifyStroke to hostile sequences", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs };

  it("empty sequence → UNKNOWN no_pose_frame_near_contact", () => {
    const prediction = classifyStroke({
      sequence: { ...sequence, frames: [] },
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("no_pose_frame_near_contact");
  });

  it("frames with no landmarks at all → UNKNOWN torso_not_measured_at_contact", () => {
    const prediction = classifyStroke({
      sequence: {
        ...sequence,
        frames: sequence.frames.map((frame) => ({ ...frame, landmarks: [] })),
      },
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("torso_not_measured_at_contact");
  });

  it("unicode / non-canonical landmark names are dropped by the legacy projection → torso unmeasured, no side", () => {
    const renamed: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) => ({
          ...mark,
          name: `${mark.name}\u200b` as typeof mark.name, // zero-width space suffix
        })),
      })),
    };
    const prediction = classifyStroke({
      sequence: renamed,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.limitingFactors).toContain("torso_not_measured_at_contact");
  });

  it("frames in reverse order and duplicated → same label as the canonical order (no order dependence)", () => {
    const canonical = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    const shuffled: PoseSequence = {
      ...sequence,
      frames: [...sequence.frames].reverse(),
    };
    const reversed = classifyStroke({
      sequence: shuffled,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(reversed.label).toBe(canonical.label);
    expect(reversed.label).toBe("FOREHAND");
  });

  it("huge input: 120k-frame sequence (≈33 min @60fps) classifies in bounded time without throwing", () => {
    const step = 1000 / 60;
    const template = sequence.frames;
    const frames = Array.from({ length: 120_000 }, (_, index) => {
      const source = template[index % template.length]!;
      return { ...source, frameIndex: index, timestampMs: Math.round(index * step) };
    });
    const huge: PoseSequence = { ...sequence, frames };
    const started = performance.now();
    const prediction = classifyStroke({
      sequence: huge,
      window: { startMs: 0, endMs: 120_000 * step },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    const elapsedMs = performance.now() - started;
    expect(["FOREHAND", "BACKHAND", "UNKNOWN"]).toContain(prediction.label);
    expect(Number.isFinite(prediction.confidence)).toBe(true);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it("NaN landmark coordinates at the contact frame → no committed side, finite confidence", () => {
    const corrupt: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) =>
        Math.abs(frame.timestampMs - window.peakMs) <= 8
          ? {
              ...frame,
              landmarks: frame.landmarks.map((mark) =>
                mark.name === "right_wrist" ? { ...mark, x: Number.NaN } : mark,
              ),
            }
          : frame,
      ),
    };
    const prediction = classifyStroke({
      sequence: corrupt,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(committedSide(prediction)).toBe(false);
    expect(Number.isFinite(prediction.confidence)).toBe(true);
  });
});
