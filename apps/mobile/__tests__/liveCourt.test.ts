/**
 * Live Court engine tests: fixture providers + REAL scoring + REAL cue engine.
 * Verifies the spec loop: rep → score → cue → summary (spec pp. 9, 35–37).
 */
import { createFixtureVisionProviderSet } from '../../../packages/vision-contracts/test/support/fixtureProvider';
import { LiveCourtEngine } from '../src/flow/liveCourt';

declare const process: { env: Record<string, string | undefined> };
process.env.PICKLE_ENV = 'development';

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
});
