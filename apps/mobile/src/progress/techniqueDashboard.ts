import type { RealAnalysisFact } from '../data/repository';
import {
  PRACTICE_HISTORY_RANGES,
  type PracticeHistoryRangeKey,
} from './practiceHistory';

/**
 * WHOOP-style technique dashboard math (MOBBIN: WHOOP "Key statistics" /
 * "Recovery statistics" with their VS. PRIOR PERIOD deltas). Everything here
 * is derived from locally stored real analyses — the same comparability rule
 * the By-stroke cards use: within a stroke, only reads that share the newest
 * read's scoring model and shot config versions are ever compared, so a model
 * upgrade can never masquerade as improvement.
 *
 * Honesty invariants:
 * - A prior-window value exists only when comparable history predates the
 *   current window. A first measured window shows NO comparison — nothing is
 *   invented for the "previous" side.
 * - A personal best fires only when a real earlier best is strictly beaten.
 * - The insight line states only arithmetic facts about the two windows.
 */

const DAY_MS = 86_400_000;
const MAXIMUM_TREND_BARS = 13;
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

export interface TechniqueDashboardOptions {
  /** Explicit reference instant; requiring it keeps tests and reports stable. */
  asOfIso: string;
  /** IANA zone from `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timeZone: string;
  range: PracticeHistoryRangeKey;
}

export interface ScoreTrendBucket {
  key: string;
  label: string;
  /** Mean of comparable scored reads in the bucket; null when none exist. */
  avg: number | null;
  count: number;
}

export interface CountStat {
  current: number;
  /** Null while no comparable history predates the current window. */
  previous: number | null;
}

export interface ScoreStat {
  /** Null when the window holds no comparable scored reads. */
  current: number | null;
  previous: number | null;
}

export interface TechniquePersonalBest {
  shotType: string;
  score: number;
  previousBest: number;
  /** Calendar day (device zone) the best-in-window read landed. */
  day: string;
}

export interface TechniqueDashboard {
  windowDays: number;
  scoredReps: CountStat;
  scoredDays: CountStat;
  avgScore: ScoreStat;
  bestScore: ScoreStat;
  /** Ascending, zero-filled, compacted to at most 13 bars. */
  buckets: ScoreTrendBucket[];
  personalBest: TechniquePersonalBest | null;
  insight: string | null;
}

/** Right-aligned section context, e.g. "VS. PRIOR 7 DAYS". */
export function vsPriorLabel(range: PracticeHistoryRangeKey): string {
  const definition = PRACTICE_HISTORY_RANGES.find(
    candidate => candidate.key === range,
  );
  return `VS. PRIOR ${(definition?.label ?? '').toUpperCase()}`;
}

export function formatSignedDelta(value: number, decimals = 1): string {
  const fixed = Math.abs(value).toFixed(decimals);
  return value < 0 && Number(fixed) !== 0 ? `-${fixed}` : `+${fixed}`;
}

interface ComparableRead {
  shotType: string;
  capturedAtMs: number;
  day: string;
  ordinal: number;
  score: number;
  /** `score` in exact integer tenths — the order-independent sum unit. */
  scoreTenths: number;
}

export function buildTechniqueDashboard(
  facts: readonly RealAnalysisFact[],
  options: TechniqueDashboardOptions,
): TechniqueDashboard {
  const definition = PRACTICE_HISTORY_RANGES.find(
    candidate => candidate.key === options.range,
  );
  if (!definition) throw new Error('Unsupported technique dashboard range.');
  const asOfMs = Date.parse(options.asOfIso);
  if (!Number.isFinite(asOfMs)) {
    throw new Error('asOfIso must be a parseable ISO timestamp.');
  }
  const dayFormatter = makeDayFormatter(options.timeZone);
  const asOfOrdinal = dayOrdinal(dayForInstant(asOfMs, dayFormatter));
  const currentStartOrdinal = asOfOrdinal - definition.days + 1;
  const previousStartOrdinal = currentStartOrdinal - definition.days;

  const reads = comparableReads(facts, asOfMs, dayFormatter);
  const current = reads.filter(read => read.ordinal >= currentStartOrdinal);
  const previous = reads.filter(
    read =>
      read.ordinal >= previousStartOrdinal &&
      read.ordinal < currentStartOrdinal,
  );
  const beforeWindow = reads.filter(read => read.ordinal < currentStartOrdinal);
  const hasHistory = beforeWindow.length > 0;

  return {
    windowDays: definition.days,
    scoredReps: {
      current: current.length,
      previous: hasHistory ? previous.length : null,
    },
    scoredDays: {
      current: distinctDays(current),
      previous: hasHistory ? distinctDays(previous) : null,
    },
    avgScore: {
      current: meanScore(current),
      previous: hasHistory ? meanScore(previous) : null,
    },
    bestScore: {
      current: maxScore(current),
      previous: hasHistory ? maxScore(previous) : null,
    },
    buckets: trendBuckets(current, currentStartOrdinal, asOfOrdinal),
    personalBest: personalBest(current, beforeWindow),
    insight: insightLine(
      meanScore(current),
      hasHistory ? meanScore(previous) : null,
      hasHistory,
      definition.label,
    ),
  };
}

/**
 * Applies the stroke-scoped comparability rule: only scored reads matching
 * their stroke's newest scored read on BOTH version axes survive. Reads with
 * unparseable timestamps or timestamps after asOf are dropped, never guessed.
 */
function comparableReads(
  facts: readonly RealAnalysisFact[],
  asOfMs: number,
  dayFormatter: Intl.DateTimeFormat,
): ComparableRead[] {
  const scored: Array<RealAnalysisFact & { capturedAtMs: number }> = [];
  for (const fact of facts) {
    if (fact.resultKind !== 'scored' || fact.overallScore === null) continue;
    const capturedAtMs = Date.parse(fact.capturedAt);
    if (!Number.isFinite(capturedAtMs) || capturedAtMs > asOfMs) continue;
    scored.push({ ...fact, capturedAtMs });
  }
  const newestByShot = new Map<
    string,
    RealAnalysisFact & { capturedAtMs: number }
  >();
  for (const fact of scored) {
    const newest = newestByShot.get(fact.shotType);
    if (!newest || fact.capturedAtMs > newest.capturedAtMs) {
      newestByShot.set(fact.shotType, fact);
    }
  }
  const reads: ComparableRead[] = [];
  for (const fact of scored) {
    const newest = newestByShot.get(fact.shotType)!;
    if (
      fact.scoringModelVersion !== newest.scoringModelVersion ||
      fact.shotConfigVersion !== newest.shotConfigVersion
    ) {
      continue;
    }
    const day = dayForInstant(fact.capturedAtMs, dayFormatter);
    reads.push({
      shotType: fact.shotType,
      capturedAtMs: fact.capturedAtMs,
      day,
      ordinal: dayOrdinal(day),
      score: fact.overallScore as number,
      // Scores are 0–10 with one decimal by domain contract. Aggregating in
      // integer tenths (the rank formula's integer-math convention) keeps
      // every average exact and independent of row order — float summation
      // drift could otherwise flip a ±0.0 delta's direction.
      scoreTenths: Math.round((fact.overallScore as number) * 10),
    });
  }
  return reads;
}

function distinctDays(reads: readonly ComparableRead[]): number {
  return new Set(reads.map(read => read.day)).size;
}

function meanScore(reads: readonly ComparableRead[]): number | null {
  if (reads.length === 0) return null;
  const tenths = reads.reduce((sum, read) => sum + read.scoreTenths, 0);
  return tenths / reads.length / 10;
}

function maxScore(reads: readonly ComparableRead[]): number | null {
  if (reads.length === 0) return null;
  return reads.reduce(
    (best, read) => Math.max(best, read.score),
    Number.NEGATIVE_INFINITY,
  );
}

/**
 * Zero-filled day buckets across the current window, compacted to at most 13
 * bars. Group averages re-aggregate the raw reads (a mean of day means would
 * over-weigh light days).
 */
function trendBuckets(
  current: readonly ComparableRead[],
  startOrdinal: number,
  endOrdinal: number,
): ScoreTrendBucket[] {
  const byOrdinal = new Map<number, { sumTenths: number; count: number }>();
  for (const read of current) {
    const entry = byOrdinal.get(read.ordinal) ?? { sumTenths: 0, count: 0 };
    entry.sumTenths += read.scoreTenths;
    entry.count += 1;
    byOrdinal.set(read.ordinal, entry);
  }
  const totalDays = endOrdinal - startOrdinal + 1;
  const groupSize = Math.max(1, Math.ceil(totalDays / MAXIMUM_TREND_BARS));
  const buckets: ScoreTrendBucket[] = [];
  for (
    let ordinal = startOrdinal;
    ordinal <= endOrdinal;
    ordinal += groupSize
  ) {
    const lastOrdinal = Math.min(ordinal + groupSize - 1, endOrdinal);
    let sumTenths = 0;
    let count = 0;
    for (let member = ordinal; member <= lastOrdinal; member += 1) {
      const entry = byOrdinal.get(member);
      if (!entry) continue;
      sumTenths += entry.sumTenths;
      count += entry.count;
    }
    const firstDay = dayFromOrdinal(ordinal);
    const lastDay = dayFromOrdinal(lastOrdinal);
    buckets.push({
      key: `${firstDay}:${lastDay}`,
      label: dayLabel(firstDay),
      avg: count > 0 ? sumTenths / count / 10 : null,
      count,
    });
  }
  return buckets;
}

/**
 * A best-in-window read that strictly beats the stroke's best from before the
 * window. Ties never celebrate. When several strokes qualify, the most recent
 * moment wins — that is the one the player just lived.
 */
function personalBest(
  current: readonly ComparableRead[],
  beforeWindow: readonly ComparableRead[],
): TechniquePersonalBest | null {
  const priorBestByShot = new Map<string, number>();
  for (const read of beforeWindow) {
    const best = priorBestByShot.get(read.shotType);
    if (best === undefined || read.score > best) {
      priorBestByShot.set(read.shotType, read.score);
    }
  }
  let winner: (TechniquePersonalBest & { capturedAtMs: number }) | null = null;
  const bestInWindow = new Map<string, ComparableRead>();
  for (const read of current) {
    const best = bestInWindow.get(read.shotType);
    if (
      !best ||
      read.score > best.score ||
      (read.score === best.score && read.capturedAtMs > best.capturedAtMs)
    ) {
      bestInWindow.set(read.shotType, read);
    }
  }
  for (const [shotType, read] of bestInWindow) {
    const priorBest = priorBestByShot.get(shotType);
    if (priorBest === undefined || read.score <= priorBest) continue;
    if (!winner || read.capturedAtMs > winner.capturedAtMs) {
      winner = {
        shotType,
        score: read.score,
        previousBest: priorBest,
        day: read.day,
        capturedAtMs: read.capturedAtMs,
      };
    }
  }
  if (!winner) return null;
  const { capturedAtMs: _ignored, ...summary } = winner;
  return summary;
}

/** One factual sentence about the two windows; null when nothing is scored. */
function insightLine(
  currentAvg: number | null,
  previousAvg: number | null,
  hasHistory: boolean,
  rangeLabel: string,
): string | null {
  if (currentAvg === null) return null;
  if (!hasHistory) {
    return 'First scored window on this device — this baseline is yours to beat.';
  }
  if (previousAvg === null) {
    return `No comparable reads landed in the prior ${rangeLabel.toLowerCase()}.`;
  }
  return `Average score ${formatSignedDelta(
    currentAvg - previousAvg,
  )} vs the prior ${rangeLabel.toLowerCase()}.`;
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
  let year = '';
  let month = '';
  let day = '';
  for (const part of formatter.formatToParts(new Date(timestampMs))) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

function dayOrdinal(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

function dayFromOrdinal(ordinal: number): string {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

function dayLabel(day: string): string {
  const monthIndex = Number(day.slice(5, 7)) - 1;
  const dayOfMonth = Number(day.slice(8, 10));
  const month = MONTH_LABELS[monthIndex];
  if (month === undefined || !Number.isSafeInteger(dayOfMonth)) return day;
  return `${month} ${dayOfMonth}`;
}
