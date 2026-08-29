import { toLegacyPoseFrames, type PoseSequence } from "@pickle/swing-domain";
import type { BallTrackObservation } from "./ballTracker.js";
import type { TrackedPaddleObservation } from "./paddleTracker.js";

/**
 * Per-stroke temporal research sequence + EXPERIMENTAL kinetic-sequence
 * measurements.
 *
 * Every timestep carries explicit masks: a missing paddle/ball at a timestep
 * is (null + mask=false), never a fake zero that could read as a
 * measurement. Timestamps are preserved AND contact-relative time is added
 * when a contact estimate exists.
 *
 * Kinetic events (hip/shoulder-line angular speed peaks, wrist/paddle speed
 * peaks, ordered relative to contact) are EXPERIMENTAL MEASUREMENTS — they
 * are not validated coaching metrics and every artifact says so.
 */

export const SEQUENCE_SCHEMA_VERSION = 1 as const;
export const KINETIC_MEASUREMENT_STATUS =
  "experimental measurement (not a validated coaching metric)";

export interface SequenceTimestep {
  tMs: number;
  /** Milliseconds relative to estimated contact; null when no estimate. */
  tRelContactMs: number | null;
  pose: {
    present: boolean;
    /** name → [x, y, visibility] for visible joints only. */
    joints: Record<string, [number, number, number]>;
  };
  paddle: { present: boolean; center: [number, number] | null; confidence: number | null };
  ball: { present: boolean; center: [number, number] | null; confidence: number | null };
}

export interface KineticEvent {
  event:
    | "hip_line_angular_speed_peak"
    | "shoulder_line_angular_speed_peak"
    | "wrist_speed_peak"
    | "paddle_speed_peak"
    | "contact";
  tMs: number;
  tRelContactMs: number | null;
  /** deg/s for angular events, normalized u/s for linear, null for contact. */
  peakValue: number | null;
}

export interface StrokeSequence {
  schemaVersion: typeof SEQUENCE_SCHEMA_VERSION;
  windowMs: { start: number; end: number };
  contactMs: number | null;
  timesteps: SequenceTimestep[];
  kinetics: { status: string; events: KineticEvent[] };
}

export function buildStrokeSequence(input: {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number };
  contactMs: number | null;
  paddle: readonly TrackedPaddleObservation[] | null;
  ball: readonly BallTrackObservation[] | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
}): StrokeSequence {
  const pad = 400;
  const frames = toLegacyPoseFrames(input.sequence).filter(
    (frame) =>
      frame.timestampMs >= input.window.startMs - pad &&
      frame.timestampMs <= input.window.endMs + pad,
  );
  const timesteps: SequenceTimestep[] = frames.map((frame) => {
    const paddleNear = nearest(input.paddle ?? [], frame.timestampMs, 25);
    const ballNear = nearest(input.ball ?? [], frame.timestampMs, 25);
    const joints: Record<string, [number, number, number]> = {};
    for (const mark of frame.landmarks) {
      if (mark.visibility >= 0.2) joints[mark.name] = [mark.x, mark.y, mark.visibility];
    }
    return {
      tMs: frame.timestampMs,
      tRelContactMs: input.contactMs !== null ? frame.timestampMs - input.contactMs : null,
      pose: { present: Object.keys(joints).length > 0, joints },
      paddle: paddleNear
        ? {
            present: true,
            center: [paddleNear.center.x, paddleNear.center.y],
            confidence: paddleNear.confidence,
          }
        : { present: false, center: null, confidence: null },
      ball: ballNear
        ? { present: true, center: [ballNear.x, ballNear.y], confidence: ballNear.confidence }
        : { present: false, center: null, confidence: null },
    };
  });

  // ── Experimental kinetic events ─────────────────────────────────────────
  const events: KineticEvent[] = [];
  const push = (
    event: KineticEvent["event"],
    sample: { timestampMs: number; value: number } | null,
  ) => {
    if (!sample) return;
    events.push({
      event,
      tMs: sample.timestampMs,
      tRelContactMs: input.contactMs !== null ? sample.timestampMs - input.contactMs : null,
      peakValue: sample.value,
    });
  };
  push("hip_line_angular_speed_peak", angularPeak(frames, "left_hip", "right_hip", input.window));
  push(
    "shoulder_line_angular_speed_peak",
    angularPeak(frames, "left_shoulder", "right_shoulder", input.window),
  );
  push("wrist_speed_peak", seriesPeak(input.wristSpeeds, input.window));
  push("paddle_speed_peak", seriesPeak(input.paddleSpeeds, input.window));
  if (input.contactMs !== null) {
    events.push({ event: "contact", tMs: input.contactMs, tRelContactMs: 0, peakValue: null });
  }
  events.sort((a, b) => a.tMs - b.tMs);

  return {
    schemaVersion: SEQUENCE_SCHEMA_VERSION,
    windowMs: { start: input.window.startMs, end: input.window.endMs },
    contactMs: input.contactMs,
    timesteps,
    kinetics: { status: KINETIC_MEASUREMENT_STATUS, events },
  };
}

function nearest<T extends { timestampMs: number }>(
  items: readonly T[],
  tMs: number,
  toleranceMs: number,
): T | null {
  let best: T | null = null;
  let bestDelta = Infinity;
  for (const item of items) {
    const delta = Math.abs(item.timestampMs - tMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = item;
    }
  }
  return best && bestDelta <= toleranceMs ? best : null;
}

/** Peak absolute angular speed (deg/s) of the line joining two joints. */
function angularPeak(
  frames: ReturnType<typeof toLegacyPoseFrames>,
  jointA: string,
  jointB: string,
  window: { startMs: number; endMs: number },
): { timestampMs: number; value: number } | null {
  const angles: Array<{ tMs: number; angle: number }> = [];
  for (const frame of frames) {
    const a = frame.landmarks.find((mark) => mark.name === jointA && mark.visibility >= 0.25);
    const b = frame.landmarks.find((mark) => mark.name === jointB && mark.visibility >= 0.25);
    if (!a || !b) continue;
    angles.push({ tMs: frame.timestampMs, angle: Math.atan2(b.y - a.y, b.x - a.x) });
  }
  let best: { timestampMs: number; value: number } | null = null;
  for (let index = 1; index < angles.length; index += 1) {
    const dtSec = (angles[index]!.tMs - angles[index - 1]!.tMs) / 1000;
    if (dtSec <= 0 || dtSec > 0.15) continue;
    if (angles[index]!.tMs < window.startMs || angles[index]!.tMs > window.endMs) continue;
    let dAngle = angles[index]!.angle - angles[index - 1]!.angle;
    while (dAngle > Math.PI) dAngle -= 2 * Math.PI;
    while (dAngle < -Math.PI) dAngle += 2 * Math.PI;
    const speed = Math.abs((dAngle * 180) / Math.PI) / dtSec;
    if (!best || speed > best.value) {
      best = { timestampMs: angles[index]!.tMs, value: speed };
    }
  }
  return best;
}

function seriesPeak(
  series: ReadonlyArray<{ timestampMs: number; value: number }> | null,
  window: { startMs: number; endMs: number },
): { timestampMs: number; value: number } | null {
  if (!series) return null;
  let best: { timestampMs: number; value: number } | null = null;
  for (const sample of series) {
    if (sample.timestampMs < window.startMs || sample.timestampMs > window.endMs) continue;
    if (!best || sample.value > best.value) best = sample;
  }
  return best;
}
