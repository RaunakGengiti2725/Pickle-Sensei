/**
 * STRUCTURAL AUDIT PROBES — LiveCourtEngine (dormant). Real fixture pipeline,
 * real scoring, real sparse cue engine. Each probe asserts the engine's own
 * contract ("truthful session summary", one rep index per stroke); a failing
 * probe is a reproduced defect on the audited commit.
 */
import type { VisionProviderSet } from '@pickle/vision-contracts';
import { ok } from '@pickle/shared-types';
import { createFixtureVisionProviderSet } from '../../../packages/vision-contracts/test/support/fixtureProvider';
import { LiveCourtEngine } from '../src/flow/liveCourt';

declare const process: { env: Record<string, string | undefined> };
process.env.PICKLE_ENV = 'development';

const clip = {
  uri: 'fixture://forehand/audit',
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
    appVersion: '0.1.0-audit',
    modelBundleVersion: 'fixture-1',
    makeId: () =>
      `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  });
}

/** Fixture set whose stroke detector finds no stroke: analyzeClip returns
 * `ok:false` (analysis.no_stroke_detected) — the canonical bad-framing case. */
function noStrokeProviders(): VisionProviderSet {
  const base = createFixtureVisionProviderSet('forehand_drive');
  return {
    ...base,
    stroke: {
      modelVersion: base.stroke.modelVersion,
      source: base.stroke.source,
      detectStrokes: async () => ok([]),
    },
  };
}

describe('AUDIT LiveCourtEngine — concurrency', () => {
  it('concurrent onStroke() calls get distinct, sequential rep indexes', async () => {
    const engine = makeEngine(createFixtureVisionProviderSet('forehand_drive'));
    const [a, b, c] = await Promise.all([
      engine.onStroke(clip),
      engine.onStroke(clip),
      engine.onStroke(clip),
    ]);
    expect([a?.repIndex, b?.repIndex, c?.repIndex]).toEqual([1, 2, 3]);
    expect(engine.allReps().map(rep => rep.repIndex)).toEqual([1, 2, 3]);
  });
});

describe('AUDIT LiveCourtEngine — truthful summary', () => {
  it('a stroke whose analysis fails is still an attempt: it is counted, not erased', async () => {
    const engine = makeEngine(noStrokeProviders());
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await engine.onStroke(clip));
    expect(results.every(rep => rep === null)).toBe(true);
    const summary = engine.summary();
    // Three swings happened; none scored. The summary must not read as an
    // empty session.
    expect(summary.validReps).toBe(0);
    expect(summary.validReps + summary.lowConfidenceReps).toBe(3);
  });

  it('three consecutive undetectable strokes reach the cue engine as no-reads so setup guidance can fire', async () => {
    // The sparse engine coaches the SETUP after lowConfidenceGuidanceAfter
    // (3) unreadable reps — but only if it ever sees them.
    const engine = makeEngine(noStrokeProviders());
    for (let i = 0; i < 3; i++) await engine.onStroke(clip);
    const cues = engine.allReps().map(rep => rep.cue.category);
    expect(cues).toContain('CORRECTION');
  });
});
