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
 * only keep or raise the number of comparable events, never lower it. Every
 * judgement is ABSOLUTE, in torso lengths per second and milliseconds of the
 * player's own body and clip — never relative to a whole-wrist baseline or
 * to the loudest motion in the clip, both of which extra motion could move.
 * Events are split at every genuine dip in wrist speed (so two strokes with
 * a short pause between them stay two) and at every peak more than a
 * contact-dip apart (so a fast hand battle whose speed never subsides is
 * still several volleys), cross-wrist grouping uses bounded peak proximity
 * only (so motion of the other wrist can never bridge two strokes into
 * one), and a candidate is comparable when it peaks at or above
 * `minComparablePeakTorsoPerSecond` on its own evidence. The only motion
 * folded into a stroke is its wind-up and recovery: a slower burst that is
 * continuous with the stroke and travels AGAINST it — the geometry of a
 * backswing — never a burst in the stroke's own direction, which is a
 * second, softer stroke.
 *
 * Every rejection carries a precise machine reason plus a diagnostic detail;
 * `importAdmissionRejectionMessage` maps reasons to store-compliant player
 * guidance. Pure and deterministic: no I/O, no randomness, no clock.
 */

export const IMPORT_ADMISSION_VERSION = 'import-admission-1';

/**
 * The envelope admission enforces. Container limits mirror the native
 * `ProvisionalImportBudget` (60 s, 240 fps, 4096 px, 4096×2160 px) so the
 * JS gate and the Swift preflight never disagree about what is importable.
 * There is deliberately no declared-frame-rate floor: a low but measured
 * frame rate belongs to the quantization-aware pose-quality floor
 * (`insufficient_fps`), which judges the recorded timestamps rather than
 * container metadata such as 23.976 fps.
 */
export const IMPORT_ADMISSION_LIMITS = Object.freeze({
  /** A stroke needs preparation and recovery around it to be measurable. */
  minDurationMs: 800,
  maxDurationMs: 60_000,
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
  /**
   * Wrist speed is smoothed over this much time (a centred window), so the
   * smoothing spans the same slice of the swing at 12 fps as at 240 fps —
   * a sample-count window would flatten the valleys between a slow clip's
   * strokes.
   */
  smoothingSpanMs: 85,
  /** An event's span is cut where the smoothed speed drops below this fraction of its peak. */
  runFloorRatio: 0.12,
  /** Two speed peaks of one wrist a contact dip apart are one event only while the speed between them stays above this fraction of the lesser peak. */
  eventValleyRatio: 0.5,
  /**
   * Two speed peaks of one wrist further apart than a contact dip are
   * distinct events only when the speed between them drops at least this
   * much, in torso lengths per second, below the lesser peak. Smaller dips
   * are jitter on one movement (a steady walk, a slow sweep). Absolute on
   * purpose: motion added evenly to a clip raises peaks and valleys alike,
   * so it can never fuse two strokes into one.
   */
  minPeakProminenceTorsoPerSecond: 1.5,
  /** An event needs at least this many samples to count as motion at all. */
  minRunSamples: 3,
  /** Body scale needs at least this many frames with both shoulders and both hips tracked. */
  minTorsoSamples: 4,
  /**
   * A wrist peaking at or above this speed, in torso lengths per second, is
   * a stroke-sized event on its own evidence. A lone event below it is not
   * admitted as a stroke.
   */
  minStrokePeakTorsoPerSecond: 4,
  /**
   * A motion event peaking at or above this speed, in torso lengths per
   * second, is a comparable event: a movement a player could mean as a
   * stroke (a dink, a block, a reset). Absolute on purpose: measured against
   * the player's body, never against the loudest motion elsewhere in the
   * clip, so a harder stroke can never demote a softer one.
   */
  minComparablePeakTorsoPerSecond: 2,
  /**
   * A speed peak below this, in torso lengths per second, is idle jitter and
   * not a motion event at all.
   */
  minCandidatePeakTorsoPerSecond: 1,
  /** Peaks within this distance of an event's first peak belong to that event (contact dip, both wrists in one swing). */
  sameEventPeakDistanceMs: 350,
  /**
   * A wind-up or recovery peaks at most at this fraction of its stroke's
   * peak speed (and always below `minStrokePeakTorsoPerSecond`). A burst
   * faster than that is a stroke in its own right.
   */
  maxWindUpPeakRatio: 0.5,
  /**
   * A wind-up ends, or a recovery begins, within this much time of the
   * stroke's motion span. A longer pause separates two movements.
   */
  maxWindUpPauseMs: 400,
  /**
   * A wind-up, a recovery and the stroke itself each travel at least this
   * far, in torso lengths, along their net direction. Motion that goes
   * nowhere has no direction to be opposite to.
   */
  minDirectedTravelTorso: 0.2,
  /**
   * Cosine between the net travel of a wind-up (or recovery) and the net
   * travel of the stroke must be at most this negative: a backswing moves
   * against the swing it prepares, a recovery returns against it.
   */
  maxWindUpDirectionCosine: -0.3,
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
  'body_scale_unmeasured',
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
  /** The same peak in torso lengths per second — body-scale independent. */
  peakTorsoPerSecond: number;
  /**
   * True when this candidate is a comparable event: it peaks at or above
   * `minComparablePeakTorsoPerSecond` and is not the wind-up or recovery of
   * a neighbouring stroke. Both judgements use only this candidate and its
   * immediate neighbour, so a louder stroke elsewhere in the clip never
   * demotes this one.
   */
  comparable: boolean;
}

export interface AdmittedStrokeEvent {
  wrist: WristName;
  startMs: number;
  endMs: number;
  peakMs: number;
  peakSpeed: number;
  peakTorsoPerSecond: number;
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
  /** Wrist position at this sample, aspect-corrected image heights. */
  x: number;
  y: number;
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
      x: current.x,
      y: current.y,
      gapBefore,
    });
    gapBefore = false;
  }
  return series;
}

/** Samples on each side of the centre that fit in `smoothingSpanMs`. */
function smoothingHalfWindow(series: readonly SpeedSample[]): number {
  const intervals: number[] = [];
  for (let index = 1; index < series.length; index += 1) {
    const current = series[index];
    const previous = series[index - 1];
    if (!current || !previous || current.gapBefore) continue;
    intervals.push(current.timestampMs - previous.timestampMs);
  }
  const interval = median(intervals);
  if (!(interval > 0)) return 0;
  return Math.floor(IMPORT_ADMISSION_LIMITS.smoothingSpanMs / 2 / interval);
}

/** Centered moving average that never averages across a tracking gap. */
function movingAverage(series: readonly SpeedSample[], half: number): number[] {
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

function landmarkPoint(
  frame: CanonicalPoseFrame,
  name: string,
  aspectRatio: number,
): { x: number; y: number } | null {
  const mark = frame.landmarks.find(entry => entry.name === name);
  if (
    !mark ||
    !Number.isFinite(mark.x) ||
    !Number.isFinite(mark.y) ||
    mark.visibility < IMPORT_ADMISSION_LIMITS.minLandmarkVisibility
  )
    return null;
  return { x: mark.x * aspectRatio, y: mark.y };
}

/**
 * Median shoulder-centre to hip-centre distance (image heights) over the
 * frames where both pairs are tracked — the same body scale the feature
 * extractor uses, so wrist speeds can be judged per torso length rather than
 * per image height. Null when too few frames carry a measurable torso.
 */
function medianTorsoLength(
  frames: readonly CanonicalPoseFrame[],
  aspectRatio: number,
): number | null {
  const samples: number[] = [];
  for (const frame of frames) {
    const leftShoulder = landmarkPoint(frame, 'left_shoulder', aspectRatio);
    const rightShoulder = landmarkPoint(frame, 'right_shoulder', aspectRatio);
    const leftHip = landmarkPoint(frame, 'left_hip', aspectRatio);
    const rightHip = landmarkPoint(frame, 'right_hip', aspectRatio);
    if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) continue;
    samples.push(
      Math.hypot(
        (leftShoulder.x + rightShoulder.x - leftHip.x - rightHip.x) / 2,
        (leftShoulder.y + rightShoulder.y - leftHip.y - rightHip.y) / 2,
      ),
    );
  }
  if (samples.length < IMPORT_ADMISSION_LIMITS.minTorsoSamples) return null;
  const torso = median(samples);
  return Number.isFinite(torso) && torso >= 1e-4 ? torso : null;
}

interface WristMeasurement {
  wrist: WristName;
  series: SpeedSample[];
  smoothed: number[];
  peak: number;
}

function measureWrist(
  frames: readonly CanonicalPoseFrame[],
  wrist: WristName,
  aspectRatio: number,
): WristMeasurement | null {
  const limits = IMPORT_ADMISSION_LIMITS;
  const series = wristSpeedSeries(frames, wrist, aspectRatio);
  if (series.length < limits.minRunSamples) return null;
  const smoothed = movingAverage(series, smoothingHalfWindow(series));
  let peak = 0;
  for (const value of smoothed) if (value > peak) peak = value;
  return { wrist, series, smoothed, peak };
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
  /** Index of the event's highest peak so far. */
  maxIndex: number;
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
 * when no tracking gap separates them and either it lies within
 * `sameEventPeakDistanceMs` of that event's FIRST peak with the speed
 * between never subsiding below `eventValleyRatio` of the lesser peak (the
 * two maxima a contact dip cuts one swing into), or the speed between never
 * drops `minPeakProminenceTorsoPerSecond` below the lesser peak (jitter on
 * one movement). The valley and the lesser peak are always measured
 * against the event's HIGHEST peak, so a run of jitter peaks on a plateau
 * can never chain two strokes together. A quiet pause of any length ends
 * the event, so two complete strokes are never fused into one; and a real
 * dip between peaks further apart than a contact dip ends it however high
 * the speed stays, so a fast hand battle is as many events as it has
 * volleys.
 */
function groupPeaks(
  series: readonly SpeedSample[],
  smoothed: readonly number[],
  peakIndices: readonly number[],
  torsoLength: number,
): WristEvent[] {
  const limits = IMPORT_ADMISSION_LIMITS;
  const events: WristEvent[] = [];
  for (const peakIndex of peakIndices) {
    const open = events[events.length - 1];
    if (open) {
      const firstPeak = open.peakIndices[0] ?? peakIndex;
      const valley = minBetween(series, smoothed, open.maxIndex, peakIndex);
      const peakDistanceMs =
        (series[peakIndex]?.timestampMs ?? 0) -
        (series[firstPeak]?.timestampMs ?? 0);
      const lesserPeak = Math.min(
        smoothed[open.maxIndex] ?? 0,
        smoothed[peakIndex] ?? 0,
      );
      const contactDip =
        peakDistanceMs <= limits.sameEventPeakDistanceMs &&
        valley.value > lesserPeak * limits.eventValleyRatio;
      const jitter =
        lesserPeak - valley.value <
        torsoLength * limits.minPeakProminenceTorsoPerSecond;
      if (!valley.gap && (contactDip || jitter)) {
        open.peakIndices.push(peakIndex);
        if ((smoothed[peakIndex] ?? 0) > (smoothed[open.maxIndex] ?? 0))
          open.maxIndex = peakIndex;
        continue;
      }
    }
    events.push({ peakIndices: [peakIndex], maxIndex: peakIndex });
  }
  return events;
}

interface Point {
  x: number;
  y: number;
}

interface MeasuredCandidate extends StrokeEventCandidate {
  startIndex: number;
  endIndex: number;
  /** The span begins at the first tracked sample or right after a tracking gap. */
  touchesSeriesStart: boolean;
  /** The span ends at the last tracked sample or right before a tracking gap. */
  touchesSeriesEnd: boolean;
  /** Wrist position where the span begins, peaks and ends. */
  startPoint: Point;
  peakPoint: Point;
  endPoint: Point;
  /** 'stroke' once this candidate has absorbed a wind-up or recovery; 'wind_up' / 'recovery' once absorbed. */
  role: 'motion' | 'stroke' | 'wind_up' | 'recovery';
  /** The stroke this candidate is the wind-up or recovery of, once absorbed. */
  phaseOf: MeasuredCandidate | null;
}

/**
 * Every motion event of one wrist with its measured span. Peaks count from
 * `minCandidatePeakTorsoPerSecond` upward. The span extends from the event's
 * peaks outward while the smoothed speed stays at or above `runFloorRatio`
 * of the event peak, never across a tracking gap and never past the speed
 * minimum that separates it from a neighbouring event.
 */
function candidatesFor(
  measurement: WristMeasurement,
  torsoLength: number,
): MeasuredCandidate[] {
  const limits = IMPORT_ADMISSION_LIMITS;
  const { series, smoothed } = measurement;
  const floor = torsoLength * limits.minCandidatePeakTorsoPerSecond;
  const events = groupPeaks(
    series,
    smoothed,
    localPeaks(series, smoothed, floor),
    torsoLength,
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
    // Each sample's position is where its speed interval ENDS, so the span's
    // travel starts at the sample before it (when no gap separates them).
    const startSample =
      startIndex > 0 && !series[startIndex]?.gapBefore
        ? series[startIndex - 1]
        : series[startIndex];
    const peakSample = series[peakIndex];
    const endSample = series[endIndex];
    if (!startSample || !peakSample || !endSample) return;
    candidates.push({
      wrist: measurement.wrist,
      startMs: series[startIndex]?.timestampMs ?? 0,
      endMs: endSample.timestampMs,
      peakMs: peakSample.timestampMs,
      peakSpeed: smoothed[peakIndex] ?? 0,
      peakTorsoPerSecond: (smoothed[peakIndex] ?? 0) / torsoLength,
      comparable: false,
      startIndex,
      endIndex,
      touchesSeriesStart:
        startIndex === 0 || (series[startIndex]?.gapBefore ?? false),
      touchesSeriesEnd:
        endIndex === smoothed.length - 1 ||
        (series[endIndex + 1]?.gapBefore ?? false),
      startPoint: { x: startSample.x, y: startSample.y },
      peakPoint: { x: peakSample.x, y: peakSample.y },
      endPoint: { x: endSample.x, y: endSample.y },
      role: 'motion',
      phaseOf: null,
    });
  });
  foldStrokePhases(candidates, series, torsoLength);
  return candidates;
}

function travel(from: Point, to: Point): Point {
  return { x: to.x - from.x, y: to.y - from.y };
}

/** Cosine of the angle between two travels; 1 when either has no length (never "opposite"). */
function directionCosine(left: Point, right: Point): number {
  const norms = Math.hypot(left.x, left.y) * Math.hypot(right.x, right.y);
  if (!(norms > 0)) return 1;
  return (left.x * right.x + left.y * right.y) / norms;
}

function hasGapBetween(
  series: readonly SpeedSample[],
  fromIndex: number,
  toIndex: number,
): boolean {
  for (let cursor = fromIndex + 1; cursor <= toIndex; cursor += 1)
    if (series[cursor]?.gapBefore) return true;
  return false;
}

/**
 * Whether `phase` is the wind-up (before) or recovery (after) of `stroke`:
 * a slower burst — at most `maxWindUpPeakRatio` of the stroke's peak and
 * below the absolute `minStrokePeakTorsoPerSecond`, since a stroke-sized
 * burst is a stroke wherever it sits — continuous with the stroke's span
 * within `maxWindUpPauseMs` and with no tracking gap between, whose net
 * travel runs AGAINST the stroke's net travel. Both travels must cover `minDirectedTravelTorso`: motion without
 * net displacement has no direction, and a burst in the stroke's own
 * direction is another stroke.
 */
function isStrokePhase(
  stroke: MeasuredCandidate,
  phase: MeasuredCandidate,
  side: 'wind_up' | 'recovery',
  series: readonly SpeedSample[],
  torsoLength: number,
): boolean {
  const limits = IMPORT_ADMISSION_LIMITS;
  if (phase.peakSpeed > stroke.peakSpeed * limits.maxWindUpPeakRatio)
    return false;
  if (phase.peakTorsoPerSecond >= limits.minStrokePeakTorsoPerSecond)
    return false;
  const pauseMs =
    side === 'wind_up'
      ? stroke.startMs - phase.endMs
      : phase.startMs - stroke.endMs;
  if (pauseMs > limits.maxWindUpPauseMs) return false;
  const gap =
    side === 'wind_up'
      ? hasGapBetween(series, phase.endIndex, stroke.startIndex)
      : hasGapBetween(series, stroke.endIndex, phase.startIndex);
  if (gap) return false;
  const minTravel = torsoLength * limits.minDirectedTravelTorso;
  const phaseTravel = travel(phase.startPoint, phase.endPoint);
  const strokeTravel = travel(stroke.startPoint, stroke.endPoint);
  if (
    Math.hypot(phaseTravel.x, phaseTravel.y) < minTravel ||
    Math.hypot(strokeTravel.x, strokeTravel.y) < minTravel
  )
    return false;
  return (
    directionCosine(phaseTravel, strokeTravel) <=
    limits.maxWindUpDirectionCosine
  );
}

/**
 * Folds each stroke-sized candidate's immediate neighbours into it when they
 * are its wind-up and recovery (`isStrokePhase`). Strokes are visited from
 * the fastest down; a candidate absorbs at most one neighbour on each side,
 * and a candidate that has absorbed a phase is a stroke and is never itself
 * absorbed. Everything else keeps its own standing, so no motion that is
 * not the immediate, opposite, continuous neighbour of a stroke is ever
 * hidden by it.
 */
function foldStrokePhases(
  candidates: MeasuredCandidate[],
  series: readonly SpeedSample[],
  torsoLength: number,
): void {
  const limits = IMPORT_ADMISSION_LIMITS;
  const order = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        candidate.peakTorsoPerSecond >= limits.minStrokePeakTorsoPerSecond,
    )
    .sort(
      (left, right) =>
        right.candidate.peakSpeed - left.candidate.peakSpeed ||
        left.index - right.index,
    );
  for (const { candidate: stroke, index } of order) {
    if (stroke.role !== 'motion' && stroke.role !== 'stroke') continue;
    const before = candidates[index - 1];
    if (
      before &&
      before.role === 'motion' &&
      isStrokePhase(stroke, before, 'wind_up', series, torsoLength)
    ) {
      before.role = 'wind_up';
      before.phaseOf = stroke;
      stroke.role = 'stroke';
    }
    const after = candidates[index + 1];
    if (
      after &&
      after.role === 'motion' &&
      isStrokePhase(stroke, after, 'recovery', series, torsoLength)
    ) {
      after.role = 'recovery';
      after.phaseOf = stroke;
      stroke.role = 'stroke';
    }
  }
}

/**
 * Groups comparable candidates (already sorted by peak time) into physical
 * events using bounded peak proximity only: a candidate joins the open
 * cluster when its peak lies within `sameEventPeakDistanceMs` of the
 * cluster's FIRST peak and the cluster holds no event of the same wrist yet
 * (both wrists move through one swing; one wrist's two events are two
 * movements, however close). Adding a candidate can never reduce the count
 * — one wrist's motion cannot bridge two strokes of the other wrist.
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
      candidate.peakMs - anchor.peakMs <= limits.sameEventPeakDistanceMs &&
      !open.some(member => member.wrist === candidate.wrist)
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
    peakTorsoPerSecond: candidate.peakTorsoPerSecond,
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

  const torsoLength = medianTorsoLength(frames, aspectRatio);
  if (torsoLength === null) {
    return {
      admitted: false,
      version,
      reason: 'body_scale_unmeasured',
      detail:
        `Shoulders and hips were tracked together on fewer than ${limits.minTorsoSamples} frames; ` +
        'wrist speed cannot be judged against the player\u2019s body scale.',
      candidates: [],
      comparableEventCount: 0,
    };
  }

  const measured = measurements
    .flatMap(measurement => candidatesFor(measurement, torsoLength))
    .sort(
      (left, right) =>
        left.peakMs - right.peakMs || left.wrist.localeCompare(right.wrist),
    );
  for (const candidate of measured) {
    candidate.comparable =
      (candidate.role === 'motion' || candidate.role === 'stroke') &&
      candidate.peakTorsoPerSecond >= limits.minComparablePeakTorsoPerSecond;
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
        `Wrist motion never reaches ${limits.minComparablePeakTorsoPerSecond} torso lengths/s ` +
        `(${measurements.map(m => `${m.wrist}: peak ${(m.peak / torsoLength).toFixed(2)} torso lengths/s`).join('; ')}).`,
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
  // The admitted movement is the stroke cluster plus the wind-up and
  // recovery folded into its members: the phases sit right beside them.
  const movement = measured.filter(
    candidate =>
      cluster.includes(candidate) ||
      (candidate.phaseOf !== null && cluster.includes(candidate.phaseOf)),
  );
  const startMs = Math.min(...movement.map(member => member.startMs));
  const endMs = Math.max(...movement.map(member => member.endMs));
  // A clip edge can only shorten the measured span, so a span already too
  // long for one stroke is judged on its length first.
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
  if (
    cluster.some(member => member.touchesSeriesStart || member.touchesSeriesEnd)
  ) {
    return {
      admitted: false,
      version,
      reason: 'stroke_truncated_at_clip_edge',
      detail: `Stroke motion (${startMs}–${endMs} ms) runs into the ${cluster.some(m => m.touchesSeriesStart) ? 'first' : 'last'} tracked frame or a tracking gap; the swing is not fully inside the clip.`,
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
  if (lead.peakTorsoPerSecond < limits.minStrokePeakTorsoPerSecond) {
    return {
      admitted: false,
      version,
      reason: 'motion_not_stroke_like',
      detail:
        `Peak wrist speed ${lead.peakTorsoPerSecond.toFixed(2)} torso lengths/s is below the ` +
        `${limits.minStrokePeakTorsoPerSecond} torso lengths/s a stroke reaches.`,
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
      peakTorsoPerSecond: lead.peakTorsoPerSecond,
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
 * frame rate, frame count, timeline, pose coverage, wrist coverage), then
 * stroke plausibility — a rejected clip must never reach a permit reservation.
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
  const wristFrames = sequence.frames.filter(
    frame =>
      landmarkPoint(frame, 'left_wrist', 1) !== null ||
      landmarkPoint(frame, 'right_wrist', 1) !== null,
  );
  const untrackedWristMs = longestUntrackedSpanMs(wristFrames, clip.durationMs);
  if (untrackedWristMs > limits.maxUntrackedSpanMs) {
    return {
      admitted: false,
      version,
      reason: 'wrist_not_tracked',
      detail:
        `The clip carries ${Math.round(untrackedWristMs)} ms without either wrist tracked ` +
        `(at most ${limits.maxUntrackedSpanMs} ms is admissible); strokes in that stretch would go unmeasured.`,
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
    case 'body_scale_unmeasured':
      return 'The player\u2019s shoulders and hips could not be tracked in this video, so the stroke cannot be measured. Use a clip where the player\u2019s upper body stays fully in frame.';
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
