/**
 * INT-native-bridge-contract adversary — session-capture surface.
 *
 * Attacks the TS side of the Swift session bridge (`startSessionCapture`,
 * `stopSessionCapture`, `extractSessionEventClip`, the `session_motion_sample`
 * event feed, the per-event clip source) against a SIMULATED native module.
 * Every expectation below encodes the contract the TS layer should uphold at
 * the seam: a failing test is a confirmed TS-side break; a passing test is
 * evidence the seam holds. Nothing here proves Swift/Vision runtime behaviour
 * (that needs `scripts/mac-full-verify.sh --remote`).
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
      extractSessionEventClip: jest.Mock;
    };
    __simulatedListeners: Array<(event: object) => void>;
  };

import {
  extractSessionEventClip,
  sessionCaptureAvailable,
  startSessionCapture,
  stopSessionCapture,
  type SessionEventClipBounds,
} from '../../src/camera/capture';
import {
  LiveSessionFlow,
  createPendingStubAnalysisProvider,
  type SessionEventAnalysisProvider,
  type SessionEventAnalysisRequest,
  type SessionMotionSample,
} from '../../src/flow/session';
import {
  connectNativeSessionMotionFeed,
  createNativeSessionEventClipSource,
} from '../../src/flow/sessionNative';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { SESSION_ENGINE_VERSION } from '@pickle/analysis-pipeline';
import fixture from '../fixtures/sessionReplay.afn-sasebo-rally1.json';

const samples: SessionMotionSample[] = fixture.wristSamples;
const CAPTURE_ID = 'session-capture-adv-1';

function emitNative(event: object): void {
  for (const listener of [...mockListeners]) listener(event);
}

function motionEvent(sample: SessionMotionSample, captureId = CAPTURE_ID) {
  return {
    type: 'session_motion_sample',
    tMs: sample.tMs,
    v: sample.v,
    captureId,
    emittedAtIso: '2026-09-08T10:00:00.000Z',
  };
}

/** Automatic-capture payload shaped like the Swift session extractor
 * (`SessionCaptureCoordinator.extract` → `ClipMediaStore.exportStrokeWindow`)
 * for the requested proposal window. Values are contract-shape placeholders. */
function sessionClipPayload(bounds: {
  startMs: number;
  endMs: number;
  peakMs: number | null;
  confidence: number;
  detectionModelVersion: string;
}): Record<string, unknown> {
  const preRollMs = 2000;
  const postRollMs = 1500;
  const eventLength = bounds.endMs - bounds.startMs;
  const durationMs = preRollMs + eventLength + postRollMs;
  return {
    uri: 'file:///private/var/mobile/Containers/Data/Application/APP/Documents/captures/session-adv.mov',
    durationMs,
    fps: 30,
    width: 1080,
    height: 1920,
    capturedAtIso: '2026-09-08T10:00:05.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: preRollMs,
      endMs: preRollMs + eventLength,
      ...(bounds.peakMs === null
        ? {}
        : { peakMotionMs: preRollMs + (bounds.peakMs - bounds.startMs) }),
      confidence: bounds.confidence,
      source: 'temporal_pose_motion',
      modelVersion: bounds.detectionModelVersion,
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: bounds.detectionModelVersion,
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 7,
      poseFrameCount: 6,
      poseMissingFrameCount: 1,
      trackedDurationMs: Math.min(200, eventLength),
      meanCanonicalJointVisibility: 0.88,
      meanJointCoverage: 0.94,
      minimumJointCoverage: 0.83,
      fullBodyVisibleFrameCount: 4,
      jointMotion: [
        {
          joint: 'left_wrist',
          sampleCount: 5,
          meanNormalizedPerSecond: 1.1,
          peakNormalizedPerSecond: 2.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs,
    postRollMs,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/var/mobile/Containers/Data/Application/APP/Documents/captures/session-adv.pose.json',
      frameCount: 6,
      sha256: 'b'.repeat(64),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

function sessionProposalEvent(bounds: {
  startMs: number;
  endMs: number;
  peakMs: number;
  confidence: number;
}) {
  return {
    eventId: 'E-adv',
    proposal: {
      eventId: 'E-adv',
      startMs: bounds.startMs,
      peakMs: bounds.peakMs,
      endMs: bounds.endMs,
      peakSpeed: 1.4,
      prominence: 3.1,
      source: 'wrist',
      confidence: bounds.confidence,
      paddleConfirmed: false,
      paddlePeakMs: null,
      paddleSupport: 0,
    },
    closeReason: 'settle',
    closedAtMs: bounds.endMs + 600,
    state: 'pending',
  } as never;
}

beforeEach(() => {
  mockBridge.startSessionCapture.mockReset();
  mockBridge.stopSessionCapture.mockReset();
  mockBridge.extractSessionEventClip.mockReset();
  mockListeners.splice(0, mockListeners.length);
  stabilitySlo.reset();
});

describe('ATTACK A1 — session extraction request pre-validation at the TS seam', () => {
  it('never forwards a semantically invalid extraction request to native', async () => {
    mockBridge.extractSessionEventClip.mockResolvedValue({});
    const attacks: Array<[string, SessionEventClipBounds]> = [
      [
        'NaN startMs',
        {
          startMs: Number.NaN,
          endMs: 1500,
          peakMs: null,
          confidence: 0.6,
          detectionModelVersion: SESSION_ENGINE_VERSION,
        },
      ],
      [
        'reversed bounds',
        {
          startMs: 1500,
          endMs: 700,
          peakMs: null,
          confidence: 0.6,
          detectionModelVersion: SESSION_ENGINE_VERSION,
        },
      ],
      [
        'zero-length window',
        {
          startMs: 700,
          endMs: 700,
          peakMs: null,
          confidence: 0.6,
          detectionModelVersion: SESSION_ENGINE_VERSION,
        },
      ],
      [
        'negative startMs',
        {
          startMs: -10,
          endMs: 700,
          peakMs: null,
          confidence: 0.6,
          detectionModelVersion: SESSION_ENGINE_VERSION,
        },
      ],
      [
        'peak outside window',
        {
          startMs: 700,
          endMs: 1500,
          peakMs: 2600,
          confidence: 0.6,
          detectionModelVersion: SESSION_ENGINE_VERSION,
        },
      ],
      [
        'confidence above 1',
        {
          startMs: 700,
          endMs: 1500,
          peakMs: 1100,
          confidence: 1.7,
          detectionModelVersion: SESSION_ENGINE_VERSION,
        },
      ],
      [
        'infinite endMs',
        {
          startMs: 700,
          endMs: Number.POSITIVE_INFINITY,
          peakMs: 1100,
          confidence: 0.6,
          detectionModelVersion: SESSION_ENGINE_VERSION,
        },
      ],
      [
        'empty detectionModelVersion',
        {
          startMs: 700,
          endMs: 1500,
          peakMs: 1100,
          confidence: 0.6,
          detectionModelVersion: '',
        },
      ],
    ];
    const forwardedToNative: string[] = [];
    for (const [label, bounds] of attacks) {
      mockBridge.extractSessionEventClip.mockClear();
      await extractSessionEventClip(CAPTURE_ID, bounds).catch(() => undefined);
      if (mockBridge.extractSessionEventClip.mock.calls.length > 0) {
        forwardedToNative.push(label);
      }
    }
    expect(forwardedToNative).toEqual([]);
  });
});

describe('ATTACK A2 — session receipt id strictness', () => {
  it('rejects a whitespace-only, control-character or oversized native session id', async () => {
    const accepted: string[] = [];
    const ids: Array<[string, string]> = [
      ['whitespace only', '   '],
      ['embedded newline', 'session\n42'],
      ['NUL byte', 'session\u000042'],
      ['4096 chars', 'x'.repeat(4096)],
    ];
    for (const [label, id] of ids) {
      mockBridge.startSessionCapture.mockResolvedValue({
        sessionCaptureId: id,
      });
      const receipt = await startSessionCapture().catch(() => null);
      if (receipt !== null) accepted.push(label);
    }
    expect(accepted).toEqual([]);
  });

  it('records an invalid-receipt SLO event and never a success for a numeric id', async () => {
    mockBridge.startSessionCapture.mockResolvedValue({ sessionCaptureId: 42 });
    await expect(startSessionCapture()).rejects.toThrow(
      /invalid session receipt/,
    );
    const kinds = stabilitySlo
      .events()
      .map(event =>
        event.kind === 'camera_startup_failed'
          ? `${event.kind}:${event.reason}`
          : event.kind,
      );
    expect(kinds).toEqual(['camera_startup_failed:invalid_session_receipt']);
  });
});

describe('ATTACK A3 — stop with an id native could never have issued', () => {
  it('does not forward an empty or control-character session id to native stop', async () => {
    mockBridge.stopSessionCapture.mockResolvedValue(undefined);
    const forwarded: string[] = [];
    for (const [label, id] of [
      ['empty', ''],
      ['whitespace', '  '],
      ['newline', 'abc\ndef'],
    ] as Array<[string, string]>) {
      mockBridge.stopSessionCapture.mockClear();
      await stopSessionCapture(id).catch(() => undefined);
      if (mockBridge.stopSessionCapture.mock.calls.length > 0)
        forwarded.push(label);
    }
    expect(forwarded).toEqual([]);
  });

  it('propagates the native session_not_found rejection code unchanged', async () => {
    const rejection = Object.assign(
      new Error('No active session capture with that identifier.'),
      { code: 'camera.session_not_found' },
    );
    mockBridge.stopSessionCapture.mockRejectedValue(rejection);
    await expect(stopSessionCapture('stale-id')).rejects.toMatchObject({
      code: 'camera.session_not_found',
    });
  });
});

describe('ATTACK A4 — extracted clip must describe the window that was requested', () => {
  const proposal = {
    startMs: 4200,
    endMs: 5000,
    peakMs: 4600,
    confidence: 0.7,
  };

  it('holds the event pending when the native trigger window length disagrees with the proposal', async () => {
    const payload = sessionClipPayload({
      ...proposal,
      detectionModelVersion: SESSION_ENGINE_VERSION,
    });
    const trigger = payload.trigger as Record<string, unknown>;
    // Native cut a 300ms trigger for an 800ms proposal.
    trigger.endMs = (trigger.startMs as number) + 300;
    trigger.peakMotionMs = (trigger.startMs as number) + 100;
    mockBridge.extractSessionEventClip.mockResolvedValue(payload);
    const extraction = await createNativeSessionEventClipSource(
      CAPTURE_ID,
    ).extract(sessionProposalEvent(proposal));
    expect(extraction.status).toBe('unavailable');
  });

  it('holds the event pending when the clip claims a different detection model than the engine that proposed it', async () => {
    const payload = sessionClipPayload({
      ...proposal,
      detectionModelVersion: 'temporal-stroke-heuristic-2',
    });
    mockBridge.extractSessionEventClip.mockResolvedValue(payload);
    const extraction = await createNativeSessionEventClipSource(
      CAPTURE_ID,
    ).extract(sessionProposalEvent(proposal));
    expect(extraction.status).toBe('unavailable');
  });

  it('accepts a clip whose trigger mirrors the proposal exactly (control)', async () => {
    mockBridge.extractSessionEventClip.mockResolvedValue(
      sessionClipPayload({
        ...proposal,
        detectionModelVersion: SESSION_ENGINE_VERSION,
      }),
    );
    const extraction = await createNativeSessionEventClipSource(
      CAPTURE_ID,
    ).extract(sessionProposalEvent(proposal));
    expect(extraction.status).toBe('extracted');
  });
});

describe('ATTACK A5 — motion feed under hostile payload shapes', () => {
  it('drops coerced-looking numerics, negative time, and sub-shaped payloads without feeding the engine', () => {
    const pushed: SessionMotionSample[] = [];
    const flow = new LiveSessionFlow({
      sessionId: 'adv-feed-1',
      source: 'live',
      provider: createPendingStubAnalysisProvider(),
    });
    const originalPush = flow.pushSample.bind(flow);
    flow.pushSample = sample => {
      pushed.push(sample);
      return originalPush(sample);
    };
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    const hostile: object[] = [
      {
        type: 'session_motion_sample',
        tMs: '10',
        v: 0.2,
        captureId: CAPTURE_ID,
      },
      {
        type: 'session_motion_sample',
        tMs: 10,
        v: '0.2',
        captureId: CAPTURE_ID,
      },
      { type: 'session_motion_sample', tMs: -1, v: 0.2, captureId: CAPTURE_ID },
      {
        type: 'session_motion_sample',
        tMs: 10,
        v: -0.2,
        captureId: CAPTURE_ID,
      },
      {
        type: 'session_motion_sample',
        tMs: Number.POSITIVE_INFINITY,
        v: 0.2,
        captureId: CAPTURE_ID,
      },
      { type: 'session_motion_sample', tMs: 10, v: 0.2, captureId: 7 },
      { type: 'session_motion_sample', tMs: 10, v: 0.2, emittedAtIso: 5 },
      { type: 'session_motion_sample', v: 0.2, captureId: CAPTURE_ID },
      { type: 'session_motion_sample', tMs: 10, captureId: CAPTURE_ID },
      { type: 'session_motion_sample' },
      { type: 'session_motion_sample', tMs: null, v: null },
      { type: 'session_motion_sample', tMs: [10], v: [0.2] },
      { type: 'session_motion_sample', tMs: { valueOf: () => 10 }, v: 0.2 },
    ];
    for (const event of hostile) emitNative(event);
    expect(pushed).toEqual([]);
    expect(feed.droppedInvalidSamples()).toBe(hostile.length);
    // A valid sample after the storm still flows.
    emitNative(motionEvent({ tMs: 33, v: 0.4 }));
    expect(pushed).toEqual([{ tMs: 33, v: 0.4 }]);
    feed.disconnect();
  });

  it('ignores unrelated native event types and a foreign capture without counting them as invalid', () => {
    const pushed: SessionMotionSample[] = [];
    const flow = new LiveSessionFlow({
      sessionId: 'adv-feed-2',
      source: 'live',
      provider: createPendingStubAnalysisProvider(),
    });
    const originalPush = flow.pushSample.bind(flow);
    flow.pushSample = sample => {
      pushed.push(sample);
      return originalPush(sample);
    };
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    emitNative({ type: 'permission', state: 'denied' });
    emitNative({ type: 'import', state: 'copying', progress: 0.4 });
    emitNative({ type: 'import_pose_extraction', progress: 0.2 });
    emitNative({ type: 'error', code: 'camera.session_failed' });
    emitNative(motionEvent({ tMs: 20, v: 0.4 }, 'foreign-capture'));
    emitNative(null as unknown as object);
    emitNative('session_motion_sample' as unknown as object);
    expect(pushed).toEqual([]);
    expect(feed.droppedInvalidSamples()).toBe(0);
    feed.disconnect();
  });
});

describe('ATTACK A6 — event ordering around stop', () => {
  it('drops queued native samples that land after the flow ended, without throwing or double-disconnecting', async () => {
    const flow = new LiveSessionFlow({
      sessionId: 'adv-order-1',
      source: 'live',
      provider: createPendingStubAnalysisProvider(),
    });
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    for (const sample of samples.slice(0, 40)) emitNative(motionEvent(sample));
    const before = flow.snapshot();
    mockBridge.stopSessionCapture.mockResolvedValue(undefined);
    await stopSessionCapture(CAPTURE_ID);
    flow.end();
    await flow.settled();
    const listenersAfterEnd = mockListeners.length;
    // Late emissions still in the bridge queue.
    expect(() => {
      for (const sample of samples.slice(40, 60))
        emitNative(motionEvent(sample));
    }).not.toThrow();
    const after = flow.snapshot();
    expect(after.phase).toBe('ended');
    expect(after.events.length).toBeGreaterThanOrEqual(before.events.length);
    expect(feed.droppedInvalidSamples()).toBe(0);
    // Feed auto-detached on the first post-end sample and disconnect() is idempotent.
    expect(mockListeners.length).toBeLessThan(listenersAfterEnd);
    expect(() => feed.disconnect()).not.toThrow();
    expect(() => feed.disconnect()).not.toThrow();
    expect(mockListeners).toHaveLength(0);
  });

  it('an out-of-order (behind-frontier) native sample never resurrects or rewrites a closed event', async () => {
    const requests: SessionEventAnalysisRequest[] = [];
    const provider: SessionEventAnalysisProvider = {
      providerId: 'adv-order-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async request => {
        requests.push(request);
        return { status: 'pending', pendingReason: 'TEST_HOLD' };
      },
    };
    const flow = new LiveSessionFlow({
      sessionId: 'adv-order-2',
      source: 'live',
      provider,
    });
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    for (const sample of samples) emitNative(motionEvent(sample));
    const closedBefore = flow.snapshot().events.map(event => event.eventId);
    expect(closedBefore.length).toBeGreaterThan(0);
    // Replay the very first samples again (stale, behind the frontier).
    for (const sample of samples.slice(0, 20)) emitNative(motionEvent(sample));
    const closedAfter = flow.snapshot().events.map(event => event.eventId);
    expect(closedAfter).toEqual(closedBefore);
    flow.end();
    await flow.settled();
    expect(flow.snapshot().events.map(event => event.eventId)).toEqual(
      fixture.expectedEmissions.map(
        (emission: { eventId: string }) => emission.eventId,
      ),
    );
    feed.disconnect();
  });
});

describe('ATTACK A7 — double start / session_busy propagation', () => {
  it('surfaces the native busy code verbatim and keeps the first session intact', async () => {
    mockBridge.startSessionCapture
      .mockResolvedValueOnce({ sessionCaptureId: 'first-session' })
      .mockRejectedValueOnce(
        Object.assign(new Error('A session capture is already running.'), {
          code: 'camera.session_busy',
        }),
      );
    const first = await startSessionCapture();
    expect(first).toEqual({ sessionCaptureId: 'first-session' });
    await expect(startSessionCapture()).rejects.toMatchObject({
      code: 'camera.session_busy',
    });
    expect(sessionCaptureAvailable()).toBe(true);
    const kinds = stabilitySlo
      .events()
      .map(event =>
        event.kind === 'camera_startup_failed'
          ? `${event.kind}:${event.reason}`
          : event.kind,
      );
    expect(kinds).toEqual([
      'camera_startup_succeeded',
      'camera_startup_failed:native_session_start_error',
    ]);
  });

  it('two concurrent starts that native both accept yield two distinct receipts (TS does not merge them)', async () => {
    mockBridge.startSessionCapture
      .mockResolvedValueOnce({ sessionCaptureId: 'a' })
      .mockResolvedValueOnce({ sessionCaptureId: 'b' });
    const [a, b] = await Promise.all([
      startSessionCapture(),
      startSessionCapture(),
    ]);
    expect(a.sessionCaptureId).not.toBe(b.sessionCaptureId);
    expect(mockBridge.startSessionCapture).toHaveBeenCalledTimes(2);
  });
});

describe('ATTACK A8 — permission denial and start failure propagation', () => {
  it('re-throws the native permission rejection with its code and records the SLO reason once', async () => {
    mockBridge.startSessionCapture.mockRejectedValue(
      Object.assign(new Error('Camera access was denied.'), {
        code: 'camera.permission_denied',
      }),
    );
    await expect(startSessionCapture()).rejects.toMatchObject({
      code: 'camera.permission_denied',
      message: 'Camera access was denied.',
    });
    expect(
      stabilitySlo
        .events()
        .filter(event => event.kind === 'camera_startup_failed'),
    ).toHaveLength(1);
    expect(
      stabilitySlo
        .events()
        .filter(event => event.kind === 'camera_startup_succeeded'),
    ).toHaveLength(0);
  });

  it('does not wrap a non-Error native rejection into a fake success', async () => {
    mockBridge.startSessionCapture.mockRejectedValue(
      'camera.session_start_failed',
    );
    await expect(startSessionCapture()).rejects.toBe(
      'camera.session_start_failed',
    );
  });

  it('a partial bridge (missing stop) reports unavailable AND start refuses to run', async () => {
    const native = jest.requireMock('react-native') as {
      NativeModules: { PickleVideoCapture: Record<string, unknown> };
    };
    const saved = native.NativeModules.PickleVideoCapture.stopSessionCapture;
    delete native.NativeModules.PickleVideoCapture.stopSessionCapture;
    try {
      expect(sessionCaptureAvailable()).toBe(false);
      mockBridge.startSessionCapture.mockResolvedValue({
        sessionCaptureId: 'orphan',
      });
      await expect(startSessionCapture()).rejects.toThrow();
      expect(mockBridge.startSessionCapture).not.toHaveBeenCalled();
    } finally {
      native.NativeModules.PickleVideoCapture.stopSessionCapture = saved;
    }
  });
});

describe('ATTACK A9 — extraction receipt with Swift-optional fields absent or null', () => {
  it('rejects null where Swift omits optional keys (posterUri/byteSize/peakMotionMs) instead of treating null as absent', async () => {
    const bounds = {
      startMs: 700,
      endMs: 1500,
      peakMs: 1100,
      confidence: 0.6,
      detectionModelVersion: SESSION_ENGINE_VERSION,
    };
    const accepted: string[] = [];
    for (const [label, mutate] of [
      ['posterUri: null', (p: Record<string, unknown>) => (p.posterUri = null)],
      ['byteSize: null', (p: Record<string, unknown>) => (p.byteSize = null)],
      [
        'poseSequence: null',
        (p: Record<string, unknown>) => (p.poseSequence = null),
      ],
      [
        'trigger.peakMotionMs: null',
        (p: Record<string, unknown>) =>
          ((p.trigger as Record<string, unknown>).peakMotionMs = null),
      ],
      [
        'nativeMediaIdentity: null',
        (p: Record<string, unknown>) => (p.nativeMediaIdentity = null),
      ],
      [
        'completion: null',
        (p: Record<string, unknown>) => (p.completion = null),
      ],
    ] as Array<[string, (p: Record<string, unknown>) => unknown]>) {
      const payload = sessionClipPayload(bounds);
      mutate(payload);
      mockBridge.extractSessionEventClip.mockResolvedValue(payload);
      const clip = await extractSessionEventClip(CAPTURE_ID, bounds).catch(
        () => null,
      );
      if (clip !== null) accepted.push(label);
    }
    expect(accepted).toEqual([]);
  });

  it('accepts the Swift-shaped payload with every optional key omitted (control)', async () => {
    const bounds = {
      startMs: 700,
      endMs: 1500,
      peakMs: null,
      confidence: 0.6,
      detectionModelVersion: SESSION_ENGINE_VERSION,
    };
    const payload = sessionClipPayload(bounds);
    delete payload.poseSequence;
    mockBridge.extractSessionEventClip.mockResolvedValue(payload);
    const clip = await extractSessionEventClip(CAPTURE_ID, bounds);
    expect(clip.captureMode).toBe('automatic_pose_trigger');
    expect(clip.poseSequence).toBeUndefined();
    expect(mockBridge.extractSessionEventClip).toHaveBeenCalledWith({
      sessionCaptureId: CAPTURE_ID,
      startMs: 700,
      endMs: 1500,
      peakMs: null,
      confidence: 0.6,
      detectionModelVersion: SESSION_ENGINE_VERSION,
    });
  });
});
