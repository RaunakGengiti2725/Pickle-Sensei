/**
 * ADVERSARY (INT-import-media-capture): the capture envelope on the IMPORT
 * path and the shared evaluator's numeric domain.
 *
 * Guided captures evaluate `attemptCaptureEnvelope` (resolution / frame rate
 * / duration floors) and are quality-blocked on UNSUPPORTED. Imported videos
 * enter `runCaptureAnalysis` the way AnalyzeScreen wires them (no envelope).
 * Attacks: a 240p @ 8 fps import with a valid sidecar; non-finite, negative
 * and out-of-domain measurements fed to the pure evaluator.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import {
  evaluateCaptureEnvelope,
  type CaptureEnvelopeMeasurements,
} from '@pickle/capture-envelope';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import { attemptCaptureEnvelope } from '../../src/camera/captureEnvelope';
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

const owner = '44444444-4444-4444-8444-444444444444';
const captureId = '88888888-8888-4888-8888-888888888888';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function permitFetch(finalized: Array<{ outcome?: string }>): jest.Mock {
  return jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      return jsonResponse({
        permit: {
          id: '99999999-9999-4999-8999-999999999999',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-30T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      finalized.push(JSON.parse(String(init?.body)) as { outcome?: string });
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function importedClip(
  sidecarJson: string,
  sequence: PoseSequence,
  durationMs: number,
): CapturedClip {
  return {
    uri: 'file:///imports/potato-cam.mov',
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
      uri: 'file:///imports/potato-cam.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
}

function screenShapedRequest(db: LocalDb, clip: CapturedClip) {
  seedSqliteCapture(db, owner, captureId, clip);
  // Mirrors AnalyzeScreen: imported clips are submitted WITHOUT an envelope.
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
    captureEnvelope: null,
    targetSeed: {
      point: { x: 0.42, y: 0.63 },
      selectedAtIso: '2026-08-30T10:01:00.000Z',
    },
  };
}

const allNull: CaptureEnvelopeMeasurements = {
  frameWidthPx: null,
  frameHeightPx: null,
  avgFrameRateFps: null,
  brightnessMeanLuma: null,
  brightnessStdLuma: null,
  laplacianVarianceMedian: null,
  meanAbsFrameDiff: null,
  denoiseSurvivalRatio: null,
  clippedPixelFraction: null,
  contrastNormalizedFrameDiff: null,
  frameIntervalCv: null,
  clipDurationMs: null,
  playerPixelHeightFraction: null,
  playerMeanJointVisibility: null,
};

describe('ADV import envelope gate', () => {
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

  it('ATTACK G1: a 240p @ 8 fps IMPORT with a valid sidecar -> the envelope says UNSUPPORTED, so the run must not score it', async () => {
    const { sequence, window } = generateSwingSequence();
    const lowQuality: PoseSequence = {
      ...sequence,
      video: { ...sequence.video, width: 240, height: 426, fps: 8 },
    };
    const sidecarJson = serializePoseSequence(lowQuality);
    const clip = importedClip(sidecarJson, lowQuality, window.endMs);

    const envelope = attemptCaptureEnvelope(clip, null, null);
    const unsupported = envelope.dimensions
      .filter(dimension => dimension.status === 'UNSUPPORTED')
      .map(dimension => dimension.dimension);
    expect(unsupported).toEqual(
      expect.arrayContaining(['resolution', 'frame_rate']),
    );

    const { db } = createSqliteTestDb();
    mockReadArtifact = async () => sidecarJson;
    const finalized: Array<{ outcome?: string }> = [];
    (globalThis as { fetch?: unknown }).fetch = permitFetch(finalized);
    const outcome = await runCaptureAnalysis(screenShapedRequest(db, clip));
    expect(outcome.kind).toBe('quality_blocked');
    expect(finalized.filter(entry => entry.outcome === 'scored')).toHaveLength(
      0,
    );
  });

  it.each([
    [
      'frameWidthPx+frameHeightPx',
      { frameWidthPx: Infinity, frameHeightPx: Infinity },
    ],
    ['avgFrameRateFps', { avgFrameRateFps: Infinity }],
    ['laplacianVarianceMedian', { laplacianVarianceMedian: Infinity }],
    ['denoiseSurvivalRatio', { denoiseSurvivalRatio: Infinity }],
    ['playerPixelHeightFraction', { playerPixelHeightFraction: Infinity }],
    ['playerMeanJointVisibility', { playerMeanJointVisibility: Infinity }],
  ] as const)(
    'ATTACK G2: +Infinity for %s is not a measurement -> must not be SUPPORTED',
    (_label, patch) => {
      const verdict = evaluateCaptureEnvelope({ ...allNull, ...patch });
      const supported = verdict.dimensions.filter(
        dimension => dimension.status === 'SUPPORTED',
      );
      expect(supported).toEqual([]);
    },
  );

  it.each([
    ['clippedPixelFraction', { clippedPixelFraction: -1 }],
    ['brightnessStdLuma', { brightnessStdLuma: -1 }],
    ['meanAbsFrameDiff', { meanAbsFrameDiff: -1 }],
    ['contrastNormalizedFrameDiff', { contrastNormalizedFrameDiff: -1 }],
    ['frameIntervalCv', { frameIntervalCv: -Infinity }],
  ] as const)(
    'ATTACK G3: a negative %s (impossible for a non-negative statistic) -> must not be SUPPORTED',
    (_label, patch) => {
      const verdict = evaluateCaptureEnvelope({ ...allNull, ...patch });
      const supported = verdict.dimensions.filter(
        dimension => dimension.status === 'SUPPORTED',
      );
      expect(supported).toEqual([]);
    },
  );

  it('ATTACK G4: visibility 1.5 and pixel-height fraction 5 are outside their [0,1] domains -> must not be SUPPORTED', () => {
    const verdict = evaluateCaptureEnvelope({
      ...allNull,
      playerMeanJointVisibility: 1.5,
      playerPixelHeightFraction: 5,
    });
    const supported = verdict.dimensions.filter(
      dimension => dimension.status === 'SUPPORTED',
    );
    expect(supported).toEqual([]);
  });

  it('control: a fully-null measurement set is entirely NOT_MEASURED and never SUPPORTED', () => {
    const verdict = evaluateCaptureEnvelope(allNull);
    expect(verdict.overallWithCoverage).toBe('SUPPORTED_UNMEASURED');
    expect(verdict.notMeasured).toHaveLength(verdict.dimensions.length);
  });
});
