/**
 * ADJUDICATION REPRODUCTIONS — area `mobile-live-court-voice`, baseline
 * commit 4d812e1aa699014cc0521fd92fde66908043aaa8.
 *
 * Each test asserts the CONTRACT the module documents in its own header
 * comments (speak each event at most once and log it truthfully; go quiet
 * after the session ends; register the recap for LiveSummary; one rep index
 * per stroke; every analyzed swing is counted). A failing test here is a
 * reproduced defect on the baseline, not a broken test — the fix must turn
 * it green without weakening the assertion.
 *
 * Finding ids match the adjudication report: LCV-1 … LCV-3 (this cluster).
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { CheckpointKey, FaultDirection } from '@pickle/shared-types';
import { createFixtureVisionProviderSet } from '../../../packages/vision-contracts/test/support/fixtureProvider';
import type {
  VideoClipRef,
  VisionProviderSet,
} from '../../../packages/vision-contracts/src/contracts';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
  type SpokenCue,
} from '../src/flow/liveSessionCoach';
import { LiveCourtEngine } from '../src/flow/liveCourt';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../src/flow/session';

declare const process: { env: Record<string, string | undefined> };
process.env.PICKLE_ENV = 'development';

// ─── LiveSessionCoach helpers ────────────────────────────────────────────────

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
        key: spec.key,
        score: spec.score,
        confidence: 0.9,
        band: 'yellow',
        direction: spec.direction,
        severity: spec.severity,
        applicable: true,
      })),
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
  };
}

function snap(
  events: SessionEventView[],
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  return {
    sessionId: 'adjudication-session',
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

const kneeFault: CheckpointSpec = {
  key: 'athletic_base',
  score: 40,
  direction: 'low',
  severity: 0.5,
};

function readyScored(index: number, score = 6.5): SessionEventView {
  return view({
    index,
    state: 'ready',
    analysis: scoredAnalysis(score, [kneeFault]),
  });
}

function makeVoice(options: { throwOn?: (text: string) => boolean } = {}) {
  const spoken: string[] = [];
  const voice: CoachVoicePort = {
    available: () => true,
    speak: (text: string) => {
      if (options.throwOn?.(text)) {
        throw new Error('native speech bridge rejected the utterance');
      }
      spoken.push(text);
    },
    stop: jest.fn(),
  };
  return { voice, spoken };
}

// ─── LCV-1: a throwing voice port must not lose the cue / recap ─────────────

describe('LCV-1 LiveSessionCoach.emit isolates voice-port failures', () => {
  it('logs the cue (spoken:false) and notifies the HUD when speak() throws', () => {
    const { voice } = makeVoice({ throwOn: () => true });
    const cues: SpokenCue[] = [];
    const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });

    expect(() => coach.sessionStarted('live')).not.toThrow();
    expect(() => coach.consumeSnapshot(snap([readyScored(0)]))).not.toThrow();

    // Contract: "Logs cues even when muted/unavailable and sets `spoken`
    // truthfully" — a dispatch failure is exactly the spoken:false case.
    const recap = coach.recap();
    expect(recap.cues.map(c => c.category)).toEqual([
      'SESSION_START',
      'CORRECTION',
    ]);
    expect(recap.cues.every(c => c.spoken === false)).toBe(true);
    expect(cues).toHaveLength(2);
  });

  it('does not silently swallow a rep: a throwing port must not consume the event without a record', () => {
    let failFirst = true;
    const { voice, spoken } = makeVoice({
      throwOn: () => {
        if (failFirst) {
          failFirst = false;
          return true;
        }
        return false;
      },
    });
    const coach = new LiveSessionCoach({ voice });
    const event = readyScored(0);

    // Tolerate the escape here so the assertion below isolates the second
    // failure mode: the event is marked consumed BEFORE emit(), so once the
    // throw escapes the rep is gone — no log record, never spoken again.
    try {
      coach.consumeSnapshot(snap([event]));
    } catch {
      // escaped throw is covered by the previous test
    }
    coach.consumeSnapshot(snap([event]));

    // Either the cue was recorded (spoken:false) on the first pass, or the
    // event stayed unconsumed and spoke on the retry — never "consumed AND
    // absent from the log AND never spoken".
    const recorded = coach
      .recap()
      .cues.filter(c => c.eventId === event.eventId);
    expect(recorded.length + spoken.length).toBeGreaterThan(0);
    expect(recorded).toHaveLength(1);
  });

  it('still registers the recap and the SESSION_END record when the closing line fails to speak', () => {
    const sessionId = 'adjudication-lcv1-end';
    const { voice } = makeVoice({
      throwOn: text => text.startsWith('Session over'),
    });
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([readyScored(0)], { sessionId }));

    const final = snap([readyScored(0)], { sessionId, phase: 'ended' });
    expect(() => coach.sessionEnded(final)).not.toThrow();

    const registered = getCompletedCoachRecap(sessionId);
    expect(registered).not.toBeNull();
    expect(registered?.cues.at(-1)?.category).toBe('SESSION_END');
    expect(registered?.cues.at(-1)?.spoken).toBe(false);
  });
});

// ─── LCV-2: lifecycle guards (sessionStarted / dispose-before-end) ─────────

describe('LCV-2 LiveSessionCoach lifecycle contract', () => {
  it('goes quiet after dispose(): a late sessionStarted() must not speak', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.dispose();

    coach.sessionStarted('live');

    // Contract: "After the session ends the coach goes quiet" and
    // dispose() is the teardown — nothing may be spoken past it.
    expect(spoken).toEqual([]);
  });

  it('goes quiet after sessionEnded(): a late sessionStarted() must not speak', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionEnded(snap([], { phase: 'ended' }));
    const spokenAtEnd = spoken.length;

    coach.sessionStarted('live');

    expect(spoken).toHaveLength(spokenAtEnd);
  });

  it('speaks the opening line at most once per coach', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    coach.sessionStarted('live');

    expect(spoken).toHaveLength(1);
  });

  it('dispose() before sessionEnded() (screen unmounted first) still registers the recap for LiveSummary', () => {
    const sessionId = 'adjudication-lcv2-dispose-first';
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([readyScored(0)], { sessionId }));
    expect(coach.recap().cues).toHaveLength(1);

    coach.dispose(); // RN unmount cleanup runs before the flow's end() lands.
    const recap = coach.sessionEnded(
      snap([readyScored(0)], { sessionId, phase: 'ended' }),
    );

    // Contract: dispose() "Keeps the log"; sessionEnded() "registers the
    // recap so LiveSummary can show what the coach said".
    expect(recap.cues).toHaveLength(1);
    expect(getCompletedCoachRecap(sessionId)).not.toBeNull();
    expect(getCompletedCoachRecap(sessionId)?.cues).toHaveLength(1);
  });
});

// ─── LiveCourtEngine helpers ─────────────────────────────────────────────────

const clip = {
  uri: 'fixture://forehand/live',
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

function makeEngine(providers: VisionProviderSet) {
  let counter = 0;
  return new LiveCourtEngine(providers, {
    sessionId: '11111111-2222-4333-8444-555555555555',
    shotType: 'forehand_drive',
    focusCheckpoint: 'contact_position',
    handedness: 'right',
    appVersion: '0.1.0-test',
    modelBundleVersion: 'fixture-1',
    makeId: () =>
      `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  });
}

/** Fixture provider whose stroke detector resolves in caller-controlled order. */
function gatedProviders(): {
  providers: VisionProviderSet;
  release: (call: number) => void;
} {
  const base = createFixtureVisionProviderSet('forehand_drive');
  const gates: Array<() => void> = [];
  const stroke = base.stroke;
  const providers: VisionProviderSet = {
    ...base,
    stroke: {
      modelVersion: stroke.modelVersion,
      source: stroke.source,
      detectStrokes: async (target: VideoClipRef) => {
        await new Promise<void>(resolve => {
          gates.push(resolve);
        });
        return stroke.detectStrokes(target);
      },
    },
  };
  return { providers, release: call => gates[call]?.() };
}

// ─── LCV-3: repIndex is read after the await ────────────────────────────────

describe('LCV-3 LiveCourtEngine.onStroke rep indexing under overlapping strokes', () => {
  it('assigns distinct, arrival-ordered rep indices when two strokes are in flight', async () => {
    const { providers, release } = gatedProviders();
    const engine = makeEngine(providers);

    const first = engine.onStroke(clip);
    const second = engine.onStroke(clip);
    release(0);
    release(1);
    const [repA, repB] = await Promise.all([first, second]);

    expect(repA).not.toBeNull();
    expect(repB).not.toBeNull();
    // Contract (LiveRep.repIndex, RepObservation.repIndex): one 1-based
    // index per stroke. Both strokes currently read repCounter === 2.
    expect([repA!.repIndex, repB!.repIndex].sort()).toEqual([1, 2]);
    expect(engine.allReps().map(r => r.repIndex)).toEqual([1, 2]);
  });

  it('keeps rep indices dense when analyses settle out of order', async () => {
    const { providers, release } = gatedProviders();
    const engine = makeEngine(providers);

    const first = engine.onStroke(clip);
    const second = engine.onStroke(clip);
    const third = engine.onStroke(clip);
    release(2);
    release(0);
    release(1);
    await Promise.all([first, second, third]);

    const indices = engine
      .allReps()
      .map(r => r.repIndex)
      .sort();
    expect(new Set(indices).size).toBe(3);
    expect(indices).toEqual([1, 2, 3]);
  });
});
