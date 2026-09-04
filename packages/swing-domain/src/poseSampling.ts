/**
 * Measured sampling structure of a pose stream — shared by every consumer
 * that must stay honest under sparse frames, timestamp jitter and positional
 * estimator noise (phase segmenter, stroke heuristic, fusion engine).
 *
 * Nothing here fills gaps or invents frames. The helpers only MEASURE what
 * the stream's own timestamps and landmarks say about it:
 *
 *  - the nominal frame interval (median consecutive delta);
 *  - the grid-aligned timeline: frame timestamps re-expressed as integer
 *    frame steps on a least-squares clock. Device frame clocks carry
 *    sub-frame jitter (capture/inference latency); the frame ORDER and the
 *    number of frames between two samples are the reliable quantities, so a
 *    derivative taken on the aligned clock is invariant to jitter that stays
 *    well below one frame interval. Gaps stay gaps (missed frames map to
 *    multiple steps);
 *  - the local frame gap bracketing a reference time, in frame intervals;
 *  - the positional noise scale of the landmark estimator, from the
 *    second-difference roughness of the slow-moving torso landmarks.
 */

export interface SampledLandmark {
  name: string;
  x: number;
  y: number;
  visibility: number;
}

export interface SampledPoseFrame {
  timestampMs: number;
  landmarks: readonly SampledLandmark[];
}

const GRID_REFINEMENT_PASSES = 2;
const SEED_CANDIDATE_RANGE: readonly [number, number] = [0.75, 1.5];

/**
 * Nominal frame interval (ms) of a possibly gappy, possibly jittered stream:
 * the fitted clock rate of the frame grid (see frameGrid). Null when the
 * grid cannot be measured — a single interval is not a sampling rate.
 */
export function nominalFrameIntervalMs(timestamps: readonly number[]): number | null {
  return frameGrid(timestamps)?.intervalMs ?? null;
}

/**
 * Seed interval for the grid fit. Consecutive deltas are whole multiples of
 * the frame interval plus bounded jitter. The median of the smaller half of
 * the deltas anchors the single-step cluster (it is that cluster as long as
 * single steps are at least half of all deltas — dropout below one frame in
 * two); the seed is then the delta within [0.75, 1.5] of that anchor whose
 * multiples fit every delta best (least squared distance of delta / seed to
 * whole steps). The range excludes the half- and double-interval aliases,
 * and the best-fitting delta lies within a sample spacing of the true
 * interval however the jitter shifts the cluster's median. Null when fewer
 * than two positive deltas exist.
 */
function seedIntervalMs(timestamps: readonly number[]): number | null {
  const deltas: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const delta = (timestamps[index] ?? 0) - (timestamps[index - 1] ?? 0);
    if (delta > 0) deltas.push(delta);
  }
  if (deltas.length < 2) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const anchor = medianOf(sorted.slice(0, Math.ceil(sorted.length / 2)));
  if (anchor <= 0) return null;
  let best = anchor;
  let bestScore = stepResidual(deltas, anchor);
  for (const candidate of sorted) {
    if (candidate < anchor * SEED_CANDIDATE_RANGE[0]) continue;
    if (candidate > anchor * SEED_CANDIDATE_RANGE[1]) break;
    const score = stepResidual(deltas, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Σ (delta / interval − nearest whole step)², steps never fewer than one. */
function stepResidual(deltas: readonly number[], interval: number): number {
  let total = 0;
  for (const delta of deltas) {
    const ratio = delta / interval;
    const residual = ratio - Math.max(1, Math.round(ratio));
    total += residual * residual;
  }
  return total;
}

export interface FrameGrid {
  /** Nominal frame interval (ms). */
  intervalMs: number;
  /** Cumulative whole frame steps from the first timestamp (steps[0] = 0). */
  steps: number[];
  /** Least-squares clock evaluated at each step (same length as the input). */
  alignedMs: number[];
}

/**
 * Re-expresses ascending timestamps on the frame grid: every frame gets a
 * whole step count (strictly increasing, so gaps stay gaps) and the aligned
 * clock is the least-squares fit of the raw timestamps against the steps.
 * Returns null when the grid cannot be measured (fewer than three
 * timestamps or no seed interval).
 *
 * The fit is iterated: each consecutive delta is rounded to a whole number
 * of steps (never fewer than one) against the seed interval, the clock is
 * fitted, and the deltas are re-read against the fitted rate. Per-delta
 * jitter below half an interval leaves the step counts unchanged, and the
 * fitted clock moves by at most the jitter's mean, so any quantity read on
 * the aligned clock is invariant to it. Dropped frames become multi-step
 * gaps exactly as the raw timestamps say they are.
 */
export function frameGrid(timestamps: readonly number[]): FrameGrid | null {
  if (timestamps.length < 3) return null;
  const seed = seedIntervalMs(timestamps);
  if (seed === null) return null;
  let interval = seed;
  let steps: number[] = [];
  let clock = { slope: seed, offset: timestamps[0] ?? 0 };
  for (let pass = 0; pass <= GRID_REFINEMENT_PASSES; pass += 1) {
    steps = [0];
    for (let index = 1; index < timestamps.length; index += 1) {
      const delta = (timestamps[index] ?? 0) - (timestamps[index - 1] ?? 0);
      steps.push((steps[index - 1] ?? 0) + Math.max(1, Math.round(delta / interval)));
    }
    clock = fitClock(timestamps, steps, interval);
    interval = clock.slope;
  }
  return {
    intervalMs: clock.slope,
    steps,
    alignedMs: steps.map((step) => clock.offset + clock.slope * step),
  };
}

function fitClock(
  timestamps: readonly number[],
  steps: readonly number[],
  fallbackSlope: number,
): { slope: number; offset: number } {
  const n = steps.length;
  const meanStep = steps.reduce((sum, value) => sum + value, 0) / n;
  const meanTime = timestamps.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < n; index += 1) {
    const ds = (steps[index] ?? 0) - meanStep;
    covariance += ds * ((timestamps[index] ?? 0) - meanTime);
    variance += ds * ds;
  }
  const slope = variance > 0 && covariance > 0 ? covariance / variance : fallbackSlope;
  return { slope, offset: meanTime - slope * meanStep };
}

/** Grid-aligned clock only; see frameGrid. */
export function gridAlignedTimestamps(timestamps: readonly number[]): number[] | null {
  return frameGrid(timestamps)?.alignedMs ?? null;
}

export interface SampleGap {
  /** Nominal frame interval the gap is measured against (ms). */
  intervalMs: number;
  /** Whole frame steps between the measured frames bracketing the reference (1 = adjacent frames). */
  gapFrames: number;
  /** Index of the last measured frame at or before the reference, when one exists. */
  beforeIndex: number | null;
  /** Index of the first measured frame at or after the reference, when one exists. */
  afterIndex: number | null;
  /** Distance from the reference to the nearest measured frame (ms). */
  nearestDeltaMs: number;
}

/**
 * The measured sampling gap around a reference time: the number of whole
 * frame steps between the last frame at-or-before and the first frame
 * at-or-after the reference (1 when they are adjacent frames, 0 when a
 * frame sits exactly on the reference). Bracketing and distance are read
 * on the grid-aligned clock, so sub-frame jitter cannot swap the bracket or
 * turn an adjacent pair into a "gap". A reference
 * outside the sampled range measures its distance to the nearest frame in
 * intervals, doubled (one-sided evidence). Null when the stream has no
 * measurable frame grid.
 */
export function sampleGapAt(timestamps: readonly number[], referenceMs: number): SampleGap | null {
  const grid = frameGrid(timestamps);
  if (grid === null) return null;
  let beforeIndex: number | null = null;
  let afterIndex: number | null = null;
  let nearestDelta = Number.POSITIVE_INFINITY;
  for (let index = 0; index < grid.alignedMs.length; index += 1) {
    const timestamp = grid.alignedMs[index] ?? 0;
    const delta = Math.abs(timestamp - referenceMs);
    if (delta < nearestDelta) nearestDelta = delta;
    if (timestamp <= referenceMs) beforeIndex = index;
    if (timestamp >= referenceMs && afterIndex === null) afterIndex = index;
  }
  if (!Number.isFinite(nearestDelta)) return null;
  const gapFrames =
    beforeIndex !== null && afterIndex !== null
      ? (grid.steps[afterIndex] ?? 0) - (grid.steps[beforeIndex] ?? 0)
      : (2 * nearestDelta) / grid.intervalMs;
  return {
    intervalMs: grid.intervalMs,
    gapFrames,
    beforeIndex,
    afterIndex,
    nearestDeltaMs: nearestDelta,
  };
}

const NOISE_REFERENCE_LANDMARKS: readonly string[] = [
  "left_shoulder",
  "right_shoulder",
  "left_hip",
  "right_hip",
];
const NOISE_MIN_VISIBILITY = 0.3;
const NOISE_MIN_SAMPLES = 8;
/**
 * Median |p_i − lerp(p_{i−1}, p_{i+1})| for i.i.d. per-axis noise σ on
 * equally spaced samples: the residual has per-axis variance 1.5σ², so its
 * magnitude is Rayleigh with scale σ√1.5 and median σ√1.5·√(2 ln 2).
 */
const RAYLEIGH_MEDIAN_SECOND_DIFFERENCE = Math.sqrt(1.5) * Math.sqrt(2 * Math.LN2);

/**
 * Per-axis positional noise scale (normalized image units) of the landmark
 * estimator, measured from the torso landmarks' second-difference roughness
 * over near-uniformly spaced consecutive triples. Torso joints move slowly
 * relative to the frame rate, so their linear-interpolation residual is
 * dominated by estimator noise; the median over the whole stream is robust
 * to the few frames of genuine torso acceleration during a swing.
 *
 * `aspectRatio` scales x into the same units as y (image heights) so the
 * result matches consumers that correct coordinate aspect. Null when fewer
 * than NOISE_MIN_SAMPLES residuals are measurable — absence of measurement
 * is never a noise estimate.
 */
export function positionalNoiseSigma(
  frames: readonly SampledPoseFrame[],
  aspectRatio = 1,
): number | null {
  const interval = nominalFrameIntervalMs(frames.map((frame) => frame.timestampMs));
  if (interval === null || interval <= 0) return null;
  const residuals: number[] = [];
  for (const name of NOISE_REFERENCE_LANDMARKS) {
    const tracked: Array<{ t: number; x: number; y: number }> = [];
    for (const frame of frames) {
      const mark = frame.landmarks.find((entry) => entry.name === name);
      if (!mark || mark.visibility < NOISE_MIN_VISIBILITY) continue;
      tracked.push({ t: frame.timestampMs, x: mark.x * aspectRatio, y: mark.y });
    }
    for (let index = 1; index < tracked.length - 1; index += 1) {
      const previous = tracked[index - 1];
      const current = tracked[index];
      const next = tracked[index + 1];
      if (!previous || !current || !next) continue;
      const dt1 = current.t - previous.t;
      const dt2 = next.t - current.t;
      if (dt1 <= 0 || dt2 <= 0) continue;
      if (dt1 > 1.5 * interval || dt2 > 1.5 * interval) continue;
      const weightPrevious = dt2 / (dt1 + dt2);
      const weightNext = dt1 / (dt1 + dt2);
      const dx = current.x - (previous.x * weightPrevious + next.x * weightNext);
      const dy = current.y - (previous.y * weightPrevious + next.y * weightNext);
      residuals.push(Math.hypot(dx, dy));
    }
  }
  if (residuals.length < NOISE_MIN_SAMPLES) return null;
  return medianOf(residuals) / RAYLEIGH_MEDIAN_SECOND_DIFFERENCE;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
