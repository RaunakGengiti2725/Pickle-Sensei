/**
 * Live Court engine tests: fixture providers + REAL scoring + REAL cue engine.
 * Verifies the spec loop: rep → score → cue → summary (spec pp. 9, 35–37).
 */
import { createFixtureVisionProviderSet } from '../../../packages/vision-contracts/test/support/fixtureProvider';
import type {
  VideoClipRef,
  VisionProviderSet,
} from '../../../packages/vision-contracts/src/contracts';
import { LiveCourtEngine } from '../src/flow/liveCourt';

declare const process: { env: Record<string, string | undefined> };
process.env.PICKLE_ENV = 'development';

/** Rep indices the REAL cue engine was called with, in call order. */
// eslint-disable-next-line no-var
var mockCueRepIndices: number[] = [];

type CoachCore = typeof import('@pickle/audio-coach-core');
type SelectCue = CoachCore['selectCue'];

jest.mock('@pickle/audio-coach-core', () => {
  const actual = jest.requireActual<CoachCore>('@pickle/audio-coach-core');
  const selectCue: SelectCue = (state, rep, rules) => {
    mockCueRepIndices.push(rep.repIndex);
    return rules === undefined
      ? actual.selectCue(state, rep)
      : actual.selectCue(state, rep, rules);
  };
  return { ...actual, selectCue };
});

beforeEach(() => {
  mockCueRepIndices = [];
});

const clip = {
  uri: 'fixture://forehand/live',
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

function makeEngine() {
  let counter = 0;
  return new LiveCourtEngine(createFixtureVisionProviderSet('forehand_drive'), {
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

/** Fixture providers whose stroke detection resolves on demand, so several
 * onStroke() calls can be in flight at once and settle out of order. */
function gatedProviders(): {
  providers: VisionProviderSet;
  release: (call: number) => void;
} {
  const base = createFixtureVisionProviderSet('forehand_drive');
  const gates: Array<() => void> = [];
  return {
    providers: {
      ...base,
      stroke: {
        modelVersion: base.stroke.modelVersion,
        source: base.stroke.source,
        detectStrokes: async (target: VideoClipRef) => {
          await new Promise<void>(resolve => {
            gates.push(resolve);
          });
          return base.stroke.detectStrokes(target);
        },
      },
    },
    release: call => gates[call]?.(),
  };
}

function makeGatedEngine(providers: VisionProviderSet) {
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

describe('LiveCourtEngine', () => {
  it('scores reps through the real pipeline and keeps fixture provenance', async () => {
    const engine = makeEngine();
    const rep = await engine.onStroke(clip);
    expect(rep).not.toBeNull();
    expect(rep!.analysis.source).toBe('fixture');
    expect(rep!.analysis.resultKind).toBe('scored');
    expect(rep!.analysis.overallScore).toBeGreaterThan(0);
    expect(rep!.analysis.versionVector.scoringModelVersion).toBe('sm-v1');
  });

  it('produces a truthful session summary over multiple reps', async () => {
    const engine = makeEngine();
    for (let i = 0; i < 5; i++) await engine.onStroke(clip);
    const summary = engine.summary();
    expect(summary.validReps).toBe(5);
    expect(summary.lowConfidenceReps).toBe(0);
    expect(summary.bestScore).not.toBeNull();
    expect(summary.startScore).not.toBeNull();
    expect(summary.focusCheckpoint).toBe('contact_position');
  });

  it('cue decisions are deterministic for identical rep sequences', async () => {
    const a = makeEngine();
    const b = makeEngine();
    const cuesA: (string | null)[] = [];
    const cuesB: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      cuesA.push((await a.onStroke(clip))?.cue.text ?? null);
      cuesB.push((await b.onStroke(clip))?.cue.text ?? null);
    }
    expect(cuesA).toEqual(cuesB);
  });

  it('gives every rep its own 1-based index when strokes overlap and settle in reverse order', async () => {
    const { providers, release } = gatedProviders();
    const engine = makeGatedEngine(providers);
    const inFlight = [
      engine.onStroke(clip),
      engine.onStroke(clip),
      engine.onStroke(clip),
      engine.onStroke(clip),
    ];
    for (let call = inFlight.length - 1; call >= 0; call--) release(call);
    await Promise.all(inFlight);

    const indices = engine
      .allReps()
      .map(rep => rep.repIndex)
      .sort((a, b) => a - b);
    expect(indices).toEqual([1, 2, 3, 4]);
  });

  it('hands the cue engine the same rep index the rep carries', async () => {
    const { providers, release } = gatedProviders();
    const engine = makeGatedEngine(providers);
    const inFlight = [engine.onStroke(clip), engine.onStroke(clip)];
    release(1);
    release(0);
    await Promise.all(inFlight);

    expect(mockCueRepIndices).toHaveLength(2);
    expect([...mockCueRepIndices].sort((a, b) => a - b)).toEqual([1, 2]);
    // Completion order drives both the rep log and the cue calls, so the
    // sequences line up element by element.
    expect(engine.allReps().map(rep => rep.repIndex)).toEqual(
      mockCueRepIndices,
    );
  });
});
