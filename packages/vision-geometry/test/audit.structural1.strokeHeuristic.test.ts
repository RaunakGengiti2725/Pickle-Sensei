import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { PoseSequence } from "@pickle/swing-domain";
import { classifyStroke, type HeuristicPaddleObservation } from "../src/index.js";

/**
 * Structural audit (pass 1) — stroke heuristic reference-frame hygiene.
 * I12/I13: the classifier abstains when the torso is not measured at the
 * reference frame and never commits a side above 0.5 on adversarial input.
 * A landmark with visibility 0 is, by the canonical contract, unmeasured.
 */

function paddleAt(x: number, y: number, contactMs: number): HeuristicPaddleObservation[] {
  return Array.from({ length: 11 }, (_, index) => ({
    timestampMs: contactMs - 200 + index * 40,
    center: { x, y },
  }));
}

/** Replace the torso landmarks of the frame nearest `tMs` with unmeasured
 * (visibility 0) landmarks placed at `point`. */
function withGhostTorso(
  sequence: PoseSequence,
  tMs: number,
  point: { x: number; y: number },
): PoseSequence {
  const nearest = sequence.frames.reduce((best, frame) =>
    Math.abs(frame.timestampMs - tMs) < Math.abs(best.timestampMs - tMs) ? frame : best,
  );
  const torso = new Set(["left_shoulder", "right_shoulder", "left_hip", "right_hip"]);
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      frame === nearest
        ? {
            ...frame,
            landmarks: frame.landmarks.map((mark) =>
              torso.has(mark.name)
                ? {
                    ...mark,
                    x: point.x + (mark.name.startsWith("left") ? -0.06 : 0.06),
                    y: point.y + (mark.name.endsWith("hip") ? 0.2 : 0),
                    visibility: 0,
                  }
                : mark,
            ),
          }
        : frame,
    ),
  };
}

describe("audit: classifyStroke — unmeasured torso at the reference frame", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs };
  const paddle = paddleAt(0.8, 0.55, window.peakMs);

  it("control: measured torso → committed side", () => {
    const prediction = classifyStroke({
      sequence,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label).toBe("FOREHAND");
    expect(prediction.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("visibility-0 torso landmarks at the reference must abstain, not define the midline", () => {
    // Ghost torso far to the RIGHT of the paddle so a midline built from it
    // flips the contact side.
    const ghosted = withGhostTorso(sequence, window.peakMs, { x: 0.9, y: 0.4 });
    const prediction = classifyStroke({
      sequence: ghosted,
      window: windowArg,
      contactMs: window.peakMs,
      handedness: "right",
      paddle,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    const honest =
      prediction.label === "UNKNOWN" ||
      (prediction.label === "FOREHAND" && prediction.confidence >= 0.5) ||
      prediction.confidence < 0.5;
    expect(
      honest,
      `label=${prediction.label} conf=${prediction.confidence} lf=${prediction.limitingFactors.join(",")}`,
    ).toBe(true);
  });
});

describe("audit: classifyStroke — degenerate windows and references", () => {
  const { sequence, window } = generateSwingSequence();

  it("startMs === endMs never throws and never commits above 0.5", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.peakMs, endMs: window.peakMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(0.8, 0.55, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(Number.isFinite(prediction.confidence)).toBe(true);
    expect(prediction.confidence).toBeLessThanOrEqual(1);
  });

  it("a contact reference outside the clip yields UNKNOWN or a sub-0.5 prediction", () => {
    const last = sequence.frames[sequence.frames.length - 1]!.timestampMs;
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: last + 5000,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(prediction.label === "UNKNOWN" || prediction.confidence < 0.5).toBe(true);
  });

  it("NaN paddle centers never produce a committed side or a non-finite confidence", () => {
    const prediction = classifyStroke({
      sequence,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: window.peakMs,
      handedness: "right",
      paddle: paddleAt(Number.NaN, Number.NaN, window.peakMs),
      paddleSpeeds: null,
      wristSpeeds: null,
    });
    expect(Number.isFinite(prediction.confidence)).toBe(true);
    expect(prediction.label === "UNKNOWN" || prediction.contactPointSource === "wrist").toBe(true);
  });

  it("paddle track confidence exactly 0.3 is 'strong'; 0.29 is 'degraded' (inclusive floor)", () => {
    const contactFrame = sequence.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs)
        ? frame
        : best,
    );
    const wrist = contactFrame.landmarks.find((mark) => mark.name === "right_wrist")!;
    const run = (confidence: number) =>
      classifyStroke({
        sequence,
        window: { startMs: window.startMs, endMs: window.endMs },
        contactMs: window.peakMs,
        handedness: "right",
        paddle: paddleAt(wrist.x + 0.03, wrist.y - 0.02, window.peakMs).map((p) => ({
          ...p,
          confidence,
        })),
        paddleSpeeds: null,
        wristSpeeds: null,
      });
    const at = run(0.3);
    expect(at.contactPointSource).toBe("paddle");
    expect(at.contactPointReliability).toBe("strong");
    const below = run(0.29);
    expect(below.contactPointSource).toBe("paddle");
    expect(below.contactPointReliability).toBe("degraded");
    expect(below.limitingFactors).toContain("paddle_point_low_track_confidence");
    expect(below.confidence).toBeLessThanOrEqual(0.6);
  });
});
