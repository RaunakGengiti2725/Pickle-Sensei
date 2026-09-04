/**
 * STRUCTURAL AUDIT #2 (mobile-analyze-capture) — permit accounting under
 * exceptions thrown AFTER the reservation.
 *
 * runCaptureAnalysis reserves a server permit before inference and promises
 * ("Permit accounting: EVERY non-scored outcome releases the reservation").
 * The release paths cover `!result.ok` and non-scored records, but the calls
 * between the reservation and the return — analyzeCapture,
 * saveAnalysisRecord, markCaptureAnalyzed, saveAnalysis — are not wrapped:
 * an exception there escapes with the reservation still held.
 *
 * Every case below drives the REAL pipeline (real generated pose sequence,
 * real sidecar hash, real fusion providers) and injects the failure at the
 * exact seam the hotspot names. Expectation = the documented contract.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

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
        ? mockAnalyzeCapture(...args)
        : actual.analyzeCapture(...args),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};
let mockAnalyzeCapture: ((...args: unknown[]) => Promise<unknown>) | null =
  null;

const owner = '11111111-1111-4111-8111-111111111111';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function recordingDb(failWhen?: (sql: string) => boolean): {
  db: LocalDb;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (failWhen?.(sql)) {
        throw new Error(`SQLITE_FULL: database or disk is full (${sql.slice(0, 32)})`);
      }
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

function permitServer(options?: { access?: unknown }): {
  fetchMock: jest.Mock;
  finalized: { permitId: string; body: unknown }[];
  reserved: number;
} {
  const finalized: { permitId: string; body: unknown }[] = [];
  const state = { reserved: 0 };
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      state.reserved += 1;
      return jsonResponse({
        permit: {
          id: `permit-${state.reserved}`,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-27T20:00:00.000Z',
        },
        ...(options && 'access' in options ? { access: options.access } : {}),
      });
    }
    const finalize = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
    if (finalize) {
      finalized.push({
        permitId: decodeURIComponent(finalize[1]!),
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return {
    fetchMock,
    finalized,
    get reserved() {
      return state.reserved;
    },
  };
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
    uri: 'file:///captures/stroke-audit.mov',
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
      uri: 'file:///captures/stroke-audit.pose.json',
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
    captureId: 'capture-audit-1',
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

describe('runCaptureAnalysis permit accounting after reservation (audit)', () => {
  beforeEach(() => {
    setActiveDataOwner(owner);
    mockAnalyzeCapture = null;
  });
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('control: a scored run reserves exactly one permit and never finalizes it', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    expect(server.reserved).toBe(1);
    expect(server.finalized).toHaveLength(0);
  });

  it('analyzeCapture THROWS after reservation → the permit must be released (failed)', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    mockAnalyzeCapture = async () => {
      throw new Error('TypeError: Cannot read properties of undefined');
    };
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const settled = await runCaptureAnalysis(request(db, clip)).then(
      outcome => ({ ok: true as const, outcome }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(server.reserved).toBe(1);
    // Contract: EVERY non-scored outcome releases the reservation.
    expect(server.finalized).toEqual([
      expect.objectContaining({
        permitId: 'permit-1',
        body: expect.objectContaining({ outcome: 'failed', ratingId: null }),
      }),
    ]);
    // Nothing durable was written for a run that produced no record.
    expect(calls.filter(c => c.sql.includes('INSERT INTO outbox'))).toHaveLength(0);
    // Observation only (the outer wrapper documents rethrow after telemetry):
    // the exception escapes to the caller rather than becoming `unavailable`.
    expect(settled.ok).toBe(false);
  });

  it('saveAnalysisRecord THROWS (e.g. SQLITE_FULL) after a scored inference → the permit must be released', async () => {
    const { db, calls } = recordingDb(sql =>
      sql.includes('local_analysis_record'),
    );
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const settled = await runCaptureAnalysis(request(db, clip)).then(
      outcome => ({ ok: true as const, outcome }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(server.reserved).toBe(1);
    // The rating was never promoted (no local_shot, no outbox), so the
    // reservation must not stay held: it should be finalized by the client.
    expect(calls.filter(c => c.sql.includes('INSERT INTO outbox'))).toHaveLength(0);
    expect(calls.filter(c => c.sql.includes('local_shot'))).toHaveLength(0);
    expect(server.finalized.map(f => f.permitId)).toEqual(['permit-1']);
    expect(settled.ok).toBe(false);
  });

  it('saveAnalysis (local_shot + outbox promotion) THROWS → the permit must be released, never left reserved with no rating bound to it', async () => {
    const { db, calls } = recordingDb(sql =>
      sql.includes('INSERT OR REPLACE INTO local_shot'),
    );
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const settled = await runCaptureAnalysis(request(db, clip)).then(
      outcome => ({ ok: true as const, outcome }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(server.reserved).toBe(1);
    expect(calls.filter(c => c.sql.includes('INSERT INTO outbox'))).toHaveLength(0);
    expect(server.finalized.map(f => f.permitId)).toEqual(['permit-1']);
    expect(settled.ok).toBe(false);
  });

  it('VERIFY: a reserve response without an access block degrades to freeLimitReached=false (documented parseReserveAccess behaviour, not a defect)', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ access: null });
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.freeLimitReached).toBe(false);
  });

  it('VERIFY: the final free permit (access.availableToReserve === 0) sets freeLimitReached=true', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({
      access: {
        premium: false,
        freeRatings: {
          limit: 2,
          used: 1,
          reserved: 1,
          remaining: 1,
          availableToReserve: 0,
        },
      },
    });
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.freeLimitReached).toBe(true);
  });

  it('VERIFY: a reservation whose status is not "reserved" is a retryable unavailable — no inference, no record', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/v1/analysis-permits')) {
        return jsonResponse({
          permit: {
            id: 'permit-x',
            accessSource: 'free',
            status: 'released',
            expiresAt: '2026-08-27T20:00:00.000Z',
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('VERIFY: a signed-out apiConfig (token null) never reaches the network and stays a retryable unavailable', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis({
      ...request(db, clip),
      apiConfig: { baseUrl: '', token: null },
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
