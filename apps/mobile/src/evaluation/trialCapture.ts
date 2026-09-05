import type {
  EvaluationTrialRecord,
  TrialClaims,
  TrialIndependenceDims,
  TrialUserFlag,
} from '@pickle/shared-types';
import { EVALUATION_TELEMETRY_CONSENT_VERSION } from '@pickle/shared-types';
import type { CaptureAnalysisOutcome } from '../analysis/runCaptureAnalysis';
import type { LocalDb } from '../data/db';
import { getActiveDataOwner } from '../data/accountScope';
import { withConnection } from '../data/transaction';
import { makeUuid } from '../util/uuid';

/**
 * On-device evaluation-trial capture (Wave G2 h07).
 *
 * A trial records what the product CLAIMED and what it ABSTAINED from for
 * one analysis attempt — never whether it was right. Correctness against
 * gold (and therefore silent-failure verdicts) is decided off-device by the
 * evaluation pipeline after human labeling; a device has no gold and must
 * not pretend to.
 *
 * Everything here is gated on the `evaluation_telemetry` consent scope:
 * callers pass the server-derived consent state, and without an active
 * grant no record is built or queued. Raw video never flows through this
 * path — only claim metadata and timings.
 */

export interface EvaluationTelemetryContext {
  /** Server-ledger-derived state. False (or absent context) → no capture. */
  consentActive: boolean;
  consentVersion?: string;
  dims: TrialIndependenceDims;
}

export interface BuildTrialInput {
  outcome: CaptureAnalysisOutcome;
  captureId: string;
  capturedAtIso: string;
  declaredStroke: string | null;
  latencyMs: number | null;
  appVersion: string;
  context: EvaluationTelemetryContext;
  userFlags?: TrialUserFlag[];
  nowIso?: () => string;
}

function claimsFor(outcome: CaptureAnalysisOutcome): TrialClaims {
  const none: TrialClaims = {
    targetLock: { status: 'not_measured' },
    eventSelection: { status: 'abstained', startMs: null, endMs: null },
    strokeLabel: { status: 'abstained', label: null, confidence: null },
    contactMarker: {
      status: 'not_measured',
      estimatedContactMs: null,
      ballConfirmed: false,
      paddleConfirmed: false,
    },
    phaseRender: {
      status: 'abstained',
      contactMs: null,
      followThroughEndMs: null,
    },
    resultScore: {
      status: 'abstained',
      overallScore: null,
      analysisConfidence: null,
      presentation: null,
    },
  };
  if (outcome.kind !== 'scored' && outcome.kind !== 'low_confidence') {
    return none;
  }
  const record = outcome.record;
  const result = record.result;
  const resolution = record.strokeResolution;
  const strokeLabel =
    resolution.kind === 'declared'
      ? { status: 'not_measured' as const, label: null, confidence: null }
      : resolution.kind === 'unresolved'
        ? { status: 'abstained' as const, label: null, confidence: null }
        : {
            status: 'presented' as const,
            label: resolution.shotType,
            confidence: resolution.confidence,
          };
  if (!result) {
    return { ...none, strokeLabel };
  }
  const contactMs = result.timestamps.contactMs;
  const followThroughEnd =
    result.phases.length > 0 ? (result.phases.at(-1)?.endMs ?? null) : null;
  return {
    // Target-identity lock coverage is not independently measured on device
    // today; recorded as not_measured so denominators stay honest.
    targetLock: { status: 'not_measured' },
    eventSelection: {
      status: 'presented',
      startMs: result.timestamps.startMs,
      endMs: result.timestamps.endMs,
    },
    strokeLabel,
    contactMarker: {
      // Ball/paddle trackers are not installed; the contact estimate comes
      // from pose only and is a claim only when a moment was presented.
      status: contactMs === null ? 'abstained' : 'presented',
      estimatedContactMs: contactMs,
      ballConfirmed: false,
      paddleConfirmed: false,
    },
    phaseRender: {
      status: result.phases.length > 0 ? 'presented' : 'abstained',
      contactMs,
      followThroughEndMs: followThroughEnd,
    },
    resultScore: {
      status: result.resultKind === 'scored' ? 'presented' : 'abstained',
      overallScore: result.overallScore,
      analysisConfidence: result.analysisConfidence,
      presentation: record.uncertainty.presentation,
    },
  };
}

/**
 * Build a trial record for one analysis attempt, or null when consent is
 * not active. Pure: no I/O.
 */
export function buildEvaluationTrial(
  input: BuildTrialInput,
): EvaluationTrialRecord | null {
  const { outcome, context } = input;
  if (!context.consentActive) return null;
  const isRecorded =
    outcome.kind === 'scored' || outcome.kind === 'low_confidence';
  return {
    schemaVersion: 'evaluation-trial-v1',
    trialId: makeUuid(),
    captureId: input.captureId,
    analysisId: isRecorded ? outcome.analysisId : null,
    capturedAtIso: input.capturedAtIso,
    recordedAtIso: (input.nowIso ?? (() => new Date().toISOString()))(),
    outcomeKind: outcome.kind,
    outcomeReason:
      outcome.kind === 'unavailable' || outcome.kind === 'quality_blocked'
        ? outcome.reason
        : null,
    envelopeOverall:
      outcome.kind === 'quality_blocked'
        ? (outcome.envelope?.overall ?? null)
        : isRecorded
          ? (outcome.record.captureEnvelope?.overall ?? null)
          : null,
    latencyMs: input.latencyMs,
    appVersion: input.appVersion,
    engineVersion: isRecorded ? outcome.record.engineVersion : null,
    modelBundleVersion: isRecorded ? 'on-device-fusion-1' : null,
    declaredStroke: input.declaredStroke,
    claims: claimsFor(outcome),
    limitingFactors: isRecorded
      ? [...outcome.record.uncertainty.limitingFactors]
      : [],
    userFlags: input.userFlags ?? [],
    dims: context.dims,
    consent: {
      scope: 'evaluation_telemetry',
      consentVersion:
        context.consentVersion ?? EVALUATION_TELEMETRY_CONSENT_VERSION,
    },
  };
}

/**
 * Queue a trial in the durable outbox for upload by the sync engine.
 * Same at-least-once + idempotent-id discipline as shot sync.
 */
export async function enqueueEvaluationTrial(
  db: LocalDb,
  trial: EvaluationTrialRecord,
): Promise<void> {
  await withConnection(db, () =>
    db.execute(
      `INSERT INTO outbox (owner_key, kind, payload)
     VALUES (?, 'evaluation.trial', ?)`,
      [getActiveDataOwner(), JSON.stringify(trial)],
    ),
  );
}

/**
 * Convenience wrapper: build (consent-gated) and queue in one step. A trial
 * that cannot be built (no consent) is a silent no-op by design — telemetry
 * must never block or alter the analysis result the user sees.
 */
export async function recordEvaluationTrial(
  db: LocalDb,
  input: BuildTrialInput,
): Promise<EvaluationTrialRecord | null> {
  const trial = buildEvaluationTrial(input);
  if (trial === null) return null;
  await enqueueEvaluationTrial(db, trial);
  return trial;
}
