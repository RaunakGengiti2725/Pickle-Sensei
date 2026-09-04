import { Platform } from 'react-native';
import type { EnvelopeVerdict, ShotTypeSlug } from '@pickle/shared-types';
import {
  analyzeCapture,
  evaluatePreAnalysisGate,
  type CaptureAnalysisRecord,
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
import { readCaptureArtifact, type CapturedClip } from '../camera/capture';
import type { LocalDb } from '../data/db';
import {
  markCaptureAnalyzed,
  saveAnalysis,
  saveAnalysisRecord,
  saveLocalOnlyAnalysis,
} from '../data/repository';
import { createFusionProviders } from '../vision/providers';
import {
  ApiError,
  createAnalysisPermitClient,
  type ApiConfigState,
} from '../data/api';
import { makeUuid } from '../util/uuid';
import {
  recordEvaluationTrial,
  type EvaluationTelemetryContext,
} from '../evaluation/trialCapture';
import { stabilitySlo } from './stabilityTelemetry';

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
      analysisId: string;
      record: CaptureAnalysisRecord;
      guidance: string | null;
    }
  | {
      kind: 'unavailable';
      reason: string;
      /** HTTP 402 `access.paywall_required`: not retryable without an upgrade. */
      cause?: 'paywall_required';
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

export interface RunCaptureAnalysisRequest {
  db: LocalDb;
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
  handedness: 'right' | 'left' | 'ambidextrous';
  cameraView: 'side' | 'rear_oblique';
  apiConfig: ApiConfigState;
  appVersion: string;
  sessionId?: string | null;
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
): Promise<CaptureAnalysisOutcome> {
  const startedAt = Date.now();
  stabilitySlo.record({ kind: 'analysis_started' });
  let outcome: CaptureAnalysisOutcome;
  try {
    outcome = await runCaptureAnalysisCore(request);
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
  if (telemetry && telemetry.consentActive) {
    try {
      await recordEvaluationTrial(request.db, {
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

async function runCaptureAnalysisCore(
  request: RunCaptureAnalysisRequest,
): Promise<CaptureAnalysisOutcome> {
  const { clip } = request;
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
    return {
      kind: 'unavailable',
      reason: 'The recorded pose sequence for this capture could not be read.',
    };
  }
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

  const fusion = createFusionProviders(request.declaredStroke);
  if (fusion.kind === 'unavailable') {
    return { kind: 'unavailable', reason: fusion.reason };
  }

  // ── Entitlement: reserve before inference (spec: permits) ─────────────
  const permits = createAnalysisPermitClient(request.apiConfig);
  let permitId: string;
  let freeLimitReached = false;
  try {
    const reserved = await permits.reserve(makeUuid());
    permitId = reserved.permit.id;
    freeLimitReached =
      reserved.permit.accessSource === 'free' &&
      reserved.access !== null &&
      !reserved.access.premium &&
      reserved.access.freeRatings.availableToReserve === 0;
  } catch (error) {
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
    await permits.release(permitId, 'unsupported').catch(() => {
      // Server-side expiry covers a lost release.
    });
    return {
      kind: 'quality_blocked',
      reason: poseQualityBlockedReason(gate),
      envelope,
      poseQuality: gate,
    };
  }

  const analysisId = makeUuid();
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
      handedness: request.handedness,
      cameraView: request.cameraView,
      capturedAtIso: clip.capturedAtIso,
    },
    {
      analysisId,
      sessionId: request.sessionId ?? null,
      appVersion: request.appVersion,
      modelBundleVersion: 'on-device-fusion-1',
      nowIso: () => new Date().toISOString(),
      makeId: makeUuid,
      captureEnvelopeThresholdsVersion: envelope?.thresholdsVersion ?? null,
      ...(request.focusCheckpoint
        ? { focusCheckpoint: request.focusCheckpoint }
        : {}),
    },
  );

  if (!result.ok) {
    await permits.release(permitId, 'failed').catch(() => {
      // The permit expires server-side; a lost release is not a lost rating.
    });
    return { kind: 'unavailable', reason: result.failure.message };
  }
  // Attach the measured envelope so downstream Result can explain
  // quality-related abstentions (additive; old records simply lack it).
  const record: CaptureAnalysisRecord = {
    ...result.value,
    captureEnvelope: envelope,
  };

  // Every run is durably recorded, scored or not — reprocessing history.
  await saveAnalysisRecord(request.db, record);
  await markCaptureAnalyzed(request.db, request.captureId);

  if (record.result && record.result.resultKind === 'scored') {
    // Promote to the product rating; the sync transaction consumes the permit.
    await saveAnalysis(request.db, record.result, permitId);
    return { kind: 'scored', analysisId, record, freeLimitReached };
  }

  // Permit accounting: EVERY non-scored outcome releases the reservation.
  // This branch also carries the AUTO DETECT abstained partial records — an
  // abstained run has result:null and must never burn the user's rating
  // allowance.
  await permits.release(permitId, 'low_confidence').catch(() => {
    // Server-side expiry covers a lost release.
  });
  if (record.result) {
    // Local display only — abstentions are never synced as ratings.
    await saveLocalOnlyAnalysis(request.db, record.result);
  }
  return {
    kind: 'low_confidence',
    analysisId,
    record,
    guidance: record.result?.guidance ?? null,
  };
}
