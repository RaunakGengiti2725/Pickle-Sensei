/**
 * ADVERSARIAL PASS 3 / tester #4 — scenarios S2 and S8.
 *
 * S2: a wrist sample whose tMs regresses behind the closed-event frontier
 *     (native clock skew / a queued late emission) after E2 closed must be
 *     dropped and counted, never rewrite or reorder E1/E2.
 * S8: a voice port that throws is wired through a REAL LiveSessionFlow via
 *     onUpdate → coach.consumeSnapshot. The port failure must not corrupt
 *     event states; the scenario asks whether the coach isolates it
 *     (onUpdateFailures stays 0) and whether the cue itself survives.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import {
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  type LiveSessionSnapshot,
  type SessionEventAnalysisProvider,
  type SessionEventView,
} from '../../src/flow/session';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
  type LiveCoachRecap,
} from '../../src/flow/liveSessionCoach';

const samples = DEV_REPLAY_RALLY.samples;

function pendingProvider(): SessionEventAnalysisProvider {
  return {
    providerId: 'attack-pending-provider',
    availability: () => ({ status: 'available' }),
    analyzeEvent: async () => ({ status: 'pending', pendingReason: 'HOLD' }),
  };
}

function scoredAnalysis(overallScore: number): AnalysisRecord {
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
          severity: 0.5,
          applicable: true,
        },
      ],
    },
  } as unknown as AnalysisRecord;
}

function bounds(event: SessionEventView) {
  return {
    eventId: event.eventId,
    index: event.index,
    startMs: event.startMs,
    peakMs: event.peakMs,
    endMs: event.endMs,
    closeReason: event.closeReason,
    closedAtMs: event.closedAtMs,
  };
}

/** Feed the recorded rally until exactly `count` events have closed. */
function feedUntilClosed(
  flow: LiveSessionFlow,
  count: number,
): { fed: number; lastTMs: number } {
  let fed = 0;
  let lastTMs = 0;
  for (const sample of samples) {
    flow.pushSample(sample);
    fed += 1;
    lastTMs = sample.tMs;
    if (flow.snapshot().events.length >= count) break;
  }
  return { fed, lastTMs };
}

describe('S2 — late (time-regressing) sample after E2 closed', () => {
  it('drops the regressing sample, counts it, and leaves E1/E2 bounds and order untouched', () => {
    const flow = new LiveSessionFlow({
      sessionId: 'attack-late-1',
      source: 'live',
      provider: pendingProvider(),
    });
    const { fed, lastTMs } = feedUntilClosed(flow, 2);
    const before = flow.snapshot();
    expect(before.events.map(e => e.eventId)).toEqual(['E1', 'E2']);
    expect(before.droppedLateSamples).toBe(0);
    const e2EndMs = before.events[1]!.endMs;
    expect(lastTMs).toBeGreaterThan(e2EndMs);

    // Regress well behind E2's end (the closed-event frontier).
    const late = { tMs: e2EndMs - 600, v: 3.5 };
    const closed = flow.pushSample(late);
    expect(closed).toEqual([]);
    const after = flow.snapshot();
    expect(after.droppedLateSamples).toBe(1);
    expect(after.events.map(bounds)).toEqual(before.events.map(bounds));
    // Session clock never runs backwards.
    expect(after.durationMs).toBe(before.durationMs);

    // A sample exactly AT the frontier is also late (<=).
    flow.pushSample({ tMs: e2EndMs, v: 3.5 });
    expect(flow.snapshot().droppedLateSamples).toBe(2);

    // Resume the real stream and finish: E1/E2 unchanged, E3 appended.
    for (const sample of samples.slice(fed)) flow.pushSample(sample);
    const final = flow.end();
    expect(final.events.slice(0, 2).map(bounds)).toEqual(
      before.events.map(bounds),
    );
    expect(final.events.map(e => e.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(final.events.map(e => e.index)).toEqual([0, 1, 2]);
    expect(final.droppedLateSamples).toBe(2);
  });

  it('a burst of regressing samples (clock skew) never resurrects or splits closed events', () => {
    const flow = new LiveSessionFlow({
      sessionId: 'attack-late-2',
      source: 'live',
      provider: pendingProvider(),
    });
    const { fed } = feedUntilClosed(flow, 2);
    const before = flow.snapshot();
    // Deterministic pseudo-random burst (seed 0x5EED) of samples inside E1/E2.
    let seed = 0x5eed;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const e2EndMs = before.events[1]!.endMs;
    for (let i = 0; i < 200; i += 1) {
      flow.pushSample({ tMs: Math.floor(next() * e2EndMs), v: next() * 4 });
    }
    const after = flow.snapshot();
    expect(after.droppedLateSamples).toBe(200);
    expect(after.events.map(bounds)).toEqual(before.events.map(bounds));
    for (const sample of samples.slice(fed)) flow.pushSample(sample);
    const final = flow.end();
    expect(final.events.map(e => e.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(final.droppedLateSamples).toBe(200);
  });

  it('a slightly regressing sample that is still past the frontier is accepted, not counted late', () => {
    const flow = new LiveSessionFlow({
      sessionId: 'attack-late-3',
      source: 'live',
      provider: pendingProvider(),
    });
    const { lastTMs } = feedUntilClosed(flow, 2);
    const before = flow.snapshot();
    const e2EndMs = before.events[1]!.endMs;
    // Behind the last sample but after the frontier: within tolerance.
    const tMs = e2EndMs + 1;
    expect(tMs).toBeLessThan(lastTMs);
    flow.pushSample({ tMs, v: 0.2 });
    const after = flow.snapshot();
    expect(after.droppedLateSamples).toBe(0);
    expect(after.events.map(bounds)).toEqual(before.events.map(bounds));
  });

  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
  ])(
    'a %s tMs is ignored by the engine and does not poison the session clock',
    (_label, tMs) => {
      const flow = new LiveSessionFlow({
        sessionId: `attack-late-4-${_label}`,
        source: 'live',
        provider: pendingProvider(),
      });
      const { fed } = feedUntilClosed(flow, 1);
      const before = flow.snapshot();
      flow.pushSample({ tMs, v: 1 });
      const after = flow.snapshot();
      // The engine itself drops non-finite samples (the event list is unchanged), so the
      // event list is unchanged either way.
      expect(after.events.map(bounds)).toEqual(before.events.map(bounds));
      // durationMs is Math.max(lastSampleMs, tMs): +Infinity / NaN must not
      // leak into the session time axis.
      expect(Number.isFinite(after.durationMs)).toBe(true);
      expect(after.durationMs).toBe(before.durationMs);
      // ...and a later real sample must restore/keep a finite clock.
      flow.pushSample(samples[fed]!);
      expect(Number.isFinite(flow.snapshot().durationMs)).toBe(true);
    },
  );
});

describe('S8 — throwing voice port wired through a real LiveSessionFlow', () => {
  function throwingVoice(): { voice: CoachVoicePort; attempts: string[] } {
    const attempts: string[] = [];
    const voice: CoachVoicePort = {
      available: () => true,
      speak: text => {
        attempts.push(text);
        throw new Error('AVSpeechSynthesizer bridge rejected utterance');
      },
      stop: () => undefined,
    };
    return { voice, attempts };
  }

  async function runRally(voice: CoachVoicePort) {
    const provider: SessionEventAnalysisProvider = {
      providerId: 'attack-scored-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => ({
        status: 'ready',
        analysis: scoredAnalysis(6.4),
      }),
    };
    const snapshots: LiveSessionSnapshot[] = [];
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'attack-throwing-port',
      source: 'live',
      provider,
      onUpdate: next => {
        snapshots.push(next);
        coach.consumeSnapshot(next);
      },
    });
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    return { coach, flow, snapshots };
  }

  it('event states are untouched: every closed event still ends ready with its analysis', async () => {
    const { voice } = throwingVoice();
    const { flow } = await runRally(voice);
    const final = flow.snapshot();
    expect(final.events.map(e => e.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(final.events.map(e => e.state)).toEqual(['ready', 'ready', 'ready']);
    expect(final.events.every(e => e.analysis !== null)).toBe(true);
    expect(final.events.every(e => e.abstainReason === null)).toBe(true);
  });

  it('the coach isolates the port failure: snapshot.onUpdateFailures stays 0', async () => {
    const { voice } = throwingVoice();
    const { flow } = await runRally(voice);
    expect(flow.snapshot().onUpdateFailures).toBe(0);
  });

  it('a cue whose utterance failed is still logged (spoken:false) so the HUD caption survives', async () => {
    const { voice, attempts } = throwingVoice();
    const { coach } = await runRally(voice);
    const recap = coach.recap();
    // The port was asked once per terminal event.
    expect(attempts).toHaveLength(3);
    const eventCues = recap.cues.filter(cue => cue.eventId !== null);
    expect(eventCues.map(cue => cue.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(eventCues.every(cue => cue.spoken === false)).toBe(true);
  });

  it('a port that throws only once does not silence the rest of the session', async () => {
    let calls = 0;
    const spoken: string[] = [];
    const voice: CoachVoicePort = {
      available: () => true,
      speak: text => {
        calls += 1;
        if (calls === 1) throw new Error('transient bridge failure');
        spoken.push(text);
      },
      stop: () => undefined,
    };
    const { coach, flow } = await runRally(voice);
    expect(flow.snapshot().events.map(e => e.state)).toEqual([
      'ready',
      'ready',
      'ready',
    ]);
    // E2 and E3 are spoken; E1 is logged as not spoken.
    expect(spoken).toHaveLength(2);
    const eventCues = coach.recap().cues.filter(cue => cue.eventId !== null);
    expect(eventCues.map(cue => cue.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(eventCues.map(cue => cue.spoken)).toEqual([false, true, true]);
  });

  it('a port that throws on the wrap-up line still registers the completed recap for LiveSummary', async () => {
    const { voice } = throwingVoice();
    const { coach, flow } = await runRally(voice);
    const final = flow.snapshot();
    let recap: LiveCoachRecap | null = null;
    expect(() => {
      recap = coach.sessionEnded(final);
    }).not.toThrow();
    expect(recap).not.toBeNull();
    expect(getCompletedCoachRecap(final.sessionId)).not.toBeNull();
  });

  it('an onCue observer that throws (HUD render error) does not swallow the remaining cues of a snapshot', async () => {
    const spoken: string[] = [];
    const voice: CoachVoicePort = {
      available: () => true,
      speak: text => {
        spoken.push(text);
      },
      stop: () => undefined,
    };
    const coach = new LiveSessionCoach({
      voice,
      onCue: cue => {
        if (cue.eventId === 'E1') throw new Error('HUD caption render failed');
      },
    });
    const provider: SessionEventAnalysisProvider = {
      providerId: 'attack-scored-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => ({
        status: 'ready',
        analysis: scoredAnalysis(6.4),
      }),
    };
    const flow = new LiveSessionFlow({
      sessionId: 'attack-throwing-observer',
      source: 'live',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    const eventCues = coach.recap().cues.filter(cue => cue.eventId !== null);
    expect(eventCues.map(cue => cue.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(spoken).toHaveLength(3);
    expect(flow.snapshot().onUpdateFailures).toBe(0);
  });
});
