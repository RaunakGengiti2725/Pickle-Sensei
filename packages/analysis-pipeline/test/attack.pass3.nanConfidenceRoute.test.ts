import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { PoseSequence } from "@pickle/swing-domain";
import { classifyStroke, type HeuristicPaddleObservation } from "@pickle/vision-geometry";
import { AUTO_RESOLUTION_MIN_CONFIDENCE, resolvePredictedProfile } from "../src/index.js";

/**
 * ADVERSARIAL PASS 3 — cross-package consequence of the vision-geometry
 * NaN-paddle-center defect (see packages/vision-geometry/test/
 * attack.pass3.visionGeometry.test.ts, S5).
 *
 * `classifyStroke` commits a side with `confidence: NaN` when a corrupt
 * paddle center is adopted while the wrist is unmeasured at contact. The
 * auto-resolution floor is `prediction.confidence < 0.5`; NaN compares
 * false, so the floor does NOT abstain and the corrupt prediction becomes a
 * side route. Tests marked `it.fails` state the expected safe behaviour and
 * pass only while the defect persists.
 */

function paddleAt(x: number, y: number, contactMs: number): HeuristicPaddleObservation[] {
  return Array.from({ length: 11 }, (_, index) => ({
    timestampMs: contactMs - 200 + index * 40,
    center: { x, y },
    confidence: 0.9,
  }));
}

function blindWristAtContact(sequence: PoseSequence, contactMs: number): PoseSequence {
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

describe("NaN confidence must never pass the auto-resolution confidence floor", () => {
  const { sequence, window } = generateSwingSequence();
  const prediction = classifyStroke({
    sequence: blindWristAtContact(sequence, window.peakMs),
    window: { startMs: window.startMs, endMs: window.endMs },
    contactMs: window.peakMs,
    handedness: "right",
    paddle: paddleAt(Number.NaN, 0.5, window.peakMs),
    paddleSpeeds: null,
    wristSpeeds: null,
  });

  it("precondition: the classifier emitted a committed side with NaN confidence", () => {
    expect(prediction.label).toBe("BACKHAND");
    expect(Number.isNaN(prediction.confidence)).toBe(true);
    expect(prediction.confidence < AUTO_RESOLUTION_MIN_CONFIDENCE).toBe(false);
  });

  it.fails("resolvePredictedProfile abstains on a NaN-confidence prediction", () => {
    const resolution = resolvePredictedProfile(prediction);
    expect(resolution.kind).toBe("abstain");
  });

  it("observed: the NaN-confidence BACKHAND resolves to a side profile route (evidence)", () => {
    const resolution = resolvePredictedProfile(prediction);
    expect(resolution.kind).toBe("side");
    if (resolution.kind !== "side") throw new Error("unreachable");
    expect(resolution.side).toBe("BACKHAND");
  });

  it("control: an explicit confidence below the floor abstains", () => {
    const resolution = resolvePredictedProfile({ ...prediction, confidence: 0.49 });
    expect(resolution).toEqual({ kind: "abstain", reason: "auto_stroke_confidence_below_floor" });
  });
});
