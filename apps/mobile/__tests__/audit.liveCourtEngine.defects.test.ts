/**
 * STRUCTURAL AUDIT PROBES — LiveCourtEngine (apps/mobile/src/flow/liveCourt.ts).
 *
 * Tests assert the behaviour the module's own doc comments promise ("every
 * rep → analyze → score → cue", "truthful session summary", deterministic
 * cues). A FAILING test here is a reproduced defect on the audited commit
 * (4d812e1a), not a pin of current behaviour.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/audit.liveCourtEngine.defects.test.ts
 */
import { fail, failure } from '@pickle/shared-types';
import type { VisionProviderSet } from '@pickle/vision-contracts';
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

/** Fixture providers whose stroke detector resolves in caller-controlled
 * order, so two overlapping onStroke() calls can be interleaved on purpose. */
function makeGatedProviders() {
  const base = createFixtureVisionProviderSet('forehand_drive');
  const gates: Array<() => void> = [];
  const stroke: VisionProviderSet['stroke'] = {
    modelVersion: base.stroke.modelVersion,
    source: base.stroke.source,
    detectStrokes: async clipRef => {
      await new Promise<void>(resolve => {
        gates.push(resolve);
      });
      return base.stroke.detectStrokes(clipRef);
    },
  };
  return { providers: { ...base, stroke }, gates };
}

describe('DEFECT PROBE: LiveCourtEngine.onStroke concurrency', () => {
  it('overlapping strokes keep distinct, arrival-ordered repIndex values (repCounter is read after the await)', async () => {
    // Sequential reference.
    const sequential = makeEngine(
      createFixtureVisionProviderSet('forehand_drive'),
    );
    const seqReps = [];
    for (let i = 0; i < 3; i++) seqReps.push(await sequential.onStroke(clip));
    expect(seqReps.map(rep => rep?.repIndex)).toEqual([1, 2, 3]);

    // Concurrent: three strokes detected before the first analysis returns
    // (the analysis takes longer than the inter-stroke gap), completing in
    // arrival order.
    const { providers, gates } = makeGatedProviders();
    const concurrent = makeEngine(providers);
    const pending = [
      concurrent.onStroke(clip),
      concurrent.onStroke(clip),
      concurrent.onStroke(clip),
    ];
    await Promise.resolve();
    expect(gates).toHaveLength(3);
    for (const open of gates) {
      open();
      // Let the released analysis run to completion before the next one.
      await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    }
    const concReps = await Promise.all(pending);

    // Same strokes, same order → the SAME rep indices as the sequential run.
    expect(concReps.map(rep => rep?.repIndex)).toEqual([1, 2, 3]);
    expect(concurrent.allReps().map(rep => rep.repIndex)).toEqual([1, 2, 3]);
  });

  it('a stroke whose analysis completes out of order still keeps repIndex == arrival order and reps in emission order', async () => {
    const { providers, gates } = makeGatedProviders();
    const engine = makeEngine(providers);
    const first = engine.onStroke(clip);
    const second = engine.onStroke(clip);
    await Promise.resolve();
    expect(gates).toHaveLength(2);
    // Second stroke's analysis lands first.
    gates[1]!();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    gates[0]!();
    const [repA, repB] = await Promise.all([first, second]);
    expect(repA?.repIndex).toBe(1);
    expect(repB?.repIndex).toBe(2);
    expect(engine.allReps().map(rep => rep.repIndex)).toEqual([1, 2]);
  });
});

describe('DEFECT PROBE: LiveCourtEngine summary truthfulness', () => {
  it('a stroke whose analysis FAILED is still accounted for in the summary (attempts never vanish)', async () => {
    const base = createFixtureVisionProviderSet('forehand_drive');
    let failNext = true;
    const stroke: VisionProviderSet['stroke'] = {
      modelVersion: base.stroke.modelVersion,
      source: base.stroke.source,
      detectStrokes: async clipRef => {
        if (failNext) {
          failNext = false;
          return fail(
            failure(
              'low_confidence',
              'analysis.no_stroke_detected',
              'no stroke',
            ),
          );
        }
        return base.stroke.detectStrokes(clipRef);
      },
    };
    const engine = makeEngine({ ...base, stroke });
    const failed = await engine.onStroke(clip);
    const ok = await engine.onStroke(clip);
    expect(failed).toBeNull();
    expect(ok).not.toBeNull();
    const summary = engine.summary();
    // Two strokes were attempted; one scored, one could not be read.
    expect(summary.validReps + summary.lowConfidenceReps).toBe(2);
    expect(summary.lowConfidenceReps).toBe(1);
  });
});
