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
  type ReleasableAnalysisOutcome,
} from '../data/api';
import { commitPracticeSet, type PracticeSetPlan } from './practiceSet';
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
 * - A server-reserved analysis permit is consumed exactly as the entitlement
 *   system requires; abstentions release the permit instead of burning it.
 * - Every run appends an immutable AnalysisRecord; scored runs additionally
 *   promote the product rating (local_shot + sync outbox).
 * - Once a permit is reserved it is settled EXACTLY once on every exit: a
 *   scored run consumes it through the durable shot.sync row, every other
 *   outcome — including a thrown error — releases it (`PermitSettlement`).
 * - The durable promotion (analysis record, capture status, rating, sync
 *   row and the practice-set bookkeeping the rating references) is ONE
 *   SQLite transaction (`inPromotionTransaction`), so a failure part-way
 *   leaves the capture retryable instead of half-promoted.
 */

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
  /**
   * Practice set the scored rating belongs to (its `sessionId` must equal
   * `sessionId` above). Committed inside the scored promotion transaction —
   * session row + session.create outbox entry ahead of the shot.sync row,
   * plus the kv activity stamp — so the rating can never be durable with a
   * sessionId the server is never told about. Non-scored runs bookkeep
   * nothing.
   */
  practiceSet?: PracticeSetPlan | null;
}

type AnalysisPermitClient = ReturnType<typeof createAnalysisPermitClient>;

/**
 * Settles a reserved analysis permit exactly once. `release()` is a no-op
 * after the first call, and a failing release is swallowed: the server
 * sweeps stale reservations, and a lost release must never mask the error
 * that caused it or turn into a second accounting event.
 */
class PermitSettlement {
  private settled = false;

  constructor(
    private readonly permits: AnalysisPermitClient,
    private readonly permitId: string,
  ) {}

  async release(outcome: ReleasableAnalysisOutcome): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    try {
      await this.permits.release(this.permitId, outcome);
    } catch {
      // Server-side expiry covers a lost release.
    }
  }

  /** The scored promotion is durable: shot.sync consumes the permit. */
  consumedBySync(): void {
    this.settled = true;
  }
}

const TRANSACTION_CONTROL =
  /^\s*(BEGIN(\s+IMMEDIATE)?|COMMIT|ROLLBACK)\s*;?\s*$/i;

/**
 * Runs `work` as ONE SQLite transaction. Repository helpers each open their
 * own `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`; inside this scope those
 * become nested SAVEPOINTs on the outer transaction, so the existing
 * helpers compose atomically without being rewritten. A helper's own
 * rollback unwinds only its savepoint; the outer transaction is committed
 * only when every step succeeded and rolled back otherwise.
 */
async function inPromotionTransaction<T>(
  db: LocalDb,
  work: (scoped: LocalDb) => Promise<T>,
): Promise<T> {
  let depth = 0;
  const scoped: LocalDb = {
    async execute(sql, params) {
      const control = TRANSACTION_CONTROL.exec(sql);
      if (!control) return db.execute(sql, params);
      const verb = control[1]!.toUpperCase();
      if (verb.startsWith('BEGIN')) {
        depth += 1;
        return db.execute(`SAVEPOINT promotion_${depth}`);
      }
      const name = `promotion_${depth}`;
      depth = Math.max(0, depth - 1);
      if (verb === 'ROLLBACK') {
        await db.execute(`ROLLBACK TO SAVEPOINT ${name}`);
      }
      return db.execute(`RELEASE SAVEPOINT ${name}`);
    },
    close() {
      db.close();
    },
  };
  await db.execute('BEGIN IMMEDIATE');
  let value: T;
  try {
    value = await work(scoped);
  } catch (error) {
    try {
      await db.execute('ROLLBACK');
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
  await db.execute('COMMIT');
  return value;
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
  const trigger =
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

  const settlement = new PermitSettlement(permits, permitId);
  try {
    return await analyzeAndPromote(request, {
      envelope,
      parsedPose: parsed.value,
      providers: fusion.providers,
      trigger,
      permitId,
      freeLimitReached,
      settlement,
    });
  } catch (error) {
    // Any thrown step after reservation: the permit is released (once) and
    // the original error still reaches the caller.
    await settlement.release('failed');
    throw error;
  }
}

interface ReservedRun {
  envelope: EnvelopeVerdict | null;
  parsedPose: Parameters<typeof analyzeCapture>[1]['pose'];
  providers: Parameters<typeof analyzeCapture>[0];
  trigger: Parameters<typeof analyzeCapture>[1]['trigger'];
  permitId: string;
  freeLimitReached: boolean;
  settlement: PermitSettlement;
}

async function analyzeAndPromote(
  request: RunCaptureAnalysisRequest,
  run: ReservedRun,
): Promise<CaptureAnalysisOutcome> {
  const { clip } = request;
  const { envelope, permitId, settlement } = run;
  const analysisId = makeUuid();
  const result = await analyzeCapture(
    run.providers,
    {
      captureId: request.captureId,
      pose: run.parsedPose,
      paddle: unavailable('paddle_detector_not_installed'),
      ball: unavailable('ball_tracker_not_installed'),
      trigger: run.trigger,
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
    // The permit expires server-side; a lost release is not a lost rating.
    await settlement.release('failed');
    return { kind: 'unavailable', reason: result.failure.message };
  }
  // Attach the measured envelope so downstream Result can explain
  // quality-related abstentions (additive; old records simply lack it).
  const record: CaptureAnalysisRecord = {
    ...result.value,
    captureEnvelope: envelope,
  };

  if (record.result && record.result.resultKind === 'scored') {
    const scored = record.result;
    // Record, capture status, practice-set bookkeeping and the product
    // rating land together or not at all; the shot.sync row consumes the
    // permit.
    await inPromotionTransaction(request.db, async db => {
      await saveAnalysisRecord(db, record);
      await markCaptureAnalyzed(db, request.captureId);
      if (request.practiceSet) {
        await commitPracticeSet(db, request.practiceSet);
      }
      await saveAnalysis(db, scored, permitId);
    });
    settlement.consumedBySync();
    return {
      kind: 'scored',
      analysisId,
      record,
      freeLimitReached: run.freeLimitReached,
    };
  }

  // Permit accounting: EVERY non-scored outcome releases the reservation.
  // This branch also carries the AUTO DETECT abstained partial records — an
  // abstained run has result:null and must never burn the user's rating
  // allowance.
  await settlement.release('low_confidence');
  const localOnly = record.result;
  // Every run is durably recorded, scored or not — reprocessing history.
  await inPromotionTransaction(request.db, async db => {
    await saveAnalysisRecord(db, record);
    await markCaptureAnalyzed(db, request.captureId);
    if (localOnly) {
      // Local display only — abstentions are never synced as ratings.
      await saveLocalOnlyAnalysis(db, localOnly);
    }
  });
  return {
    kind: 'low_confidence',
    analysisId,
    record,
    guidance: record.result?.guidance ?? null,
  };
}
