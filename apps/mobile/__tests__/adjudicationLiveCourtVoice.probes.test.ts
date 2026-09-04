/**
 * ADJUDICATION PROBES (run-only, not part of the confirmed set). Each probe
 * PRINTS what the baseline does so the adjudicator can classify the
 * auditor claim; the assertions pin the OBSERVED baseline behaviour, so a
 * green run here is evidence of the behaviour, not an endorsement of it.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import { NativeModules } from 'react-native';
import {
  selectLiveCue,
  worstCheckpoint,
  INITIAL_LIVE_COACH_STATE,
  sessionEndLine,
} from '@pickle/audio-coach-core';
import {
  LiveSessionCoach,
  type CoachVoicePort,
} from '../src/flow/liveSessionCoach';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../src/flow/liveSessionSummary';
import { sessionScoreProgression } from '../src/flow/sessionProgress';
import { tts } from '../src/audio/tts';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../src/flow/session';

function scored(overallScore: number, severity = 0.5): AnalysisRecord {
  return {
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
    result: {
      resultKind: 'scored',
      overallScore,
      checkpoints: [
        {
          key: 'athletic_base',
          score: 40,
          confidence: 0.9,
          band: 'yellow',
          direction: 'low',
          severity,
          applicable: true,
        },
      ],
    },
  } as unknown as AnalysisRecord;
}

function view(
  index: number,
  analysis: AnalysisRecord | null,
  eventId = `E${index + 1}`,
): SessionEventView {
  return {
    eventId,
    index,
    startMs: index * 1000,
    endMs: index * 1000 + 400,
    peakMs: index * 1000 + 200,
    durationMs: 400,
    peakSpeed: 2.5,
    paddleConfirmed: true,
    closeReason: 'settle',
    closedAtMs: index * 1000 + 600,
    state: analysis ? 'ready' : 'pending',
    pendingReason: null,
    abstainReason: null,
    analysis,
    family: null,
    boundaryUncertain: false,
    retroSuppressed: false,
  };
}

function snap(
  events: SessionEventView[],
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  return {
    sessionId: 'probe-session',
    phase: 'running',
    source: 'live',
    startedAtIso: '2026-09-04T10:00:00.000Z',
    durationMs: events.length * 1000 + 600,
    strokeCount: events.length,
    events,
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'test-engine-1',
    analysisProviderId: 'test-provider',
    ...overrides,
  };
}

function voice() {
  const spoken: string[] = [];
  const port: CoachVoicePort = {
    available: () => true,
    speak: text => {
      spoken.push(text);
    },
    stop: () => undefined,
  };
  return { port, spoken };
}

describe('PROBE non-finite numeric inputs (auditor P1/P2 claims)', () => {
  it('speaks NaN / Infinity verbatim and poisons bestOverall', () => {
    const { port, spoken } = voice();
    const coach = new LiveSessionCoach({ voice: port });
    coach.consumeSnapshot(snap([view(0, scored(Number.NaN))]));
    coach.consumeSnapshot(
      snap([
        view(0, scored(Number.NaN)),
        view(1, scored(Number.POSITIVE_INFINITY)),
      ]),
    );
    coach.consumeSnapshot(
      snap([
        view(0, scored(Number.NaN)),
        view(1, scored(Number.POSITIVE_INFINITY)),
        view(2, scored(9.9, 0.0)),
      ]),
    );
    console.log('[PROBE non-finite] spoken =', JSON.stringify(spoken));
    expect(spoken[0]).toContain('NaN');
    expect(spoken[1]).toContain('Infinity');
    // A genuine 9.9 after Infinity can never be a personal best again.
    expect(spoken[2]?.startsWith('New best')).toBe(false);
  });

  it('worstCheckpoint ignores a NaN-severity checkpoint only when it is first', () => {
    const nan = {
      key: 'athletic_base' as const,
      score: 10,
      direction: 'low' as const,
      severity: Number.NaN,
      applicable: true,
    };
    const real = {
      key: 'contact_position' as const,
      score: 50,
      direction: 'late' as const,
      severity: 0.5,
      applicable: true,
    };
    const a = worstCheckpoint([nan, real]);
    const b = worstCheckpoint([real, nan]);
    console.log(
      '[PROBE worstCheckpoint] nan-first =',
      a?.key,
      'severity',
      a?.severity,
      '| real-first =',
      b?.key,
    );
    expect(a?.key).toBe('athletic_base'); // NaN comparisons are all false → first entry sticks
    expect(b?.key).toBe('contact_position');
    const { decision } = selectLiveCue(INITIAL_LIVE_COACH_STATE, {
      repIndex: 1,
      kind: 'scored',
      overallScore: 6,
      checkpoints: [nan, real],
    });
    console.log(
      '[PROBE worstCheckpoint] cue with NaN-first =',
      decision.category,
      decision.text,
    );
    expect(decision.category).toBe('PRAISE'); // NaN >= 0.3 is false → the real fault is never corrected
  });
});

describe('PROBE dedupe key is eventId only', () => {
  it('a second session reusing eventIds is silently skipped by the same coach instance', () => {
    const { port, spoken } = voice();
    const coach = new LiveSessionCoach({ voice: port });
    coach.consumeSnapshot(snap([view(0, scored(6.0))], { sessionId: 'S1' }));
    coach.consumeSnapshot(snap([view(0, scored(4.0))], { sessionId: 'S2' }));
    console.log('[PROBE dedupe] spoken =', JSON.stringify(spoken));
    expect(spoken).toHaveLength(1);
  });
});

describe('PROBE liveSessionSummary round-trip', () => {
  it('build writes a fractional durationMs that parse zeroes', () => {
    const events = [view(0, scored(6.0))];
    const record = buildLiveSessionSummaryRecord(
      snap(events, { durationMs: 1234.5, phase: 'ended' }),
      sessionScoreProgression(events),
      null,
    );
    const parsed = parseLiveSessionSummaryRecord(JSON.stringify(record));
    console.log(
      '[PROBE summary] built durationMs =',
      record.durationMs,
      '→ parsed durationMs =',
      parsed?.durationMs,
    );
    expect(record.durationMs).toBe(1234.5);
    expect(parsed?.durationMs).toBe(0);
  });

  it('parse accepts self-inconsistent / out-of-range numbers and arbitrary strings', () => {
    const events = [view(0, scored(6.0))];
    const record = buildLiveSessionSummaryRecord(
      snap(events, { phase: 'ended' }),
      sessionScoreProgression(events),
      null,
    );
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify({
        ...record,
        scoredCount: 5,
        strokeCount: 1,
        sessionAverage: 999,
        topCorrection: 'not_a_checkpoint',
        correctionsByCheckpoint: { bogus_key: 2 },
      }).replace('"bogus_key"', '"__proto__":3,"bogus_key"'),
    );
    console.log('[PROBE summary] lenient parse =', JSON.stringify(parsed));
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionAverage).toBe(999);
    expect(parsed?.topCorrection).toBe('not_a_checkpoint');
    expect(parsed?.scoredCount).toBe(5);
    expect(Object.keys(parsed?.correctionsByCheckpoint ?? {}).sort()).toEqual([
      '__proto__',
      'bogus_key',
    ]);
    expect(({} as Record<string, unknown>).bogus_key).toBeUndefined();
  });
});

describe('PROBE sessionEndLine rounding contradiction via the REAL progression path', () => {
  it('cannot produce mismatched start/end strings when averages come from sessionScoreProgression', () => {
    // Direct call with unrounded inputs (the auditor repro):
    const direct = sessionEndLine({
      scoredCount: 2,
      startAverage: 6.24,
      endAverage: 6.26,
      best: 6.26,
    });
    // Real path: progression rounds both averages to 1 decimal first.
    const progression = sessionScoreProgression([
      view(0, scored(6.24)),
      view(1, scored(6.26)),
    ]);
    const real = sessionEndLine({
      scoredCount: progression.scoredCount,
      startAverage: progression.startAverage,
      endAverage: progression.endAverage,
      best: progression.best?.score ?? null,
    });
    console.log(
      '[PROBE endLine] direct =',
      direct,
      '| real =',
      real,
      '| averages =',
      progression.startAverage,
      progression.endAverage,
    );
    expect(direct).toContain(
      'started around 6.2 and finished around 6.3 — held steady at 6.3',
    );
    expect(progression.startAverage).toBe(6.2);
    expect(progression.endAverage).toBe(6.3);
    expect(real).not.toContain('held steady');
  });
});

describe('PROBE tts bridge with a partial native module', () => {
  it('available() is truthiness-based and speak() forwards without a guard', () => {
    console.log(
      '[PROBE tts] native module present in jest =',
      Boolean(NativeModules.PickleAudioCoach),
      'available =',
      tts.available(),
    );
    expect(tts.available()).toBe(false);
    expect(() => tts.speak('hello')).not.toThrow();
  });
});
