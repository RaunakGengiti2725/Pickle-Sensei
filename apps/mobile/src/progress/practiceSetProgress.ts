import type { RealAnalysisFact } from '../data/repository';
import { CHECKPOINT_NAMES } from '../components/strokeResultModel';
import { plural } from '../util/plural';

/**
 * PRACTICE SET progress — "did the re-record improve on the read before it?"
 * for the analyses recorded in one sitting (one `sessionId`, see
 * analysis/practiceSet.ts). Pure over RealAnalysisFact so the Result surface
 * and the Progress dashboard render the same arithmetic.
 *
 * Honesty invariants (the dashboard's, applied to one set):
 * - Only scored real attempts of the SAME stroke as the set's latest attempt
 *   are compared, and only those sharing the latest attempt's
 *   scoringModelVersion + shotConfigVersion (a model upgrade mid-sitting can
 *   never masquerade as improvement). Mismatched attempts are COUNTED, never
 *   silently dropped — the insight says they were not compared.
 * - Deltas are exact integer TENTHS (scores are 0–10 with one decimal by
 *   domain contract), so a ±0.0 can never flip sign through float drift.
 * - A set with fewer than two comparable attempts has no summary: nothing is
 *   invented for the "before" side.
 * - The headline and insight state measured arithmetic only.
 */

export interface PracticeSetAttempt {
  id: string;
  capturedAt: string;
  overallScore: number;
  priorityCheckpoint: string | null;
  checkpointScores: Record<string, number>;
}

export type PracticeSetTrend = 'improved' | 'slipped' | 'held';

export interface PracticeSetSummary {
  sessionId: string;
  shotType: string;
  /** Chronological, comparable attempts only (same stroke + versions as the
   * latest attempt). */
  attempts: PracticeSetAttempt[];
  first: PracticeSetAttempt;
  latest: PracticeSetAttempt;
  best: PracticeSetAttempt;
  /** latest − first in exact integer tenths (+8 = +0.8). */
  deltaTenths: number;
  /** |deltaTenths| ≥ PRACTICE_SET_TREND_THRESHOLD_TENTHS → improved/slipped. */
  trend: PracticeSetTrend;
  /** Checkpoints that scored < 65 in `first` and ≥ 80 in `latest`. */
  fixedCheckpoints: string[];
  /** The latest attempt's priority checkpoint — what is still open. */
  stillOpen: string | null;
  /** Scored attempts of this stroke skipped because their scoring model or
   * shot config differs from the latest attempt's. */
  excludedCount: number;
  startedAt: string;
  endedAt: string;
}

/** A move smaller than this many tenths is "held" — within one read's noise. */
export const PRACTICE_SET_TREND_THRESHOLD_TENTHS = 3;
/** A checkpoint counts as fixed when it climbs from below this… */
export const FIXED_CHECKPOINT_FROM_BELOW = 65;
/** …to at least this within the set. */
export const FIXED_CHECKPOINT_TO_AT_LEAST = 80;
/** A set is "the latest" for the dashboard only this long after its last read. */
export const DEFAULT_LATEST_SET_MAX_AGE_MS = 24 * 60 * 60_000;

/** U+2212 MINUS SIGN — a real minus, not a hyphen, in user-facing numerals. */
const MINUS = '\u2212';

interface ScoredSetFact {
  fact: RealAnalysisFact;
  capturedAtMs: number;
  score: number;
}

/** Scores are 0–10 with one decimal by domain contract; integer tenths are
 * the exact, order-independent unit (the rank formula's convention). */
export function scoreTenths(score: number): number {
  return Math.round(score * 10);
}

function scoredFactsInSet(
  facts: readonly RealAnalysisFact[],
  sessionId: string,
): ScoredSetFact[] {
  const scored: ScoredSetFact[] = [];
  for (const fact of facts) {
    if (fact.sessionId !== sessionId) continue;
    if (fact.resultKind !== 'scored') continue;
    if (typeof fact.overallScore !== 'number') continue;
    if (!Number.isFinite(fact.overallScore)) continue;
    const capturedAtMs = Date.parse(fact.capturedAt);
    if (!Number.isFinite(capturedAtMs)) continue;
    scored.push({ fact, capturedAtMs, score: fact.overallScore });
  }
  // Chronological; ties broken by id so the order never depends on row order.
  scored.sort(
    (left, right) =>
      left.capturedAtMs - right.capturedAtMs ||
      (left.fact.id < right.fact.id
        ? -1
        : left.fact.id > right.fact.id
          ? 1
          : 0),
  );
  return scored;
}

function toAttempt(entry: ScoredSetFact): PracticeSetAttempt {
  const scores: Record<string, number> = {};
  // Defensive over the fact shape: a fact from an older reader without the
  // map contributes no checkpoint evidence rather than crashing the surface.
  const raw: unknown = entry.fact.checkpointScores;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        scores[key] = value;
      }
    }
  }
  return {
    id: entry.fact.id,
    capturedAt: entry.fact.capturedAt,
    overallScore: entry.score,
    priorityCheckpoint:
      typeof entry.fact.priorityCheckpoint === 'string'
        ? entry.fact.priorityCheckpoint
        : null,
    checkpointScores: scores,
  };
}

export function practiceSetTrend(deltaTenths: number): PracticeSetTrend {
  if (deltaTenths >= PRACTICE_SET_TREND_THRESHOLD_TENTHS) return 'improved';
  if (deltaTenths <= -PRACTICE_SET_TREND_THRESHOLD_TENTHS) return 'slipped';
  return 'held';
}

/** Checkpoints below the "from" bar in `first` that reach the "to" bar in
 * `latest` — a checkpoint absent from either attempt is never inferred. Order
 * follows `first`'s checkpoint order (the stroke sequence). */
export function fixedCheckpointsBetween(
  first: PracticeSetAttempt,
  latest: PracticeSetAttempt,
): string[] {
  const fixed: string[] = [];
  for (const [key, before] of Object.entries(first.checkpointScores)) {
    const after = latest.checkpointScores[key];
    if (after === undefined) continue;
    if (
      before < FIXED_CHECKPOINT_FROM_BELOW &&
      after >= FIXED_CHECKPOINT_TO_AT_LEAST
    ) {
      fixed.push(key);
    }
  }
  return fixed;
}

/**
 * Summary of one set, or null unless at least two comparable scored attempts
 * of the latest attempt's stroke exist. `latest` is the chronologically last
 * scored attempt in the set; it fixes the stroke and the version pair every
 * other attempt must match.
 */
export function summarizePracticeSet(
  facts: readonly RealAnalysisFact[],
  sessionId: string,
): PracticeSetSummary | null {
  if (!sessionId) return null;
  const scored = scoredFactsInSet(facts, sessionId);
  const newest = scored[scored.length - 1];
  if (!newest) return null;

  const sameStroke = scored.filter(
    entry => entry.fact.shotType === newest.fact.shotType,
  );
  const comparable = sameStroke.filter(
    entry =>
      entry.fact.scoringModelVersion === newest.fact.scoringModelVersion &&
      entry.fact.shotConfigVersion === newest.fact.shotConfigVersion,
  );
  if (comparable.length < 2) return null;

  const attempts = comparable.map(toAttempt);
  const first = attempts[0]!;
  const latest = attempts[attempts.length - 1]!;
  // Ties go to the most recent — the one the player just lived.
  let best = first;
  for (const attempt of attempts) {
    if (scoreTenths(attempt.overallScore) >= scoreTenths(best.overallScore)) {
      best = attempt;
    }
  }
  const deltaTenths =
    scoreTenths(latest.overallScore) - scoreTenths(first.overallScore);

  return {
    sessionId,
    shotType: newest.fact.shotType,
    attempts,
    first,
    latest,
    best,
    deltaTenths,
    trend: practiceSetTrend(deltaTenths),
    fixedCheckpoints: fixedCheckpointsBetween(first, latest),
    stillOpen: latest.priorityCheckpoint,
    excludedCount: sameStroke.length - comparable.length,
    startedAt: first.capturedAt,
    endedAt: latest.capturedAt,
  };
}

export interface LatestPracticeSetOptions {
  /** Explicit reference instant; requiring it keeps tests and reports stable. */
  asOfIso: string;
  /** How long after its last read a set still counts as "the latest". */
  maxAgeMs?: number;
}

/**
 * The most recent set (by its latest scored attempt) whose last read landed
 * within `maxAgeMs` of `asOfIso` AND that has a summary. A newer set with a
 * single attempt does not hide an older, comparable one still inside the
 * window. Attempts after `asOfIso` are ignored, never guessed.
 */
export function latestPracticeSet(
  facts: readonly RealAnalysisFact[],
  options: LatestPracticeSetOptions,
): PracticeSetSummary | null {
  const asOfMs = Date.parse(options.asOfIso);
  if (!Number.isFinite(asOfMs)) {
    throw new Error('asOfIso must be a parseable ISO timestamp.');
  }
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_LATEST_SET_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error('maxAgeMs must be a non-negative number.');
  }

  const visible: RealAnalysisFact[] = [];
  const latestBySession = new Map<string, number>();
  for (const fact of facts) {
    const capturedAtMs = Date.parse(fact.capturedAt);
    if (!Number.isFinite(capturedAtMs) || capturedAtMs > asOfMs) continue;
    visible.push(fact);
    if (
      fact.sessionId === null ||
      fact.resultKind !== 'scored' ||
      typeof fact.overallScore !== 'number' ||
      !Number.isFinite(fact.overallScore)
    ) {
      continue;
    }
    const previous = latestBySession.get(fact.sessionId);
    if (previous === undefined || capturedAtMs > previous) {
      latestBySession.set(fact.sessionId, capturedAtMs);
    }
  }

  const candidates = [...latestBySession.entries()]
    .filter(([, latestMs]) => asOfMs - latestMs <= maxAgeMs)
    .sort(
      ([leftId, leftMs], [rightId, rightMs]) =>
        rightMs - leftMs || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
    );
  for (const [sessionId] of candidates) {
    const summary = summarizePracticeSet(visible, sessionId);
    if (summary) return summary;
  }
  return null;
}

/** One decimal from exact tenths, e.g. 8 → "0.8", 15 → "1.5". */
function tenthsToDecimal(absTenths: number): string {
  return (absTenths / 10).toFixed(1);
}

/** Signed one-decimal delta with a real minus sign: "+0.8", "−0.3", "+0.0". */
export function formatTenthsDelta(deltaTenths: number): string {
  if (deltaTenths < 0) return `${MINUS}${tenthsToDecimal(-deltaTenths)}`;
  return `+${tenthsToDecimal(deltaTenths)}`;
}

/** "+0.8 in this set" / "−0.3 in this set" / "Held steady in this set". */
export function practiceSetHeadline(summary: PracticeSetSummary): string {
  if (summary.trend === 'held') return 'Held steady in this set';
  return `${formatTenthsDelta(summary.deltaTenths)} in this set`;
}

/** Lower-cased display name for mid-sentence use ("contact position"). */
export function checkpointPhrase(key: string): string {
  const name = CHECKPOINT_NAMES[key] ?? key.replace(/_/g, ' ').trim();
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * One factual sentence: attempt count, best score, then the most concrete
 * checkpoint fact available (a fixed checkpoint's before→after, else the
 * still-open priority checkpoint), then any attempts that were not compared.
 * Every clause traces to a measured field; nothing is inferred.
 */
export function practiceSetInsight(summary: PracticeSetSummary): string {
  const count = summary.attempts.length;
  const clauses = [
    `${count} ${plural(count, 'attempt')}`,
    `best ${summary.best.overallScore.toFixed(1)}`,
  ];
  const fixed = summary.fixedCheckpoints[0];
  if (fixed !== undefined) {
    const before = summary.first.checkpointScores[fixed];
    const after = summary.latest.checkpointScores[fixed];
    if (before !== undefined && after !== undefined) {
      clauses.push(
        `${checkpointPhrase(fixed)} improved from ${Math.round(before)} to ${Math.round(after)}`,
      );
    }
  } else if (summary.stillOpen !== null) {
    clauses.push(`${checkpointPhrase(summary.stillOpen)} still open`);
  }
  if (summary.excludedCount > 0) {
    clauses.push(
      `${summary.excludedCount} ${plural(
        summary.excludedCount,
        'attempt',
      )} on a different scoring model not compared`,
    );
  }
  return clauses.join(' · ');
}
