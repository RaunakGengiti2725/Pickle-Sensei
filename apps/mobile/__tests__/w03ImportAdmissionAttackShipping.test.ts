import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import * as pipeline from '@pickle/analysis-pipeline';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import * as importAdmission from '../src/camera/importAdmission';
import { IMPORT_ADMISSION_LIMITS } from '../src/camera/importAdmission';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';

/**
 * W03-01 adversarial tests against candidate da6ff3c7 — SHIPPING PATH.
 *
 * Each ambiguous clip from w03ImportAdmissionAttack.test.ts is pushed
 * through `runCaptureAnalysis` against a permit server that WOULD grant the
 * permit. Expected (the work package's objective): the clip is refused with a
 * precise reason and `POST /v1/analysis-permits` is never called, nothing is
 * inferred, no rated shot is written. A FAILING test is a confirmed break on
 * the free-rating conservation invariant: an ambiguous import reached
 * charging.
 */

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
    verifyCapturedClipCurrentBytes: jest.fn(),
    extractImportedPoseSequence: jest.fn(),
  };
});

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { ...actual, analyzeCapture: jest.fn(actual.analyzeCapture) };
});

jest.mock('../src/camera/importAdmission', () => {
  const actual = jest.requireActual('../src/camera/importAdmission');
  return {
    ...actual,
    admitImportedMedia: jest.fn(actual.admitImportedMedia),
    admitImportedClip: jest.fn(actual.admitImportedClip),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '33333333-3333-4333-8333-333333333333';

function permitServer(): { fetchMock: jest.Mock; finalized: unknown[] } {
  const finalized: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
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
      finalized.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, finalized };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function importedClipWithSidecar(sequence: PoseSequence): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const lastFrame = sequence.frames[sequence.frames.length - 1];
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///imports/attack-clip.mov',
    durationMs: (lastFrame?.timestampMs ?? 0) + 200,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    posterUri: 'file:///imports/attack-clip.poster.jpg',
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///imports/attack-clip.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
  const captureId = '77777777-7777-4777-8777-777777777777';
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

function wristSpeedProfile(
  durationMs: number,
  fps: number,
  rightAt: (tMs: number) => number,
  startMs = 0,
): PoseSequence {
  const { sequence } = generateSwingSequence();
  const body = sequence.frames[0];
  if (!body) throw new Error('synthetic swing produced no frames');
  const dtMs = 1000 / fps;
  const frames: PoseSequence['frames'] = [];
  let index = 0;
  for (let tMs = startMs; tMs <= durationMs; tMs += dtMs) {
    const rightStep = (rightAt(tMs) * dtMs) / 1000;
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark =>
        mark.name === 'right_wrist'
          ? { ...mark, x: 0.55 + (index % 2 === 0 ? 0 : rightStep) }
          : mark,
      ),
    });
    index += 1;
  }
  return { ...sequence, video: { ...sequence.video, fps }, frames };
}

function hump(centerMs: number, halfWidthMs: number, peak: number) {
  return (tMs: number): number => {
    const distance = Math.abs(tMs - centerMs);
    if (distance >= halfWidthMs) return 0;
    return peak * (1 - distance / halfWidthMs);
  };
}

function sumOf(...profiles: ReadonlyArray<(tMs: number) => number>) {
  return (tMs: number): number =>
    profiles.reduce((total, profile) => total + profile(tMs), 0);
}

function rally(
  startMs: number,
  periodMs: number,
  peaks: readonly number[],
  valleys: readonly number[],
) {
  return (tMs: number): number => {
    const count = peaks.length;
    if (tMs < startMs || tMs > startMs + periodMs * count) return 0;
    const index = Math.min(count - 1, Math.floor((tMs - startMs) / periodMs));
    const phase = ((tMs - startMs) % periodMs) / periodMs;
    const peak = peaks[index] ?? 0;
    const before = index === 0 ? 0 : (valleys[index - 1] ?? 0);
    const after = index === count - 1 ? 0 : (valleys[index] ?? 0);
    if (phase < 0.5) return before + (peak - before) * (phase / 0.5);
    return peak + (after - peak) * ((phase - 0.5) / 0.5);
  };
}

function occludeRightWrist(
  sequence: PoseSequence,
  fromMs: number,
  toMs: number,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map(frame =>
      frame.timestampMs >= fromMs && frame.timestampMs <= toMs
        ? {
            ...frame,
            landmarks: frame.landmarks.map(mark =>
              mark.name === 'right_wrist'
                ? {
                    ...mark,
                    visibility:
                      IMPORT_ADMISSION_LIMITS.minLandmarkVisibility - 0.01,
                  }
                : mark,
            ),
          }
        : frame,
    ),
  };
}

function dropPoseFrames(
  sequence: PoseSequence,
  fromMs: number,
  toMs: number,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames
      .filter(frame => frame.timestampMs < fromMs || frame.timestampMs > toMs)
      .map((frame, index) => ({ ...frame, frameIndex: index })),
  };
}

const stroke = (centerMs: number) => hump(centerMs, 150, 1.0);

const AMBIGUOUS_SHAPES: ReadonlyArray<[string, () => PoseSequence]> = [
  [
    'four decaying volleys every 450 ms (valleys at 81 % of the next peak)',
    () =>
      wristSpeedProfile(
        5000,
        60,
        rally(1000, 450, [1.0, 0.9, 0.81, 0.73], [0.73, 0.66, 0.6]),
      ),
  ],
  [
    'two equal volleys 330 ms apart with a 55 % valley',
    () => wristSpeedProfile(3000, 60, rally(1000, 330, [1.0, 1.0], [0.55])),
  ],
  [
    'a second stroke hidden in a 400 ms whole-pose gap',
    () =>
      dropPoseFrames(
        wristSpeedProfile(4000, 60, sumOf(stroke(1000), stroke(2500))),
        2300,
        2700,
      ),
  ],
  [
    'two strokes hidden while the hitting wrist is untracked for the first 4.5 s',
    () =>
      occludeRightWrist(
        wristSpeedProfile(
          7000,
          60,
          sumOf(stroke(1000), stroke(2500), stroke(6000)),
        ),
        0,
        4500,
      ),
  ],
  [
    'a pose sequence that begins 2.4 s into the clip',
    () => wristSpeedProfile(4000, 60, hump(3200, 150, 1.0), 2400),
  ],
];

function signIn(account = owner) {
  setActiveDataOwner(account);
  establishApiSession({
    canonicalAppUserId: account,
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    provider: 'apple',
  });
}

describe('ATTACK 9 — free-rating conservation: ambiguous imports must never reach the permit reservation', () => {
  beforeEach(() => {
    signIn();
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it.each(AMBIGUOUS_SHAPES)(
    '%s is refused before any permit is reserved — nothing inferred, nothing rated',
    async (_title, build) => {
      const { db, calls } = createSqliteTestDb();
      const { clip, sidecarJson } = importedClipWithSidecar(build());
      mockReadArtifact = async () => sidecarJson;
      const { fetchMock, finalized } = permitServer();
      (globalThis as { fetch?: unknown }).fetch = fetchMock;
      const analyzeSpy = jest.mocked(pipeline.analyzeCapture);
      analyzeSpy.mockClear();

      const outcome = await runCaptureAnalysis(request(db, clip));

      expect({
        kind: outcome.kind,
        permitReservations: fetchMock.mock.calls
          .map(([url]) => String(url))
          .filter(url => url.endsWith('/v1/analysis-permits')).length,
        permitFinalizations: finalized.length,
        inferenceRuns: analyzeSpy.mock.calls.length,
        ratedShotWrites: calls.filter(call =>
          call.sql.includes('INSERT OR REPLACE INTO local_shot'),
        ).length,
        durableRows: calls.length,
      }).toEqual({
        kind: 'quality_blocked',
        permitReservations: 0,
        permitFinalizations: 0,
        inferenceRuns: 0,
        ratedShotWrites: 0,
        durableRows: 0,
      });
    },
  );
});

describe('ATTACK 10 — codec / rotation / track-layout rules are unreachable from the shipping path', () => {
  /**
   * `admitImportedMedia(clip, probe)` only checks codec, rotation and video
   * track count when a probe is supplied. `runCaptureAnalysis` calls it with
   * the clip alone and `admitImportedClip(clip, sequence)` without a probe,
   * and `CapturedClip` carries no codec/rotation/track fields — so on the
   * shipping path `unsupported_codec`, `unsupported_rotation` and
   * `unsupported_track_layout` can never be produced.
   */
  beforeEach(() => {
    signIn();
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('the shipping path supplies a codec/rotation/track probe to the media admission', async () => {
    const { db } = createSqliteTestDb();
    const { clip, sidecarJson } = importedClipWithSidecar(
      generateSwingSequence().sequence,
    );
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const mediaSpy = jest.mocked(importAdmission.admitImportedMedia);
    const clipSpy = jest.mocked(importAdmission.admitImportedClip);
    mediaSpy.mockClear();
    clipSpy.mockClear();

    await runCaptureAnalysis(request(db, clip));

    expect(
      mediaSpy.mock.calls.length + clipSpy.mock.calls.length,
    ).toBeGreaterThan(0);
    const probes = [
      ...mediaSpy.mock.calls.map(([, probe]) => probe),
      ...clipSpy.mock.calls.map(([, , probe]) => probe),
    ];
    expect(
      probes.some(
        probe =>
          probe !== undefined &&
          probe.codec !== undefined &&
          probe.rotationDegrees !== undefined &&
          probe.videoTrackCount !== undefined,
      ),
    ).toBe(true);
  });
});
