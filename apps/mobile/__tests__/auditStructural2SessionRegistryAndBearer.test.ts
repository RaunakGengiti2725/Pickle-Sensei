/**
 * STRUCTURAL AUDIT #2 (mobile-analyze-capture) — live-session plumbing:
 *  - the module-level completed-session registry (session.ts) has no
 *    eviction and no owner scoping;
 *  - createNativeSessionAnalysisProvider forwards `apiConfig` to
 *    runCaptureAnalysis; per AGENTS.md the bearer must be resolved per request.
 *
 * Note: none of `src/flow/session*.ts` has a production importer today, so
 * every observation here is about latent code (see report).
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import {
  LiveSessionFlow,
  createPendingStubAnalysisProvider,
  getCompletedSession,
  type SessionEventAnalysisRequest,
  type SessionMotionSample,
} from '../src/flow/session';
import { createNativeSessionAnalysisProvider } from '../src/flow/sessionNative';
import fixture from './fixtures/sessionReplay.afn-sasebo-rally1.json';

jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
}));
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});
let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const samples: SessionMotionSample[] = fixture.wristSamples;

function makeFlow(sessionId: string) {
  return new LiveSessionFlow({
    sessionId,
    source: 'replay',
    startedAtIso: '2026-01-01T00:00:00.000Z',
    provider: createPendingStubAnalysisProvider(),
  });
}

describe('completed-session registry (audit)', () => {
  it('VERIFY: ended sessions are readable by id and never-started ids are null', () => {
    const flow = makeFlow('audit-registry-1');
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    expect(getCompletedSession('audit-registry-1')).not.toBeNull();
    expect(getCompletedSession('audit-registry-never')).toBeNull();
  });

  it('the registry has no eviction: 200 completed sessions in one process keep 200 full snapshots alive (a bounded registry would have evicted the oldest)', () => {
    const ids: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const id = `audit-registry-bulk-${i}`;
      ids.push(id);
      const flow = makeFlow(id);
      for (const sample of samples) flow.pushSample(sample);
      flow.end();
    }
    const retained = ids.filter(id => getCompletedSession(id) !== null);
    expect(retained).toHaveLength(200);
    expect(getCompletedSession(ids[0]!)).toBeNull();
  });

  it('the registry is not owner-scoped: a session ended under account A is still readable after switching the active data owner to account B', () => {
    setActiveDataOwner('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const flow = makeFlow('audit-registry-owner-a');
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    expect(getCompletedSession('audit-registry-owner-a')).not.toBeNull();

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    // Expected: another account (or the signed-out state) cannot read A's
    // completed session summary from process memory.
    expect(getCompletedSession('audit-registry-owner-a')).toBeNull();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });
});

describe('native session analysis provider bearer handling (audit)', () => {
  const owner = '33333333-3333-4333-8333-333333333333';

  function eventClip(): { clip: CapturedClip; sidecarJson: string } {
    const { sequence, window } = generateSwingSequence();
    const sidecarJson = serializePoseSequence(sequence);
    const clip: CapturedClip = {
      uri: 'file:///captures/session-e1.mov',
      durationMs: window.endMs,
      fps: 59.94,
      width: 720,
      height: 1280,
      capturedAtIso: '2026-08-27T18:00:00.000Z',
      captureMode: 'automatic_pose_trigger',
      recognition: {
        status: 'unknown',
        reason: 'validated_classifier_unavailable',
      },
      trigger: {
        startMs: window.startMs,
        endMs: window.endMs,
        peakMotionMs: window.peakMs,
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
        analysisInputFrameCount: sequence.frames.length,
        poseFrameCount: sequence.frames.length,
        poseMissingFrameCount: 0,
        trackedDurationMs: window.endMs,
        meanCanonicalJointVisibility: 0.9,
        meanJointCoverage: 0.9,
        minimumJointCoverage: 0.8,
        fullBodyVisibleFrameCount: sequence.frames.length,
        jointMotion: [],
      },
      ballSpeed: {
        status: 'unavailable',
        reason: 'calibrated_ball_tracker_unavailable',
      },
      preRollMs: 200,
      postRollMs: 200,
      poseSequence: {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: 'file:///captures/session-e1.pose.json',
        frameCount: sequence.frames.length,
        sha256: sha256Hex(sidecarJson),
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: 'apple-vision-bodypose-1',
      },
    };
    return { clip, sidecarJson };
  }

  function request(clip: CapturedClip): SessionEventAnalysisRequest {
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
      poseSequenceSlice: clip.poseSequence ?? null,
    };
  }

  const db = { execute: async () => ({ rows: [] }), close() {} } as LocalDb;

  function refusingServer(): { fetchMock: jest.Mock; authHeaders: string[] } {
    const authHeaders: string[] = [];
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/analysis-permits')) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        authHeaders.push(headers['Authorization'] ?? headers['authorization'] ?? '');
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({
            error: { code: 'unavailable', message: 'rating service down' },
          }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    return { fetchMock, authHeaders };
  }

  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('VERIFY: a getter-backed apiConfig (the syncRuntime pattern) bears the ROTATED token on the next event — the provider does not snapshot the token', async () => {
    const { clip, sidecarJson } = eventClip();
    mockReadArtifact = async () => sidecarJson;
    const server = refusingServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    let currentToken = 'token-before-rotation';
    const provider = createNativeSessionAnalysisProvider({
      db,
      apiConfig: {
        baseUrl: 'https://api.test',
        get token() {
          return currentToken;
        },
      },
      appVersion: '0.1.0',
      handedness: 'right',
    });
    const first = await provider.analyzeEvent(request(clip));
    expect(first.status).toBe('pending');
    currentToken = 'token-after-rotation';
    const second = await provider.analyzeEvent(request(clip));
    expect(second.status).toBe('pending');
    expect(server.authHeaders).toEqual([
      'Bearer token-before-rotation',
      'Bearer token-after-rotation',
    ]);
  });

  it('a literal {token} snapshot passed at construction keeps bearing the OLD token after rotation (the type does not force per-request resolution)', async () => {
    const { clip, sidecarJson } = eventClip();
    mockReadArtifact = async () => sidecarJson;
    const server = refusingServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    let currentToken = 'token-before-rotation';
    const provider = createNativeSessionAnalysisProvider({
      db,
      // What a naive caller would write from getApiSession():
      apiConfig: { baseUrl: 'https://api.test', token: currentToken },
      appVersion: '0.1.0',
      handedness: 'right',
    });
    await provider.analyzeEvent(request(clip));
    currentToken = 'token-after-rotation';
    await provider.analyzeEvent(request(clip));
    // Documented hazard (AGENTS.md per-request bearer rule): the second
    // event still bears the token captured at construction.
    expect(server.authHeaders).toEqual([
      'Bearer token-before-rotation',
      'Bearer token-before-rotation',
    ]);
  });
});
