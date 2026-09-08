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
import {
  IMPORT_ADMISSION_LIMITS,
  importAdmissionRejectionMessage,
} from '../src/camera/importAdmission';
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
 * W03-01 adversarial suite (shipping path) against candidate 42bf4c60.
 *
 * Each clip below is ambiguous or truncated by the objective's own words
 * ("ambiguous clips are rejected with a precise reason and never reach
 * charging"). The tests assert what the objective demands on the session-
 * less `runCaptureAnalysis` path: a `quality_blocked` outcome, no
 * `POST /v1/analysis-permits`, no inference and no durable attempt. A failing
 * test is a confirmed break — the clip reached the permit reservation (and
 * with the mocked server, a scored, charged result).
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

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '33333333-3333-4333-8333-333333333333';
const LIMITS = IMPORT_ADMISSION_LIMITS;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: new Map<string, string>(),
    json: async () => body,
  } as unknown as Response;
}

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
  speedAt: (tMs: number) => number,
): PoseSequence {
  const { sequence } = generateSwingSequence();
  const body = sequence.frames[0];
  if (!body) throw new Error('synthetic swing produced no frames');
  const dtMs = 1000 / fps;
  const frames: PoseSequence['frames'] = [];
  let index = 0;
  for (let tMs = 0; tMs <= durationMs; tMs += dtMs) {
    const stepImageHeights = (speedAt(tMs) * dtMs) / 1000;
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark =>
        mark.name === 'right_wrist'
          ? { ...mark, x: 0.55 + (index % 2 === 0 ? 0 : stepImageHeights) }
          : mark,
      ),
    });
    index += 1;
  }
  return { ...sequence, video: { ...sequence.video, fps }, frames };
}

function wristTravelProfile(
  durationMs: number,
  fps: number,
  velocityAt: (tMs: number) => readonly [number, number],
): PoseSequence {
  const { sequence } = generateSwingSequence();
  const body = sequence.frames[0];
  if (!body) throw new Error('synthetic swing produced no frames');
  const dtMs = 1000 / fps;
  const frames: PoseSequence['frames'] = [];
  let index = 0;
  let x = 0.45;
  let y = 0.55;
  for (let tMs = 0; tMs <= durationMs; tMs += dtMs) {
    const [vx, vy] = velocityAt(tMs);
    x += (vx * dtMs) / 1000;
    y += (vy * dtMs) / 1000;
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark =>
        mark.name === 'right_wrist' ? { ...mark, x, y } : mark,
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

function trimSequence(
  sequence: PoseSequence,
  fromMs: number,
  toMs: number,
): PoseSequence {
  const kept = sequence.frames.filter(
    frame => frame.timestampMs >= fromMs && frame.timestampMs <= toMs,
  );
  const base = kept[0]?.timestampMs ?? 0;
  return {
    ...sequence,
    frames: kept.map((frame, index) => ({
      ...frame,
      frameIndex: index,
      timestampMs: frame.timestampMs - base,
    })),
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
                ? { ...mark, visibility: LIMITS.minLandmarkVisibility - 0.01 }
                : mark,
            ),
          }
        : frame,
    ),
  };
}

/** Four volleys every 450 ms from 1000 ms whose valleys stay at 72 % of the peaks. */
function handBattle72(): PoseSequence {
  return wristSpeedProfile(5000, 60, tMs => {
    if (tMs < 1000 || tMs > 2800) return 0;
    const phase = ((tMs - 1000) % 450) / 450;
    return 0.72 + 0.28 * Math.max(0, 1 - Math.abs(phase - 0.5) * 2);
  });
}

/** Two strokes 1.5 s apart; the wrist is lost for the 400 ms of the second. */
function hiddenSecondStroke(): PoseSequence {
  const two = wristSpeedProfile(
    4000,
    60,
    tMs => hump(1000, 150, 1.0)(tMs) + hump(2500, 150, 1.0)(tMs),
  );
  return occludeRightWrist(two, 2300, 2700);
}

/** A backward wind-up then a forward swing, trimmed to start at the wind-up's peak. */
function clipStartingMidBackswing(): PoseSequence {
  const full = wristTravelProfile(3000, 60, tMs => [
    -hump(1000, 150, 1.2)(tMs) + hump(1350, 150, 3.0)(tMs),
    0,
  ]);
  return trimSequence(full, 1000, 3000);
}

function signIn(account = owner) {
  setActiveDataOwner(account);
  establishApiSession({
    canonicalAppUserId: account,
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    provider: 'apple',
  });
}

const analyzeCaptureMock = pipeline.analyzeCapture as jest.MockedFunction<
  typeof pipeline.analyzeCapture
>;

describe('W03-01 attack S — ambiguous imports on the shipping runCaptureAnalysis path', () => {
  beforeEach(() => {
    signIn();
    analyzeCaptureMock.mockClear();
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it.each([
    [
      'S1: a four-volley hand battle whose valleys stay at 72 % of the peaks',
      handBattle72,
    ],
    [
      'S2: a second stroke hidden in a 400 ms wrist-tracking hole',
      hiddenSecondStroke,
    ],
    [
      'S3: a clip that starts in the middle of the backswing',
      clipStartingMidBackswing,
    ],
  ])(
    '%s is refused before any permit is reserved — fetch is never called, nothing is rated',
    async (_title, build) => {
      const { db, calls } = createSqliteTestDb();
      const { clip, sidecarJson } = importedClipWithSidecar(build());
      mockReadArtifact = async () => sidecarJson;
      const { fetchMock, finalized } = permitServer();
      (globalThis as { fetch?: unknown }).fetch = fetchMock;

      const outcome = await runCaptureAnalysis(request(db, clip));

      const permitCalls = fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter(url => url.endsWith('/v1/analysis-permits'));
      const summary = {
        kind: outcome.kind,
        reason: 'reason' in outcome ? outcome.reason : null,
        permitReservations: permitCalls.length,
        permitFinalizations: finalized,
        inferenceRuns: analyzeCaptureMock.mock.calls.length,
        ratedShotWrites: calls.filter(call =>
          call.sql.includes('INSERT OR REPLACE INTO local_shot'),
        ).length,
      };
      expect(summary).toEqual({
        kind: 'quality_blocked',
        reason: expect.stringMatching(
          new RegExp(
            [
              importAdmissionRejectionMessage('multiple_stroke_events'),
              importAdmissionRejectionMessage('stroke_truncated_at_clip_edge'),
              importAdmissionRejectionMessage('wrist_not_tracked'),
            ]
              .map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('|'),
          ),
        ),
        permitReservations: 0,
        permitFinalizations: [],
        inferenceRuns: 0,
        ratedShotWrites: 0,
      });
    },
  );

  it('S4: a double submit of one admitted import reserves at most one permit and rates at most once', async () => {
    const { db, calls } = createSqliteTestDb();
    const { clip, sidecarJson } = importedClipWithSidecar(
      generateSwingSequence().sequence,
    );
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const req = request(db, clip);
    const outcomes = await Promise.all([
      runCaptureAnalysis(req),
      runCaptureAnalysis(req),
    ]);
    const permitCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter(url => url.endsWith('/v1/analysis-permits'));
    expect(permitCalls.length).toBeLessThanOrEqual(1);
    expect(analyzeCaptureMock.mock.calls.length).toBeLessThanOrEqual(1);
    expect(
      calls.filter(call =>
        call.sql.includes('INSERT OR REPLACE INTO local_shot'),
      ).length,
    ).toBeLessThanOrEqual(1);
    expect(outcomes.some(outcome => outcome.kind === 'scored')).toBe(true);
  });

  it.each([
    [429, { error: { code: 'rate_limited', message: 'Too many requests.' } }],
    [503, { error: { code: 'unavailable', message: 'Service unavailable.' } }],
  ])(
    'S5: an admitted import whose permit reservation answers %s runs no inference and rates nothing',
    async (status, body) => {
      const { db, calls } = createSqliteTestDb();
      const { clip, sidecarJson } = importedClipWithSidecar(
        generateSwingSequence().sequence,
      );
      mockReadArtifact = async () => sidecarJson;
      const fetchMock = jest.fn(async (url: string) => {
        if (url.endsWith('/v1/analysis-permits'))
          return jsonResponse(body, status);
        throw new Error(`Unexpected fetch: ${url}`);
      });
      (globalThis as { fetch?: unknown }).fetch = fetchMock;

      const outcome = await runCaptureAnalysis(request(db, clip));
      expect(outcome.kind).toBe('unavailable');
      expect(analyzeCaptureMock).not.toHaveBeenCalled();
      expect(
        calls.some(call =>
          call.sql.includes('INSERT OR REPLACE INTO local_shot'),
        ),
      ).toBe(false);
      expect(
        calls.some(call => call.sql.includes('local_analysis_record')),
      ).toBe(false);
    },
  );
});
