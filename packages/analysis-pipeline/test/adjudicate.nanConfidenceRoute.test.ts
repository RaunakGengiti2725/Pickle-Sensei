import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { PoseSequence } from "@pickle/swing-domain";
import { classifyStroke, type HeuristicPaddleObservation } from "@pickle/vision-geometry";
import { AUTO_RESOLUTION_MIN_CONFIDENCE, resolvePredictedProfile } from "../src/index.js";

/**
 * ADJUDICATION — cross-package leg of VG-1 at 4d812e1a: a NaN-confidence
 * side prediction from classifyStroke passes resolvePredictedProfile's
 * confidence floor because `NaN < floor` is false.
 */

function blindAtContact(sequence: PoseSequence, contactMs: number): PoseSequence {
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

describe("VG-1 route leg: NaN confidence bypasses AUTO_RESOLUTION_MIN_CONFIDENCE", () => {
  const { sequence, window } = generateSwingSequence();
  const paddle: HeuristicPaddleObservation[] = Array.from({ length: 11 }, (_, index) => ({
    timestampMs: window.peakMs - 200 + index * 40,
    center: { x: Number.NaN, y: 0.5 },
    confidence: 0.9,
  }));
  const prediction = classifyStroke({
    sequence: blindAtContact(sequence, window.peakMs),
    window: { startMs: window.startMs, endMs: window.endMs },
    contactMs: window.peakMs,
    handedness: "right",
    paddle,
    paddleSpeeds: null,
    wristSpeeds: null,
  });

  it("OBSERVED: classifier output is BACKHAND with NaN confidence", () => {
    expect(prediction.label).toBe("BACKHAND");
    expect(Number.isNaN(prediction.confidence)).toBe(true);
  });

  it("OBSERVED: resolvePredictedProfile resolves a side route instead of abstaining", () => {
    const resolution = resolvePredictedProfile(prediction);
    console.log(
      "[VG-1 route] floor",
      AUTO_RESOLUTION_MIN_CONFIDENCE,
      "→",
      JSON.stringify(resolution),
    );
    expect(resolution.kind).toBe("side");
    if (resolution.kind === "side") expect(resolution.side).toBe("BACKHAND");
  });

  it("CONTROL: confidence just below the floor abstains", () => {
    const resolution = resolvePredictedProfile({
      ...prediction,
      confidence: AUTO_RESOLUTION_MIN_CONFIDENCE - 0.01,
    });
    expect(resolution).toEqual({ kind: "abstain", reason: "auto_stroke_confidence_below_floor" });
  });
});
