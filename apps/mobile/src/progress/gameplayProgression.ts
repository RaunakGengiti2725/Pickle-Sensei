import type { LiveSessionHistoryRow } from '../data/repository';
import {
  parseLiveSessionSummaryRecord,
  type LiveSessionSummaryRecordV1,
} from '../flow/liveSessionSummary';

/**
 * Cross-session gameplay progression, built ONLY from durably stored Live
 * Court session summaries (mode 'live_court', completed, owner-scoped).
 * Replay/demo sessions are excluded — demo data never becomes progress.
 * Pure so jest pins the math without a database.
 */

export interface GameplaySessionPoint {
  sessionId: string;
  startedAtIso: string;
  endedAtIso: string | null;
  /** Mean of all scored swings in that session (1 decimal), null when the
   * session produced no scored swings. */
  average: number | null;
  /** In-session start→end movement recorded at the time. */
  delta: number | null;
  best: number | null;
  scoredCount: number;
  strokeCount: number;
  cuesSpoken: number;
  topCorrection: string | null;
}

export interface GameplayProgression {
  /** Every stored live session, oldest first. */
  sessions: GameplaySessionPoint[];
  /** Sessions with at least one scored swing, oldest first. */
  scoredSessions: GameplaySessionPoint[];
  /** Session averages for charting (scored sessions, oldest first). */
  trendPoints: number[];
  firstAverage: number | null;
  latestAverage: number | null;
  /** latestAverage - firstAverage, 1 decimal; null unless 2+ scored sessions. */
  overallDelta: number | null;
  bestSession: GameplaySessionPoint | null;
  totalScoredSwings: number;
  totalStrokeEvents: number;
  /** Sessions whose in-session delta was positive (finished above start). */
  improvedSessions: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function toPoint(
  row: LiveSessionHistoryRow,
  record: LiveSessionSummaryRecordV1,
): GameplaySessionPoint {
  return {
    sessionId: row.id,
    startedAtIso: row.startedAt,
    endedAtIso: row.endedAt,
    average: record.sessionAverage,
    delta: record.delta,
    best: record.bestScore,
    scoredCount: record.scoredCount,
    strokeCount: record.strokeCount,
    cuesSpoken: record.cuesSpoken,
    topCorrection: record.topCorrection,
  };
}

export function buildGameplayProgression(
  rows: readonly LiveSessionHistoryRow[],
): GameplayProgression {
  const sessions: GameplaySessionPoint[] = [];
  for (const row of rows) {
    const record = parseLiveSessionSummaryRecord(row.summary);
    // Only real live sessions count toward gameplay progression.
    if (record === null || record.source !== 'live') continue;
    sessions.push(toPoint(row, record));
  }
  const scoredSessions = sessions.filter(
    session => session.average !== null && session.scoredCount > 0,
  );
  const trendPoints = scoredSessions.map(session => session.average as number);
  const firstAverage = trendPoints[0] ?? null;
  const latestAverage = trendPoints.at(-1) ?? null;
  let bestSession: GameplaySessionPoint | null = null;
  for (const session of scoredSessions) {
    if (
      bestSession === null ||
      (session.average as number) > (bestSession.average as number)
    ) {
      bestSession = session;
    }
  }
  return {
    sessions,
    scoredSessions,
    trendPoints,
    firstAverage,
    latestAverage,
    overallDelta:
      firstAverage !== null && latestAverage !== null && trendPoints.length >= 2
        ? round1(latestAverage - firstAverage)
        : null,
    bestSession,
    totalScoredSwings: sessions.reduce(
      (sum, session) => sum + session.scoredCount,
      0,
    ),
    totalStrokeEvents: sessions.reduce(
      (sum, session) => sum + session.strokeCount,
      0,
    ),
    improvedSessions: sessions.filter(
      session => session.delta !== null && session.delta > 0,
    ).length,
  };
}

/** "Aug 31" style label from an ISO timestamp; falls back to the raw string
 * prefix when unparseable (never throws in a render path). */
export function sessionDayLabel(startedAtIso: string): string {
  const parsed = Date.parse(startedAtIso);
  if (!Number.isFinite(parsed)) return startedAtIso.slice(0, 10);
  const date = new Date(parsed);
  const month = [
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
  ][date.getMonth()];
  return `${month} ${date.getDate()}`;
}
