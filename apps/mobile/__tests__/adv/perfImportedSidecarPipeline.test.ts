/**
 * ADVERSARY (performance-bounds): the imported-video analysis pipeline at
 * the 60-second import cap.
 *
 * The native extraction receipt admits up to MAX_IMPORTED_POSE_FRAMES (4000)
 * frames, and the product caps imports at 60 s. A 60 s @ 60 fps import is
 * therefore a legitimate, supported sidecar of ~3600 frames × 17 landmarks.
 * `runCaptureAnalysis` reads, hashes, parses and fuses that sidecar on the
 * JS thread. Probed here:
 *  - wall time and scaling from a 15 s import to the 60 s cap (a quadratic
 *    stage would show up as a super-linear ratio well above 4x);
 *  - how many times the sidecar bytes are read from disk and SHA-256 hashed
 *    per analysis — every extra pass over a multi-megabyte file is paid on
 *    the JS thread of an entry-level iPhone.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import * as swingDomain from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import { MAX_IMPORTED_POSE_FRAMES } from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../../testSupport/sqlite';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

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

// Count every SHA-256 the pipeline computes; the real implementation runs.
jest.mock('@pickle/swing-domain', () => {
  const actual = jest.requireActual<typeof swingDomain>('@pickle/swing-domain');
  const inputs: Array<{ input: string; ms: number }> = [];
  return {
    ...actual,
    sha256Hex: (input: string) => {
      const start = performance.now();
      const digest = actual.sha256Hex(input);
      inputs.push({ input, ms: performance.now() - start });
      return digest;
    },
    __hashInputs: inputs,
  };
});
const { __hashInputs: hashInputs } = jest.requireMock(
  '@pickle/swing-domain',
) as {
  __hashInputs: Array<{ input: string; ms: number }>;
};

const owner = '55555555-5555-4555-8555-555555555555';
/** Generous absolute ceiling for one analysis of the largest supported
 * import in V8 on the CI box (Hermes on device is several times slower). */
const MAX_IMPORT_ANALYSIS_BUDGET_MS = 20_000;
/** 3600 / 900 frames = 4x the input; anything beyond 2x that ratio means a
 * stage is not linear in the frame count. */
const MAX_SCALING_RATIO = 8;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function permitServer(): jest.Mock {
  return jest.fn(async (url: string) => {
    if (url.endsWith('/v1/analysis-permits')) {
      return jsonResponse({
        permit: {
          id: '66666666-6666-4666-8666-666666666666',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-30T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) return jsonResponse({ ok: true });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

/** A synthetic imported swing padded with a long ready/recover phase so the
 * clip runs `seconds` long at 60 fps — the way a real 60 s import looks
 * when the stroke sits in the middle of the footage. */
function longImport(seconds: number): {
  clip: CapturedClip;
  sidecarJson: string;
  frameCount: number;
} {
  const swingMs = 1_200;
  const padMs = Math.max(0, (seconds * 1000 - swingMs) / 2);
  const { sequence, window } = generateSwingSequence({
    fps: 60,
    readyMs: padMs,
    recoverMs: padMs,
  });
  const sidecarJson = swingDomain.serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///imports/long-${seconds}s.mov`,
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    posterUri: `file:///imports/long-${seconds}s.poster.jpg`,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///imports/long-${seconds}s.pose.json`,
      frameCount: sequence.frames.length,
      sha256: swingDomain.sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson, frameCount: sequence.frames.length };
}

function request(db: LocalDb, clip: CapturedClip, captureId: string) {
  seedSqliteCapture(db, owner, captureId, clip);
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
    targetSeed: {
      point: { x: 0.42, y: 0.63 },
      selectedAtIso: '2026-08-30T10:01:00.000Z',
    },
  };
}

async function analyzeTimed(seconds: number, captureId: string) {
  const { db } = createSqliteTestDb();
  const { clip, sidecarJson, frameCount } = longImport(seconds);
  let reads = 0;
  mockReadArtifact = async () => {
    reads += 1;
    return sidecarJson;
  };
  // The clip built above hashed the sidecar once itself; count from here.
  const hashesBefore = hashInputs.length;
  const sidecarHashPasses = () =>
    hashInputs.slice(hashesBefore).filter(entry => entry.input === sidecarJson);
  (globalThis as { fetch?: unknown }).fetch = permitServer();
  const start = performance.now();
  const outcome = await runCaptureAnalysis(request(db, clip, captureId));
  const ms = performance.now() - start;
  const result = {
    outcome,
    ms,
    reads,
    sidecarHashes: sidecarHashPasses().length,
    sidecarHashMs: sidecarHashPasses().reduce(
      (sum, entry) => sum + entry.ms,
      0,
    ),
    frameCount,
    sidecarBytes: sidecarJson.length,
  };
  return result;
}

describe('ADV perf: imported sidecar pipeline at the 60 s import cap', () => {
  beforeEach(() => {
    setActiveDataOwner(owner);
    establishApiSession({
      canonicalAppUserId: owner,
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      provider: 'apple',
    });
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('analyzes the largest supported import (60 s @ 60 fps) inside the budget and scales linearly from 15 s', async () => {
    const small = await analyzeTimed(
      15,
      '77777777-7777-4777-8777-000000000015',
    );
    const large = await analyzeTimed(
      60,
      '77777777-7777-4777-8777-000000000060',
    );
    console.warn(
      `[adv] 15s import: ${small.frameCount} frames, ${small.sidecarBytes} B, ${small.ms.toFixed(0)} ms, outcome=${small.outcome.kind}`,
    );
    console.warn(
      `[adv] 60s import: ${large.frameCount} frames, ${large.sidecarBytes} B, ${large.ms.toFixed(0)} ms, outcome=${large.outcome.kind}`,
    );
    expect(large.frameCount).toBeLessThanOrEqual(MAX_IMPORTED_POSE_FRAMES);
    expect(large.frameCount).toBeGreaterThan(3_500);
    expect(['scored', 'low_confidence']).toContain(small.outcome.kind);
    expect(['scored', 'low_confidence']).toContain(large.outcome.kind);
    expect(large.ms).toBeLessThan(MAX_IMPORT_ANALYSIS_BUDGET_MS);
    expect(large.ms / Math.max(small.ms, 1)).toBeLessThan(MAX_SCALING_RATIO);
  });

  it('reads and hashes the multi-megabyte sidecar once per analysis', async () => {
    const run = await analyzeTimed(60, '77777777-7777-4777-8777-000000000061');
    console.warn(
      `[adv] 60s import: sidecar read ${run.reads}x, sha256 over sidecar ${run.sidecarHashes}x (${run.sidecarHashMs.toFixed(0)} ms total on the JS thread)`,
    );
    expect(['scored', 'low_confidence']).toContain(run.outcome.kind);
    expect(run.reads).toBe(1);
    expect(run.sidecarHashes).toBe(1);
  });

  it('cancelling right after the 60 s sidecar is read skips inference and reserves no permit', async () => {
    const { db } = createSqliteTestDb();
    const { clip, sidecarJson } = longImport(60);
    const controller = new AbortController();
    mockReadArtifact = async () => {
      controller.abort();
      return sidecarJson;
    };
    const fetchMock = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const start = performance.now();
    const outcome = await runCaptureAnalysis({
      ...request(db, clip, '77777777-7777-4777-8777-000000000062'),
      signal: controller.signal,
    });
    const ms = performance.now() - start;
    console.warn(
      `[adv] abort after sidecar read: outcome=${outcome.kind}/${'cause' in outcome ? outcome.cause : '-'} in ${ms.toFixed(0)} ms, ${fetchMock.mock.calls.length} permit request(s)`,
    );
    expect(outcome).toMatchObject({ kind: 'unavailable', cause: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ms).toBeLessThan(1_000);
  });
});
