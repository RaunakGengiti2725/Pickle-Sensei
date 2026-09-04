import type { PoseSequence } from "@pickle/swing-domain";

/**
 * Audit-only helpers (structural audit pass 1, branch
 * devin/audit-pkg-vision-geometry-structural2). No production semantics.
 */

/** Deep copy of a sequence so probes never mutate the shared fixture. */
export function cloneSequence(sequence: PoseSequence): PoseSequence {
  return {
    ...sequence,
    video: { ...sequence.video },
    frames: sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) => ({ ...mark })),
    })),
  };
}

/**
 * Re-encode one landmark as a "not detected" joint the way the native
 * provider emits it (INFERRED from native/vision-core/Sources/ApplePoseProvider.swift:
 * every `recognizedPoint` is forwarded with `visibility = confidence`, no
 * filter; a zero-confidence Vision point sits at location (0,0) which maps
 * to normalized top-left (0, 1)). Frames are selected by predicate.
 */
export function ghostLandmark(
  sequence: PoseSequence,
  name: string,
  select: (timestampMs: number) => boolean,
  at: { x: number; y: number } = { x: 0, y: 1 },
): PoseSequence {
  const copy = cloneSequence(sequence);
  for (const frame of copy.frames) {
    if (!select(frame.timestampMs)) continue;
    for (const mark of frame.landmarks) {
      if (mark.name !== name) continue;
      mark.x = at.x;
      mark.y = at.y;
      mark.visibility = 0;
    }
  }
  return copy;
}

/** Remove one landmark entirely from the selected frames. */
export function dropLandmark(
  sequence: PoseSequence,
  name: string,
  select: (timestampMs: number) => boolean,
): PoseSequence {
  const copy = cloneSequence(sequence);
  for (const frame of copy.frames) {
    if (!select(frame.timestampMs)) continue;
    frame.landmarks = frame.landmarks.filter((mark) => mark.name !== name);
  }
  return copy;
}
