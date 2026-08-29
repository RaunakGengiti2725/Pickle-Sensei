import type { CaptureEvidenceV1 } from '../camera/capture';
import type { PendingCapture } from '../data/repository';

const DAY_MS = 86_400_000;
const MAXIMUM_RANGE_DAYS = 366;
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export const PRACTICE_HISTORY_RANGES = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '28d', label: '4 weeks', days: 28 },
  { key: '90d', label: '90 days', days: 90 },
] as const;

export type PracticeHistoryRangeKey =
  (typeof PRACTICE_HISTORY_RANGES)[number]['key'];

export interface BuildPracticeHistoryOptions {
  asOfIso: string;
  /** IANA zone from `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timeZone: string;
  range: PracticeHistoryRangeKey;
}

export interface PracticeHistoryChartBucket {
  key: string;
  label: string;
  count: number;
}

export interface PracticeHistoryResult {
  range: PracticeHistoryRangeKey;
  buckets: PracticeHistoryChartBucket[];
  /** All values except streaks describe the selected current range. */
  captureCount: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  trackedDurationMs: number;
  meanPoseAvailability: number | null;
  meanJointCoverage: number | null;
  priorPeriodDelta: {
    captureCount: number;
    activeDays: number;
    trackedDurationMs: number;
    meanPoseAvailability: number | null;
    meanJointCoverage: number | null;
  };
}

export interface PracticeHistoryOptions {
  /** Explicit reference instant; requiring it keeps tests and reports stable. */
  asOfIso: string;
  /** IANA zone; per-instant offsets keep historical DST boundaries correct. */
  timeZone: string;
  /** Current and prior comparison periods have this many days each. */
  rangeDays: number;
}

export interface PoseAvailabilityMetrics {
  analysisInputFrameCount: number;
  poseFrameCount: number;
  poseMissingFrameCount: number;
  /** Pose-producing inference attempts divided by all inference attempts. */
  rate: number | null;
}

export interface JointTrackingMetrics {
  /** Weighted by the number of real pose frames in each capture. */
  meanCoverage: number | null;
  minimumCoverage: number | null;
  /** Mean visibility of the canonical 12-joint set, pose-frame weighted. */
  meanCanonicalJointVisibility: number | null;
  fullBodyVisibleFrameRate: number | null;
}

export interface PracticeMetrics {
  eligibleCaptureCount: number;
  activeDayCount: number;
  /** Sum of evidence-window pose duration, not clip or session duration. */
  trackedPoseDurationMs: number;
  poseAvailability: PoseAvailabilityMetrics;
  jointTracking: JointTrackingMetrics;
}

export interface PracticeDayBucket extends PracticeMetrics {
  day: string;
}

export interface PracticeRangeBucket extends PracticeMetrics {
  period: 'current' | 'previous';
  startDay: string;
  endDay: string;
}

export interface PracticePeriodComparison {
  eligibleCaptureDelta: number;
  activeDayDelta: number;
  trackedPoseDurationDeltaMs: number;
  /** Direct rate differences; null unless both periods have evidence. */
  poseAvailabilityRateDelta: number | null;
  meanJointCoverageDelta: number | null;
}

export interface PracticeHistory {
  asOfDay: string;
  timeZone: string;
  rangeDays: number;
  sourceCaptureCount: number;
  excludedCaptureCount: number;
  lifetime: PracticeMetrics;
  streak: {
    currentDays: number;
    longestDays: number;
    practicedToday: boolean;
    lastPracticeDay: string | null;
  };
  /** Ascending, zero-filled buckets for the current range. */
  dayBuckets: PracticeDayBucket[];
  rangeBuckets: {
    current: PracticeRangeBucket;
    previous: PracticeRangeBucket;
  };
  priorPeriodComparison: PracticePeriodComparison;
}

interface EligibleCapture {
  id: string;
  capturedAtMs: number;
  day: string;
  evidence: CaptureEvidenceV1;
}

interface MutableMetrics {
  captureCount: number;
  activeDays: Set<string>;
  trackedPoseDurationMs: number;
  analysisInputFrameCount: number;
  poseFrameCount: number;
  poseMissingFrameCount: number;
  coveragePoseFrameSum: number;
  visibilityPoseFrameSum: number;
  minimumCoverage: number | null;
  fullBodyVisibleFrameCount: number;
}

/** UI-ready view of the strict evidence aggregation for a selected range. */
export function buildPracticeHistory(
  captures: readonly PendingCapture[],
  options: BuildPracticeHistoryOptions,
): PracticeHistoryResult {
  const definition = PRACTICE_HISTORY_RANGES.find(
    candidate => candidate.key === options.range,
  );
  if (!definition) throw new Error('Unsupported practice history range.');

  const history = aggregatePracticeHistory(captures, {
    asOfIso: options.asOfIso,
    timeZone: options.timeZone,
    rangeDays: definition.days,
  });
  const current = history.rangeBuckets.current;
  const delta = history.priorPeriodComparison;
  return {
    range: options.range,
    buckets: history.dayBuckets.map(bucket => ({
      key: bucket.day,
      label: dayLabel(bucket.day),
      count: bucket.eligibleCaptureCount,
    })),
    captureCount: current.eligibleCaptureCount,
    activeDays: current.activeDayCount,
    currentStreak: history.streak.currentDays,
    longestStreak: history.streak.longestDays,
    trackedDurationMs: current.trackedPoseDurationMs,
    meanPoseAvailability: current.poseAvailability.rate,
    meanJointCoverage: current.jointTracking.meanCoverage,
    priorPeriodDelta: {
      captureCount: delta.eligibleCaptureDelta,
      activeDays: delta.activeDayDelta,
      trackedDurationMs: delta.trackedPoseDurationDeltaMs,
      meanPoseAvailability: delta.poseAvailabilityRateDelta,
      meanJointCoverage: delta.meanJointCoverageDelta,
    },
  };
}

/**
 * Builds practice history solely from repository-validated automatic captures.
 * It intentionally does not expose stroke labels, scores, form, power, or MPH:
 * the pending-capture evidence contract cannot substantiate those metrics.
 */
export function aggregatePracticeHistory(
  captures: readonly PendingCapture[],
  options: PracticeHistoryOptions,
): PracticeHistory {
  const asOfMs = parseExplicitInstant(options.asOfIso, 'asOfIso');
  assertOptions(options);
  const dayFormatter = makeDayFormatter(options.timeZone);
  const timeZone = dayFormatter.resolvedOptions().timeZone;
  const asOfDay = dayForInstant(asOfMs, dayFormatter);
  const asOfOrdinal = dayOrdinal(asOfDay);
  const currentStartOrdinal = asOfOrdinal - options.rangeDays + 1;
  const previousEndOrdinal = currentStartOrdinal - 1;
  const previousStartOrdinal = previousEndOrdinal - options.rangeDays + 1;

  const eligible = captures
    .map(capture => eligibleCapture(capture, asOfMs, dayFormatter))
    .filter((capture): capture is EligibleCapture => capture !== null)
    .sort(
      (left, right) =>
        left.capturedAtMs - right.capturedAtMs ||
        left.id.localeCompare(right.id),
    );

  const lifetime = emptyMetrics();
  const current = emptyMetrics();
  const previous = emptyMetrics();
  const byDay = new Map<string, MutableMetrics>();

  for (const capture of eligible) {
    addCapture(lifetime, capture);
    const ordinal = dayOrdinal(capture.day);
    if (ordinal >= currentStartOrdinal && ordinal <= asOfOrdinal) {
      addCapture(current, capture);
    } else if (
      ordinal >= previousStartOrdinal &&
      ordinal <= previousEndOrdinal
    ) {
      addCapture(previous, capture);
    }
    const dayMetrics = byDay.get(capture.day) ?? emptyMetrics();
    addCapture(dayMetrics, capture);
    byDay.set(capture.day, dayMetrics);
  }

  const dayBuckets: PracticeDayBucket[] = [];
  for (
    let ordinal = currentStartOrdinal;
    ordinal <= asOfOrdinal;
    ordinal += 1
  ) {
    const day = dayFromOrdinal(ordinal);
    dayBuckets.push({
      day,
      ...finalizeMetrics(byDay.get(day) ?? emptyMetrics()),
    });
  }

  const currentRange: PracticeRangeBucket = {
    period: 'current',
    startDay: dayFromOrdinal(currentStartOrdinal),
    endDay: asOfDay,
    ...finalizeMetrics(current),
  };
  const previousRange: PracticeRangeBucket = {
    period: 'previous',
    startDay: dayFromOrdinal(previousStartOrdinal),
    endDay: dayFromOrdinal(previousEndOrdinal),
    ...finalizeMetrics(previous),
  };
  const activeOrdinals = [...lifetime.activeDays]
    .map(dayOrdinal)
    .sort((left, right) => left - right);

  return {
    asOfDay,
    timeZone,
    rangeDays: options.rangeDays,
    sourceCaptureCount: captures.length,
    excludedCaptureCount: captures.length - eligible.length,
    lifetime: finalizeMetrics(lifetime),
    streak: streakForDays(activeOrdinals, asOfOrdinal),
    dayBuckets,
    rangeBuckets: { current: currentRange, previous: previousRange },
    priorPeriodComparison: comparePeriods(currentRange, previousRange),
  };
}

function eligibleCapture(
  capture: PendingCapture,
  asOfMs: number,
  dayFormatter: Intl.DateTimeFormat,
): EligibleCapture | null {
  if (
    capture.evidenceStatus !== 'valid' ||
    capture.clip?.captureMode !== 'automatic_pose_trigger'
  ) {
    return null;
  }
  const clip = capture.clip;
  // Recheck the repository's metadata-match invariant at this pure boundary.
  if (
    clip.uri !== capture.uri ||
    clip.capturedAtIso !== capture.capturedAtIso ||
    clip.durationMs !== capture.durationMs ||
    clip.fps !== capture.fps ||
    clip.width !== capture.width ||
    clip.height !== capture.height
  ) {
    return null;
  }
  const capturedAtMs = parseOptionalExplicitInstant(capture.capturedAtIso);
  if (capturedAtMs === null || capturedAtMs > asOfMs) return null;
  return {
    id: capture.id,
    capturedAtMs,
    day: dayForInstant(capturedAtMs, dayFormatter),
    evidence: clip.captureEvidence,
  };
}

function emptyMetrics(): MutableMetrics {
  return {
    captureCount: 0,
    activeDays: new Set<string>(),
    trackedPoseDurationMs: 0,
    analysisInputFrameCount: 0,
    poseFrameCount: 0,
    poseMissingFrameCount: 0,
    coveragePoseFrameSum: 0,
    visibilityPoseFrameSum: 0,
    minimumCoverage: null,
    fullBodyVisibleFrameCount: 0,
  };
}

function addCapture(metrics: MutableMetrics, capture: EligibleCapture): void {
  const evidence = capture.evidence;
  metrics.captureCount += 1;
  metrics.activeDays.add(capture.day);
  metrics.trackedPoseDurationMs += evidence.trackedDurationMs;
  metrics.analysisInputFrameCount += evidence.analysisInputFrameCount;
  metrics.poseFrameCount += evidence.poseFrameCount;
  metrics.poseMissingFrameCount += evidence.poseMissingFrameCount;
  metrics.coveragePoseFrameSum +=
    evidence.meanJointCoverage * evidence.poseFrameCount;
  metrics.visibilityPoseFrameSum +=
    evidence.meanCanonicalJointVisibility * evidence.poseFrameCount;
  metrics.minimumCoverage =
    metrics.minimumCoverage === null
      ? evidence.minimumJointCoverage
      : Math.min(metrics.minimumCoverage, evidence.minimumJointCoverage);
  metrics.fullBodyVisibleFrameCount += evidence.fullBodyVisibleFrameCount;
}

function finalizeMetrics(metrics: MutableMetrics): PracticeMetrics {
  const poseAvailabilityRate = divideOrNull(
    metrics.poseFrameCount,
    metrics.analysisInputFrameCount,
  );
  return {
    eligibleCaptureCount: metrics.captureCount,
    activeDayCount: metrics.activeDays.size,
    trackedPoseDurationMs: metrics.trackedPoseDurationMs,
    poseAvailability: {
      analysisInputFrameCount: metrics.analysisInputFrameCount,
      poseFrameCount: metrics.poseFrameCount,
      poseMissingFrameCount: metrics.poseMissingFrameCount,
      rate: poseAvailabilityRate,
    },
    jointTracking: {
      meanCoverage: divideOrNull(
        metrics.coveragePoseFrameSum,
        metrics.poseFrameCount,
      ),
      minimumCoverage: metrics.minimumCoverage,
      meanCanonicalJointVisibility: divideOrNull(
        metrics.visibilityPoseFrameSum,
        metrics.poseFrameCount,
      ),
      fullBodyVisibleFrameRate: divideOrNull(
        metrics.fullBodyVisibleFrameCount,
        metrics.poseFrameCount,
      ),
    },
  };
}

function comparePeriods(
  current: PracticeRangeBucket,
  previous: PracticeRangeBucket,
): PracticePeriodComparison {
  return {
    eligibleCaptureDelta:
      current.eligibleCaptureCount - previous.eligibleCaptureCount,
    activeDayDelta: current.activeDayCount - previous.activeDayCount,
    trackedPoseDurationDeltaMs:
      current.trackedPoseDurationMs - previous.trackedPoseDurationMs,
    poseAvailabilityRateDelta: differenceOrNull(
      current.poseAvailability.rate,
      previous.poseAvailability.rate,
    ),
    meanJointCoverageDelta: differenceOrNull(
      current.jointTracking.meanCoverage,
      previous.jointTracking.meanCoverage,
    ),
  };
}

function streakForDays(
  activeOrdinals: readonly number[],
  asOfOrdinal: number,
): PracticeHistory['streak'] {
  if (activeOrdinals.length === 0) {
    return {
      currentDays: 0,
      longestDays: 0,
      practicedToday: false,
      lastPracticeDay: null,
    };
  }

  let longestDays = 1;
  let run = 1;
  for (let index = 1; index < activeOrdinals.length; index += 1) {
    const current = activeOrdinals[index];
    const previous = activeOrdinals[index - 1];
    if (current === undefined || previous === undefined) continue;
    run = current === previous + 1 ? run + 1 : 1;
    longestDays = Math.max(longestDays, run);
  }

  const latest = activeOrdinals.at(-1);
  let currentDays = 0;
  if (latest !== undefined && latest >= asOfOrdinal - 1) {
    currentDays = 1;
    for (let index = activeOrdinals.length - 2; index >= 0; index -= 1) {
      const day = activeOrdinals[index];
      if (day === undefined || day !== latest - currentDays) break;
      currentDays += 1;
    }
  }

  return {
    currentDays,
    longestDays,
    practicedToday: latest === asOfOrdinal,
    lastPracticeDay: latest === undefined ? null : dayFromOrdinal(latest),
  };
}

function assertOptions(options: PracticeHistoryOptions): void {
  if (
    typeof options.timeZone !== 'string' ||
    options.timeZone.trim().length === 0
  ) {
    throw new Error('timeZone must be a non-empty IANA timezone.');
  }
  if (
    !Number.isSafeInteger(options.rangeDays) ||
    options.rangeDays < 1 ||
    options.rangeDays > MAXIMUM_RANGE_DAYS
  ) {
    throw new Error('rangeDays must be an integer between 1 and 366.');
  }
}

function parseExplicitInstant(value: string, field: string): number {
  const parsed = parseOptionalExplicitInstant(value);
  if (parsed === null) {
    throw new Error(
      `${field} must be an ISO timestamp with an explicit timezone.`,
    );
  }
  return parsed;
}

function parseOptionalExplicitInstant(value: string): number | null {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function makeDayFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new Error('timeZone must be a supported IANA timezone.');
  }
}

function dayForInstant(
  timestampMs: number,
  formatter: Intl.DateTimeFormat,
): string {
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  for (const part of formatter.formatToParts(new Date(timestampMs))) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('The selected timezone could not produce a calendar day.');
  }
  return `${year}-${month}-${day}`;
}

function dayOrdinal(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

function dayFromOrdinal(ordinal: number): string {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

function divideOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function differenceOrNull(
  current: number | null,
  previous: number | null,
): number | null {
  return current === null || previous === null ? null : current - previous;
}

function dayLabel(day: string): string {
  const monthIndex = Number(day.slice(5, 7)) - 1;
  const dayOfMonth = Number(day.slice(8, 10));
  const month = MONTH_LABELS[monthIndex];
  if (month === undefined || !Number.isSafeInteger(dayOfMonth)) return day;
  return `${month} ${dayOfMonth}`;
}
