import { z } from "zod";
import {
  CAMERA_VIEWS,
  CHECKPOINTS,
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

/** Canonical shot-sync payload (spec p. 21). */
export const ShotSyncPayload = z.object({
  id: z.uuid(),
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
  source: z.enum(["real", "fixture"]),
  phases: z.array(PhaseSpanSchema),
  checkpoints: z.array(CheckpointScoreSchema),
  versionVector: VersionVectorSchema,
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
