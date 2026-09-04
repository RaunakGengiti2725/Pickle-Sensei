import type { CanonicalLandmark, CanonicalPoseFrame, PoseSequence } from "@pickle/swing-domain";
import type { SeededRng } from "./rng.js";

/**
 * Seeded keypoint-stream synthesizer for the PLAYER VISIBILITY matrix.
 *
 * Every function is a pure transform over the canonical PoseSequence produced
 * by the committed synthetic swing fixture (@pickle/evaluation
 * generateSwingSequence). Nothing here invents a better skeleton than the
 * input: transforms only REMOVE information (dropout, occlusion, cropping,
 * gaps), PERTURB it (jitter, scale, translation) or SPLICE in a second,
 * clearly different skeleton (multi-person / spectator cases). The output is
 * what a pose provider could plausibly hand the pipeline under that
 * visibility condition.
 */

export const ALL_LANDMARKS = [
  "head",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
] as const;
export type LandmarkName = (typeof ALL_LANDMARKS)[number];

export const LEG_LANDMARKS: readonly LandmarkName[] = [
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
];
export const LOWER_BODY_LANDMARKS: readonly LandmarkName[] = [
  "left_hip",
  "right_hip",
  ...LEG_LANDMARKS,
];
export const ARM_LANDMARKS: Record<"left" | "right", readonly LandmarkName[]> = {
  left: ["left_elbow", "left_wrist"],
  right: ["right_elbow", "right_wrist"],
};

/**
 * How a pose provider represents a joint it did not measure: some models omit
 * the landmark, others emit it at a visibility below the pipeline's 0.3
 * threshold. Both representations must be handled identically downstream.
 */
export type DropoutMode = "omit" | "low_visibility";

/** Visibility assigned to a dropped landmark in `low_visibility` mode (< 0.3). */
const DROPPED_VISIBILITY = 0.12;

function withFrames(sequence: PoseSequence, frames: CanonicalPoseFrame[]): PoseSequence {
  return { ...sequence, frames: frames.map((frame, index) => ({ ...frame, frameIndex: index })) };
}

/**
 * Whole-frame confidence recomputed from the landmarks that survive a
 * transform: mean visibility over the canonical vocabulary, absent joints
 * counting as zero. This is the conservative reading a provider would give
 * for a partially measured body.
 */
export function frameConfidenceFrom(landmarks: readonly CanonicalLandmark[]): number {
  let total = 0;
  for (const name of ALL_LANDMARKS) {
    const mark = landmarks.find((entry) => entry.name === name);
    if (mark) total += mark.visibility;
  }
  return total / ALL_LANDMARKS.length;
}

function dropLandmarks(
  frame: CanonicalPoseFrame,
  shouldDrop: (name: string) => boolean,
  mode: DropoutMode,
): CanonicalPoseFrame {
  const landmarks =
    mode === "omit"
      ? frame.landmarks.filter((mark) => !shouldDrop(mark.name))
      : frame.landmarks.map((mark) =>
          shouldDrop(mark.name) ? { ...mark, visibility: DROPPED_VISIBILITY } : mark,
        );
  return { ...frame, landmarks, confidence: frameConfidenceFrom(landmarks) };
}

/** Remove a fixed joint set from every frame (legs/arms never in view). */
export function removeJoints(
  sequence: PoseSequence,
  joints: readonly string[],
  mode: DropoutMode,
): PoseSequence {
  const set = new Set(joints);
  return withFrames(
    sequence,
    sequence.frames.map((frame) => dropLandmarks(frame, (name) => set.has(name), mode)),
  );
}

/** Per-frame, per-joint independent dropout at `rate` for the listed joints. */
export function dropoutJoints(
  sequence: PoseSequence,
  rng: SeededRng,
  joints: readonly string[],
  rate: number,
  mode: DropoutMode,
): PoseSequence {
  const set = new Set(joints);
  return withFrames(
    sequence,
    sequence.frames.map((frame) => {
      const dropped = new Set<string>();
      for (const mark of frame.landmarks) {
        if (set.has(mark.name) && rng.chance(rate)) dropped.add(mark.name);
      }
      return dropLandmarks(frame, (name) => dropped.has(name), mode);
    }),
  );
}

/** Gaussian positional jitter (image units) on every measured landmark. */
export function jitter(sequence: PoseSequence, rng: SeededRng, sigma: number): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) => ({
        ...mark,
        x: mark.x + rng.gaussian() * sigma,
        y: mark.y + rng.gaussian() * sigma,
      })),
    })),
  );
}

/** Joints hidden (visibility < 0.3 or omitted) inside [startMs, endMs]. */
export function occlude(
  sequence: PoseSequence,
  joints: readonly string[],
  startMs: number,
  endMs: number,
  mode: DropoutMode,
): PoseSequence {
  const set = new Set(joints);
  return withFrames(
    sequence,
    sequence.frames.map((frame) =>
      frame.timestampMs >= startMs && frame.timestampMs <= endMs
        ? dropLandmarks(frame, (name) => set.has(name), mode)
        : frame,
    ),
  );
}

/**
 * Player leaves the frame: frames inside [startMs, endMs] are not measured
 * at all (a real gap in the sequence, as the canonical record specifies —
 * never filled).
 */
export function removeFrames(sequence: PoseSequence, startMs: number, endMs: number): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.filter((frame) => frame.timestampMs < startMs || frame.timestampMs > endMs),
  );
}

/** Frames kept but with no person measured (empty landmark list, confidence 0). */
export function emptyLandmarks(sequence: PoseSequence): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) => ({ ...frame, landmarks: [], confidence: 0 })),
  );
}

/** Every landmark measured, but at sub-threshold visibility (no real person). */
export function floorVisibility(
  sequence: PoseSequence,
  rng: SeededRng,
  lower: number,
  upper: number,
): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) => {
      const landmarks = frame.landmarks.map((mark) => ({
        ...mark,
        visibility: rng.uniform(lower, upper),
      }));
      return { ...frame, landmarks, confidence: frameConfidenceFrom(landmarks) };
    }),
  );
}

/** Body center (mean of shoulders and hips over the clip) for scaling. */
export function bodyCenter(sequence: PoseSequence): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let count = 0;
  for (const frame of sequence.frames) {
    for (const mark of frame.landmarks) {
      if (
        mark.name === "left_shoulder" ||
        mark.name === "right_shoulder" ||
        mark.name === "left_hip" ||
        mark.name === "right_hip"
      ) {
        x += mark.x;
        y += mark.y;
        count += 1;
      }
    }
  }
  return count > 0 ? { x: x / count, y: y / count } : { x: 0.5, y: 0.5 };
}

/**
 * Camera distance: scale every landmark about `center`. Landmarks that land
 * outside the image are not measurable and are dropped per `mode` — a close
 * camera crops the body; a far camera shrinks it.
 */
export function scaleAbout(
  sequence: PoseSequence,
  center: { x: number; y: number },
  factor: number,
  mode: DropoutMode,
): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) => {
      const scaled = frame.landmarks.map((mark) => ({
        ...mark,
        x: center.x + (mark.x - center.x) * factor,
        y: center.y + (mark.y - center.y) * factor,
      }));
      const outside = new Set(
        scaled
          .filter((mark) => mark.x < 0 || mark.x > 1 || mark.y < 0 || mark.y > 1)
          .map((mark) => mark.name),
      );
      const clipped = { ...frame, landmarks: scaled };
      return dropLandmarks(clipped, (name) => outside.has(name), mode);
    }),
  );
}

/** Rigid translation of the whole skeleton (image units). */
export function translate(sequence: PoseSequence, dx: number, dy: number): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) => ({ ...mark, x: mark.x + dx, y: mark.y + dy })),
    })),
  );
}

/**
 * Frame-edge crop: landmarks below `yCut` (image bottom cut by the framing)
 * are not in view. Models the classic "legs out of frame" capture.
 */
export function cropBelow(sequence: PoseSequence, yCut: number, mode: DropoutMode): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) => {
      const below = new Set(
        frame.landmarks.filter((mark) => mark.y > yCut).map((mark) => mark.name),
      );
      return dropLandmarks(frame, (name) => below.has(name), mode);
    }),
  );
}

/**
 * A second, clearly different person: the reference skeleton's FIRST frame
 * held still (a bystander standing at `offset` from the player), mirrored
 * left/right so it is not a copy of the player.
 */
export function bystanderFrom(
  sequence: PoseSequence,
  offset: { x: number; y: number },
  scale: number,
): CanonicalLandmark[] {
  const first = sequence.frames[0];
  if (!first) return [];
  const center = bodyCenter(sequence);
  return first.landmarks.map((mark) => ({
    ...mark,
    name: mark.name.startsWith("left_")
      ? mark.name.replace("left_", "right_")
      : mark.name.startsWith("right_")
        ? mark.name.replace("right_", "left_")
        : mark.name,
    x: center.x + offset.x - (mark.x - center.x) * scale,
    y: center.y + offset.y + (mark.y - center.y) * scale,
  }));
}

/** Identity switch: from `switchMs` on, the tracked body is the bystander. */
export function identitySwitch(
  sequence: PoseSequence,
  bystander: readonly CanonicalLandmark[],
  switchMs: number,
): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) =>
      frame.timestampMs >= switchMs
        ? {
            ...frame,
            landmarks: bystander.map((mark) => ({ ...mark })),
            confidence: frameConfidenceFrom(bystander),
          }
        : frame,
    ),
  );
}

/** Tracker flicker: each frame independently reports the bystander with probability `rate`. */
export function identityFlicker(
  sequence: PoseSequence,
  rng: SeededRng,
  bystander: readonly CanonicalLandmark[],
  rate: number,
): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) =>
      rng.chance(rate)
        ? {
            ...frame,
            landmarks: bystander.map((mark) => ({ ...mark })),
            confidence: frameConfidenceFrom(bystander),
          }
        : frame,
    ),
  );
}

/**
 * The tracked person is a spectator: the player's ready stance held for the
 * whole clip, optionally with a slow small arm gesture (amplitude in image
 * units, period in ms) — motion, but no stroke.
 */
export function spectator(
  sequence: PoseSequence,
  gesture: { amplitude: number; periodMs: number } | null,
): PoseSequence {
  const first = sequence.frames[0];
  if (!first) return sequence;
  return withFrames(
    sequence,
    sequence.frames.map((frame) => ({
      ...frame,
      confidence: first.confidence,
      landmarks: first.landmarks.map((mark) => {
        if (!gesture || (mark.name !== "right_wrist" && mark.name !== "left_wrist")) {
          return { ...mark };
        }
        const phase = (2 * Math.PI * frame.timestampMs) / gesture.periodMs;
        return {
          ...mark,
          x: mark.x + gesture.amplitude * Math.sin(phase),
          y: mark.y + gesture.amplitude * 0.5 * Math.cos(phase),
        };
      }),
    })),
  );
}

/** Timestamp of the frame closest to a clip-relative instant. */
export function nearestTimestamp(sequence: PoseSequence, tMs: number): number {
  let best = tMs;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const frame of sequence.frames) {
    const delta = Math.abs(frame.timestampMs - tMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = frame.timestampMs;
    }
  }
  return best;
}
