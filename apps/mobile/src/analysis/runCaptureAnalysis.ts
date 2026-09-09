import { Platform } from 'react-native';
import type { EnvelopeVerdict, ShotTypeSlug } from '@pickle/shared-types';
import {
  analyzeCapture,
  FUSION_ENGINE_VERSION,
  STROKE_TAXONOMY_VERSION,
  isDeclaredTechniqueIntent,
  isAnalysisInputSelectionSnapshot,
  isConfirmationTimestamp,
  evaluatePreAnalysisGate,
  type AnalysisInputSelectionSnapshot,
  type CaptureAnalysisRecord,
  type FusionProviders,
  type NeedsTechniqueConfirmationRecord,
  type TechniqueConfirmationEvidence,
  type TechniqueConfirmationInput,
  type VerifiedTechniqueConfirmationRecord,
  type PreAnalysisGateDecision,
  type StrokeWindowContext,
} from '@pickle/analysis-pipeline';
import {
  parsePoseSequence,
  sha256Hex,
  unavailable,
  type PoseSequence,
} from '@pickle/swing-domain';
import {
  detectOfflineStrokeWindow,
  evaluateCaptureQuality,
} from '@pickle/vision-geometry';
import {
  extractImportedPoseSequence,
  readCaptureArtifact,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../camera/capture';
import type { LocalDb } from '../data/db';
import {
  assertDataOwnerContext,
  captureDataOwnerContext,
  DataOwnerChangedError,
  isDataOwnerContextCurrent,
  type DataOwnerContext,
} from '../data/accountScope';
import {
  markCaptureAnalyzed,
  saveAnalysis,
  saveAnalysisRecord,
  saveLocalOnlyAnalysis,
  updateCaptureClipPayload,
} from '../data/repository';
import { createFusionProviders } from '../vision/providers';
import {
  ApiError,
  createAnalysisPermitClient,
  type ApiConfigState,
  type ReservedAnalysisPermitWithAccess,
} from '../data/api';
import { makeUuid } from '../util/uuid';
import {
  recordEvaluationTrial,
  type EvaluationTelemetryContext,
} from '../evaluation/trialCapture';
import { stabilitySlo } from './stabilityTelemetry';
import { forDataOwner, withTransaction } from '../data/transactions';
import { commitPracticeSet, type PracticeSetPlan } from './practiceSet';
import { bearerTokenFor, getApiSession } from '../account/apiSession';
import {
  runJournal,
  analysisAttemptJournal,
  recoverAnalysisJournals,
  RunJournalError,
  type RunJournalEntry,
  type RunJournalIdentity,
  type RunJournalReleaseOutcome,
  type RunJournalScope,
} from './runJournal';
import {
  confirmationCaptureHash,
  confirmationContinuationOperationId,
  confirmationInputsMatch,
  confirmationRecordHash,
  sameConfirmationJournalIdentity,
  isSavedCaptureId,
  loadSavedTechniqueConfirmation,
} from './savedTechniqueConfirmation';
import {
  OriginalAnalysisExecution,
  OriginalAnalysisHeldError,
  originalAnalysisOperations,
  type AnalysisTechnicalFailure,
  type OriginalAnalysisAttempt,
  type OriginalAnalysisOperation,
} from './originalAnalysisOperations';
import {
  assertOriginalClip,
  captureExecutionDefinitionHash,
  originalCanonicalJson,
  type OriginalModelPolicy,
  type OriginalModelDescriptor,
} from './originalAnalysisSnapshot';
import {
  isReleaseNotAuthorized,
  isSettledRefusalRun,
  partialOutcomeMarker,
  readPartialCaptureAnalysisRecord,
  readPartialOutcome,
  readReservationRefusal,
  saveReservationRefusal,
  toPartialCaptureAnalysisRecord,
  type PartialCaptureAnalysisRecord,
  type PartialOutcomeMarker,
} from './partialOutcome';

/**
 * Capture → canonical observations → fusion analysis → durable records.
 *
 * Honesty and product rules enforced here:
 * - Analysis runs only on the real recorded pose sequence (hash-addressed
 *   sidecar written at capture time, or by the explicit native extraction
 *   pass for imported videos). No sequence → no analysis.
 * - The pose-quality gate (`evaluateCaptureQuality` + `evaluatePreAnalysisGate`
 *   over the parsed sidecar and the stroke window) is decided BEFORE the
 *   analysis engine sees the sequence: footage whose tracking is measurably
 *   unusable is an honest abstention, never a rating.
 * - A server-reserved analysis permit is consumed exactly as the entitlement
 *   system requires; abstentions release the permit instead of burning it.
 * - Every analyzed run appends an immutable AnalysisRecord; scored runs
 *   additionally promote the product rating (local_shot + sync outbox).
 */

/**
 * The measured motion span the continuity gate inspects. Live captures carry
 * the trigger's movement window. Imported clips carry none — the container
 * legitimately starts before the player steps in and keeps rolling after the
 * swing — so the offline detector's motion core stands in; when it finds no
 * distinct stroke the signal is honestly not evaluated and the engine's own
 * stroke resolution decides.
 */
function strokeWindowFor(
  clip: CapturedClip,
  pose: PoseSequence,
): StrokeWindowContext | null {
  if (clip.captureMode === 'automatic_pose_trigger') {
    return {
      windowStartMs: clip.trigger.startMs,
      windowEndMs: clip.trigger.endMs,
    };
  }
  const detected = detectOfflineStrokeWindow(pose);
  if (!detected.ok) return null;
  return {
    windowStartMs: detected.value.motionStartMs,
    windowEndMs: detected.value.motionEndMs,
  };
}

export type CaptureAnalysisOutcome =
  | {
      kind: 'scored';
      replayed?: true;
      analysisId: string;
      record: CaptureAnalysisRecord;
      /**
       * True when this scored run consumed the account's FINAL free rating
       * (permit source "free" and the reserve-time access snapshot shows
       * nothing left to reserve). The UI uses it to surface the upgrade
       * prompt exactly once, right when the last free analysis completes.
       */
      freeLimitReached: boolean;
    }
  | {
      kind: 'low_confidence';
      replayed?: true;
      analysisId: string;
      record: CaptureAnalysisRecord;
      guidance: string | null;
    }
  | {
      kind: 'unavailable';
      reason: string;
      /** HTTP 402 `access.paywall_required`: not retryable without an upgrade. */
      cause?:
        | 'paywall_required'
        | 'account_changed'
        | 'cancelled'
        | 'recovery_pending';
    }
  | {
      /**
       * Analysis is honestly withheld BEFORE inference — poor input never
       * becomes a confident score, and nothing is recorded as an analysis.
       * Either the capture envelope is UNSUPPORTED (no permit is reserved), or
       * the recorded pose sequence failed the pose-quality gate (`poseQuality`
       * carries the measured reasons; the reserved permit was released).
       */
      kind: 'quality_blocked';
      reason: string;
      envelope: EnvelopeVerdict | null;
      poseQuality?: PreAnalysisGateDecision;
    };

export type RunCaptureAnalysisOutcome =
  | CaptureAnalysisOutcome
  | {
      kind: 'needs_technique_confirmation';
      replayed?: true;
      analysisId: string;
      record: NeedsTechniqueConfirmationRecord;
    }
  | {
      /**
       * Mechanics were measured and durably recorded, but the release
       * authority settled the reservation with a typed refusal, so no
       * validated technique benchmark exists: no permit was held, no rating
       * was counted, no product row or outbox item was written. Replays of
       * the same operation return the same record without reserving again.
       */
      kind: 'partial';
      replayed?: true;
      analysisId: string;
      record: PartialCaptureAnalysisRecord;
      partialOutcome: PartialOutcomeMarker;
    };

export interface RunCaptureAnalysisRequest {
  db: LocalDb;
  ownerContext?: DataOwnerContext;
  operationId?: string;
  signal?: AbortSignal;
  captureId: string;
  clip: CapturedClip;
  /**
   * The user's declared stroke, or null for AUTO DETECT. Declared and
   * predicted stay separate records everywhere: null routes the run through
   * the fusion engine's hierarchical classifier ladder (predicted_l3 /
   * predicted_family / honest abstention), never through an invented slug.
   */
  declaredStroke: ShotTypeSlug | null;
  /**
   * Canonical technique from the TechniqueIntent (e.g. "BACKHAND_DINK")
   * when one was declared. Only disambiguates the declared slug's analysis
   * profile; validated against the registry downstream — never a new route.
   */
  declaredCanonical?: string | null;
  techniqueConfirmation?: TechniqueConfirmationInput;
  handedness: 'right' | 'left' | 'ambidextrous';
  cameraView: 'side' | 'rear_oblique';
  apiConfig: ApiConfigState;
  appVersion: string;
  sessionId?: string | null;
  practiceSet?: PracticeSetPlan | null;
  focusCheckpoint?: string;
  /**
   * Product-assisted target selection ("tap yourself"). Normalized image
   * point identifying WHICH person on court is the user. This is an
   * initialization seed for identity, never a spatial constraint.
   */
  targetSeed?: {
    point: { x: number; y: number };
    selectedAtIso: string;
  } | null;
  /**
   * Capture-envelope verdict for this attempt (canonical shared-types
   * contract). UNSUPPORTED forces the honest-abstention path before any
   * inference; DEGRADED proceeds and is recorded so Result can explain
   * quality-related abstentions. Null/undefined means no envelope was
   * measured — the run proceeds exactly as before.
   */
  captureEnvelope?: EnvelopeVerdict | null;
  /**
   * Evaluation-trial capture context (Wave G2 fresh-user loop). Present and
   * consentActive only when the server ledger shows an active
   * `evaluation_telemetry` grant; absent or inactive → no trial is recorded.
   * Telemetry never alters or blocks the analysis outcome.
   */
  evaluationTelemetry?: EvaluationTelemetryContext | null;
}

export async function runCaptureAnalysis(
  request: RunCaptureAnalysisRequest,
): Promise<RunCaptureAnalysisOutcome> {
  const startedAt = Date.now();
  stabilitySlo.record({ kind: 'analysis_started' });
  let outcome: RunCaptureAnalysisOutcome;
  let ownerContext: DataOwnerContext;
  try {
    const owner = request.ownerContext ?? captureDataOwnerContext();
    ownerContext = Object.freeze({
      ownerKey: owner.ownerKey,
      generation: owner.generation,
    });
    const clip = JSON.parse(JSON.stringify(request.clip)) as CapturedClip;
    outcome = await runCaptureAnalysisCore({
      ...request,
      clip,
      ownerContext,
      targetSeed: request.targetSeed
        ? {
            point: { ...request.targetSeed.point },
            selectedAtIso: request.targetSeed.selectedAtIso,
          }
        : request.targetSeed,
      techniqueConfirmation: request.techniqueConfirmation
        ? {
            analysisId: request.techniqueConfirmation.analysisId,
            intent: { ...request.techniqueConfirmation.intent },
            confirmedAtIso: request.techniqueConfirmation.confirmedAtIso,
          }
        : undefined,
      practiceSet: request.practiceSet
        ? { ...request.practiceSet }
        : request.practiceSet,
      captureEnvelope: request.captureEnvelope
        ? {
            ...request.captureEnvelope,
            dimensions: request.captureEnvelope.dimensions.map(dimension => ({
              ...dimension,
            })),
            notMeasured: [...request.captureEnvelope.notMeasured],
          }
        : request.captureEnvelope,
      apiConfig: { baseUrl: request.apiConfig.baseUrl, token: null },
    });
  } catch (error) {
    stabilitySlo.record({ kind: 'analysis_failed', failureKind: 'exception' });
    throw error;
  }
  // 'scored', 'low_confidence' and 'quality_blocked' all answered the user
  // honestly; only 'unavailable' means the run produced no outcome at all.
  if (outcome.kind === 'unavailable') {
    stabilitySlo.record({
      kind: 'analysis_failed',
      failureKind: outcome.cause ?? 'unavailable',
    });
  } else {
    stabilitySlo.record({ kind: 'analysis_completed' });
  }
  const telemetry = request.evaluationTelemetry ?? null;
  if (
    telemetry &&
    telemetry.consentActive &&
    outcome.kind !== 'needs_technique_confirmation' &&
    outcome.kind !== 'partial' &&
    !('replayed' in outcome && outcome.replayed) &&
    isDataOwnerContextCurrent(ownerContext) &&
    !request.signal?.aborted
  ) {
    try {
      await recordEvaluationTrial(forDataOwner(request.db, ownerContext), {
        outcome,
        captureId: request.captureId,
        capturedAtIso: request.clip.capturedAtIso,
        declaredStroke: request.declaredStroke,
        latencyMs: Date.now() - startedAt,
        appVersion: request.appVersion,
        context: telemetry,
      });
    } catch {
      // Telemetry is best-effort evidence collection: a failed queue write
      // must never surface as an analysis failure to the user.
    }
  }
  if (!isDataOwnerContextCurrent(ownerContext)) return accountChangedOutcome();
  if (
    request.signal?.aborted &&
    (outcome.kind === 'scored' ||
      outcome.kind === 'low_confidence' ||
      outcome.kind === 'needs_technique_confirmation')
  ) {
    return outcome.kind === 'scored'
      ? recoveryPendingOutcome()
      : cancelledOutcome();
  }
  return outcome;
}

export const PAYWALL_REQUIRED_CODE = 'access.paywall_required';

type CaptureTrigger = Parameters<typeof analyzeCapture>[1]['trigger'];

const POSE_QUALITY_REASON_COPY: Record<string, string> = {
  no_person_found: 'no player was tracked',
  too_few_pose_frames: 'too few tracked frames',
  insufficient_fps: 'the tracking frame rate was too low',
  low_pose_confidence: 'the player could not be tracked with confidence',
  body_not_fully_visible: 'the full body was not in view',
  person_implausible_scale:
    'the player was too small or too close in the frame',
  tracking_dropout_gap: 'tracking dropped out during the clip',
  stroke_window_tracking_gap: 'tracking dropped out during the stroke',
  torso_not_measured: 'the torso could not be measured',
};

function poseQualityBlockedReason(gate: PreAnalysisGateDecision): string {
  const measured = gate.reasons
    .map(
      reason => POSE_QUALITY_REASON_COPY[reason] ?? reason.replace(/_/g, ' '),
    )
    .join(', ');
  return (
    'This capture cannot be analyzed honestly — the recorded motion could ' +
    `not be measured well enough to rate (${measured}). Nothing was rated. ` +
    'Keep your whole body in frame through the stroke and try again.'
  );
}

function isPaywallRequired(error: ApiError): boolean {
  return error.status === 402 || error.code === PAYWALL_REQUIRED_CODE;
}

function accountChangedOutcome(): CaptureAnalysisOutcome {
  return {
    kind: 'unavailable',
    cause: 'account_changed',
    reason: 'The account changed before this analysis finished.',
  };
}

class AnalysisRunCancelledError extends Error {}

function cancelledOutcome(): CaptureAnalysisOutcome {
  return {
    kind: 'unavailable',
    cause: 'cancelled',
    reason: 'This analysis was cancelled. Your capture is still saved.',
  };
}

function recoveryPendingOutcome(): Extract<
  CaptureAnalysisOutcome,
  { kind: 'unavailable' }
> {
  return {
    kind: 'unavailable',
    cause: 'recovery_pending',
    reason:
      'This saved analysis is awaiting recovery. Its existing operation will be reconciled without starting another rating.',
  };
}

function assertExecution(
  request: RunCaptureAnalysisRequest,
  owner: DataOwnerContext,
): void {
  assertDataOwnerContext(owner);
  if (request.signal?.aborted) throw new AnalysisRunCancelledError();
  if (request.techniqueConfirmation) {
    const session = getApiSession();
    const expected = runJournal.scope({
      ownerKey: owner.ownerKey,
      apiOrigin: request.apiConfig.baseUrl,
    });
    const current = session
      ? runJournal.scope({
          ownerKey: session.canonicalAppUserId,
          apiOrigin: session.apiBaseUrl,
        })
      : null;
    if (
      current?.ownerKey !== expected.ownerKey ||
      current.apiOrigin !== expected.apiOrigin
    ) {
      throw new TechniqueConfirmationHeldError(
        'Reconnect the original account and rating service to confirm this saved capture.',
      );
    }
  }
}

const MODEL_BUNDLE_VERSION = 'on-device-fusion-2';

function analysisModelPolicy(providers: FusionProviders): OriginalModelPolicy {
  const descriptor = (
    provider: Pick<FusionProviders['scorer'], 'descriptor'> | null | undefined,
  ): OriginalModelDescriptor | null => {
    const value = provider?.descriptor;
    return value
      ? [
          value.providerId,
          value.modelVersion,
          value.runtime,
          value.executionTarget,
          value.artifactHash,
          value.inputSchemaVersion,
          value.outputSchemaVersion,
        ]
      : null;
  };
  return [
    FUSION_ENGINE_VERSION,
    STROKE_TAXONOMY_VERSION,
    MODEL_BUNDLE_VERSION,
    [providers.phase.modelVersion, providers.phase.source],
    descriptor(providers.biomechanics),
    descriptor(providers.scorer),
    descriptor(providers.faultDetector),
    descriptor(providers.uncertainty),
    descriptor(providers.coach),
    descriptor(providers.classifier),
    descriptor(providers.autoStrokeClassifier),
    providers.shadowScorers.map(provider => descriptor(provider)!),
  ];
}

function analysisModelPolicyHash(providers: FusionProviders): string {
  // Keep the exact legacy hash/ordering so saved confirmations still replay.
  return sha256Hex(JSON.stringify(analysisModelPolicy(providers)));
}

function analysisDefinitionHash(
  request: RunCaptureAnalysisRequest,
  providers: FusionProviders,
  observationHash: string,
): string {
  return captureExecutionDefinitionHash(
    request,
    analysisModelPolicyHash(providers),
    observationHash,
  );
}

function defaultOperationId(
  scope: RunJournalScope,
  captureId: string,
  requestHash: string,
): string {
  const hash = sha256Hex(
    JSON.stringify([scope.ownerKey, captureId.toLowerCase(), requestHash]),
  );
  const variant = ((Number.parseInt(hash.slice(16, 17), 16) & 3) | 8).toString(
    16,
  );
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function inputSelectionSnapshot(
  request: RunCaptureAnalysisRequest,
  owner: DataOwnerContext,
  scope: RunJournalScope,
  providers: FusionProviders,
  requestHash: string,
): AnalysisInputSelectionSnapshot | null {
  const clip = request.clip;
  const pose = clip.poseSequence;
  if (
    !pose ||
    (clip.captureMode === 'automatic_pose_trigger' &&
      request.targetSeed != null)
  )
    return null;
  const snapshot: AnalysisInputSelectionSnapshot = {
    version: 'capture-analysis-input-v1',
    ownerKey: scope.ownerKey,
    ownerGeneration: owner.generation,
    apiOrigin: scope.apiOrigin,
    captureId: request.captureId,
    observationHash: pose.sha256,
    definitionHash: requestHash,
    modelPolicyHash: analysisModelPolicyHash(providers),
    capture: {
      captureMode: clip.captureMode,
      capturedAtIso: clip.capturedAtIso,
      durationMs: clip.durationMs,
      width: clip.width,
      height: clip.height,
      fps: clip.fps,
      poseFrameCount: pose.frameCount,
      poseModelVersion: pose.poseModelVersion,
      poseUri: pose.uri,
      payloadHash: confirmationCaptureHash(clip),
    },
    trigger:
      clip.captureMode === 'automatic_pose_trigger'
        ? {
            startMs: clip.trigger.startMs,
            endMs: clip.trigger.endMs,
            peakMotionMs: clip.trigger.peakMotionMs ?? null,
            confidence: clip.trigger.confidence,
            modelVersion: clip.trigger.modelVersion,
          }
        : {
            startMs: 0,
            endMs: clip.durationMs,
            peakMotionMs: null,
            confidence: 1,
            modelVersion: 'imported-full-clip-1',
          },
    declaredStroke: request.declaredStroke,
    declaredCanonical: request.declaredCanonical ?? null,
    handedness: request.handedness,
    cameraView: request.cameraView,
    focusCheckpoint: request.focusCheckpoint ?? null,
    target: {
      userSelection: request.targetSeed
        ? {
            ...request.targetSeed,
            point: { ...request.targetSeed.point },
            source: 'import_tap',
          }
        : null,
      guidedStartTap:
        clip.captureMode === 'automatic_pose_trigger' && clip.targetLock
          ? {
              point: { ...clip.targetLock.tapPoint },
              selectedAtIso: null,
              source: 'guided_start_region',
            }
          : null,
      acquiredAnchor:
        clip.captureMode === 'automatic_pose_trigger' && clip.targetSeed
          ? {
              point: { x: clip.targetSeed.x, y: clip.targetSeed.y },
              source: clip.targetSeed.source,
            }
          : null,
    },
  };
  return isAnalysisInputSelectionSnapshot(snapshot) ? snapshot : null;
}

function permitPort(scope: RunJournalScope) {
  return {
    ...scope,
    ...createAnalysisPermitClient({
      baseUrl: scope.apiOrigin,
      get token() {
        const session = getApiSession();
        if (!session) return null;
        try {
          const current = runJournal.scope({
            ownerKey: session.canonicalAppUserId,
            apiOrigin: session.apiBaseUrl,
          });
          return current.ownerKey === scope.ownerKey &&
            current.apiOrigin === scope.apiOrigin
            ? bearerTokenFor(session.canonicalAppUserId)
            : null;
        } catch {
          return null;
        }
      },
    }),
  };
}

/** Call immediately after saving capture/selection and planning its practice set,
 * BEFORE native extraction. No permit, model inference or profile lookup occurs.
 * UI adoption is explicit; legacy requests are never silently upgraded. */
export async function prepareOriginalCaptureAnalysis(
  request: RunCaptureAnalysisRequest,
  execution: OriginalAnalysisExecution,
  operationId = makeUuid(),
): Promise<OriginalAnalysisOperation> {
  execution.assertCurrent();
  assertExecution(request, execution.ownerContext);
  if (
    request.ownerContext &&
    (request.ownerContext.ownerKey !== execution.ownerContext.ownerKey ||
      request.ownerContext.generation !== execution.ownerContext.generation)
  )
    throw new OriginalAnalysisHeldError('stale_execution');
  if (request.techniqueConfirmation)
    throw new OriginalAnalysisHeldError('use_saved_technique_confirmation');
  const scope = runJournal.scope({
    ownerKey: execution.scope.ownerKey,
    apiOrigin: request.apiConfig.baseUrl,
  });
  if (scope.apiOrigin !== execution.scope.apiOrigin)
    throw new OriginalAnalysisHeldError('origin_mismatch');
  const fusion = createFusionProviders(request.declaredStroke);
  return originalAnalysisOperations.prepare(
    request.db,
    execution,
    {
      version: 'original-analysis-v1',
      ...execution.scope,
      captureId: request.captureId,
      clip: request.clip,
      declaredStroke: request.declaredStroke,
      declaredCanonical: request.declaredCanonical ?? null,
      handedness: request.handedness,
      cameraView: request.cameraView,
      focusCheckpoint: request.focusCheckpoint ?? null,
      targetSeed: request.targetSeed ?? null,
      sessionId: request.sessionId ?? null,
      practiceSet: request.practiceSet ?? null,
      appVersion: request.appVersion,
      modelPolicy:
        fusion.kind === 'real' ? analysisModelPolicy(fusion.providers) : null,
      captureEnvelope: request.captureEnvelope ?? null,
    },
    operationId,
  );
}

export interface RunOriginalCaptureAnalysisRequest {
  db: LocalDb;
  execution: OriginalAnalysisExecution;
  /** Logical id returned by preparation, not a released permit/attempt key. */
  operationId: string;
  predecessorAttemptId?: string;
}
interface PreparedOriginalAttempt {
  operation: OriginalAnalysisOperation;
  run: RunJournalEntry;
  execution: OriginalAnalysisExecution;
  releaseAdmissionGuard: () => void;
  /** The durable refusal of this same settled attempt being resumed. */
  resumedRefusal: PartialOutcomeMarker | null;
}
async function originalCompletionOutcome(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
  replayed = true,
  freeLimitReached = false,
): Promise<RunCaptureAnalysisOutcome | null> {
  const completed = await originalAnalysisOperations.loadCompletion(
    db,
    execution,
    operationId,
  );
  if (!completed) return null;
  const { record } = completed;
  const replay = replayed ? { replayed: true as const } : {};
  if (record.kind === 'needs_technique_confirmation')
    return {
      kind: 'needs_technique_confirmation',
      analysisId: record.id,
      record,
      ...replay,
    };
  const partialOutcome = readPartialOutcome(record);
  if (partialOutcome !== null)
    return {
      kind: 'partial',
      analysisId: record.id,
      record: { ...record, result: null, partialOutcome },
      partialOutcome,
      ...replay,
    };
  if (record.result?.resultKind === 'scored')
    return {
      kind: 'scored',
      analysisId: record.id,
      record,
      freeLimitReached,
      ...replay,
    };
  return {
    kind: 'low_confidence',
    analysisId: record.id,
    record,
    guidance: record.result?.guidance ?? null,
    ...replay,
  };
}

/** Explicit reconciliation is separate from retry admission. It can only
 * finish the current attempt's original hold, never append or infer. */
export async function reconcileOriginalCaptureAnalysis(
  request: RunOriginalCaptureAnalysisRequest,
): Promise<void> {
  const { db, execution, operationId } = request;
  const operation = await originalAnalysisOperations.read(
    db,
    execution,
    operationId,
  );
  if (!operation?.currentAttemptId || operation.finalRecordId !== null) return;
  const attempt = await originalAnalysisOperations.readAttempt(
    db,
    operation,
    operation.currentAttemptId,
  );
  execution.assertCurrent();
  await analysisAttemptJournal.recover(
    db,
    execution.scope,
    permitPort(execution.scope),
    { operationId: attempt.run.operationId, limit: 1 },
  );
  execution.assertCurrent();
}

/** Same saved movie and immutable settings only. No camera, picker, present-day
 * profile or new practice plan is consulted. A missing byte comparison holds.
 * Pre-permit extraction may resume a prepared operation; a permit successor
 * requires the caller's exact predecessor AND the store's acknowledged proof. */
export async function runOriginalCaptureAnalysis(
  input: RunOriginalCaptureAnalysisRequest,
): Promise<RunCaptureAnalysisOutcome> {
  const { db, execution, operationId, predecessorAttemptId } = { ...input };
  let finish: (() => void) | undefined;
  let finishAdmission: (() => void) | undefined;
  try {
    execution.assertCurrent();
    const completed = await originalCompletionOutcome(
      db,
      execution,
      operationId,
    );
    if (completed) return completed;
    let operation = await originalAnalysisOperations.read(
      db,
      execution,
      operationId,
    );
    if (!operation) return recoveryPendingOutcome();
    // A settled, permit-less refusal whose mechanics record never landed is
    // resumed on the SAME attempt: nothing is reserved again and the durable
    // refusal is the only reason the partial may carry.
    let resumed: {
      attempt: OriginalAnalysisAttempt;
      marker: PartialOutcomeMarker;
    } | null = null;
    if (operation.currentAttemptId !== null) {
      const previous = await originalAnalysisOperations.readAttempt(
        db,
        operation,
        operation.currentAttemptId,
      );
      if (
        runJournal
          .activeOperationIds(execution.scope)
          .includes(previous.run.operationId)
      )
        return recoveryPendingOutcome();
      const refusal = await readReservationRefusal(db, previous.run);
      execution.assertCurrent();
      if (refusal) {
        if (
          predecessorAttemptId !== undefined &&
          predecessorAttemptId !== operation.currentAttemptId
        )
          return recoveryPendingOutcome();
        resumed = { attempt: previous, marker: refusal };
      } else if (
        predecessorAttemptId !== operation.currentAttemptId ||
        previous.run.state !== 'released' ||
        previous.run.releaseOutcome !== 'failed' ||
        previous.technicalFailure === null
      )
        return recoveryPendingOutcome();
    } else if (predecessorAttemptId !== undefined)
      return recoveryPendingOutcome();
    finish = runJournal.startExecution({ ...execution.scope, operationId });
    const original = operation.snapshot;
    const fusion = createFusionProviders(original.declaredStroke);
    if (
      fusion.kind !== 'real' ||
      analysisModelPolicyHash(fusion.providers) !== operation.modelPolicyHash
    )
      return recoveryPendingOutcome();
    const envelope =
      operation.observation?.captureEnvelope ?? original.captureEnvelope;
    if (envelope?.overall === 'UNSUPPORTED')
      return {
        kind: 'quality_blocked',
        envelope,
        reason:
          'The original measured capture quality is outside the supported envelope. Nothing was rated.',
      };
    let clip = await originalAnalysisOperations.readCapture(db, operation);
    execution.assertCurrent();
    if (!clip.poseSequence) {
      if (
        clip.captureMode !== 'imported_video' ||
        !original.clip.nativeMediaIdentity
      )
        return recoveryPendingOutcome();
      const verified = await verifyCapturedClipCurrentBytes(
        clip,
        execution.ownerContext,
        { operationId: makeUuid(), signal: execution.signal },
      );
      execution.assertCurrent();
      if (
        verified.status !== 'verified-current-bytes' ||
        originalCanonicalJson(verified.comparedExpectation) !==
          originalCanonicalJson(original.clip.nativeMediaIdentity)
      )
        return recoveryPendingOutcome();
      const before = clip;
      const extracted = await extractImportedPoseSequence(
        clip,
        original.targetSeed?.point ?? null,
        { operationId: makeUuid(), signal: execution.signal },
      );
      execution.assertCurrent();
      const enriched = assertOriginalClip({
        ...clip,
        poseSequence: extracted.poseSequence,
        ...(extracted.posterUri ? { posterUri: extracted.posterUri } : {}),
      });
      await withTransaction(db, async tx => {
        const current = await originalAnalysisOperations.readCapture(
          tx,
          operation!,
        );
        if (originalCanonicalJson(current) !== originalCanonicalJson(before))
          throw new OriginalAnalysisHeldError('capture_changed');
        await updateCaptureClipPayload(
          forDataOwner(tx, execution.ownerContext),
          original.captureId,
          enriched,
        );
        execution.assertCurrent();
      });
      clip = enriched;
    }
    const sidecar = await readCaptureArtifact(clip.poseSequence!.uri);
    execution.assertCurrent();
    operation = await originalAnalysisOperations.sealObservation(
      db,
      execution,
      operationId,
      { clip, sidecarJson: sidecar, captureEnvelope: envelope },
    );
    finishAdmission = analysisAttemptJournal.protectAnalysisAdmission(
      execution.scope,
      operation.analysisId,
    );
    let prepared: PreparedOriginalAttempt;
    if (resumed) {
      if (operation.currentAttemptId !== resumed.attempt.run.operationId)
        return recoveryPendingOutcome();
      const current = await originalAnalysisOperations.readAttempt(
        db,
        operation,
        operation.currentAttemptId,
      );
      execution.assertCurrent();
      if (
        originalCanonicalJson(current) !==
          originalCanonicalJson(resumed.attempt) ||
        !isSettledRefusalRun(current.run)
      )
        return recoveryPendingOutcome();
      prepared = {
        operation,
        run: current.run,
        execution,
        releaseAdmissionGuard: finishAdmission,
        resumedRefusal: resumed.marker,
      };
    } else {
      const admission = await originalAnalysisOperations.admit(
        db,
        execution,
        operationId,
        {
          settingsHash: operation.settingsHash,
          modelPolicyHash: analysisModelPolicyHash(fusion.providers),
          predecessorAttemptId,
        },
      );
      execution.assertCurrent();
      if (admission.kind === 'replay')
        return (
          (await originalCompletionOutcome(db, execution, operationId)) ??
          recoveryPendingOutcome()
        );
      if (admission.kind !== 'created') return recoveryPendingOutcome();
      prepared = {
        operation: admission.operation,
        run: admission.attempt.run,
        execution,
        releaseAdmissionGuard: finishAdmission,
        resumedRefusal: null,
      };
    }
    return await runCaptureAnalysisCore(
      {
        db,
        ownerContext: execution.ownerContext,
        signal: execution.signal,
        captureId: original.captureId,
        clip,
        declaredStroke: original.declaredStroke,
        declaredCanonical: original.declaredCanonical,
        handedness: original.handedness,
        cameraView: original.cameraView,
        focusCheckpoint: original.focusCheckpoint ?? undefined,
        targetSeed: original.targetSeed,
        sessionId: original.sessionId,
        practiceSet: original.practiceSet,
        appVersion: original.appVersion,
        apiConfig: { baseUrl: original.apiOrigin, token: null },
        captureEnvelope: envelope,
      },
      prepared,
    );
  } catch {
    if (!isDataOwnerContextCurrent(execution.ownerContext))
      return accountChangedOutcome();
    if (execution.signal?.aborted) return cancelledOutcome();
    return recoveryPendingOutcome();
  } finally {
    finishAdmission?.();
    finish?.();
  }
}

async function readJournalOutcome(
  request: RunCaptureAnalysisRequest,
  owner: DataOwnerContext,
  run: RunJournalEntry,
  replayed = true,
  freeLimitReached = false,
): Promise<RunCaptureAnalysisOutcome> {
  assertExecution(request, owner);
  const loaded = await loadSavedTechniqueConfirmation({
    db: request.db,
    ownerContext: owner,
    captureId: run.captureId,
    apiOrigin: run.apiOrigin,
    originalAnalysisId: run.analysisId,
    requireLatest: false,
    signal: request.signal,
    assertCurrent: () => assertExecution(request, owner),
  });
  assertExecution(request, owner);
  if (loaded.kind === 'unavailable') return recoveryPendingOutcome();
  const journal = loaded.journal;
  if (!sameConfirmationJournalIdentity(journal, run))
    return recoveryPendingOutcome();
  const record =
    loaded.kind === 'already_completed' ? loaded.record : loaded.saved.record;
  if (
    request.techniqueConfirmation &&
    record.strokeIntent.confirmation?.analysisId !==
      request.techniqueConfirmation.analysisId
  )
    return recoveryPendingOutcome();
  if (loaded.kind !== 'already_completed') {
    return {
      kind: 'needs_technique_confirmation',
      analysisId: run.analysisId,
      record: loaded.saved.record,
      ...(replayed ? { replayed: true as const } : {}),
    };
  }
  if (loaded.resultKind === 'scored') {
    return {
      kind: 'scored',
      analysisId: run.analysisId,
      record: loaded.record,
      freeLimitReached,
      ...(replayed ? { replayed: true as const } : {}),
    };
  }
  return {
    kind: 'low_confidence',
    analysisId: run.analysisId,
    record: loaded.record,
    guidance: loaded.record.result.guidance,
    ...(replayed ? { replayed: true as const } : {}),
  };
}

/**
 * The settled refusal of a plain (non-original) run, read back from storage.
 * `replay` carries the durable partial when its mechanics record landed;
 * `resume` means the refusal is durable but the record is not, so the same
 * run finishes its mechanics WITHOUT reserving again; null means this run is
 * not a settled refusal at all.
 */
async function readPartialReplay(
  db: LocalDb,
  run: RunJournalEntry,
): Promise<
  | { kind: 'replay'; record: PartialCaptureAnalysisRecord }
  | { kind: 'resume'; marker: PartialOutcomeMarker }
  | null
> {
  const marker = await readReservationRefusal(db, run);
  if (!marker) return null;
  const { rows } = await db.execute(
    `SELECT r.id, r.capture_id, r.created_at, r.engine_version, r.scoring_model_version, r.record, s.id AS shot_id
     FROM local_analysis_record r LEFT JOIN local_shot s ON s.owner_key = r.owner_key AND s.id = r.id
     WHERE r.owner_key = ? AND r.id = ?`,
    [run.ownerKey, run.analysisId],
  );
  const row = rows[0];
  if (!row) return { kind: 'resume', marker };
  if (typeof row.record !== 'string' || row.shot_id !== null)
    throw new RunJournalError('identity_conflict');
  const record = readPartialCaptureAnalysisRecord(JSON.parse(row.record), {
    id: row.id,
    captureId: row.capture_id,
    createdAtIso: row.created_at,
    engineVersion: row.engine_version,
    scoringModelVersion: row.scoring_model_version,
  });
  if (
    record === null ||
    record.captureId !== run.captureId ||
    originalCanonicalJson(record.partialOutcome) !==
      originalCanonicalJson(marker)
  )
    throw new RunJournalError('identity_conflict');
  return { kind: 'replay', record };
}

class TechniqueConfirmationHeldError extends Error {}

interface TechniqueConfirmationAdmission {
  evidence: TechniqueConfirmationEvidence;
  original: VerifiedTechniqueConfirmationRecord;
  journal: RunJournalEntry;
}

async function readTechniqueConfirmationEvidence(
  request: RunCaptureAnalysisRequest,
  owner: DataOwnerContext,
  scope: RunJournalScope,
  observationHash: string,
  providers: FusionProviders,
): Promise<TechniqueConfirmationAdmission | undefined> {
  const confirmation = request.techniqueConfirmation;
  if (!confirmation) return undefined;
  if (
    !isDeclaredTechniqueIntent(confirmation.intent) ||
    confirmation.intent.legacySlug !== request.declaredStroke ||
    confirmation.intent.canonical !== request.declaredCanonical ||
    !isConfirmationTimestamp(confirmation.confirmedAtIso)
  ) {
    throw new TechniqueConfirmationHeldError(
      'Choose an exact technique before confirming this saved capture.',
    );
  }
  const load = () =>
    loadSavedTechniqueConfirmation({
      db: request.db,
      ownerContext: owner,
      captureId: request.captureId,
      apiOrigin: scope.apiOrigin,
      originalAnalysisId: confirmation.analysisId,
      signal: request.signal,
      assertCurrent: () => assertExecution(request, owner),
    });
  let loaded = await load();
  assertExecution(request, owner);
  if (
    loaded.kind !== 'ready' &&
    loaded.kind !== 'release_pending' &&
    loaded.kind !== 'recovery_blocked'
  ) {
    throw new TechniqueConfirmationHeldError(
      'The original confirmation for this saved capture could not be verified. Keep this saved clip; no new rating was started.',
    );
  }
  const original = loaded.saved.record;
  const selection = original.inputSelection;
  if (
    original.observationHash !== observationHash ||
    !confirmationInputsMatch(selection, request.clip, request.targetSeed) ||
    confirmationRecordHash({
      ...original,
      captureEnvelope: request.captureEnvelope ?? null,
    }) !== confirmationRecordHash(original) ||
    selection.handedness !== request.handedness ||
    selection.cameraView !== request.cameraView ||
    selection.focusCheckpoint !== (request.focusCheckpoint ?? null) ||
    selection.modelPolicyHash !== analysisModelPolicyHash(providers) ||
    selection.definitionHash !==
      analysisDefinitionHash(
        {
          ...request,
          declaredStroke: selection.declaredStroke,
          declaredCanonical: selection.declaredCanonical,
          techniqueConfirmation: original.strokeIntent.confirmation,
          captureEnvelope: original.captureEnvelope,
        },
        providers,
        observationHash,
      )
  ) {
    throw new TechniqueConfirmationHeldError(
      'This saved capture or its original analysis settings changed. No new rating was started.',
    );
  }
  const originalRun = loaded.journal;
  if (originalRun.state === 'release_pending') {
    const originalScope = runJournal.scope(originalRun);
    const permits = permitPort(originalScope);
    const guardedDb: LocalDb = {
      async execute(sql, params) {
        assertExecution(request, owner);
        const result = await request.db.execute(sql, params);
        assertExecution(request, owner);
        return result;
      },
      close() {
        throw new Error('A confirmation cannot close its database.');
      },
    };
    await recoverAnalysisJournals(
      guardedDb,
      originalScope,
      {
        ...originalScope,
        async reserve() {
          throw new TechniqueConfirmationHeldError(
            'The original permit must remain bound.',
          );
        },
        async release(permitId, outcome) {
          assertExecution(request, owner);
          if (permitId !== originalRun.permitId || outcome !== 'low_confidence')
            throw new TechniqueConfirmationHeldError(
              'The original permit changed.',
            );
          await permits.release(permitId, outcome);
          assertExecution(request, owner);
        },
      },
      { operationId: originalRun.operationId, limit: 1 },
    ).catch(() => {});
    assertExecution(request, owner);
    loaded = await load();
    assertExecution(request, owner);
  }
  if (
    loaded.kind !== 'ready' ||
    loaded.journal.state !== 'released' ||
    !sameConfirmationJournalIdentity(loaded.journal, originalRun) ||
    confirmationRecordHash(loaded.saved.record) !==
      confirmationRecordHash(original)
  ) {
    throw new TechniqueConfirmationHeldError(
      'The original rating hold or immutable confirmation is still awaiting verification. Your clip is saved; no second rating has been started.',
    );
  }
  const session = getApiSession();
  const currentScope = session
    ? runJournal.scope({
        ownerKey: session.canonicalAppUserId,
        apiOrigin: session.apiBaseUrl,
      })
    : null;
  if (
    currentScope?.ownerKey !== scope.ownerKey ||
    currentScope.apiOrigin !== scope.apiOrigin
  ) {
    throw new TechniqueConfirmationHeldError(
      'Reconnect the original account and rating service to confirm this saved capture.',
    );
  }
  const originalStrokeIntent = { ...original.strokeIntent };
  delete originalStrokeIntent.confirmation;
  return {
    evidence: {
      ...confirmation,
      intent: { ...confirmation.intent },
      originalStrokeIntent,
    },
    original,
    journal: loaded.journal,
  };
}

async function runCaptureAnalysisCore(
  request: RunCaptureAnalysisRequest,
  original?: PreparedOriginalAttempt,
): Promise<RunCaptureAnalysisOutcome> {
  const { clip } = request;
  const journal = original ? analysisAttemptJournal : runJournal;
  const ownerContext = request.ownerContext ?? captureDataOwnerContext();
  const assertCurrent = () => {
    assertExecution(request, ownerContext);
    original?.execution.assertCurrent();
  };
  if (!isDataOwnerContextCurrent(ownerContext)) return accountChangedOutcome();
  if (request.signal?.aborted) return cancelledOutcome();
  original?.execution.assertCurrent();
  let continuationOperationId: string | undefined;
  if (request.techniqueConfirmation) {
    try {
      assertCurrent();
      if (
        !isSavedCaptureId(request.captureId) ||
        !isSavedCaptureId(request.techniqueConfirmation.analysisId)
      )
        return recoveryPendingOutcome();
      const scope = runJournal.scope({
        ownerKey: ownerContext.ownerKey,
        apiOrigin: request.apiConfig.baseUrl,
      });
      continuationOperationId = confirmationContinuationOperationId(
        scope.ownerKey,
        request.captureId,
        request.techniqueConfirmation.analysisId,
      );
      if (
        request.operationId !== undefined &&
        request.operationId !== continuationOperationId
      )
        return recoveryPendingOutcome();
      if (
        runJournal.activeOperationIds(scope).includes(continuationOperationId)
      )
        return recoveryPendingOutcome();
      const existing = await runJournal.read(request.db, {
        ...scope,
        operationId: continuationOperationId,
      });
      assertCurrent();
      if (existing) {
        if (
          existing.captureId !== request.captureId ||
          runJournal.activeOperationIds(scope).includes(continuationOperationId)
        )
          return recoveryPendingOutcome();
        const settled = await readPartialReplay(request.db, existing);
        assertCurrent();
        if (settled?.kind === 'replay')
          return {
            kind: 'partial',
            replayed: true,
            analysisId: existing.analysisId,
            record: settled.record,
            partialOutcome: settled.record.partialOutcome,
          };
        // Completion is authoritative even when a stale screen now chooses
        // another technique or the original media/model is unavailable. The
        // stored request hash is validated against its immutable record, not
        // against a request that will never be executed. Uncertain work holds.
        if (
          settled === null &&
          existing.state !== 'committed' &&
          existing.releaseOutcome !== 'low_confidence'
        )
          return recoveryPendingOutcome();
        if (settled === null)
          return await readJournalOutcome(request, ownerContext, existing);
      }
    } catch {
      if (!isDataOwnerContextCurrent(ownerContext))
        return accountChangedOutcome();
      if (request.signal?.aborted) return cancelledOutcome();
      return recoveryPendingOutcome();
    }
  }
  // ── Capture-envelope gate: UNSUPPORTED input never enters inference ────
  const envelope = request.captureEnvelope ?? null;
  if (envelope && envelope.overall === 'UNSUPPORTED') {
    const blocking = envelope.dimensions
      .filter(d => d.status === 'UNSUPPORTED')
      .map(d => d.dimension.replace(/_/g, ' '))
      .join(', ');
    return {
      kind: 'quality_blocked',
      reason:
        'This capture cannot be analyzed honestly — the measured capture ' +
        `quality is outside the supported envelope (${blocking}). ` +
        'Nothing was rated.',
      envelope,
    };
  }
  // ── Recorded-pose gate: analysis runs ONLY on a real recorded sequence ──
  // Imported clips qualify once the explicit native extraction pass has
  // attached its sidecar ref; without one they stay honestly un-analyzable.
  if (clip.captureMode === 'imported_video' && !clip.poseSequence) {
    return {
      kind: 'unavailable',
      reason:
        'Imported videos have no recorded pose sequence yet. Record with the guided camera to get a Technique Score.',
    };
  }
  const poseSequence = clip.poseSequence;
  if (!poseSequence) {
    return {
      kind: 'unavailable',
      reason:
        'This capture predates pose-sequence recording, so it cannot be scored. New guided captures record the full motion.',
    };
  }

  // ── Load and validate the canonical temporal record ────────────────────
  let sidecarJson: string;
  try {
    sidecarJson = await readCaptureArtifact(poseSequence.uri);
  } catch {
    if (original) {
      const outcome =
        request.signal?.aborted || !isDataOwnerContextCurrent(ownerContext)
          ? 'cancelled'
          : 'failed';
      await originalAnalysisOperations.requestRelease(
        request.db,
        original.run,
        outcome,
        outcome === 'failed' ? 'inference_technical' : null,
      );
      original.releaseAdmissionGuard();
      await journal.recover(
        request.db,
        original.execution.scope,
        permitPort(original.execution.scope),
        { operationId: original.run.operationId, limit: 1 },
      );
    }
    if (!isDataOwnerContextCurrent(ownerContext))
      return accountChangedOutcome();
    if (request.signal?.aborted) return cancelledOutcome();
    return {
      kind: 'unavailable',
      reason: 'The recorded pose sequence for this capture could not be read.',
    };
  }
  if (!isDataOwnerContextCurrent(ownerContext)) return accountChangedOutcome();
  if (request.signal?.aborted) return cancelledOutcome();
  // Integrity: the sidecar must be byte-identical to what capture recorded.
  if (sha256Hex(sidecarJson) !== poseSequence.sha256) {
    return {
      kind: 'unavailable',
      reason:
        'The recorded pose sequence failed its integrity check (hash mismatch). It will not be trusted or repaired.',
    };
  }
  const parsed = parsePoseSequence(sidecarJson, {
    providerId:
      Platform.OS === 'android' ? 'pose.mediapipe' : 'pose.apple-vision',
    runtime: Platform.OS === 'android' ? 'mediapipe' : 'vision_framework',
    executionTarget: 'on_device',
    artifactHash: null,
  });
  if (!parsed.ok) {
    return {
      kind: 'unavailable',
      reason: `The recorded pose sequence is invalid (${parsed.failure.code}). It will not be repaired or guessed.`,
    };
  }

  if (
    parsed.value.frames.length !== poseSequence.frameCount ||
    parsed.value.producedBy.modelVersion !== poseSequence.poseModelVersion ||
    parsed.value.video.width !== clip.width ||
    parsed.value.video.height !== clip.height ||
    parsed.value.video.fps !== clip.fps
  ) {
    return {
      kind: 'unavailable',
      reason:
        'The recorded pose sequence does not match this capture’s saved metadata. It will not be repaired or rated.',
    };
  }

  const fusion = createFusionProviders(request.declaredStroke);
  if (fusion.kind === 'unavailable') {
    return { kind: 'unavailable', reason: fusion.reason };
  }

  // ── Entitlement: reserve before inference (spec: permits) ─────────────
  const scope = runJournal.scope({
    ownerKey: ownerContext.ownerKey,
    apiOrigin: request.apiConfig.baseUrl,
  });
  const observationHash = sha256Hex(sidecarJson);
  if (
    original &&
    (analysisModelPolicyHash(fusion.providers) !==
      original.operation.modelPolicyHash ||
      observationHash !== original.operation.observation?.observationHash)
  )
    return recoveryPendingOutcome();
  const requestHash =
    original?.run.requestHash ??
    analysisDefinitionHash(request, fusion.providers, observationHash);
  const operationId =
    original?.run.operationId ??
    continuationOperationId ??
    request.operationId ??
    defaultOperationId(scope, request.captureId, requestHash);
  const reference = { ...scope, operationId };
  let finishExecution: () => void;
  try {
    finishExecution = journal.startExecution(reference);
    original?.releaseAdmissionGuard();
  } catch (error) {
    if (error instanceof RunJournalError && error.code === 'execution_active')
      return recoveryPendingOutcome();
    throw error;
  }
  const permits = permitPort(scope);
  let run: RunJournalIdentity | null = null;
  let freeLimitReached = false;
  let technicalFailure: AnalysisTechnicalFailure | null = null;
  let phase: 'preflight' | 'inference' | 'commit' = 'preflight';
  const cleanup = async (outcome: RunJournalReleaseOutcome) => {
    if (!run) return;
    if (original)
      await originalAnalysisOperations.requestRelease(
        request.db,
        run,
        outcome,
        outcome === 'failed' ? technicalFailure : null,
      );
    else await journal.requestRelease(request.db, run, outcome);
    finishExecution();
    await journal.recover(request.db, scope, permits, {
      operationId: run.operationId,
      limit: 1,
    });
  };

  try {
    const existing = await journal.read(request.db, reference);
    assertCurrent();
    if (original) {
      await originalAnalysisOperations.assertCurrentAttempt(
        request.db,
        original.execution,
        original.operation.operationId,
        original.run,
      );
      if (
        original.resumedRefusal
          ? !existing || !isSettledRefusalRun(existing)
          : existing?.state !== 'reserve_pending'
      )
        return recoveryPendingOutcome();
    }
    if (request.techniqueConfirmation && existing) {
      if (existing.captureId !== request.captureId)
        return recoveryPendingOutcome();
      const settled = await readPartialReplay(request.db, existing);
      assertCurrent();
      if (settled?.kind === 'replay')
        return {
          kind: 'partial',
          replayed: true,
          analysisId: existing.analysisId,
          record: settled.record,
          partialOutcome: settled.record.partialOutcome,
        };
      if (
        settled === null &&
        existing.state !== 'committed' &&
        existing.releaseOutcome !== 'low_confidence'
      )
        return recoveryPendingOutcome();
      if (settled === null)
        return await readJournalOutcome(request, ownerContext, existing);
    }
    let admission: TechniqueConfirmationAdmission | undefined;
    try {
      admission = await readTechniqueConfirmationEvidence(
        request,
        ownerContext,
        scope,
        observationHash,
        fusion.providers,
      );
      assertCurrent();
    } catch (error) {
      if (!isDataOwnerContextCurrent(ownerContext))
        return accountChangedOutcome();
      if (request.signal?.aborted) return cancelledOutcome();
      return {
        ...recoveryPendingOutcome(),
        reason:
          error instanceof TechniqueConfirmationHeldError
            ? error.message
            : 'This saved confirmation could not be verified. Its existing operation is held without starting another rating.',
      };
    }
    const techniqueConfirmation = admission?.evidence;
    const inputSelection = inputSelectionSnapshot(
      request,
      ownerContext,
      scope,
      fusion.providers,
      requestHash,
    );
    if (!inputSelection)
      return {
        ...recoveryPendingOutcome(),
        reason:
          'The original capture selection could not be recorded faithfully. Your clip remains saved.',
      };
    run = original?.run ?? {
      ...reference,
      ownerGeneration: existing?.ownerGeneration ?? ownerContext.generation,
      captureId: request.captureId,
      analysisId: existing?.analysisId ?? makeUuid(),
      reservationKey: existing?.reservationKey ?? makeUuid(),
      requestHash,
    };
    const identity = run;
    const begun = original
      ? { created: true, run: original.run }
      : admission
        ? await withTransaction(request.db, async rawTransaction => {
            const fresh = await loadSavedTechniqueConfirmation({
              db: rawTransaction,
              ownerContext,
              captureId: request.captureId,
              apiOrigin: scope.apiOrigin,
              originalAnalysisId: admission.original.id,
              signal: request.signal,
              assertCurrent: () => assertExecution(request, ownerContext),
            });
            assertCurrent();
            if (
              fresh.kind !== 'ready' ||
              !sameConfirmationJournalIdentity(
                fresh.journal,
                admission.journal,
              ) ||
              confirmationRecordHash(fresh.saved.record) !==
                confirmationRecordHash(admission.original) ||
              !confirmationInputsMatch(
                fresh.saved.record.inputSelection,
                clip,
                request.targetSeed,
              )
            ) {
              throw new TechniqueConfirmationHeldError(
                'The saved confirmation changed before continuation.',
              );
            }
            const begun = await runJournal.begin(rawTransaction, identity);
            // The owner/service can change while SQLite acknowledges INSERT. Do
            // not commit a continuation that has already lost its admission.
            assertCurrent();
            return begun;
          })
        : await runJournal.begin(request.db, identity);
    run = begun.run;
    assertCurrent();
    let resumedRefusal: PartialOutcomeMarker | null =
      original?.resumedRefusal ?? null;
    if (!begun.created) {
      const settled = await readPartialReplay(request.db, begun.run);
      assertCurrent();
      if (settled?.kind === 'replay')
        return {
          kind: 'partial',
          replayed: true,
          analysisId: begun.run.analysisId,
          record: settled.record,
          partialOutcome: settled.record.partialOutcome,
        };
      if (settled?.kind === 'resume') resumedRefusal = settled.marker;
      else return await readJournalOutcome(request, ownerContext, begun.run);
    }
    // A typed 409 `access.release_not_authorized` is the authority's SETTLED
    // answer, not an outage: no permit exists, nothing is chargeable, and the
    // refusal is stored with the journal row so mechanics can still be
    // delivered — now or by a later run of this same operation.
    let withheld: PartialOutcomeMarker | null = resumedRefusal;
    let permitId: string | null = null;
    if (withheld === null) {
      let reserved: ReservedAnalysisPermitWithAccess | null = null;
      try {
        reserved = await permits.reserve(run.reservationKey);
      } catch (error) {
        const refused = isReleaseNotAuthorized(error);
        if (original && !refused) {
          technicalFailure =
            error instanceof TypeError ||
            (error instanceof ApiError &&
              (error.status === 408 ||
                error.status === 429 ||
                error.status >= 500))
              ? 'reservation_transport'
              : null;
          await originalAnalysisOperations
            .requestRelease(request.db, run, 'failed', technicalFailure)
            .catch(() => {});
        }
        if (refused) {
          const settledRun = run;
          const marker = partialOutcomeMarker();
          await withTransaction(request.db, async tx => {
            if (original)
              await originalAnalysisOperations.requestRelease(
                tx,
                settledRun,
                'failed',
                null,
              );
            await journal.reservationFailed(tx, settledRun, error);
            await saveReservationRefusal(tx, settledRun, marker);
          }).catch(() => {});
          const settled = await journal.read(request.db, reference);
          assertCurrent();
          if (
            !settled ||
            !isSettledRefusalRun(settled) ||
            (await readReservationRefusal(request.db, settled)) === null
          )
            return recoveryPendingOutcome();
          withheld = marker;
        } else {
          await journal
            .reservationFailed(request.db, run, error)
            .catch(() => {});
          if (!isDataOwnerContextCurrent(ownerContext))
            return accountChangedOutcome();
          if (request.signal?.aborted) return cancelledOutcome();
          if (error instanceof ApiError && isPaywallRequired(error)) {
            return {
              kind: 'unavailable',
              reason: error.message,
              cause: 'paywall_required',
            };
          }
          const message =
            error instanceof ApiError
              ? error.message
              : 'The rating service could not be reached. Your capture is saved and can be scored later.';
          return { kind: 'unavailable', reason: message };
        }
      }
      if (reserved !== null) {
        const saved = await journal.reserved(
          request.db,
          run,
          reserved.permit.id,
        );
        assertCurrent();
        if (saved?.state !== 'reserved' || saved.permitId === null)
          return recoveryPendingOutcome();
        permitId = saved.permitId;
        freeLimitReached =
          reserved.permit.accessSource === 'free' &&
          reserved.access !== null &&
          !reserved.access.premium &&
          reserved.access.freeRatings.availableToReserve === 0;
      } else if (withheld === null) return recoveryPendingOutcome();
    }
    assertCurrent();
    // Imported clips carry no measured trigger: the analysis window is
    // honestly the whole clip, and the provenance says exactly that instead
    // of impersonating the live temporal-motion detector. Phase segmentation
    // still finds (or honestly fails to find) the stroke inside that window.
    const trigger: CaptureTrigger =
      clip.captureMode === 'automatic_pose_trigger'
        ? {
            startMs: clip.trigger.startMs,
            endMs: clip.trigger.endMs,
            peakMotionMs: clip.trigger.peakMotionMs ?? null,
            confidence: clip.trigger.confidence,
            producedBy: {
              providerId: 'trigger.temporal-heuristic',
              modelVersion: clip.trigger.modelVersion,
              runtime: 'deterministic' as const,
              executionTarget: 'on_device' as const,
              artifactHash: null,
            },
          }
        : {
            startMs: 0,
            endMs: clip.durationMs,
            peakMotionMs: null,
            confidence: 1,
            producedBy: {
              providerId: 'trigger.imported-full-clip',
              modelVersion: 'imported-full-clip-1',
              runtime: 'deterministic' as const,
              executionTarget: 'on_device' as const,
              artifactHash: null,
            },
          };

    // ── Pose-quality gate: the engine only sees measurably usable tracking ──
    const gate = evaluatePreAnalysisGate({
      frame: null,
      pose: parsed.value,
      poseQuality: evaluateCaptureQuality(parsed.value),
      stroke: strokeWindowFor(clip, parsed.value),
    });
    if (!gate.analyzable) {
      await cleanup('unsupported');
      assertCurrent();
      return {
        kind: 'quality_blocked',
        reason: poseQualityBlockedReason(gate),
        envelope,
        poseQuality: gate,
      };
    }

    const analysisId = run.analysisId;
    phase = 'inference';
    const result = await analyzeCapture(
      fusion.providers,
      {
        captureId: request.captureId,
        pose: parsed.value,
        paddle: unavailable('paddle_detector_not_installed'),
        ball: unavailable('ball_tracker_not_installed'),
        trigger,
        // declared may be null (AUTO DETECT); predicted is filled downstream
        // by the classifier providers, never here.
        stroke: { declared: request.declaredStroke, predicted: null },
        declaredCanonical: request.declaredCanonical ?? null,
        ...(techniqueConfirmation ? { techniqueConfirmation } : {}),
        handedness: request.handedness,
        cameraView: request.cameraView,
        capturedAtIso: clip.capturedAtIso,
      },
      {
        analysisId,
        sessionId: request.sessionId ?? null,
        appVersion: request.appVersion,
        modelBundleVersion: MODEL_BUNDLE_VERSION,
        nowIso: () => new Date().toISOString(),
        makeId: makeUuid,
        captureEnvelopeThresholdsVersion: envelope?.thresholdsVersion ?? null,
        ...(request.focusCheckpoint
          ? { focusCheckpoint: request.focusCheckpoint }
          : {}),
      },
    );
    assertCurrent();
    if (
      original &&
      analysisModelPolicyHash(fusion.providers) !==
        original.operation.modelPolicyHash
    )
      throw new OriginalAnalysisHeldError('model_policy_changed');

    if (!result.ok) {
      if (
        original &&
        (['retryable', 'timeout', 'network'].includes(result.failure.kind) ||
          result.failure.code.endsWith('.provider_crash'))
      )
        technicalFailure = 'inference_technical';
      await cleanup('failed').catch(() => {
        // The permit expires server-side; a lost release is not a lost rating.
      });
      assertCurrent();
      return { kind: 'unavailable', reason: result.failure.message };
    }
    // Attach the measured envelope so downstream Result can explain
    // quality-related abstentions (additive; old records simply lack it).
    const measured: CaptureAnalysisRecord = {
      ...result.value,
      captureEnvelope: envelope,
      observationHash,
      inputSelection,
    };
    const partial =
      withheld === null
        ? null
        : toPartialCaptureAnalysisRecord(measured, withheld);
    const record: CaptureAnalysisRecord = partial ?? measured;

    if (
      record.id !== run.analysisId ||
      record.captureId !== run.captureId ||
      (record.result !== null && record.result.id !== run.analysisId)
    ) {
      throw new RunJournalError('identity_conflict');
    }
    const journalRun = run;
    // Every run is durably recorded, scored or not — reprocessing history.
    phase = 'commit';
    if (original) {
      await originalAnalysisOperations.commit(
        request.db,
        original.execution,
        original.operation.operationId,
        journalRun,
        record,
        withheld,
      );
    } else
      await withTransaction(request.db, async rawTransaction => {
        const db = forDataOwner(rawTransaction, ownerContext);
        if (partial !== null) {
          const settled = await journal.read(rawTransaction, reference);
          if (
            !settled ||
            !isSettledRefusalRun(settled) ||
            originalCanonicalJson(
              await readReservationRefusal(rawTransaction, settled),
            ) !== originalCanonicalJson(partial.partialOutcome)
          )
            throw new RunJournalError('invalid_transition');
        }
        await saveAnalysisRecord(db, record);
        assertCurrent();
        if (record.kind !== 'needs_technique_confirmation') {
          await markCaptureAnalyzed(db, request.captureId);
          assertCurrent();
        }
        // A settled refusal ends here: no permit, no product row, no outbox
        // item — the mechanics record is its whole durable outcome.
        if (partial !== null) return;
        if (record.result?.resultKind === 'scored') {
          if (permitId === null)
            throw new RunJournalError('invalid_transition');
          if (request.practiceSet) {
            if (request.practiceSet.sessionId !== record.result.sessionId) {
              throw new Error('The practice set does not match this analysis.');
            }
            await commitPracticeSet(db, request.practiceSet);
            assertCurrent();
          }
          // Promote to the product rating; the sync transaction consumes the permit.
          await saveAnalysis(db, record.result, permitId);
          assertCurrent();
          await runJournal.commit(rawTransaction, journalRun, record.result.id);
        } else {
          if (record.result) {
            // Local display only — abstentions are never synced as ratings.
            await saveLocalOnlyAnalysis(db, record.result);
            assertCurrent();
          }
          await runJournal.requestRelease(
            rawTransaction,
            journalRun,
            'low_confidence',
          );
        }
        assertCurrent();
      });
    assertCurrent();

    if (partial !== null)
      return {
        kind: 'partial',
        analysisId,
        record: partial,
        partialOutcome: partial.partialOutcome,
      };
    if (record.result?.resultKind === 'scored') {
      return { kind: 'scored', analysisId, record, freeLimitReached };
    }

    // Permit accounting: EVERY non-scored outcome releases the reservation.
    // This branch also carries the AUTO DETECT abstained partial records — an
    // abstained run has result:null and must never burn the user's rating
    // allowance.
    await cleanup('low_confidence').catch(() => {
      // Server-side expiry covers a lost release.
    });
    assertCurrent();
    if (record.kind === 'needs_technique_confirmation') {
      return { kind: 'needs_technique_confirmation', analysisId, record };
    }
    return {
      kind: 'low_confidence',
      analysisId,
      record,
      guidance: record.result?.guidance ?? null,
    };
  } catch (error) {
    let ownerChanged =
      error instanceof DataOwnerChangedError ||
      !isDataOwnerContextCurrent(ownerContext);
    let cancelled =
      error instanceof AnalysisRunCancelledError || request.signal?.aborted;
    if (!run) {
      if (ownerChanged) return accountChangedOutcome();
      if (cancelled) return cancelledOutcome();
      if (error instanceof TechniqueConfirmationHeldError)
        return { ...recoveryPendingOutcome(), reason: error.message };
      throw error;
    }
    if (original && !ownerChanged && !cancelled) {
      try {
        const completed = await originalCompletionOutcome(
          request.db,
          original.execution,
          original.operation.operationId,
          false,
          freeLimitReached,
        );
        if (completed) return completed;
      } catch {
        return recoveryPendingOutcome();
      }
    }
    const durable = await journal.readCommitStatus(request.db, run);
    ownerChanged ||= !isDataOwnerContextCurrent(ownerContext);
    cancelled ||= request.signal?.aborted;
    if (durable.kind === 'committed') {
      if (ownerChanged) return accountChangedOutcome();
      if (cancelled) return recoveryPendingOutcome();
      return await readJournalOutcome(
        request,
        ownerContext,
        durable.run,
        false,
        freeLimitReached,
      ).catch(() => recoveryPendingOutcome());
    }
    if (durable.kind === 'not_committed') {
      if (
        original &&
        phase === 'commit' &&
        !ownerChanged &&
        !cancelled &&
        !(error instanceof RunJournalError) &&
        !(error instanceof OriginalAnalysisHeldError) &&
        error instanceof Error &&
        !/constraint|foreign.key|missing|no.row/i.test(error.message)
      )
        technicalFailure = 'local_commit';
      await cleanup(ownerChanged || cancelled ? 'cancelled' : 'failed').catch(
        () => {},
      );
      if (ownerChanged || !isDataOwnerContextCurrent(ownerContext))
        return accountChangedOutcome();
      if (cancelled || request.signal?.aborted) return cancelledOutcome();
      if (error instanceof TechniqueConfirmationHeldError)
        return { ...recoveryPendingOutcome(), reason: error.message };
      throw error;
    }
    if (ownerChanged) return accountChangedOutcome();
    if (error instanceof RunJournalError && error.code === 'identity_conflict')
      throw error;
    return recoveryPendingOutcome();
  } finally {
    finishExecution();
  }
}
