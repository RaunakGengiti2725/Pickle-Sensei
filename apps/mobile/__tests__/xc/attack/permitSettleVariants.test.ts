/**
 * ADVERSARIAL VARIANTS of the permit-settlement fix (0853e8c8,
 * `settleAbandonedPermit` in runCaptureAnalysis.ts).
 *
 * Attacks: server answers the inline release with each interesting status
 * (401 expired bearer, 408 timeout, 429 rate limit, 5xx, 404 already
 * settled, 409 already finalized, 400), the outbox insert itself fails,
 * the owner signs out between reservation and the local failure, and a
 * fresh run after a settled failure.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import type { CapturedClip } from '../../../src/camera/capture';
import { runCaptureAnalysis } from '../../../src/analysis/runCaptureAnalysis';

jest.mock('../../../src/camera/capture', () => {
  const actual = jest.requireActual('../../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '11111111-1111-4111-8111-111111111111';
const PERMIT_ID = 'permit-attack-1';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

interface FaultyDb {
  db: LocalDb;
  calls: RecordedCall[];
  outbox: Array<{ kind: string; payload: Record<string, unknown> }>;
}

function faultyDb(
  failOn: (sql: string) => boolean,
  options: { failOutboxInsert?: boolean; onFailure?: () => void } = {},
): FaultyDb {
  const calls: RecordedCall[] = [];
  const outbox: FaultyDb['outbox'] = [];
  let injected = false;
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (!injected && failOn(sql)) {
        injected = true;
        options.onFailure?.();
        throw new Error(`disk I/O error (injected on: ${sql.slice(0, 40)})`);
      }
      if (sql.includes('INSERT INTO outbox')) {
        if (options.failOutboxInsert) {
          throw new Error('database or disk is full (outbox insert)');
        }
        const kindMatch = /VALUES \(\?, '([a-z.]+)', \?\)/.exec(sql);
        outbox.push({
          kind: kindMatch?.[1] ?? String(params[1]),
          payload: JSON.parse(String(params[params.length - 1])) as Record<
            string,
            unknown
          >,
        });
      }
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls, outbox };
}

type FinalizeBehaviour =
  | { kind: 'ok' }
  | { kind: 'network_error' }
  | { kind: 'http'; status: number; code: string };

interface PermitServer {
  fetchMock: jest.Mock;
  reserved: string[];
  finalized: Array<{ permitId: string; outcome: unknown }>;
}

function permitServer(finalize: FinalizeBehaviour): PermitServer {
  const reserved: string[] = [];
  const finalized: PermitServer['finalized'] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      reserved.push(PERMIT_ID);
      return jsonResponse(200, {
        permit: {
          id: PERMIT_ID,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-27T20:00:00.000Z',
        },
      });
    }
    const match = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
    if (match) {
      if (finalize.kind === 'network_error') {
        throw new TypeError('Network request failed');
      }
      if (finalize.kind === 'http') {
        return jsonResponse(finalize.status, {
          error: { code: finalize.code, message: finalize.code },
        });
      }
      const body = JSON.parse(String(init?.body)) as { outcome: unknown };
      finalized.push({
        permitId: decodeURIComponent(match[1] ?? ''),
        outcome: body.outcome,
      });
      return jsonResponse(200, { ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, reserved, finalized };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
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
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

const failOnRecord = (sql: string) =>
  sql.includes('INSERT INTO local_analysis_record');

function releaseRows(faulty: FaultyDb) {
  return faulty.outbox.filter(row => row.kind === 'permit.release');
}

describe('settleAbandonedPermit — server answer matrix', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  describe.each([
    [401, 'auth.required'],
    [408, 'network.timeout'],
    [429, 'rate_limited'],
    [500, 'internal'],
    [503, 'unavailable'],
  ])('inline release answered %i %s (transient)', (status, code) => {
    it('queues exactly one durable permit.release row', async () => {
      const faulty = faultyDb(failOnRecord);
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const server = permitServer({ kind: 'http', status, code });
      (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

      await expect(
        runCaptureAnalysis(request(faulty.db, clip)),
      ).rejects.toThrow('disk I/O error');

      expect(releaseRows(faulty)).toEqual([
        {
          kind: 'permit.release',
          payload: { permitId: PERMIT_ID, outcome: 'failed' },
        },
      ]);
    });
  });

  describe.each([
    [400, 'validation.invalid_permit_id'],
    [404, 'access.permit_not_found'],
    [409, 'access.permit_already_finalized'],
  ])(
    'inline release answered %i %s (server already settled it)',
    (status, code) => {
      it('queues nothing and surfaces the local persistence error', async () => {
        const faulty = faultyDb(failOnRecord);
        const { clip, sidecarJson } = swingClipWithSidecar();
        mockReadArtifact = async () => sidecarJson;
        const server = permitServer({ kind: 'http', status, code });
        (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

        await expect(
          runCaptureAnalysis(request(faulty.db, clip)),
        ).rejects.toThrow('disk I/O error');

        expect(releaseRows(faulty)).toHaveLength(0);
      });
    },
  );

  it('when the outbox insert ALSO fails the caller still sees the original persistence error', async () => {
    const faulty = faultyDb(failOnRecord, { failOutboxInsert: true });
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ kind: 'network_error' });
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    await expect(runCaptureAnalysis(request(faulty.db, clip))).rejects.toThrow(
      'disk I/O error',
    );
    expect(releaseRows(faulty)).toHaveLength(0);
  });

  it('owner signed out between reservation and the local failure: no cross-owner outbox row, original error surfaces', async () => {
    const faulty = faultyDb(failOnRecord, {
      onFailure: () => setActiveDataOwner(SIGNED_OUT_DATA_OWNER),
    });
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ kind: 'network_error' });
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    await expect(runCaptureAnalysis(request(faulty.db, clip))).rejects.toThrow(
      'disk I/O error',
    );
    expect(releaseRows(faulty)).toHaveLength(0);
  });

  it('a second run after a settled failure reserves a fresh permit and syncs normally (no sticky state)', async () => {
    const faulty = faultyDb(failOnRecord);
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ kind: 'network_error' });
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    await expect(runCaptureAnalysis(request(faulty.db, clip))).rejects.toThrow(
      'disk I/O error',
    );
    const outcome = await runCaptureAnalysis(request(faulty.db, clip));
    expect(outcome.kind).toBe('scored');
    expect(server.reserved).toHaveLength(2);
    expect(releaseRows(faulty)).toHaveLength(1);
    expect(faulty.outbox.filter(row => row.kind === 'shot.sync')).toHaveLength(
      1,
    );
  });
});
