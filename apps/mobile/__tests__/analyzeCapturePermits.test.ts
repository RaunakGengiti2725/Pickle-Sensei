import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

/**
 * PERMIT ACCOUNTING + DURABLE PROMOTION (mobile-analyze-capture::A1).
 *
 * After `permits.reserve()` succeeds, every exit from runCaptureAnalysis must
 * settle the reservation EXACTLY once: a scored run consumes it through the
 * durable shot.sync row, everything else releases it — including a thrown
 * error from any post-reservation step. The error itself still reaches the
 * caller, and a failing release (the server sweep is the backstop) never
 * masks it.
 *
 * Faults are injected at the SQL boundary of the fake LocalDb: that is where
 * the real failures happen (a SQLite error inside saveAnalysisRecord,
 * markCaptureAnalyzed or saveAnalysis), so the pins hold no matter which
 * repository function ends up issuing the statement. The fake honours
 * BEGIN/COMMIT/ROLLBACK so the durable state after a failure is observable.
 */

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return {
    ...actual,
    analyzeCapture: (...args: unknown[]) =>
      mockAnalyzeCapture
        ? mockAnalyzeCapture()
        : (actual.analyzeCapture as (...a: unknown[]) => unknown)(...args),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};
let mockAnalyzeCapture: (() => Promise<never>) | null = null;

const owner = '11111111-1111-4111-8111-111111111111';
const CAPTURE_ID = 'capture-1';

// ─── Fake LocalDb: durable state + transactions + SQL fault injection ───────

interface ShotRow {
  id: string;
  sessionId: string | null;
  source: string;
}
interface OutboxRow {
  kind: string;
  payload: Record<string, unknown>;
}
interface DurableState {
  /** Analysis record ids by capture id. */
  records: Map<string, string[]>;
  captureStatus: Map<string, string>;
  shots: ShotRow[];
  outbox: OutboxRow[];
  sessions: string[];
}

interface FaultDb {
  db: LocalDb;
  state: DurableState;
  sql: string[];
  /** Statements containing any of these fragments throw `injected: <label>`. */
  failOn: Map<string, string>;
}

function faultDb(): FaultDb {
  const state: DurableState = {
    records: new Map(),
    captureStatus: new Map([[CAPTURE_ID, 'awaiting_model']]),
    shots: [],
    outbox: [],
    sessions: [],
  };
  const sql: string[] = [];
  const failOn = new Map<string, string>();
  let staged: (() => void)[] | null = null;
  const write = (apply: () => void) => {
    if (staged) staged.push(apply);
    else apply();
  };
  const db: LocalDb = {
    async execute(statement: string, params: unknown[] = []) {
      sql.push(statement);
      for (const [fragment, label] of failOn) {
        if (statement.includes(fragment)) {
          throw new Error(`injected: ${label}`);
        }
      }
      if (statement === 'BEGIN IMMEDIATE') {
        if (staged) throw new Error('fakeDb: nested transaction');
        staged = [];
        return { rows: [] };
      }
      if (statement === 'COMMIT') {
        const pending = staged ?? [];
        staged = null;
        for (const apply of pending) apply();
        return { rows: [] };
      }
      if (statement === 'ROLLBACK') {
        staged = null;
        return { rows: [] };
      }
      if (statement.startsWith('SELECT value FROM kv')) return { rows: [] };
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) return { rows: [] };
      if (statement.includes('INSERT INTO local_analysis_record')) {
        const id = String(params[1]);
        const captureId = String(params[2]);
        write(() => {
          const list = state.records.get(captureId) ?? [];
          list.push(id);
          state.records.set(captureId, list);
        });
        return { rows: [] };
      }
      if (statement.includes("UPDATE local_capture SET status = 'analyzed'")) {
        const captureId = String(params[1]);
        write(() => state.captureStatus.set(captureId, 'analyzed'));
        return { rows: [] };
      }
      if (statement.includes('INSERT OR REPLACE INTO local_shot')) {
        const row: ShotRow = {
          id: String(params[1]),
          sessionId: params[2] === null ? null : String(params[2]),
          source: String(params[8]),
        };
        write(() => state.shots.push(row));
        return { rows: [] };
      }
      if (statement.includes('INSERT OR REPLACE INTO local_session')) {
        const id = String(params[1]);
        write(() => state.sessions.push(id));
        return { rows: [] };
      }
      if (statement.includes('INSERT INTO outbox')) {
        const kind = /'([a-z.]+)'/.exec(statement)?.[1] ?? 'unknown';
        const payload = JSON.parse(String(params[1])) as Record<
          string,
          unknown
        >;
        write(() => state.outbox.push({ kind, payload }));
        return { rows: [] };
      }
      throw new Error(`fakeDb: unhandled sql ${statement}`);
    },
    close() {},
  };
  return { db, state, sql, failOn };
}

// ─── Permit server seam ─────────────────────────────────────────────────────

interface PermitServer {
  fetchMock: jest.Mock;
  finalized: { url: string; body: Record<string, unknown> }[];
  /** When set, every finalize call rejects with this error. */
  finalizeFailure: Error | null;
}

function permitServer(): PermitServer {
  const server: PermitServer = {
    finalized: [],
    finalizeFailure: null,
    fetchMock: jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/analysis-permits')) {
        return jsonResponse({
          permit: {
            id: 'permit-1',
            accessSource: 'free',
            status: 'reserved',
            expiresAt: '2026-08-27T20:00:00.000Z',
          },
        });
      }
      if (url.includes('/finalize')) {
        server.finalized.push({
          url,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        if (server.finalizeFailure) throw server.finalizeFailure;
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  };
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

// ─── Real recorded-clip fixture ─────────────────────────────────────────────

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence();
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
    captureId: CAPTURE_ID,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

function arrange() {
  const fixture = faultDb();
  const { clip, sidecarJson } = swingClipWithSidecar();
  mockReadArtifact = async () => sidecarJson;
  const server = permitServer();
  (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
  return { ...fixture, clip, server };
}

function expectSingleRelease(server: PermitServer, outcome: string) {
  expect(server.finalized).toHaveLength(1);
  expect(server.finalized[0]!.url).toContain('/v1/analysis-permits/permit-1/');
  expect(server.finalized[0]!.body).toMatchObject({ outcome, ratingId: null });
}

describe('runCaptureAnalysis — permit is settled exactly once on every post-reservation exit', () => {
  beforeEach(() => {
    setActiveDataOwner(owner);
    mockAnalyzeCapture = null;
  });
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    mockAnalyzeCapture = null;
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('analyzeCapture THROWS after reservation → released once, error reaches the caller, nothing durable', async () => {
    const { db, state, clip, server } = arrange();
    mockAnalyzeCapture = async () => {
      throw new Error('injected: analyzeCapture');
    };

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'injected: analyzeCapture',
    );
    expectSingleRelease(server, 'failed');
    expect(state.records.get(CAPTURE_ID) ?? []).toHaveLength(0);
    expect(state.captureStatus.get(CAPTURE_ID)).toBe('awaiting_model');
    expect(state.shots).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });

  it('saveAnalysisRecord THROWS → released once, error reaches the caller, capture still retryable', async () => {
    const { db, state, clip, server, failOn } = arrange();
    failOn.set('INSERT INTO local_analysis_record', 'saveAnalysisRecord');

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'injected: saveAnalysisRecord',
    );
    expectSingleRelease(server, 'failed');
    expect(state.captureStatus.get(CAPTURE_ID)).toBe('awaiting_model');
    expect(state.shots).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });

  it('markCaptureAnalyzed THROWS → released once, error reaches the caller, no half-promoted rating', async () => {
    const { db, state, clip, server, failOn } = arrange();
    failOn.set(
      "UPDATE local_capture SET status = 'analyzed'",
      'markCaptureAnalyzed',
    );

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'injected: markCaptureAnalyzed',
    );
    expectSingleRelease(server, 'failed');
    expect(state.captureStatus.get(CAPTURE_ID)).toBe('awaiting_model');
    expect(state.shots).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });

  it('saveAnalysis THROWS → released once, error reaches the caller', async () => {
    const { db, state, clip, server, failOn } = arrange();
    failOn.set('INSERT OR REPLACE INTO local_shot', 'saveAnalysis');

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'injected: saveAnalysis',
    );
    expectSingleRelease(server, 'failed');
    expect(state.shots).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });

  it('a failing permits.release is swallowed and never masks the original error', async () => {
    const { db, clip, server, failOn } = arrange();
    failOn.set('INSERT OR REPLACE INTO local_shot', 'saveAnalysis');
    server.finalizeFailure = new Error('finalize unreachable');

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'injected: saveAnalysis',
    );
    // The release was attempted exactly once even though it failed.
    expect(server.finalized).toHaveLength(1);
  });
});

describe('runCaptureAnalysis — scored promotion is atomic with the capture status', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('a saveAnalysis failure leaves NO durable analysis record and the capture awaiting_model — retryable, not half-promoted', async () => {
    const { db, state, clip, server, failOn } = arrange();
    failOn.set('INSERT OR REPLACE INTO local_shot', 'saveAnalysis');

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'injected: saveAnalysis',
    );
    expect(state.records.get(CAPTURE_ID) ?? []).toHaveLength(0);
    expect(state.captureStatus.get(CAPTURE_ID)).toBe('awaiting_model');
    expect(state.shots).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
    expectSingleRelease(server, 'failed');
  });

  it('a shot.sync outbox failure rolls the whole promotion back — record, status and rating land together or not at all', async () => {
    const { db, state, clip, server, failOn } = arrange();
    failOn.set('INSERT INTO outbox', 'outbox');

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'injected: outbox',
    );
    expect(state.records.get(CAPTURE_ID) ?? []).toHaveLength(0);
    expect(state.captureStatus.get(CAPTURE_ID)).toBe('awaiting_model');
    expect(state.shots).toHaveLength(0);
    expectSingleRelease(server, 'failed');
  });

  it('a successful scored run commits record + analyzed status + rating + shot.sync in one transaction and consumes the permit', async () => {
    const { db, state, clip, server, sql } = arrange();

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;

    expect(state.records.get(CAPTURE_ID)).toEqual([outcome.analysisId]);
    expect(state.captureStatus.get(CAPTURE_ID)).toBe('analyzed');
    expect(state.shots.map(s => s.id)).toEqual([outcome.analysisId]);
    expect(state.outbox.map(o => o.kind)).toEqual(['shot.sync']);
    expect(state.outbox[0]!.payload['analysisPermitId']).toBe('permit-1');
    // Consumed by the durable shot.sync row — never explicitly finalized.
    expect(server.finalized).toHaveLength(0);

    // Every durable write of the promotion sits inside ONE transaction.
    const begin = sql.indexOf('BEGIN IMMEDIATE');
    const commit = sql.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    for (const fragment of [
      'INSERT INTO local_analysis_record',
      "UPDATE local_capture SET status = 'analyzed'",
      'INSERT OR REPLACE INTO local_shot',
      'INSERT INTO outbox',
    ]) {
      const index = sql.findIndex(s => s.includes(fragment));
      expect(index).toBeGreaterThan(begin);
      expect(index).toBeLessThan(commit);
    }
  });
});
