/**
 * Shared fixtures for the mobile-data-sync adversarial pass
 * (__tests__/attack/mobileDataSync1). Everything here is test-only.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { CapturedClip } from '../../src/camera/capture';
import type { SyncTransport } from '../../src/data/sync';

export const OWNER_A = '11111111-1111-4111-8111-111111111111';
export const OWNER_B = '22222222-2222-4222-8222-222222222222';
export const PERMIT_ID = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const SHOT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

export const realAnalysis: ShotAnalysis = {
  id: SHOT_ID,
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.8,
  analysisConfidence: 0.91,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'validated-bundle-1',
    poseModelVersion: 'pose-1',
    paddleModelVersion: 'paddle-1',
    strokeDetectorVersion: 'stroke-1',
    phaseModelVersion: 'phase-1',
    scoringModelVersion: 'score-1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

export const capturedClip: CapturedClip = {
  uri: 'file:///private/captures/real.mov',
  durationMs: 3900,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger: {
    startMs: 1800,
    endMs: 2450,
    peakMotionMs: 2220,
    confidence: 0.84,
    source: 'temporal_pose_motion',
    modelVersion: 'temporal-stroke-heuristic-2',
  },
  captureEvidence: {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'mediapipe_pose_landmarker',
    poseModelVersion: 'mediapipe-pose-landmarker-full-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: 8,
    poseFrameCount: 7,
    poseMissingFrameCount: 1,
    trackedDurationMs: 600,
    meanCanonicalJointVisibility: 0.86,
    meanJointCoverage: 0.93,
    minimumJointCoverage: 0.83,
    fullBodyVisibleFrameCount: 5,
    jointMotion: [
      {
        joint: 'left_wrist',
        sampleCount: 6,
        meanNormalizedPerSecond: 1.2,
        peakNormalizedPerSecond: 2.1,
      },
    ],
  },
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 1800,
  postRollMs: 1450,
};

/** Same regex as supabase/functions/api/index.ts `UUID_RE` (line 179). */
export const SERVER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const serverIsUuid = (value: unknown): value is string =>
  typeof value === 'string' && SERVER_UUID_RE.test(value);

export interface SyncShotsRequest {
  shots: Array<Record<string, unknown>>;
}

/**
 * In-process emulation of POST /v1/shots:sync as implemented by
 * supabase/functions/api/index.ts `syncShots` + `parseSyncShot` (the UUID
 * checks that gate a payload) and the `apply_synced_shot` replay rule
 * ("this user already owns the row → accepted"). It is deliberately narrow:
 * only the validation branches this attack pass exercises are reproduced,
 * and it mirrors the real handler's ordering (parse whole batch first, then
 * replay lookup, then per-shot apply).
 */
export function createServerEmulator(): SyncTransport & {
  requests: SyncShotsRequest[];
  /** apply_synced_shot RPC invocations (replays inside one batch still call it). */
  rpcCalls: string[];
  /** Shot ids actually inserted server-side. */
  inserted: string[];
  owned: Set<string>;
} {
  const owned = new Set<string>();
  const requests: SyncShotsRequest[] = [];
  const rpcCalls: string[] = [];
  const inserted: string[] = [];
  return {
    requests,
    rpcCalls,
    inserted,
    owned,
    async syncShots(shots) {
      const batch = shots as Array<Record<string, unknown>>;
      requests.push({ shots: batch });
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      const parsed: Array<Record<string, unknown>> = [];
      for (const raw of batch) {
        const rawId = typeof raw.id === 'string' ? raw.id : 'unknown';
        if (!serverIsUuid(raw.id)) {
          rejected.push({
            id: rawId,
            code: 'shot.invalid_payload',
            message: 'id must be a UUID.',
          });
          continue;
        }
        if (raw.source !== 'real') {
          rejected.push({
            id: rawId,
            code: 'shot.non_real_source',
            message: 'Only analyses produced by a real provider may be synced.',
          });
          continue;
        }
        if (!serverIsUuid(raw.analysisPermitId)) {
          rejected.push({
            id: rawId,
            code: 'shot.invalid_payload',
            message: 'analysisPermitId must be a UUID.',
          });
          continue;
        }
        if (raw.sessionId !== null && !serverIsUuid(raw.sessionId)) {
          rejected.push({
            id: rawId,
            code: 'shot.invalid_payload',
            message: 'sessionId must be a UUID or null.',
          });
          continue;
        }
        parsed.push(raw);
      }
      const replayIds = new Set(
        parsed.map(s => String(s.id)).filter(id => owned.has(id)),
      );
      for (const shot of parsed) {
        const id = String(shot.id);
        if (replayIds.has(id)) {
          acceptedIds.push(id);
          continue;
        }
        // apply_synced_shot: "already owns the row → accepted" (idempotent),
        // otherwise insert.
        rpcCalls.push(id);
        if (!owned.has(id)) {
          owned.add(id);
          inserted.push(id);
        }
        acceptedIds.push(id);
      }
      return { acceptedIds, rejected };
    },
    async createSession() {},
    async finalizeSession() {},
  };
}

export const flushMicrotasks = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};
