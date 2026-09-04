/**
 * A server permit reserved for a rating must never be orphaned by a LOCAL
 * failure. Between `permits.reserve()` and the durable shot.sync outbox row
 * there are three local writes (analysis record, capture status, local
 * shot + outbox). If any of them throws, the reservation must be settled:
 * released on the server (retried), or — when the server cannot be reached
 * — represented by a durable outbox row the drain finalizes later. Otherwise
 * the user's free rating stays held server-side with no local record of it.
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
import { drainOutbox, type SyncTransport } from '../../../src/data/sync';

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
const PERMIT_ID = 'permit-orphan-1';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

interface FaultyDb {
  db: LocalDb;
  calls: RecordedCall[];
  /** Rows of the in-memory outbox; kind + parsed payload. */
  outbox: Array<{ kind: string; payload: Record<string, unknown> }>;
}

/** Records every statement; throws `error` for the first statement matching
 * `failOn` (later matches succeed, mirroring a transient local write error).
 * Outbox inserts are kept so the test can see what would survive a restart. */
function faultyDb(failOn: (sql: string) => boolean): FaultyDb {
  const calls: RecordedCall[] = [];
  const outbox: FaultyDb['outbox'] = [];
  let injected = false;
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (!injected && failOn(sql)) {
        injected = true;
        throw new Error(`disk I/O error (injected on: ${sql.slice(0, 40)})`);
      }
      if (sql.includes('INSERT INTO outbox')) {
        const kindMatch = /VALUES \(\?, '([a-z.]+)', \?\)/.exec(sql);
        outbox.push({
          kind: kindMatch ? kindMatch[1] : String(params[1]),
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

interface PermitServer {
  fetchMock: jest.Mock;
  reserved: string[];
  /** Every finalize the server accepted: permit id + outcome. */
  finalized: Array<{ permitId: string; outcome: unknown }>;
}

function permitServer(options: { finalizeReachable: boolean }): PermitServer {
  const reserved: string[] = [];
  const finalized: PermitServer['finalized'] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      reserved.push(PERMIT_ID);
      return jsonResponse({
        permit: {
          id: PERMIT_ID,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-27T20:00:00.000Z',
        },
      });
    }
    const finalize = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
    if (finalize) {
      if (!options.finalizeReachable) {
        throw new TypeError('Network request failed');
      }
      const body = JSON.parse(String(init?.body)) as { outcome: unknown };
      finalized.push({
        permitId: decodeURIComponent(finalize[1]),
        outcome: body.outcome,
      });
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, reserved, finalized };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
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

/** The three local writes that sit between the reservation and the durable
 * shot.sync row, in execution order. */
const FAILURE_POINTS: Array<{
  name: string;
  failOn: (sql: string) => boolean;
}> = [
  {
    name: 'local_analysis_record insert',
    failOn: sql => sql.includes('INSERT INTO local_analysis_record'),
  },
  {
    name: 'local_capture status update',
    failOn: sql => sql.includes("SET status = 'analyzed'"),
  },
  {
    name: 'local_shot insert (inside the shot.sync transaction)',
    failOn: sql => sql.includes('INSERT OR REPLACE INTO local_shot'),
  },
];

function releaseRows(faulty: FaultyDb, permitId: string) {
  return faulty.outbox.filter(
    row =>
      row.kind === 'permit.release' && row.payload['permitId'] === permitId,
  );
}

describe('permit reserved, then a local persistence failure', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  describe.each(FAILURE_POINTS)('$name', ({ failOn }) => {
    it('releases the reserved permit on the server when it is reachable', async () => {
      const faulty = faultyDb(failOn);
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const server = permitServer({ finalizeReachable: true });
      (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

      await expect(
        runCaptureAnalysis(request(faulty.db, clip)),
      ).rejects.toThrow('disk I/O error');

      expect(server.reserved).toEqual([PERMIT_ID]);
      const releases = server.finalized.filter(
        entry => entry.permitId === PERMIT_ID,
      );
      // Exactly one release, and never a durable shot row that would consume
      // the permit for a rating the user does not have locally.
      expect(releases).toHaveLength(1);
      expect(releases[0].outcome).toBe('failed');
      expect(
        faulty.outbox.filter(row => row.kind === 'shot.sync'),
      ).toHaveLength(0);
    });

    it('queues a durable release row when the server cannot be reached', async () => {
      const faulty = faultyDb(failOn);
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const server = permitServer({ finalizeReachable: false });
      (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

      await expect(
        runCaptureAnalysis(request(faulty.db, clip)),
      ).rejects.toThrow('disk I/O error');

      expect(server.reserved).toEqual([PERMIT_ID]);
      expect(server.finalized).toHaveLength(0);
      const rows = releaseRows(faulty, PERMIT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toEqual({
        permitId: PERMIT_ID,
        outcome: 'failed',
      });
      expect(
        faulty.outbox.filter(row => row.kind === 'shot.sync'),
      ).toHaveLength(0);
    });
  });

  it('a successful run still reserves once and releases nothing (the sync transaction consumes the permit)', async () => {
    const faulty = faultyDb(() => false);
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ finalizeReachable: true });
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(faulty.db, clip));

    expect(outcome.kind).toBe('scored');
    expect(server.reserved).toEqual([PERMIT_ID]);
    expect(server.finalized).toHaveLength(0);
    expect(releaseRows(faulty, PERMIT_ID)).toHaveLength(0);
    expect(faulty.outbox.filter(row => row.kind === 'shot.sync')).toHaveLength(
      1,
    );
  });
});

describe('durable permit.release rows drain to the server', () => {
  interface OutboxRow {
    id: number;
    owner_key: string;
    kind: string;
    payload: string;
    attempts: number;
    last_error: string | null;
  }

  function outboxDb(rows: Array<{ kind: string; payload: unknown }>) {
    const outbox: OutboxRow[] = rows.map((row, index) => ({
      id: index + 1,
      owner_key: owner,
      kind: row.kind,
      payload: JSON.stringify(row.payload),
      attempts: 0,
      last_error: null,
    }));
    const db: LocalDb = {
      async execute(sql: string, params: unknown[] = []) {
        if (sql.startsWith('SELECT id, kind, payload')) {
          return {
            rows: outbox
              .filter(
                r =>
                  r.owner_key === String(params[0]) &&
                  r.attempts < Number(params[1]),
              )
              .map(r => ({ ...r })),
          };
        }
        if (sql.startsWith('DELETE FROM outbox')) {
          const idx = outbox.findIndex(
            r => r.owner_key === params[0] && r.id === params[1],
          );
          if (idx >= 0) outbox.splice(idx, 1);
          return { rows: [] };
        }
        if (sql.startsWith('UPDATE outbox')) {
          const row = outbox.find(
            r => r.owner_key === params[1] && r.id === params[2],
          );
          if (row) {
            if (sql.includes('attempts = attempts + 1')) row.attempts += 1;
            row.last_error = String(params[0]);
          }
          return { rows: [] };
        }
        if (sql.startsWith('SELECT count(*)')) {
          return {
            rows: [
              { n: outbox.filter(row => row.owner_key === params[0]).length },
            ],
          };
        }
        throw new Error(`outboxDb: unhandled sql ${sql}`);
      },
      close() {},
    };
    return { db, outbox };
  }

  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('finalizes the permit through the transport and deletes the row', async () => {
    const { db, outbox } = outboxDb([
      {
        kind: 'permit.release',
        payload: { permitId: PERMIT_ID, outcome: 'failed' },
      },
    ]);
    const released: Array<[string, string]> = [];
    const transport: SyncTransport = {
      async syncShots() {
        return { acceptedIds: [], rejected: [] };
      },
      async createSession() {},
      async finalizeSession() {},
      async releasePermit(permitId, outcome) {
        released.push([permitId, outcome]);
      },
    };

    const result = await drainOutbox(db, transport);

    expect(released).toEqual([[PERMIT_ID, 'failed']]);
    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(outbox).toHaveLength(0);
  });

  it('keeps the row (no attempt burned) while the server is unreachable', async () => {
    const { db, outbox } = outboxDb([
      {
        kind: 'permit.release',
        payload: { permitId: PERMIT_ID, outcome: 'failed' },
      },
    ]);
    const transport: SyncTransport = {
      async syncShots() {
        return { acceptedIds: [], rejected: [] };
      },
      async createSession() {},
      async finalizeSession() {},
      async releasePermit() {
        throw new TypeError('Network request failed');
      },
    };

    const result = await drainOutbox(db, transport);

    expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].attempts).toBe(0);
    expect(outbox[0].last_error).toContain('Network request failed');
  });
});
