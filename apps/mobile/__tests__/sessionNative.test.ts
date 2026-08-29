/**
 * Native session plumbing tests (D-040 Gap 1 + Gap 2 closure, TS side) —
 * against a SIMULATED native module + event emitter, never the real bridge:
 *  - the frozen `session_motion_sample` payload is validated at the boundary
 *    (malformed payloads dropped and counted, never coerced);
 *  - streamed samples reach LiveSessionFlow.pushSample and close the same
 *    recorded events the replay path closes (fixture rally, no synthesis);
 *  - per-event clip requests carry the frozen proposal bounds VERBATIM and
 *    the receipt is the validated CapturedClip contract;
 *  - extraction failures leave events honestly 'pending' — no fake results;
 *  - the native analysis provider dispatches declared-null (AUTO) into the
 *    canonical runCaptureAnalysis path.
 */
// Only the names capture.ts imports — spreading the real RN index would pull
// TurboModule getters that jest cannot satisfy. The simulated bridge and its
// listener registry live inside the factory (jest.mock is hoisted above this
// file's own bindings) and are re-exported for the tests to drive.
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

jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
}));

import type { LocalDb } from '../src/data/db';
import {
  extractSessionEventClip,
  sessionCaptureAvailable,
  startSessionCapture,
  type CapturedClip,
} from '../src/camera/capture';
import {
  LiveSessionFlow,
  NATIVE_CLIP_EXTRACTION_NOT_BUILT,
  createPendingStubAnalysisProvider,
  nativeSessionMotionFeedAvailability,
  type SessionEventAnalysisProvider,
  type SessionEventAnalysisRequest,
  type SessionMotionSample,
} from '../src/flow/session';
import {
  connectNativeSessionMotionFeed,
  createNativeSessionAnalysisProvider,
  createNativeSessionEventClipSource,
  isSessionMotionSampleEvent,
} from '../src/flow/sessionNative';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import { savePendingCapture } from '../src/data/repository';
import { SESSION_ENGINE_VERSION } from '@pickle/analysis-pipeline';
import fixture from './fixtures/sessionReplay.afn-sasebo-rally1.json';

const samples: SessionMotionSample[] = fixture.wristSamples;
const CAPTURE_ID = 'session-capture-42';

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

/** A structurally valid automatic-capture payload as the native extractor
 * would return it (values are placeholders for contract-shape testing only —
 * no measurement claims). */
function validClipPayload(): Record<string, unknown> {
  return {
    uri: 'file:///private/var/mobile/session-clip-E1.mov',
    durationMs: 2100,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-08-28T10:00:05.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 767,
      endMs: 1567,
      peakMotionMs: 1100,
      confidence: 0.8,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 7,
      poseFrameCount: 6,
      poseMissingFrameCount: 1,
      trackedDurationMs: 620,
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
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/var/mobile/session-clip-E1.pose.json',
      frameCount: 6,
      sha256: 'a'.repeat(64),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

beforeEach(() => {
  mockListeners.length = 0;
  mockBridge.startSessionCapture.mockReset();
  mockBridge.stopSessionCapture.mockReset();
  mockBridge.extractSessionEventClip.mockReset();
  (runCaptureAnalysis as jest.Mock).mockReset();
  (savePendingCapture as jest.Mock).mockClear();
});

describe('session capture bridge surface', () => {
  it('reports the full session surface as available', () => {
    expect(sessionCaptureAvailable()).toBe(true);
    expect(nativeSessionMotionFeedAvailability()).toEqual({
      available: true,
      mode: 'native',
    });
  });

  it('rejects an invalid native session receipt', async () => {
    mockBridge.startSessionCapture.mockResolvedValue({ nope: true });
    await expect(startSessionCapture()).rejects.toThrow(
      /invalid session receipt/i,
    );
  });

  it('returns a validated receipt and forwards exact extraction bounds', async () => {
    mockBridge.startSessionCapture.mockResolvedValue({
      sessionCaptureId: CAPTURE_ID,
    });
    const receipt = await startSessionCapture();
    expect(receipt.sessionCaptureId).toBe(CAPTURE_ID);

    mockBridge.extractSessionEventClip.mockResolvedValue(validClipPayload());
    const clip = await extractSessionEventClip(CAPTURE_ID, {
      startMs: 767,
      endMs: 1567,
      peakMs: 1100,
      confidence: 0.8,
      detectionModelVersion: SESSION_ENGINE_VERSION,
    });
    expect(mockBridge.extractSessionEventClip).toHaveBeenCalledWith({
      sessionCaptureId: CAPTURE_ID,
      startMs: 767,
      endMs: 1567,
      peakMs: 1100,
      confidence: 0.8,
      detectionModelVersion: SESSION_ENGINE_VERSION,
    });
    expect(clip.captureMode).toBe('automatic_pose_trigger');
  });

  it('rejects an extraction payload that fails clip validation', async () => {
    const broken = validClipPayload();
    delete broken.captureEvidence;
    mockBridge.extractSessionEventClip.mockResolvedValue(broken);
    await expect(
      extractSessionEventClip(CAPTURE_ID, {
        startMs: 767,
        endMs: 1567,
        peakMs: null,
        confidence: 0.8,
        detectionModelVersion: SESSION_ENGINE_VERSION,
      }),
    ).rejects.toThrow(/invalid or incomplete/i);
  });
});

describe('native motion stream consumption', () => {
  it('validates the frozen payload shape', () => {
    expect(
      isSessionMotionSampleEvent({
        type: 'session_motion_sample',
        tMs: 67,
        v: 0.06,
      }),
    ).toBe(true);
    for (const bad of [
      null,
      {},
      { type: 'session_motion_sample', tMs: -1, v: 0.5 },
      { type: 'session_motion_sample', tMs: Number.NaN, v: 0.5 },
      { type: 'session_motion_sample', tMs: 10, v: -0.2 },
      { type: 'session_motion_sample', tMs: 10, v: '0.2' },
      { type: 'session_motion_sample', tMs: 10 },
      { type: 'other', tMs: 10, v: 0.5 },
    ]) {
      expect(isSessionMotionSampleEvent(bad)).toBe(false);
    }
  });

  it('streams the recorded rally into the flow and closes the same events', async () => {
    const requests: SessionEventAnalysisRequest[] = [];
    const provider: SessionEventAnalysisProvider = {
      providerId: 'test-capture-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async request => {
        requests.push(request);
        return { status: 'pending', pendingReason: 'TEST_HOLD' };
      },
    };
    const flow = new LiveSessionFlow({
      sessionId: 'live-native-1',
      source: 'live',
      startedAtIso: '2026-08-28T10:00:00.000Z',
      provider,
    });
    const feed = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
    for (const sample of samples) emitNative(motionEvent(sample));
    flow.end();
    await flow.settled();
    const events = flow.snapshot().events;
    expect(events.map(event => event.eventId)).toEqual(
      fixture.expectedEmissions.map(
        (emission: { eventId: string }) => emission.eventId,
      ),
    );
    expect(requests.every(request => request.declaredStroke === null)).toBe(
      true,
    );
    expect(feed.droppedInvalidSamples()).toBe(0);
    feed.disconnect();
  });

  it('drops malformed and foreign-capture payloads without feeding the engine', () => {
    const pushed: SessionMotionSample[] = [];
    const flow = new LiveSessionFlow({
      sessionId: 'live-native-2',
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
    emitNative({ type: 'session_motion_sample', tMs: 10, v: 'bogus' });
    emitNative({ type: 'session_motion_sample', tMs: Number.NaN, v: 1 });
    emitNative({ type: 'permission', state: 'granted' });
    emitNative(motionEvent({ tMs: 20, v: 0.4 }, 'someone-elses-capture'));
    emitNative(motionEvent({ tMs: 30, v: 0.5 }));
    expect(pushed).toEqual([{ tMs: 30, v: 0.5 }]);
    expect(feed.droppedInvalidSamples()).toBe(2);
    feed.disconnect();
    emitNative(motionEvent({ tMs: 40, v: 0.6 }));
    expect(pushed).toHaveLength(1);
  });
});

describe('per-event clip source', () => {
  it('requests each closed event with its frozen bounds and hands the clip to the provider', async () => {
    mockBridge.extractSessionEventClip.mockImplementation(async () =>
      validClipPayload(),
    );
    const requests: SessionEventAnalysisRequest[] = [];
    const provider: SessionEventAnalysisProvider = {
      providerId: 'test-clip-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async request => {
        requests.push(request);
        return { status: 'pending', pendingReason: 'TEST_HOLD' };
      },
    };
    const flow = new LiveSessionFlow({
      sessionId: 'live-native-3',
      source: 'live',
      provider,
      clipSource: createNativeSessionEventClipSource(CAPTURE_ID),
    });
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    expect(requests.length).toBeGreaterThan(0);
    expect(mockBridge.extractSessionEventClip).toHaveBeenCalledTimes(
      requests.length,
    );
    const calls = mockBridge.extractSessionEventClip.mock.calls;
    for (const [index, request] of requests.entries()) {
      expect(calls[index]![0]).toEqual({
        sessionCaptureId: CAPTURE_ID,
        startMs: request.proposal.startMs,
        endMs: request.proposal.endMs,
        peakMs: request.proposal.peakMs,
        confidence: request.proposal.confidence,
        detectionModelVersion: SESSION_ENGINE_VERSION,
      });
    }
    for (const request of requests) {
      expect(request.clip).not.toBeNull();
      expect(request.poseSequenceSlice).toEqual(
        validClipPayload().poseSequence,
      );
      expect(request.declaredStroke).toBeNull();
    }
  });

  it('leaves events honestly pending when extraction fails', async () => {
    mockBridge.extractSessionEventClip.mockRejectedValue(
      new Error('rolling buffer does not cover the window yet'),
    );
    const provider: SessionEventAnalysisProvider = {
      providerId: 'test-never-called',
      availability: () => ({ status: 'available' }),
      analyzeEvent: jest.fn(),
    };
    const flow = new LiveSessionFlow({
      sessionId: 'live-native-4',
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
      expect(event.pendingReason).toContain('SESSION_CLIP_EXTRACTION_FAILED');
      expect(event.pendingReason).toContain('rolling buffer');
    }
    expect(provider.analyzeEvent).not.toHaveBeenCalled();
  });

  it('reports a clip without a pose sidecar as unavailable, never analyzable', async () => {
    const payload = validClipPayload();
    delete payload.poseSequence;
    mockBridge.extractSessionEventClip.mockResolvedValue(payload);
    const source = createNativeSessionEventClipSource(CAPTURE_ID);
    const extraction = await source.extract({
      eventId: 'E1',
      proposal: {
        eventId: 'E1',
        startMs: 767,
        peakMs: 1100,
        endMs: 1567,
        peakSpeed: 1.4,
        prominence: 3.1,
        source: 'wrist',
        confidence: 0.8,
        paddleConfirmed: false,
        paddlePeakMs: null,
        paddleSupport: 0,
      },
      closeReason: 'settle',
      closedAtMs: 2167,
      state: 'pending',
    } as never);
    expect(extraction.status).toBe('unavailable');
    if (extraction.status === 'unavailable') {
      expect(extraction.pendingReason).toContain(
        'SESSION_CLIP_POSE_SLICE_EMPTY',
      );
    }
  });
});

describe('native session analysis provider', () => {
  const deps = {
    db: { execute: async () => ({ rows: [] }), close() {} } as LocalDb,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
    handedness: 'right' as const,
  };

  function requestWithClip(
    clip: CapturedClip | null,
  ): SessionEventAnalysisRequest {
    return {
      sessionId: 'session-9',
      eventId: 'E1',
      proposal: {
        eventId: 'E1',
        startMs: 767,
        peakMs: 1100,
        endMs: 1567,
        peakSpeed: 1.4,
        prominence: 3.1,
        source: 'wrist',
        confidence: 0.8,
        paddleConfirmed: false,
        paddlePeakMs: null,
        paddleSupport: 0,
      },
      closeReason: 'settle',
      closedAtMs: 2167,
      declaredStroke: null,
      clip,
      poseSequenceSlice: null,
    };
  }

  it('holds a request without a clip honestly pending', async () => {
    const provider = createNativeSessionAnalysisProvider(deps);
    const outcome = await provider.analyzeEvent(requestWithClip(null));
    expect(outcome).toEqual({
      status: 'pending',
      pendingReason: NATIVE_CLIP_EXTRACTION_NOT_BUILT,
    });
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
  });

  it('saves the capture and dispatches declared-null AUTO into the canonical path', async () => {
    const record = { id: 'analysis-1' };
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'scored',
      analysisId: 'analysis-1',
      record,
    });
    const clip = validClipPayload() as unknown as CapturedClip;
    const provider = createNativeSessionAnalysisProvider(deps);
    const outcome = await provider.analyzeEvent(requestWithClip(clip));
    expect(savePendingCapture).toHaveBeenCalledTimes(1);
    const analyzeArgs = (runCaptureAnalysis as jest.Mock).mock.calls[0]![0];
    expect(analyzeArgs.clip).toBe(clip);
    expect(analyzeArgs.declaredStroke).toBeNull();
    expect(analyzeArgs.sessionId).toBe('session-9');
    expect(analyzeArgs.handedness).toBe('right');
    expect(outcome).toEqual({ status: 'ready', analysis: record });
  });

  it('passes a real capture envelope judged from the clip configuration', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'scored',
      analysisId: 'analysis-1',
      record: { id: 'analysis-1' },
    });
    const clip = validClipPayload() as unknown as CapturedClip;
    const provider = createNativeSessionAnalysisProvider(deps);
    await provider.analyzeEvent(requestWithClip(clip));
    const analyzeArgs = (runCaptureAnalysis as jest.Mock).mock.calls[0]![0];
    const envelope = analyzeArgs.captureEnvelope;
    expect(envelope).not.toBeNull();
    // 720x1280 @ 59.94fps — resolution and frame rate judged from config.
    expect(
      envelope.dimensions.find(
        (d: { dimension: string }) => d.dimension === 'resolution',
      ),
    ).toMatchObject({ status: 'SUPPORTED', measured: 720 });
    expect(
      envelope.dimensions.find(
        (d: { dimension: string }) => d.dimension === 'frame_rate',
      ),
    ).toMatchObject({ status: 'SUPPORTED' });
  });

  it('holds an unsupported-quality session clip honestly pending — never rated', async () => {
    (runCaptureAnalysis as jest.Mock).mockImplementation(
      async (args: { captureEnvelope: { overall: string } | null }) => {
        // Mirror the real gate: UNSUPPORTED envelopes are blocked before
        // inference by runCaptureAnalysis itself.
        if (args.captureEnvelope?.overall === 'UNSUPPORTED') {
          return {
            kind: 'quality_blocked',
            reason: 'capture quality outside the supported envelope',
            envelope: args.captureEnvelope,
          };
        }
        throw new Error('expected the UNSUPPORTED envelope to be passed');
      },
    );
    const payload = validClipPayload();
    payload.width = 320;
    payload.height = 240;
    const clip = payload as unknown as CapturedClip;
    const provider = createNativeSessionAnalysisProvider(deps);
    const outcome = await provider.analyzeEvent(requestWithClip(clip));
    expect(outcome).toEqual({
      status: 'pending',
      pendingReason: 'capture quality outside the supported envelope',
    });
  });

  it('maps an unavailable analysis outcome to an honest pending state', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'unavailable',
      reason: 'POSE_SIDECAR_HASH_MISMATCH',
    });
    const clip = validClipPayload() as unknown as CapturedClip;
    const provider = createNativeSessionAnalysisProvider(deps);
    const outcome = await provider.analyzeEvent(requestWithClip(clip));
    expect(outcome).toEqual({
      status: 'pending',
      pendingReason: 'POSE_SIDECAR_HASH_MISMATCH',
    });
  });
});
