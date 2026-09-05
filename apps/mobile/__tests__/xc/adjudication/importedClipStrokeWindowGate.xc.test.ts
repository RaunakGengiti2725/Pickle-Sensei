/**
 * XC-ADJ-VIS-1 — imported clips and the stroke-window continuity gate.
 *
 * A real import is a user's camera-roll video: it starts before the player
 * is in frame and/or keeps rolling after the swing. The continuity gate must
 * inspect the MEASURED stroke (the offline detector's motion core), never the
 * whole container — otherwise every import with an untracked lead-in or tail
 * is refused as "tracking dropped out during the stroke" while the swing
 * itself is fully tracked and the whole-clip quality report is analyzable.
 *
 * The inverse must hold too: a torso dropout THROUGH the stroke is refused,
 * the reserved permit is released as `unsupported`, and no rating is written.
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

const OWNER = '33333333-3333-4333-8333-333333333333';
const API = { baseUrl: 'https://api.test', token: 'bearer-token' };

function importedClip(
  id: string,
  sequence: PoseSequence,
  durationMs: number,
): { clip: CapturedClip; sidecarJson: string } {
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///imports/${id}.mov`,
    durationMs,
    fps: 60,
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

/** Another body hides the player's torso for [fromMs, toMs] (landmarks stay,
 * visibility collapses — what Apple Vision reports for an occluded joint). */
function hideTorso(
  sequence: PoseSequence,
  fromMs: number,
  toMs: number,
): PoseSequence {
  const torso = new Set([
    'left_shoulder',
    'right_shoulder',
    'left_hip',
    'right_hip',
  ]);
  return {
    ...sequence,
    frames: sequence.frames.map(f =>
      f.timestampMs >= fromMs && f.timestampMs <= toMs
        ? {
            ...f,
            landmarks: f.landmarks.map(mark =>
              torso.has(mark.name) ? { ...mark, visibility: 0.05 } : mark,
            ),
          }
        : f,
    ),
  };
}

/** The player walks into frame `leadInMs` after the video starts. */
function playerEntersLate(
  sequence: PoseSequence,
  leadInMs: number,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames
      .filter(f => f.timestampMs >= leadInMs)
      .map((f, frameIndex) => ({ ...f, frameIndex })),
  };
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

describe('imported clip — stroke-window tracking gate', () => {
  it('control: an import tracked from the first to the last frame is scored', async () => {
    const { sequence, window } = generateSwingSequence({ handed: 'right' });
    const { clip, sidecarJson } = importedClip(
      'control',
      sequence,
      window.endMs,
    );
    const { outcome } = await run(clip, sidecarJson);
    expect(outcome.kind).toBe('scored');
  });

  it('player steps into frame 300 ms after the video starts → must still be scored (swing fully tracked, whole-clip quality analyzable)', async () => {
    const { sequence, window } = generateSwingSequence({ handed: 'right' });
    const late = playerEntersLate(sequence, 300);
    // The stroke itself (ready → backswing → contact → follow → recover) is
    // intact and the whole-clip capture-quality report accepts it.
    expect(late.frames[0]!.timestampMs).toBeGreaterThanOrEqual(300);
    expect(evaluateCaptureQuality(late).analyzable).toBe(true);
    const { clip, sidecarJson } = importedClip('lead-in', late, window.endMs);

    const { outcome, fake } = await run(clip, sidecarJson);

    expect(outcome.kind).toBe('scored');
    expect(fake.shots).toHaveLength(1);
    expect(server.reserves).toBe(1);
    expect(server.releases).toEqual([]);
  });

  it('video keeps rolling 500 ms after the player leaves frame → must still be scored, not "tracking dropped out during the stroke"', async () => {
    const { sequence, window } = generateSwingSequence({ handed: 'right' });
    expect(evaluateCaptureQuality(sequence).analyzable).toBe(true);
    const { clip, sidecarJson } = importedClip(
      'tail',
      sequence,
      window.endMs + 500,
    );

    const { outcome, fake } = await run(clip, sidecarJson);

    if (outcome.kind === 'quality_blocked') {
      // Surface the exact copy the user would read.
      expect(outcome.reason).not.toMatch(/during the stroke/);
    }
    expect(outcome.kind).toBe('scored');
    expect(fake.shots).toHaveLength(1);
    expect(server.releases).toEqual([]);
  });

  it('torso hidden for 300 ms through contact → refused before inference, permit released as unsupported, no rating written', async () => {
    const { sequence, window } = generateSwingSequence({ handed: 'right' });
    const occluded = hideTorso(
      sequence,
      window.peakMs - 150,
      window.peakMs + 150,
    );
    // Whole-clip statistics cannot see a short occlusion: only the
    // stroke-window gate can, which is exactly why the phone path needs it.
    expect(evaluateCaptureQuality(occluded).analyzable).toBe(true);
    const { clip, sidecarJson } = importedClip(
      'occluded',
      occluded,
      window.endMs + 500,
    );

    const { outcome, fake } = await run(clip, sidecarJson);

    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind === 'quality_blocked') {
      expect(outcome.poseQuality?.reasons).toContain(
        'stroke_window_tracking_gap',
      );
      expect(outcome.reason).toMatch(/during the stroke/);
    }
    expect(fake.shots).toHaveLength(0);
    expect(fake.analysisRecords).toHaveLength(0);
    expect(server.reserves).toBe(1);
    expect(server.releases).toEqual([
      { permitId: 'permit-1', outcome: 'unsupported' },
    ]);
  });
});
