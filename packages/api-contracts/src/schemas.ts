import { z } from "zod";
import {
  CAMERA_VIEWS,
  CHECKPOINTS,
  CONSENT_ACTIONS,
  CONSENT_CAPTURE_MODES,
  CONSENT_SCOPES,
  CONSENT_SOURCES,
  FAULT_DIRECTIONS,
  PHASES,
  SHOT_TYPES,
} from "@pickle/shared-types";

/**
 * Single source of truth for /v1 payloads (directive §29). The backend
 * validates requests against these; mobile derives static types from them.
 * No manually drifting duplicates.
 */

export const ErrorEnvelope = z.object({
  error: z.object({
    kind: z.enum([
      "timeout",
      "retryable",
      "permanent",
      "low_confidence",
      "permission_denied",
      "network",
      "unsupported_device",
      "corrupted_media",
      "auth_failed",
      "not_implemented",
    ]),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelopeT = z.infer<typeof ErrorEnvelope>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
});

export const ShotTypeItem = z.object({
  id: z.uuid(),
  slug: z.enum(SHOT_TYPES),
  name: z.string(),
  description: z.string(),
  displayOrder: z.number().int(),
  enabled: z.boolean(),
});
export const ShotTypesResponse = z.object({ items: z.array(ShotTypeItem) });

export const CheckpointItem = z.object({
  id: z.uuid(),
  slug: z.enum(CHECKPOINTS),
  name: z.string(),
  description: z.string(),
  displayOrder: z.number().int(),
});
export const CheckpointsResponse = z.object({ items: z.array(CheckpointItem) });

export const VersionVectorSchema = z.object({
  appVersion: z.string(),
  modelBundleVersion: z.string(),
  poseModelVersion: z.string(),
  paddleModelVersion: z.string(),
  strokeDetectorVersion: z.string(),
  phaseModelVersion: z.string(),
  scoringModelVersion: z.string(),
  shotConfigVersion: z.string(),
});

export const PhaseSpanSchema = z.object({
  key: z.enum(PHASES),
  startMs: z.number().int().nonnegative(),
  representativeMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
});

export const CheckpointScoreSchema = z.object({
  key: z.enum(CHECKPOINTS),
  score: z.number().min(0).max(100).nullable(),
  confidence: z.number().min(0).max(1),
  band: z.enum(["green", "yellow", "red", "unscored"]),
  direction: z.enum(FAULT_DIRECTIONS),
  severity: z.number().min(0).max(1),
  applicable: z.boolean(),
});

/** Canonical shot-sync payload (spec p. 21).
 *
 * Every persisted analysis is bound to the server-issued permit reserved
 * before inference. A scored result consumes that permit in the same database
 * transaction as the shot insert; an abstention releases it atomically.
 */
export const ShotSyncPayload = z
  .object({
    id: z.uuid(),
    analysisPermitId: z.uuid(),
    sessionId: z.uuid().nullable(),
    shotType: z.enum(SHOT_TYPES),
    cameraView: z.enum(CAMERA_VIEWS),
    capturedAt: z.iso.datetime(),
    timestamps: z.object({
      startMs: z.number().int().nonnegative(),
      contactMs: z.number().int().nonnegative().nullable(),
      endMs: z.number().int().nonnegative(),
    }),
    overallScore: z.number().min(0).max(10).nullable(),
    confidence: z.number().min(0).max(1),
    resultKind: z.enum(["scored", "low_confidence"]),
    source: z.literal("real"),
    phases: z.array(PhaseSpanSchema),
    checkpoints: z.array(CheckpointScoreSchema),
    versionVector: VersionVectorSchema,
  })
  .superRefine((value, context) => {
    if (value.resultKind === "scored" && value.overallScore === null) {
      context.addIssue({
        code: "custom",
        path: ["overallScore"],
        message: "overallScore is required when resultKind is scored",
      });
    }
    if (value.resultKind === "low_confidence" && value.overallScore !== null) {
      context.addIssue({
        code: "custom",
        path: ["overallScore"],
        message: "overallScore must be null when resultKind is low_confidence",
      });
    }
  });
export type ShotSyncPayloadT = z.infer<typeof ShotSyncPayload>;

export const ShotsSyncRequest = z.object({
  shots: z.array(ShotSyncPayload).min(1).max(200),
});
export const ShotsSyncResponse = z.object({
  acceptedIds: z.array(z.uuid()),
  rejected: z.array(z.object({ id: z.uuid(), code: z.string(), message: z.string() })),
});

export const SessionCreateRequest = z.object({
  id: z.uuid(),
  mode: z.enum(["live", "guided_drill", "single", "import"]),
  shotType: z.enum(SHOT_TYPES).nullable(),
  focusCheckpoint: z.enum(CHECKPOINTS).nullable(),
  cameraView: z.enum(CAMERA_VIEWS).nullable(),
  startedAt: z.iso.datetime(),
});
export const SessionResponse = z.object({
  session: z.object({
    id: z.uuid(),
    mode: z.enum(["live", "guided_drill", "single", "import"]),
    shotType: z.enum(SHOT_TYPES).nullable(),
    focusCheckpoint: z.enum(CHECKPOINTS).nullable(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    completed: z.boolean(),
    shotCount: z.number().int().nonnegative(),
  }),
});

export const AccountBootstrapRequest = z.object({
  locale: z.string(),
  timezone: z.string(),
  device: z.object({
    platform: z.enum(["ios", "android"]),
    osVersion: z.string(),
    appVersion: z.string(),
    model: z.string(),
  }),
});

export const AccessStateSchema = z.object({
  premium: z.boolean(),
  entitlements: z.array(z.string()),
  freeRatings: z.object({
    limit: z.literal(2),
    used: z.number().int().min(0).max(2),
    reserved: z.number().int().nonnegative(),
    remaining: z.number().int().min(0).max(2),
    availableToReserve: z.number().int().min(0).max(2),
  }),
  canStartRating: z.boolean(),
  paywallRequired: z.boolean(),
});
export type AccessStateT = z.infer<typeof AccessStateSchema>;

export const AnalysisPermitSchema = z.object({
  id: z.uuid(),
  accessSource: z.enum(["free", "premium"]),
  status: z.enum(["reserved", "consumed", "released", "expired"]),
  outcome: z
    .enum([
      "scored",
      "low_confidence",
      "cancelled",
      "failed",
      "unsupported",
      "incorrect_recognition",
      "expired",
    ])
    .nullable(),
  ratingId: z.uuid().nullable(),
  reservedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  finalizedAt: z.iso.datetime().nullable(),
});

export const AnalysisPermitReserveRequest = z.object({
  idempotencyKey: z.uuid(),
});
export const AnalysisPermitResponse = z.object({
  permit: AnalysisPermitSchema,
  access: AccessStateSchema,
});

export const AnalysisPermitFinalizeRequest = z
  .object({
    outcome: z.enum([
      "scored",
      "low_confidence",
      "cancelled",
      "failed",
      "unsupported",
      "incorrect_recognition",
    ]),
    ratingId: z.uuid().nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.outcome === "scored" && !value.ratingId) {
      context.addIssue({
        code: "custom",
        path: ["ratingId"],
        message: "ratingId is required when outcome is scored",
      });
    }
    if (value.outcome !== "scored" && value.ratingId) {
      context.addIssue({
        code: "custom",
        path: ["ratingId"],
        message: "ratingId must be null unless outcome is scored",
      });
    }
  });

export const RevenueCatSyncResponse = z.object({
  billing: z.object({
    premium: z.boolean(),
    productKey: z.string().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    verifiedAt: z.iso.datetime(),
  }),
  access: AccessStateSchema,
});

/** Real training lifecycle contracts. No endpoint accepts computed scores or
 * streak qualification from a client; those are always derived server-side. */
export const TrainingPlanCreateRequest = z.object({
  sourceShotId: z.uuid(),
});

export const TrainingPlanReassessmentRequest = z.object({
  shotId: z.uuid(),
});

export const DrillCompletionCreateRequest = z
  .object({
    id: z.uuid(),
    drillSlug: z.string().min(3).max(60),
    trainingPlanItemId: z.uuid().nullable().optional(),
    practiceSessionId: z.uuid().nullable().optional(),
    completedAt: z.iso.datetime(),
    actualRepetitions: z.number().int().min(1).max(10_000).nullable().optional(),
    actualDurationSeconds: z.number().int().min(1).max(14_400).nullable().optional(),
  })
  .refine(
    (value) => value.actualRepetitions != null || value.actualDurationSeconds != null,
    "A completion requires actual repetitions or duration.",
  );
export type DrillCompletionCreateRequestT = z.infer<typeof DrillCompletionCreateRequest>;

export const TrainingPlanItemSchema = z.object({
  id: z.uuid(),
  position: z.number().int().positive(),
  kind: z.enum(["warmup", "targeted", "reassessment"]),
  drill: z
    .object({
      slug: z.string(),
      title: z.string(),
      description: z.string(),
      coachName: z.string(),
      equipment: z.array(z.unknown()),
      saved: z.boolean(),
    })
    .nullable(),
  cueText: z.string().nullable(),
  targetSets: z.number().int().nullable(),
  targetRepetitionsPerSet: z.number().int().nullable(),
  targetDurationSeconds: z.number().int().nullable(),
  restSeconds: z.number().int().nullable(),
  completion: z
    .object({
      id: z.uuid(),
      completedAt: z.iso.datetime(),
      actualRepetitions: z.number().int().nullable(),
      actualDurationSeconds: z.number().int().nullable(),
      qualifiesForStreak: z.boolean(),
    })
    .nullable(),
});

export const TrainingPlanSchema = z.object({
  id: z.uuid(),
  status: z.enum(["active", "completed", "superseded"]),
  algorithmVersion: z.string(),
  sourceShotId: z.uuid(),
  shotType: z.enum(SHOT_TYPES),
  priorityCheckpoint: z.enum(CHECKPOINTS),
  priorityDirection: z.enum(FAULT_DIRECTIONS),
  baselineScore: z.number().min(0).max(10),
  baselineCheckpointScore: z.number().min(0).max(100).nullable(),
  reassessmentShotId: z.uuid().nullable(),
  scoreDelta: z.number().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  items: z.array(TrainingPlanItemSchema),
});
export const TrainingPlanResponse = z.object({ plan: TrainingPlanSchema.nullable() });

export const PracticeStreakSchema = z.object({
  currentDays: z.number().int().nonnegative(),
  longestDays: z.number().int().nonnegative(),
  practicedToday: z.boolean(),
  lastPracticeDate: z.iso.date().nullable(),
});

/** First-party consent ledger contracts (append-only; scopes independent).
 * model_training is an explicit opt-in — no endpoint or default grants it. */
export const ConsentGrantRequest = z.object({
  scope: z.enum(CONSENT_SCOPES),
  consentVersion: z.string().min(1).max(64),
  source: z.enum(CONSENT_SOURCES),
  device: z.string().min(1).max(160).nullable().optional(),
  captureMode: z.enum(CONSENT_CAPTURE_MODES),
  strokeIntent: z.string().min(1).max(60).nullable().optional(),
});
export type ConsentGrantRequestT = z.infer<typeof ConsentGrantRequest>;

export const ConsentWithdrawRequest = z.object({
  scope: z.enum(CONSENT_SCOPES),
  source: z.enum(CONSENT_SOURCES),
  device: z.string().min(1).max(160).nullable().optional(),
});
export type ConsentWithdrawRequestT = z.infer<typeof ConsentWithdrawRequest>;

export const ConsentRecordSchema = z.object({
  id: z.uuid(),
  subjectPseudonym: z.uuid(),
  scope: z.enum(CONSENT_SCOPES),
  action: z.enum(CONSENT_ACTIONS),
  consentVersion: z.string(),
  source: z.enum(CONSENT_SOURCES),
  device: z.string().nullable(),
  captureMode: z.enum(CONSENT_CAPTURE_MODES).nullable(),
  strokeIntent: z.string().nullable(),
  recordedAt: z.iso.datetime(),
  seq: z.number().int().positive().optional(),
});

export const ConsentScopeStatusSchema = z.object({
  scope: z.enum(CONSENT_SCOPES),
  active: z.boolean(),
  consentVersion: z.string().nullable(),
  lastAction: z.enum(CONSENT_ACTIONS).nullable(),
  lastActionAt: z.iso.datetime().nullable(),
});

export const ConsentStatusResponse = z.object({
  subjectPseudonym: z.uuid().nullable(),
  scopes: z.array(ConsentScopeStatusSchema),
  records: z.array(ConsentRecordSchema),
});
export type ConsentStatusResponseT = z.infer<typeof ConsentStatusResponse>;

/** Ledger export envelope: ConsentRecord contract shape (recordedAtIso, seq
 * required) with integrity fields intake hosts verify before trusting it. */
export const ConsentLedgerExportRecordSchema = z.object({
  id: z.uuid(),
  subjectPseudonym: z.uuid(),
  scope: z.enum(CONSENT_SCOPES),
  action: z.enum(CONSENT_ACTIONS),
  consentVersion: z.string(),
  source: z.enum(CONSENT_SOURCES),
  device: z.string().nullable(),
  captureMode: z.enum(CONSENT_CAPTURE_MODES).nullable(),
  strokeIntent: z.string().nullable(),
  recordedAtIso: z.iso.datetime(),
  seq: z.number().int().positive(),
});

export const ConsentLedgerExportResponse = z.object({
  exportVersion: z.literal("consent-ledger-export-v1"),
  exportedAtIso: z.iso.datetime(),
  subjectPseudonym: z.uuid(),
  recordCount: z.number().int().nonnegative(),
  maxSeq: z.number().int().positive().nullable(),
  recordsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  records: z.array(ConsentLedgerExportRecordSchema),
});
export type ConsentLedgerExportResponseT = z.infer<typeof ConsentLedgerExportResponse>;
