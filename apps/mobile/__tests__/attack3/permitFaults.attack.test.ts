/**
 * ADVERSARIAL PASS 3 / mobile-analyze-capture — permit accounting under
 * post-reservation faults in `runCaptureAnalysis`.
 *
 * Attacks (against 4d812e1a):
 *  S1  saveAnalysis (scored promotion) rejects → is the record half-promoted,
 *      and what happens to the reserved permit?
 *  S2  saveAnalysisRecord rejects after a successful analyzeCapture → is the
 *      permit released, and does the caller get an `unavailable` outcome
 *      rather than a thrown exception?
 *  S4  analyzeCapture throws after permits.reserve resolves → is
 *      permits.release called?
 *
 * The real analysis pipeline, the real repository, and the real permit client
 * run; only SQLite (`LocalDb`), the sidecar reader and `fetch` are faked so
 * faults can be injected at exact statements.
 *
 * MAC-01 contract (the pins below assert it): every exit after a successful
 * `permits.reserve` either consumes the permit (scored path fully promoted)
 * or finalizes it exactly once — a throw releases with outcome 'failed'
 * BEFORE the exception escapes runCaptureAnalysis.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import * as pipeline from '@pickle/analysis-pipeline';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

// analyzeCapture is re-exported from the pipeline index; spying on the module
// namespace lets S4 make it throw AFTER the permit has been reserved without
// touching the rest of the real pipeline.
jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { __esModule: true, ...actual };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '33333333-3333-4333-8333-333333333333';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

/** A LocalDb that records every statement and can reject statements whose
 * SQL matches `failWhen` (the injected fault), optionally only the Nth match. */
function faultDb(
  failWhen: (sql: string, index: number) => boolean,
  error: Error = new Error('SQLITE_FULL: database or disk is full'),
): { db: LocalDb; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      const index = calls.length;
      calls.push({ sql, params });
      if (failWhen(sql, index)) throw error;
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

interface PermitServer {
  fetchMock: jest.Mock;
  reserves: number;
  finalized: Array<{ permitId: string; body: unknown }>;
}

function permitServer(): PermitServer {
  const server: PermitServer = {
    reserves: 0,
    finalized: [],
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
            expiresAt: '2026-09-04T20:00:00.000Z',
          },
        });
      }
      const finalize = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
      if (finalize) {
        server.finalized.push({
          permitId: decodeURIComponent(finalize[1]!),
          body: JSON.parse(String(init?.body)),
        });
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
    uri: 'file:///captures/attack3-permit.mov',
    durationMs: window.endMs,
    fps: 60,
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
      uri: 'file:///captures/attack3-permit.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip, captureId = 'capture-a3') {
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

const sqlOf = (calls: RecordedCall[]) => calls.map(c => c.sql.trim());

const FAILED_RELEASE = {
  permitId: 'permit-1',
  body: { outcome: 'failed', ratingId: null },
};

describe('ATTACK S1 — saveAnalysis (scored promotion) rejects', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
    jest.restoreAllMocks();
  });

  it('local_shot insert fails inside the promotion transaction → transaction rolled back, no outbox row; permit released once (failed) before the exception escapes runCaptureAnalysis', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const { db, calls } = faultDb(sql =>
      sql.includes('INSERT OR REPLACE INTO local_shot'),
    );

    const run = runCaptureAnalysis(request(db, clip));

    // The exception propagates out of runCaptureAnalysis (the outer wrapper
    // records analysis_failed and rethrows) — the caller (AnalyzeScreen catch
    // → stage 'analysis' error) handles it; the permit is settled first.
    await expect(run).rejects.toThrow(/SQLITE_FULL/);

    const sql = sqlOf(calls);
    // The immutable analysis record and the capture status were written
    // BEFORE the promotion — they are durable while the rating is not.
    expect(
      sql.some(s => s.startsWith('INSERT INTO local_analysis_record')),
    ).toBe(true);
    expect(sql.some(s => s.includes("SET status = 'analyzed'"))).toBe(true);
    // The promotion transaction itself is atomic: BEGIN → failed insert →
    // ROLLBACK, no outbox row. (HELD: no half-promoted local_shot/outbox.)
    expect(sql).toContain('BEGIN IMMEDIATE');
    expect(sql).toContain('ROLLBACK');
    expect(sql.some(s => s.startsWith('INSERT INTO outbox'))).toBe(false);

    // Permit state: reserved exactly once …
    expect(server.reserves).toBe(1);
    // … and released exactly once with outcome 'failed' — the rating that
    // would have consumed it via shot sync does not exist, so the reserve
    // must not sit against the user's allowance until the server sweep.
    expect(server.finalized).toEqual([FAILED_RELEASE]);
  });

  it('outbox insert fails (second statement of the promotion transaction) → rollback removes the local_shot write too; permit released once (failed)', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const { db, calls } = faultDb(sql => sql.includes('INSERT INTO outbox'));

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      /SQLITE_FULL/,
    );

    const sql = sqlOf(calls);
    const begin = sql.indexOf('BEGIN IMMEDIATE');
    const rollback = sql.indexOf('ROLLBACK');
    expect(begin).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(begin);
    // local_shot was written inside the transaction and is undone by the
    // ROLLBACK — nothing is half-promoted at the SQLite level.
    expect(
      sql.findIndex(s => s.startsWith('INSERT OR REPLACE INTO local_shot')),
    ).toBeGreaterThan(begin);
    expect(sql.some(s => s === 'COMMIT')).toBe(false);
    expect(server.reserves).toBe(1);
    expect(server.finalized).toEqual([FAILED_RELEASE]);
  });

  it('COMMIT itself fails → ROLLBACK is attempted, exception escapes after the permit is released once (failed); analysis record already durable', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const { db, calls } = faultDb(sql => sql.trim() === 'COMMIT');

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      /SQLITE_FULL/,
    );
    const sql = sqlOf(calls);
    expect(sql).toContain('ROLLBACK');
    expect(server.finalized).toEqual([FAILED_RELEASE]);
    expect(server.reserves).toBe(1);
  });
});

describe('ATTACK S2 — saveAnalysisRecord rejects after a successful analyzeCapture', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
    jest.restoreAllMocks();
  });

  it('exception escapes as a throw (NOT an `unavailable` outcome) only AFTER the reserved permit is released once (failed)', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const { db, calls } = faultDb(sql =>
      sql.includes('INSERT INTO local_analysis_record'),
    );

    let outcome: unknown = null;
    let thrown: unknown = null;
    try {
      outcome = await runCaptureAnalysis(request(db, clip));
    } catch (error) {
      thrown = error;
    }

    // A persistence fault is not a typed inference outcome: it is rethrown
    // (the outer wrapper records analysis_failed) — but never with the
    // permit still reserved.
    expect(outcome).toBeNull();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/SQLITE_FULL/);

    // Nothing after the failed record insert ran: the capture is still
    // 'awaiting_model' and no rating was promoted (good), …
    const sql = sqlOf(calls);
    expect(sql.some(s => s.includes("SET status = 'analyzed'"))).toBe(false);
    expect(
      sql.some(s => s.startsWith('INSERT OR REPLACE INTO local_shot')),
    ).toBe(false);
    expect(sql.some(s => s.startsWith('INSERT INTO outbox'))).toBe(false);
    // … and the permit reserved for this run is finalized exactly once with
    // 'failed' — the same release an inference failure issues.
    expect(server.reserves).toBe(1);
    expect(server.finalized).toEqual([FAILED_RELEASE]);
    // The release is issued BEFORE the exception escapes: by the time the
    // caller observes the throw, the finalize request has been sent.
    expect(
      server.fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/finalize'),
      ),
    ).toHaveLength(1);
  });

  it('markCaptureAnalyzed rejects after the record insert → record durable, capture stays awaiting_model, permit released once (failed), exception escapes', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const { db, calls } = faultDb(sql =>
      sql.includes("SET status = 'analyzed'"),
    );

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      /SQLITE_FULL/,
    );
    const sql = sqlOf(calls);
    expect(
      sql.some(s => s.startsWith('INSERT INTO local_analysis_record')),
    ).toBe(true);
    expect(
      sql.some(s => s.startsWith('INSERT OR REPLACE INTO local_shot')),
    ).toBe(false);
    expect(server.reserves).toBe(1);
    expect(server.finalized).toEqual([FAILED_RELEASE]);
  });

  it('CONTROL: an inference failure (frozen wrists) releases the permit with outcome "failed" and returns `unavailable` — the same contract the persistence faults above now honour', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    const frozen = JSON.parse(sidecarJson);
    for (const frame of frozen.frames) {
      for (const mark of frame.l) {
        if (String(mark.n).endsWith('wrist')) {
          mark.x = 0.5;
          mark.y = 0.5;
        }
      }
    }
    const frozenJson = JSON.stringify(frozen);
    mockReadArtifact = async () => frozenJson;
    const frozenClip = {
      ...clip,
      poseSequence: {
        ...(clip.captureMode === 'automatic_pose_trigger'
          ? clip.poseSequence!
          : (undefined as never)),
        sha256: sha256Hex(frozenJson),
      },
    } as CapturedClip;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const { db } = faultDb(() => false);

    const outcome = await runCaptureAnalysis(request(db, frozenClip));
    expect(outcome.kind).toBe('unavailable');
    expect(server.finalized).toEqual([
      {
        permitId: 'permit-1',
        body: { outcome: 'failed', ratingId: null },
      },
    ]);
  });
});

describe('ATTACK S4 — analyzeCapture throws after permits.reserve resolved', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
    jest.restoreAllMocks();
  });

  it('permits.release(permitId, "failed") is called exactly once and the exception escapes after it', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const { db, calls } = faultDb(() => false);

    const analyzeSpy = jest
      .spyOn(pipeline, 'analyzeCapture')
      .mockImplementation(() => {
        // Only reachable after reserve — assert ordering explicitly.
        expect(server.reserves).toBe(1);
        throw new TypeError(
          "Cannot read properties of undefined (reading 'frames')",
        );
      });

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      /Cannot read properties of undefined/,
    );
    expect(analyzeSpy).toHaveBeenCalledTimes(1);
    expect(server.reserves).toBe(1);
    // No durable write of any kind …
    expect(calls).toHaveLength(0);
    // … and the reserve is finalized exactly once with 'failed'.
    expect(server.finalized).toEqual([FAILED_RELEASE]);
    expect(
      server.fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/finalize'),
      ),
    ).toHaveLength(1);
  });

  it('analyzeCapture REJECTS asynchronously (returned promise) — same single failed release', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const { db } = faultDb(() => false);
    jest
      .spyOn(pipeline, 'analyzeCapture')
      .mockImplementation(
        () =>
          Promise.reject(new Error('pipeline crashed mid-inference')) as never,
      );

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      /pipeline crashed/,
    );
    expect(server.reserves).toBe(1);
    expect(server.finalized).toEqual([FAILED_RELEASE]);
  });

  it('rapid repeat: five back-to-back runs whose analyzeCapture throws release all five reserved permits (one failed release each)', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const { db } = faultDb(() => false);
    jest.spyOn(pipeline, 'analyzeCapture').mockImplementation(() => {
      throw new Error('boom');
    });

    for (let i = 0; i < 5; i += 1) {
      await expect(
        runCaptureAnalysis(request(db, clip, `cap-${i}`)),
      ).rejects.toThrow('boom');
    }
    expect(server.reserves).toBe(5);
    expect(server.finalized).toEqual(
      [1, 2, 3, 4, 5].map(n => ({
        permitId: `permit-${n}`,
        body: { outcome: 'failed', ratingId: null },
      })),
    );
  });
});
