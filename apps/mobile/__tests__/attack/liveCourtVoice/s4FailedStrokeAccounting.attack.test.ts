/**
 * ADVERSARIAL S4 (mobile-live-court-voice, pass 3) — a stroke the pipeline
 * could not analyze (analyzeClip → ok:false) must still be ACCOUNTED for.
 *
 * Attack: stroke 2 of 3 fails in the vision provider (no stroke detected →
 * `low_confidence` failure, exactly what an unreadable swing produces).
 * LiveCourtEngine.onStroke (liveCourt.ts L67-79) bumps `repCounter`, then
 * returns null before anything is recorded, so:
 *   - summary().validReps + lowConfidenceReps no longer equals the strokes
 *     the player actually took (the swing silently vanishes);
 *   - the cue engine's low-confidence streak never advances, so N unreadable
 *     swings in a row never produce the SETUP_GUIDANCE cue the engine has for
 *     exactly that situation (cueEngine.ts L94-106).
 * Also: two strokes analyzed concurrently whose analyses resolve out of order
 * are recorded in RESOLUTION order, not stroke order (L105), which flips
 * startScore/endScore and feeds the cue engine reps in the wrong sequence.
 */
import type { Result } from '@pickle/shared-types';
import { fail, failure, ok } from '@pickle/shared-types';
import type {
  IStrokeDetector,
  StrokeEvent,
  VideoClipRef,
  VisionProviderSet,
} from '@pickle/vision-contracts';
import { createFixtureVisionProviderSet } from '../../../../../packages/vision-contracts/test/support/fixtureProvider';
import { LiveCourtEngine } from '../../../src/flow/liveCourt';

declare const process: { env: Record<string, string | undefined> };
process.env.PICKLE_ENV = 'development';

const clip = {
  uri: 'fixture://forehand/attack-s4',
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

type StrokePlan = (
  callIndex: number,
  clip: VideoClipRef,
) => Promise<Result<StrokeEvent[]>> | null;

/** Wraps the fixture stroke detector; `plan` may override individual calls. */
function providersWithStrokePlan(plan: StrokePlan): {
  providers: VisionProviderSet;
  calls: () => number;
} {
  const base = createFixtureVisionProviderSet('forehand_drive');
  let calls = 0;
  const stroke: IStrokeDetector = {
    modelVersion: base.stroke.modelVersion,
    source: base.stroke.source,
    async detectStrokes(c: VideoClipRef) {
      const index = calls;
      calls += 1;
      const override = plan(index, c);
      if (override !== null) return override;
      return base.stroke.detectStrokes(c);
    },
  };
  return { providers: { ...base, stroke }, calls: () => calls };
}

function makeEngine(providers: VisionProviderSet) {
  let counter = 0;
  return new LiveCourtEngine(providers, {
    sessionId: '11111111-2222-4333-8444-555555555555',
    shotType: 'forehand_drive',
    focusCheckpoint: 'contact_position',
    handedness: 'right',
    appVersion: '0.1.0-attack',
    modelBundleVersion: 'fixture-1',
    makeId: () =>
      `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  });
}

const noStroke = (): Promise<Result<StrokeEvent[]>> => Promise.resolve(ok([]));
const corrupt = (): Promise<Result<StrokeEvent[]>> =>
  Promise.resolve(
    fail(
      failure(
        'corrupted_media',
        'vision.stroke.decode_failed',
        'Could not decode the clip.',
      ),
    ),
  );

describe('ADVERSARIAL S4: stroke 2 of 3 fails in the vision provider', () => {
  it('the failed stroke is reported to the caller as null (no fake score)', async () => {
    const { providers } = providersWithStrokePlan(i =>
      i === 1 ? noStroke() : null,
    );
    const engine = makeEngine(providers);
    const r1 = await engine.onStroke(clip);
    const r2 = await engine.onStroke(clip);
    const r3 = await engine.onStroke(clip);
    expect(r1?.analysis.resultKind).toBe('scored');
    expect(r2).toBeNull();
    expect(r3?.analysis.resultKind).toBe('scored');
    // repIndex is honest about the gap...
    expect([r1?.repIndex, r3?.repIndex]).toEqual([1, 3]);
  });

  it('summary() accounts for the attempted stroke: valid + lowConfidence === 3 attempted, lowConfidence === 1', async () => {
    const { providers, calls } = providersWithStrokePlan(i =>
      i === 1 ? noStroke() : null,
    );
    const engine = makeEngine(providers);
    for (let i = 0; i < 3; i += 1) await engine.onStroke(clip);
    expect(calls()).toBe(3);
    const summary = engine.summary();
    // ...but the summary is not: today validReps=2, lowConfidenceReps=0.
    expect(summary.validReps).toBe(2);
    expect(summary.validReps + summary.lowConfidenceReps).toBe(3);
    expect(summary.lowConfidenceReps).toBe(1);
  });

  it('a corrupted_media failure on stroke 2 is accounted for the same way', async () => {
    const { providers } = providersWithStrokePlan(i =>
      i === 1 ? corrupt() : null,
    );
    const engine = makeEngine(providers);
    for (let i = 0; i < 3; i += 1) await engine.onStroke(clip);
    const summary = engine.summary();
    expect(summary.validReps).toBe(2);
    expect(summary.validReps + summary.lowConfidenceReps).toBe(3);
  });

  it('three unreadable strokes in a row must reach the SETUP_GUIDANCE cue (cueEngine lowConfidenceGuidanceAfter=3)', async () => {
    const { providers } = providersWithStrokePlan(() => noStroke());
    const engine = makeEngine(providers);
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push(await engine.onStroke(clip));
    // Today every call returns null and nothing is recorded, so the coach
    // has no way to ever say "Check the camera framing".
    const summary = engine.summary();
    expect(summary.lowConfidenceReps).toBe(3);
    expect(summary.cuesSpoken).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r?.cue.category === 'CORRECTION')).toBe(true);
  });

  it('EVIDENCE: allReps() shows the gap while summary() hides it', async () => {
    const { providers } = providersWithStrokePlan(i =>
      i === 1 ? noStroke() : null,
    );
    const engine = makeEngine(providers);
    for (let i = 0; i < 3; i += 1) await engine.onStroke(clip);
    const indices = engine.allReps().map(r => r.repIndex);
    const summary = engine.summary();
    // Passes on 4d812e1a — this is the observed shape for the finding.
    expect(indices).toEqual([1, 3]);
    expect({
      valid: summary.validReps,
      low: summary.lowConfidenceReps,
    }).toEqual({
      valid: 2,
      low: 0,
    });
  });
});

describe('ADVERSARIAL S4b: concurrent strokes whose analyses resolve out of order', () => {
  function delayed(ms: number, base: IStrokeDetector, c: VideoClipRef) {
    return new Promise<Result<StrokeEvent[]>>(resolve => {
      setTimeout(() => {
        void base.detectStrokes(c).then(resolve);
      }, ms);
    });
  }

  it('reps are recorded in stroke order (repIndex 1 before 2) even when stroke 2 finishes first', async () => {
    const base = createFixtureVisionProviderSet('forehand_drive');
    // Stroke 1 takes 40ms, stroke 2 finishes immediately.
    const { providers } = providersWithStrokePlan((i, c) =>
      delayed(i === 0 ? 40 : 0, base.stroke, c),
    );
    const engine = makeEngine(providers);
    const first = engine.onStroke({ ...clip, durationMs: 1500 });
    const second = engine.onStroke({ ...clip, durationMs: 2400 });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1?.repIndex).toBe(1);
    expect(r2?.repIndex).toBe(2);
    const order = engine.allReps().map(r => r.repIndex);
    // Today: [2, 1] — recorded in resolution order.
    expect(order).toEqual([1, 2]);
    const summary = engine.summary();
    expect(summary.startScore).toBe(r1?.analysis.overallScore ?? null);
    expect(summary.endScore).toBe(r2?.analysis.overallScore ?? null);
  });

  it('EVIDENCE: both in-flight strokes read repCounter AFTER their await → duplicate repIndex 2, recorded in resolution order', async () => {
    const base = createFixtureVisionProviderSet('forehand_drive');
    const { providers } = providersWithStrokePlan((i, c) =>
      delayed(i === 0 ? 40 : 0, base.stroke, c),
    );
    const engine = makeEngine(providers);
    const [r1, r2] = await Promise.all([
      engine.onStroke({ ...clip, durationMs: 1500 }),
      engine.onStroke({ ...clip, durationMs: 2400 }),
    ]);
    const s1 = r1?.analysis.overallScore ?? null;
    const s2 = r2?.analysis.overallScore ?? null;
    const summary = engine.summary();
    // Observed on 4d812e1a (liveCourt.ts L87/L97 read this.repCounter after
    // the await at L68): neither rep is repIndex 1; both are 2; the first
    // recorded rep is the one whose analysis finished first (stroke 2).
    expect([r1?.repIndex, r2?.repIndex]).toEqual([2, 2]);
    expect(engine.allReps().map(r => r.repIndex)).toEqual([2, 2]);
    expect(summary.startScore).toBe(s2);
    expect(summary.endScore).toBe(s1);
    expect(typeof s1).toBe('number');
    expect(typeof s2).toBe('number');
  });

  it('EVIDENCE: sequential strokes get unique, ordered repIndex (the concurrent case is the only breakage)', async () => {
    const engine = makeEngine(createFixtureVisionProviderSet('forehand_drive'));
    const a = await engine.onStroke({ ...clip, durationMs: 1500 });
    const b = await engine.onStroke({ ...clip, durationMs: 2400 });
    expect([a?.repIndex, b?.repIndex]).toEqual([1, 2]);
    expect(engine.allReps().map(r => r.repIndex)).toEqual([1, 2]);
  });
});
