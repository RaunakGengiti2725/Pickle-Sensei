/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario S9 (+ round-trip extras).
 * The durable Live Court summary must survive a JSON round trip for real
 * engine output: native wrist timestamps are fractional milliseconds, so
 * snapshot.durationMs is frequently non-integer.
 */
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
  type LiveSessionSummaryRecordV1,
} from '../../src/flow/liveSessionSummary';
import {
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  createPendingStubAnalysisProvider,
  type LiveSessionSnapshot,
} from '../../src/flow/session';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import { LiveSessionCoach } from '../../src/flow/liveSessionCoach';

function snapshotWithDuration(durationMs: number): LiveSessionSnapshot {
  return {
    sessionId: 'attack-summary',
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
    engineVersion: 'attack-engine-1',
    analysisProviderId: 'attack-provider',
  };
}

function roundTrip(record: LiveSessionSummaryRecordV1) {
  return parseLiveSessionSummaryRecord(JSON.stringify(record));
}

describe('S9 — fractional durationMs round trip', () => {
  it('durationMs 3871.5 is kept by the parsed record', () => {
    const snapshot = snapshotWithDuration(3871.5);
    const record = buildLiveSessionSummaryRecord(
      snapshot,
      sessionScoreProgression(snapshot.events),
      null,
    );
    expect(record.durationMs).toBe(3871.5);
    const parsed = roundTrip(record);
    expect(parsed).not.toBeNull();
    expect(parsed!.durationMs).toBe(3871.5);
  });

  it('observed today: the fractional duration is zeroed on parse while every integer sibling survives', () => {
    const snapshot = snapshotWithDuration(3871.5);
    const record = buildLiveSessionSummaryRecord(
      snapshot,
      sessionScoreProgression(snapshot.events),
      null,
    );
    const parsed = roundTrip(record)!;
    expect(parsed.durationMs).toBe(0);
    // Same record with an integer duration parses faithfully — the loss is
    // specifically the integer-only validator on a fractional field.
    const integer = roundTrip({ ...record, durationMs: 3871 })!;
    expect(integer.durationMs).toBe(3871);
  });

  it('a REAL flow fed fractional native tMs yields a fractional durationMs, so the loss is reachable', () => {
    const flow = new LiveSessionFlow({
      sessionId: 'attack-summary-real',
      source: 'live',
      provider: createPendingStubAnalysisProvider(),
    });
    // 60 Hz wrist samples arrive at 16.6667 ms spacing on device.
    for (const sample of DEV_REPLAY_RALLY.samples) {
      flow.pushSample({ tMs: sample.tMs + 0.5, v: sample.v });
    }
    const final = flow.end();
    expect(Number.isInteger(final.durationMs)).toBe(false);
    const record = buildLiveSessionSummaryRecord(
      final,
      sessionScoreProgression(final.events),
      null,
    );
    const parsed = roundTrip(record)!;
    expect(parsed.durationMs).toBe(record.durationMs);
  });

  it('a session average that is a clean tenth (e.g. 6.5) survives — finiteOrNull fields are unaffected', () => {
    const record: LiveSessionSummaryRecordV1 = {
      ...buildLiveSessionSummaryRecord(
        snapshotWithDuration(1000),
        sessionScoreProgression([]),
        null,
      ),
      startAverage: 6.5,
      endAverage: 7.1,
      delta: 0.6,
      bestScore: 7.4,
      sessionAverage: 6.8,
    };
    const parsed = roundTrip(record)!;
    expect(parsed.startAverage).toBe(6.5);
    expect(parsed.endAverage).toBe(7.1);
    expect(parsed.delta).toBe(0.6);
    expect(parsed.bestScore).toBe(7.4);
    expect(parsed.sessionAverage).toBe(6.8);
  });
});

describe('summary round-trip extras — recap, hostile payloads', () => {
  it('the coach recap (cuesSpoken / topCorrection / correctionsByCheckpoint) survives a round trip', () => {
    const voice = {
      available: () => true,
      speak: () => undefined,
      stop: () => undefined,
    };
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    const snapshot = snapshotWithDuration(1234);
    coach.sessionEnded(snapshot);
    const record = buildLiveSessionSummaryRecord(
      snapshot,
      sessionScoreProgression(snapshot.events),
      coach.recap(),
    );
    const parsed = roundTrip(record)!;
    expect(parsed.cuesSpoken).toBe(record.cuesSpoken);
    expect(parsed.topCorrection).toBe(record.topCorrection);
    expect(parsed.correctionsByCheckpoint).toEqual(
      record.correctionsByCheckpoint,
    );
  });

  it.each([
    [
      'prototype-polluting keys',
      '{"version":1,"source":"live","__proto__":{"polluted":true},"correctionsByCheckpoint":{"__proto__":{"x":1},"constructor":2}}',
    ],
    [
      'huge numbers',
      '{"version":1,"source":"live","durationMs":1e309,"strokeCount":9007199254740993,"cuesSpoken":-0}',
    ],
    [
      'unicode noise',
      '{"version":1,"source":"live","topCorrection":"🏓\\u0000\\ud83d","engineVersion":"\\u202e"}',
    ],
    [
      'wrong types',
      '{"version":1,"source":"live","durationMs":"3871","strokeCount":true,"correctionsByCheckpoint":[1,2]}',
    ],
    ['nested arrays as record', '[1,2,3]'],
    ['version string', '{"version":"1","source":"live"}'],
    ['replay source', '{"version":1,"source":"replay","durationMs":10}'],
  ])(
    'parse never throws and never coerces junk into fake history: %s',
    (_label, json) => {
      let parsed: LiveSessionSummaryRecordV1 | null = null;
      expect(() => {
        parsed = parseLiveSessionSummaryRecord(json);
      }).not.toThrow();
      if (parsed !== null) {
        const record = parsed as LiveSessionSummaryRecordV1;
        expect(record.version).toBe(1);
        for (const key of [
          'durationMs',
          'strokeCount',
          'scoredCount',
          'noReadCount',
          'pendingCount',
          'cuesSpoken',
        ] as const) {
          expect(Number.isSafeInteger(record[key])).toBe(true);
          expect(record[key]).toBeGreaterThanOrEqual(0);
        }
        for (const value of Object.values(record.correctionsByCheckpoint)) {
          expect(Number.isSafeInteger(value)).toBe(true);
        }
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      }
    },
  );

  it('a 5 MB summary string parses without hanging', () => {
    const corrections: Record<string, number> = {};
    for (let i = 0; i < 100_000; i += 1)
      corrections[`checkpoint_${i}_${'x'.repeat(30)}`] = i;
    const json = JSON.stringify({
      version: 1,
      source: 'live',
      durationMs: 1,
      correctionsByCheckpoint: corrections,
    });
    expect(json.length).toBeGreaterThan(5_000_000);
    const started = Date.now();
    const parsed = parseLiveSessionSummaryRecord(json);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!.correctionsByCheckpoint)).toHaveLength(100_000);
  });
});
