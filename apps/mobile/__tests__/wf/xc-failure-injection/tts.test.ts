/**
 * xc-failure-injection-mobile — TTS UNAVAILABLE.
 *
 * `src/audio/tts.ts` is the only JS port to the native AVSpeechSynthesizer
 * bridge (`NativeModules.PickleAudioCoach`). The REAL module is loaded in an
 * isolated registry against: no bridge, a partial bridge (speak without
 * stop / stop without speak), a bridge whose methods throw, and a seeded
 * sweep over random bridge shapes. The dormant Live Court engine
 * (`LiveSessionCoach`, no shipping UI caller — AGENTS.md "Live Court —
 * REMOVED") is driven with `tts` as its CoachVoicePort to show what a
 * future caller inherits.
 *
 * Whether AVSpeechSynthesizer itself can fail on-device is Apple-runtime
 * truth and is NOT claimed here.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import {
  LiveSessionCoach,
  type CoachVoicePort,
  type SpokenCue,
} from '../../../src/flow/liveSessionCoach';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../../../src/flow/session';
import {
  runScenario,
  seededRng,
  pick,
  verdictFor,
  type Invariants,
} from '../../../scripts/failure-injection/recorder';

type TtsModule = typeof import('../../../src/audio/tts');

const SUITE = 'tts';
const FILES = {
  nativeRead: 'apps/mobile/src/audio/tts.ts:14-15',
  available: 'apps/mobile/src/audio/tts.ts:18-20',
  speak: 'apps/mobile/src/audio/tts.ts:21-23',
  stop: 'apps/mobile/src/audio/tts.ts:24-26',
  coachEmit: 'apps/mobile/src/flow/liveSessionCoach.ts:254-263',
  liveCourtRemoved: 'AGENTS.md:732-741',
};

function loadTtsWith(bridge: Record<string, unknown> | undefined): TtsModule {
  let loaded: TtsModule | null = null;
  jest.isolateModules(() => {
    const rn =
      jest.requireActual<typeof import('react-native')>('react-native');
    const modules = rn.NativeModules as Record<string, unknown>;
    if (bridge === undefined) delete modules['PickleAudioCoach'];
    else modules['PickleAudioCoach'] = bridge;
    loaded = jest.requireActual<TtsModule>('../../../src/audio/tts');
  });
  if (!loaded) throw new Error('tts module did not load');
  return loaded;
}

function outcomeOf(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return `threw:${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── Dormant Live Court engine fixtures (shape of liveSessionCoach.test.ts) ──

function scoredAnalysis(): AnalysisRecord {
  return {
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
    result: {
      resultKind: 'scored',
      overallScore: 6.4,
      checkpoints: [
        {
          key: 'contact_position',
          score: 80,
          confidence: 0.9,
          band: 'yellow',
          direction: 'none',
          severity: 0.1,
          applicable: true,
        },
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

function readyEvent(index: number): SessionEventView {
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
    analysis: scoredAnalysis(),
    family: null,
    boundaryUncertain: false,
    retroSuppressed: false,
  };
}

function snap(events: SessionEventView[]): LiveSessionSnapshot {
  return {
    sessionId: 'session-fi',
    phase: 'running',
    source: 'live',
    startedAtIso: '2026-08-29T10:00:00.000Z',
    durationMs: events.length * 1000 + 600,
    strokeCount: events.length,
    events,
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'test-engine-1',
    analysisProviderId: 'test-provider',
  };
}

describe('xc-failure-injection — TTS unavailable', () => {
  it('TTS-01 native bridge absent: available()=false and speak()/stop() are silent no-ops (never throw)', async () => {
    await runScenario(
      {
        id: 'TTS-01',
        failureClass: 'tts',
        suite: SUITE,
        title: 'NativeModules.PickleAudioCoach undefined',
        seed: 51,
        inputs: { bridge: 'absent' },
        files: [FILES.nativeRead, FILES.available, FILES.speak, FILES.stop],
      },
      () => {
        const { tts } = loadTtsWith(undefined);
        expect(tts.available()).toBe(false);
        expect(outcomeOf(() => tts.speak('Bend the knees more.'))).toBe('ok');
        expect(outcomeOf(() => tts.stop())).toBe('ok');
        const invariants: Invariants = {
          noInfiniteSpinner: 'n/a',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: 'available=false; speak/stop no-ops.',
          expected:
            'Explicit unavailability; callers show cues on screen instead.',
        };
      },
    );
  });

  it('TTS-02 bridge present but speak() throws (synthesizer fault): tts.speak propagates the throw to its caller', async () => {
    const message =
      'AVSpeechSynthesizer failed to start utterance (AVAudioSession not active)';
    await runScenario(
      {
        id: 'TTS-02',
        failureClass: 'tts',
        suite: SUITE,
        title: 'bridge.speak throws synchronously',
        seed: 52,
        inputs: { bridge: 'speak_throws', message },
        files: [FILES.speak, FILES.coachEmit],
      },
      () => {
        const { tts } = loadTtsWith({
          speak: () => {
            throw new Error(message);
          },
          stop: jest.fn(),
        });
        expect(tts.available()).toBe(true);
        const speak = outcomeOf(() => tts.speak('Nice.'));
        expect(speak).toBe(`threw:${message}`);
        expect(outcomeOf(() => tts.stop())).toBe('ok');
        const invariants: Invariants = {
          noInfiniteSpinner: 'n/a',
          noSilentFailure: 'pass',
          noStoreCrash: 'fail',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed: `available=true; speak ${speak}. No try/catch in tts.ts — the exception reaches the caller. No shipping JS caller exists today (Live Court removed).`,
          expected:
            'A voice failure should degrade to captions, not propagate.',
        };
      },
    );
  });

  it('TTS-03 partial bridge (speak without stop): available()=true, stop() throws TypeError — `native?.stop()` guards the module, not the method', async () => {
    await runScenario(
      {
        id: 'TTS-03',
        failureClass: 'tts',
        suite: SUITE,
        title: 'bridge exports speak only',
        seed: 53,
        inputs: { bridge: '{speak}' },
        files: [FILES.stop],
      },
      () => {
        const { tts } = loadTtsWith({ speak: jest.fn() });
        expect(tts.available()).toBe(true);
        expect(outcomeOf(() => tts.speak('x'))).toBe('ok');
        const stop = outcomeOf(() => tts.stop());
        expect(stop).toMatch(/^threw:.*stop is not a function/);
        const invariants: Invariants = {
          noInfiniteSpinner: 'n/a',
          noSilentFailure: 'pass',
          noStoreCrash: 'fail',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed: `stop ${stop}`,
          expected:
            'A partial bridge (e.g. an older native build) should not turn stop() into a TypeError.',
        };
      },
    );
  });

  it('TTS-04 [dormant engine] LiveSessionCoach over an absent bridge: cues are produced with spoken=false and never throw', async () => {
    await runScenario(
      {
        id: 'TTS-04',
        failureClass: 'tts',
        suite: SUITE,
        title: 'LiveSessionCoach with tts (bridge absent) as voice port',
        seed: 54,
        inputs: { bridge: 'absent', events: 3 },
        files: [FILES.coachEmit, FILES.liveCourtRemoved],
      },
      () => {
        const { tts } = loadTtsWith(undefined);
        const cues: SpokenCue[] = [];
        const coach = new LiveSessionCoach({
          voice: tts as CoachVoicePort,
          onCue: cue => cues.push(cue),
        });
        expect(coach.voiceAvailable()).toBe(false);
        coach.sessionStarted('live');
        coach.consumeSnapshot(
          snap([readyEvent(0), readyEvent(1), readyEvent(2)]),
        );
        const recap = coach.sessionEnded(
          snap([readyEvent(0), readyEvent(1), readyEvent(2)]),
        );
        expect(cues.length).toBeGreaterThanOrEqual(2);
        expect(cues.every(cue => cue.spoken === false)).toBe(true);
        expect(recap.spokenCount).toBe(0);
        const invariants: Invariants = {
          noInfiniteSpinner: 'n/a',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `${cues.length} cues captioned, 0 spoken, recap.spokenCount=0.`,
          expected: 'Caption fallback; `spoken` records the truth.',
        };
      },
    );
  });

  it('TTS-05 [dormant engine] LiveSessionCoach over a throwing bridge: the first cue throws out of consumeSnapshot() — the cue is lost (not captioned) and later events are blocked', async () => {
    await runScenario(
      {
        id: 'TTS-05',
        failureClass: 'tts',
        suite: SUITE,
        title: 'LiveSessionCoach with tts whose speak() throws',
        seed: 55,
        inputs: { bridge: 'speak_throws', events: 2 },
        files: [FILES.coachEmit, FILES.speak, FILES.liveCourtRemoved],
      },
      () => {
        const { tts } = loadTtsWith({
          speak: () => {
            throw new Error('AVSpeechSynthesizer unavailable');
          },
          stop: jest.fn(),
        });
        const cues: SpokenCue[] = [];
        const coach = new LiveSessionCoach({
          voice: tts as CoachVoicePort,
          onCue: cue => cues.push(cue),
        });
        const start = outcomeOf(() => coach.sessionStarted('live'));
        const consume = outcomeOf(() =>
          coach.consumeSnapshot(snap([readyEvent(0), readyEvent(1)])),
        );
        expect(start).toMatch(/^threw:/);
        expect(consume).toMatch(/^threw:/);
        expect(cues).toHaveLength(0);
        const invariants: Invariants = {
          noInfiniteSpinner: 'n/a',
          noSilentFailure: 'fail',
          noStoreCrash: 'fail',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed: `sessionStarted ${start}; consumeSnapshot ${consume}; 0 cues reached onCue (captions lost).`,
          expected:
            'emit() should record the cue with spoken=false when the port throws. Dormant: no UI reaches this today.',
        };
      },
    );
  });

  it('TTS-06 seeded sweep ×24: random bridge shapes — matrix of which calls throw', async () => {
    const shapes: Record<string, Record<string, unknown> | undefined> = {
      absent: undefined,
      empty: {},
      speak_only: { speak: jest.fn() },
      stop_only: { stop: jest.fn() },
      full_ok: { speak: jest.fn(), stop: jest.fn() },
      speak_throws: {
        speak: () => {
          throw new Error('speak fault');
        },
        stop: jest.fn(),
      },
      stop_throws: {
        speak: jest.fn(),
        stop: () => {
          throw new Error('stop fault');
        },
      },
      speak_not_function: { speak: 'yes', stop: jest.fn() },
    };
    const names = Object.keys(shapes);
    const matrix: Record<
      string,
      { available: boolean; speak: string; stop: string }
    > = {};
    for (let seed = 500; seed < 524; seed += 1) {
      const rng = seededRng(seed);
      const shape = pick(rng, names);
      await runScenario(
        {
          id: `TTS-06/${seed}`,
          failureClass: 'tts',
          suite: SUITE,
          title: 'random bridge shape',
          seed,
          inputs: { shape },
          files: [FILES.available, FILES.speak, FILES.stop],
        },
        () => {
          const { tts } = loadTtsWith(shapes[shape]);
          const row = {
            available: tts.available(),
            speak: outcomeOf(() => tts.speak('cue')),
            stop: outcomeOf(() => tts.stop()),
          };
          matrix[shape] = row;
          const threw = row.speak !== 'ok' || row.stop !== 'ok';
          const invariants: Invariants = {
            noInfiniteSpinner: 'n/a',
            noSilentFailure: 'pass',
            noStoreCrash: threw ? 'fail' : 'pass',
          };
          return {
            invariants,
            verdict: threw ? 'degraded' : 'safe',
            observed: JSON.stringify(row),
            expected: 'available() honest; speak/stop never throw.',
          };
        },
      );
    }
    expect(matrix['absent']).toEqual({
      available: false,
      speak: 'ok',
      stop: 'ok',
    });
    expect(matrix['full_ok']).toEqual({
      available: true,
      speak: 'ok',
      stop: 'ok',
    });
    // `available()` reports true for a bridge whose `speak` is a non-function
    // truthy export, then speak() throws.
    if (matrix['speak_not_function']) {
      expect(matrix['speak_not_function'].available).toBe(true);
      expect(matrix['speak_not_function'].speak).toMatch(/^threw:/);
    }
    if (matrix['stop_only']) {
      expect(matrix['stop_only']).toMatchObject({
        available: false,
        stop: 'ok',
      });
    }
  });
});
