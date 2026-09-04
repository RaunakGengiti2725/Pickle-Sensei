/**
 * ADVERSARIAL PASS 3 — mobile-analyze-capture / LiveSessionFlow races.
 *
 * Attacks (all against the seam's own state machine; providers are
 * state-machine doubles, never product results):
 *
 *  A1  end() → late motion sample → late provider resolution: the sample is
 *      rejected, the completed-session registry updates EXACTLY once per late
 *      outcome and never for the rejected sample.
 *  A2  5 events whose provider promises resolve in a SEEDED random order:
 *      sessionScoreProgression points are ordered by emission index.
 *  A3  Native feed delivers a sample after end(): dropped, flow untouched.
 *  A4  Late provider REJECTION after end() cannot rewrite a terminal state.
 *  A5  Corrupt/skewed samples (NaN, -Infinity, huge, unicode session id).
 *
 * Seeded randomness: mulberry32(SEED) — SEED is printed in the test name so
 * a failure can be replayed byte-for-byte.
 */
// Simulated native bridge + emitter (same shape as sessionNative.test.ts) so
// the native feed can be attacked without the real TurboModule.
jest.mock('react-native', () => {
  const listeners: Array<(event: object) => void> = [];
  const bridge = {
    capture: jest.fn(),
    importVideo: jest.fn(),
    cancel: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    startSessionCapture: jest.fn(),
    stopSessionCapture: jest.fn(),
    extractSessionEventClip: jest.fn(),
  };
  return {
    Platform: { OS: 'ios' },
    NativeModules: { PickleVideoCapture: bridge },
    NativeEventEmitter: class {
      addListener(_type: string, listener: (event: object) => void) {
        listeners.push(listener);
        return {
          remove: () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      }
    },
    __simulatedListeners: listeners,
  };
});
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
}));

const { __simulatedListeners: mockListeners } = jest.requireMock(
  'react-native',
) as { __simulatedListeners: Array<(event: object) => void> };

import type { AnalysisRecord } from '@pickle/swing-domain';
import {
  LiveSessionFlow,
  getCompletedSession,
  type LiveSessionSnapshot,
  type SessionEventAnalysisProvider,
  type SessionMotionSample,
} from '../src/flow/session';
import { connectNativeSessionMotionFeed } from '../src/flow/sessionNative';
import { sessionScoreProgression } from '../src/flow/sessionProgress';
import fixture from './fixtures/sessionReplay.afn-sasebo-rally1.json';

const rally: SessionMotionSample[] = fixture.wristSamples;

/** Two rallies back to back → ≥5 closed stroke events (3 + 3). */
function twoRallies(): SessionMotionSample[] {
  const last = rally[rally.length - 1]!.tMs;
  const offset = last + 1000;
  return [
    ...rally,
    ...rally.map(sample => ({ tMs: sample.tMs + offset, v: sample.v })),
  ];
}

function scoredRecord(id: string, overallScore: number): AnalysisRecord {
  return {
    schemaVersion: 1,
    id,
    captureId: `capture-${id}`,
    createdAtIso: '2026-01-01T00:00:00.000Z',
    engineVersion: 'test-double',
    strokeTaxonomyVersion: 'test-double',
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: false,
    },
    modelRuns: [],
    provenance: {
      appVersion: 'test-double',
      pipelineVersion: 'test-double',
      providerVersions: [],
      scoreVersion: 'test-double',
      taxonomyVersion: 'test-double',
      drillMappingVersion: 'none',
      captureEnvelopeVersion: 'capture-envelope-not-measured',
      recordedAtIso: '2026-01-01T00:00:00.000Z',
    },
    // Structural double: only resultKind/overallScore are read by the
    // progression module.
    result: {
      resultKind: 'scored',
      overallScore,
    } as unknown as AnalysisRecord['result'],
    faults: [],
    uncertainty: {
      analysisConfidence: 0,
      presentation: 'abstain',
      perCheckpoint: {},
      limitingFactors: ['TEST_DOUBLE'],
    },
    evidence: [],
    shadow: [],
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Provider whose every analyzeEvent is held until the test releases it. */
function gatedProvider(): {
  provider: SessionEventAnalysisProvider;
  release: (eventId: string, score: number) => void;
  fail: (eventId: string, message: string) => void;
  pendingIds: () => string[];
} {
  const gates = new Map<
    string,
    {
      resolve: (outcome: { status: 'ready'; analysis: AnalysisRecord }) => void;
      reject: (error: Error) => void;
    }
  >();
  return {
    provider: {
      providerId: 'gated-double',
      availability: () => ({ status: 'available' }),
      analyzeEvent: request =>
        new Promise((resolve, reject) => {
          gates.set(request.eventId, { resolve, reject });
        }),
    },
    release: (eventId, score) => {
      const gate = gates.get(eventId);
      if (!gate) throw new Error(`no gate for ${eventId}`);
      gates.delete(eventId);
      gate.resolve({
        status: 'ready',
        analysis: scoredRecord(`analysis-${eventId}`, score),
      });
    },
    fail: (eventId, message) => {
      const gate = gates.get(eventId);
      if (!gate) throw new Error(`no gate for ${eventId}`);
      gates.delete(eventId);
      gate.reject(new Error(message));
    },
    pendingIds: () => [...gates.keys()],
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('A1 — end() then late sample + late provider resolution', () => {
  it('rejects the late sample; registry updates exactly once per late outcome', async () => {
    const sessionId = 'attack-a1-late';
    const gated = gatedProvider();
    const updates: LiveSessionSnapshot[] = [];
    const flow = new LiveSessionFlow({
      sessionId,
      source: 'replay',
      provider: gated.provider,
      onUpdate: snapshot => updates.push(snapshot),
    });
    for (const sample of rally) flow.pushSample(sample);
    const atEnd = flow.end();
    expect(atEnd.phase).toBe('ended');
    expect(atEnd.strokeCount).toBe(3);
    // Dispatch reaches the provider one microtask hop later (clip extraction
    // step); let it land so every gate is armed before the attack.
    await flushMicrotasks();
    expect(gated.pendingIds().sort()).toEqual(['E1', 'E2', 'E3']);

    const registryAtEnd = getCompletedSession(sessionId);
    expect(registryAtEnd).not.toBeNull();
    expect(registryAtEnd!.events.map(event => event.state)).toEqual([
      'processing',
      'processing',
      'processing',
    ]);
    const updatesAtEnd = updates.length;

    // Late motion sample: MUST be rejected and MUST NOT touch the registry.
    expect(() => flow.pushSample({ tMs: 99_999, v: 3 })).toThrow(
      /already ended/,
    );
    expect(getCompletedSession(sessionId)).toBe(registryAtEnd);
    expect(updates.length).toBe(updatesAtEnd);
    expect(flow.snapshot().durationMs).toBe(atEnd.durationMs);
    expect(flow.snapshot().strokeCount).toBe(3);

    // ONE late provider resolution → EXACTLY ONE registry update.
    gated.release('E2', 7.5);
    await flushMicrotasks();
    const afterOne = getCompletedSession(sessionId)!;
    expect(afterOne).not.toBe(registryAtEnd);
    expect(updates.length).toBe(updatesAtEnd + 1);
    expect(afterOne.events.map(event => event.state)).toEqual([
      'processing',
      'ready',
      'processing',
    ]);
    expect(afterOne.events[1]!.analysis?.id).toBe('analysis-E2');

    // Rejected sample AFTER a late outcome: still no registry churn.
    expect(() => flow.pushSample({ tMs: 100_000, v: 3 })).toThrow(
      /already ended/,
    );
    expect(getCompletedSession(sessionId)).toBe(afterOne);
    expect(updates.length).toBe(updatesAtEnd + 1);

    // Remaining late outcomes: one update each, no more.
    gated.release('E1', 6.1);
    gated.release('E3', 8.2);
    await flow.settled();
    expect(updates.length).toBe(updatesAtEnd + 3);
    const final = getCompletedSession(sessionId)!;
    expect(final.events.map(event => event.state)).toEqual([
      'ready',
      'ready',
      'ready',
    ]);
    expect(final.phase).toBe('ended');
    expect(final.durationMs).toBe(atEnd.durationMs);

    // Idempotent second end() after everything settled: nothing changes.
    const again = flow.end();
    expect(again.events.map(event => event.state)).toEqual([
      'ready',
      'ready',
      'ready',
    ]);
    expect(updates.length).toBe(updatesAtEnd + 3);
  });
});

describe('A2 — 5 events, provider promises resolve out of order', () => {
  const SEEDS = [1, 7, 42, 20260904, 0xdeadbeef];
  for (const seed of SEEDS) {
    it(`orders progression points by emission index (seed=${seed})`, async () => {
      const sessionId = `attack-a2-${seed}`;
      const gated = gatedProvider();
      const flow = new LiveSessionFlow({
        sessionId,
        source: 'replay',
        provider: gated.provider,
      });
      for (const sample of twoRallies()) flow.pushSample(sample);
      flow.end();
      await flushMicrotasks();
      const ids = flow.snapshot().events.map(event => event.eventId);
      expect(ids.length).toBeGreaterThanOrEqual(5);
      expect(ids).toEqual(ids.map((_, index) => `E${index + 1}`));
      expect(gated.pendingIds().sort()).toEqual([...ids].sort());

      // Distinct scores so a wrong ordering is unambiguous: E(i) → score i.
      const rng = mulberry32(seed);
      const order = shuffled(ids, rng);
      expect(order).not.toEqual(ids); // the attack must really reorder
      for (const eventId of order) {
        gated.release(eventId, Number(eventId.slice(1)));
        await flushMicrotasks();
      }
      await flow.settled();

      const events = flow.snapshot().events;
      // Feed the views to the progression module in RESOLUTION order too —
      // the module documents order independence.
      const byResolution = order.map(id => events.find(e => e.eventId === id)!);
      for (const views of [events, byResolution]) {
        const progression = sessionScoreProgression(views);
        expect(progression.scoredCount).toBe(ids.length);
        expect(progression.points.map(point => point.eventIndex)).toEqual(
          ids.map((_, index) => index),
        );
        expect(progression.points.map(point => point.eventId)).toEqual(ids);
        expect(progression.points.map(point => point.score)).toEqual(
          ids.map((_, index) => index + 1),
        );
        // endMs strictly increasing along the session time axis.
        for (let i = 1; i < progression.points.length; i += 1) {
          expect(progression.points[i]!.endMs).toBeGreaterThan(
            progression.points[i - 1]!.endMs,
          );
        }
        expect(progression.best?.eventId).toBe(ids[ids.length - 1]);
        expect(progression.delta).not.toBeNull();
        expect(progression.delta!).toBeGreaterThan(0);
      }
      // Registry snapshot (what LiveSummary reads) agrees.
      const registry = getCompletedSession(sessionId)!;
      expect(registry.events.map(event => event.state)).toEqual(
        ids.map(() => 'ready'),
      );
      expect(registry.events.map(event => event.eventId)).toEqual(ids);
    });
  }
});

describe('A3 — native feed delivers a sample after end()', () => {
  it('drops the late native sample without touching the ended flow', async () => {
    const sessionId = 'attack-a3-native-late';
    const gated = gatedProvider();
    const flow = new LiveSessionFlow({
      sessionId,
      source: 'live',
      provider: gated.provider,
    });
    const captureId = 'native-capture-1';
    const connection = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: captureId,
    });
    const emit = (event: object) => {
      for (const listener of [...mockListeners]) listener(event);
    };
    expect(mockListeners).toHaveLength(1);
    for (const sample of rally) {
      emit({
        type: 'session_motion_sample',
        captureId,
        tMs: sample.tMs,
        v: sample.v,
        emittedAtIso: '2026-01-01T00:00:00.000Z',
      });
    }
    expect(flow.snapshot().strokeCount).toBeGreaterThanOrEqual(2);
    const ended = flow.end();
    const registry = getCompletedSession(sessionId);

    // Queued native emission delivered after stop.
    emit({
      type: 'session_motion_sample',
      captureId,
      tMs: ended.durationMs + 5000,
      v: 4,
      emittedAtIso: '2026-01-01T00:00:10.000Z',
    });
    // And one for a DIFFERENT capture id, and one malformed.
    emit({
      type: 'session_motion_sample',
      captureId: 'someone-else',
      tMs: 1,
      v: 1,
      emittedAtIso: '2026-01-01T00:00:10.000Z',
    });
    emit({ type: 'session_motion_sample', captureId, tMs: 'x', v: null });

    expect(flow.snapshot().durationMs).toBe(ended.durationMs);
    expect(flow.snapshot().strokeCount).toBe(ended.strokeCount);
    expect(getCompletedSession(sessionId)).toBe(registry);
    // The feed disconnected itself on the first post-end delivery.
    expect(mockListeners).toHaveLength(0);
    expect(connection.droppedInvalidSamples()).toBe(0);
    connection.disconnect();
    await flushMicrotasks();
    expect(gated.pendingIds().length).toBe(ended.strokeCount);
    for (const id of gated.pendingIds()) gated.release(id, 5);
    await flow.settled();
  });
});

describe('A4 — late provider rejection after end()', () => {
  it('cannot rewrite an already-terminal event; failing events abstain honestly', async () => {
    const sessionId = 'attack-a4-late-reject';
    const gated = gatedProvider();
    const flow = new LiveSessionFlow({
      sessionId,
      source: 'replay',
      provider: gated.provider,
    });
    for (const sample of rally) flow.pushSample(sample);
    flow.end();
    await flushMicrotasks();
    gated.release('E1', 9);
    await flushMicrotasks();
    expect(flow.snapshot().events[0]!.state).toBe('ready');
    gated.fail('E2', 'permit service unreachable \u{1F4A5} 権限');
    gated.fail('E3', 'x'.repeat(100_000));
    await flow.settled();
    const [e1, e2, e3] = getCompletedSession(sessionId)!.events;
    expect(e1!.state).toBe('ready');
    expect(e1!.analysis?.id).toBe('analysis-E1');
    expect(e2!.state).toBe('abstained');
    expect(e2!.abstainReason).toContain('ANALYSIS_DISPATCH_FAILED');
    expect(e2!.abstainReason).toContain('\u{1F4A5} 権限');
    expect(e3!.state).toBe('abstained');
    // Progression: 1 scored, 2 no-reads, 0 pending — nothing invented.
    const progression = sessionScoreProgression(flow.snapshot().events);
    expect(progression.scoredCount).toBe(1);
    expect(progression.noReadCount).toBe(2);
    expect(progression.pendingCount).toBe(0);
    expect(progression.points.map(point => point.eventId)).toEqual(['E1']);
  });
});

describe('A5 — corrupt/skewed samples and hostile ids at the native boundary', () => {
  it('NaN / infinite / negative / non-number samples are dropped+counted, never coerced', async () => {
    const gated = gatedProvider();
    const sessionId = 'attack-a5-\u{1F3D3}-'.padEnd(600, 'ü');
    const flow = new LiveSessionFlow({
      sessionId,
      source: 'live',
      provider: gated.provider,
    });
    const captureId = 'capture-\u{1F3D3}';
    const connection = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: captureId,
    });
    const emit = (event: object) => {
      for (const listener of [...mockListeners]) listener(event);
    };
    const base = { type: 'session_motion_sample', captureId };
    const hostile: object[] = [
      { ...base, tMs: Number.NaN, v: Number.NaN },
      { ...base, tMs: -1, v: -5 },
      { ...base, tMs: Number.POSITIVE_INFINITY, v: 1 },
      { ...base, tMs: 0, v: Number.NEGATIVE_INFINITY },
      { ...base, tMs: '100', v: '1' },
      { ...base, tMs: 100, v: 1, captureId: 42 },
      { ...base, tMs: 100, v: 1, emittedAtIso: 12345 },
      { ...base, tMs: 100n, v: 1 },
      { ...base, tMs: 100, v: null },
      { ...base, tMs: [100], v: [1] },
    ];
    for (const event of hostile) emit(event);
    expect(connection.droppedInvalidSamples()).toBe(hostile.length);
    expect(flow.snapshot().durationMs).toBe(0);
    expect(flow.snapshot().strokeCount).toBe(0);

    // Clock skew: huge-but-finite tMs is contractually valid; it must not
    // throw and the real rally after it is handled by the engine's own
    // late-sample accounting (pinned: no crash, no fabricated strokes from
    // garbage alone).
    emit({ ...base, tMs: Number.MAX_SAFE_INTEGER, v: 0 });
    expect(connection.droppedInvalidSamples()).toBe(hostile.length);
    for (const sample of rally) emit({ ...base, ...sample });
    const ended = flow.end();
    expect(() => JSON.stringify(ended)).not.toThrow();
    expect(Number.isFinite(ended.durationMs)).toBe(true);
    expect(getCompletedSession(sessionId)?.phase).toBe('ended');
    expect(getCompletedSession(sessionId)?.sessionId).toBe(sessionId);
    connection.disconnect();
    await flushMicrotasks();
    for (const id of gated.pendingIds()) gated.release(id, 5);
    await flow.settled();
  });
});
