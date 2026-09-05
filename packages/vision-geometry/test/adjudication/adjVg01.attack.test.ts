import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";
import { generateSwingSequence } from "@pickle/evaluation";
import { classifyStroke } from "../../src/index.js";

/**
 * ADJ-VG-01 adversarial attack on candidate 33f3f03a (stroke-heuristic-8).
 *
 * The candidate gates the REFERENCE-frame torso on visibility. The three
 * other torso consumers in strokeHeuristicLite.ts still read shoulder/hip
 * coordinates from landmarks whose visibility is 0 (Apple Vision's value for
 * an unrecognised joint, forwarded verbatim by ClipMediaStore.swift and
 * accepted by parsePoseSequence):
 *
 *   - scanFacingWindow()  — presence-only `find("left_shoulder")`
 *   - scanRaiseWindow()   — explicit `find("left_shoulder", 0)` floor
 *   - medianTorsoExtent() — presence-only `find(...)`
 *
 * The contract the fix claims ("a torso landmark below TORSO_MIN_VISIBILITY is
 * treated exactly like an absent one", header comment for stroke-heuristic-8)
 * is asserted here for every frame in the sequence, not just the reference
 * frame: (1) unmeasured == absent, and (2) the COORDINATES of an unmeasured
 * landmark must never change the verdict. Every assertion states the safe
 * behaviour. The reference frame (±40ms of the event peak) is left intact in
 * every case so the candidate's own gate is never the thing under test.
 */

type Frame = PoseSequence["frames"][number];
type Landmark = Frame["landmarks"][number];
type LandmarkName = Landmark["name"];

const SHOULDERS: readonly LandmarkName[] = ["left_shoulder", "right_shoulder"];
const HIPS: readonly LandmarkName[] = ["left_hip", "right_hip"];
const TORSO: readonly LandmarkName[] = [...SHOULDERS, ...HIPS];

function mutateFrames(
  sequence: PoseSequence,
  select: (frame: Frame) => boolean,
  names: readonly LandmarkName[],
  mutate: (mark: Landmark) => Landmark,
): PoseSequence {
  const wanted = new Set<string>(names);
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      !select(frame)
        ? frame
        : {
            ...frame,
            landmarks: frame.landmarks.map((mark) => (wanted.has(mark.name) ? mutate(mark) : mark)),
          },
    ),
  };
}

function removeFromFrames(
  sequence: PoseSequence,
  select: (frame: Frame) => boolean,
  names: readonly LandmarkName[],
): PoseSequence {
  const wanted = new Set<string>(names);
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      !select(frame)
        ? frame
        : { ...frame, landmarks: frame.landmarks.filter((mark) => !wanted.has(mark.name)) },
    ),
  };
}

describe("ADJ-VG-01 attack: unmeasured torso landmarks OUTSIDE the reference frame", () => {
  const { sequence, window } = generateSwingSequence();
  const peakMs = window.peakMs;
  const atReference = (frame: Frame) => Math.abs(frame.timestampMs - peakMs) <= 40;
  const within = (halfWidthMs: number) => (frame: Frame) =>
    !atReference(frame) && Math.abs(frame.timestampMs - peakMs) <= halfWidthMs;

  const classify = (seq: PoseSequence) =>
    classifyStroke({
      sequence: seq,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: null,
      eventPeakMs: peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });

  const control = classify(sequence);

  it("precondition: the untouched fixture commits FOREHAND", () => {
    expect(control.label).toBe("FOREHAND");
  });

  describe("scanFacingWindow (±200ms facing consensus)", () => {
    // Shoulders in the ±200ms facing window, reference frame excluded:
    // visibility 0 + mirrored x (what an unrecognised joint's stale/garbage
    // coordinate looks like) vs the same landmarks deleted.
    const invisibleMirrored = mutateFrames(sequence, within(200), SHOULDERS, (mark) => ({
      ...mark,
      x: 1 - mark.x,
      visibility: 0,
    }));
    const invisibleInPlace = mutateFrames(sequence, within(200), SHOULDERS, (mark) => ({
      ...mark,
      visibility: 0,
    }));
    const absent = removeFromFrames(sequence, within(200), SHOULDERS);

    it("visibility-0 shoulders must be indistinguishable from absent shoulders", () => {
      expect(classify(invisibleMirrored)).toEqual(classify(absent));
    });

    it("the coordinates of visibility-0 shoulders must not change the verdict", () => {
      expect(classify(invisibleMirrored)).toEqual(classify(invisibleInPlace));
    });

    it("visibility-0 shoulder coordinates must never flip the committed side", () => {
      const poisoned = classify(invisibleMirrored);
      expect(["FOREHAND", "UNKNOWN"]).toContain(poisoned.label);
    });
  });

  describe("scanRaiseWindow (±150ms overhead corroboration)", () => {
    // A merely-degraded dominant wrist at the reference (visibility 0.4, above
    // the 0.25 dominant-wrist floor, below WRIST_RELIABLE_VISIBILITY 0.5) lets
    // the skeletal raise scan decide OVERHEAD on its own. Torso in the ±150ms
    // overhead window, reference frame excluded: visibility 0 + dragged toward
    // the image bottom (shoulder line far below the wrist) vs the same
    // landmarks deleted.
    const degradedWrist = mutateFrames(sequence, atReference, ["right_wrist"], (mark) => ({
      ...mark,
      visibility: 0.4,
    }));
    const dragged = (mark: Landmark): Landmark => ({
      ...mark,
      y: mark.name.endsWith("shoulder") ? 0.8 : 0.99,
      visibility: 0,
    });
    const invisibleDragged = mutateFrames(degradedWrist, within(150), TORSO, dragged);
    const invisibleInPlace = mutateFrames(degradedWrist, within(150), TORSO, (mark) => ({
      ...mark,
      visibility: 0,
    }));
    const absent = removeFromFrames(degradedWrist, within(150), TORSO);

    it("precondition: the degraded-wrist fixture still commits FOREHAND", () => {
      expect(classify(degradedWrist).label).toBe("FOREHAND");
    });

    it("visibility-0 torso must be indistinguishable from an absent torso", () => {
      expect(classify(invisibleDragged)).toEqual(classify(absent));
    });

    it("the coordinates of a visibility-0 torso must not change the verdict", () => {
      expect(classify(invisibleDragged)).toEqual(classify(invisibleInPlace));
    });

    it("a visibility-0 torso must not manufacture an OVERHEAD from a forehand", () => {
      expect(classify(invisibleDragged).label).not.toBe("OVERHEAD");
    });
  });

  describe("medianTorsoExtent (sequence-wide torso-collapse gate)", () => {
    // A VISIBLE reference torso collapsed to half its extent must abstain via
    // the collapse-vs-median gate. The gate compares against the median of
    // every frame's torso — including frames whose torso was never measured.
    const collapsedReference = mutateFrames(sequence, atReference, HIPS, (mark) => ({
      ...mark,
      y: mark.y - 0.1,
    }));
    const others = (frame: Frame) => !atReference(frame);
    const invisibleCollapsed = mutateFrames(collapsedReference, others, HIPS, (mark) => ({
      ...mark,
      y: mark.y - 0.1,
      visibility: 0,
    }));
    const invisibleInPlace = mutateFrames(collapsedReference, others, HIPS, (mark) => ({
      ...mark,
      visibility: 0,
    }));

    it("precondition: the collapsed visible reference torso abstains against an honest median", () => {
      const honest = classify(collapsedReference);
      expect(honest.label).toBe("UNKNOWN");
      expect(honest.limitingFactors).toContain("torso_extent_collapsed_vs_sequence_median");
    });

    it("the coordinates of visibility-0 hips must not change the verdict", () => {
      expect(classify(invisibleCollapsed)).toEqual(classify(invisibleInPlace));
    });

    it("visibility-0 hips must not be able to defeat the torso-collapse abstention", () => {
      expect(classify(invisibleCollapsed).label).toBe("UNKNOWN");
    });
  });
});
