/**
 * Adversarial pass 3 / scenarios 4 and 6 — hostile permit-reserve responses.
 *
 *  S4  `{permit:{id:'x',status:'consumed'}}` → `reserve()` throws the public
 *      non-reserved ApiError (409 `access.permit_not_reserved`; the
 *      assignment's `permit.unavailable` wording does not exist in api.ts)
 *      and `runCaptureAnalysis()` returns `unavailable` without writing a
 *      rating, a record or a capture status change.
 *  S6  `{permit:{…reserved}, access:'garbage'}` → parsed `access` is null
 *      and a scored run reports `freeLimitReached === false`.
 *
 * Extras: other permit statuses, null / non-object bodies, a reserved permit
 * with a missing / empty / non-string id, and every malformed `access`
 * shape that must degrade to null instead of failing the reservation.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import { ApiError, createAnalysisPermitClient } from '../../src/data/api';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';

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

const owner = '11111111-1111-4111-8111-111111111111';
const apiConfig = { baseUrl: 'https://api.test', token: 'token-1' };

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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

function server(reserveBody: unknown): {
  fetchMock: jest.Mock;
  finalized: unknown[];
} {
  const finalized: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) return jsonResponse(reserveBody);
    if (url.includes('/finalize')) {
      finalized.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, finalized };
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-abc.mov',
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
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
      uri: 'file:///captures/stroke-abc.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
  return {
    db,
    captureId: 'capture-1',
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig,
    appVersion: '1.0',
  };
}

const RESERVED = {
  id: 'permit-1',
  accessSource: 'free',
  status: 'reserved',
  expiresAt: '2026-08-27T20:00:00.000Z',
};

const GOOD_ACCESS = {
  premium: false,
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 1,
    remaining: 0,
    availableToReserve: 0,
  },
};

beforeEach(() => setActiveDataOwner(owner));
afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

// ---------------------------------------------------------------------------
// S4
// ---------------------------------------------------------------------------

describe('attack S4 — reserve returns a consumed permit', () => {
  it('reserve() throws the public non-reserved ApiError (409 access.permit_not_reserved)', async () => {
    const { fetchMock } = server({ permit: { id: 'x', status: 'consumed' } });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const permits = createAnalysisPermitClient(apiConfig);
    let caught: unknown;
    try {
      await permits.reserve('idem-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe('access.permit_not_reserved');
    expect(apiError.message).toBe('The analysis permit is no longer reserved.');
    // The assignment's wording (`permit.unavailable`) is NOT the shipped code.
    expect(apiError.code).not.toBe('permit.unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'consumed',
    'released',
    'expired',
    'failed',
    '',
    'RESERVED',
    'reserved ',
  ])('permit status %j is refused before inference', async status => {
    const { fetchMock } = server({ permit: { id: 'x', status } });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    await expect(
      createAnalysisPermitClient(apiConfig).reserve('k'),
    ).rejects.toMatchObject({
      status: 409,
      code: 'access.permit_not_reserved',
    });
  });

  it('runCaptureAnalysis returns unavailable (retryable, not paywall) and writes NOTHING locally', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = server({
      permit: { id: 'x', status: 'consumed' },
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome).toEqual({
      kind: 'unavailable',
      reason: 'The analysis permit is no longer reserved.',
    });
    // Not a paywall: the screen must offer retry, not upgrade.
    expect((outcome as { cause?: string }).cause).toBeUndefined();
    // No local_shot, no outbox, no analysis record, no capture status update.
    expect(calls).toHaveLength(0);
    // No release/finalize of a permit we never held.
    expect(finalized).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a permit-less body ({}) and a null body both degrade to unavailable with no writes (TypeError → generic copy)', async () => {
    for (const body of [{}, null, { permit: null }, 'not-an-object', 42]) {
      const { db, calls } = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const { fetchMock } = server(body);
      (globalThis as { fetch?: unknown }).fetch = fetchMock;
      const outcome = await runCaptureAnalysis(request(db, clip));
      expect(outcome.kind).toBe('unavailable');
      if (outcome.kind !== 'unavailable') return;
      expect(outcome.reason).toBe(
        'The rating service could not be reached. Your capture is saved and can be scored later.',
      );
      expect(calls).toHaveLength(0);
    }
  });

  it('a reserved permit with a MISSING / non-string / empty id is not caught by the reserve guard; the run fails only AFTER the record was persisted (observed)', async () => {
    const cases: Array<{ id: unknown; expectError: RegExp }> = [
      { id: undefined, expectError: /trim|undefined/ },
      { id: 42, expectError: /trim/ },
      { id: '   ', expectError: /server-reserved analysis permit is required/ },
    ];
    for (const { id, expectError } of cases) {
      const { db, calls } = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const { fetchMock } = server({ permit: { ...RESERVED, id } });
      (globalThis as { fetch?: unknown }).fetch = fetchMock;

      // OBSERVED (P3, api.ts:155-166 + repository.ts saveAnalysis): the
      // reserve guard only checks `status`, so a reserved permit with a bad id
      // lets inference run; saveAnalysis then throws. runCaptureAnalysis
      // rejects with a raw Error (AnalyzeScreen's catch renders the message
      // with a retry), after local_analysis_record + capture status were
      // already written but BEFORE any local_shot / outbox row.
      await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
        expectError,
      );
      expect(calls.some(c => c.sql.includes('local_analysis_record'))).toBe(
        true,
      );
      expect(calls.some(c => c.sql.includes("SET status = 'analyzed'"))).toBe(
        true,
      );
      expect(
        calls.some(c => c.sql.includes('INSERT OR REPLACE INTO local_shot')),
      ).toBe(false);
      expect(calls.some(c => c.sql.includes('INSERT INTO outbox'))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// S6
// ---------------------------------------------------------------------------

describe('attack S6 — reserved permit with a malformed access snapshot', () => {
  it("access:'garbage' parses to null and the reservation still succeeds", async () => {
    const { fetchMock } = server({ permit: RESERVED, access: 'garbage' });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const reserved = await createAnalysisPermitClient(apiConfig).reserve('k');
    expect(reserved.permit).toEqual(RESERVED);
    expect(reserved.access).toBeNull();
  });

  it.each<[string, unknown]>([
    ['string', 'garbage'],
    ['number', 7],
    ['array', [1, 2]],
    ['null', null],
    ['missing', undefined],
    ['empty object', {}],
    [
      'premium not boolean',
      { premium: 'yes', freeRatings: GOOD_ACCESS.freeRatings },
    ],
    ['freeRatings missing', { premium: false }],
    ['freeRatings null', { premium: false, freeRatings: null }],
    ['freeRatings string', { premium: false, freeRatings: 'x' }],
    [
      'numeric field as string',
      {
        premium: false,
        freeRatings: { ...GOOD_ACCESS.freeRatings, availableToReserve: '0' },
      },
    ],
    [
      'NaN field',
      {
        premium: false,
        freeRatings: { ...GOOD_ACCESS.freeRatings, remaining: Number.NaN },
      },
    ],
    [
      'Infinity field',
      {
        premium: false,
        freeRatings: {
          ...GOOD_ACCESS.freeRatings,
          limit: Number.POSITIVE_INFINITY,
        },
      },
    ],
    [
      'missing numeric field',
      {
        premium: false,
        freeRatings: { limit: 2, used: 1, reserved: 1, remaining: 0 },
      },
    ],
    [
      'null numeric field',
      {
        premium: false,
        freeRatings: { ...GOOD_ACCESS.freeRatings, used: null },
      },
    ],
  ])('malformed access (%s) → null', async (_label, access) => {
    const body: Record<string, unknown> = { permit: RESERVED };
    if (access !== undefined) body.access = access;
    const { fetchMock } = server(body);
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const reserved = await createAnalysisPermitClient(apiConfig).reserve('k');
    expect(reserved.access).toBeNull();
  });

  it('a well-formed snapshot parses exactly (control) and extra keys are dropped', async () => {
    const { fetchMock } = server({
      permit: RESERVED,
      access: {
        ...GOOD_ACCESS,
        extra: 'ignored',
        freeRatings: { ...GOOD_ACCESS.freeRatings, bonus: 1 },
      },
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const reserved = await createAnalysisPermitClient(apiConfig).reserve('k');
    expect(reserved.access).toEqual(GOOD_ACCESS);
  });

  it("scored run with access:'garbage' → freeLimitReached is false (rating saved, permit bound)", async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = server({
      permit: RESERVED,
      access: 'garbage',
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.freeLimitReached).toBe(false);
    const outboxInsert = calls.find(c => c.sql.includes('INSERT INTO outbox'));
    expect(outboxInsert).toBeDefined();
    expect(JSON.parse(String(outboxInsert!.params[1]))).toMatchObject({
      analysisPermitId: 'permit-1',
    });
    // Scored runs never finalize the permit client-side; sync consumes it.
    expect(finalized).toEqual([]);
  });

  it('control: the SAME run with a well-formed exhausted snapshot reports freeLimitReached true', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = server({ permit: RESERVED, access: GOOD_ACCESS });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.freeLimitReached).toBe(true);
  });

  it('a premium permit ignores even a well-formed exhausted free-ratings snapshot', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = server({
      permit: { ...RESERVED, accessSource: 'premium' },
      access: GOOD_ACCESS,
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.freeLimitReached).toBe(false);
  });
});
