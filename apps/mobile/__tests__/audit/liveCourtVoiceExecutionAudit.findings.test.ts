/**
 * Execution audit FINDINGS harness (pass 2 of 3) for `mobile-live-court-voice`.
 *
 * Each test asserts the behaviour the module contracts promise (docstrings in
 * src/flow/liveSessionCoach.ts, src/flow/liveSessionSummary.ts,
 * src/flow/liveCourt.ts) and FAILS on 4d812e1a, documenting a concrete
 * deviation. They are intentionally red: the coordinator decides whether each
 * is a bug to fix or a contract to reword. Nothing here is wired into CI.
 *
 * New file only — production code is unchanged.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { CheckpointKey, FaultDirection } from '@pickle/shared-types';
import { ok } from '@pickle/shared-types';
import { createFixtureVisionProviderSet } from '../../../../packages/vision-contracts/test/support/fixtureProvider';
import { LiveCourtEngine } from '../../src/flow/liveCourt';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
} from '../../src/flow/liveSessionCoach';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../../src/flow/liveSessionSummary';
import {
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  type LiveSessionSnapshot,
  type SessionEventAnalysisProvider,
  type SessionEventView,
} from '../../src/flow/session';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';

declare const process: { env: Record<string, string | undefined> };
process.env.PICKLE_ENV = 'development';

interface CheckpointSpec {
  key: CheckpointKey;
  score: number | null;
  direction: FaultDirection;
  severity: number;
}

function scoredAnalysis(
  overallScore: number,
  checkpoints: CheckpointSpec[],
): AnalysisRecord {
  return {
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
    result: {
      resultKind: 'scored',
      overallScore,
      checkpoints: checkpoints.map(spec => ({
        ...spec,
        confidence: 0.9,
        band: 'yellow',
        applicable: true,
      })),
    },
  } as unknown as AnalysisRecord;
}

function scoredView(index: number, score: number): SessionEventView {
  return {
    eventId: `E${index + 1}`,
    index,
    startMs: index * 1000,
    endMs: index * 1000 + 400,
    peakMs: index * 1000 + 200,
    durationMs: 400,
    peakSpeed: 2.5,
    paddleConfirmed: true,
    closeReason: 'settle',
    closedAtMs: index * 1000 + 600,
    state: 'ready',
    pendingReason: null,
    abstainReason: null,
    analysis: scoredAnalysis(score, [
      { key: 'athletic_base', score: 40, direction: 'low', severity: 0.5 },
    ]),
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
    sessionId: 'findings-session',
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
    engineVersion: 'audit-engine-1',
    analysisProviderId: 'audit-provider',
    ...overrides,
  };
}

function makeVoice(speak: CoachVoicePort['speak'] = () => undefined) {
  const stop = jest.fn();
  const voice: CoachVoicePort = { available: () => true, speak, stop };
  return { voice, stop };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('FINDING A — a throwing voice port loses the cue for good (no caption, no recap, never retried)', () => {
  it('liveSessionCoach.ts:254-265 — contract says muted/unavailable voice still LOGS the cue; a throwing speak() logs nothing', () => {
    let attempts = 0;
    const { voice } = makeVoice(() => {
      attempts += 1;
      throw new Error('AVSpeechSynthesizer bridge rejected');
    });
    const captions: string[] = [];
    const coach = new LiveSessionCoach({
      voice,
      onCue: cue => captions.push(cue.text),
    });
    const events = [scoredView(0, 6.2), scoredView(1, 6.4)];
    let thrown: unknown = null;
    try {
      coach.consumeSnapshot(snap(events));
    } catch (error) {
      thrown = error;
    }
    // Second snapshot: E1 is already marked consumed, so it is never spoken
    // or captioned again; E2 is picked up only now.
    try {
      coach.consumeSnapshot(snap(events));
    } catch {
      // second throw for E2
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(attempts).toBe(2);
    // EXPECTED (per contract): both cues recorded with spoken=false so the HUD
    // caption and the recap still carry them.
    expect(coach.recap().cues.map(cue => [cue.eventId, cue.spoken])).toEqual([
      ['E1', false],
      ['E2', false],
    ]);
    expect(captions).toHaveLength(2);
  });

  it('end-to-end: the throw is swallowed by LiveSessionFlow.notify (onUpdateFailures) and the swing is silently dropped from the coach log', async () => {
    const { voice } = makeVoice(() => {
      throw new Error('bridge rejected');
    });
    const coach = new LiveSessionCoach({ voice });
    const provider: SessionEventAnalysisProvider = {
      providerId: 'ok',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => ({
        status: 'ready',
        analysis: scoredAnalysis(6.4, []),
      }),
    };
    const flow = new LiveSessionFlow({
      sessionId: 'throw-e2e',
      source: 'live',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    const final = flow.snapshot();
    expect(final.events.every(e => e.state === 'ready')).toBe(true);
    // OBSERVED: onUpdateFailures === 3 and recap().cues is empty.
    // EXPECTED: three captioned (spoken=false) cues; no subscriber failures.
    expect(final.onUpdateFailures).toBe(0);
    expect(coach.recap().cues).toHaveLength(3);
  });
});

describe('FINDING B — cues follow analysis-RESOLUTION order, not event order (contradicts liveSessionCoach.ts:28)', () => {
  it('E3 resolves first → it is spoken as "rep 1" and the coach state (last/best score) is seeded from the newest swing', async () => {
    const gates = new Map<string, () => void>();
    const scores: Record<string, number> = { E1: 5.5, E2: 6.5, E3: 7.5 };
    const provider: SessionEventAnalysisProvider = {
      providerId: 'gated',
      availability: () => ({ status: 'available' }),
      analyzeEvent: request =>
        new Promise(resolve => {
          gates.set(request.eventId, () =>
            resolve({
              status: 'ready',
              analysis: scoredAnalysis(scores[request.eventId] ?? 6, []),
            }),
          );
        }),
    };
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'order-1',
      source: 'live',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    flow.end();
    await flushMicrotasks();
    for (const id of ['E3', 'E1', 'E2']) {
      gates.get(id)!();
      await flushMicrotasks();
    }
    await flow.settled();
    const spokenOrder = coach.recap().cues.map(cue => cue.eventId);
    // Session-end math is in EVENT order (sessionProgress.ts) → "up 2".
    expect(sessionScoreProgression(flow.snapshot().events).delta).toBe(2);
    // EXPECTED per docstring "spoken about at most ONCE, in event order".
    // OBSERVED: ['E3', 'E1', 'E2'].
    expect(spokenOrder).toEqual(['E1', 'E2', 'E3']);
  });
});

describe('FINDING C — dispose() before sessionEnded() drops the SESSION_END line and the recap registry entry', () => {
  it('liveSessionCoach.ts:193-218 — after dispose(), sessionEnded() is a no-op so LiveSummary finds no recap', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const final = snap([scoredView(0, 6.2)], {
      sessionId: 'dispose-then-end',
      phase: 'ended',
    });
    coach.consumeSnapshot(final);
    coach.dispose(); // screen unmount
    const recap = coach.sessionEnded(final);
    // EXPECTED: the recap for a session that DID happen is registered
    // (dispose only cuts the utterance; "Keeps the log").
    expect(getCompletedCoachRecap('dispose-then-end')).not.toBeNull();
    expect(recap.cues.at(-1)?.category).toBe('SESSION_END');
  });
});

describe('FINDING D — sessionStarted() ignores the ended flag', () => {
  it('liveSessionCoach.ts:144-156 — a start line after dispose()/sessionEnded() is still spoken ("nobody talks to an empty court")', () => {
    const spoken: string[] = [];
    const { voice } = makeVoice(text => {
      spoken.push(text);
    });
    const coach = new LiveSessionCoach({ voice });
    coach.sessionEnded(snap([], { phase: 'ended' }));
    coach.dispose();
    coach.sessionStarted('live');
    // EXPECTED: nothing spoken after the session ended.
    expect(spoken.filter(text => !text.startsWith('Session over'))).toEqual([]);
  });
});

describe('FINDING E — summary record round trip zeroes a fractional durationMs', () => {
  it('liveSessionSummary.ts:78-82,113 — build() writes snapshot.durationMs verbatim, parse() requires a safe integer', () => {
    const final = snap([scoredView(0, 6.2)], {
      durationMs: 1234.5,
      phase: 'ended',
    });
    const record = buildLiveSessionSummaryRecord(
      final,
      sessionScoreProgression(final.events),
      null,
    );
    expect(record.durationMs).toBe(1234.5);
    const parsed = parseLiveSessionSummaryRecord(JSON.stringify(record));
    // EXPECTED: a value the writer accepted survives its own parser
    // (sessionNative.ts accepts any finite tMs >= 0, so fractional clocks are
    // legal at the TS boundary even though the Swift emitter sends Int).
    expect(parsed?.durationMs).toBe(1234.5);
  });
});

describe('FINDING F — LiveCourtEngine counts a failed stroke analysis as a rep index but not as a rep', () => {
  it('liveCourt.ts:67,79 — repCounter advances before analysis; a null result leaves a gap and vanishes from summary()', async () => {
    const base = createFixtureVisionProviderSet('forehand_drive');
    let strokes = 0;
    const providers = {
      ...base,
      stroke: {
        ...base.stroke,
        detectStrokes: async (
          ...args: Parameters<typeof base.stroke.detectStrokes>
        ) => {
          strokes += 1;
          return strokes === 1 ? ok([]) : base.stroke.detectStrokes(...args);
        },
      },
    };
    let counter = 0;
    const engine = new LiveCourtEngine(providers, {
      sessionId: '11111111-2222-4333-8444-555555555555',
      shotType: 'forehand_drive',
      focusCheckpoint: 'contact_position',
      handedness: 'right',
      appVersion: '0.1.0-test',
      modelBundleVersion: 'fixture-1',
      makeId: () =>
        `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    });
    const clip = {
      uri: 'fixture://forehand/live',
      durationMs: 2400,
      fps: 30,
      width: 720,
      height: 1280,
    };
    expect(await engine.onStroke(clip)).toBeNull();
    const rep = await engine.onStroke(clip);
    expect(rep).not.toBeNull();
    const summary = engine.summary();
    // OBSERVED: the first real LiveRep carries repIndex 2, and the failed
    // stroke is neither a valid nor a low-confidence rep (2 swings → 1 counted).
    // EXPECTED: rep indices are dense over recorded reps, or the failed swing
    // is surfaced in the summary as unreadable rather than disappearing.
    expect(rep!.repIndex).toBe(1);
    expect(summary.validReps + summary.lowConfidenceReps).toBe(2);
  });
});
