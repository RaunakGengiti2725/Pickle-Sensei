/**
 * ADVERSARIAL PASS (native-swing-lab-camera-engine #2) — TS side of the
 * native session bridge, against a SIMULATED native module + event emitter.
 *
 * Attacks (each `it` states the contract it pins and what a break looks like):
 *  - a valid motion event with `captureId: undefined` while the feed is bound
 *    to a session id IS accepted (the guard only drops DEFINED mismatching ids);
 *  - malformed payloads claiming the frozen type (tMs:-1, v:NaN, string tMs)
 *    are counted malformed and never reach LiveSessionFlow.pushSample; an
 *    event whose type is 'session_motion_sample ' (trailing space) is NOT the
 *    frozen type — it is ignored like any foreign event and NOT counted;
 *  - `extractSessionEventClip` rejecting with camera.session_not_found after
 *    stopSessionCapture resolved leaves every event honestly pending with the
 *    native message, exactly ONE extraction call per event, no retry loop;
 *  - seeded rapid interleavings of valid/malformed/foreign samples, late
 *    emissions after end(), unicode + huge capture ids, extreme numeric
 *    values, and a throwing pushSample.
 *
 * Seeded randomness: mulberry32(SEED) with SEED = 0x5eed_0002 (recorded in
 * the assertion messages so a failure can be replayed).
 */
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
    NativeModules: {
      PickleVideoCapture: bridge,
    },
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
    __simulatedBridge: bridge,
    __simulatedListeners: listeners,
  };
});

const { __simulatedBridge: mockBridge, __simulatedListeners: mockListeners } =
  jest.requireMock('react-native') as {
    __simulatedBridge: {
      startSessionCapture: jest.Mock;
      stopSessionCapture: jest.Mock;
      extractSessionEventClip: jest.Mock;
    };
    __simulatedListeners: Array<(event: object) => void>;
  };

jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
}));

import {
  startSessionCapture,
  stopSessionCapture,
} from '../../src/camera/capture';
import {
  LiveSessionFlow,
  createPendingStubAnalysisProvider,
  type SessionEventAnalysisProvider,
  type SessionMotionSample,
} from '../../src/flow/session';
import {
  connectNativeSessionMotionFeed,
  createNativeSessionEventClipSource,
  isSessionMotionSampleEvent,
} from '../../src/flow/sessionNative';
import fixture from '../fixtures/sessionReplay.afn-sasebo-rally1.json';

const samples: SessionMotionSample[] = fixture.wristSamples;
const CAPTURE_ID = 'session-capture-attack-2';
const SEED = 0x5eed_0002;

/** mulberry32 — tiny deterministic PRNG so every run replays identically. */
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

function emitNative(event: object): void {
  for (const listener of [...mockListeners]) listener(event);
}

/** `captureId: null` OMITS the key (an `undefined` argument would take the
 * default, which is the classic default-parameter trap). */
function motionEvent(
  sample: SessionMotionSample,
  captureId: string | null = CAPTURE_ID,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: 'session_motion_sample',
    tMs: sample.tMs,
    v: sample.v,
    emittedAtIso: '2026-09-04T10:00:00.000Z',
  };
  if (captureId !== null) event.captureId = captureId;
  return event;
}

/** Wraps a flow so every pushSample call is recorded (the attack oracle). */
function recordingFlow(sessionId: string): {
  flow: LiveSessionFlow;
  pushed: SessionMotionSample[];
} {
  const pushed: SessionMotionSample[] = [];
  const flow = new LiveSessionFlow({
    sessionId,
    source: 'live',
    provider: createPendingStubAnalysisProvider(),
  });
  const originalPush = flow.pushSample.bind(flow);
  flow.pushSample = sample => {
    pushed.push(sample);
    return originalPush(sample);
  };
  return { flow, pushed };
}

/** Mirrors the iOS bridge rejection shape (RN wraps native rejects into an
 * Error carrying `code`). Message text from PickleVideoCapture.swift. */
function sessionNotFoundError(): Error & { code: string } {
  const error = new Error(
    'No active session capture matches this id.',
  ) as Error & { code: string };
  error.code = 'camera.session_not_found';
  return error;
}

beforeEach(() => {
  mockListeners.length = 0;
  mockBridge.startSessionCapture.mockReset();
  mockBridge.stopSessionCapture.mockReset();
  mockBridge.extractSessionEventClip.mockReset();
});

describe('[attack] capture-id guard contract', () => {
  it('accepts a valid event with captureId undefined while sessionCaptureId is set (only DEFINED mismatching ids are dropped)', () => {
    const { flow, pushed } = recordingFlow('attack-undefined-id');
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    const event = motionEvent({ tMs: 10, v: 0.3 }, null);
    expect('captureId' in event).toBe(false);
    expect(isSessionMotionSampleEvent(event)).toBe(true);
    emitNative(event);
    // Explicit `captureId: undefined` key present is the same contract.
    emitNative({ ...motionEvent({ tMs: 20, v: 0.3 }), captureId: undefined });
    // A DEFINED mismatching id is dropped silently (not a malformed payload).
    emitNative(motionEvent({ tMs: 30, v: 0.3 }, 'other-capture'));
    // The matching id is accepted.
    emitNative(motionEvent({ tMs: 40, v: 0.3 }, CAPTURE_ID));
    expect(pushed).toEqual([
      { tMs: 10, v: 0.3 },
      { tMs: 20, v: 0.3 },
      { tMs: 40, v: 0.3 },
    ]);
    expect(feed.droppedInvalidSamples()).toBe(0);
    feed.disconnect();
  });

  it('with no sessionCaptureId bound, every defined captureId is accepted (nothing to mismatch against)', () => {
    const { flow, pushed } = recordingFlow('attack-unbound');
    const feed = connectNativeSessionMotionFeed(flow);
    emitNative(motionEvent({ tMs: 10, v: 0.1 }, 'a'));
    emitNative(motionEvent({ tMs: 20, v: 0.1 }, 'b'));
    emitNative(motionEvent({ tMs: 30, v: 0.1 }, null));
    expect(pushed).toHaveLength(3);
    expect(feed.droppedInvalidSamples()).toBe(0);
    feed.disconnect();
  });

  it('matches capture ids by exact code points — unicode normalisation forms and huge ids are not conflated', () => {
    const nfc = 'capture-\u00e9-\u{1F3D3}'; // é precomposed + 🏓
    const nfd = 'capture-e\u0301-\u{1F3D3}'; // e + combining acute
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'));
    const { flow, pushed } = recordingFlow('attack-unicode');
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: nfc,
    });
    emitNative(motionEvent({ tMs: 10, v: 0.2 }, nfc));
    emitNative(motionEvent({ tMs: 20, v: 0.2 }, nfd));
    emitNative(motionEvent({ tMs: 30, v: 0.2 }, 'x'.repeat(1 << 20)));
    emitNative(motionEvent({ tMs: 40, v: 0.2 }, ''));
    expect(pushed).toEqual([{ tMs: 10, v: 0.2 }]);
    expect(feed.droppedInvalidSamples()).toBe(0);
    feed.disconnect();

    const hugeId = 'h'.repeat(1 << 20);
    const bound = recordingFlow('attack-huge-id');
    const hugeFeed = connectNativeSessionMotionFeed(bound.flow, {
      sessionCaptureId: hugeId,
    });
    emitNative(motionEvent({ tMs: 10, v: 0.2 }, hugeId));
    emitNative(motionEvent({ tMs: 20, v: 0.2 }, `${hugeId}h`));
    expect(bound.pushed).toEqual([{ tMs: 10, v: 0.2 }]);
    hugeFeed.disconnect();
  });
});

describe('[attack] malformed payloads never reach pushSample', () => {
  it('tMs:-1, v:NaN and a string tMs are counted malformed; the trailing-space type is a FOREIGN event (ignored, not counted)', () => {
    const { flow, pushed } = recordingFlow('attack-malformed');
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    const claimingFrozenType = [
      { type: 'session_motion_sample', tMs: -1, v: 0.5, captureId: CAPTURE_ID },
      {
        type: 'session_motion_sample',
        tMs: 10,
        v: Number.NaN,
        captureId: CAPTURE_ID,
      },
      {
        type: 'session_motion_sample',
        tMs: '10',
        v: 0.5,
        captureId: CAPTURE_ID,
      },
    ];
    const trailingSpaceType = {
      type: 'session_motion_sample ',
      tMs: 10,
      v: 0.5,
      captureId: CAPTURE_ID,
    };
    for (const bad of [...claimingFrozenType, trailingSpaceType]) {
      expect(isSessionMotionSampleEvent(bad)).toBe(false);
      emitNative(bad);
    }
    expect(pushed).toEqual([]);
    // Contract as implemented (sessionNative.ts connectNativeSessionMotionFeed):
    // only payloads whose `type` IS the frozen string but fail validation are
    // counted. 'session_motion_sample ' is a different event type and is
    // dropped on the same silent path as e.g. `{type:'permission'}`.
    expect(feed.droppedInvalidSamples()).toBe(claimingFrozenType.length);
    expect(feed.droppedInvalidSamples()).toBe(3);
    feed.disconnect();
  });

  it('rejects every non-finite / negative / wrongly-typed field and every non-object envelope', () => {
    const { flow, pushed } = recordingFlow('attack-fields');
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    const bad: unknown[] = [
      { type: 'session_motion_sample', tMs: Number.POSITIVE_INFINITY, v: 0.1 },
      { type: 'session_motion_sample', tMs: Number.NEGATIVE_INFINITY, v: 0.1 },
      { type: 'session_motion_sample', tMs: 10, v: Number.POSITIVE_INFINITY },
      { type: 'session_motion_sample', tMs: 10, v: -0 - 1e-9 },
      { type: 'session_motion_sample', tMs: 10, v: null },
      { type: 'session_motion_sample', tMs: null, v: 0.1 },
      { type: 'session_motion_sample', tMs: 10n as unknown, v: 0.1 },
      { type: 'session_motion_sample', tMs: 10, v: 0.1, captureId: 42 },
      { type: 'session_motion_sample', tMs: 10, v: 0.1, captureId: null },
      { type: 'session_motion_sample', tMs: 10, v: 0.1, emittedAtIso: 12 },
      { type: 'session_motion_sample', tMs: [10], v: 0.1 },
      { type: 'session_motion_sample', tMs: { valueOf: () => 10 }, v: 0.1 },
      { type: ['session_motion_sample'], tMs: 10, v: 0.1 },
    ];
    for (const payload of bad) {
      expect(isSessionMotionSampleEvent(payload)).toBe(false);
      emitNative(payload as object);
    }
    // Non-object envelopes cannot even be emitted as objects; validate directly.
    for (const envelope of [null, undefined, 1, 'session_motion_sample', []]) {
      expect(isSessionMotionSampleEvent(envelope)).toBe(false);
    }
    expect(pushed).toEqual([]);
    // Every entry above claims the frozen type except the array-typed one.
    expect(feed.droppedInvalidSamples()).toBe(bad.length - 1);
    feed.disconnect();
  });

  it('clock-skewed / garbage emittedAtIso strings are tolerated (string-typed), non-strings are malformed', () => {
    const { flow, pushed } = recordingFlow('attack-clock');
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    emitNative({
      ...motionEvent({ tMs: 10, v: 0.1 }),
      emittedAtIso: '1970-01-01T00:00:00.000Z',
    });
    emitNative({
      ...motionEvent({ tMs: 20, v: 0.1 }),
      emittedAtIso: '2999-12-31T23:59:59.999Z',
    });
    emitNative({
      ...motionEvent({ tMs: 30, v: 0.1 }),
      emittedAtIso: 'not a date',
    });
    emitNative({
      ...motionEvent({ tMs: 40, v: 0.1 }),
      emittedAtIso: Date.now(),
    });
    expect(pushed.map(s => s.tMs)).toEqual([10, 20, 30]);
    expect(feed.droppedInvalidSamples()).toBe(1);
    feed.disconnect();
  });

  it('extreme-but-finite values are accepted by the boundary and do not crash the engine', () => {
    const { flow, pushed } = recordingFlow('attack-extremes');
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    emitNative(motionEvent({ tMs: 0, v: 0 }));
    emitNative(motionEvent({ tMs: 1, v: Number.MAX_VALUE }));
    emitNative(motionEvent({ tMs: 2, v: Number.MIN_VALUE }));
    emitNative(motionEvent({ tMs: Number.MAX_SAFE_INTEGER, v: 0.1 }));
    // Time going backwards after the huge timestamp: with no closed event the
    // frontier has not moved, so the engine must SORT it in (not drop it) and
    // must not throw on the out-of-order arrival.
    expect(() => emitNative(motionEvent({ tMs: 3, v: 0.1 }))).not.toThrow();
    expect(pushed).toHaveLength(5);
    expect(feed.droppedInvalidSamples()).toBe(0);
    const snapshot = flow.end();
    expect(Number.isFinite(snapshot.durationMs)).toBe(true);
    expect(snapshot.durationMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(snapshot.droppedLateSamples).toBe(0);
    expect(snapshot.phase).toBe('ended');
    for (const event of snapshot.events) {
      expect(Number.isFinite(event.startMs)).toBe(true);
      expect(Number.isFinite(event.endMs)).toBe(true);
      expect(Number.isFinite(event.peakSpeed)).toBe(true);
    }
    feed.disconnect();
  });

  it('seeded rapid interleaving: exact malformed count, exact accepted order, foreign ids never counted', () => {
    const rng = mulberry32(SEED);
    const { flow, pushed } = recordingFlow('attack-seeded');
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    const expectedPushed: SessionMotionSample[] = [];
    let expectedMalformed = 0;
    let tMs = 0;
    // Kept at 2 500 emissions: LiveSessionFlow.pushSample re-proposes over the
    // whole accumulated series (see sessionEngineScaling.attack.test.ts), so
    // larger counts turn this boundary test into a runtime benchmark.
    const TOTAL = 2_500;
    for (let index = 0; index < TOTAL; index += 1) {
      tMs += 1 + Math.floor(rng() * 40);
      const roll = rng();
      if (roll < 0.6) {
        const v = Math.round(rng() * 5 * 1e4) / 1e4;
        expectedPushed.push({ tMs, v });
        emitNative(motionEvent({ tMs, v }));
      } else if (roll < 0.75) {
        expectedMalformed += 1;
        const variant = Math.floor(rng() * 4);
        emitNative(
          variant === 0
            ? { type: 'session_motion_sample', tMs: -tMs, v: 0.1 }
            : variant === 1
              ? { type: 'session_motion_sample', tMs, v: Number.NaN }
              : variant === 2
                ? { type: 'session_motion_sample', tMs: String(tMs), v: 0.1 }
                : { type: 'session_motion_sample', tMs, v: -1 },
        );
      } else if (roll < 0.9) {
        emitNative(motionEvent({ tMs, v: 0.1 }, `foreign-${index}`));
      } else {
        emitNative({ type: 'session_motion_sample ', tMs, v: 0.1 });
      }
    }
    expect(pushed).toEqual(expectedPushed);
    expect(feed.droppedInvalidSamples()).toBe(expectedMalformed);
    expect(expectedPushed.length).toBeGreaterThan(TOTAL * 0.5);
    expect(expectedMalformed).toBeGreaterThan(TOTAL * 0.1);
    feed.disconnect();
  });

  it('late emissions after end() are dropped without throwing and the feed self-detaches', () => {
    const { flow, pushed } = recordingFlow('attack-late');
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    emitNative(motionEvent({ tMs: 10, v: 0.2 }));
    flow.end();
    expect(mockListeners).toHaveLength(1);
    expect(() => emitNative(motionEvent({ tMs: 20, v: 0.2 }))).not.toThrow();
    // Self-detached on the first post-end sample: the listener is gone.
    expect(mockListeners).toHaveLength(0);
    expect(() => emitNative(motionEvent({ tMs: 30, v: 0.2 }))).not.toThrow();
    expect(pushed).toEqual([{ tMs: 10, v: 0.2 }]);
    expect(feed.droppedInvalidSamples()).toBe(0);
    // Double disconnect is idempotent.
    feed.disconnect();
    feed.disconnect();
  });

  it('a throwing pushSample is contained and counted, and the feed keeps serving later samples', () => {
    const flow = new LiveSessionFlow({
      sessionId: 'attack-throwing-push',
      source: 'live',
      provider: createPendingStubAnalysisProvider(),
    });
    const originalPush = flow.pushSample.bind(flow);
    let armed = true;
    const pushed: SessionMotionSample[] = [];
    flow.pushSample = sample => {
      if (armed) {
        armed = false;
        throw new Error('simulated engine fault');
      }
      pushed.push(sample);
      return originalPush(sample);
    };
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    expect(() => emitNative(motionEvent({ tMs: 10, v: 0.2 }))).not.toThrow();
    emitNative(motionEvent({ tMs: 20, v: 0.2 }));
    expect(pushed).toEqual([{ tMs: 20, v: 0.2 }]);
    expect(feed.droppedInvalidSamples()).toBe(1);
    feed.disconnect();
  });
});

describe('[attack] clip extraction after the native session is gone', () => {
  it('camera.session_not_found after stopSessionCapture resolved → every event pending, ONE extraction call each, no retry loop', async () => {
    mockBridge.startSessionCapture.mockResolvedValue({
      sessionCaptureId: CAPTURE_ID,
    });
    mockBridge.stopSessionCapture.mockResolvedValue(undefined);
    const receipt = await startSessionCapture();
    await stopSessionCapture(receipt.sessionCaptureId);
    expect(mockBridge.stopSessionCapture).toHaveBeenCalledWith(CAPTURE_ID);
    // From here the coordinator is nil on the native side: every extraction
    // rejects with the bridge's camera.session_not_found error.
    mockBridge.extractSessionEventClip.mockImplementation(async () => {
      throw sessionNotFoundError();
    });

    const provider: SessionEventAnalysisProvider = {
      providerId: 'attack-never-called',
      availability: () => ({ status: 'available' }),
      analyzeEvent: jest.fn(),
    };
    const flow = new LiveSessionFlow({
      sessionId: 'attack-session-not-found',
      source: 'live',
      provider,
      clipSource: createNativeSessionEventClipSource(CAPTURE_ID),
    });
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();

    const events = flow.snapshot().events;
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.state).toBe('pending');
      expect(event.pendingReason).toBe(
        'SESSION_CLIP_EXTRACTION_FAILED: No active session capture matches this id.',
      );
    }
    expect(provider.analyzeEvent).not.toHaveBeenCalled();
    // Exactly one native call per closed event — no retries.
    expect(mockBridge.extractSessionEventClip).toHaveBeenCalledTimes(
      events.length,
    );
    const callsAfterSettle =
      mockBridge.extractSessionEventClip.mock.calls.length;
    // Let any hypothetical retry timer fire: the count must not move.
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    await flow.settled();
    expect(mockBridge.extractSessionEventClip).toHaveBeenCalledTimes(
      callsAfterSettle,
    );
    expect(flow.snapshot().events.every(e => e.state === 'pending')).toBe(true);
  });

  it('a rejection that arrives AFTER end() (stop raced the in-flight extractions) lands every event as pending, never a fake outcome', async () => {
    const rejecters: Array<(error: Error) => void> = [];
    mockBridge.extractSessionEventClip.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejecters.push(reject);
        }),
    );
    const provider: SessionEventAnalysisProvider = {
      providerId: 'attack-race',
      availability: () => ({ status: 'available' }),
      analyzeEvent: jest.fn(),
    };
    const flow = new LiveSessionFlow({
      sessionId: 'attack-race-stop',
      source: 'live',
      provider,
      clipSource: createNativeSessionEventClipSource(CAPTURE_ID),
    });
    for (const sample of samples) flow.pushSample(sample);
    const snapshotAtEnd = flow.end();
    expect(snapshotAtEnd.phase).toBe('ended');
    // Every closed event is mid-flight in the native extraction.
    expect(snapshotAtEnd.events.length).toBeGreaterThan(0);
    expect(
      snapshotAtEnd.events.every(event => event.state === 'processing'),
    ).toBe(true);
    expect(rejecters).toHaveLength(snapshotAtEnd.events.length);

    // Native side: the user stopped, stopSessionCapture resolved and the
    // coordinator is gone; THEN the queued extractions fail.
    mockBridge.stopSessionCapture.mockResolvedValue(undefined);
    await stopSessionCapture(CAPTURE_ID);
    for (const reject of rejecters) reject(sessionNotFoundError());
    await flow.settled();

    const events = flow.snapshot().events;
    expect(events).toHaveLength(snapshotAtEnd.events.length);
    for (const event of events) {
      expect(event.state).toBe('pending');
      expect(event.pendingReason).toBe(
        'SESSION_CLIP_EXTRACTION_FAILED: No active session capture matches this id.',
      );
    }
    expect(provider.analyzeEvent).not.toHaveBeenCalled();
    expect(mockBridge.extractSessionEventClip).toHaveBeenCalledTimes(
      events.length,
    );
  });

  it('non-Error rejections (plain string / object) still map to an explicit pending reason, never a throw or fake result', async () => {
    const provider: SessionEventAnalysisProvider = {
      providerId: 'attack-non-error',
      availability: () => ({ status: 'available' }),
      analyzeEvent: jest.fn(),
    };
    for (const rejection of [
      'camera.session_not_found',
      { code: 'camera.session_not_found' },
      undefined,
      0,
    ]) {
      mockBridge.extractSessionEventClip.mockReset();
      mockBridge.extractSessionEventClip.mockImplementation(async () => {
        throw rejection;
      });
      const flow = new LiveSessionFlow({
        sessionId: `attack-non-error-${typeof rejection}`,
        source: 'live',
        provider,
        clipSource: createNativeSessionEventClipSource(CAPTURE_ID),
      });
      for (const sample of samples) flow.pushSample(sample);
      flow.end();
      await flow.settled();
      const events = flow.snapshot().events;
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.state).toBe('pending');
        expect(event.pendingReason).toMatch(
          /^SESSION_CLIP_EXTRACTION_FAILED: /,
        );
      }
    }
    expect(provider.analyzeEvent).not.toHaveBeenCalled();
  });

  it('rapid repeat: 25 back-to-back flows against a dead session never leak a call beyond one per event', async () => {
    mockBridge.extractSessionEventClip.mockImplementation(async () => {
      throw sessionNotFoundError();
    });
    let totalEvents = 0;
    for (let round = 0; round < 25; round += 1) {
      const flow = new LiveSessionFlow({
        sessionId: `attack-rapid-${round}`,
        source: 'live',
        provider: {
          providerId: 'attack-rapid',
          availability: () => ({ status: 'available' }),
          analyzeEvent: jest.fn(),
        },
        clipSource: createNativeSessionEventClipSource(CAPTURE_ID),
      });
      for (const sample of samples) flow.pushSample(sample);
      flow.end();
      await flow.settled();
      totalEvents += flow.snapshot().events.length;
    }
    expect(totalEvents).toBeGreaterThan(0);
    expect(mockBridge.extractSessionEventClip).toHaveBeenCalledTimes(
      totalEvents,
    );
  });
});
