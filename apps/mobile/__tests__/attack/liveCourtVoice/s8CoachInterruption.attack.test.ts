/**
 * ADVERSARIAL extras (mobile-live-court-voice, pass 3) — interruption and
 * lifecycle attacks on LiveSessionCoach:
 *   - the voice port throws mid-snapshot (native TTS bridge failure)
 *   - dispose() (unmount) followed by late session events / start line
 *   - sessionEnded() after dispose() — recap registry
 *   - mute toggled between events, and an available() port that flaps
 *
 * The coach speaks through CoachVoicePort.speak (liveSessionCoach.ts
 * L254-266 emit). Nothing in emit/consumeSnapshot catches — a throwing port
 * propagates out of consumeSnapshot AFTER the eventId was marked consumed
 * and state advanced (L163-181), so the cue is lost forever and the
 * remaining events of that snapshot are not processed in that call.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import {
  getCompletedCoachRecap,
  LiveSessionCoach,
  type CoachVoicePort,
  type SpokenCue,
} from '../../../src/flow/liveSessionCoach';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../../../src/flow/session';

function scoredAnalysis(overallScore: number): AnalysisRecord {
  return {
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
    result: { resultKind: 'scored', overallScore, checkpoints: [] },
  } as unknown as AnalysisRecord;
}

function ready(
  eventId: string,
  index: number,
  score: number,
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
    state: 'ready',
    pendingReason: null,
    abstainReason: null,
    analysis: scoredAnalysis(score),
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
    sessionId: 'attack-s8',
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

interface Harness {
  coach: LiveSessionCoach;
  spoken: string[];
  cues: SpokenCue[];
  speak: jest.Mock;
  stop: jest.Mock;
}

function harness(
  options: {
    speakImpl?: (text: string) => boolean | void;
    available?: () => boolean;
  } = {},
): Harness {
  const spoken: string[] = [];
  const cues: SpokenCue[] = [];
  const speak = jest.fn((text: string) => {
    const out = options.speakImpl ? options.speakImpl(text) : undefined;
    spoken.push(text);
    return out;
  });
  const stop = jest.fn();
  const voice: CoachVoicePort = {
    available: options.available ?? (() => true),
    speak,
    stop,
  };
  const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });
  return { coach, spoken, cues, speak, stop };
}

describe('ADVERSARIAL: voice port throws mid-snapshot', () => {
  it('a throwing speak() must not escape consumeSnapshot and must not lose the cue', () => {
    let calls = 0;
    const h = harness({
      speakImpl: () => {
        calls += 1;
        if (calls === 2) throw new Error('AVSpeechSynthesizer unavailable');
      },
    });
    const events = [
      ready('e1', 0, 6.0),
      ready('e2', 1, 6.2),
      ready('e3', 2, 6.4),
    ];
    expect(() => h.coach.consumeSnapshot(snap(events))).not.toThrow();
    // Every terminal event gets exactly one cue record, spoken or not.
    expect(h.cues.map(c => c.eventId)).toEqual(['e1', 'e2', 'e3']);
    expect(h.cues[1]?.spoken).toBe(false);
  });

  it('EVIDENCE: on 4d812e1a the exception propagates, e2 is consumed-but-silent forever and e3 waits for the next snapshot', () => {
    let calls = 0;
    const h = harness({
      speakImpl: () => {
        calls += 1;
        if (calls === 2) throw new Error('AVSpeechSynthesizer unavailable');
      },
    });
    const events = [
      ready('e1', 0, 6.0),
      ready('e2', 1, 6.2),
      ready('e3', 2, 6.4),
    ];
    expect(() => h.coach.consumeSnapshot(snap(events))).toThrow(
      'AVSpeechSynthesizer unavailable',
    );
    expect(h.cues.map(c => c.eventId)).toEqual(['e1']);
    // Re-delivering the same snapshot (the session engine re-notifies on
    // every state change) never re-speaks e2 — it was marked consumed
    // before speak() threw — but does pick up e3.
    h.coach.consumeSnapshot(snap(events));
    expect(h.cues.map(c => c.eventId)).toEqual(['e1', 'e3']);
    expect(h.coach.recap().cues.map(c => c.eventId)).toEqual(['e1', 'e3']);
  });

  it('a throwing stop() must not escape setMuted / dispose', () => {
    const h = harness();
    h.stop.mockImplementation(() => {
      throw new Error('native stop failed');
    });
    expect(() => h.coach.setMuted(true)).not.toThrow();
    expect(() => h.coach.dispose()).not.toThrow();
  });

  it('EVIDENCE: on 4d812e1a a throwing stop() escapes both setMuted and dispose', () => {
    const h = harness();
    h.stop.mockImplementation(() => {
      throw new Error('native stop failed');
    });
    expect(() => h.coach.setMuted(true)).toThrow('native stop failed');
    expect(() => h.coach.dispose()).toThrow('native stop failed');
  });
});

describe('ADVERSARIAL: dispose / end ordering', () => {
  it('events arriving after dispose() are ignored (no speech after unmount)', () => {
    const h = harness();
    h.coach.dispose();
    h.coach.consumeSnapshot(snap([ready('late', 0, 7.0)]));
    expect(h.speak).not.toHaveBeenCalled();
    expect(h.cues).toHaveLength(0);
  });

  it('sessionStarted() after dispose() must not speak', () => {
    const h = harness();
    h.coach.dispose();
    h.coach.sessionStarted('live');
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('EVIDENCE: on 4d812e1a sessionStarted() after dispose() still speaks the opening line', () => {
    const h = harness();
    h.coach.dispose();
    h.coach.sessionStarted('live');
    expect(h.speak).toHaveBeenCalledTimes(1);
    expect(h.cues[0]?.category).toBe('SESSION_START');
  });

  it('sessionEnded() after dispose() registers no recap for LiveSummary (documented: dispose keeps the log but ends)', () => {
    const h = harness();
    h.coach.consumeSnapshot(snap([ready('e1', 0, 6.0)]));
    h.coach.dispose();
    const recap = h.coach.sessionEnded(
      snap([ready('e1', 0, 6.0)], { sessionId: 'disposed-first' }),
    );
    expect(recap.cues.map(c => c.eventId)).toEqual(['e1']);
    expect(recap.cues.some(c => c.category === 'SESSION_END')).toBe(false);
    expect(getCompletedCoachRecap('disposed-first')).toBeNull();
  });

  it('sessionEnded() twice speaks the closing line once and registers once', () => {
    const h = harness();
    const final = snap([ready('e1', 0, 6.0)], { sessionId: 'ended-twice' });
    h.coach.consumeSnapshot(final);
    h.coach.sessionEnded(final);
    h.coach.sessionEnded(final);
    expect(h.cues.filter(c => c.category === 'SESSION_END')).toHaveLength(1);
    expect(getCompletedCoachRecap('ended-twice')?.cues).toHaveLength(2);
  });
});

describe('ADVERSARIAL: mute / availability flapping between events', () => {
  it('mute mid-session records cues as unspoken and stops the voice once', () => {
    const h = harness();
    h.coach.consumeSnapshot(snap([ready('e1', 0, 6.0)]));
    h.coach.setMuted(true);
    h.coach.consumeSnapshot(snap([ready('e1', 0, 6.0), ready('e2', 1, 6.2)]));
    h.coach.setMuted(false);
    h.coach.consumeSnapshot(
      snap([ready('e1', 0, 6.0), ready('e2', 1, 6.2), ready('e3', 2, 6.4)]),
    );
    expect(h.cues.map(c => [c.eventId, c.spoken])).toEqual([
      ['e1', true],
      ['e2', false],
      ['e3', true],
    ]);
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it('available() flapping false→true never re-speaks a cue that was recorded unspoken', () => {
    let available = false;
    const h = harness({ available: () => available });
    h.coach.consumeSnapshot(snap([ready('e1', 0, 6.0)]));
    available = true;
    h.coach.consumeSnapshot(snap([ready('e1', 0, 6.0)]));
    expect(h.cues.map(c => [c.eventId, c.spoken])).toEqual([['e1', false]]);
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('port returning false (suppressed) is recorded honestly as spoken=false', () => {
    const h = harness({ speakImpl: () => false });
    h.coach.consumeSnapshot(snap([ready('e1', 0, 6.0)]));
    expect(h.cues[0]?.spoken).toBe(false);
    expect(h.coach.recap().spokenCount).toBe(0);
  });
});
