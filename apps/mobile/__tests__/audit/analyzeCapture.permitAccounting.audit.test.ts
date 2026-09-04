/**
 * AUDIT HARNESS (mobile-analyze-capture execution pass, cloud plane).
 *
 * Adversarial permit-accounting probes for `runCaptureAnalysis`: what
 * happens to a RESERVED analysis permit when a step AFTER the reservation
 * throws (local persistence failure, sidecar read failure)? The product
 * rule is "abstentions release the permit instead of burning it" and "a
 * lost release is not a lost rating" (server sweeps after 24h) — these
 * tests characterize the exact client behaviour on those paths so the
 * coordinator can decide whether a 24h stranded reservation is acceptable
 * for a two-lifetime-free-ratings account.
 *
 * New file only; production code and existing tests are untouched.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';

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

interface DbCall {
  sql: string;
  params: unknown[];
}

function faultingDb(failWhenSqlIncludes: string | null): {
  db: LocalDb;
  calls: DbCall[];
} {
  const calls: DbCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params: params as unknown[] });
      if (failWhenSqlIncludes && sql.includes(failWhenSqlIncludes)) {
        throw new Error(
          `SQLITE_FULL: simulated failure on ${failWhenSqlIncludes}`,
        );
      }
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

interface PermitServer {
  fetchMock: jest.Mock;
  reserves: number;
  releases: Array<{ permitId: string; outcome: unknown }>;
}

function permitServer(): PermitServer {
  const server: PermitServer = {
    fetchMock: jest.fn(),
    reserves: 0,
    releases: [],
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
            expiresAt: '2026-08-27T20:00:00.000Z',
          },
          access: {
            premium: false,
            freeRatings: { availableToReserve: 1 },
          },
        });
      }
      const finalize = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
      if (finalize) {
        server.releases.push({
          permitId: finalize[1]!,
          outcome: JSON.parse(String(init?.body)),
        });
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  return server;
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
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
    appVersion: '1.0',
  };
}

describe('AUDIT runCaptureAnalysis — permit accounting when a post-reserve step throws', () => {
  beforeEach(() => {
    setActiveDataOwner(owner);
    stabilitySlo.reset();
  });
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('baseline: a healthy scored run reserves exactly one permit and never calls finalize', async () => {
    const { db } = faultingDb(null);
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    expect(server.reserves).toBe(1);
    expect(server.releases).toHaveLength(0);
  });

  it('CHARACTERIZATION: local_analysis_record insert failure after a successful analysis rethrows and leaves the reserved permit un-released (client relies on the 24h server sweep)', async () => {
    const { db, calls } = faultingDb('local_analysis_record');
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      /SQLITE_FULL/,
    );
    // The permit WAS reserved…
    expect(server.reserves).toBe(1);
    // …and no release/finalize was attempted for it on the exception path.
    expect(server.releases).toHaveLength(0);
    // Nothing durable was written (the failing statement was the first write).
    expect(
      calls.some(call =>
        call.sql.includes('INSERT OR REPLACE INTO local_shot'),
      ),
    ).toBe(false);
    // Telemetry classifies this as an exception failure, not a completion.
    const kinds = stabilitySlo.events().map(event => event.kind);
    expect(kinds).toContain('analysis_failed');
    expect(kinds).not.toContain('analysis_completed');
    expect(
      stabilitySlo
        .events()
        .some(
          event =>
            event.kind === 'analysis_failed' &&
            event.failureKind === 'exception',
        ),
    ).toBe(true);
  });

  it('CHARACTERIZATION: local_shot promotion failure after the record was appended rethrows with the permit still reserved and the capture already marked analyzed', async () => {
    const { db, calls } = faultingDb('INSERT OR REPLACE INTO local_shot');
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      /SQLITE_FULL/,
    );
    expect(server.reserves).toBe(1);
    expect(server.releases).toHaveLength(0);
    // The immutable record and the status flip both landed before the throw.
    expect(calls.some(call => call.sql.includes('local_analysis_record'))).toBe(
      true,
    );
    expect(
      calls.some(call => call.sql.includes("SET status = 'analyzed'")),
    ).toBe(true);
    // The outbox entry carrying analysisPermitId was never written, so the
    // permit will not be consumed by sync either.
    expect(calls.some(call => call.sql.includes('INSERT INTO outbox'))).toBe(
      false,
    );
  });

  it('a retry after the local persistence failure reserves a SECOND permit (the first stays reserved server-side)', async () => {
    const failing = faultingDb('local_analysis_record');
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    await expect(
      runCaptureAnalysis(request(failing.db, clip)),
    ).rejects.toThrow();
    const healthy = faultingDb(null);
    const retry = await runCaptureAnalysis(request(healthy.db, clip));
    expect(retry.kind).toBe('scored');
    expect(server.reserves).toBe(2);
    expect(server.releases).toHaveLength(0);
    const outbox = healthy.calls.find(call =>
      call.sql.includes('INSERT INTO outbox'),
    );
    expect(outbox).toBeDefined();
    expect(JSON.parse(String(outbox!.params[1])).analysisPermitId).toBe(
      'permit-2',
    );
  });

  it('sidecar read failure is an honest unavailable outcome BEFORE any permit is reserved', async () => {
    const { db, calls } = faultingDb(null);
    const { clip } = swingClipWithSidecar();
    mockReadArtifact = async () => {
      throw new Error('ENOENT: sidecar missing');
    };
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('could not be read');
    expect(server.reserves).toBe(0);
    expect(calls).toHaveLength(0);
    expect(
      stabilitySlo
        .events()
        .some(
          event =>
            event.kind === 'analysis_failed' &&
            event.failureKind === 'unavailable',
        ),
    ).toBe(true);
  });

  it('a permit release that itself fails (finalize 500) is swallowed: the honest unavailable outcome still returns and nothing is synced', async () => {
    const { db, calls } = faultingDb(null);
    const { clip, sidecarJson } = swingClipWithSidecar();
    // Freeze all wrists: no motion → the pipeline abstains → release path.
    const frozen = JSON.parse(sidecarJson) as {
      frames: Array<{ l: Array<{ n: unknown; x: number; y: number }> }>;
    };
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
    if (clip.captureMode !== 'automatic_pose_trigger')
      throw new Error('fixture');
    const frozenClip: CapturedClip = {
      ...clip,
      poseSequence: { ...clip.poseSequence!, sha256: sha256Hex(frozenJson) },
    };
    const server = permitServer();
    let finalizeAttempts = 0;
    server.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/analysis-permits')) {
        server.reserves += 1;
        return jsonResponse({
          permit: {
            id: `permit-${server.reserves}`,
            accessSource: 'free',
            status: 'reserved',
            expiresAt: '2026-08-27T20:00:00.000Z',
          },
          access: { premium: false, freeRatings: { availableToReserve: 1 } },
        });
      }
      if (url.includes('/finalize')) {
        finalizeAttempts += 1;
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({
            error: { code: 'server.error', message: 'boom' },
          }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, frozenClip));
    expect(outcome.kind).toBe('unavailable');
    expect(server.reserves).toBe(1);
    // Exactly one release attempt; its failure is swallowed, not retried.
    expect(finalizeAttempts).toBe(1);
    expect(
      calls.filter(call => call.sql.includes('INSERT INTO outbox')),
    ).toHaveLength(0);
  });
});
