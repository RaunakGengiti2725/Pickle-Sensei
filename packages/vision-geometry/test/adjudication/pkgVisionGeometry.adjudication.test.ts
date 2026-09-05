import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";
import { generateSwingSequence } from "@pickle/evaluation";
import { classifyStroke } from "../../src/index.js";

/**
 * ADJUDICATION — pkg-vision-geometry @ 4d812e1a.
 *
 * Independent reproductions of the auditor findings that were CONFIRMED.
 * Every test asserts the SAFE (expected) behaviour, so on the audited
 * revision each one FAILS; a fix is complete when this file is green without
 * any assertion being weakened. Inputs are all finite and structurally valid
 * (they survive `parsePoseSequence`), i.e. reachable from the shipping path.
 *
 * This file carries the ADJ-VG-01 cases (branch
 * devin/triage-pkg-vision-geometry-ADJ-VG-01 @ 82485300, assertions
 * unchanged). ADJ-VG-02/03/04 are separate findings and land with their own
 * fixes.
 */

const TORSO = new Set(["left_shoulder", "right_shoulder", "left_hip", "right_hip"]);

function withTorsoAt(
  sequence: PoseSequence,
  aroundMs: number,
  mutate: (mark: PoseSequence["frames"][number]["landmarks"][number]) => typeof mark,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      Math.abs(frame.timestampMs - aroundMs) > 40
        ? frame
        : {
            ...frame,
            landmarks: frame.landmarks.map((mark) => (TORSO.has(mark.name) ? mutate(mark) : mark)),
          },
    ),
  };
}

describe("ADJ-VG-01 classifyStroke: visibility-0 torso landmarks must not define the midline", () => {
  const { sequence, window } = generateSwingSequence();
  // Exactly the shipping call shape (apps/mobile/src/vision/providers.ts):
  // no paddle, no speed series, reference = event peak.
  const classify = (seq: PoseSequence) =>
    classifyStroke({
      sequence: seq,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: null,
      eventPeakMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });

  it("control: fully measured torso commits FOREHAND", () => {
    expect(classify(sequence).label).toBe("FOREHAND");
  });

  it("visibility-0 torso at the reference frame abstains (same as an absent torso)", () => {
    const unmeasured = withTorsoAt(sequence, window.peakMs, (mark) => ({ ...mark, visibility: 0 }));
    const absent = withTorsoAt(sequence, window.peakMs, (mark) => ({
      ...mark,
      name: `${mark.name}_removed` as typeof mark.name,
    }));
    expect(classify(absent).label).toBe("UNKNOWN"); // precondition: absence abstains
    const prediction = classify(unmeasured);
    expect(prediction.label, JSON.stringify(prediction)).toBe("UNKNOWN");
  });

  it("visibility-0 torso coordinates must not be able to flip the committed side", () => {
    // Same invisible landmarks, but their (unmeasured) x is dragged to the
    // far right so the midline crosses the wrist. A gated classifier is
    // indifferent to invisible coordinates; the baseline flips the label.
    const shifted = withTorsoAt(sequence, window.peakMs, (mark) => ({
      ...mark,
      x: Math.min(0.99, mark.x + 0.45),
      visibility: 0,
    }));
    const prediction = classify(shifted);
    expect(prediction.label, JSON.stringify(prediction)).not.toBe("BACKHAND");
  });
});
