/**
 * XC-CV-1 adversarial attack — the pose-quality gate's ORDER in
 * runCaptureAnalysis and its neighbourhood (double-scale variants).
 *
 * The XC-CV-1 fix on f702f0f8 runs evaluateCaptureQuality + the
 * pre-analysis gate AFTER `permits.reserve()`. The gate is a pure local
 * computation over the already-validated sidecar (no network, no
 * entitlement), yet the entitlement round trip is spent first. The
 * capture-envelope gate directly above it in the same function abstains
 * BEFORE any permit is reserved — that is the honesty contract these tests
 * hold the pose gate to.
 *
 * Cases marked `EXPECTED FAIL on f702f0f8` are the breaks; everything else
 * is double-scale coverage of the neighbourhood (empty pose, ordering,
 * malformed payloads, concurrency with three interleaved runs, live-window
 * tracking loss, fps boundaries) that MUST keep passing.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import type { CapturedClip } from '../../../src/camera/capture';
import { setActiveDataOwner } from '../../../src/data/accountScope';
import { createFakeLocalDb } from '../../../testing/xcBehavioral/fakeLocalDb';

const mockSidecars = new Map<string, string>();
jest.mock('../../../src/camera/capture', () => {
  const actual = jest.requireActual('../../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: async (uri: string) => {
      const json = mockSidecars.get(uri);
      if (json === undefined) throw new Error(`no sidecar registered: ${uri}`);
      return json;
    },
  };
});

import { runCaptureAnalysis } from '../../../src/analysis/runCaptureAnalysis';

const OWNER = '44444444-4444-4444-8444-444444444444';
const API = { baseUrl: 'https://api.test', token: 'bearer-token' };

function liveClip(
  id: string,
  sequence: PoseSequence,
  window: { startMs: number; endMs: number; peakMs: number },
  sidecarJson = serializePoseSequence(sequence),
): CapturedClip {
  const uri = `file:///captures/${id}.pose.json`;
  mockSidecars.set(uri, sidecarJson);
  return {
    uri: `file:///captures/${id}.mov`,
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-09-05T03:00:00.000Z',
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
      jointMotion: [],
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
      uri,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

interface Server {
  reserves: number;
  releases: Array<{ permitId: string; outcome: string; ratingId: unknown }>;
  /** Override the reserve response (or throw) for the next reserve calls. */
  reserveBehaviour: 'accept' | 'paywall_402' | 'offline';
  availableToReserve: number;
}

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

function installPermitServer(): Server {
  const server: Server = {
    reserves: 0,
    releases: [],
    reserveBehaviour: 'accept',
    availableToReserve: 1,
  };
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      server.reserves += 1;
      if (server.reserveBehaviour === 'offline') {
        // What RN's whatwg-fetch throws with no connectivity.
        throw new TypeError('Network request failed');
      }
      if (server.reserveBehaviour === 'paywall_402') {
        return json(402, {
          error: {
            code: 'access.paywall_required',
            message: 'You have used your free ratings. Upgrade to keep rating.',
          },
        });
      }
      return json(200, {
        permit: {
          id: `permit-${server.reserves}`,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-05T20:00:00.000Z',
        },
        access: {
          premium: false,
          freeRatings: { availableToReserve: server.availableToReserve },
        },
      });
    }
    if (url.includes('/v1/analysis-permits/') && url.endsWith('/finalize')) {
      const permitId = decodeURIComponent(
        url.slice(
          url.indexOf('/v1/analysis-permits/') + '/v1/analysis-permits/'.length,
          url.length - '/finalize'.length,
        ),
      );
      const body = JSON.parse(String(init?.body)) as {
        outcome: string;
        ratingId: unknown;
      };
      server.releases.push({
        permitId,
        outcome: body.outcome,
        ratingId: body.ratingId,
      });
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
  mockSidecars.clear();
  server = installPermitServer();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function run(
  clip: CapturedClip,
  captureId = `capture-${clip.uri}`,
  fake = createFakeLocalDb(),
) {
  return runCaptureAnalysis({
    db: fake.db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: API,
    appVersion: '1.0.0-attack',
    sessionId: null,
  }).then(outcome => ({ outcome, fake }));
}

/** Player 2% of frame height: QUALITY_THRESHOLDS.minTorsoLengthNorm is 0.08. */
function farCameraClip(id: string): CapturedClip {
  const { sequence, window } = generateSwingSequence({ torsoLength: 0.02 });
  return liveClip(id, sequence, window);
}

describe('XC-CV-1 attack — pose-quality gate vs the entitlement boundary', () => {
  it('control: the same swing at torso 0.2 is scored and its permit is left for shot sync', async () => {
    const { sequence, window } = generateSwingSequence();
    const { outcome, fake } = await run(liveClip('ctrl', sequence, window));
    expect(outcome.kind).toBe('scored');
    expect(server.reserves).toBe(1);
    expect(server.releases).toEqual([]);
    expect(fake.analysisRecords).toHaveLength(1);
  });

  it('EXPECTED FAIL on f702f0f8 — far-camera clip at the free limit (reserve → 402): the local pose gate must abstain with guidance, not surface the paywall', async () => {
    server.reserveBehaviour = 'paywall_402';
    const { outcome, fake } = await run(farCameraClip('far-402'));
    // The clip is unmeasurable regardless of entitlement; a typed abstention
    // with "keep your whole body in frame" guidance is the only honest
    // outcome. Observed on f702f0f8: kind 'unavailable', cause
    // 'paywall_required' → AnalyzeScreen recovery 'upgrade'.
    expect(outcome).toEqual(
      expect.objectContaining({ kind: 'quality_blocked' }),
    );
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.poseQuality?.reasons).toContain('person_implausible_scale');
    expect(fake.analysisRecords).toHaveLength(0);
  });

  it('EXPECTED FAIL on f702f0f8 — far-camera clip offline: the pose gate needs no network, so it must not promise "can be scored later" for a clip that never can be', async () => {
    server.reserveBehaviour = 'offline';
    const { outcome } = await run(farCameraClip('far-offline'));
    // Observed on f702f0f8: kind 'unavailable', reason "The rating service
    // could not be reached. Your capture is saved and can be scored later."
    expect(outcome).toEqual(
      expect.objectContaining({ kind: 'quality_blocked' }),
    );
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.reason).toContain('Nothing was rated');
  });

  it('EXPECTED FAIL on f702f0f8 — pose-quality abstention parity with the envelope gate: no permit round trip for a locally unmeasurable clip', async () => {
    const { outcome } = await run(farCameraClip('far-online'));
    expect(outcome.kind).toBe('quality_blocked');
    // The envelope gate (same function, a few lines up) abstains with zero
    // fetches. Observed on f702f0f8: 1 reserve + 1 finalize('unsupported')
    // — a permit is parked server-side for up to 24 h if the finalize is
    // lost (reserve_analysis_permit counts status='reserved' rows).
    expect(server.reserves).toBe(0);
  });
});

describe('XC-CV-1 attack — neighbourhood (must keep passing)', () => {
  it('empty pose array: structurally valid sidecar with zero frames is a typed no_person_found abstention, permit released unsupported, no records', async () => {
    const { sequence, window } = generateSwingSequence();
    const empty: PoseSequence = { ...sequence, frames: [] };
    const { outcome, fake } = await run(liveClip('empty', empty, window));
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.poseQuality?.reasons).toContain('no_person_found');
    expect(server.releases).toEqual([
      expect.objectContaining({
        permitId: 'permit-1',
        outcome: 'unsupported',
        ratingId: null,
      }),
    ]);
    expect(fake.analysisRecords).toHaveLength(0);
    expect(fake.shots).toHaveLength(0);
    expect(fake.outbox).toHaveLength(0);
  });

  it('frame ordering: a sidecar whose frames are reversed is refused by the parser before any permit is touched', async () => {
    const { sequence, window } = generateSwingSequence();
    const reversed: PoseSequence = {
      ...sequence,
      frames: [...sequence.frames].reverse(),
    };
    const { outcome } = await run(liveClip('reversed', reversed, window));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('pose_sequence.non_monotonic');
    expect(server.reserves).toBe(0);
  });

  it('duplicate timestamps (two frames stamped identically) are refused as non-monotonic, no permit', async () => {
    const { sequence, window } = generateSwingSequence();
    const frames = sequence.frames.map(f => ({ ...f }));
    frames[10]!.timestampMs = frames[9]!.timestampMs;
    const { outcome } = await run(
      liveClip('dup-ts', { ...sequence, frames }, window),
    );
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('pose_sequence.non_monotonic');
    expect(server.reserves).toBe(0);
  });

  it('NULL / NaN payload fields: a null visibility and a NaN coordinate are each refused by the parser, no permit', async () => {
    const { sequence, window } = generateSwingSequence();
    const raw = JSON.parse(serializePoseSequence(sequence)) as {
      frames: Array<{ l: Array<Record<string, unknown>> }>;
    };
    raw.frames[5]!.l[3]!.v = null;
    const nullJson = JSON.stringify(raw);
    const nullClip = liveClip('null-vis', sequence, window, nullJson);
    const nullOutcome = (await run(nullClip)).outcome;
    expect(nullOutcome.kind).toBe('unavailable');
    if (nullOutcome.kind !== 'unavailable') return;
    expect(nullOutcome.reason).toContain('pose_sequence.corrupt_landmark');

    // JSON cannot carry NaN; a producer that stringifies one emits null.
    const raw2 = JSON.parse(serializePoseSequence(sequence)) as {
      frames: Array<{ l: Array<Record<string, unknown>> }>;
    };
    raw2.frames[7]!.l[0]!.x = 'NaN';
    const nanJson = JSON.stringify(raw2);
    const nanOutcome = (await run(liveClip('nan-x', sequence, window, nanJson)))
      .outcome;
    expect(nanOutcome.kind).toBe('unavailable');
    if (nanOutcome.kind !== 'unavailable') return;
    expect(nanOutcome.reason).toContain('pose_sequence.corrupt_landmark');
    expect(server.reserves).toBe(0);
  });

  it('concurrency: three interleaved runs (far, control, too-close) with unicode capture ids each settle their OWN permit; only the control writes', async () => {
    const control = generateSwingSequence();
    const far = generateSwingSequence({ torsoLength: 0.02 });
    const near = generateSwingSequence({ torsoLength: 0.7 });
    const fake = createFakeLocalDb();
    const [farOut, ctrlOut, nearOut] = await Promise.all([
      run(
        liveClip('far-🥒', far.sequence, far.window),
        'capture-far-🥒-Ünïcode',
        fake,
      ),
      run(
        liveClip('ctrl-日本', control.sequence, control.window),
        'capture-ctrl-日本',
        fake,
      ),
      run(
        liveClip('near-ß', near.sequence, near.window),
        'capture-near-ß',
        fake,
      ),
    ]);
    expect(farOut.outcome.kind).toBe('quality_blocked');
    expect(nearOut.outcome.kind).toBe('quality_blocked');
    expect(ctrlOut.outcome.kind).toBe('scored');
    if (ctrlOut.outcome.kind !== 'scored') return;

    expect(server.reserves).toBe(3);
    expect(server.releases).toHaveLength(2);
    expect(
      server.releases.every(
        r => r.outcome === 'unsupported' && r.ratingId === null,
      ),
    ).toBe(true);
    const released = new Set(server.releases.map(r => r.permitId));
    expect(released.size).toBe(2);
    const outboxPayloads = fake.outbox.map(
      row => JSON.parse(row.payload) as { analysisPermitId: string },
    );
    expect(outboxPayloads).toHaveLength(1);
    // The scored run's permit is the one NOT released.
    expect(released.has(outboxPayloads[0]!.analysisPermitId)).toBe(false);
    expect(fake.analysisRecords).toHaveLength(1);
    expect(fake.analysisRecords[0]!.owner).toBe(OWNER);
    expect(fake.shots).toHaveLength(1);
  });

  it('live capture: torso tracking lost from contact to the trigger end is refused (stroke_window_tracking_gap), permit released unsupported', async () => {
    const { sequence, window } = generateSwingSequence();
    const torso = new Set([
      'left_shoulder',
      'right_shoulder',
      'left_hip',
      'right_hip',
    ]);
    const lost: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(f =>
        f.timestampMs >= window.peakMs
          ? {
              ...f,
              landmarks: f.landmarks.map(m =>
                torso.has(m.name) ? { ...m, visibility: 0.05 } : m,
              ),
            }
          : f,
      ),
    };
    const { outcome, fake } = await run(liveClip('torso-lost', lost, window));
    expect(outcome.kind).toBe('quality_blocked');
    if (outcome.kind !== 'quality_blocked') return;
    expect(outcome.poseQuality?.reasons).toContain(
      'stroke_window_tracking_gap',
    );
    expect(server.releases).toEqual([
      expect.objectContaining({ outcome: 'unsupported', ratingId: null }),
    ]);
    expect(fake.analysisRecords).toHaveLength(0);
  });

  it('live capture: torso lost ONLY in the pre-roll (before trigger.startMs) is still scored', async () => {
    // The native writer re-bases the trigger to the selected range, so a
    // real live clip carries `preRollMs` of footage BEFORE trigger.startMs.
    // The generator's ready phase (400 ms) is that pre-roll here.
    const { sequence, window: whole } = generateSwingSequence({ readyMs: 400 });
    const window = { ...whole, startMs: 400 };
    const torso = new Set([
      'left_shoulder',
      'right_shoulder',
      'left_hip',
      'right_hip',
    ]);
    const preRollLost: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map(f =>
        f.timestampMs < 350
          ? {
              ...f,
              landmarks: f.landmarks.map(m =>
                torso.has(m.name) ? { ...m, visibility: 0.05 } : m,
              ),
            }
          : f,
      ),
    };
    const { outcome } = await run(
      liveClip('preroll-lost', preRollLost, window),
    );
    expect(outcome.kind).toBe('scored');
  });

  it('fps boundary on the live path: 14 fps is refused as insufficient_fps, 15 fps is not refused for fps', async () => {
    const slow = generateSwingSequence({ fps: 14 });
    const slowOut = (await run(liveClip('fps14', slow.sequence, slow.window)))
      .outcome;
    expect(slowOut.kind).toBe('quality_blocked');
    if (slowOut.kind !== 'quality_blocked') return;
    expect(slowOut.poseQuality?.reasons).toContain('insufficient_fps');

    const floor = generateSwingSequence({ fps: 15 });
    const floorOut = (
      await run(liveClip('fps15', floor.sequence, floor.window))
    ).outcome;
    if (floorOut.kind === 'quality_blocked') {
      expect(floorOut.poseQuality?.reasons ?? []).not.toContain(
        'insufficient_fps',
      );
    }
  });

  it('stale permit: a reserve response already expired server-side still gates nothing locally — the blocked clip releases it as unsupported', async () => {
    (globalThis.fetch as jest.Mock).mockImplementationOnce(async () => {
      server.reserves += 1;
      return json(200, {
        permit: {
          id: 'permit-stale',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
        access: { premium: false, freeRatings: { availableToReserve: 1 } },
      });
    });
    const { outcome } = await run(farCameraClip('far-stale'));
    expect(outcome.kind).toBe('quality_blocked');
    expect(server.releases).toEqual([
      expect.objectContaining({
        permitId: 'permit-stale',
        outcome: 'unsupported',
      }),
    ]);
  });
});
