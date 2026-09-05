import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";
import { generateSwingSequence } from "@pickle/evaluation";
import { classifyStroke } from "../../src/index.js";

/**
 * ADJ-VG-01 acceptance pins (triage, integrated head).
 *
 * The reference-frame torso must be gated on landmark visibility like every
 * other geometry consumer (kinematics.landmark, MIN_LANDMARK_VISIBILITY 0.3).
 * A torso that is present but unmeasured (visibility below the floor) must be
 * indistinguishable from an absent torso: UNKNOWN + torso_not_measured_at_contact.
 * Every assertion states the SAFE behaviour; a fix is complete when this file
 * is green without weakening any assertion.
 */

type Landmark = PoseSequence["frames"][number]["landmarks"][number];
type LandmarkName = Landmark["name"];

const TORSO: readonly LandmarkName[] = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"];
const HIPS: readonly LandmarkName[] = ["left_hip", "right_hip"];
/** Mirrors kinematics.ts MIN_LANDMARK_VISIBILITY (not exported). */
const MIN_LANDMARK_VISIBILITY = 0.3;

function mutateAtReference(
  sequence: PoseSequence,
  aroundMs: number,
  names: readonly LandmarkName[],
  mutate: (mark: Landmark) => Landmark,
): PoseSequence {
  const wanted = new Set<string>(names);
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      Math.abs(frame.timestampMs - aroundMs) > 40
        ? frame
        : {
            ...frame,
            landmarks: frame.landmarks.map((mark) => (wanted.has(mark.name) ? mutate(mark) : mark)),
          },
    ),
  };
}

function removeAtReference(
  sequence: PoseSequence,
  aroundMs: number,
  names: readonly LandmarkName[],
): PoseSequence {
  const wanted = new Set<string>(names);
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      Math.abs(frame.timestampMs - aroundMs) > 40
        ? frame
        : { ...frame, landmarks: frame.landmarks.filter((mark) => !wanted.has(mark.name)) },
    ),
  };
}

describe("ADJ-VG-01 acceptance: unmeasured torso landmarks at the reference frame", () => {
  const { sequence, window } = generateSwingSequence();
  // Shipping call shape (apps/mobile/src/vision/providers.ts): no paddle, no
  // speed series, reference = event peak.
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

  const control = classify(sequence);

  it("precondition: fully measured control commits a side", () => {
    expect(["FOREHAND", "BACKHAND"]).toContain(control.label);
  });

  it("AC1: visibility-0 torso yields UNKNOWN/torso_not_measured_at_contact, byte-identical to the removed torso", () => {
    const unmeasured = classify(
      mutateAtReference(sequence, window.peakMs, TORSO, (mark) => ({ ...mark, visibility: 0 })),
    );
    const absent = classify(removeAtReference(sequence, window.peakMs, TORSO));
    expect(absent.label).toBe("UNKNOWN"); // precondition: absence abstains today
    expect(absent.limitingFactors).toContain("torso_not_measured_at_contact");
    expect(unmeasured.label, JSON.stringify(unmeasured)).toBe("UNKNOWN");
    expect(unmeasured.limitingFactors).toContain("torso_not_measured_at_contact");
    expect(JSON.stringify(unmeasured)).toBe(JSON.stringify(absent));
  });

  it("AC2: moving an invisible torso landmark's x/y arbitrarily can never change a committed side", () => {
    const flipped = control.label === "FOREHAND" ? "BACKHAND" : "FOREHAND";
    const invisibleVisibilities = [0, 0.1, MIN_LANDMARK_VISIBILITY - 0.01];
    const displacements: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [0.45, 0],
      [-0.45, 0],
      [0, 0.4],
      [0, -0.4],
      [0.3, -0.3],
      [-0.3, 0.3],
    ];
    const groups: ReadonlyArray<readonly LandmarkName[]> = [
      ...TORSO.map((name) => [name] as const),
      ["left_shoulder", "right_shoulder"],
      HIPS,
      TORSO,
    ];
    const labels = new Set<string>();
    for (const names of groups) {
      for (const visibility of invisibleVisibilities) {
        for (const [dx, dy] of displacements) {
          const prediction = classify(
            mutateAtReference(sequence, window.peakMs, names, (mark) => ({
              ...mark,
              x: Math.min(0.99, Math.max(0.01, mark.x + dx)),
              y: Math.min(0.99, Math.max(0.01, mark.y + dy)),
              visibility,
            })),
          );
          labels.add(prediction.label);
          expect(
            prediction.label,
            `${names.join("+")} vis=${visibility} dx=${dx} dy=${dy}: ${JSON.stringify(prediction)}`,
          ).not.toBe(flipped);
        }
      }
    }
    // Invisible coordinates carry no information: every variant must agree.
    expect(labels.size, [...labels].join(",")).toBe(1);
  });

  it("AC3: shoulders measured but both hips at visibility 0 abstains instead of substituting the hips", () => {
    const partial = classify(
      mutateAtReference(sequence, window.peakMs, HIPS, (mark) => ({ ...mark, visibility: 0 })),
    );
    expect(partial.label, JSON.stringify(partial)).toBe("UNKNOWN");
    expect(partial.limitingFactors).toContain("torso_not_measured_at_contact");
  });

  it("AC3b: a visibility-0 hip dragged to the image bottom must not inflate the torso into a committed label", () => {
    const stretched = classify(
      mutateAtReference(sequence, window.peakMs, ["left_hip"], (mark) => ({
        ...mark,
        x: 0,
        y: 1,
        visibility: 0,
      })),
    );
    expect(stretched.label, JSON.stringify(stretched)).toBe("UNKNOWN");
    expect(stretched.limitingFactors).toContain("torso_not_measured_at_contact");
  });
});
