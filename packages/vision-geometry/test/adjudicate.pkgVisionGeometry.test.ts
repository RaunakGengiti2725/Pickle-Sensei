import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { PoseSequence } from "@pickle/swing-domain";
import {
  classifyStroke,
  type HeuristicPaddleObservation,
  type HeuristicStrokePrediction,
} from "../src/index.js";

/**
 * ADJUDICATION — pkg-vision-geometry at 4d812e1a (VG-1 / VG-1b).
 *
 * Adjudicator-authored reproductions, converted from "observed defect"
 * assertions into the DESIRED behaviour the acceptance criteria demand: a
 * paddle center must be finite and inside [0,1]² to be used as the contact
 * point. When it is not, the classifier either falls back to a measured wrist
 * or abstains — it never commits a side from an invalid point, and its
 * confidence is always finite in [0,1]. Every such prediction carries the
 * `paddle_center_invalid` limiting factor.
 */

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

function expectInvalidCenterHandled(prediction: HeuristicStrokePrediction): void {
  expect(Number.isFinite(prediction.confidence)).toBe(true);
  expect(prediction.confidence).toBeGreaterThanOrEqual(0);
  expect(prediction.confidence).toBeLessThanOrEqual(1);
  expect(prediction.limitingFactors).toContain("paddle_center_invalid");
  expect(prediction.contactPointSource).not.toBe("paddle");
}

// ─────────────────────────────────────────────────────────────────────────────
// VG-1 (adversary1 P1): NaN / infinite paddle center + wrist invisible
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-1 classifyStroke: non-finite paddle center with wrist unmeasured at contact", () => {
  const { sequence, window } = generateSwingSequence();
  const blind = withWristInvisibleAtContact(sequence, window.peakMs);

  it("NaN center → UNKNOWN with paddle_center_invalid, finite confidence", () => {
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
    expectInvalidCenterHandled(prediction);
    expect(prediction.label).toBe("UNKNOWN");
    expect(prediction.leaf).toBe("UNKNOWN");
    expect(prediction.contactPointSource).toBeNull();
  });

  it("{x:+Infinity} center → UNKNOWN with paddle_center_invalid (no side from an infinite point)", () => {
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
    expectInvalidCenterHandled(prediction);
    expect(prediction.label).toBe("UNKNOWN");
  });

  it("{y:-Infinity} center → UNKNOWN with paddle_center_invalid", () => {
    const prediction = classifyStroke({
      sequence: blind,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.8, Number.NEGATIVE_INFINITY, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expectInvalidCenterHandled(prediction);
    expect(prediction.label).toBe("UNKNOWN");
  });

  it("CONTROL: same NaN center with wrist VISIBLE → wrist used, finite confidence, paddle_center_invalid recorded", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(Number.NaN, 0.5, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expectInvalidCenterHandled(prediction);
    expect(prediction.contactPointSource).toBe("wrist");
    // Synthetic right-handed swing: contact wrist is well right of midline.
    expect(prediction.label).toBe("FOREHAND");
  });

  it("CONTROL: valid paddle center with wrist invisible still carries the (degraded) paddle point", () => {
    const prediction = classifyStroke({
      sequence: blind,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.8, 0.55, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.limitingFactors).not.toContain("paddle_center_invalid");
    expect(prediction.contactPointSource).toBe("paddle");
    expect(prediction.contactPointReliability).toBe("degraded");
    expect(Number.isFinite(prediction.confidence)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VG-1b (adversary1 P2): out-of-image paddle center (same branch)
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-1b classifyStroke: out-of-image paddle center with wrist unmeasured", () => {
  const { sequence, window } = generateSwingSequence();
  const blind = withWristInvisibleAtContact(sequence, window.peakMs);

  it("{x:5,y:0.5} → UNKNOWN with paddle_center_invalid (no side from a point outside [0,1]²)", () => {
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
    expectInvalidCenterHandled(prediction);
    expect(prediction.label).toBe("UNKNOWN");
  });

  it("{x:-7,y:0.5} → UNKNOWN with paddle_center_invalid (mirror)", () => {
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
    expectInvalidCenterHandled(prediction);
    expect(prediction.label).toBe("UNKNOWN");
  });

  it("{x:0.8,y:1.5} (below the image) → UNKNOWN with paddle_center_invalid", () => {
    const prediction = classifyStroke({
      sequence: blind,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.8, 1.5, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expectInvalidCenterHandled(prediction);
    expect(prediction.label).toBe("UNKNOWN");
  });
});
