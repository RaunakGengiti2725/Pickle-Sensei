/**
 * XC-ADJ-VIS-1 — 24 fps imports and the `insufficient_fps` gate.
 *
 * Pose timestamps are whole milliseconds (native `Int(elapsedMs.rounded())`,
 * the synthetic generator's `Math.round`), so a genuine 24 fps clip measures
 * 24.0008, 24.0000 or 23.9990 depending only on `(frames - 1) mod 3`, and
 * 23.976 fps ("24p") always measures below 24. `packages/capture-envelope`
 * (frame-rate-avg-v0.2) puts 24 fps INSIDE the supported band and only
 * degrades down to 15; the pose-quality floor mirrors that degraded floor
 * and is quantization-aware, so none of these clips may be refused.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import { evaluateCaptureQuality } from '@pickle/vision-geometry';
import type { CapturedClip } from '../../../src/camera/capture';
import { setActiveDataOwner } from '../../../src/data/accountScope';
import { createFakeLocalDb } from '../../../testing/xcBehavioral/fakeLocalDb';

let mockReadArtifact: (uri: string) => Promise<string> = () =>
  Promise.reject(new Error('readCaptureArtifact mock not configured'));
jest.mock('../../../src/camera/capture', () => {
  const actual = jest.requireActual('../../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

import { runCaptureAnalysis } from '../../../src/analysis/runCaptureAnalysis';

const OWNER = '44444444-4444-4444-8444-444444444444';
const API = { baseUrl: 'https://api.test', token: 'bearer-token' };

function importedClip(
  id: string,
  sequence: PoseSequence,
  fps: number,
): { clip: CapturedClip; sidecarJson: string } {
  const sidecarJson = serializePoseSequence(sequence);
  const last = sequence.frames[sequence.frames.length - 1]!;
  const clip: CapturedClip = {
    uri: `file:///imports/${id}.mov`,
    durationMs: last.timestampMs,
    fps,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T09:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///imports/${id}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

/** The player holds the recover pose for `extraFrames` more frames of the
 * same `fps` grid (whole-millisecond presentation timestamps, as written by
 * the native extractor). */
function holdFinalPose(
  sequence: PoseSequence,
  fps: number,
  extraFrames: number,
): PoseSequence {
  const frames = [...sequence.frames];
  const last = frames[frames.length - 1]!;
  for (let k = 1; k <= extraFrames; k += 1) {
    const frameIndex = frames.length;
    frames.push({
      ...last,
      frameIndex,
      timestampMs: Math.round((frameIndex * 1000) / fps),
    });
  }
  return { ...sequence, frames };
}

interface Server {
  reserves: number;
  releases: Array<{ permitId: string; outcome: string }>;
}

function installPermitServer(): Server {
  const server: Server = { reserves: 0, releases: [] };
  const json = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
    }) as unknown as Response;
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      server.reserves += 1;
      return json(200, {
        permit: {
          id: `permit-${server.reserves}`,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-04T20:00:00.000Z',
        },
        access: { premium: false, freeRatings: { availableToReserve: 1 } },
      });
    }
    if (url.includes('/v1/analysis-permits/') && url.endsWith('/finalize')) {
      const permitId = decodeURIComponent(
        url.slice(
          url.indexOf('/v1/analysis-permits/') + '/v1/analysis-permits/'.length,
          url.length - '/finalize'.length,
        ),
      );
      const body = JSON.parse(String(init?.body)) as { outcome: string };
      server.releases.push({ permitId, outcome: body.outcome });
      return json(200, { ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return server;
}

const originalFetch = globalThis.fetch;
let server: Server;

beforeEach(() => {
  setActiveDataOwner(OWNER);
  server = installPermitServer();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function run(clip: CapturedClip, sidecarJson: string) {
  mockReadArtifact = async () => sidecarJson;
  const fake = createFakeLocalDb();
  const outcome = await runCaptureAnalysis({
    db: fake.db,
    captureId: `capture-${clip.uri}`,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: API,
    appVersion: '1.0.0-test',
    sessionId: null,
  });
  return { outcome, fake };
}

describe('imported clip — 24 fps and the insufficient_fps gate', () => {
  it('control: a 24 fps import with 49 pose frames (48 intervals, exactly 2000 ms) is scored', async () => {
    const { sequence } = generateSwingSequence({ handed: 'right', fps: 24 });
    // 48 generated frames → hold the final pose one more frame → 49.
    const held = holdFinalPose(sequence, 24, 1);
    expect(held.frames).toHaveLength(49);
    expect(evaluateCaptureQuality(held).stats.effectiveFps).toBe(24);
    const { clip, sidecarJson } = importedClip('24fps-49', held, 24);

    const { outcome } = await run(clip, sidecarJson);

    expect(outcome.kind).toBe('scored');
  });

  it('the SAME 24 fps import one frame longer (50 frames, 49 intervals → 2042 ms) must still be scored, not "the tracking frame rate was too low"', async () => {
    const { sequence } = generateSwingSequence({ handed: 'right', fps: 24 });
    const held = holdFinalPose(sequence, 24, 2);
    expect(held.frames).toHaveLength(50);
    const quality = evaluateCaptureQuality(held);
    // 49 * 1000 / 2042 = 23.9990… — a rounding artifact, not a frame rate.
    expect(quality.stats.effectiveFps).toBeGreaterThan(23.99);
    expect(quality.stats.effectiveFps).toBeLessThan(24);
    const { clip, sidecarJson } = importedClip('24fps-50', held, 24);

    const { outcome, fake } = await run(clip, sidecarJson);

    if (outcome.kind === 'quality_blocked') {
      expect(outcome.reason).not.toMatch(/frame rate was too low/);
    }
    expect(outcome.kind).toBe('scored');
    expect(fake.shots).toHaveLength(1);
    expect(server.reserves).toBe(1);
    expect(server.releases).toEqual([]);
  });

  it('a 23.976 fps ("24p") import — capture envelope DEGRADED, not UNSUPPORTED — must be analyzed, not blocked on every clip', async () => {
    const fps = 23.976;
    const { sequence } = generateSwingSequence({ handed: 'right', fps });
    expect(evaluateCaptureQuality(sequence).stats.effectiveFps).toBeLessThan(
      24,
    );
    const { clip, sidecarJson } = importedClip('23976fps', sequence, fps);

    const { outcome, fake } = await run(clip, sidecarJson);

    if (outcome.kind === 'quality_blocked') {
      expect(outcome.reason).not.toMatch(/frame rate was too low/);
    }
    expect(outcome.kind).toBe('scored');
    expect(fake.shots).toHaveLength(1);
    expect(server.releases).toEqual([]);
  });

  it('a 12 fps import — below the envelope DEGRADED floor — is refused as insufficient_fps, the permit released, no rating written', async () => {
    const fps = 12;
    const { sequence } = generateSwingSequence({ handed: 'right', fps });
    const { clip, sidecarJson } = importedClip('12fps', sequence, fps);

    const { outcome, fake } = await run(clip, sidecarJson);

    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind === 'quality_blocked') {
      expect(outcome.poseQuality?.reasons).toContain('insufficient_fps');
      expect(outcome.reason).toMatch(/frame rate was too low/);
    }
    expect(fake.shots).toHaveLength(0);
    expect(server.reserves).toBe(1);
    expect(server.releases).toEqual([
      { permitId: 'permit-1', outcome: 'unsupported' },
    ]);
  });
});
