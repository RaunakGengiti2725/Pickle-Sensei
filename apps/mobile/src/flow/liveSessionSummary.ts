import type { LiveSessionSnapshot } from './session';
import type { SessionScoreProgression } from './sessionProgress';
import type { LiveCoachRecap } from './liveSessionCoach';

/**
 * Durable Live Court session summary (local_session.summary payload for
 * mode 'live_court'). Everything here is derived from REAL engine output —
 * the progression math over canonical analyses and the coach's actual cue
 * log. Version-tagged so future shapes can coexist with stored rows.
 */

export const LIVE_SESSION_MODE = 'live_court';

export interface LiveSessionSummaryRecordV1 {
  version: 1;
  engineVersion: string;
  source: 'live' | 'replay';
  durationMs: number;
  strokeCount: number;
  scoredCount: number;
  noReadCount: number;
  pendingCount: number;
  /** Start/end window averages from sessionScoreProgression (1 decimal). */
  startAverage: number | null;
  endAverage: number | null;
  delta: number | null;
  bestScore: number | null;
  /** Mean of ALL scored swings this session, 1 decimal. */
  sessionAverage: number | null;
  cuesSpoken: number;
  topCorrection: string | null;
  correctionsByCheckpoint: Record<string, number>;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildLiveSessionSummaryRecord(
  snapshot: LiveSessionSnapshot,
  progression: SessionScoreProgression,
  recap: LiveCoachRecap | null,
): LiveSessionSummaryRecordV1 {
  const scores = progression.points.map(point => point.score);
  return {
    version: 1,
    engineVersion: snapshot.engineVersion,
    source: snapshot.source,
    durationMs: snapshot.durationMs,
    strokeCount: snapshot.strokeCount,
    scoredCount: progression.scoredCount,
    noReadCount: progression.noReadCount,
    pendingCount: progression.pendingCount,
    startAverage: progression.startAverage,
    endAverage: progression.endAverage,
    delta: progression.delta,
    bestScore: progression.best?.score ?? null,
    sessionAverage:
      scores.length > 0
        ? round1(scores.reduce((sum, score) => sum + score, 0) / scores.length)
        : null,
    cuesSpoken: recap?.spokenCount ?? 0,
    topCorrection: recap?.topCorrection ?? null,
    correctionsByCheckpoint: Object.fromEntries(
      Object.entries(recap?.correctionsByCheckpoint ?? {}).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    ),
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function countOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/**
 * Strict parse of a stored summary row. Anything that does not look like a
 * V1 live-session record returns null — corrupt or foreign payloads are
 * excluded from progression, never coerced into fake history.
 */
export function parseLiveSessionSummaryRecord(
  json: string | null,
): LiveSessionSummaryRecordV1 | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (record.source !== 'live' && record.source !== 'replay') return null;
  const correctionsRaw =
    typeof record.correctionsByCheckpoint === 'object' &&
    record.correctionsByCheckpoint !== null
      ? (record.correctionsByCheckpoint as Record<string, unknown>)
      : {};
  return {
    version: 1,
    engineVersion: String(record.engineVersion ?? 'unknown'),
    source: record.source,
    durationMs: countOrZero(record.durationMs),
    strokeCount: countOrZero(record.strokeCount),
    scoredCount: countOrZero(record.scoredCount),
    noReadCount: countOrZero(record.noReadCount),
    pendingCount: countOrZero(record.pendingCount),
    startAverage: finiteOrNull(record.startAverage),
    endAverage: finiteOrNull(record.endAverage),
    delta: finiteOrNull(record.delta),
    bestScore: finiteOrNull(record.bestScore),
    sessionAverage: finiteOrNull(record.sessionAverage),
    cuesSpoken: countOrZero(record.cuesSpoken),
    topCorrection:
      typeof record.topCorrection === 'string' ? record.topCorrection : null,
    correctionsByCheckpoint: Object.fromEntries(
      Object.entries(correctionsRaw).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isSafeInteger(entry[1]),
      ),
    ),
  };
}
