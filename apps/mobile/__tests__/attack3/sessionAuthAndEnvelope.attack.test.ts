/**
 * ADVERSARIAL PASS 3 / mobile-analyze-capture
 *
 *  S5  The 3rd permits.reserve of a live session returns 401. Do later events
 *      go pending, and does anything re-resolve the bearer — or is the
 *      `apiConfig` captured when `createNativeSessionAnalysisProvider` was
 *      constructed replayed forever?
 *  S6  A clip with `fps: 0` through `assertCapturedClip` and
 *      `attemptCaptureEnvelope`: UNSUPPORTED/guidance, or a scored run?
 *
 * Real LiveSessionFlow, real native session provider, real runCaptureAnalysis,
 * real analysis pipeline, real repository. Only SQLite (`LocalDb`), the
 * sidecar reader and `fetch` are faked.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  assertCapturedClip,
  type CapturedClip,
} from '../../src/camera/capture';
import {
  attemptCaptureEnvelope,
  captureGuidanceLines,
  qualityBlockedMessage,
} from '../../src/camera/captureEnvelope';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import {
  LiveSessionFlow,
  type SessionEventClipSource,
  type SessionMotionSample,
} from '../../src/flow/session';
import { createNativeSessionAnalysisProvider } from '../../src/flow/sessionNative';
import fixture from '../fixtures/sessionReplay.afn-sasebo-rally1.json';

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '55555555-5555-4555-8555-555555555555';
const wristSamples: SessionMotionSample[] = fixture.wristSamples;

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function recordingDb(): { db: LocalDb; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    json: async () => body,
  } as unknown as Response;
}

interface ReserveCall {
  authorization: string | undefined;
  status: number;
}

/** Permit server whose reserve endpoint answers 200 for the first
 * `okReserves` calls and 401 (`auth.required`) for every later one. */
function permitServer(okReserves: number) {
  const reserves: ReserveCall[] = [];
  const finalized: string[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.endsWith('/v1/analysis-permits')) {
      const status = reserves.length < okReserves ? 200 : 401;
      reserves.push({ authorization: headers.authorization, status });
      if (status === 401) {
        return jsonResponse(401, {
          error: { code: 'auth.required', message: 'Sign in to continue.' },
        });
      }
      return jsonResponse(200, {
        permit: {
          id: `permit-${reserves.length}`,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-04T20:00:00.000Z',
        },
      });
    }
    const finalize = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
    if (finalize) {
      finalized.push(decodeURIComponent(finalize[1]!));
      return jsonResponse(200, { ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  return { reserves, finalized, fetchMock };
}

function swingClip(
  fps: number,
  uri = 'file:///captures/attack3-session.mov',
): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri,
    durationMs: window.endMs,
    fps,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
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
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `${uri}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

const STALE_TOKEN = 'access-token-stale';
const ROTATED_TOKEN = 'access-token-rotated';

function apiSession(bearerToken: string) {
  return {
    apiBaseUrl: 'https://api.test',
    bearerToken,
    canonicalAppUserId: owner,
    provider: 'apple' as const,
    refreshToken: 'refresh-1',
  };
}

describe('ATTACK S5 — 3rd permits.reserve of a session returns 401', () => {
  const unauthorizedListener = jest.fn();
  beforeEach(() => {
    setActiveDataOwner(owner);
    unauthorizedListener.mockReset();
    setApiUnauthorizedListener(unauthorizedListener);
  });
  afterEach(() => {
    setApiUnauthorizedListener(null);
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  /** Drives the recorded rally through the flow twice (second pass offset in
   * time) so the session closes 6 events; returns the settled snapshot. */
  async function runSession(
    provider: ReturnType<typeof createNativeSessionAnalysisProvider>,
    clipSource: SessionEventClipSource,
    afterFirstPass?: () => void,
  ) {
    const flow = new LiveSessionFlow({
      sessionId: 'attack3-session-401',
      source: 'live',
      startedAtIso: '2026-09-04T12:00:00.000Z',
      provider,
      clipSource,
    });
    const offset = wristSamples[wristSamples.length - 1]!.tMs + 1000;
    for (const sample of wristSamples) flow.pushSample(sample);
    // The first pass closes two events (the third closes on the next
    // samples); every dispatch settles before the second half, so the 401
    // lands on the THIRD reserve and the "later events" below are truly later.
    await flow.settled();
    afterFirstPass?.();
    for (const sample of wristSamples) {
      flow.pushSample({ tMs: sample.tMs + offset, v: sample.v });
    }
    flow.end();
    await flow.settled();
    return flow.snapshot();
  }

  it('the bearer rotated before event 3: reserves 3..6 replay the STALE token captured at provider construction, every later event is pending, and no re-auth is triggered (the 401 names a token that is no longer current)', async () => {
    const { clip, sidecarJson } = swingClip(60);
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer(2);
    const { db, calls } = recordingDb();

    // The session that exists when the provider is built …
    establishApiSession(apiSession(STALE_TOKEN));
    const current = getApiSession()!;
    const provider = createNativeSessionAnalysisProvider({
      db,
      apiConfig: { baseUrl: current.apiBaseUrl, token: current.bearerToken },
      appVersion: '0.1.0',
      handedness: 'right',
    });
    const clipSource: SessionEventClipSource = {
      sourceId: 'attack3-clip-source',
      async extract() {
        return {
          status: 'extracted',
          clip,
          poseSequenceSlice: clip.poseSequence ?? null,
        };
      },
    };

    const snapshot = await runSession(provider, clipSource, () => {
      // … is rotated by sessionKeeper before the third stroke lands.
      expect(server.reserves).toHaveLength(2);
      establishApiSession(apiSession(ROTATED_TOKEN));
    });

    expect(snapshot.events).toHaveLength(6);
    expect(snapshot.events.map(e => e.state)).toEqual([
      'ready',
      'ready',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    for (const event of snapshot.events.slice(2)) {
      expect(event.pendingReason).toMatch(/Sign in to continue/);
      expect(event.analysis).toBeNull();
    }

    // Six reserves, every one of them with the token captured at construction.
    expect(server.reserves.map(r => r.status)).toEqual([
      200, 200, 401, 401, 401, 401,
    ]);
    expect(server.reserves.map(r => r.authorization)).toEqual(
      Array(6).fill(`Bearer ${STALE_TOKEN}`),
    );
    // BROKEN (contract: "resolve the bearer per request … never capture
    // bearerToken at construction"): the CURRENT session already holds a
    // valid rotated bearer that the provider never consulted.
    expect(getApiSession()?.bearerToken).toBe(ROTATED_TOKEN);
    expect(
      server.reserves.some(r => r.authorization === `Bearer ${ROTATED_TOKEN}`),
    ).toBe(false);
    // And nothing signals the failure upstream: reportApiUnauthorized ignores
    // a rejected token that is not the current one, so no refresh, no
    // sign-out, no prompt — the events just stay pending.
    expect(unauthorizedListener).not.toHaveBeenCalled();

    // Durable state: 2 scored records; the 4 pending events left their
    // `awaiting_model` capture rows behind with no analysis record.
    const sql = calls.map(c => c.sql.trim());
    expect(
      sql.filter(s => s.startsWith('INSERT INTO local_capture')),
    ).toHaveLength(6);
    expect(
      sql.filter(s => s.startsWith('INSERT INTO local_analysis_record')),
    ).toHaveLength(2);
    // Scored permits settle through the shot.sync outbox row, not /finalize.
    expect(
      sql.filter(
        s => s.startsWith('INSERT INTO outbox') && s.includes("'shot.sync'"),
      ),
    ).toHaveLength(2);
    expect(server.finalized).toEqual([]);
  });

  it('the CURRENT bearer expires (401 on the still-current token): the auth listener fires once per rejected reserve, and even after it establishes a fresh session the provider keeps sending the dead token', async () => {
    const { clip, sidecarJson } = swingClip(60);
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer(2);
    const { db } = recordingDb();

    establishApiSession(apiSession(STALE_TOKEN));
    // Stand-in for authStore.handleApiUnauthorized → refreshSessionNow(): the
    // refresh succeeds and a new bearer becomes current.
    unauthorizedListener.mockImplementation(() => {
      establishApiSession(apiSession(ROTATED_TOKEN));
    });
    const current = getApiSession()!;
    const provider = createNativeSessionAnalysisProvider({
      db,
      apiConfig: { baseUrl: current.apiBaseUrl, token: current.bearerToken },
      appVersion: '0.1.0',
      handedness: 'right',
    });
    const clipSource: SessionEventClipSource = {
      sourceId: 'attack3-clip-source',
      async extract() {
        return {
          status: 'extracted',
          clip,
          poseSequenceSlice: clip.poseSequence ?? null,
        };
      },
    };

    const snapshot = await runSession(provider, clipSource);

    expect(snapshot.events.map(e => e.state)).toEqual([
      'ready',
      'ready',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    // The first 401 was on the current token → listener fired and rotated.
    expect(unauthorizedListener).toHaveBeenCalledTimes(1);
    expect(getApiSession()?.bearerToken).toBe(ROTATED_TOKEN);
    // BROKEN: reserves 4..6 happen AFTER a valid bearer exists and still
    // carry the dead one; the refreshed session never reaches the provider.
    expect(server.reserves.map(r => r.authorization)).toEqual(
      Array(6).fill(`Bearer ${STALE_TOKEN}`),
    );
    expect(server.reserves.map(r => r.status)).toEqual([
      200, 200, 401, 401, 401, 401,
    ]);
  });
});

describe('ATTACK S6 — clip with fps: 0 through assertCapturedClip → attemptCaptureEnvelope → runCaptureAnalysis', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('assertCapturedClip ACCEPTS fps: 0 (only negative fps is rejected); the envelope then classifies frame_rate UNSUPPORTED with guidance, and runCaptureAnalysis is quality_blocked before any permit or inference', async () => {
    const { clip, sidecarJson } = swingClip(0);
    mockReadArtifact = async () => sidecarJson;

    // Validation lets the zero through …
    const validated = assertCapturedClip(
      JSON.parse(JSON.stringify(clip)),
      'automatic_pose_trigger',
    );
    expect(validated.fps).toBe(0);
    // … (negative and NaN are the only rejected shapes)
    expect(() =>
      assertCapturedClip({ ...clip, fps: -1 }, 'automatic_pose_trigger'),
    ).toThrow(/invalid or incomplete/);
    expect(() =>
      assertCapturedClip(
        { ...clip, fps: Number.NaN },
        'automatic_pose_trigger',
      ),
    ).toThrow(/invalid or incomplete/);

    // … the envelope measures 0 fps as UNSUPPORTED (not NOT_MEASURED) …
    const envelope = attemptCaptureEnvelope(validated, null, null);
    const frameRate = envelope.dimensions.find(
      d => d.dimension === 'frame_rate',
    );
    expect(frameRate).toMatchObject({
      status: 'UNSUPPORTED',
      measured: 0,
      unit: 'fps',
    });
    expect(envelope.overall).toBe('UNSUPPORTED');
    expect(envelope.notMeasured).not.toContain('frame_rate');
    const guidance = captureGuidanceLines(envelope);
    expect(guidance.map(g => g.dimension)).toContain('frame_rate');
    expect(guidance.find(g => g.dimension === 'frame_rate')?.status).toBe(
      'UNSUPPORTED',
    );

    // … and the analysis entry point abstains with that envelope attached.
    const server = permitServer(99);
    const { db, calls } = recordingDb();
    const outcome = await runCaptureAnalysis({
      db,
      captureId: 'capture-fps0',
      clip: validated,
      declaredStroke: 'forehand_drive',
      handedness: 'right',
      cameraView: 'side',
      apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
      appVersion: '0.1.0',
      captureEnvelope: envelope,
    });
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') throw new Error('unreachable');
    expect(outcome.reason).toMatch(/frame rate/);
    expect(outcome.envelope.overall).toBe('UNSUPPORTED');
    const message = qualityBlockedMessage(outcome.reason, outcome.envelope);
    expect(
      message.split('\n').filter(l => l.startsWith('•')).length,
    ).toBeGreaterThan(0);
    // HELD: no permit, no inference, no durable write for a blocked capture.
    expect(server.fetchMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('control: fps 0 with envelope OMITTED (the AnalyzeScreen wiring for imported_video passes captureEnvelope: null) reaches inference and scores — the gate is only as good as the caller that computes the envelope', async () => {
    const { clip, sidecarJson } = swingClip(0);
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer(99);
    const { db, calls } = recordingDb();
    const outcome = await runCaptureAnalysis({
      db,
      captureId: 'capture-fps0-no-envelope',
      clip,
      declaredStroke: 'forehand_drive',
      handedness: 'right',
      cameraView: 'side',
      apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
      appVersion: '0.1.0',
      captureEnvelope: null,
    });
    // Observed for the record: with no envelope there is nothing to gate on.
    expect(['scored', 'low_confidence']).toContain(outcome.kind);
    expect(server.reserves).toHaveLength(1);
    expect(
      calls.filter(c => c.sql.includes('INSERT INTO local_analysis_record')),
    ).toHaveLength(1);
  });
});
