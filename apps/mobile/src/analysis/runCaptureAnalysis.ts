import { Platform } from 'react-native';
import type { EnvelopeVerdict, ShotTypeSlug } from '@pickle/shared-types';
import {
  analyzeCapture,
  type CaptureAnalysisRecord,
} from '@pickle/analysis-pipeline';
import {
  parsePoseSequence,
  sha256Hex,
  unavailable,
} from '@pickle/swing-domain';
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

/**
 * Capture → canonical observations → fusion analysis → durable records.
 *
 * Honesty and product rules enforced here:
 * - Analysis runs only on the real recorded pose sequence (hash-addressed
 *   sidecar written at capture time). No sequence → no analysis.
 * - A server-reserved analysis permit is consumed exactly as the entitlement
 *   system requires; abstentions release the permit instead of burning it.
 * - Every run appends an immutable AnalysisRecord; scored runs additionally
 *   promote the product rating (local_shot + sync outbox).
 */

export type CaptureAnalysisOutcome =
  | { kind: 'scored'; analysisId: string; record: CaptureAnalysisRecord }
  | {
      kind: 'low_confidence';
      analysisId: string;
      record: CaptureAnalysisRecord;
      guidance: string | null;
    }
  | { kind: 'unavailable'; reason: string }
  | {
      /**
       * The capture envelope is UNSUPPORTED: analysis is honestly withheld
       * BEFORE inference — poor input never becomes a confident score. No
       * permit is reserved and nothing is recorded as an analysis.
       */
      kind: 'quality_blocked';
      reason: string;
      envelope: EnvelopeVerdict;
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
  const outcome = await runCaptureAnalysisCore(request);
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

async function runCaptureAnalysisCore(
  request: RunCaptureAnalysisRequest,
): Promise<CaptureAnalysisOutcome> {
  const { clip } = request;
  // ── Capture-envelope gate: UNSUPPORTED input never enters inference ────
  const envelope = request.captureEnvelope ?? null;
  if (envelope && envelope.overall === 'UNSUPPORTED') {
    const blocking = envelope.dimensions
      .filter(d => d.status === 'UNSUPPORTED')
      .map(d => d.dimension)
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
  if (clip.captureMode !== 'automatic_pose_trigger') {
    return {
      kind: 'unavailable',
      reason:
        'Imported videos have no recorded pose sequence yet. Record with the guided camera to get a Technique Score.',
    };
  }
  if (!clip.poseSequence) {
    return {
      kind: 'unavailable',
      reason:
        'This capture predates pose-sequence recording, so it cannot be scored. New guided captures record the full motion.',
    };
  }

  // ── Load and validate the canonical temporal record ────────────────────
  let sidecarJson: string;
  try {
    sidecarJson = await readCaptureArtifact(clip.poseSequence.uri);
  } catch {
    return {
      kind: 'unavailable',
      reason: 'The recorded pose sequence for this capture could not be read.',
    };
  }
  // Integrity: the sidecar must be byte-identical to what capture recorded.
  if (sha256Hex(sidecarJson) !== clip.poseSequence.sha256) {
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
  try {
    const permit = await permits.reserve(makeUuid());
    permitId = permit.id;
  } catch (error) {
    const message =
      error instanceof ApiError
        ? error.message
        : 'The rating service could not be reached. Your capture is saved and can be scored later.';
    return { kind: 'unavailable', reason: message };
  }

  const analysisId = makeUuid();
  const result = await analyzeCapture(
    fusion.providers,
    {
      captureId: request.captureId,
      pose: parsed.value,
      paddle: unavailable('paddle_detector_not_installed'),
      ball: unavailable('ball_tracker_not_installed'),
      trigger: {
        startMs: clip.trigger.startMs,
        endMs: clip.trigger.endMs,
        peakMotionMs: clip.trigger.peakMotionMs ?? null,
        confidence: clip.trigger.confidence,
        producedBy: {
          providerId: 'trigger.temporal-heuristic',
          modelVersion: clip.trigger.modelVersion,
          runtime: 'deterministic',
          executionTarget: 'on_device',
          artifactHash: null,
        },
      },
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
    return { kind: 'scored', analysisId, record };
  }

  // Permit accounting: EVERY non-scored outcome releases the reservation.
  // This branch also carries the AUTO DETECT partial records — a
  // predicted_family (shared side profile) or abstained run has result:null
  // and must never burn the user's rating allowance.
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
