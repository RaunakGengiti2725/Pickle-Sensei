/**
 * ADVERSARY (INT-import-media-capture): versioned time mapping between an
 * imported clip's media timeline and its extracted pose sidecar.
 *
 * The analysis window for an imported clip is declared as the WHOLE media
 * timeline [0, durationMs] ("trigger.imported-full-clip"). These attacks feed
 * sidecars whose frame timeline does not live inside that window, or clip
 * metadata whose durationMs disagrees with the sidecar span, and assert the
 * honest outcome: no scored record whose timestamps point outside the media
 * the user imported, and no permit consumed for such a record.
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
  reservations: number;
}

function permitServer(): PermitServer {
  const server: PermitServer = {
    finalized: [],
    reservations: 0,
    fetchMock: jest.fn(),
  };
  server.fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      server.reservations += 1;
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

function shiftTimeline(sequence: PoseSequence, deltaMs: number): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map(frame => ({
      ...frame,
      timestampMs: frame.timestampMs + deltaMs,
    })),
  };
}

function importedClip(
  sequence: PoseSequence,
  durationMs: number,
): { clip: CapturedClip; sidecarJson: string } {
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
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
  };
  return { clip, sidecarJson };
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

function scoredOutsideMedia(
  outcome: Awaited<ReturnType<typeof runCaptureAnalysis>>,
  durationMs: number,
): boolean {
  if (outcome.kind !== 'scored' && outcome.kind !== 'low_confidence')
    return false;
  const stamps = outcome.record.result?.timestamps;
  if (!stamps) return false;
  return stamps.startMs < 0 || stamps.endMs > durationMs;
}

describe('ADV time mapping: sidecar timeline vs imported media timeline', () => {
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

  it('control: an aligned sidecar scores with its window inside the media timeline', async () => {
    const { db } = createSqliteTestDb();
    const { sequence, window } = generateSwingSequence();
    const { clip, sidecarJson } = importedClip(sequence, window.endMs);
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    expect(scoredOutsideMedia(outcome, clip.durationMs)).toBe(false);
  });

  it('ATTACK A1: every pose frame is stamped AFTER the clip ends (timeline shifted past durationMs)', async () => {
    const { db } = createSqliteTestDb();
    const { sequence, window } = generateSwingSequence();
    const durationMs = window.endMs;
    const shifted = shiftTimeline(sequence, durationMs * 2);
    const { clip, sidecarJson } = importedClip(shifted, durationMs);
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    // Frames outside [0, durationMs] cannot describe this media. A scored
    // record here would rate motion that happened outside the imported clip.
    expect(['unavailable', 'quality_blocked']).toContain(outcome.kind);
    expect(
      server.finalized.filter(entry => entry.outcome === 'scored'),
    ).toHaveLength(0);
  });

  it('ATTACK A2: pose frames carry NEGATIVE timestamps (before media time zero)', async () => {
    const { db } = createSqliteTestDb();
    const { sequence, window } = generateSwingSequence();
    const durationMs = window.endMs;
    const lastMs = sequence.frames.at(-1)!.timestampMs;
    // Shift so the whole swing sits before t=0 while still strictly increasing.
    const shifted = shiftTimeline(sequence, -(lastMs + 1));
    const { clip, sidecarJson } = importedClip(shifted, durationMs);
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(['unavailable', 'quality_blocked']).toContain(outcome.kind);
    expect(
      server.finalized.filter(entry => entry.outcome === 'scored'),
    ).toHaveLength(0);
  });

  it('ATTACK A3: clip metadata claims a 1 ms media timeline while the sidecar spans seconds', async () => {
    const { db } = createSqliteTestDb();
    const { sequence } = generateSwingSequence();
    const { clip, sidecarJson } = importedClip(sequence, 1);
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    // The declared analysis window is [0, 1ms]; the observation is seconds
    // long. Either the mismatch is refused, or (if scored) the record must
    // not claim a window inside a 1 ms clip.
    expect(scoredOutsideMedia(outcome, clip.durationMs)).toBe(false);
    expect(['unavailable', 'quality_blocked']).toContain(outcome.kind);
  });

  it('ATTACK A4: clip metadata claims a one-hour media timeline for a four-second sidecar', async () => {
    const { db } = createSqliteTestDb();
    const { sequence } = generateSwingSequence();
    const lastMs = sequence.frames.at(-1)!.timestampMs;
    const durationMs = 3_600_000;
    const { clip, sidecarJson } = importedClip(sequence, durationMs);
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    // Native caps imports at 60 s; JS must not admit a clip row whose
    // timeline is 900x longer than the pose evidence covers. If it scores,
    // the record's window must at least stay within the observed frames.
    if (outcome.kind === 'scored' || outcome.kind === 'low_confidence') {
      const stamps = outcome.record.result?.timestamps;
      expect(stamps).toBeDefined();
      expect(stamps!.endMs).toBeLessThanOrEqual(lastMs);
    } else {
      expect(['unavailable', 'quality_blocked']).toContain(outcome.kind);
    }
  });

  it('ATTACK A5: frame indices are negative, duplicated and out of order while timestamps look valid', async () => {
    const { db } = createSqliteTestDb();
    const { sequence, window } = generateSwingSequence();
    const scrambled: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((frame, index) => ({
        ...frame,
        frameIndex: index % 2 === 0 ? -index : 7,
      })),
    };
    const { clip, sidecarJson } = importedClip(scrambled, window.endMs);
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer();
    (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    // A sidecar whose frame indices cannot be mapped back to media frames is
    // corrupt evidence; it must be refused rather than repaired or trusted.
    expect(['unavailable', 'quality_blocked']).toContain(outcome.kind);
    expect(
      server.finalized.filter(entry => entry.outcome === 'scored'),
    ).toHaveLength(0);
  });
});
