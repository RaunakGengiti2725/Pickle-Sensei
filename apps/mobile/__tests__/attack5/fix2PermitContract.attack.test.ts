/**
 * ADVERSARIAL PASS — fix round 2 (MAC-01) against
 * `origin/devin/fix2-mac-01-03-04-permit-leak` merged onto 3a134e80.
 *
 * The fix's contract (runCaptureAnalysis.ts, "Entitlement: reserve before
 * inference"): after `permits.reserve` resolves, EVERY exit either consumes
 * the permit or releases it exactly once, and a permit that cannot be
 * finalized "must never gate inference or a durable write" — it is turned
 * into a typed `unavailable` outcome, never a thrown exception.
 *
 * The real pipeline, repository and permit client run; only SQLite, the
 * sidecar reader and `fetch` are simulated. Titles carry the classification:
 * `[BREAK]` = the expectation is the fix's own contract and this commit
 * violates it; `[HELD]` = the attack did not get through.
 *
 * Baseline comparison (3a134e80, same test file): A1 also fails there —
 * the non-string id survived until `saveAnalysis` (repository.ts:151
 * `analysisPermitId.trim`), i.e. inference RAN on a permit that could never
 * be finalized. The candidate moves the TypeError before inference but still
 * lets it escape as a crash. Pre-existing, not a regression; the candidate's
 * own guard is where the typed outcome is promised and not delivered.
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

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { __esModule: true, ...actual };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '55555555-5555-4555-8555-555555555555';
const LOW_CONFIDENCE_VISIBILITY = 0.5;

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function recordingDb(fault?: (sql: string, index: number) => void): {
  db: LocalDb;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      fault?.(sql, calls.length - 1);
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
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

interface PermitServerOptions {
  /** The literal `permit` block the reserve call returns. */
  permit?: Record<string, unknown>;
  release?: 'ok' | 'reject_network' | 'http_500';
}

function permitServer(options: PermitServerOptions = {}) {
  const finalizeUrls: string[] = [];
  const finalizeBodies: unknown[] = [];
  const reserveBodies: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      reserveBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        permit: options.permit ?? {
          id: 'permit-fix2-1',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-04T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      finalizeUrls.push(url);
      finalizeBodies.push(JSON.parse(String(init?.body)));
      switch (options.release ?? 'ok') {
        case 'reject_network':
          throw new TypeError('Network request failed');
        case 'http_500':
          return jsonResponse(
            { error: { code: 'internal', message: 'boom' } },
            500,
          );
        default:
          return jsonResponse({ ok: true });
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, finalizeUrls, finalizeBodies, reserveBodies };
}

function swingClipWithSidecar(visibility: number | null = null): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const { sequence, window } = generateSwingSequence({});
  const dimmed =
    visibility === null
      ? sequence
      : {
          ...sequence,
          frames: sequence.frames.map(frame => ({
            ...frame,
            confidence: visibility,
            landmarks: frame.landmarks.map(mark => ({ ...mark, visibility })),
          })),
        };
  const sidecarJson = serializePoseSequence(dimmed);
  const clip: CapturedClip = {
    uri: 'file:///captures/fix2.mov',
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
      uri: 'file:///captures/fix2.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip, captureId = 'capture-fix2') {
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-fix2' },
    appVersion: '0.1.0',
  };
}

function setFetch(fetchMock: unknown) {
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

beforeEach(() => setActiveDataOwner(owner));
afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  setFetch(undefined);
  jest.restoreAllMocks();
});

// ─── A1: the new permit-id guard trusts the wire type ──────────────────────

describe('A1 — reserve 200 whose permit.id is not a string', () => {
  it.each([
    ['missing', {}],
    ['null', { id: null }],
    ['numeric', { id: 42 }],
  ])(
    '[BREAK][pre-existing on 3a134e80] permit.id %s → the fix promises a typed `unavailable` (no inference, no writes); instead the guard itself throws',
    async (_label, idField) => {
      const { db, calls } = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const server = permitServer({
        permit: {
          ...idField,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-04T20:00:00.000Z',
        },
      });
      setFetch(server.fetchMock);
      const analyzeSpy = jest.spyOn(pipeline, 'analyzeCapture');

      // Contract: the run RESOLVES with the same typed outcome the
      // whitespace-only id gets ('invalid analysis permit').
      const outcome = await runCaptureAnalysis(request(db, clip));
      expect(outcome.kind).toBe('unavailable');
      if (outcome.kind !== 'unavailable') return;
      expect(outcome.reason).toContain('invalid analysis permit');
      expect(analyzeSpy).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(server.finalizeUrls).toHaveLength(0);
    },
  );
});

// ─── Controls: the release boundary under ordering / fault variants ────────

describe('controls — release boundary variants', () => {
  it('[HELD] evaluatePreAnalysisGate throws after reservation → exactly one finalize(failed), original error escapes', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    setFetch(server.fetchMock);
    jest.spyOn(pipeline, 'evaluatePreAnalysisGate').mockImplementation(() => {
      throw new Error('gate exploded');
    });
    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'gate exploded',
    );
    expect(server.finalizeBodies).toEqual([
      { outcome: 'failed', ratingId: null },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('[HELD] analyzeCapture throws AND finalize rejects → the ORIGINAL error escapes (release failure never masks it)', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ release: 'reject_network' });
    setFetch(server.fetchMock);
    jest.spyOn(pipeline, 'analyzeCapture').mockImplementation(() => {
      throw new Error('inference exploded');
    });
    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'inference exploded',
    );
    expect(server.finalizeBodies).toHaveLength(1);
  });

  it('[HELD] saveLocalOnlyAnalysis throws AFTER the low_confidence release → no second finalize (no failed-after-low_confidence double release)', async () => {
    const { db } = recordingDb(sql => {
      if (sql.includes('INSERT OR REPLACE INTO local_shot')) {
        throw new Error('disk full');
      }
    });
    const { clip, sidecarJson } = swingClipWithSidecar(
      LOW_CONFIDENCE_VISIBILITY,
    );
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    setFetch(server.fetchMock);
    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'disk full',
    );
    expect(server.finalizeBodies).toEqual([
      { outcome: 'low_confidence', ratingId: null },
    ]);
  });

  it('[HELD] saveAnalysis (scored promotion) throws inside its transaction → one finalize(failed), no outbox entry', async () => {
    const { db, calls } = recordingDb(sql => {
      if (sql.includes('INSERT INTO outbox')) throw new Error('outbox locked');
    });
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    setFetch(server.fetchMock);
    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'outbox locked',
    );
    expect(server.finalizeBodies).toEqual([
      { outcome: 'failed', ratingId: null },
    ]);
    expect(calls.some(call => /ROLLBACK/i.test(call.sql))).toBe(true);
  });

  it('[HELD] 3 concurrent runs where the middle one throws: each permit finalized at most once, the failing one with `failed`', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar(
      LOW_CONFIDENCE_VISIBILITY,
    );
    mockReadArtifact = async () => sidecarJson;
    let reserveCount = 0;
    const finalizeBodies: Array<{ url: string; body: unknown }> = [];
    setFetch(
      jest.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/v1/analysis-permits')) {
          reserveCount += 1;
          return jsonResponse({
            permit: {
              id: `permit-c${reserveCount}`,
              accessSource: 'free',
              status: 'reserved',
              expiresAt: '2026-09-04T20:00:00.000Z',
            },
          });
        }
        if (url.includes('/finalize')) {
          finalizeBodies.push({ url, body: JSON.parse(String(init?.body)) });
          return jsonResponse({ ok: true });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const dbs = [0, 1, 2].map(i =>
      recordingDb(sql => {
        if (i === 1 && sql.includes('local_analysis_record')) {
          throw new Error('record write failed');
        }
      }),
    );
    const results = await Promise.allSettled(
      dbs.map(({ db }, i) =>
        runCaptureAnalysis(request(db, clip, `capture-c${i}`)),
      ),
    );
    expect(results.map(r => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    const byPermit = new Map<string, unknown[]>();
    for (const { url, body } of finalizeBodies) {
      const id = url.split('/analysis-permits/')[1]!.split('/finalize')[0]!;
      byPermit.set(id, [...(byPermit.get(id) ?? []), body]);
    }
    expect(byPermit.size).toBe(3);
    for (const bodies of byPermit.values()) expect(bodies).toHaveLength(1);
    expect(
      finalizeBodies.map(f => (f.body as { outcome: string }).outcome).sort(),
    ).toEqual(['failed', 'low_confidence', 'low_confidence']);
  });
});
