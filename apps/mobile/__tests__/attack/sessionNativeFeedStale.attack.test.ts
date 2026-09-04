/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario S3.
 * connectNativeSessionMotionFeed() under a hostile emitter: samples from a
 * stale capture interleaved with valid ones, malformed payloads, and native
 * emissions that keep arriving after flow.end(). Expected: exactly one
 * auto-disconnect, stale samples silently ignored (not counted as
 * malformed), and droppedInvalidSamples counting ONLY malformed payloads.
 */
jest.mock('react-native', () => {
  const listeners: Array<(event: object) => void> = [];
  let removals = 0;
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
            removals += 1;
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      }
    },
    __simulatedListeners: listeners,
    __removals: () => removals,
  };
});

const { __simulatedListeners: mockListeners, __removals: removals } =
  jest.requireMock('react-native') as {
    __simulatedListeners: Array<(event: object) => void>;
    __removals: () => number;
  };

import {
  LiveSessionFlow,
  createPendingStubAnalysisProvider,
  type SessionMotionSample,
} from '../../src/flow/session';
import { connectNativeSessionMotionFeed } from '../../src/flow/sessionNative';
import fixture from '../fixtures/sessionReplay.afn-sasebo-rally1.json';

const samples: SessionMotionSample[] = fixture.wristSamples;
const CAPTURE_ID = 'session-capture-42';
const STALE_CAPTURE_ID = 'session-capture-41';

function emitNative(event: object): void {
  for (const listener of [...mockListeners]) listener(event);
}

function motionEvent(sample: SessionMotionSample, captureId = CAPTURE_ID) {
  return {
    type: 'session_motion_sample',
    tMs: sample.tMs,
    v: sample.v,
    captureId,
    emittedAtIso: '2026-08-28T10:00:00.000Z',
  };
}

function instrumentedFlow(sessionId: string) {
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

describe('S3 — stale-capture interleaving and post-end emissions', () => {
  beforeEach(() => {
    mockListeners.splice(0, mockListeners.length);
  });

  it('ignores stale-capture samples silently, counts only malformed payloads, auto-disconnects exactly once after end()', () => {
    const { flow, pushed } = instrumentedFlow('attack-native-1');
    const removalsBefore = removals();
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    expect(mockListeners).toHaveLength(1);

    // Interleave: every third sample is a stale-capture echo of the previous
    // one (tMs regressed as well — must not even reach the flow).
    const valid: SessionMotionSample[] = [];
    let staleCount = 0;
    for (const [i, sample] of samples.slice(0, 60).entries()) {
      emitNative(motionEvent(sample));
      valid.push(sample);
      if (i % 3 === 2) {
        emitNative(
          motionEvent({ tMs: sample.tMs - 5, v: 9 }, STALE_CAPTURE_ID),
        );
        staleCount += 1;
      }
    }
    // Malformed payloads of the session type (counted).
    emitNative({ type: 'session_motion_sample', tMs: 10, v: 'bogus' });
    emitNative({ type: 'session_motion_sample', tMs: -1, v: 1 });
    emitNative({ type: 'session_motion_sample', tMs: 5000, v: -0.1 });
    emitNative({ type: 'session_motion_sample' });
    // Non-session events (ignored, not counted).
    emitNative({ type: 'permission', state: 'denied' });
    emitNative({ type: 'error', message: 'camera interrupted' });
    // A stale-capture MALFORMED payload is malformed first — counted.
    emitNative({
      type: 'session_motion_sample',
      tMs: Number.NaN,
      v: 1,
      captureId: STALE_CAPTURE_ID,
    });

    expect(staleCount).toBeGreaterThan(0);
    expect(pushed).toEqual(valid);
    expect(feed.droppedInvalidSamples()).toBe(5);
    expect(flow.snapshot().droppedLateSamples).toBe(0);

    flow.end();
    expect(flow.ended()).toBe(true);
    expect(mockListeners).toHaveLength(1);

    // A stale-capture sample after end() is still just ignored — no
    // disconnect yet (it never reaches the flow).
    emitNative(motionEvent({ tMs: 9000, v: 1 }, STALE_CAPTURE_ID));
    expect(mockListeners).toHaveLength(1);
    expect(removals()).toBe(removalsBefore);

    // First valid post-end emission: auto-disconnect, no throw, not counted.
    emitNative(motionEvent({ tMs: 9001, v: 1 }));
    expect(mockListeners).toHaveLength(0);
    expect(removals()).toBe(removalsBefore + 1);
    expect(feed.droppedInvalidSamples()).toBe(5);
    expect(pushed).toEqual(valid);

    // Further emissions (valid, malformed, stale) reach nothing.
    emitNative(motionEvent({ tMs: 9002, v: 1 }));
    emitNative({ type: 'session_motion_sample', tMs: 10, v: 'bogus' });
    emitNative(motionEvent({ tMs: 9003, v: 1 }, STALE_CAPTURE_ID));
    expect(feed.droppedInvalidSamples()).toBe(5);
    expect(pushed).toEqual(valid);
    expect(removals()).toBe(removalsBefore + 1);

    // Explicit disconnect after the auto-disconnect is idempotent-safe.
    feed.disconnect();
    expect(mockListeners).toHaveLength(0);
  });

  it('a queued burst of 500 post-end emissions triggers exactly one disconnect and zero pushes', () => {
    const { flow, pushed } = instrumentedFlow('attack-native-2');
    const removalsBefore = removals();
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    for (const sample of samples) emitNative(motionEvent(sample));
    const fedCount = pushed.length;
    flow.end();
    for (let i = 0; i < 500; i += 1) {
      emitNative(motionEvent({ tMs: 4000 + i, v: 0.5 }));
    }
    expect(pushed).toHaveLength(fedCount);
    expect(removals()).toBe(removalsBefore + 1);
    expect(feed.droppedInvalidSamples()).toBe(0);
    expect(mockListeners).toHaveLength(0);
  });

  it('without a sessionCaptureId every capture is accepted (documented), so callers must pass one', () => {
    const { flow, pushed } = instrumentedFlow('attack-native-3');
    const feed = connectNativeSessionMotionFeed(flow);
    emitNative(motionEvent({ tMs: 10, v: 0.1 }, STALE_CAPTURE_ID));
    emitNative(motionEvent({ tMs: 20, v: 0.2 }));
    expect(pushed).toEqual([
      { tMs: 10, v: 0.1 },
      { tMs: 20, v: 0.2 },
    ]);
    expect(feed.droppedInvalidSamples()).toBe(0);
    feed.disconnect();
  });

  it('a stale-capture sample that would be LATE for the engine is ignored before the engine sees it', () => {
    const { flow, pushed } = instrumentedFlow('attack-native-4');
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    for (const sample of samples) {
      emitNative(motionEvent(sample));
      if (flow.snapshot().events.length >= 2) break;
    }
    const before = flow.snapshot();
    expect(before.events).toHaveLength(2);
    emitNative(motionEvent({ tMs: 100, v: 5 }, STALE_CAPTURE_ID));
    const after = flow.snapshot();
    expect(after.droppedLateSamples).toBe(0);
    expect(pushed.at(-1)?.tMs).not.toBe(100);
    expect(after.events.map(e => e.eventId)).toEqual(
      before.events.map(e => e.eventId),
    );
    feed.disconnect();
  });
});
