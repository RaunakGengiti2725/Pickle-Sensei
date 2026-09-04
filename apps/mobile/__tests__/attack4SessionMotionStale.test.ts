/**
 * ADVERSARIAL PASS 3 / tester #4 — S5: stale `session_motion_sample`
 * emissions from a PREVIOUS session capture arriving after
 * stopSessionCapture(), while a NEW session capture is live on the same
 * PickleCameraEvent channel. Simulated native module + emitter (never the
 * real bridge). Every `it` pins what 4d812e1a actually does.
 *
 * Seeded randomness: the interleaving test uses a fixed LCG seed (0xA4A4)
 * so the shuffle is reproducible.
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
    __simulatedBridge: bridge,
    __simulatedListeners: listeners,
  };
});

const { __simulatedBridge: mockBridge, __simulatedListeners: mockListeners } =
  jest.requireMock('react-native') as {
    __simulatedBridge: {
      startSessionCapture: jest.Mock;
      stopSessionCapture: jest.Mock;
    };
    __simulatedListeners: Array<(event: object) => void>;
  };

jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
}));

import { startSessionCapture, stopSessionCapture } from '../src/camera/capture';
import {
  LiveSessionFlow,
  createPendingStubAnalysisProvider,
  type SessionMotionSample,
} from '../src/flow/session';
import { connectNativeSessionMotionFeed } from '../src/flow/sessionNative';

const CAPTURE_A = 'session-capture-aaaa';
const CAPTURE_B = 'session-capture-bbbb';

function emitNative(event: object): void {
  for (const listener of [...mockListeners]) listener(event);
}

function motionEvent(sample: SessionMotionSample, captureId?: string) {
  return {
    type: 'session_motion_sample',
    tMs: sample.tMs,
    v: sample.v,
    ...(captureId !== undefined ? { captureId } : {}),
    emittedAtIso: '2026-09-04T12:00:00.000Z',
  };
}

function spiedFlow(sessionId: string) {
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

/** Deterministic LCG so the interleaving is reproducible (seed recorded). */
function seededShuffle<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

beforeEach(() => {
  mockListeners.length = 0;
  mockBridge.startSessionCapture.mockReset();
  mockBridge.stopSessionCapture.mockReset();
});

describe('S5 — stale-capture motion samples after stopSessionCapture', () => {
  it('[HELD isolation / BROKEN-P3 telemetry] every sample stamped with the PREVIOUS sessionCaptureId is dropped from the new session, but droppedInvalidSamples does NOT advance for them (silent drop, no counter)', async () => {
    mockBridge.startSessionCapture
      .mockResolvedValueOnce({ sessionCaptureId: CAPTURE_A })
      .mockResolvedValueOnce({ sessionCaptureId: CAPTURE_B });
    mockBridge.stopSessionCapture.mockResolvedValue(undefined);

    // Session A: real bridge start → feed → some samples → stop.
    const receiptA = await startSessionCapture();
    expect(receiptA.sessionCaptureId).toBe(CAPTURE_A);
    const a = spiedFlow('live-a');
    const feedA = connectNativeSessionMotionFeed(a.flow, {
      sessionCaptureId: CAPTURE_A,
    });
    emitNative(motionEvent({ tMs: 0, v: 0.1 }, CAPTURE_A));
    emitNative(motionEvent({ tMs: 16, v: 0.2 }, CAPTURE_A));
    expect(a.pushed).toHaveLength(2);
    a.flow.end();
    feedA.disconnect();
    await stopSessionCapture(CAPTURE_A);
    expect(mockBridge.stopSessionCapture).toHaveBeenCalledWith(CAPTURE_A);

    // Session B starts on the same channel.
    const receiptB = await startSessionCapture();
    expect(receiptB.sessionCaptureId).toBe(CAPTURE_B);
    const b = spiedFlow('live-b');
    const feedB = connectNativeSessionMotionFeed(b.flow, {
      sessionCaptureId: CAPTURE_B,
    });

    // Queued emissions from A drain AFTER B is live.
    const stale = Array.from({ length: 50 }, (_, i) =>
      motionEvent({ tMs: 1000 + i * 16, v: 0.9 }, CAPTURE_A),
    );
    for (const event of stale) emitNative(event);
    expect(b.pushed).toHaveLength(0);
    expect(a.pushed).toHaveLength(2); // A's flow (ended) got nothing either.

    // OBSERVED on 4d812e1a: foreign-capture drops are not counted.
    expect(feedB.droppedInvalidSamples()).toBe(0);

    emitNative(motionEvent({ tMs: 0, v: 0.3 }, CAPTURE_B));
    expect(b.pushed).toEqual([{ tMs: 0, v: 0.3 }]);
    feedB.disconnect();
    b.flow.end();
  });

  it('[HELD] seed 0xA4A4: 1000 stale + 1000 live samples interleaved → exactly the 1000 live ones reach the engine, in emission order', () => {
    const b = spiedFlow('live-b-interleaved');
    const feedB = connectNativeSessionMotionFeed(b.flow, {
      sessionCaptureId: CAPTURE_B,
    });
    const live = Array.from({ length: 1000 }, (_, i) => ({
      tMs: i * 16,
      v: (i % 7) / 10,
    }));
    const events = seededShuffle(
      [
        ...live.map(sample => motionEvent(sample, CAPTURE_B)),
        ...Array.from({ length: 1000 }, (_, i) =>
          motionEvent({ tMs: i * 16, v: 0.99 }, CAPTURE_A),
        ),
      ],
      0xa4a4,
    );
    for (const event of events) emitNative(event);
    const liveInEmissionOrder = events
      .filter(event => event.captureId === CAPTURE_B)
      .map(event => ({ tMs: event.tMs, v: event.v }));
    expect(b.pushed).toEqual(liveInEmissionOrder);
    expect(b.pushed).toHaveLength(1000);
    expect(feedB.droppedInvalidSamples()).toBe(0);
    feedB.disconnect();
    b.flow.end();
  });

  it('[HELD] queued emissions with the SAME captureId arriving after the flow ended auto-disconnect the feed without throwing and never reach pushSample', () => {
    const a = spiedFlow('live-a-ended');
    const feedA = connectNativeSessionMotionFeed(a.flow, {
      sessionCaptureId: CAPTURE_A,
    });
    emitNative(motionEvent({ tMs: 0, v: 0.1 }, CAPTURE_A));
    a.flow.end();
    expect(a.flow.ended()).toBe(true);
    const listenersBefore = mockListeners.length;
    expect(() => {
      for (let i = 0; i < 20; i += 1) {
        emitNative(motionEvent({ tMs: 100 + i, v: 0.5 }, CAPTURE_A));
      }
    }).not.toThrow();
    expect(a.pushed).toHaveLength(1);
    // The listener removed itself on the first post-end sample.
    expect(mockListeners.length).toBe(listenersBefore - 1);
    expect(feedA.droppedInvalidSamples()).toBe(0);
    feedA.disconnect();
  });

  it('[OBSERVED] a stale sample WITHOUT a captureId stamp is accepted by a filtered feed (the filter only rejects a DIFFERENT stamp)', () => {
    const b = spiedFlow('live-b-unstamped');
    const feedB = connectNativeSessionMotionFeed(b.flow, {
      sessionCaptureId: CAPTURE_B,
    });
    emitNative(motionEvent({ tMs: 0, v: 0.2 }));
    expect(b.pushed).toEqual([{ tMs: 0, v: 0.2 }]);
    feedB.disconnect();
    b.flow.end();
  });

  it('[HELD] stale samples with a hostile captureId (unicode, empty string, huge) are dropped and never coerced', () => {
    const b = spiedFlow('live-b-hostile');
    const feedB = connectNativeSessionMotionFeed(b.flow, {
      sessionCaptureId: CAPTURE_B,
    });
    emitNative(motionEvent({ tMs: 0, v: 0.2 }, ''));
    emitNative(motionEvent({ tMs: 1, v: 0.2 }, '🎾'.repeat(5000)));
    emitNative(motionEvent({ tMs: 2, v: 0.2 }, `${CAPTURE_B} `));
    emitNative(motionEvent({ tMs: 3, v: 0.2 }, CAPTURE_B.toUpperCase()));
    emitNative({
      type: 'session_motion_sample',
      tMs: 4,
      v: 0.2,
      captureId: { toString: () => CAPTURE_B },
    });
    emitNative({
      type: 'session_motion_sample',
      tMs: 5,
      v: 0.2,
      captureId: [CAPTURE_B],
    });
    expect(b.pushed).toHaveLength(0);
    // Non-string captureIds are MALFORMED (counted); wrong strings are not.
    expect(feedB.droppedInvalidSamples()).toBe(2);
    feedB.disconnect();
    b.flow.end();
  });

  it('[HELD] disconnect() is idempotent and a re-connected feed on the same flow starts from a clean counter', () => {
    const b = spiedFlow('live-b-reconnect');
    const first = connectNativeSessionMotionFeed(b.flow, {
      sessionCaptureId: CAPTURE_B,
    });
    emitNative({ type: 'session_motion_sample', tMs: -1, v: 1 });
    expect(first.droppedInvalidSamples()).toBe(1);
    first.disconnect();
    first.disconnect();
    expect(mockListeners).toHaveLength(0);
    const second = connectNativeSessionMotionFeed(b.flow, {
      sessionCaptureId: CAPTURE_B,
    });
    expect(second.droppedInvalidSamples()).toBe(0);
    emitNative(motionEvent({ tMs: 0, v: 0.2 }, CAPTURE_B));
    expect(b.pushed).toEqual([{ tMs: 0, v: 0.2 }]);
    second.disconnect();
    b.flow.end();
  });
});
