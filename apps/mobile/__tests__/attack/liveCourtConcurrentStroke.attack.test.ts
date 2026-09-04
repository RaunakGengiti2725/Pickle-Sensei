/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario S1.
 * LiveCourtEngine.onStroke() increments `repCounter` BEFORE awaiting the
 * analysis and reads `repCounter` / `coachState` AFTER it. Two strokes whose
 * analyses are in flight at the same time (fast consecutive swings, a slow
 * pose provider) therefore race on the same mutable state.
 *
 * Expected contract: each stroke owns a distinct repIndex, and the cue for
 * the stroke that finishes second is selected from a state that already
 * contains the stroke that finished first (no lost update).
 */
import type { Measurement } from '@pickle/shared-types';
import type { VisionProviderSet } from '@pickle/vision-contracts';
import { createFixtureVisionProviderSet } from '../../../../packages/vision-contracts/test/support/fixtureProvider';
import { LiveCourtEngine } from '../../src/flow/liveCourt';

const clip = {
  uri: 'fixture://forehand/live',
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

interface Gate {
  release: () => void;
  opened: Promise<void>;
}

function gate(): Gate {
  let release: () => void = () => undefined;
  const opened = new Promise<void>(resolve => {
    release = resolve;
  });
  return { release, opened };
}

/**
 * Wraps the deterministic fixture providers so each extractMeasurements call
 * (a) waits on its own gate, letting the test pick the completion order, and
 * (b) optionally degrades the measurements so consecutive reps score
 * differently (a real court never produces identical swings).
 */
function controllableProviders(
  gates: Gate[],
  degrade: ReadonlyArray<boolean>,
): { providers: VisionProviderSet; calls: () => number } {
  const base = createFixtureVisionProviderSet('forehand_drive');
  let call = 0;
  const providers: VisionProviderSet = {
    ...base,
    features: {
      version: base.features.version,
      async extractMeasurements(input) {
        const index = call++;
        const result = await base.features.extractMeasurements(input);
        const g = gates[index];
        if (g) await g.opened;
        if (!result.ok || !degrade[index]) return result;
        const worse: Measurement[] = result.value.map(m =>
          m.metricKey === 'knee_flexion_deg' ||
          m.metricKey === 'shoulder_turn_deg' ||
          m.metricKey === 'weight_transfer_norm'
            ? { ...m, value: m.value * 0.2 }
            : m,
        );
        return { ...result, value: worse };
      },
    },
  };
  return { providers, calls: () => call };
}

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

describe('S1 — concurrent LiveCourtEngine.onStroke()', () => {
  it('baseline: sequential strokes get distinct repIndex and the second sees the first (personal best)', async () => {
    const { providers } = controllableProviders([], [true, false]);
    const engine = makeEngine(providers);
    const first = await engine.onStroke(clip);
    const second = await engine.onStroke(clip);
    expect(first?.repIndex).toBe(1);
    expect(second?.repIndex).toBe(2);
    expect(first?.analysis.overallScore).not.toBeNull();
    expect(second?.analysis.overallScore).not.toBeNull();
    // Precondition for the attack below: rep 2 really is the better swing.
    expect(second!.analysis.overallScore!).toBeGreaterThan(
      first!.analysis.overallScore!,
    );
    expect(second?.isPersonalBest).toBe(true);
  });

  it('Promise.all of two strokes yields distinct repIndex values', async () => {
    const { providers } = controllableProviders([], [true, false]);
    const engine = makeEngine(providers);
    const [a, b] = await Promise.all([
      engine.onStroke(clip),
      engine.onStroke(clip),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(new Set([a!.repIndex, b!.repIndex]).size).toBe(2);
    expect([a!.repIndex, b!.repIndex].sort()).toEqual([1, 2]);
    expect(engine.summary().validReps).toBe(2);
  });

  it('the stroke that finishes second is cued from a state that includes the first', async () => {
    // Stroke A (worse swing) is released first, stroke B (better) second —
    // the same order they were started in, so B must see A's score.
    const gA = gate();
    const gB = gate();
    const { providers } = controllableProviders([gA, gB], [true, false]);
    const engine = makeEngine(providers);
    const pA = engine.onStroke(clip);
    const pB = engine.onStroke(clip);
    gA.release();
    await pA;
    gB.release();
    const [a, b] = await Promise.all([pA, pB]);
    expect(a!.analysis.overallScore!).toBeLessThan(b!.analysis.overallScore!);
    // Coach state: B's cue/personal-best must be selected from a state that
    // already contains A.
    expect(b!.isPersonalBest).toBe(true);
    expect(engine.summary().bestScore).toBe(b!.analysis.overallScore);
    expect(engine.summary().startScore).toBe(a!.analysis.overallScore);
  });

  it('in-flight strokes keep their own repIndex (A=1, B=2) regardless of completion order', async () => {
    const gA = gate();
    const gB = gate();
    const { providers } = controllableProviders([gA, gB], [true, false]);
    const engine = makeEngine(providers);
    const pA = engine.onStroke(clip);
    const pB = engine.onStroke(clip);
    gA.release();
    await pA;
    gB.release();
    const [a, b] = await Promise.all([pA, pB]);
    expect(a!.repIndex).toBe(1);
    expect(b!.repIndex).toBe(2);
  });

  it('out-of-order completion (B before A) still keeps both reps and one best score', async () => {
    const gA = gate();
    const gB = gate();
    const { providers } = controllableProviders([gA, gB], [true, false]);
    const engine = makeEngine(providers);
    const pA = engine.onStroke(clip);
    const pB = engine.onStroke(clip);
    gB.release();
    await pB;
    gA.release();
    const [a, b] = await Promise.all([pA, pB]);
    const summary = engine.summary();
    expect(summary.validReps).toBe(2);
    expect(summary.bestScore).toBe(
      Math.max(a!.analysis.overallScore!, b!.analysis.overallScore!),
    );
    // The later-finishing (worse) rep A must not be a personal best, and the
    // coach must still remember B's score afterwards: a third, identical-to-B
    // swing is NOT a new personal best.
    expect(a!.isPersonalBest).toBe(false);
    const third = await engine.onStroke(clip);
    expect(third!.repIndex).toBe(3);
    expect(third!.isPersonalBest).toBe(false);
  });

  it('rapid burst of 8 concurrent strokes yields repIndex 1..8 exactly once each', async () => {
    const { providers } = controllableProviders([], []);
    const engine = makeEngine(providers);
    const reps = await Promise.all(
      Array.from({ length: 8 }, () => engine.onStroke(clip)),
    );
    const indices = reps.map(r => r!.repIndex).sort((x, y) => x - y);
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(engine.summary().validReps).toBe(8);
  });

  it('observed today: every in-flight stroke reports the FINAL counter value (lost update on repIndex)', async () => {
    const { providers } = controllableProviders([], []);
    const engine = makeEngine(providers);
    const reps = await Promise.all(
      Array.from({ length: 8 }, () => engine.onStroke(clip)),
    );
    // `this.repCounter` is re-read after the await instead of captured before
    // it, so all eight reps — and the selectCue() repIndex used for the
    // personal-best gate — carry repIndex 8.
    expect(reps.map(r => r!.repIndex)).toEqual([8, 8, 8, 8, 8, 8, 8, 8]);
    expect(engine.summary().validReps).toBe(8);
  });
});
