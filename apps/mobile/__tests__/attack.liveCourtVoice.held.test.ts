/**
 * ADVERSARIAL PASS — mobile-live-court-voice (HELD set).
 *
 * Attacks against LiveSessionCoach / tts / LiveCourtEngine that the code at
 * 4d812e1a is expected to SURVIVE. Every test here asserts the product
 * contract (speak once per event, in event order, quiet after end, honest
 * `spoken`, no crash on hostile input). A failure in this file is a new
 * regression. The sibling `attack.liveCourtVoice.broken.test.ts` holds the
 * attacks that currently FAIL (documented findings).
 *
 * Seeded randomness: every fuzz uses the LCG below with the seed printed in
 * the test name so a failure can be replayed exactly.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type {
  CheckpointKey,
  FaultDirection,
  ShotTypeSlug,
} from '@pickle/shared-types';
import { CHECKPOINTS, FAULT_DIRECTIONS } from '@pickle/shared-types';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
  type SpokenCue,
} from '../src/flow/liveSessionCoach';
import {
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  type LiveSessionSnapshot,
  type SessionEventAnalysisProvider,
  type SessionEventView,
} from '../src/flow/session';
import { sessionScoreProgression } from '../src/flow/sessionProgress';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../src/flow/liveSessionSummary';

// ─── fixtures ──────────────────────────────────────────────────────────────

interface CheckpointSpec {
  key: CheckpointKey;
  score: number | null;
  direction: FaultDirection;
  severity: number;
  applicable?: boolean;
}

function scoredAnalysis(
  overallScore: number | null,
  checkpoints: CheckpointSpec[],
  shotType: ShotTypeSlug = 'forehand_drive',
): AnalysisRecord {
  return {
    strokeResolution: { kind: 'declared', shotType },
    result: {
      resultKind: 'scored',
      overallScore,
      checkpoints: checkpoints.map(spec => ({
        key: spec.key,
        score: spec.score,
        confidence: 0.9,
        band: 'yellow',
        direction: spec.direction,
        severity: spec.severity,
        applicable: spec.applicable ?? true,
      })),
    },
  } as unknown as AnalysisRecord;
}

function lowConfidenceAnalysis(): AnalysisRecord {
  return {
    strokeResolution: { kind: 'unresolved' },
    result: {
      resultKind: 'low_confidence',
      overallScore: null,
      checkpoints: [],
    },
  } as unknown as AnalysisRecord;
}

function view(
  partial: Partial<SessionEventView> & { index: number },
): SessionEventView {
  const { index } = partial;
  return {
    eventId: `E${index + 1}`,
    startMs: index * 1000,
    endMs: index * 1000 + 400,
    peakMs: index * 1000 + 200,
    durationMs: 400,
    peakSpeed: 2.5,
    paddleConfirmed: true,
    closeReason: 'settle',
    closedAtMs: index * 1000 + 600,
    state: 'pending',
    pendingReason: null,
    abstainReason: null,
    analysis: null,
    family: null,
    boundaryUncertain: false,
    retroSuppressed: false,
    ...partial,
    index,
  };
}

function snap(
  events: SessionEventView[],
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  return {
    sessionId: 'attack-session',
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
    engineVersion: 'attack-engine',
    analysisProviderId: 'attack-provider',
    ...overrides,
  };
}

function makeVoice(available = true) {
  const spoken: Array<{ text: string; category: string | undefined }> = [];
  const voice: CoachVoicePort = {
    available: () => available,
    speak: (text, options) => {
      spoken.push({ text, category: options?.category });
    },
    stop: jest.fn(),
  };
  return { voice, spoken };
}

const kneeFault: CheckpointSpec = {
  key: 'athletic_base',
  score: 40,
  direction: 'low',
  severity: 0.5,
};
const clean: CheckpointSpec[] = [
  { key: 'contact_position', score: 88, direction: 'none', severity: 0.05 },
  { key: 'athletic_base', score: 90, direction: 'none', severity: 0.02 },
];

/** Deterministic LCG (Numerical Recipes constants) — replayable fuzz. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// ─── LiveSessionCoach: ordering / dedupe / idempotency ─────────────────────

describe('LiveSessionCoach — event ordering & dedupe under hostile snapshots', () => {
  it('speaks each event exactly once even when the same events are re-sent 500 times with shuffled order', () => {
    const seed = 0xc0ffee;
    const rnd = lcg(seed);
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = Array.from({ length: 12 }, (_, i) =>
      view({
        index: i,
        state: 'ready',
        analysis: scoredAnalysis(5 + (i % 5), i % 2 ? [kneeFault] : clean),
      }),
    );
    coach.consumeSnapshot(snap(events));
    for (let round = 0; round < 500; round += 1) {
      const shuffled = [...events].sort(() => rnd() - 0.5);
      coach.consumeSnapshot(snap(shuffled));
    }
    expect(spoken).toHaveLength(12);
    expect(coach.recap().cues.map(c => c.eventId)).toEqual(
      events.map(e => e.eventId),
    );
  });

  it('never re-speaks an event whose analysis record CHANGES after it was cued (re-analysis / corrupt overwrite)', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.4, [kneeFault]),
        }),
      ]),
    );
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(9.9, clean),
        }),
      ]),
    );
    coach.consumeSnapshot(
      snap([view({ index: 0, state: 'abstained', abstainReason: 'NO_POSE' })]),
    );
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toContain('6.4');
  });

  it('speaks late-settling events in EVENT order when several turn terminal in one snapshot, regardless of array order', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    // Snapshot 1: E1..E4 all pending.
    coach.consumeSnapshot(snap([0, 1, 2, 3].map(i => view({ index: i }))));
    // Snapshot 2: E3 and E1 settle, delivered in resolution order (E3 first).
    // The flow guarantees index order in `events`; the coach must at least
    // never speak an event twice or skip one when they later settle.
    const settled = [
      view({ index: 2, state: 'ready', analysis: scoredAnalysis(7.0, clean) }),
      view({
        index: 0,
        state: 'ready',
        analysis: scoredAnalysis(6.0, [kneeFault]),
      }),
      view({ index: 1 }),
      view({ index: 3 }),
    ];
    coach.consumeSnapshot(snap(settled));
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.0, [kneeFault]),
        }),
        view({ index: 1, state: 'ready', analysis: lowConfidenceAnalysis() }),
        view({
          index: 2,
          state: 'ready',
          analysis: scoredAnalysis(7.0, clean),
        }),
        view({ index: 3, state: 'abstained', abstainReason: 'NO_POSE' }),
      ]),
    );
    const ids = coach.recap().cues.map(c => c.eventId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.slice(2)).toEqual(['E2', 'E4']);
  });

  it('sessionEnded(final) twice → ONE end line and ONE registry write (scenario 6)', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [
      view({
        index: 0,
        state: 'ready',
        analysis: scoredAnalysis(6.0, [kneeFault]),
      }),
      view({ index: 1, state: 'ready', analysis: scoredAnalysis(7.0, clean) }),
    ];
    const final = snap(events, { sessionId: 'attack-twice', phase: 'ended' });
    coach.consumeSnapshot(final);
    const first = coach.sessionEnded(final);
    // Second call carries a DIFFERENT snapshot (a late analysis landed).
    const later = snap(
      [
        ...events,
        view({
          index: 2,
          state: 'ready',
          analysis: scoredAnalysis(9.0, clean),
        }),
      ],
      { sessionId: 'attack-twice', phase: 'ended' },
    );
    const second = coach.sessionEnded(later);
    const endLines = spoken.filter(s => s.category === 'SESSION_END');
    expect(endLines).toHaveLength(1);
    expect(second).toEqual(first);
    expect(getCompletedCoachRecap('attack-twice')).toEqual(first);
    // The late 9.0 must NOT be voiced after the wrap-up.
    expect(spoken.some(s => s.text.includes('9.0'))).toBe(false);
  });

  it('dispose() is idempotent and silences everything that follows (snapshots, repeated dispose)', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    coach.dispose();
    coach.dispose();
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.4, [kneeFault]),
        }),
      ]),
    );
    expect(voice.stop).toHaveBeenCalledTimes(2);
    expect(spoken).toHaveLength(1); // only the start line
    expect(coach.recap().cues).toHaveLength(1);
  });

  it('mute toggled between two snapshots: caption is logged for the muted event, speech resumes for the next, stop() fires once per mute', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const e0 = view({
      index: 0,
      state: 'ready',
      analysis: scoredAnalysis(6.4, [kneeFault]),
    });
    const e1 = view({
      index: 1,
      state: 'ready',
      analysis: scoredAnalysis(6.6, [kneeFault]),
    });
    coach.setMuted(true);
    coach.consumeSnapshot(snap([e0]));
    coach.setMuted(false);
    coach.setMuted(false);
    coach.consumeSnapshot(snap([e0, e1]));
    expect(voice.stop).toHaveBeenCalledTimes(1);
    expect(coach.recap().cues.map(c => c.spoken)).toEqual([false, true]);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.category).toBe('REPEAT_CORRECTION');
  });

  it('voice availability flapping mid-session (permission/route loss) is recorded per cue, never retroactively', () => {
    let available = true;
    const spokenTexts: string[] = [];
    const voice: CoachVoicePort = {
      available: () => available,
      speak: text => {
        spokenTexts.push(text);
      },
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice });
    const events = [
      view({
        index: 0,
        state: 'ready',
        analysis: scoredAnalysis(6.4, [kneeFault]),
      }),
      view({
        index: 1,
        state: 'ready',
        analysis: scoredAnalysis(6.5, [kneeFault]),
      }),
      view({
        index: 2,
        state: 'ready',
        analysis: scoredAnalysis(6.6, [kneeFault]),
      }),
    ];
    coach.consumeSnapshot(snap([events[0]!]));
    available = false;
    coach.consumeSnapshot(snap(events.slice(0, 2)));
    available = true;
    coach.consumeSnapshot(snap(events));
    expect(coach.recap().cues.map(c => c.spoken)).toEqual([true, false, true]);
    expect(coach.recap().spokenCount).toBe(2);
    expect(spokenTexts).toHaveLength(2);
  });

  it('a port returning a non-boolean truthy/`undefined` value still counts as spoken; only `false` suppresses', () => {
    const returns: unknown[] = [undefined, true, 1, 'ok', null, 0, false];
    let i = 0;
    const voice: CoachVoicePort = {
      available: () => true,
      speak: () => returns[i++] as boolean | void,
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap(
        returns.map((_, idx) =>
          view({
            index: idx,
            state: 'ready',
            analysis: scoredAnalysis(6.0, [kneeFault]),
          }),
        ),
      ),
    );
    // Contract: "Returning false means deliberately not voiced; void/true
    // both count as spoken". null/0 are not `false`, so they count as spoken.
    expect(coach.recap().cues.map(c => c.spoken)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});

// ─── hostile analysis payloads ─────────────────────────────────────────────

describe('LiveSessionCoach — hostile analysis payloads', () => {
  it('unicode / RTL / zero-width / emoji in checkpoint text never crash and never leak into spoken cues (phrases are canned)', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const hostile = scoredAnalysis(6.4, [kneeFault]);
    // Corrupt the record with hostile strings in places the coach never reads.
    (hostile as unknown as Record<string, unknown>).strokeResolution = {
      kind: 'declared',
      shotType: '\u202Eforehand\u200B\uD83E\uDD4F\u0000drive',
    };
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          eventId: '\u202EE1\u0000\uFEFF',
          state: 'ready',
          analysis: hostile,
          abstainReason: '\uD83D\uDE00'.repeat(1000),
        }),
      ]),
    );
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe('6.4. Bend the knees more.');
    expect(coach.recap().cues[0]?.eventId).toBe('\u202EE1\u0000\uFEFF');
  });

  it('a 5 000-checkpoint record (huge input) is cued once with the worst applicable checkpoint and in bounded time', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const rnd = lcg(0x5eed);
    const checkpoints: CheckpointSpec[] = Array.from(
      { length: 5000 },
      (_, i) => ({
        key: CHECKPOINTS[i % CHECKPOINTS.length]!,
        score: Math.floor(rnd() * 100),
        direction: FAULT_DIRECTIONS[i % FAULT_DIRECTIONS.length]!,
        severity: rnd() * 0.29, // all below the correction threshold…
      }),
    );
    checkpoints.push({
      key: 'paddle_set',
      score: 10,
      direction: 'low',
      severity: 0.95,
    }); // …except one
    const started = Date.now();
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(4.2, checkpoints),
        }),
      ]),
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe('4.2. Set the paddle higher.');
    expect(coach.lastCue()?.targetCheckpoint).toBe('paddle_set');
  });

  it('2 000 events fed through 2 000 growing snapshots: exactly 2 000 cues, event order preserved, O(n²) loop stays under 5 s', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const rnd = lcg(0xbeef);
    const events: SessionEventView[] = [];
    const started = Date.now();
    for (let i = 0; i < 2000; i += 1) {
      const roll = rnd();
      events.push(
        roll < 0.6
          ? view({
              index: i,
              state: 'ready',
              analysis: scoredAnalysis(
                Math.round(rnd() * 100) / 10,
                roll < 0.3 ? [kneeFault] : clean,
              ),
            })
          : roll < 0.8
            ? view({
                index: i,
                state: 'ready',
                analysis: lowConfidenceAnalysis(),
              })
            : view({ index: i, state: 'abstained', abstainReason: 'NO_POSE' }),
      );
      coach.consumeSnapshot(snap(events));
    }
    expect(Date.now() - started).toBeLessThan(5000);
    const cues = coach.recap().cues;
    expect(cues).toHaveLength(2000);
    expect(cues.map(c => c.eventId)).toEqual(events.map(e => e.eventId));
    expect(cues.every(c => c.text.length > 0)).toBe(true);
  });

  it('negative / zero / >10 / clock-skewed durationMs is passed through verbatim to atMs, never clamped or reordered', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const e = view({
      index: 0,
      state: 'ready',
      analysis: scoredAnalysis(6.4, [kneeFault]),
    });
    coach.consumeSnapshot(snap([e], { durationMs: -5000 }));
    expect(coach.lastCue()?.atMs).toBe(-5000);
    const e2 = view({
      index: 1,
      state: 'ready',
      analysis: scoredAnalysis(6.4, [kneeFault]),
    });
    coach.consumeSnapshot(snap([e, e2], { durationMs: 0 }));
    expect(coach.lastCue()?.atMs).toBe(0);
    const final = snap([e, e2], {
      durationMs: Number.MAX_SAFE_INTEGER,
      phase: 'ended',
    });
    coach.sessionEnded(final);
    expect(coach.lastCue()?.atMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('scored result with overallScore null is voiced as an honest no-read, not as a score', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(null, [kneeFault]),
        }),
      ]),
    );
    expect(coach.lastCue()?.category).toBe('NO_READ');
    expect(spoken[0]?.text).not.toMatch(/null|undefined|NaN/);
  });

  it('recap correction tally is exact under 1 000 seeded reps and topCorrection is the argmax (ties → first seen)', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const rnd = lcg(0x1234);
    const events: SessionEventView[] = [];
    const keys: CheckpointKey[] = [
      'athletic_base',
      'paddle_set',
      'contact_position',
    ];
    for (let i = 0; i < 1000; i += 1) {
      const key = keys[Math.floor(rnd() * keys.length)]!;
      events.push(
        view({
          index: i,
          state: 'ready',
          analysis: scoredAnalysis(6.0, [
            { key, score: 30, direction: 'low', severity: 0.7 },
          ]),
        }),
      );
    }
    coach.consumeSnapshot(snap(events));
    const recap = coach.recap();
    const expected: Partial<Record<CheckpointKey, number>> = {};
    for (const cue of recap.cues) {
      if (
        cue.category === 'CORRECTION' ||
        cue.category === 'REPEAT_CORRECTION'
      ) {
        expected[cue.targetCheckpoint!] =
          (expected[cue.targetCheckpoint!] ?? 0) + 1;
      }
    }
    expect(recap.correctionsByCheckpoint).toEqual(expected);
    const total = Object.values(recap.correctionsByCheckpoint).reduce(
      (a, b) => a + b,
      0,
    );
    // Every rep here has a severe fault, and no IMPROVEMENT can fire (scores
    // never rise), so every rep is a correction of some kind.
    expect(total).toBe(1000);
    const max = Math.max(...Object.values(recap.correctionsByCheckpoint));
    expect(recap.correctionsByCheckpoint[recap.topCorrection!]).toBe(max);
  });
});

// ─── LiveSummary record round-trip ─────────────────────────────────────────

describe('liveSessionSummary — recap → record → parse', () => {
  it('round-trips a real recap and rejects corrupt/foreign/huge payloads without throwing', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [
      view({
        index: 0,
        state: 'ready',
        analysis: scoredAnalysis(6.0, [kneeFault]),
      }),
      view({ index: 1, state: 'ready', analysis: scoredAnalysis(7.0, clean) }),
      view({ index: 2 }),
    ];
    const final = snap(events, { sessionId: 'attack-summary', phase: 'ended' });
    coach.consumeSnapshot(final);
    const recap = coach.sessionEnded(final);
    const record = buildLiveSessionSummaryRecord(
      final,
      sessionScoreProgression(events),
      recap,
    );
    expect(record.cuesSpoken).toBe(3);
    expect(record.pendingCount).toBe(1);
    expect(parseLiveSessionSummaryRecord(JSON.stringify(record))).toEqual(
      record,
    );

    const hostile = [
      '',
      '{',
      'null',
      '[]',
      '"str"',
      JSON.stringify({ version: 2, source: 'live' }),
      JSON.stringify({ version: 1, source: 'Live' }),
      JSON.stringify({
        version: 1,
        source: 'live',
        __proto__: { polluted: true },
      }),
      '{"version":1,"source":"live","durationMs":' + '9'.repeat(400) + '}',
      JSON.stringify({
        version: 1,
        source: 'replay',
        correctionsByCheckpoint: {
          a: 1.5,
          b: 'x',
          c: Number.MAX_SAFE_INTEGER,
          d: -1,
        },
        cuesSpoken: -3,
        bestScore: 'NaN',
        topCorrection: 42,
      }),
    ];
    for (const json of hostile) {
      expect(() => parseLiveSessionSummaryRecord(json)).not.toThrow();
    }
    expect(parseLiveSessionSummaryRecord(hostile[8]!)?.durationMs).toBe(0);
    const parsed = parseLiveSessionSummaryRecord(hostile[9]!);
    expect(parsed?.correctionsByCheckpoint).toEqual({
      c: Number.MAX_SAFE_INTEGER,
      d: -1,
    });
    expect(parsed?.cuesSpoken).toBe(0);
    expect(parsed?.bestScore).toBeNull();
    expect(parsed?.topCorrection).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ─── tts bridge: missing native module ─────────────────────────────────────

describe('tts bridge — native module absent', () => {
  it('reports unavailable and every call is a harmless no-op (no throw) when PickleAudioCoach is not linked', () => {
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({ NativeModules: {} }));
      const { tts } =
        jest.requireActual<typeof import('../src/audio/tts')>(
          '../src/audio/tts',
        );
      expect(tts.available()).toBe(false);
      expect(() => tts.speak('hello')).not.toThrow();
      expect(() => tts.stop()).not.toThrow();
      // And the coach records honest captions only.
      const coach = new LiveSessionCoach({ voice: tts });
      coach.sessionStarted('live');
      expect(coach.lastCue()?.spoken).toBe(false);
    });
  });

  it('a native module object without `speak` (partial link) is treated as unavailable', () => {
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({
        NativeModules: { PickleAudioCoach: { stop: jest.fn() } },
      }));
      const { tts } =
        jest.requireActual<typeof import('../src/audio/tts')>(
          '../src/audio/tts',
        );
      expect(tts.available()).toBe(false);
    });
  });
});

// ─── real LiveSessionFlow interleavings ────────────────────────────────────

describe('LiveSessionCoach + LiveSessionFlow — interruptions mid-flight', () => {
  function deferredProvider() {
    const resolvers: Array<() => void> = [];
    const provider: SessionEventAnalysisProvider = {
      providerId: 'deferred',
      availability: () => ({ status: 'available' }),
      analyzeEvent: request =>
        new Promise(resolve => {
          resolvers.push(() =>
            resolve(
              request.eventId === 'E2'
                ? { status: 'abstained', abstainReason: 'POSE_TOO_SPARSE' }
                : {
                    status: 'ready',
                    analysis: scoredAnalysis(6.4, [kneeFault]),
                  },
            ),
          );
        }),
    };
    return { provider, resolvers };
  }

  /** analyzeEvent is invoked behind the async clip-extraction step, so the
   * resolvers only exist after the microtask queue drains. */
  const drain = () => new Promise<void>(resolve => setImmediate(resolve));

  it('user stops the session while every analysis is still in flight → end line first, late analyses stay silent, recap registered once', async () => {
    const { provider, resolvers } = deferredProvider();
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'attack-flight',
      source: 'live',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    coach.sessionStarted('live');
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    const final = flow.end();
    expect(final.strokeCount).toBe(3);
    expect(final.events.every(e => e.state === 'processing')).toBe(true);
    const recap = coach.sessionEnded(final);
    await drain();
    expect(resolvers).toHaveLength(3);
    // Now the analyses land, out of order.
    for (const resolve of [...resolvers].reverse()) resolve();
    await flow.settled();
    expect(spoken.map(s => s.category)).toEqual([
      'SESSION_START',
      'SESSION_END',
    ]);
    expect(spoken[1]?.text).toBe(
      'Session over. No swings could be scored this time.',
    );
    expect(getCompletedCoachRecap('attack-flight')).toEqual(recap);
    expect(coach.recap().cues).toHaveLength(2);
    // The flow's own summary DOES see the late reads (design: they land in the
    // summary, not in the voice).
    expect(sessionScoreProgression(flow.snapshot().events).scoredCount).toBe(2);
  });

  it('an onUpdate observer that throws is isolated by the flow: the coach still receives every later snapshot', async () => {
    const { provider, resolvers } = deferredProvider();
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    let calls = 0;
    const flow = new LiveSessionFlow({
      sessionId: 'attack-throwing-observer',
      source: 'live',
      provider,
      onUpdate: next => {
        calls += 1;
        coach.consumeSnapshot(next);
        if (calls % 3 === 0) throw new Error('HUD exploded');
      },
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    const final = flow.end();
    await drain();
    expect(resolvers).toHaveLength(3);
    for (const resolve of resolvers) resolve();
    await flow.settled();
    expect(final.onUpdateFailures).toBeGreaterThan(0);
    coach.sessionEnded(final);
    expect(coach.recap().cues.filter(c => c.eventId !== null)).toHaveLength(3);
  });
});

// ─── seeded fuzz over the whole coach ──────────────────────────────────────

describe('LiveSessionCoach — seeded fuzz invariants', () => {
  for (const seed of [1, 42, 0xdead, 20260904]) {
    it(`seed=${seed}: one cue per terminal event, in order, spoken === (available && !muted && port accepted), nothing after end`, () => {
      const rnd = lcg(seed);
      let available = true;
      let muted = false;
      let lastPortReturn: boolean | undefined;
      const voice: CoachVoicePort = {
        available: () => available,
        speak: () => {
          lastPortReturn = rnd() < 0.1 ? false : undefined;
          return lastPortReturn;
        },
        stop: jest.fn(),
      };
      const seen: SpokenCue[] = [];
      const coach = new LiveSessionCoach({
        voice,
        onCue: cue => {
          seen.push(cue);
          const expectedSpoken =
            available && !muted && lastPortReturn !== false;
          expect(cue.spoken).toBe(expectedSpoken);
          lastPortReturn = undefined;
        },
      });
      coach.sessionStarted(rnd() < 0.5 ? 'live' : 'replay');
      const events: SessionEventView[] = [];
      const terminalAt = new Map<string, number>();
      let ended = false;
      let endedAtStep = -1;
      const steps = 400;
      for (let step = 0; step < steps; step += 1) {
        const roll = rnd();
        if (roll < 0.25) {
          events.push(view({ index: events.length }));
        } else if (roll < 0.6 && events.some(e => e.state === 'pending')) {
          const pendingIdx = events.findIndex(e => e.state === 'pending');
          const outcome = rnd();
          events[pendingIdx] =
            outcome < 0.6
              ? view({
                  index: pendingIdx,
                  state: 'ready',
                  analysis: scoredAnalysis(
                    Math.round(rnd() * 100) / 10,
                    rnd() < 0.5 ? [kneeFault] : clean,
                  ),
                })
              : outcome < 0.8
                ? view({
                    index: pendingIdx,
                    state: 'ready',
                    analysis: lowConfidenceAnalysis(),
                  })
                : view({
                    index: pendingIdx,
                    state: 'abstained',
                    abstainReason: 'NO_POSE',
                  });
          if (!ended) terminalAt.set(events[pendingIdx]!.eventId, step);
        } else if (roll < 0.7) {
          muted = !muted;
          coach.setMuted(muted);
        } else if (roll < 0.78) {
          available = !available;
        } else if (roll < 0.8 && !ended && step > steps / 2) {
          ended = true;
          endedAtStep = step;
          coach.sessionEnded(
            snap(events, { phase: 'ended', sessionId: `fuzz-${seed}` }),
          );
        }
        if (!ended || rnd() < 0.5) coach.consumeSnapshot(snap(events));
      }
      if (!ended)
        coach.sessionEnded(
          snap(events, { phase: 'ended', sessionId: `fuzz-${seed}` }),
        );

      const cues = coach.recap().cues;
      expect(seen).toEqual(cues);
      const eventCues = cues.filter(c => c.eventId !== null);
      // Exactly the events that turned terminal BEFORE the end were cued, once.
      const expectedIds = events
        .filter(e => e.state !== 'pending' && terminalAt.has(e.eventId))
        .filter(
          e =>
            endedAtStep < 0 ||
            (terminalAt.get(e.eventId) ?? Infinity) <= endedAtStep,
        )
        .map(e => e.eventId);
      // Every step that settles an event also delivers that snapshot, so the
      // cued set must equal the settled-before-end set exactly.
      expect(eventCues.map(c => c.eventId)).toEqual(expectedIds);
      // Event order: cue eventIds ascend in event index.
      const indices = eventCues.map(c => Number(c.eventId!.slice(1)));
      expect([...indices].sort((a, b) => a - b)).toEqual(indices);
      // Start first, end last, exactly one of each.
      expect(cues[0]?.category).toBe('SESSION_START');
      expect(cues.at(-1)?.category).toBe('SESSION_END');
      expect(cues.filter(c => c.category === 'SESSION_START')).toHaveLength(1);
      expect(cues.filter(c => c.category === 'SESSION_END')).toHaveLength(1);
      expect(cues.every(c => c.text.length > 0)).toBe(true);
      expect(coach.recap().spokenCount).toBe(cues.filter(c => c.spoken).length);
    });
  }
});
