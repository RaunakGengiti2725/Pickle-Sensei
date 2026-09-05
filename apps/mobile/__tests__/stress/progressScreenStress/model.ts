import type { CaptureSpec, ScoredFactSpec } from './fixtures';

/**
 * Independent oracle for what ProgressScreen must display. It is written
 * from the documented product rules (ProgressScreen.tsx header comment,
 * techniqueDashboard.ts "Honesty invariants", practiceHistory.ts "the ONE
 * verified-practice rule") rather than by calling the production helpers, so
 * a defect in those helpers cannot hide behind an oracle that shares it.
 *
 * Rules modelled:
 *  T1  Only `scored` reads with a numeric score count toward technique.
 *  T2  Within a stroke, only reads sharing the NEWEST read's scoring model
 *      and shot config versions are comparable; others are excluded.
 *  T3  Windows are calendar days in the device zone: the current window is
 *      the last N days ending today; the prior window is the N days before.
 *  T4  Averages are exact means of integer tenths, shown with one decimal.
 *  T5  A prior-window value exists only when comparable history predates
 *      the current window; otherwise NO comparison is shown.
 *  P1  Practice counts only verified captures: guided (pose trigger) clips
 *      and imported clips whose pose sequence was recorded. Unmeasured
 *      imports, corrupt payloads, metadata mismatches and legacy rows never
 *      count.
 *  P2  Practice and technique are separate: captures never move technique
 *      numbers and analyses never move practice numbers.
 *  P3  A prior-window practice comparison is shown only when the prior
 *      window itself holds verified captures ("zero prior captures hides
 *      every comparison instead of faking 0s", ProgressScreen.tsx).
 *  P4  "First measured period on this device." may be claimed only when NO
 *      verified capture predates the current window at all.
 *  S1  Reads/captures stamped after "now" are excluded, never guessed.
 */

export type RangeKey = '7d' | '28d' | '90d';
export const RANGE_DAYS: Record<RangeKey, number> = {
  '7d': 7,
  '28d': 28,
  '90d': 90,
};

const DAY_MS = 86_400_000;

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Calendar day ordinal (days since epoch) of an instant in `timeZone`. */
export function dayOrdinalInZone(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const pick = (type: string) =>
    Number(parts.find(part => part.type === type)?.value);
  const utcMidnight = Date.UTC(pick('year'), pick('month') - 1, pick('day'));
  return Math.floor(utcMidnight / DAY_MS);
}

export interface TechniqueExpectation {
  reps: string;
  avg: string;
  best: string;
  days: string;
  /** Whether a "prior period" comparison must be present on every row. */
  hasPrior: boolean;
  priorReps: string | null;
  priorDays: string | null;
  /** Null when no comparison is due OR the prior window holds no reads. */
  priorAvg: string | null;
  priorBest: string | null;
  comparableIds: string[];
}

export interface PracticeExpectation {
  captures: string;
  activeDays: string;
  hasPrior: boolean;
  priorCaptures: string | null;
  priorActiveDays: string | null;
  /** Verified captures exist before the current window (any age). */
  hasOlderHistory: boolean;
}

interface ComparableRead {
  id: string;
  ordinal: number;
  tenths: number;
}

function comparableReads(
  facts: readonly ScoredFactSpec[],
  asOfMs: number,
  timeZone: string,
): ComparableRead[] {
  const scored = facts.filter(fact => {
    const ms = Date.parse(fact.capturedAtIso);
    return (
      fact.overallScore !== null && Number.isFinite(ms) && ms <= asOfMs // T1, S1
    );
  });
  const newest = new Map<string, ScoredFactSpec>();
  for (const fact of scored) {
    const current = newest.get(fact.shotType);
    if (
      !current ||
      Date.parse(fact.capturedAtIso) > Date.parse(current.capturedAtIso)
    ) {
      newest.set(fact.shotType, fact);
    }
  }
  return scored
    .filter(fact => {
      const reference = newest.get(fact.shotType)!;
      return (
        fact.versions.scoringModelVersion ===
          reference.versions.scoringModelVersion &&
        fact.versions.shotConfigVersion === reference.versions.shotConfigVersion
      ); // T2
    })
    .map(fact => ({
      id: fact.id,
      ordinal: dayOrdinalInZone(Date.parse(fact.capturedAtIso), timeZone),
      tenths: Math.round((fact.overallScore as number) * 10),
    }));
}

function mean(reads: readonly ComparableRead[]): string {
  if (reads.length === 0) return '—';
  const total = reads.reduce((sum, read) => sum + read.tenths, 0);
  return (total / reads.length / 10).toFixed(1); // T4
}

function best(reads: readonly ComparableRead[]): string {
  if (reads.length === 0) return '—';
  return (Math.max(...reads.map(read => read.tenths)) / 10).toFixed(1);
}

function distinctDays(reads: readonly { ordinal: number }[]): number {
  return new Set(reads.map(read => read.ordinal)).size;
}

export function expectedTechnique(
  facts: readonly ScoredFactSpec[],
  range: RangeKey,
  asOfMs: number,
  timeZone: string,
): TechniqueExpectation {
  const days = RANGE_DAYS[range];
  const asOfOrdinal = dayOrdinalInZone(asOfMs, timeZone);
  const start = asOfOrdinal - days + 1; // T3
  const priorStart = start - days;
  const reads = comparableReads(facts, asOfMs, timeZone);
  const current = reads.filter(read => read.ordinal >= start);
  const prior = reads.filter(
    read => read.ordinal >= priorStart && read.ordinal < start,
  );
  const hasPrior = reads.some(read => read.ordinal < start); // T5
  return {
    reps: String(current.length),
    avg: mean(current),
    best: best(current),
    days: String(distinctDays(current)),
    hasPrior,
    priorReps: hasPrior ? String(prior.length) : null,
    priorDays: hasPrior ? String(distinctDays(prior)) : null,
    priorAvg: hasPrior && prior.length > 0 ? mean(prior) : null,
    priorBest: hasPrior && prior.length > 0 ? best(prior) : null,
    comparableIds: current.map(read => read.id).sort(),
  };
}

export function captureCounts(kind: CaptureSpec['kind']): boolean {
  return kind === 'guided' || kind === 'imported_measured'; // P1
}

export function expectedPractice(
  captures: readonly CaptureSpec[],
  range: RangeKey,
  asOfMs: number,
  timeZone: string,
): PracticeExpectation {
  const days = RANGE_DAYS[range];
  const asOfOrdinal = dayOrdinalInZone(asOfMs, timeZone);
  const start = asOfOrdinal - days + 1;
  const priorStart = start - days;
  const verified = captures
    .filter(capture => captureCounts(capture.kind))
    .map(capture => ({
      ms: Date.parse(capture.capturedAtIso),
    }))
    .filter(capture => Number.isFinite(capture.ms) && capture.ms <= asOfMs) // S1
    .map(capture => ({ ordinal: dayOrdinalInZone(capture.ms, timeZone) }));
  const current = verified.filter(capture => capture.ordinal >= start);
  const prior = verified.filter(
    capture => capture.ordinal >= priorStart && capture.ordinal < start,
  );
  const hasPrior = prior.length > 0; // P3
  return {
    captures: String(current.length),
    activeDays: String(distinctDays(current)),
    hasPrior,
    priorCaptures: hasPrior ? String(prior.length) : null,
    priorActiveDays: hasPrior ? String(distinctDays(prior)) : null,
    hasOlderHistory: verified.some(capture => capture.ordinal < start), // P4
  };
}

/**
 * Practice-set attempts the screen may offer to open (the "this set" card):
 * take sessions by their latest scored read, newest first, keeping only those
 * whose latest read landed within the last 24h; the first session that holds
 * at least two reads comparable to its newest read (same stroke, same model
 * and config versions) is the set, and exactly those comparable reads are
 * the attempts. Only ids from that set may ever be handed to the Result
 * route.
 */
export function latestPracticeSetIds(
  facts: readonly ScoredFactSpec[],
  asOfMs: number,
): string[] {
  const bySession = new Map<string, ScoredFactSpec[]>();
  for (const fact of facts) {
    const ms = Date.parse(fact.capturedAtIso);
    if (
      fact.sessionId === null ||
      fact.overallScore === null ||
      !Number.isFinite(ms) ||
      ms > asOfMs
    ) {
      continue;
    }
    const list = bySession.get(fact.sessionId) ?? [];
    list.push(fact);
    bySession.set(fact.sessionId, list);
  }
  const candidates = [...bySession.entries()]
    .map(([sessionId, list]) => ({
      sessionId,
      list: [...list].sort(
        (left, right) =>
          Date.parse(left.capturedAtIso) - Date.parse(right.capturedAtIso) ||
          left.id.localeCompare(right.id),
      ),
      latestMs: Math.max(...list.map(fact => Date.parse(fact.capturedAtIso))),
    }))
    .filter(entry => asOfMs - entry.latestMs <= DAY_MS)
    .sort(
      (left, right) =>
        right.latestMs - left.latestMs ||
        left.sessionId.localeCompare(right.sessionId),
    );
  for (const candidate of candidates) {
    const newest = candidate.list[candidate.list.length - 1]!;
    const comparable = candidate.list.filter(
      fact =>
        fact.shotType === newest.shotType &&
        fact.versions.scoringModelVersion ===
          newest.versions.scoringModelVersion &&
        fact.versions.shotConfigVersion === newest.versions.shotConfigVersion,
    );
    if (comparable.length >= 2) {
      return comparable.map(fact => fact.id).sort();
    }
  }
  return [];
}
