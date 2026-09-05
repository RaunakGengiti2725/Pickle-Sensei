import { describe, expect, it } from "vitest";
import { parsePoseSequence, serializePoseSequence, type PoseSequence } from "@pickle/swing-domain";
import { generateSwingSequence } from "@pickle/evaluation";
import { classifyStroke } from "../../src/index.js";

/**
 * ADJ-VG-01 adversarial follow-up (attack on ff62c523).
 *
 * The fix gates the REFERENCE frame's torso on visibility. The same
 * classifier still reads unmeasured (visibility < 0.3) torso landmarks from
 * the NEIGHBOURING frames of the very same call:
 *   - scanFacingWindow (±200ms) votes the facing sign from shoulder x-order
 *     with no visibility floor, and the consensus overrides the measured
 *     reference frame;
 *   - medianTorsoExtent normalizes the collapse gate from every frame's
 *     torso with no visibility floor;
 *   - scanRaiseWindow (±150ms) normalizes the overhead corroboration by a
 *     shoulder/hip line read at visibility floor 0.
 * Every assertion below states the SAFE behaviour (invisible coordinates
 * carry no information, so they must be indistinguishable from absent
 * landmarks and must not be able to change a label).
 */

type Landmark = PoseSequence["frames"][number]["landmarks"][number];
type LandmarkName = Landmark["name"];

const SHOULDERS: readonly LandmarkName[] = ["left_shoulder", "right_shoulder"];
const TORSO: readonly LandmarkName[] = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"];
const FACING_WINDOW_MS = 200;
const REFERENCE_KEEP_MS = 40;

/** Mutate only frames within ±FACING_WINDOW_MS of the reference EXCEPT the
 * reference frame itself (|dt| <= REFERENCE_KEEP_MS stays fully measured). */
function mutateNeighbours(
  sequence: PoseSequence,
  aroundMs: number,
  mutateFrame: (landmarks: Landmark[]) => Landmark[],
  windowMs = FACING_WINDOW_MS,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) => {
      const dt = Math.abs(frame.timestampMs - aroundMs);
      if (dt <= REFERENCE_KEEP_MS || dt > windowMs) return frame;
      return { ...frame, landmarks: mutateFrame(frame.landmarks) };
    }),
  };
}

function swapShoulderXInvisible(landmarks: Landmark[], visibility: number): Landmark[] {
  const left = landmarks.find((mark) => mark.name === "left_shoulder");
  const right = landmarks.find((mark) => mark.name === "right_shoulder");
  if (!left || !right) return landmarks;
  return landmarks.map((mark) => {
    if (mark.name === "left_shoulder") return { ...mark, x: right.x, visibility };
    if (mark.name === "right_shoulder") return { ...mark, x: left.x, visibility };
    return mark;
  });
}

function dropNames(landmarks: Landmark[], names: readonly LandmarkName[]): Landmark[] {
  const wanted = new Set<string>(names);
  return landmarks.filter((mark) => !wanted.has(mark.name));
}

describe("ADJ-VG-01 attack: unmeasured torso landmarks in NEIGHBOURING frames of the same call", () => {
  const { sequence, window } = generateSwingSequence();
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
  const flipped = control.label === "FOREHAND" ? "BACKHAND" : "FOREHAND";

  it("precondition: fully measured control commits a side", () => {
    expect(["FOREHAND", "BACKHAND"]).toContain(control.label);
  });

  it("ATT1: visibility-0 shoulders in the ±200ms window (reference frame fully measured) must not flip the committed side", () => {
    for (const visibility of [0, 0.1, 0.29]) {
      const attacked = classify(
        mutateNeighbours(sequence, window.peakMs, (landmarks) =>
          swapShoulderXInvisible(landmarks, visibility),
        ),
      );
      expect(attacked.label, `vis=${visibility}: ${JSON.stringify(attacked)}`).not.toBe(flipped);
    }
  });

  it("ATT1b: visibility-0 neighbour shoulders must be indistinguishable from absent neighbour shoulders", () => {
    const invisible = classify(
      mutateNeighbours(sequence, window.peakMs, (landmarks) =>
        swapShoulderXInvisible(landmarks, 0),
      ),
    );
    const absent = classify(
      mutateNeighbours(sequence, window.peakMs, (landmarks) => dropNames(landmarks, SHOULDERS)),
    );
    expect(JSON.stringify(invisible)).toBe(JSON.stringify(absent));
  });

  it("ATT2: visibility-0 torso coordinates in non-reference frames must not change the label (median-torso normalizer)", () => {
    // Reference frame stays measured; every other frame's torso is unmeasured
    // and its hips are dragged to the image bottom (a torso Apple Vision did
    // not recognise carries arbitrary coordinates).
    const stretched = classify(
      mutateNeighbours(
        sequence,
        window.peakMs,
        (landmarks) =>
          landmarks.map((mark) =>
            mark.name === "left_hip" || mark.name === "right_hip"
              ? { ...mark, y: 0.99, visibility: 0 }
              : mark.name === "left_shoulder" || mark.name === "right_shoulder"
                ? { ...mark, visibility: 0 }
                : mark,
          ),
        Number.POSITIVE_INFINITY,
      ),
    );
    const absent = classify(
      mutateNeighbours(
        sequence,
        window.peakMs,
        (landmarks) => dropNames(landmarks, TORSO),
        Number.POSITIVE_INFINITY,
      ),
    );
    expect(stretched.label, JSON.stringify(stretched)).toBe(absent.label);
    expect(JSON.stringify(stretched)).toBe(JSON.stringify(absent));
  });

  it("ATT2b: visibility-0 torso coordinates in non-reference frames must not manufacture a commit from a reference torso the classifier itself calls collapsed", () => {
    // Reference torso: measured, but collapsed to half the player's median
    // (hips lifted). The sequence-median gate abstains on this today.
    const collapseHips = (landmarks: Landmark[], visibility: number | null): Landmark[] => {
      const ls = landmarks.find((mark) => mark.name === "left_shoulder");
      const rs = landmarks.find((mark) => mark.name === "right_shoulder");
      if (!ls || !rs) return landmarks;
      const shoulderY = (ls.y + rs.y) / 2;
      return landmarks.map((mark) => {
        if (mark.name === "left_hip" || mark.name === "right_hip") {
          return { ...mark, y: shoulderY + 0.1, ...(visibility === null ? {} : { visibility }) };
        }
        if (
          visibility !== null &&
          (mark.name === "left_shoulder" || mark.name === "right_shoulder")
        ) {
          return { ...mark, visibility };
        }
        return mark;
      });
    };
    const referenceCollapsed: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) =>
        Math.abs(frame.timestampMs - window.peakMs) <= REFERENCE_KEEP_MS
          ? { ...frame, landmarks: collapseHips(frame.landmarks, null) }
          : frame,
      ),
    };
    const gated = classify(referenceCollapsed);
    expect(gated.label, JSON.stringify(gated)).toBe("UNKNOWN");
    expect(gated.limitingFactors).toContain("torso_extent_collapsed_vs_sequence_median");

    // Now every OTHER frame's torso is unmeasured (visibility 0) with its
    // coordinates collapsed the same way. Unmeasured coordinates carry no
    // information: the verdict must stay identical to the gated one.
    const attacked = classify(
      mutateNeighbours(
        referenceCollapsed,
        window.peakMs,
        (landmarks) => collapseHips(landmarks, 0),
        Number.POSITIVE_INFINITY,
      ),
    );
    expect(attacked.label, JSON.stringify(attacked)).toBe("UNKNOWN");
  });

  it("ATT3: visibility-0 torso coordinates in the ±150ms raise window must not manufacture an OVERHEAD", () => {
    // Degrade the contact wrist (visibility 0.4 < 0.5) so the point is
    // 'degraded'; the reference torso stays fully measured.
    const degradedWrist: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame) =>
        Math.abs(frame.timestampMs - window.peakMs) <= REFERENCE_KEEP_MS
          ? {
              ...frame,
              landmarks: frame.landmarks.map((mark) =>
                mark.name === "right_wrist" ? { ...mark, visibility: 0.4 } : mark,
              ),
            }
          : frame,
      ),
    };
    const base = classify(degradedWrist);
    expect(["FOREHAND", "BACKHAND", "UNKNOWN"]).toContain(base.label);
    expect(base.label).not.toBe("OVERHEAD");

    // Neighbouring frames: torso unmeasured (visibility 0) and dragged to the
    // image bottom, so the unmeasured shoulder line sits BELOW the wrist.
    const attacked = classify(
      mutateNeighbours(
        degradedWrist,
        window.peakMs,
        (landmarks) =>
          landmarks.map((mark) =>
            mark.name === "left_shoulder" || mark.name === "right_shoulder"
              ? { ...mark, y: 0.9, visibility: 0 }
              : mark.name === "left_hip" || mark.name === "right_hip"
                ? { ...mark, y: 0.99, visibility: 0 }
                : mark,
          ),
        150,
      ),
    );
    expect(attacked.label, JSON.stringify(attacked)).toBe(base.label);

    const absent = classify(
      mutateNeighbours(
        degradedWrist,
        window.peakMs,
        (landmarks) => dropNames(landmarks, TORSO),
        150,
      ),
    );
    expect(absent.label, JSON.stringify(absent)).toBe(base.label);
    expect(JSON.stringify(attacked)).toBe(JSON.stringify(absent));
  });

  it("ATT4: the neighbour-shoulder flip survives the pose-sidecar wire contract the mobile AUTO DETECT path parses", () => {
    // apps/mobile runCaptureAnalysis: sidecar JSON -> parsePoseSequence ->
    // classifyStroke. A visibility-0 landmark is a valid wire landmark.
    const wire = serializePoseSequence(
      mutateNeighbours(sequence, window.peakMs, (landmarks) =>
        swapShoulderXInvisible(landmarks, 0),
      ),
    );
    const parsed = parsePoseSequence(wire, sequence.producedBy);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    const attacked = classify(parsed.value);
    expect(attacked.label, JSON.stringify(attacked)).toBe(control.label);
  });
});
