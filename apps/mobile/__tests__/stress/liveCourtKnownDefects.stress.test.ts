/**
 * Minimized, deterministic pins for every defect the seeded campaigns
 * reproduce (test-support/stress/knownDefects.ts). Each block asserts the EXPECTED
 * behaviour under `test.failing`, so the suite stays green on 1fb0efd7 and
 * flips to "expected to fail but passed" the moment a fix lands — at which
 * point the block becomes a plain `test` and the knownDefects entry goes.
 *
 * Nothing here is a second implementation of the unit: every pin drives the
 * public API of flow/session.ts, flow/liveCourt.ts, flow/liveSessionCoach.ts
 * and flow/liveSessionSummary.ts exactly as the campaigns do.
 */
import type { ShotTypeSlug } from '@pickle/shared-types';
import { createFixtureVisionProviderSet } from '../../../../packages/vision-contracts/test/support/fixtureProvider';
import { LiveCourtEngine } from '../../src/flow/liveCourt';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type SpokenCue,
} from '../../src/flow/liveSessionCoach';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../../src/flow/liveSessionSummary';
import {
  LiveSessionFlow,
  createPendingStubAnalysisProvider,
  getCompletedSession,
  type SessionMotionSample,
} from '../../src/flow/session';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import { SeededRng } from '../../test-support/stress/seededStress';

declare const process: {
  env: Record<string, string | undefined>;
  hrtime: { bigint(): bigint };
};
process.env.PICKLE_ENV = 'development';

const voice = () => ({
  available: () => true,
  speak: () => true,
  stop: () => undefined,
});

/** One clean stroke (rise → peak → fall) followed by a quiet valley, at a
 * fixed frame period. Integer clock unless `frameMs` is fractional. */
function strokeSeries(
  startMs: number,
  frameMs: number,
  peak = 3,
): SessionMotionSample[] {
  const samples: SessionMotionSample[] = [];
  let t = startMs;
  for (let i = 1; i <= 6; i++)
    samples.push({ tMs: (t += frameMs), v: (peak * i) / 6 });
  for (let i = 5; i >= 0; i--)
    samples.push({ tMs: (t += frameMs), v: (peak * i) / 6 + 0.04 });
  for (let i = 0; i < 40; i++) samples.push({ tMs: (t += frameMs), v: 0.04 });
  return samples;
}

function makeFlow(sessionId: string, onUpdate?: () => void) {
  return new LiveSessionFlow({
    sessionId,
    source: 'live',
    startedAtIso: '2026-01-01T00:00:00.000Z',
    provider: createPendingStubAnalysisProvider(),
    ...(onUpdate ? { onUpdate } : {}),
  });
}

describe('LC-1 — non-finite sample time poisons durationMs (session.ts L464, L502)', () => {
  // Campaign seeds 2772749347 / 2856637442 (liveSessionRandomized, base
  // 20260904), minimized to a single `malformed` action.
  test.failing(
    'a NaN/Infinity tMs is dropped like the engine drops it, so durationMs stays finite',
    () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const flow = makeFlow(`lc1-${String(bad)}`);
        for (const sample of strokeSeries(0, 33)) flow.pushSample(sample);
        const before = flow.snapshot().durationMs;
        flow.pushSample({ tMs: bad, v: 1 });
        // The engine ignores the sample (SessionEventEngine.push: !isFinite →
        // continue) — the flow's own clock must agree with the engine.
        expect(flow.snapshot().droppedLateSamples).toBe(0);
        expect(flow.snapshot().durationMs).toBe(before);
        expect(Number.isFinite(flow.snapshot().durationMs)).toBe(true);
      }
    },
  );

  test('observed: durationMs becomes NaN / Infinity and never recovers (documents the defect)', () => {
    const flow = makeFlow('lc1-observed');
    for (const sample of strokeSeries(0, 33)) flow.pushSample(sample);
    flow.pushSample({ tMs: Number.POSITIVE_INFINITY, v: 1 });
    expect(flow.snapshot().durationMs).toBe(Number.POSITIVE_INFINITY);
    for (const sample of strokeSeries(3000, 33)) flow.pushSample(sample);
    expect(flow.snapshot().durationMs).toBe(Number.POSITIVE_INFINITY);
    const snapshot = flow.end();
    const record = buildLiveSessionSummaryRecord(
      snapshot,
      sessionScoreProgression(snapshot.events),
      null,
    );
    // The stored row silently becomes durationMs 0 (JSON null → countOrZero).
    expect(
      parseLiveSessionSummaryRecord(JSON.stringify(record))?.durationMs,
    ).toBe(0);
  });
});

describe('LC-2 — sessionStarted() after the coach ended still speaks (liveSessionCoach.ts L144–L156)', () => {
  // Campaign seeds 3260190435 / 1012533942 (liveSessionRandomized).

  test.failing(
    'no cue is produced by sessionStarted() once sessionEnded() ran',
    () => {
      const cues: SpokenCue[] = [];
      const coach = new LiveSessionCoach({
        voice: voice(),
        onCue: cue => cues.push(cue),
      });
      coach.sessionStarted('live');
      const flow = makeFlow('lc2-ended');
      coach.sessionEnded(flow.end());
      const spokenBefore = cues.length;
      coach.sessionStarted('live');
      expect(cues.length).toBe(spokenBefore);
      expect(coach.recap().cues[coach.recap().cues.length - 1]!.category).toBe(
        'SESSION_END',
      );
    },
  );

  test.failing(
    'no cue is produced by sessionStarted() once dispose() ran',
    () => {
      const cues: SpokenCue[] = [];
      const coach = new LiveSessionCoach({
        voice: voice(),
        onCue: cue => cues.push(cue),
      });
      coach.sessionStarted('replay');
      coach.dispose();
      coach.sessionStarted('replay');
      expect(cues.map(cue => cue.category)).toEqual(['SESSION_START']);
    },
  );
});

describe('LC-3 — LiveCourtEngine.onStroke() stamps repIndex after the await (liveCourt.ts L67, L87, L97)', () => {
  // Campaign seeds 33038095 / 4294450153 (liveCourtEngineRandomized),
  // minimized to a single `burst` action.
  const SHOT: ShotTypeSlug = 'forehand_drive';
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));

  function engineWithLatency(latencies: number[]) {
    const base = createFixtureVisionProviderSet(SHOT);
    let call = 0;
    const providers = {
      ...base,
      pose: {
        ...base.pose,
        async extractPose(
          clip: Parameters<typeof base.pose.extractPose>[0],
          window: Parameters<typeof base.pose.extractPose>[1],
        ) {
          const wait = latencies[call++ % latencies.length] ?? 0;
          for (let i = 0; i < wait; i++) await tick();
          return base.pose.extractPose(clip, window);
        },
      },
    };
    let id = 0;
    return new LiveCourtEngine(providers, {
      sessionId: 'lc3',
      shotType: SHOT,
      focusCheckpoint: 'contact_position',
      handedness: 'right',
      appVersion: '0.0.0-stress',
      modelBundleVersion: 'fixture-1',
      makeId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    });
  }

  const clip = (index: number) => ({
    uri: `fixture://lc3/${index}`,
    durationMs: 1800,
    fps: 30,
    width: 720,
    height: 1280,
  });

  test.failing(
    'three overlapping strokes get repIndex 1, 2, 3 in call order',
    async () => {
      const engine = engineWithLatency([2, 0, 1]);
      const reps = await Promise.all(
        [1, 2, 3].map(i => engine.onStroke(clip(i))),
      );
      expect(reps.map(rep => rep?.repIndex)).toEqual([1, 2, 3]);
      expect(engine.allReps().map(rep => rep.repIndex)).toEqual([1, 2, 3]);
    },
  );

  test('observed: every overlapping rep carries the final counter value and allReps() is in completion order', async () => {
    const engine = engineWithLatency([2, 0, 1]);
    const reps = await Promise.all(
      [1, 2, 3].map(i => engine.onStroke(clip(i))),
    );
    expect(reps.map(rep => rep?.repIndex)).toEqual([3, 3, 3]);
    // Completion order 2 → 3 → 1 (latencies 0, 1, 2 ticks).
    expect(engine.allReps().map(rep => rep.analysis.id.slice(-1))).toEqual([
      '2',
      '3',
      '1',
    ]);
  });

  test('serial strokes (awaited one at a time) index correctly — the defect needs overlap', async () => {
    const engine = engineWithLatency([2, 0, 1]);
    const indices: Array<number | undefined> = [];
    for (const i of [1, 2, 3])
      indices.push((await engine.onStroke(clip(i)))?.repIndex);
    expect(indices).toEqual([1, 2, 3]);
  });
});

describe('LC-4 — completed-session registry lags onUpdateFailures after end() (session.ts L482, L610, L619)', () => {
  test.failing(
    'getCompletedSession() reports the same onUpdateFailures as flow.snapshot()',
    () => {
      const flow = makeFlow('lc4', () => {
        throw new Error('subscriber boom');
      });
      for (const sample of strokeSeries(0, 33)) flow.pushSample(sample);
      flow.end();
      expect(getCompletedSession('lc4')?.onUpdateFailures).toBe(
        flow.snapshot().onUpdateFailures,
      );
    },
  );
});

describe('LC-5 — parse zeroes a non-integer durationMs the builder wrote (liveSessionSummary.ts L49, L110)', () => {
  // Campaign: every fractional-clock plan that reaches `end` (92/200 in the
  // 200-seed smoke, e.g. seeds with plan.fractionalClock = true).
  test.failing(
    'build → JSON → parse is identity for a 30 fps (33.333 ms) sample clock',
    () => {
      const flow = makeFlow('lc5');
      for (const sample of strokeSeries(0, 1000 / 30)) flow.pushSample(sample);
      const snapshot = flow.end();
      expect(Number.isInteger(snapshot.durationMs)).toBe(false);
      const record = buildLiveSessionSummaryRecord(
        snapshot,
        sessionScoreProgression(snapshot.events),
        null,
      );
      expect(parseLiveSessionSummaryRecord(JSON.stringify(record))).toEqual(
        record,
      );
    },
  );

  test('observed: the stored row reads back durationMs 0', () => {
    const flow = makeFlow('lc5-observed');
    for (const sample of strokeSeries(0, 1000 / 30)) flow.pushSample(sample);
    const snapshot = flow.end();
    const record = buildLiveSessionSummaryRecord(
      snapshot,
      sessionScoreProgression(snapshot.events),
      null,
    );
    expect(record.durationMs).toBeGreaterThan(1000);
    expect(
      parseLiveSessionSummaryRecord(JSON.stringify(record))?.durationMs,
    ).toBe(0);
  });
});

describe('LC-6 — per-sample push cost grows with session length (analysis-pipeline sessionEngine.ts propose()/reconcile())', () => {
  // SessionEventEngine.push() → reconcile() → propose() re-runs
  // proposeStrokeEventsV2 over the WHOLE accumulated wrist series, and
  // buildEvent filters that series once per peak, so each pushSample() costs
  // O(samples × events). Measured here as wall-clock per fixed-size window of
  // a seeded 30 fps stroke stream; the threshold is loose (3×) because the
  // box is shared — a bounded engine keeps the ratio near 1.
  const WINDOW = 1200;
  const WINDOWS = 4;

  function measure(): number[] {
    const rng = new SeededRng(0x1c6);
    const flow = makeFlow('lc6');
    const costs: number[] = [];
    let t = 0;
    let pending: SessionMotionSample[] = [];
    const next = (): SessionMotionSample => {
      if (pending.length === 0) {
        pending = strokeSeries(t, 33, Number(rng.float(1.5, 5).toFixed(2)));
        t = pending[pending.length - 1]!.tMs;
      }
      return pending.shift()!;
    };
    for (let w = 0; w < WINDOWS; w++) {
      const started = process.hrtime.bigint();
      for (let i = 0; i < WINDOW; i++) flow.pushSample(next());
      costs.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    flow.end();
    return costs;
  }

  test.failing(
    `the ${WINDOWS}th window of ${WINDOW} samples costs at most 3× the first`,
    () => {
      const costs = measure();
      console.error(
        `LC-6 window costs (ms): ${costs.map(c => c.toFixed(0)).join(' ')}`,
      );
      expect(costs[WINDOWS - 1]! / Math.max(1, costs[0]!)).toBeLessThanOrEqual(
        3,
      );
    },
  );
});

describe("LC-2 companion — the recap registry is the coach's truth", () => {
  test('sessionEnded() registers the recap once and further calls do not change it', () => {
    const coach = new LiveSessionCoach({ voice: voice() });
    coach.sessionStarted('live');
    const flow = makeFlow('lc2-companion');
    const first = coach.sessionEnded(flow.end());
    const second = coach.sessionEnded(flow.snapshot());
    expect(second).toEqual(first);
    expect(getCompletedCoachRecap('lc2-companion')).toEqual(first);
  });
});
