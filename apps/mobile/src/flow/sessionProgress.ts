import type { SessionEventView } from './session';

/**
 * SESSION SCORE PROGRESSION — the pure "did this session move?" read over a
 * session's stroke events. Consumed by summary surfaces (score-over-reps
 * chart, start→end movement line); pure so jest can pin the math without
 * rendering.
 *
 * Honest-data rules, same spirit as the rest of the session flow:
 *
 *   - A point is plotted ONLY for an event whose analysis actually produced
 *     a scored result (state 'ready', resultKind 'scored', overallScore
 *     present). Nothing is interpolated, carried forward or fabricated.
 *   - Reps the pipeline analyzed but could not score (abstentions,
 *     low_confidence results, ready records without a result payload) are
 *     COUNTED, never hidden — the UI can say "3 reps had no read" instead of
 *     quietly drawing a shorter line.
 *   - pending/processing reps may still resolve, so they sit in their own
 *     bucket: neither points nor no-reads yet.
 *   - Points follow the session's emission order (event index), never
 *     analysis resolution order — a late-settling analysis must not
 *     reshuffle the progression.
 *   - The start→end delta is reported as measured. A decline is a negative
 *     number, not a clamped zero.
 *   - Events that violate upstream contracts (a 'ready' event with no
 *     analysis record, or a 'scored' result missing its score) land in NO
 *     bucket — this module refuses to guess a read that does not exist.
 */

/** One scored rep on the session time axis. */
export interface SessionScorePoint {
  eventId: string;
  eventIndex: number; // SessionEventView.index
  endMs: number; // event end on the session time axis
  score: number; // 0..10 overall score
}

export interface SessionScoreProgression {
  /** Scored events in event-index order (never resolution order). */
  points: SessionScorePoint[];
  scoredCount: number;
  /** Analyzed but unscorable: ready-with-low_confidence results + abstained events. */
  noReadCount: number;
  /** Not yet (or never) analyzed: pending + processing events. */
  pendingCount: number;
  /** Mean of the first `window` scored reps, 1 decimal; null when no scored reps. */
  startAverage: number | null;
  /** Mean of the last `window` scored reps, 1 decimal; null when no scored reps. */
  endAverage: number | null;
  /** endAverage - startAverage, 1 decimal; null unless scoredCount >= 2. */
  delta: number | null;
  best: SessionScorePoint | null; // highest score; earliest event wins ties
  /** The start/end window size actually used: n>=6 → 3, n>=4 → 2, else 1. */
  windowSize: number;
}

/** One-decimal rounding — the same resolution overall scores are shown at. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function meanScore(points: readonly SessionScorePoint[]): number {
  let sum = 0;
  for (const point of points) sum += point.score;
  return sum / points.length;
}

/**
 * Fold a session's event views into the progression summary. Pure and
 * order-independent: events may arrive in any order (e.g. re-sorted by
 * resolution time); points and windows always follow the event index.
 */
export function sessionScoreProgression(
  events: readonly SessionEventView[],
): SessionScoreProgression {
  const points: SessionScorePoint[] = [];
  let noReadCount = 0;
  let pendingCount = 0;

  for (const event of events) {
    if (event.state === 'pending' || event.state === 'processing') {
      pendingCount += 1;
      continue;
    }
    if (event.state === 'abstained') {
      noReadCount += 1;
      continue;
    }
    // state === 'ready'. Undefined = no analysis record at all (upstream
    // contract violation — counted nowhere); null = analysis ran but
    // produced no result payload (an honest no-read).
    const result = event.analysis?.result;
    if (result === undefined) continue;
    if (result === null || result.resultKind === 'low_confidence') {
      noReadCount += 1;
      continue;
    }
    if (result.overallScore === null) {
      // 'scored' without a score violates the ShotAnalysis contract —
      // never plotted, never guessed into a bucket.
      continue;
    }
    points.push({
      eventId: event.eventId,
      eventIndex: event.index,
      endMs: event.endMs,
      score: result.overallScore,
    });
  }

  // Emission order, regardless of how the caller ordered the views.
  points.sort((a, b) => a.eventIndex - b.eventIndex);
  const scoredCount = points.length;

  const windowSize = scoredCount >= 6 ? 3 : scoredCount >= 4 ? 2 : 1;
  const startAverage =
    scoredCount === 0 ? null : round1(meanScore(points.slice(0, windowSize)));
  const endAverage =
    scoredCount === 0 ? null : round1(meanScore(points.slice(-windowSize)));
  // A one-rep session has no movement to report — start and end are the
  // same swing. Two scored reps is the honest minimum for a delta.
  const delta =
    scoredCount >= 2 && startAverage !== null && endAverage !== null
      ? round1(endAverage - startAverage)
      : null;

  let best: SessionScorePoint | null = null;
  for (const point of points) {
    // Strictly greater: with index-ordered points, ties keep the earliest.
    if (best === null || point.score > best.score) best = point;
  }

  return {
    points,
    scoredCount,
    noReadCount,
    pendingCount,
    startAverage,
    endAverage,
    delta,
    best,
    windowSize,
  };
}
