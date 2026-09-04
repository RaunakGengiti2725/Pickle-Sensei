/**
 * Adjudication reproduction (xc-journeys / journey-analyze-happy-and-fail):
 * after the server permit is reserved, a local-storage failure while
 * persisting the scored run must not leave the reservation orphaned — it
 * occupies one of the free-tier allowances for up to 24h
 * (analysis_permits reserved-count window in reserve_analysis_permit()).
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import type { CapturedClip } from '../../../src/camera/capture';
import { runCaptureAnalysis } from '../../../src/analysis/runCaptureAnalysis';

jest.mock('../../../src/camera/capture', () => {
  const actual = jest.requireActual('../../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '11111111-1111-4111-8111-111111111111';

function failingDb(failWhenSqlIncludes: string): {
  db: LocalDb;
  calls: string[];
} {
  const calls: string[] = [];
  const db: LocalDb = {
    async execute(sql) {
      calls.push(sql);
      if (sql.includes(failWhenSqlIncludes)) {
        throw new Error('SQLITE_FULL: database or disk is full');
      }
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

function permitServer(): {
  fetchMock: jest.Mock;
  reserved: number;
  finalized: unknown[];
} {
  const state = {
    fetchMock: jest.fn(),
    reserved: 0,
    finalized: [] as unknown[],
  };
  state.fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      state.reserved += 1;
      return jsonResponse({
        permit: {
          id: 'permit-1',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-27T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      state.finalized.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return state;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-abc.mov',
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
      uri: 'file:///captures/stroke-abc.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

describe('adjudication: permit reservation vs local-storage failure', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it.each([
    [
      'saveAnalysisRecord (local_analysis_record insert)',
      'local_analysis_record',
    ],
    ['markCaptureAnalyzed (status update)', "SET status = 'analyzed'"],
    [
      'saveAnalysis (local_shot / outbox write)',
      'INSERT OR REPLACE INTO local_shot',
    ],
  ])(
    'a throw in %s after reserve leaves the permit reserved (no release, no outbox row)',
    async (_label, failingSql) => {
      const { db, calls } = failingDb(failingSql);
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const server = permitServer();
      (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

      await expect(
        runCaptureAnalysis({
          db,
          captureId: 'capture-1',
          clip,
          declaredStroke: 'forehand_drive',
          handedness: 'right',
          cameraView: 'side',
          apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
          appVersion: '0.1.0',
        }),
      ).rejects.toThrow('SQLITE_FULL');

      const outboxRows = calls.filter(sql =>
        sql.includes('INSERT INTO outbox'),
      );

      console.log(
        `[adjudicate] fail=${failingSql} reserved=${server.reserved} released=${server.finalized.length} outboxRows=${outboxRows.length}`,
      );
      expect(server.reserved).toBe(1);
      // The reservation was neither consumed by a queued sync nor released:
      // it stays 'reserved' server-side for up to 24h against the allowance.
      expect(outboxRows.length > 0 || server.finalized.length > 0).toBe(true);
    },
  );
});
