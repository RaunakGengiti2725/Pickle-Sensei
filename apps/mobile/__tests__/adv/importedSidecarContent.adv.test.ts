/**
 * ADVERSARY (INT-import-media-capture): malformed / hostile pose-sidecar
 * CONTENT that still passes the byte-identity hash (the attacker controls the
 * file, so the recorded sha256 matches) and the canonical parser.
 *
 * The imported-video gate trusts a sidecar once its hash matches and it
 * parses. These attacks probe what the parser lets through into scoring:
 * unknown joints, duplicated joints, off-image coordinates, a single frame,
 * a landmark flood (resource bound), and metadata that disagrees with the
 * clip. Honest outcome: refused (unavailable / quality_blocked) or, where the
 * engine legitimately scores, no permit finalized as scored for garbage.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
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

const owner = '33333333-3333-4333-8333-333333333333';
const captureId = '77777777-7777-4777-8777-777777777777';

interface PermitServer {
  fetchMock: jest.Mock;
  finalized: Array<{ outcome?: string }>;
}

function permitServer(): PermitServer {
  const server: PermitServer = { finalized: [], fetchMock: jest.fn() };
  server.fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
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
    if (url.includes('/finalize')) {
      server.finalized.push(
        JSON.parse(String(init?.body)) as { outcome?: string },
      );
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
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

type ImportedClip = Extract<CapturedClip, { captureMode: 'imported_video' }>;

function importedClip(
  sidecarJson: string,
  sequence: PoseSequence,
  durationMs: number,
  overrides: Partial<ImportedClip> = {},
): ImportedClip {
  return {
    uri: 'file:///imports/rally-clip.mov',
    durationMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///imports/rally-clip.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
    ...overrides,
  };
}

function request(db: LocalDb, clip: CapturedClip) {
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

async function attack(sequence: PoseSequence, durationMs: number) {
  const { db } = createSqliteTestDb();
  const sidecarJson = serializePoseSequence(sequence);
  const clip = importedClip(sidecarJson, sequence, durationMs);
  mockReadArtifact = async () => sidecarJson;
  const server = permitServer();
  (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
  const outcome = await runCaptureAnalysis(request(db, clip));
  return { outcome, server, sidecarJson };
}

function scoredFinalizations(server: PermitServer): number {
  return server.finalized.filter(entry => entry.outcome === 'scored').length;
}

describe('ADV imported sidecar content that survives hash + parse', () => {
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

  it('ATTACK E1: every landmark is renamed to an unknown joint -> no human pose, must not score', async () => {
    const { sequence, window } = generateSwingSequence();
    const renamed: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        landmarks: frame.landmarks.map((mark, index) => ({
          ...mark,
          name: `alien_joint_${index}`,
        })),
      })),
    };
    const { outcome, server } = await attack(renamed, window.endMs);
    expect(['unavailable', 'quality_blocked']).toContain(outcome.kind);
    expect(scoredFinalizations(server)).toBe(0);
  });

  it('ATTACK E2: each frame carries every joint TWICE with contradictory coordinates -> ambiguous evidence must be refused', async () => {
    const { sequence, window } = generateSwingSequence();
    const doubled: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        landmarks: [
          ...frame.landmarks,
          ...frame.landmarks.map(mark => ({
            ...mark,
            x: 1 - mark.x,
            y: 1 - mark.y,
          })),
        ],
      })),
    };
    const { outcome, server } = await attack(doubled, window.endMs);
    expect(['unavailable', 'quality_blocked']).toContain(outcome.kind);
    expect(scoredFinalizations(server)).toBe(0);
  });

  it('ATTACK E3: landmarks sit a million image-widths off screen -> not on-image evidence, must not score', async () => {
    const { sequence, window } = generateSwingSequence();
    const offscreen: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        landmarks: frame.landmarks.map(mark => ({
          ...mark,
          x: mark.x + 1_000_000,
          y: mark.y - 1_000_000,
        })),
      })),
    };
    const { outcome, server } = await attack(offscreen, window.endMs);
    expect(['unavailable', 'quality_blocked']).toContain(outcome.kind);
    expect(scoredFinalizations(server)).toBe(0);
  });

  it('ATTACK E4: a single-frame sidecar for a multi-second clip -> no motion, must not score', async () => {
    const { sequence, window } = generateSwingSequence();
    const single: PoseSequence = {
      ...sequence,
      frames: sequence.frames.slice(0, 1),
    };
    const { outcome, server } = await attack(single, window.endMs);
    expect(['unavailable', 'quality_blocked']).toContain(outcome.kind);
    expect(scoredFinalizations(server)).toBe(0);
  });

  it('ATTACK E5: landmark flood (1000 extra joints per frame) is bounded -> finishes with a known outcome, no crash', async () => {
    const { sequence, window } = generateSwingSequence();
    const flooded: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        landmarks: [
          ...frame.landmarks,
          ...Array.from({ length: 1000 }, (_, index) => ({
            name: `flood_${index}`,
            x: 0.5,
            y: 0.5,
            visibility: 1,
          })),
        ],
      })),
    };
    const startedAt = Date.now();
    const { outcome, sidecarJson } = await attack(flooded, window.endMs);
    const elapsedMs = Date.now() - startedAt;
    // Evidence for the report: sidecar size and wall time are logged, never
    // asserted with an inflated timeout.
    console.info(
      `[ADV E5] sidecar bytes=${sidecarJson.length} elapsedMs=${elapsedMs} outcome=${outcome.kind}`,
    );
    expect([
      'unavailable',
      'quality_blocked',
      'scored',
      'low_confidence',
    ]).toContain(outcome.kind);
  });

  it('ATTACK E6: sidecar fps disagrees with the clip fps -> refused', async () => {
    const { sequence, window } = generateSwingSequence();
    const { db } = createSqliteTestDb();
    const sidecarJson = serializePoseSequence(sequence);
    const clip = importedClip(sidecarJson, sequence, window.endMs, {
      fps: sequence.video.fps + 1,
    });
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it('ATTACK E7: sidecar ref frameCount is one less than the file (hash recomputed to match) -> refused', async () => {
    const { sequence, window } = generateSwingSequence();
    const { db } = createSqliteTestDb();
    const sidecarJson = serializePoseSequence(sequence);
    const clip = importedClip(sidecarJson, sequence, window.endMs);
    clip.poseSequence = {
      ...clip.poseSequence!,
      frameCount: sequence.frames.length - 1,
    };
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it('ATTACK E8: sidecar prefixed with a UTF-8 BOM (same logical JSON) -> hash mismatch refuses, never repairs', async () => {
    const { sequence, window } = generateSwingSequence();
    const { db } = createSqliteTestDb();
    const sidecarJson = serializePoseSequence(sequence);
    const clip = importedClip(sidecarJson, sequence, window.endMs);
    mockReadArtifact = async () => `\uFEFF${sidecarJson}`;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    expect(server.fetchMock).not.toHaveBeenCalled();
  });
});
