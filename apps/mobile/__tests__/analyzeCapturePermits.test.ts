/**
 * mobile-analyze-capture::A1 — permit and durable-state contract of
 * `runCaptureAnalysis` when a step AFTER `permits.reserve()` throws.
 *
 * Unlike the statement-recording fakes in the attack suites, this pin runs the
 * production schema (`getDb()` → LOCAL_MIGRATIONS + ensureAccountScopedSchema)
 * on a REAL SQLite database (node:sqlite, Node 22) so the durable state a
 * device is left with — `local_capture.status`, `local_analysis_record`,
 * `local_shot`, `outbox` — is read back from disk semantics, not inferred
 * from the SQL text. Faults are injected at exact statements; the real
 * pipeline, repository and permit client run.
 *
 * Contract pinned:
 *  1. analyzeCapture / saveAnalysisRecord / markCaptureAnalyzed / saveAnalysis
 *     throwing after reservation → exactly one `finalize(permitId, failed)`
 *     and the ORIGINAL error reaches the caller.
 *  2. A failing release is swallowed and never masks the original error.
 *  3. A saveAnalysis failure never leaves a capture in `awaiting_model` with a
 *     durable analysis record; and for every persistence fault a re-run of
 *     the SAME capture reconciles the record/status pair (status `analyzed`,
 *     exactly one rating promoted with the retry's permit).
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import * as pipeline from '@pickle/analysis-pipeline';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { savePendingCapture } from '../src/data/repository';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

// apps/mobile types only `jest` (no @types/node) so app code cannot lean on
// Node APIs; this test declares the exact node:sqlite surface it drives.
declare const require: (id: string) => unknown;

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

const mockState: { real: DatabaseSync | null } = { real: null };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const db = mockState.real;
    if (!db) throw new Error('test did not open a database');
    return {
      executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => ({
        rows: db.prepare(sql).all(...(params as (string | number | null)[])),
      }),
      close: () => {},
    };
  },
}));

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

// analyzeCapture is re-exported from the pipeline index; spying on the module
// namespace lets a test make it throw AFTER the permit has been reserved.
jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { __esModule: true, ...actual };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '44444444-4444-4444-8444-444444444444';

function openProductionSchemaDb(): LocalDb {
  mockState.real = new DatabaseSync(':memory:');
  const loaded: { getDb: (() => LocalDb) | null } = { getDb: null };
  jest.isolateModules(() => {
    loaded.getDb =
      jest.requireActual<typeof import('../src/data/db')>(
        '../src/data/db',
      ).getDb;
  });
  if (!loaded.getDb) throw new Error('db module did not load');
  return loaded.getDb();
}

interface FaultDb {
  db: LocalDb;
  /** Reject the NEXT statement whose SQL contains `needle` (once). */
  failNext(needle: string, error: Error): void;
}

function withFaults(inner: LocalDb): FaultDb {
  const pending: Array<{ needle: string; error: Error }> = [];
  return {
    db: {
      async execute(sql, params = []) {
        const index = pending.findIndex(f => sql.includes(f.needle));
        if (index >= 0) {
          const [fault] = pending.splice(index, 1);
          throw fault!.error;
        }
        return inner.execute(sql, params);
      },
      close() {
        inner.close();
      },
    },
    failNext(needle, error) {
      pending.push({ needle, error });
    },
  };
}

interface PermitServer {
  fetchMock: jest.Mock;
  reserves: number;
  finalized: Array<{ permitId: string; body: unknown }>;
  /** When set, every finalize call fails this way instead of answering 200. */
  finalizeFailure: 'http_500' | 'network' | null;
}

function permitServer(): PermitServer {
  const server: PermitServer = {
    reserves: 0,
    finalized: [],
    finalizeFailure: null,
    fetchMock: jest.fn(),
  };
  server.fetchMock.mockImplementation(
    async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/analysis-permits')) {
        server.reserves += 1;
        return jsonResponse({
          permit: {
            id: `permit-${server.reserves}`,
            accessSource: 'free',
            status: 'reserved',
            expiresAt: '2026-09-05T20:00:00.000Z',
          },
        });
      }
      const finalize = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
      if (finalize) {
        server.finalized.push({
          permitId: decodeURIComponent(finalize[1]!),
          body: JSON.parse(String(init?.body)),
        });
        if (server.finalizeFailure === 'network') {
          throw new TypeError('Network request failed');
        }
        if (server.finalizeFailure === 'http_500') {
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => ({ error: { code: 'internal' } }),
          } as unknown as Response;
        }
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  return server;
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
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/a1-permit.mov',
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-05T12:00:00.000Z',
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
      uri: 'file:///captures/a1-permit.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

const CAPTURE_ID = 'capture-a1';

function request(db: LocalDb, clip: CapturedClip) {
  return {
    db,
    captureId: CAPTURE_ID,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

interface DurableState {
  captureStatus: string | null;
  records: number;
  shots: number;
  outbox: Array<{ analysisId: string; analysisPermitId: string }>;
}

async function durableState(db: LocalDb): Promise<DurableState> {
  const capture = await db.execute(
    'SELECT status FROM local_capture WHERE owner_key = ? AND id = ?',
    [owner, CAPTURE_ID],
  );
  const records = await db.execute(
    'SELECT count(*) AS n FROM local_analysis_record WHERE owner_key = ? AND capture_id = ?',
    [owner, CAPTURE_ID],
  );
  const shots = await db.execute(
    'SELECT count(*) AS n FROM local_shot WHERE owner_key = ?',
    [owner],
  );
  const outbox = await db.execute(
    "SELECT payload FROM outbox WHERE owner_key = ? AND kind = 'shot.sync' ORDER BY id",
    [owner],
  );
  return {
    captureStatus:
      capture.rows[0] === undefined ? null : String(capture.rows[0]['status']),
    records: Number(records.rows[0]!['n']),
    shots: Number(shots.rows[0]!['n']),
    outbox: outbox.rows.map(row => {
      const payload = JSON.parse(String(row['payload'])) as {
        id: string;
        analysisPermitId: string;
      };
      return {
        analysisId: payload.id,
        analysisPermitId: payload.analysisPermitId,
      };
    }),
  };
}

const failedRelease = (permitId: string) => ({
  permitId,
  body: { outcome: 'failed', ratingId: null },
});

interface Scenario {
  name: string;
  /** Statement needle for the injected SQLite fault, or null for a thrown
   * analyzeCapture. */
  fault: string | null;
  error: Error;
  /** Durable state expected right after the throw. */
  afterThrow: Pick<DurableState, 'captureStatus' | 'records' | 'shots'>;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'analyzeCapture throws',
    fault: null,
    error: new TypeError(
      "Cannot read properties of undefined (reading 'frames')",
    ),
    afterThrow: { captureStatus: 'awaiting_model', records: 0, shots: 0 },
  },
  {
    name: 'saveAnalysisRecord throws',
    fault: 'INSERT INTO local_analysis_record',
    error: new Error('SQLITE_FULL: database or disk is full (record)'),
    afterThrow: { captureStatus: 'awaiting_model', records: 0, shots: 0 },
  },
  {
    name: 'markCaptureAnalyzed throws',
    fault: "UPDATE local_capture SET status = 'analyzed'",
    error: new Error('SQLITE_FULL: database or disk is full (status)'),
    // The immutable record landed before the status flip failed; the capture
    // is honestly still pending (no rating exists) and reconciles on re-run.
    afterThrow: { captureStatus: 'awaiting_model', records: 1, shots: 0 },
  },
  {
    name: 'saveAnalysis throws',
    fault: 'INSERT OR REPLACE INTO local_shot',
    error: new Error('SQLITE_FULL: database or disk is full (shot)'),
    afterThrow: { captureStatus: 'analyzed', records: 1, shots: 0 },
  },
];

async function seededRun(scenario: Scenario, server: PermitServer) {
  const { clip, sidecarJson } = swingClipWithSidecar();
  mockReadArtifact = async () => sidecarJson;
  (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
  const real = openProductionSchemaDb();
  const faults = withFaults(real);
  await savePendingCapture(faults.db, CAPTURE_ID, 'unrecognized', clip);
  expect((await durableState(real)).captureStatus).toBe('awaiting_model');
  if (scenario.fault === null) {
    jest.spyOn(pipeline, 'analyzeCapture').mockImplementationOnce(() => {
      expect(server.reserves).toBe(1);
      throw scenario.error;
    });
  } else {
    faults.failNext(scenario.fault, scenario.error);
  }
  return { clip, real, faults };
}

beforeEach(() => setActiveDataOwner(owner));
afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
  jest.restoreAllMocks();
  mockState.real?.close();
  mockState.real = null;
});

describe('A1 §1 — a throw after reservation releases the permit exactly once and still surfaces', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} → one finalize(permit-1, failed), original error escapes, durable state as recorded`, async () => {
      const server = permitServer();
      const { clip, real, faults } = await seededRun(scenario, server);

      let thrown: unknown = null;
      try {
        await runCaptureAnalysis(request(faults.db, clip));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(scenario.error);

      expect(server.reserves).toBe(1);
      expect(server.finalized).toEqual([failedRelease('permit-1')]);
      expect(
        server.fetchMock.mock.calls.filter(([url]) =>
          String(url).includes('/finalize'),
        ),
      ).toHaveLength(1);

      const state = await durableState(real);
      expect(state.captureStatus).toBe(scenario.afterThrow.captureStatus);
      expect(state.records).toBe(scenario.afterThrow.records);
      expect(state.shots).toBe(scenario.afterThrow.shots);
      // A rating never leaves the device without the promotion succeeding.
      expect(state.outbox).toEqual([]);
    });
  }
});

describe('A1 §2 — a failing release is swallowed and never masks the original error', () => {
  for (const finalizeFailure of ['http_500', 'network'] as const) {
    it(`saveAnalysis throws and finalize fails (${finalizeFailure}) → the SQLite error escapes, one release attempted`, async () => {
      const server = permitServer();
      server.finalizeFailure = finalizeFailure;
      const scenario = SCENARIOS[3]!;
      const { clip, faults } = await seededRun(scenario, server);

      let thrown: unknown = null;
      try {
        await runCaptureAnalysis(request(faults.db, clip));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(scenario.error);
      expect(server.finalized).toEqual([failedRelease('permit-1')]);
    });

    it(`analyzeCapture throws and finalize fails (${finalizeFailure}) → the pipeline error escapes, one release attempted`, async () => {
      const server = permitServer();
      server.finalizeFailure = finalizeFailure;
      const scenario = SCENARIOS[0]!;
      const { clip, faults } = await seededRun(scenario, server);

      await expect(runCaptureAnalysis(request(faults.db, clip))).rejects.toBe(
        scenario.error,
      );
      expect(server.finalized).toEqual([failedRelease('permit-1')]);
    });
  }
});

describe('A1 §3 — promotion vs markCaptureAnalyzed: no awaiting_model capture with a durable record after a saveAnalysis fault, and every fault reconciles on re-run', () => {
  it('saveAnalysis fault: the capture is NOT left awaiting_model beside its durable record; nothing is promoted', async () => {
    const server = permitServer();
    const scenario = SCENARIOS[3]!;
    const { clip, real, faults } = await seededRun(scenario, server);

    await expect(runCaptureAnalysis(request(faults.db, clip))).rejects.toBe(
      scenario.error,
    );
    const state = await durableState(real);
    expect(state.records).toBe(1);
    expect(state.captureStatus).not.toBe('awaiting_model');
    expect(state.captureStatus).toBe('analyzed');
    expect(state.shots).toBe(0);
    expect(state.outbox).toEqual([]);
    // The promotion transaction is closed: the connection is not left inside
    // an open BEGIN (a later write would otherwise fail or nest).
    await expect(real.execute('BEGIN IMMEDIATE')).resolves.toBeDefined();
    await real.execute('ROLLBACK');
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}, then a re-run of the SAME capture → status analyzed, exactly one rating promoted with the retry permit, first permit released`, async () => {
      const server = permitServer();
      const { clip, real, faults } = await seededRun(scenario, server);

      await expect(runCaptureAnalysis(request(faults.db, clip))).rejects.toBe(
        scenario.error,
      );
      jest.restoreAllMocks();

      const retry = await runCaptureAnalysis(request(faults.db, clip));
      expect(retry.kind).toBe('scored');
      if (retry.kind !== 'scored') return;

      const state = await durableState(real);
      expect(state.captureStatus).toBe('analyzed');
      // Records are append-only reprocessing history: the failed attempt's
      // record (when it landed) stays beside the retry's.
      expect(state.records).toBe(scenario.afterThrow.records + 1);
      expect(state.shots).toBe(1);
      expect(state.outbox).toEqual([
        { analysisId: retry.analysisId, analysisPermitId: 'permit-2' },
      ]);

      expect(server.reserves).toBe(2);
      // permit-1 was released once (failed); permit-2 is consumed by the
      // shot-sync transaction and therefore never finalized from the client.
      expect(server.finalized).toEqual([failedRelease('permit-1')]);
    });
  }
});
