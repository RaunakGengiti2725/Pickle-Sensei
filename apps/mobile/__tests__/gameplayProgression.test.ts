/**
 * Gameplay progression tests: cross-session math built ONLY from validated
 * stored summaries. Demo replays and corrupt rows never become history.
 */
import type { LiveSessionSnapshot } from '../src/flow/session';
import { sessionScoreProgression } from '../src/flow/sessionProgress';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
  type LiveSessionSummaryRecordV1,
} from '../src/flow/liveSessionSummary';
import {
  buildGameplayProgression,
  sessionDayLabel,
} from '../src/progress/gameplayProgression';
import type { LiveSessionHistoryRow } from '../src/data/repository';

function record(
  partial: Partial<LiveSessionSummaryRecordV1>,
): LiveSessionSummaryRecordV1 {
  return {
    version: 1,
    engineVersion: 'test-engine',
    source: 'live',
    durationMs: 60000,
    strokeCount: 8,
    scoredCount: 6,
    noReadCount: 1,
    pendingCount: 1,
    startAverage: 5.5,
    endAverage: 6.5,
    delta: 1.0,
    bestScore: 7.2,
    sessionAverage: 6.0,
    cuesSpoken: 8,
    topCorrection: 'athletic_base',
    correctionsByCheckpoint: { athletic_base: 3 },
    ...partial,
  };
}

function row(
  id: string,
  startedAt: string,
  summary: LiveSessionSummaryRecordV1 | string | null,
): LiveSessionHistoryRow {
  return {
    id,
    startedAt,
    endedAt: null,
    summary:
      summary === null
        ? null
        : typeof summary === 'string'
        ? summary
        : JSON.stringify(summary),
  };
}

describe('live session summary record', () => {
  it('build → stringify → parse round-trips every field', () => {
    const snapshot = {
      sessionId: 's1',
      phase: 'ended',
      source: 'live',
      startedAtIso: '2026-08-31T10:00:00.000Z',
      durationMs: 45000,
      strokeCount: 2,
      events: [],
      distribution: [],
      qualityNotes: [],
      droppedLateSamples: 0,
      onUpdateFailures: 0,
      engineVersion: 'engine-9',
      analysisProviderId: 'provider-1',
    } as unknown as LiveSessionSnapshot;
    const built = buildLiveSessionSummaryRecord(
      snapshot,
      sessionScoreProgression([]),
      {
        cues: [],
        spokenCount: 4,
        correctionsByCheckpoint: { athletic_base: 2 },
        topCorrection: 'athletic_base',
      },
    );
    const parsed = parseLiveSessionSummaryRecord(JSON.stringify(built));
    expect(parsed).toEqual(built);
    expect(parsed?.engineVersion).toBe('engine-9');
    expect(parsed?.cuesSpoken).toBe(4);
    expect(parsed?.topCorrection).toBe('athletic_base');
  });

  it('rejects foreign or corrupt payloads instead of coercing them', () => {
    expect(parseLiveSessionSummaryRecord(null)).toBeNull();
    expect(parseLiveSessionSummaryRecord('not json')).toBeNull();
    expect(parseLiveSessionSummaryRecord('{}')).toBeNull();
    expect(
      parseLiveSessionSummaryRecord(JSON.stringify({ version: 2 })),
    ).toBeNull();
    // Legacy rep-loop summaries (different shape) are excluded, not guessed.
    expect(
      parseLiveSessionSummaryRecord(
        JSON.stringify({ validReps: 5, startScore: 6 }),
      ),
    ).toBeNull();
  });
});

describe('buildGameplayProgression', () => {
  it('builds an honest cross-session trend and excludes replays + corrupt rows', () => {
    const rows: LiveSessionHistoryRow[] = [
      row(
        's1',
        '2026-08-01T10:00:00.000Z',
        record({ sessionAverage: 5.5, delta: 0.4 }),
      ),
      // Demo replay: never progression, even if stored.
      row('s2', '2026-08-02T10:00:00.000Z', record({ source: 'replay' })),
      // Corrupt row: excluded, never guessed.
      row('s3', '2026-08-03T10:00:00.000Z', 'corrupt{'),
      // Session where nothing scored: listed but not charted.
      row(
        's4',
        '2026-08-04T10:00:00.000Z',
        record({
          sessionAverage: null,
          scoredCount: 0,
          delta: null,
          bestScore: null,
          startAverage: null,
          endAverage: null,
        }),
      ),
      row(
        's5',
        '2026-08-05T10:00:00.000Z',
        record({ sessionAverage: 6.4, delta: -0.2 }),
      ),
      row(
        's6',
        '2026-08-06T10:00:00.000Z',
        record({ sessionAverage: 6.9, delta: 1.1 }),
      ),
    ];
    const progression = buildGameplayProgression(rows);
    expect(progression.sessions.map(session => session.sessionId)).toEqual([
      's1',
      's4',
      's5',
      's6',
    ]);
    expect(
      progression.scoredSessions.map(session => session.sessionId),
    ).toEqual(['s1', 's5', 's6']);
    expect(progression.trendPoints).toEqual([5.5, 6.4, 6.9]);
    expect(progression.firstAverage).toBe(5.5);
    expect(progression.latestAverage).toBe(6.9);
    expect(progression.overallDelta).toBe(1.4);
    expect(progression.bestSession?.sessionId).toBe('s6');
    expect(progression.improvedSessions).toBe(2); // s1 (+0.4) and s6 (+1.1)
    expect(progression.totalScoredSwings).toBe(18); // 6 + 0 + 6 + 6
  });

  it('handles empty and single-session histories without inventing a trend', () => {
    expect(buildGameplayProgression([]).sessions).toHaveLength(0);
    expect(buildGameplayProgression([]).overallDelta).toBeNull();
    const single = buildGameplayProgression([
      row('s1', '2026-08-01T10:00:00.000Z', record({})),
    ]);
    expect(single.latestAverage).toBe(6.0);
    // One session is a data point, not a trend.
    expect(single.overallDelta).toBeNull();
  });
});

describe('sessionDayLabel', () => {
  it('renders a short day label and never throws on bad input', () => {
    expect(sessionDayLabel('2026-08-31T10:00:00.000Z')).toMatch(/Aug \d+/);
    expect(sessionDayLabel('garbage')).toBe('garbage'.slice(0, 10));
  });
});
