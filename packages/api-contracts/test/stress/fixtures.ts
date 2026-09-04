/**
 * Well-formed request/response fixtures for every wire-facing Zod contract,
 * used as the starting point for seeded hostile mutations. Synthetic ids and
 * values only.
 */
import type { z } from "zod";
import {
  AccountBootstrapRequest,
  AnalysisFeedbackRequest,
  AnalysisPermitFinalizeRequest,
  AnalysisPermitReserveRequest,
  ConsentGrantRequest,
  ConsentWithdrawRequest,
  DrillCompletionCreateRequest,
  ErrorEnvelope,
  EvaluationTrialUploadRequest,
  HealthResponse,
  SessionCreateRequest,
  ShotSyncPayload,
  ShotsSyncRequest,
  TrainingPlanCreateRequest,
  TrainingPlanReassessmentRequest,
} from "../../src/schemas.js";

export interface ContractFixture {
  name: string;
  schema: z.ZodType;
  /** Cross-field refinements (superRefine/refine) can reject structurally valid input. */
  refined: boolean;
  make(): unknown;
}

export function makeShotSyncPayload(index = 0): z.input<typeof ShotSyncPayload> {
  const suffix = String(index).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${suffix}`,
    analysisPermitId: `00000000-0000-4000-9000-${suffix}`,
    sessionId: null,
    shotType: "forehand_drive",
    cameraView: "side",
    capturedAt: "2026-08-27T17:30:00.000Z",
    timestamps: { startMs: 0, contactMs: 420, endMs: 900 },
    overallScore: 7.25,
    confidence: 0.82,
    resultKind: "scored",
    source: "real",
    phases: [{ key: "contact", startMs: 400, representativeMs: 420, endMs: 440, confidence: 0.9 }],
    checkpoints: [
      {
        key: "contact_position",
        score: 70,
        confidence: 0.8,
        band: "green",
        direction: "early",
        severity: 0.2,
        applicable: true,
      },
    ],
    versionVector: {
      appVersion: "0.1.0",
      modelBundleVersion: "bundle-1",
      poseModelVersion: "pose-1",
      paddleModelVersion: "paddle-1",
      strokeDetectorVersion: "stroke-1",
      phaseModelVersion: "phase-1",
      scoringModelVersion: "score-1",
      shotConfigVersion: "shot-1",
    },
  };
}

export const CONTRACT_FIXTURES: readonly ContractFixture[] = [
  {
    name: "ShotsSyncRequest",
    schema: ShotsSyncRequest,
    refined: true,
    make: () => ({ shots: [makeShotSyncPayload(1), makeShotSyncPayload(2)] }),
  },
  {
    name: "SessionCreateRequest",
    schema: SessionCreateRequest,
    refined: false,
    make: () => ({
      id: "00000000-0000-4000-8000-000000000010",
      mode: "single",
      shotType: "dink",
      focusCheckpoint: null,
      cameraView: "side",
      startedAt: "2026-08-27T17:30:00.000Z",
    }),
  },
  {
    name: "AccountBootstrapRequest",
    schema: AccountBootstrapRequest,
    refined: false,
    make: () => ({
      locale: "en-US",
      timezone: "America/Los_Angeles",
      device: { platform: "ios", osVersion: "17.5", appVersion: "0.1.0", model: "iPhone15,2" },
    }),
  },
  {
    name: "AnalysisPermitReserveRequest",
    schema: AnalysisPermitReserveRequest,
    refined: false,
    make: () => ({ idempotencyKey: "00000000-0000-4000-8000-000000000020" }),
  },
  {
    name: "AnalysisPermitFinalizeRequest",
    schema: AnalysisPermitFinalizeRequest,
    refined: true,
    make: () => ({ outcome: "scored", ratingId: "00000000-0000-4000-8000-000000000030" }),
  },
  {
    name: "TrainingPlanCreateRequest",
    schema: TrainingPlanCreateRequest,
    refined: false,
    make: () => ({ sourceShotId: "00000000-0000-4000-8000-000000000040" }),
  },
  {
    name: "TrainingPlanReassessmentRequest",
    schema: TrainingPlanReassessmentRequest,
    refined: false,
    make: () => ({ shotId: "00000000-0000-4000-8000-000000000050" }),
  },
  {
    name: "DrillCompletionCreateRequest",
    schema: DrillCompletionCreateRequest,
    refined: true,
    make: () => ({
      id: "00000000-0000-4000-8000-000000000060",
      drillSlug: "contact-out-front",
      trainingPlanItemId: null,
      practiceSessionId: null,
      completedAt: "2026-08-27T17:30:00.000Z",
      actualRepetitions: 30,
      actualDurationSeconds: 300,
    }),
  },
  {
    name: "AnalysisFeedbackRequest",
    schema: AnalysisFeedbackRequest,
    refined: true,
    make: () => ({ rating: "not_quite", category: "wrong_stroke" }),
  },
  {
    name: "ConsentGrantRequest",
    schema: ConsentGrantRequest,
    refined: false,
    make: () => ({
      scope: "model_training",
      consentVersion: "model-training-v1",
      source: "mobile_settings",
      device: "iPhone15,2",
      captureMode: "all_captures",
      strokeIntent: "dink",
      decisionId: "00000000-0000-4000-8000-000000000070",
      decidedAtIso: "2026-08-27T17:30:00.000Z",
    }),
  },
  {
    name: "ConsentWithdrawRequest",
    schema: ConsentWithdrawRequest,
    refined: false,
    make: () => ({ scope: "model_training", source: "mobile_settings", device: null }),
  },
  {
    name: "EvaluationTrialUploadRequest",
    schema: EvaluationTrialUploadRequest,
    refined: false,
    make: () => ({
      trials: [
        {
          schemaVersion: "evaluation-trial-v1",
          trialId: "00000000-0000-4000-8000-000000000080",
          capturedAtIso: "2026-08-27T17:30:00.000Z",
          consent: { scope: "evaluation_telemetry", consentVersion: "evaluation-telemetry-v1" },
          latencyMs: 1234,
        },
      ],
    }),
  },
  {
    name: "ErrorEnvelope",
    schema: ErrorEnvelope,
    refined: false,
    make: () => ({
      error: {
        kind: "permanent",
        code: "validation.shots_sync",
        message: "invalid",
        retryable: false,
        requestId: "req-1",
      },
    }),
  },
  {
    name: "HealthResponse",
    schema: HealthResponse,
    refined: false,
    make: () => ({ status: "ok", version: "0.1.0" }),
  },
];
