import type { PoseFrame, PoseLandmarkName } from "@pickle/shared-types";

/**
 * Pure 2D kinematics over measured pose frames. Every function is
 * deterministic and unit-explicit. Coordinates are treated as top-left
 * normalized-image values; callers supply the clip aspect ratio (width/height)
 * so horizontal distances are expressed in the same physical unit as vertical
 * ones ("image heights"). Nothing here estimates, extrapolates, or invents a
 * landmark that was not measured.
 */

export interface Point {
  x: number;
  y: number;
  visibility: number;
}

export const MIN_LANDMARK_VISIBILITY = 0.3;

export function landmark(
  frame: PoseFrame,
  name: PoseLandmarkName,
  aspectRatio: number,
): Point | null {
  const found = frame.landmarks.find((entry) => entry.name === name);
  if (!found || found.visibility < MIN_LANDMARK_VISIBILITY) return null;
  return { x: found.x * aspectRatio, y: found.y, visibility: found.visibility };
}

export function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    visibility: Math.min(a.visibility, b.visibility),
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Interior angle at vertex `b` (degrees, 0..180). */
export function interiorAngleDeg(a: Point, b: Point, c: Point): number {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const magnitudes = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (magnitudes === 0) return 0;
  const cosine = Math.min(1, Math.max(-1, dot / magnitudes));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/** Direction of the segment a→b in degrees (-180..180], image coordinates. */
export function segmentAngleDeg(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Smallest absolute difference between two angles in degrees (0..180). */
export function angularDifferenceDeg(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const half = Math.floor(sorted.length / 2);
  const upper = sorted[half] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[half - 1] ?? upper) + upper) / 2;
}

export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Centered moving average; window is forced odd and clipped at the edges. */
export function movingAverage(values: readonly number[], window: number): number[] {
  const half = Math.floor(Math.max(1, window) / 2);
  return values.map((_, index) => {
    const start = Math.max(0, index - half);
    const end = Math.min(values.length, index + half + 1);
    return mean(values.slice(start, end));
  });
}

export interface TimedSample {
  timestampMs: number;
  value: number;
}

/**
 * Speed profile (units per second) of one landmark via central finite
 * differences on frames where the landmark is measured. Frames missing the
 * landmark are skipped, never interpolated.
 */
export function speedSeries(
  frames: readonly PoseFrame[],
  name: PoseLandmarkName,
  aspectRatio: number,
): TimedSample[] {
  const tracked: Array<{ timestampMs: number; point: Point }> = [];
  for (const frame of frames) {
    const point = landmark(frame, name, aspectRatio);
    if (point) tracked.push({ timestampMs: frame.timestampMs, point });
  }
  if (tracked.length < 3) return [];
  const speeds: TimedSample[] = [];
  for (let index = 1; index < tracked.length - 1; index += 1) {
    const previous = tracked[index - 1];
    const current = tracked[index];
    const next = tracked[index + 1];
    if (!previous || !current || !next) continue;
    const dtMs = next.timestampMs - previous.timestampMs;
    if (dtMs <= 0) continue;
    speeds.push({
      timestampMs: current.timestampMs,
      value: (distance(previous.point, next.point) / dtMs) * 1000,
    });
  }
  return speeds;
}

/**
 * Speed via CONSECUTIVE differences. The central-difference `speedSeries`
 * cancels reciprocating motion (a compact volley punch reads ~0 at its
 * fastest frame because prev→next spans out-and-back); this variant does
 * not. Kept separate so the frozen phase.geometry.v1 consumer of
 * `speedSeries` stays byte-identical.
 */
export function consecutiveSpeedSeries(
  frames: readonly PoseFrame[],
  name: PoseLandmarkName,
  aspectRatio: number,
  maxGapMs = 150,
): TimedSample[] {
  const tracked: Array<{ timestampMs: number; point: Point }> = [];
  for (const frame of frames) {
    const point = landmark(frame, name, aspectRatio);
    if (point) tracked.push({ timestampMs: frame.timestampMs, point });
  }
  const speeds: TimedSample[] = [];
  for (let index = 1; index < tracked.length; index += 1) {
    const previous = tracked[index - 1]!;
    const current = tracked[index]!;
    const dtMs = current.timestampMs - previous.timestampMs;
    if (dtMs <= 0 || dtMs > maxGapMs) continue;
    speeds.push({
      timestampMs: current.timestampMs,
      value: (distance(previous.point, current.point) / dtMs) * 1000,
    });
  }
  return speeds;
}

/** Path length of a landmark across frames inside [startMs, endMs]. */
export function pathLength(
  frames: readonly PoseFrame[],
  name: PoseLandmarkName,
  startMs: number,
  endMs: number,
  aspectRatio: number,
): number {
  let previous: Point | null = null;
  let total = 0;
  for (const frame of frames) {
    if (frame.timestampMs < startMs || frame.timestampMs > endMs) continue;
    const point = landmark(frame, name, aspectRatio);
    if (!point) continue;
    if (previous) total += distance(previous, point);
    previous = point;
  }
  return total;
}

/** The measured frame closest in time to `timestampMs`. */
export function frameNearest(frames: readonly PoseFrame[], timestampMs: number): PoseFrame | null {
  let best: PoseFrame | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const delta = Math.abs(frame.timestampMs - timestampMs);
    if (delta < bestDelta) {
      best = frame;
      bestDelta = delta;
    }
  }
  return best;
}

export function framesWithin(
  frames: readonly PoseFrame[],
  startMs: number,
  endMs: number,
): PoseFrame[] {
  return frames.filter((frame) => frame.timestampMs >= startMs && frame.timestampMs <= endMs);
}

export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}
