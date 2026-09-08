import type { CanonicalPoseFrame, PoseSequence } from '@pickle/swing-domain';
import type { CapturedClip } from './capture';

/**
 * Conservative admission for imported videos (W03-01).
 *
 * Guided capture records exactly one stroke because the temporal trigger
 * decided when to record. An imported clip carries no such decision: the
 * container may hold a whole rally, an idle player, or a stroke cut in half.
 * Admission answers, from measured evidence only, whether the clip is a
 * single analyzable stroke inside the supported media envelope:
 *
 * - `admitImportedMedia` — container envelope (duration, frame rate,
 *   dimensions, rotation, codec, track layout). Decided BEFORE the native
 *   pose extraction pass, so unsupported media never spends decode time.
 * - `admitImportedStrokeEvents` — single-stroke plausibility over the
 *   extracted pose sequence. Every distinct motion event is measured and
 *   exposed; zero events abstain, several comparable events abstain. The
 *   loudest motion is never silently chosen.
 * - `admitImportedClip` — both, in that order, plus sidecar/clip geometry
 *   and coverage consistency. Decided BEFORE any analysis permit is
 *   reserved, so a rejected clip never reaches charging.
 *
 * The event count is MONOTONIC in the evidence: adding motion to a clip can
 * only keep or raise the number of comparable events, never lower it. Events
 * are split at every genuine dip in wrist speed (so two strokes with a short
 * pause between them stay two), and cross-wrist grouping uses bounded peak
 * proximity only (so motion of the other wrist can never bridge two strokes
 * into one).
 *
 * Every rejection carries a precise machine reason plus a diagnostic detail;
 * `importAdmissionRejectionMessage` maps reasons to store-compliant player
 * guidance. Pure and deterministic: no I/O, no randomness, no clock.
 */

export const IMPORT_ADMISSION_VERSION = 'import-admission-1';

/**
 * The envelope admission enforces. Container limits mirror the native
 * `ProvisionalImportBudget` (60 s, 240 fps, 4096 px, 4096×2160 px) so the
 * JS gate and the Swift preflight never disagree about what is importable;
 * the frame-rate floor mirrors the capture envelope's degraded floor (15 fps)
 * that the pose-quality gate already refuses below.
 */
export const IMPORT_ADMISSION_LIMITS = Object.freeze({
  /** A stroke needs preparation and recovery around it to be measurable. */
  minDurationMs: 800,
  maxDurationMs: 60_000,
  minFps: 15,
  maxFps: 240,
  maxFrameDimension: 4096,
  maxFramePixels: 4096 * 2160,
  /** Sidecar timestamps may run this far past the container duration. */
  timelineToleranceMs: 50,
  /**
   * The clip may carry at most this much time without a tracked pose at its
   * start, at its end, or between two consecutive pose frames. Beyond it the
   * evidence no longer covers the clip it vouches for.
   */
  maxUntrackedSpanMs: 2500,
  minPoseFrames: 12,
  minLandmarkVisibility: 0.3,
  /** Wrist samples further apart than this are a tracking gap, not motion. */
  maxSampleGapMs: 150,
  smoothingWindow: 5,
  /** A wrist has a distinct stroke only when its peak clears the idle baseline by this factor. */
  distinctPeakRatio: 2.5,
  /** An event's span is cut where the smoothed speed drops below this fraction of its peak. */
  runFloorRatio: 0.12,
  /** Two adjacent speed peaks of one wrist are separate events when the speed between them falls below this fraction of the lesser peak. */
  eventValleyRatio: 0.5,
  /** An event needs at least this many samples to count as motion at all. */
  minRunSamples: 3,
  /** A candidate peaking at or above this fraction of the strongest peak is a comparable event. */
  comparablePeakRatio: 0.4,
  /** Peaks within this distance of an event's first peak belong to that event (contact dip, both wrists in one swing). */
  sameEventPeakDistanceMs: 350,
  /** A single stroke's motion core lasts at least this long; shorter bursts are tracking spikes. */
  minStrokeMotionMs: 150,
  /** A single stroke's continuous motion never lasts longer than this; two complete swings cannot fit. */
  maxStrokeMotionMs: 2000,
});

export const IMPORT_ADMISSION_REASONS = Object.freeze([
  'not_imported_clip',
  'duration_unknown',
  'duration_too_short',
  'duration_too_long',
  'frame_rate_unknown',
  'frame_rate_too_low',
  'frame_rate_too_high',
  'unsupported_dimensions',
  'unsupported_rotation',
  'unsupported_codec',
  'unsupported_track_layout',
  'pose_sequence_missing',
  'pose_geometry_mismatch',
  'pose_coverage_incomplete',
  'too_few_pose_frames',
  'wrist_not_tracked',
  'no_stroke_event',
  'multiple_stroke_events',
  'stroke_truncated_at_clip_edge',
  'motion_not_stroke_like',
] as const);

export type ImportAdmissionReason = (typeof IMPORT_ADMISSION_REASONS)[number];

/**
 * Container facts the native import preflight can report beyond what the
 * `CapturedClip` payload carries. Every field is optional: a field that was
 * not measured is not checked here (the native decoder already had to accept
 * the file to produce a pose sequence), while a field that IS reported must
 * be supported.
 */
export interface ImportedMediaProbe {
  /** Rotation encoded in the track's preferredTransform, in degrees. */
  rotationDegrees?: number;
  /** Video codec identifier — a FourCC (`avc1`, `hvc1`) or a name (`h264`, `hevc`). */
  codec?: string;
  /** Number of video tracks in the container. */
  videoTrackCount?: number;
}

export interface AdmittedImportedMedia {
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  /** Normalized to 0 | 90 | 180 | 270 when the probe reported a rotation. */
  rotationDegrees?: number;
  /** Lower-cased identifier when the probe reported a codec. */
  codec?: string;
}

export type WristName = 'left_wrist' | 'right_wrist';

/** One measured motion event of a wrist: a speed peak with the span around it. */
export interface StrokeEventCandidate {
  wrist: WristName;
  startMs: number;
  endMs: number;
  peakMs: number;
  /** Peak smoothed wrist speed, image heights per second. */
  peakSpeed: number;
  /** True when this candidate peaks within `comparablePeakRatio` of the strongest one. */
  comparable: boolean;
}

export interface AdmittedStrokeEvent {
  wrist: WristName;
  startMs: number;
  endMs: number;
  peakMs: number;
  peakSpeed: number;
}

export type ImportMediaAdmission =
  | {
      admitted: true;
      version: typeof IMPORT_ADMISSION_VERSION;
      media: AdmittedImportedMedia;
    }
  | {
      admitted: false;
      version: typeof IMPORT_ADMISSION_VERSION;
      reason: ImportAdmissionReason;
      detail: string;
    };

export type ImportStrokeAdmission =
  | {
      admitted: true;
      version: typeof IMPORT_ADMISSION_VERSION;
      event: AdmittedStrokeEvent;
      candidates: StrokeEventCandidate[];
      comparableEventCount: number;
    }
  | {
      admitted: false;
      version: typeof IMPORT_ADMISSION_VERSION;
      reason: ImportAdmissionReason;
      detail: string;
      candidates: StrokeEventCandidate[];
      comparableEventCount: number;
    };

export type ImportAdmission =
  | {
      admitted: true;
      version: typeof IMPORT_ADMISSION_VERSION;
      media: AdmittedImportedMedia;
      event: AdmittedStrokeEvent;
      candidates: StrokeEventCandidate[];
      comparableEventCount: number;
    }
  | {
      admitted: false;
      version: typeof IMPORT_ADMISSION_VERSION;
      reason: ImportAdmissionReason;
      detail: string;
      candidates: StrokeEventCandidate[];
      comparableEventCount: number;
    };

const SUPPORTED_CODECS: ReadonlySet<string> = new Set([
  'avc1',
  'h264',
  'hvc1',
  'hev1',
  'hevc',
]);

const CODEC_TAG = /^[a-z0-9]{1,8}$/;

function reject(
  reason: ImportAdmissionReason,
  detail: string,
): Extract<ImportMediaAdmission, { admitted: false }> {
  return { admitted: false, version: IMPORT_ADMISSION_VERSION, reason, detail };
}

function normalizeRotation(degrees: number): number | null {
  if (!Number.isFinite(degrees)) return null;
  const quarterTurns = degrees / 90;
  if (!Number.isSafeInteger(quarterTurns)) return null;
  return (((quarterTurns % 4) + 4) % 4) * 90;
}

/**
 * Container envelope gate. Runs on the imported `CapturedClip` (already
 * shape-validated by `assertCapturedClip`) before the pose extraction pass.
 */
export function admitImportedMedia(
  clip: CapturedClip,
  probe: ImportedMediaProbe = {},
): ImportMediaAdmission {
  if (clip.captureMode !== 'imported_video') {
    return reject(
      'not_imported_clip',
      `captureMode ${JSON.stringify(clip.captureMode)} is not an imported video.`,
    );
  }
  const limits = IMPORT_ADMISSION_LIMITS;
  if (!Number.isFinite(clip.durationMs)) {
    return reject(
      'duration_unknown',
      `durationMs ${String(clip.durationMs)} is not a measured duration.`,
    );
  }
  if (clip.durationMs < limits.minDurationMs) {
    return reject(
      'duration_too_short',
      `durationMs ${clip.durationMs} is below the ${limits.minDurationMs} ms minimum.`,
    );
  }
  if (clip.durationMs > limits.maxDurationMs) {
    return reject(
      'duration_too_long',
      `durationMs ${clip.durationMs} exceeds the ${limits.maxDurationMs} ms maximum.`,
    );
  }
  if (!Number.isFinite(clip.fps) || clip.fps <= 0) {
    return reject(
      'frame_rate_unknown',
      `fps ${String(clip.fps)} is not a measured frame rate.`,
    );
  }
  if (clip.fps < limits.minFps) {
    return reject(
      'frame_rate_too_low',
      `fps ${clip.fps} is below the ${limits.minFps} fps floor.`,
    );
  }
  if (clip.fps > limits.maxFps) {
    return reject(
      'frame_rate_too_high',
      `fps ${clip.fps} exceeds the ${limits.maxFps} fps ceiling.`,
    );
  }
  if (
    !Number.isInteger(clip.width) ||
    !Number.isInteger(clip.height) ||
    clip.width < 1 ||
    clip.height < 1 ||
    clip.width > limits.maxFrameDimension ||
    clip.height > limits.maxFrameDimension ||
    clip.width * clip.height > limits.maxFramePixels
  ) {
    return reject(
      'unsupported_dimensions',
      `${clip.width}x${clip.height} is outside the supported frame size ` +
        `(≤ ${limits.maxFrameDimension} px per side, ≤ ${limits.maxFramePixels} px total).`,
    );
  }

  const media: AdmittedImportedMedia = {
    durationMs: clip.durationMs,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
  };

  if (probe.rotationDegrees !== undefined) {
    const rotation = normalizeRotation(probe.rotationDegrees);
    if (rotation === null) {
      return reject(
        'unsupported_rotation',
        `rotation ${String(probe.rotationDegrees)}° is not a quarter turn (0/90/180/270).`,
      );
    }
    media.rotationDegrees = rotation;
  }
  if (probe.codec !== undefined) {
    const codec = probe.codec.toLowerCase();
    if (!CODEC_TAG.test(codec) || !SUPPORTED_CODECS.has(codec)) {
      return reject(
        'unsupported_codec',
        `codec ${JSON.stringify(probe.codec)} is not one of ${[...SUPPORTED_CODECS].join(', ')}.`,
      );
    }
    media.codec = codec;
  }
  if (
    probe.videoTrackCount !== undefined &&
    (!Number.isInteger(probe.videoTrackCount) || probe.videoTrackCount !== 1)
  ) {
    return reject(
      'unsupported_track_layout',
      `container has ${String(probe.videoTrackCount)} video tracks; exactly one is supported.`,
    );
  }

  return { admitted: true, version: IMPORT_ADMISSION_VERSION, media };
}

interface SpeedSample {
  timestampMs: number;
  value: number;
  /** True when a tracking gap separates this sample from the previous one. */
  gapBefore: boolean;
}

/**
 * Frame-to-frame speed of one wrist (image heights per second) on frames
 * where it was measured. Missing frames are skipped, never interpolated;
 * pairs further apart than `maxSampleGapMs` produce no sample and mark a gap.
 */
function wristSpeedSeries(
  frames: readonly CanonicalPoseFrame[],
  wrist: WristName,
  aspectRatio: number,
): SpeedSample[] {
  const limits = IMPORT_ADMISSION_LIMITS;
  const tracked: Array<{ timestampMs: number; x: number; y: number }> = [];
  for (const frame of frames) {
    const mark = frame.landmarks.find(entry => entry.name === wrist);
    if (
      !mark ||
      !Number.isFinite(mark.x) ||
      !Number.isFinite(mark.y) ||
      mark.visibility < limits.minLandmarkVisibility
    ) {
      continue;
    }
    tracked.push({
      timestampMs: frame.timestampMs,
      x: mark.x * aspectRatio,
      y: mark.y,
    });
  }
  const series: SpeedSample[] = [];
  let gapBefore = false;
  for (let index = 1; index < tracked.length; index += 1) {
    const previous = tracked[index - 1];
    const current = tracked[index];
    if (!previous || !current) continue;
    const dtMs = current.timestampMs - previous.timestampMs;
    if (dtMs <= 0 || dtMs > limits.maxSampleGapMs) {
      gapBefore = true;
      continue;
    }
    series.push({
      timestampMs: current.timestampMs,
      value:
        (Math.hypot(current.x - previous.x, current.y - previous.y) / dtMs) *
        1000,
      gapBefore,
    });
    gapBefore = false;
  }
  return series;
}

/** Centered moving average that never averages across a tracking gap. */
function movingAverage(
  series: readonly SpeedSample[],
  window: number,
): number[] {
  const half = Math.floor(Math.max(1, window) / 2);
  return series.map((_, index) => {
    let start = index;
    while (start > index - half && start > 0 && !series[start]?.gapBefore)
      start -= 1;
    let end = index + 1;
    while (end < index + half + 1 && end < series.length) {
      if (series[end]?.gapBefore) break;
      end += 1;
    }
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1)
      sum += series[cursor]?.value ?? 0;
    return sum / (end - start);
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const half = Math.floor(sorted.length / 2);
  const upper = sorted[half] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[half - 1] ?? upper) + upper) / 2;
}

interface WristMeasurement {
  wrist: WristName;
  series: SpeedSample[];
  smoothed: number[];
  peak: number;
  baseline: number;
  distinct: boolean;
}

function measureWrist(
  frames: readonly CanonicalPoseFrame[],
  wrist: WristName,
  aspectRatio: number,
): WristMeasurement | null {
  const limits = IMPORT_ADMISSION_LIMITS;
  const series = wristSpeedSeries(frames, wrist, aspectRatio);
  if (series.length < limits.minRunSamples) return null;
  const smoothed = movingAverage(series, limits.smoothingWindow);
  let peak = 0;
  for (const value of smoothed) if (value > peak) peak = value;
  const baseline = median(smoothed);
  const distinct = peak >= Math.max(baseline * limits.distinctPeakRatio, 1e-6);
  return { wrist, series, smoothed, peak, baseline, distinct };
}

/**
 * Indices of the local maxima of the smoothed series at or above `floor`.
 * A plateau counts once (its first index); a tracking gap starts a new
 * ascent, so the first sample after a gap can be a peak of its own.
 */
function localPeaks(
  series: readonly SpeedSample[],
  smoothed: readonly number[],
  floor: number,
): number[] {
  const peaks: number[] = [];
  let ascending = true;
  let plateauStart = 0;
  for (let index = 0; index < smoothed.length; index += 1) {
    const value = smoothed[index] ?? 0;
    if (index > 0 && series[index]?.gapBefore) {
      ascending = true;
      plateauStart = index;
    }
    const nextIndex = index + 1;
    const next =
      nextIndex < smoothed.length && !series[nextIndex]?.gapBefore
        ? (smoothed[nextIndex] ?? 0)
        : null;
    if (next === null || next < value) {
      if (ascending && value > 0 && value >= floor) peaks.push(plateauStart);
      ascending = false;
    } else if (next > value) {
      ascending = true;
      plateauStart = nextIndex;
    }
  }
  return peaks;
}

interface WristEvent {
  /** Indices of the smoothed-series peaks that belong to this event, ascending. */
  peakIndices: number[];
}

function minBetween(
  series: readonly SpeedSample[],
  smoothed: readonly number[],
  fromIndex: number,
  toIndex: number,
): { value: number; index: number; gap: boolean } {
  let value = Number.POSITIVE_INFINITY;
  let index = fromIndex;
  let gap = false;
  for (let cursor = fromIndex + 1; cursor <= toIndex; cursor += 1) {
    if (series[cursor]?.gapBefore) gap = true;
    const current = smoothed[cursor] ?? 0;
    if (current < value) {
      value = current;
      index = cursor;
    }
  }
  return { value, index, gap };
}

/**
 * Groups one wrist's peaks into events. A peak joins the open event only
 * when it lies within `sameEventPeakDistanceMs` of that event's FIRST peak
 * (a contact dip splits one stroke into two nearby maxima) or when the
 * speed between it and the previous peak never subsides below
 * `eventValleyRatio` of the lesser peak (one continuous movement). A quiet
 * pause of any length — including one shorter than a backswing — ends the
 * event, so two complete strokes are never fused into one.
 */
function groupPeaks(
  series: readonly SpeedSample[],
  smoothed: readonly number[],
  peakIndices: readonly number[],
): WristEvent[] {
  const limits = IMPORT_ADMISSION_LIMITS;
  const events: WristEvent[] = [];
  for (const peakIndex of peakIndices) {
    const open = events[events.length - 1];
    if (open) {
      const firstPeak = open.peakIndices[0] ?? peakIndex;
      const lastPeak =
        open.peakIndices[open.peakIndices.length - 1] ?? peakIndex;
      const valley = minBetween(series, smoothed, lastPeak, peakIndex);
      const peakDistanceMs =
        (series[peakIndex]?.timestampMs ?? 0) -
        (series[firstPeak]?.timestampMs ?? 0);
      const lesserPeak = Math.min(
        smoothed[lastPeak] ?? 0,
        smoothed[peakIndex] ?? 0,
      );
      const continuous = valley.value > lesserPeak * limits.eventValleyRatio;
      if (
        !valley.gap &&
        (peakDistanceMs <= limits.sameEventPeakDistanceMs || continuous)
      ) {
        open.peakIndices.push(peakIndex);
        continue;
      }
    }
    events.push({ peakIndices: [peakIndex] });
  }
  return events;
}

interface MeasuredCandidate extends StrokeEventCandidate {
  touchesSeriesStart: boolean;
  touchesSeriesEnd: boolean;
}

/**
 * Every motion event of one wrist with its measured span. The span extends
 * from the event's peaks outward while the smoothed speed stays at or above
 * `runFloorRatio` of the event peak, never across a tracking gap and never
 * past the speed minimum that separates it from a neighbouring event.
 */
function candidatesFor(measurement: WristMeasurement): MeasuredCandidate[] {
  const limits = IMPORT_ADMISSION_LIMITS;
  const { series, smoothed } = measurement;
  const floor = measurement.peak * limits.runFloorRatio;
  const events = groupPeaks(
    series,
    smoothed,
    localPeaks(series, smoothed, floor),
  );
  const candidates: MeasuredCandidate[] = [];
  events.forEach((event, position) => {
    const firstPeak = event.peakIndices[0] ?? 0;
    const lastPeak = event.peakIndices[event.peakIndices.length - 1] ?? 0;
    let peakIndex = firstPeak;
    for (const index of event.peakIndices) {
      if ((smoothed[index] ?? 0) > (smoothed[peakIndex] ?? 0))
        peakIndex = index;
    }
    const eventFloor = (smoothed[peakIndex] ?? 0) * limits.runFloorRatio;
    const previous = events[position - 1];
    const next = events[position + 1];
    const leftBound = previous
      ? minBetween(
          series,
          smoothed,
          previous.peakIndices[previous.peakIndices.length - 1] ?? 0,
          firstPeak,
        ).index
      : 0;
    const rightBound = next
      ? minBetween(series, smoothed, lastPeak, next.peakIndices[0] ?? lastPeak)
          .index
      : smoothed.length - 1;
    let startIndex = firstPeak;
    while (
      startIndex > leftBound &&
      !series[startIndex]?.gapBefore &&
      (smoothed[startIndex - 1] ?? 0) >= eventFloor
    ) {
      startIndex -= 1;
    }
    let endIndex = lastPeak;
    while (
      endIndex < rightBound &&
      !series[endIndex + 1]?.gapBefore &&
      (smoothed[endIndex + 1] ?? 0) >= eventFloor
    ) {
      endIndex += 1;
    }
    if (endIndex - startIndex + 1 < limits.minRunSamples) return;
    candidates.push({
      wrist: measurement.wrist,
      startMs: series[startIndex]?.timestampMs ?? 0,
      endMs: series[endIndex]?.timestampMs ?? 0,
      peakMs: series[peakIndex]?.timestampMs ?? 0,
      peakSpeed: smoothed[peakIndex] ?? 0,
      comparable: false,
      touchesSeriesStart: startIndex === 0,
      touchesSeriesEnd: endIndex === smoothed.length - 1,
    });
  });
  return candidates;
}

/**
 * Groups comparable candidates (already sorted by peak time) into physical
 * events using bounded peak proximity only: a candidate joins the open
 * cluster when its peak lies within `sameEventPeakDistanceMs` of the
 * cluster's FIRST peak. This is the minimum number of fixed-width windows
 * covering the peaks, so adding a candidate can never reduce the count —
 * one wrist's motion cannot bridge two strokes of the other wrist.
 */
function clusterComparable(
  candidates: readonly MeasuredCandidate[],
): MeasuredCandidate[][] {
  const limits = IMPORT_ADMISSION_LIMITS;
  const clusters: MeasuredCandidate[][] = [];
  for (const candidate of candidates) {
    const open = clusters[clusters.length - 1];
    const anchor = open?.[0];
    if (
      open &&
      anchor &&
      candidate.peakMs - anchor.peakMs <= limits.sameEventPeakDistanceMs
    ) {
      open.push(candidate);
    } else {
      clusters.push([candidate]);
    }
  }
  return clusters;
}

function publicCandidate(candidate: MeasuredCandidate): StrokeEventCandidate {
  return {
    wrist: candidate.wrist,
    startMs: candidate.startMs,
    endMs: candidate.endMs,
    peakMs: candidate.peakMs,
    peakSpeed: candidate.peakSpeed,
    comparable: candidate.comparable,
  };
}

/**
 * Single-stroke plausibility over the extracted pose sequence. Exactly one
 * distinct, comparable, edge-free, stroke-length motion event is admitted;
 * everything else is a precise abstention. All measured candidates are
 * returned so callers can show WHY, never just "the biggest one".
 */
export function admitImportedStrokeEvents(
  sequence: PoseSequence,
): ImportStrokeAdmission {
  const limits = IMPORT_ADMISSION_LIMITS;
  const version = IMPORT_ADMISSION_VERSION;
  const frames = sequence.frames;
  if (frames.length < limits.minPoseFrames) {
    return {
      admitted: false,
      version,
      reason: 'too_few_pose_frames',
      detail: `${frames.length} pose frames; at least ${limits.minPoseFrames} are required.`,
      candidates: [],
      comparableEventCount: 0,
    };
  }
  const aspectRatio =
    sequence.video.height > 0
      ? sequence.video.width / sequence.video.height
      : 1;
  const measurements = (['right_wrist', 'left_wrist'] as const)
    .map(wrist => measureWrist(frames, wrist, aspectRatio))
    .filter((entry): entry is WristMeasurement => entry !== null);
  if (measurements.length === 0) {
    return {
      admitted: false,
      version,
      reason: 'wrist_not_tracked',
      detail:
        'Neither wrist was measured on enough consecutive frames to detect a stroke.',
      candidates: [],
      comparableEventCount: 0,
    };
  }

  const measured = measurements
    .filter(measurement => measurement.distinct)
    .flatMap(candidatesFor)
    .sort(
      (left, right) =>
        left.peakMs - right.peakMs || left.wrist.localeCompare(right.wrist),
    );
  let strongest = 0;
  for (const candidate of measured)
    if (candidate.peakSpeed > strongest) strongest = candidate.peakSpeed;
  for (const candidate of measured) {
    candidate.comparable =
      strongest > 0 &&
      candidate.peakSpeed >= strongest * limits.comparablePeakRatio;
  }
  const candidates = measured.map(publicCandidate);
  const clusters = clusterComparable(
    measured.filter(candidate => candidate.comparable),
  );
  const comparableEventCount = clusters.length;

  if (comparableEventCount === 0) {
    return {
      admitted: false,
      version,
      reason: 'no_stroke_event',
      detail:
        'Wrist motion has no distinct stroke peak above the idle baseline ' +
        `(${measurements.map(m => `${m.wrist}: peak ${m.peak.toFixed(3)}, baseline ${m.baseline.toFixed(3)}`).join('; ')}).`,
      candidates,
      comparableEventCount,
    };
  }
  if (comparableEventCount > 1) {
    const peaks = clusters.map(cluster => {
      const lead = cluster.reduce((best, member) =>
        member.peakSpeed > best.peakSpeed ? member : best,
      );
      return `${lead.wrist} @ ${lead.peakMs} ms (${lead.peakSpeed.toFixed(3)})`;
    });
    return {
      admitted: false,
      version,
      reason: 'multiple_stroke_events',
      detail: `${comparableEventCount} comparable stroke events measured: ${peaks.join(', ')}.`,
      candidates,
      comparableEventCount,
    };
  }

  const cluster = clusters[0] ?? [];
  const lead = cluster.reduce<MeasuredCandidate | null>(
    (best, member) =>
      best === null || member.peakSpeed > best.peakSpeed ? member : best,
    null,
  );
  if (!lead) {
    return {
      admitted: false,
      version,
      reason: 'no_stroke_event',
      detail: 'No comparable stroke event could be measured.',
      candidates,
      comparableEventCount: 0,
    };
  }
  const startMs = Math.min(...cluster.map(member => member.startMs));
  const endMs = Math.max(...cluster.map(member => member.endMs));
  if (
    cluster.some(member => member.touchesSeriesStart || member.touchesSeriesEnd)
  ) {
    return {
      admitted: false,
      version,
      reason: 'stroke_truncated_at_clip_edge',
      detail: `Stroke motion (${startMs}–${endMs} ms) runs into the ${cluster.some(m => m.touchesSeriesStart) ? 'first' : 'last'} tracked frame; the swing is not fully inside the clip.`,
      candidates,
      comparableEventCount,
    };
  }
  if (endMs - startMs > limits.maxStrokeMotionMs) {
    return {
      admitted: false,
      version,
      reason: 'motion_not_stroke_like',
      detail: `Motion core lasts ${endMs - startMs} ms; a single stroke stays under ${limits.maxStrokeMotionMs} ms.`,
      candidates,
      comparableEventCount,
    };
  }
  if (endMs - startMs < limits.minStrokeMotionMs) {
    return {
      admitted: false,
      version,
      reason: 'motion_not_stroke_like',
      detail: `Motion core lasts ${endMs - startMs} ms; a single stroke lasts at least ${limits.minStrokeMotionMs} ms.`,
      candidates,
      comparableEventCount,
    };
  }
  return {
    admitted: true,
    version,
    event: {
      wrist: lead.wrist,
      startMs,
      endMs,
      peakMs: lead.peakMs,
      peakSpeed: lead.peakSpeed,
    },
    candidates,
    comparableEventCount,
  };
}

/** Longest stretch of the clip without a tracked pose: lead-in, tail, or an interior gap. */
function longestUntrackedSpanMs(
  frames: readonly CanonicalPoseFrame[],
  durationMs: number,
): number {
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!first || !last) return durationMs;
  let longest = Math.max(first.timestampMs, durationMs - last.timestampMs);
  for (let index = 1; index < frames.length; index += 1) {
    const gap =
      (frames[index]?.timestampMs ?? 0) - (frames[index - 1]?.timestampMs ?? 0);
    if (gap > longest) longest = gap;
  }
  return longest;
}

/**
 * Full admission for an imported clip whose extraction pass produced
 * `sequence` (already hash-verified and canonically parsed by the caller).
 * Container envelope first, then sidecar/clip consistency (frame geometry,
 * frame rate, frame count, timeline, coverage), then stroke plausibility — a
 * rejected clip must never reach a permit reservation.
 */
export function admitImportedClip(
  clip: CapturedClip,
  sequence: PoseSequence,
  probe: ImportedMediaProbe = {},
): ImportAdmission {
  const media = admitImportedMedia(clip, probe);
  if (!media.admitted) {
    return { ...media, candidates: [], comparableEventCount: 0 };
  }
  const version = IMPORT_ADMISSION_VERSION;
  const limits = IMPORT_ADMISSION_LIMITS;
  if (clip.captureMode !== 'imported_video' || !clip.poseSequence) {
    return {
      admitted: false,
      version,
      reason: 'pose_sequence_missing',
      detail: 'The imported clip carries no extracted pose-sequence sidecar.',
      candidates: [],
      comparableEventCount: 0,
    };
  }
  const firstFrame = sequence.frames[0];
  const lastFrame = sequence.frames[sequence.frames.length - 1];
  const geometryMismatch =
    sequence.video.width !== clip.width ||
    sequence.video.height !== clip.height ||
    sequence.video.fps !== clip.fps ||
    sequence.frames.length !== clip.poseSequence.frameCount ||
    (firstFrame !== undefined && firstFrame.timestampMs < 0) ||
    (lastFrame !== undefined &&
      lastFrame.timestampMs > clip.durationMs + limits.timelineToleranceMs);
  if (geometryMismatch) {
    return {
      admitted: false,
      version,
      reason: 'pose_geometry_mismatch',
      detail:
        `Sidecar ${sequence.video.width}x${sequence.video.height} @ ${sequence.video.fps} fps, ` +
        `${sequence.frames.length} frames, stamps ${firstFrame?.timestampMs ?? 0}–${lastFrame?.timestampMs ?? 0} ms ` +
        `does not fit clip ${clip.width}x${clip.height} @ ${clip.fps} fps, ` +
        `${clip.poseSequence.frameCount} recorded frames, ${clip.durationMs} ms.`,
      candidates: [],
      comparableEventCount: 0,
    };
  }
  const untrackedMs = longestUntrackedSpanMs(sequence.frames, clip.durationMs);
  if (untrackedMs > limits.maxUntrackedSpanMs) {
    return {
      admitted: false,
      version,
      reason: 'pose_coverage_incomplete',
      detail:
        `The clip carries ${Math.round(untrackedMs)} ms without a tracked pose ` +
        `(at most ${limits.maxUntrackedSpanMs} ms is admissible); the evidence does not cover the clip.`,
      candidates: [],
      comparableEventCount: 0,
    };
  }
  const events = admitImportedStrokeEvents(sequence);
  if (!events.admitted) return events;
  return {
    admitted: true,
    version,
    media: media.media,
    event: events.event,
    candidates: events.candidates,
    comparableEventCount: events.comparableEventCount,
  };
}

/** Player-facing guidance for a rejection. Honest and actionable; no claims. */
export function importAdmissionRejectionMessage(
  reason: ImportAdmissionReason,
): string {
  switch (reason) {
    case 'not_imported_clip':
      return 'This recording was not imported from your library, so import checks do not apply to it.';
    case 'duration_unknown':
      return 'The length of this video could not be read, so it cannot be analyzed. Try exporting it again from your library.';
    case 'duration_too_short':
      return 'This video is too short to analyze. Use a clip that shows the whole stroke, from setup through follow-through.';
    case 'duration_too_long':
      return 'This video is too long to analyze. Trim it to 60 seconds or less — ideally a few seconds around one stroke — and import it again.';
    case 'frame_rate_unknown':
      return 'The frame rate of this video could not be read, so it cannot be analyzed. Try exporting it again from your library.';
    case 'frame_rate_too_low':
      return 'This video has too few frames per second to measure a stroke. Use a clip recorded at a standard frame rate, such as 30 or 60 fps.';
    case 'frame_rate_too_high':
      return 'This video has more frames per second than can be analyzed. Export it at 240 fps or lower and import it again.';
    case 'unsupported_dimensions':
      return 'This video is larger than what can be analyzed. Export it at 4K or lower and import it again.';
    case 'unsupported_rotation':
      return 'The orientation of this video could not be read reliably. Export it again with a standard portrait or landscape orientation.';
    case 'unsupported_codec':
      return 'This video uses a format that cannot be analyzed. Export it as H.264 or HEVC and import it again.';
    case 'unsupported_track_layout':
      return 'This file does not contain exactly one video track, so it cannot be analyzed. Export it as a single video and import it again.';
    case 'pose_sequence_missing':
      return 'Player movement has not been read from this video yet, so it cannot be scored.';
    case 'pose_geometry_mismatch':
      return 'The movement read from this video does not match the video itself. Import the clip again to re-read it.';
    case 'pose_coverage_incomplete':
      return 'The player could not be tracked through part of this video, so it cannot be checked for a single stroke. Trim it to a few seconds around one swing where the player stays in view.';
    case 'too_few_pose_frames':
      return 'Too little of the player was tracked to measure a stroke. Use a clip where the player is clearly visible for the whole swing.';
    case 'wrist_not_tracked':
      return 'The hitting arm could not be tracked in this video. Use a clip where the player and paddle arm stay fully in frame.';
    case 'no_stroke_event':
      return 'No stroke was found in this video. Import a clip that shows one full swing.';
    case 'multiple_stroke_events':
      return 'This video contains more than one stroke. Trim it to a single stroke — a few seconds around one swing — and import it again.';
    case 'stroke_truncated_at_clip_edge':
      return 'The stroke starts or ends outside this video. Use a clip with a moment of setup before the swing and recovery after it.';
    case 'motion_not_stroke_like':
      return 'The movement in this video does not look like a single stroke. Import a clip that shows one swing rather than continuous play.';
  }
}
