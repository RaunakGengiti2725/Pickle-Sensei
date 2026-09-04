/**
 * Valid persisted records — one per fuzzed surface. Each is what the app
 * itself writes today (schema version 1); the generators mutate these into
 * random bytes, truncations, retyped fields and future schema versions.
 */
import type { Json } from './generators';

export const PROFILE_TEMPLATE: Json = {
  firstName: 'Sam',
  gender: 'prefer_not_to_say',
  skillLevel: 'intermediate',
  handedness: 'right',
  goal: 'dinks',
  biggestProblem: 'consistency',
  focusCheckpoint: 'contact_position',
};

export const PENDING_PROFILE_TEMPLATE: Json = {
  version: 1,
  profile: PROFILE_TEMPLATE,
};

export const CONSISTENCY_LEDGER_TEMPLATE: Json = {
  version: 1,
  drills: [
    {
      id: 'drill-1',
      slug: 'soft-hands-dinks',
      title: 'Soft hands dinks',
      completedAtIso: '2026-08-30T17:00:00.000Z',
    },
  ],
  celebrated: { 'streak-7': '2026-08-30' },
  daySecuredShownDay: '2026-08-30',
};

export const NOTIFICATION_PREFS_TEMPLATE: Json = {
  version: 1,
  enabled: true,
  practiceReminder: true,
  practiceReminderMinutes: 18 * 60,
  streakDefense: true,
  weeklyRecap: false,
  comeback: true,
  promptDismissed: true,
};

export const PENDING_NOTIFICATION_CHOICE_TEMPLATE: Json = {
  version: 1,
  enabled: true,
};

export const REVIEW_PROMPT_TEMPLATE: Json = {
  version: 1,
  scoredAnalyses: 4,
  promptedCount: 1,
  lastPromptedAtIso: '2026-08-20T12:00:00.000Z',
  reviewedAtIso: null,
};

export const RANK_RECORD_TEMPLATE: Json = {
  version: 1,
  tier: 'silver',
  rating: 4.2,
};

export const PRACTICE_SET_TEMPLATE: Json = {
  sessionId: 'set-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  shotType: 'forehand_drive',
  startedAtIso: '2026-09-04T05:00:00.000Z',
  lastActivityAtIso: '2026-09-04T05:20:00.000Z',
};

export const WALKTHROUGH_TEMPLATE: Json = { version: 1 };

export const LOCAL_MODE_TEMPLATE: Json = { version: 1, mode: 'guest' };

export const LIVE_SESSION_SUMMARY_TEMPLATE: Json = {
  version: 1,
  engineVersion: 'live-1',
  source: 'live',
  durationMs: 420_000,
  strokeCount: 12,
  scoredCount: 9,
  noReadCount: 2,
  pendingCount: 1,
  startAverage: 6.1,
  endAverage: 7.2,
  delta: 1.1,
  bestScore: 8.4,
  sessionAverage: 6.9,
  cuesSpoken: 5,
  topCorrection: 'contact_position',
  correctionsByCheckpoint: { contact_position: 3, preparation: 2 },
};

export const CAPTURE_TARGET_SEED_TEMPLATE: Json = {
  point: { x: 0.42, y: 0.63 },
  selectedAtIso: '2026-08-28T00:00:00.000Z',
};

export const SHOT_ANALYSIS_TEMPLATE: Json = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-26T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [
    { key: 'contact_position', score: 7.1, applicable: true },
    { key: 'preparation', score: null, applicable: false },
  ],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: { checkpoint: 'contact_position' },
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

export const OUTBOX_SHOT_TEMPLATE: Json = {
  ...(SHOT_ANALYSIS_TEMPLATE as { [key: string]: Json }),
  analysisPermitId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
};

export const OUTBOX_SESSION_TEMPLATE: Json = {
  id: 'set-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  startedAt: '2026-09-04T05:00:00.000Z',
  shotType: 'forehand_drive',
};

export const OUTBOX_TRIAL_TEMPLATE: Json = {
  trialId: 'trial-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  shotId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  outcome: 'scored',
};

export const ANALYSIS_RECORD_TEMPLATE: Json = {
  schemaVersion: 1,
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  captureId: 'capture-1',
  createdAtIso: '2026-08-26T18:00:00.000Z',
  engineVersion: 'fusion-1',
  strokeTaxonomyVersion: 'tax-1',
  strokeResolution: { status: 'declared', canonical: 'forehand_drive' },
  modalities: { pose: 'available', ball: 'unavailable' },
  modelRuns: [],
  provenance: { appVersion: '0.1.0' },
  result: SHOT_ANALYSIS_TEMPLATE,
  faults: [],
  uncertainty: { level: 'low' },
  evidence: [],
};

export const CAPTURE_ROW_META = {
  id: 'capture-1',
  uri: 'file:///imports/rally.mov',
  shot_type: 'forehand_drive',
  declared_stroke: 'forehand_drive',
  captured_at: '2026-08-27T18:10:00.000Z',
  duration_ms: 5100,
  fps: 30,
  width: 1920,
  height: 1080,
  status: 'awaiting_model',
} as const;

export const CAPTURED_CLIP_TEMPLATE: Json = {
  uri: CAPTURE_ROW_META.uri,
  durationMs: CAPTURE_ROW_META.duration_ms,
  fps: CAPTURE_ROW_META.fps,
  width: CAPTURE_ROW_META.width,
  height: CAPTURE_ROW_META.height,
  capturedAtIso: CAPTURE_ROW_META.captured_at,
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
};

export const VAULT_RECORD_TEMPLATE: Json = {
  version: 1,
  provider: 'apple',
  canonicalAppUserId: '7fc2c743-028f-4ec6-942c-a84508f3be38',
  refreshToken: 'refresh-token-v1',
  email: 'pat@example.com',
  displayName: 'Pat',
};
