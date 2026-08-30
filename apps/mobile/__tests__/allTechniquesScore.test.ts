// The scoring flow pulls in the SQLite-backed db, whose native binding does
// not exist under jest. Every db touch in this test uses the recording stub.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  SELECTABLE_TECHNIQUES_V1,
  SHOT_TYPES,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

/**
 * EVERY TECHNIQUE SCORES — the product guarantee this suite locks.
 *
 * A guided capture with a real recorded pose sequence, declared as ANY of
 * the eight ShotTypeSlugs (and any selectable canonical technique), must
 * come back `scored`. No "not yet released" refusals, no invented
 * abstentions: the registry resolves sm-v1 for every stroke and every
 * stroke has a complete metric target configuration.
 */

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '33333333-3333-4333-8333-333333333333';

function recordingDb(): { db: LocalDb; calls: { sql: string }[] } {
  const calls: { sql: string }[] = [];
  const db: LocalDb = {
    async execute(sql) {
      calls.push({ sql });
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function permitServer(): { fetchMock: jest.Mock; finalized: unknown[] } {
  const finalized: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      return jsonResponse({
        permit: {
          id: 'permit-all-1',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-27T20:00:00.000Z',
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

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-all.mov',
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
      uri: 'file:///captures/stroke-all.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function request(
  db: LocalDb,
  clip: CapturedClip,
  declaredStroke: ShotTypeSlug,
  declaredCanonical: string | null,
) {
  return {
    db,
    captureId: `capture-all-${declaredStroke}`,
    clip,
    declaredStroke,
    declaredCanonical,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

describe('every declared technique produces a real score', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it.each(SHOT_TYPES.map(slug => [slug] as const))(
    'declared "%s" scores end-to-end (no unreleased techniques)',
    async slug => {
      const { db, calls } = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const { fetchMock, finalized } = permitServer();
      (globalThis as { fetch?: unknown }).fetch = fetchMock;

      const outcome = await runCaptureAnalysis(request(db, clip, slug, null));
      expect(outcome.kind).toBe('scored');
      if (outcome.kind !== 'scored') return;
      expect(outcome.record.result?.shotType).toBe(slug);
      expect(outcome.record.result?.resultKind).toBe('scored');
      expect(outcome.record.result?.overallScore).not.toBeNull();
      // The rating was promoted and queued for sync — never released.
      expect(finalized).toHaveLength(0);
      expect(
        calls.filter(call => call.sql.includes('INSERT INTO outbox')),
      ).toHaveLength(1);
    },
  );

  it.each(
    SELECTABLE_TECHNIQUES_V1.filter(
      technique => technique.legacySlug !== null,
    ).map(technique => [technique.canonical, technique.legacySlug!] as const),
  )(
    'canonical technique "%s" (slug %s) scores end-to-end',
    async (canonical, slug) => {
      const { db } = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const { fetchMock } = permitServer();
      (globalThis as { fetch?: unknown }).fetch = fetchMock;

      const outcome = await runCaptureAnalysis(
        request(db, clip, slug, canonical),
      );
      expect(outcome.kind).toBe('scored');
      if (outcome.kind !== 'scored') return;
      expect(outcome.record.result?.overallScore).not.toBeNull();
    },
  );
});
