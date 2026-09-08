/**
 * H09-01 adversarial attack — boundary and corrupt-state probes against the
 * durable summary the candidate now owns (`liveSessionSummary.ts` took over
 * the `LiveCoachRecap` shape it persists).
 *
 * Product invariant under test: unknown/corrupt state never becomes
 * fabricated history. A stored row whose counters are negative, NaN, or
 * non-numeric is either rejected (null) or kept intact — it must not be
 * rewritten into a plausible-looking record with zeroed counters.
 */

import type { LiveSessionHistoryRow } from '../../src/data/repository';
import type { LiveSessionSnapshot } from '../../src/flow/session';
import type { SessionScoreProgression } from '../../src/flow/sessionProgress';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
  type LiveCoachRecap,
} from '../../src/flow/liveSessionSummary';
import { buildGameplayProgression } from '../../src/progress/gameplayProgression';

function row(summary: unknown): LiveSessionHistoryRow {
  return {
    id: 'row-1',
    startedAt: '2026-09-08T00:00:00.000Z',
    endedAt: null,
    summary: JSON.stringify(summary),
  };
}

function snapshot(
  partial: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  return {
    sessionId: 's1',
    phase: 'ended',
    source: 'live',
    startedAtIso: '2026-09-08T00:00:00.000Z',
    durationMs: 60_000,
    strokeCount: 3,
    events: [],
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'engine-test',
    analysisProviderId: 'provider-test',
    ...partial,
  };
}

function progression(
  partial: Partial<SessionScoreProgression> = {},
): SessionScoreProgression {
  return {
    points: [],
    scoredCount: 0,
    noReadCount: 0,
    pendingCount: 0,
    startAverage: null,
    endAverage: null,
    delta: null,
    best: null,
    windowSize: 1,
    ...partial,
  };
}

function recap(partial: Partial<LiveCoachRecap> = {}): LiveCoachRecap {
  return {
    cues: [],
    spokenCount: 0,
    correctionsByCheckpoint: {},
    topCorrection: null,
    ...partial,
  };
}

describe('H09-01 attack: durable live-session summary at its boundaries', () => {
  it('build → parse keeps the recap aggregates when the recap is well-formed', () => {
    const built = buildLiveSessionSummaryRecord(
      snapshot(),
      progression(),
      recap({
        spokenCount: 4,
        topCorrection: 'athletic_base',
        correctionsByCheckpoint: { athletic_base: 2 },
      }),
    );
    expect(parseLiveSessionSummaryRecord(JSON.stringify(built))).toEqual(built);
  });

  it('a recap with NaN / negative / Infinity aggregates does not survive into the persisted record', () => {
    const built = buildLiveSessionSummaryRecord(
      snapshot(),
      progression(),
      recap({
        spokenCount: Number.NaN,
        correctionsByCheckpoint: {
          athletic_base: Number.NaN,
          paddle_set: -3,
          follow_through: Number.POSITIVE_INFINITY,
        },
      }),
    );
    expect(
      Number.isSafeInteger(built.cuesSpoken) && built.cuesSpoken >= 0,
    ).toBe(true);
    expect(
      Object.values(built.correctionsByCheckpoint).every(
        n => Number.isSafeInteger(n) && n >= 0,
      ),
    ).toBe(true);
  });

  it('a stored row with corrupt counters is excluded from history, not rewritten into a zeroed "improved" session', () => {
    const corrupt = {
      version: 1,
      engineVersion: 'engine-test',
      source: 'live',
      durationMs: -1,
      strokeCount: 'eight',
      scoredCount: -6,
      noReadCount: Number.NaN,
      pendingCount: 1.5,
      startAverage: 5.5,
      endAverage: 6.5,
      delta: 1,
      bestScore: 7.2,
      sessionAverage: 6,
      cuesSpoken: -8,
      topCorrection: 'athletic_base',
      correctionsByCheckpoint: { athletic_base: 3 },
    };
    const parsed = parseLiveSessionSummaryRecord(JSON.stringify(corrupt));
    // Either the row is excluded outright, or every field is exactly what was stored.
    if (parsed !== null) {
      expect(parsed.scoredCount).toBe(corrupt.scoredCount);
      expect(parsed.durationMs).toBe(corrupt.durationMs);
      expect(parsed.cuesSpoken).toBe(corrupt.cuesSpoken);
    }
    const history = buildGameplayProgression([row(corrupt)]);
    expect({
      sessions: history.sessions.length,
      improved: history.improvedSessions,
    }).toEqual({
      sessions: 0,
      improved: 0,
    });
  });

  it('a stored row that claims scores and an improvement but zero scored swings never counts as an improved session', () => {
    const contradictory = {
      version: 1,
      engineVersion: 'engine-test',
      source: 'live',
      durationMs: 60_000,
      strokeCount: 8,
      scoredCount: 0,
      noReadCount: 0,
      pendingCount: 0,
      startAverage: 5.5,
      endAverage: 6.5,
      delta: 1,
      bestScore: 7.2,
      sessionAverage: 6,
      cuesSpoken: 8,
      topCorrection: 'athletic_base',
      correctionsByCheckpoint: {},
    };
    const history = buildGameplayProgression([row(contradictory)]);
    expect(history.trendPoints).toEqual([]);
    expect(history.improvedSessions).toBe(0);
  });

  it('far-future, negative and unsafe-integer durations are not accepted as plausible sessions', () => {
    const base = JSON.parse(
      JSON.stringify(
        buildLiveSessionSummaryRecord(snapshot(), progression(), null),
      ),
    ) as Record<string, unknown>;
    const parsedFarFuture = parseLiveSessionSummaryRecord(
      JSON.stringify({ ...base, durationMs: Number.MAX_SAFE_INTEGER }),
    );
    expect(
      parsedFarFuture === null ||
        parsedFarFuture.durationMs === Number.MAX_SAFE_INTEGER,
    ).toBe(true);
    const parsedUnsafe = parseLiveSessionSummaryRecord(
      JSON.stringify({ ...base, durationMs: 2 ** 60 }),
    );
    expect(parsedUnsafe === null || parsedUnsafe.durationMs === 2 ** 60).toBe(
      true,
    );
  });

  it('non-string / empty payloads and a foreign version are rejected', () => {
    expect(parseLiveSessionSummaryRecord(null)).toBeNull();
    expect(parseLiveSessionSummaryRecord('')).toBeNull();
    expect(parseLiveSessionSummaryRecord('[]')).toBeNull();
    expect(parseLiveSessionSummaryRecord('"live"')).toBeNull();
    expect(
      parseLiveSessionSummaryRecord(
        JSON.stringify({ version: 2, source: 'live' }),
      ),
    ).toBeNull();
    expect(
      parseLiveSessionSummaryRecord(
        JSON.stringify({ version: 1, source: 'demo' }),
      ),
    ).toBeNull();
  });
});
