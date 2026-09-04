/**
 * STRUCTURAL AUDIT PROBES — liveSessionSummary build/parse (dormant Live Court
 * durable summary). The parser documents itself as STRICT ("anything that does
 * not look like a V1 live-session record returns null — corrupt payloads are
 * excluded from progression, never coerced into fake history"). Each probe
 * asserts that contract; a failing probe is a reproduced defect.
 */
import type { LiveSessionSnapshot } from '../src/flow/session';
import { sessionScoreProgression } from '../src/flow/sessionProgress';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
  type LiveSessionSummaryRecordV1,
} from '../src/flow/liveSessionSummary';

function snapshot(durationMs: number): LiveSessionSnapshot {
  return {
    sessionId: 'audit-summary',
    phase: 'ended',
    source: 'live',
    startedAtIso: '2026-08-31T10:00:00.000Z',
    durationMs,
    strokeCount: 0,
    events: [],
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'audit-engine',
    analysisProviderId: 'audit-provider',
  };
}

function record(
  partial: Partial<LiveSessionSummaryRecordV1>,
): LiveSessionSummaryRecordV1 {
  return {
    version: 1,
    engineVersion: 'audit-engine',
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

describe('AUDIT liveSessionSummary — build/parse contract', () => {
  it('a fractional durationMs (finite, >= 0 — what sessionNative admits) round-trips instead of collapsing to 0', () => {
    const built = buildLiveSessionSummaryRecord(
      snapshot(3871.5),
      sessionScoreProgression([]),
      null,
    );
    expect(built.durationMs).toBe(3871.5);
    const parsed = parseLiveSessionSummaryRecord(JSON.stringify(built));
    expect(parsed).not.toBeNull();
    expect(parsed?.durationMs).toBeCloseTo(3871.5, 3);
  });

  it('rejects an out-of-range sessionAverage (scores are 0..10)', () => {
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify(record({ sessionAverage: 999 })),
    );
    expect(parsed === null || parsed.sessionAverage === null).toBe(true);
  });

  it('rejects impossible cross-field counts (scoredCount > strokeCount)', () => {
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify(record({ strokeCount: 1, scoredCount: 50 })),
    );
    expect(parsed).toBeNull();
  });

  it('drops negative correction counts', () => {
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify(
        record({ correctionsByCheckpoint: { athletic_base: -7 } }),
      ),
    );
    expect(parsed?.correctionsByCheckpoint.athletic_base).toBeUndefined();
  });

  it('a non-numeric count is a corrupt record, not a zero', () => {
    const corrupt = { ...record({}), strokeCount: 'eight' };
    const parsed = parseLiveSessionSummaryRecord(JSON.stringify(corrupt));
    expect(parsed).toBeNull();
  });
});
