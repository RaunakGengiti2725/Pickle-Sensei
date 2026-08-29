/**
 * Evaluation-trial contract (evaluation-trial-v1) — the on-device record of
 * ONE analysis attempt, captured for the fresh-user evaluation loop.
 *
 * Rules this contract encodes:
 * - A trial record carries CLAIMS the product presented and abstentions it
 *   made — never verdicts. Correct/wrong is decided later, off-device, by
 *   humans labeling against gold (the silent-failure contract in swing-lab).
 *   The device has no gold and must not pretend to.
 * - Capture and upload are gated on the `evaluation_telemetry` consent
 *   scope. No active grant → no record, no upload, no exception.
 * - Silent-failure accounting is per explicit event kind (wrong target,
 *   wrong event, wrong stroke, false contact, impossible phase, false
 *   high-confidence Result) — never hidden behind an aggregate accuracy.
 * - Learning-curve independence dimensions (user pseudonym, session, court,
 *   device, event) travel with every trial so fresh-user curves can be
 *   computed over genuinely independent units.
 */

/**
 * The six explicit silent-failure event kinds counted by the evaluation
 * pipeline. The first five map 1:1 onto the silent-failure-v1.1 material
 * claims; the sixth names the product-level compound: a scored Result
 * presented at normal (high) confidence in a trial where any material claim
 * silent-failed.
 */
export const SILENT_FAILURE_EVENT_KINDS = [
  "WRONG_TARGET",
  "WRONG_EVENT",
  "WRONG_STROKE",
  "FALSE_CONTACT",
  "IMPOSSIBLE_PHASE",
  "FALSE_HIGH_CONFIDENCE_RESULT",
] as const;
export type SilentFailureEventKind = (typeof SILENT_FAILURE_EVENT_KINDS)[number];

export const EVALUATION_TRIAL_SCHEMA_VERSION = "evaluation-trial-v1";

/**
 * Claim status as recorded ON DEVICE:
 * - "presented": the product showed this claim to the user.
 * - "abstained": the product explicitly declined this claim (honesty).
 * - "not_measured": the subsystem does not produce this claim on this
 *   platform/build — distinct from abstention so denominators stay honest.
 */
export const TRIAL_CLAIM_STATUSES = ["presented", "abstained", "not_measured"] as const;
export type TrialClaimStatus = (typeof TRIAL_CLAIM_STATUSES)[number];

export const TRIAL_OUTCOME_KINDS = [
  "scored",
  "low_confidence",
  "unavailable",
  "quality_blocked",
] as const;
export type TrialOutcomeKind = (typeof TRIAL_OUTCOME_KINDS)[number];

/** User-tapped disagreement flags — candidate silent-failure signals routed
 * to labeling, never verdicts by themselves. */
export const TRIAL_USER_FLAGS = [
  "wrong_person_locked",
  "not_my_shot",
  "wrong_stroke_label",
  "contact_marker_wrong",
  "phases_look_wrong",
  "score_seems_wrong",
] as const;
export type TrialUserFlag = (typeof TRIAL_USER_FLAGS)[number];

export interface TrialClaims {
  /** Target-identity lock. Coverage is not measured on device today. */
  targetLock: { status: TrialClaimStatus };
  /** Stroke-event selection window presented on the timeline. */
  eventSelection: {
    status: TrialClaimStatus;
    startMs: number | null;
    endMs: number | null;
  };
  /** Stroke label shown to the user (predicted, never declared). */
  strokeLabel: {
    status: TrialClaimStatus;
    label: string | null;
    confidence: number | null;
  };
  /** Contact-moment marker. */
  contactMarker: {
    status: TrialClaimStatus;
    estimatedContactMs: number | null;
    ballConfirmed: boolean;
    paddleConfirmed: boolean;
  };
  /** Rendered phase timeline boundaries relevant to ordering validity. */
  phaseRender: {
    status: TrialClaimStatus;
    contactMs: number | null;
    followThroughEndMs: number | null;
  };
  /** The scored Result surface itself. */
  resultScore: {
    status: TrialClaimStatus;
    overallScore: number | null;
    analysisConfidence: number | null;
    presentation: "normal" | "lower_confidence" | "abstain" | null;
  };
}

/**
 * Independence dimensions for learning-curve tracking. Every field is the
 * client's honest value or null — never a fabricated placeholder.
 */
export interface TrialIndependenceDims {
  /** Server-issued consent pseudonym; null until the server stamps it. */
  userPseudonym: string | null;
  sessionId: string | null;
  /** User-entered or app-selected court identifier; null when unknown. */
  courtId: string | null;
  deviceModel: string | null;
  devicePlatform: "ios" | "android";
  osVersion: string | null;
}

export interface EvaluationTrialRecord {
  schemaVersion: typeof EVALUATION_TRIAL_SCHEMA_VERSION;
  /** Client-minted UUID; upload is idempotent on it. */
  trialId: string;
  captureId: string;
  analysisId: string | null;
  capturedAtIso: string;
  recordedAtIso: string;
  outcomeKind: TrialOutcomeKind;
  /** Why the trial produced no user-visible rating, when it didn't. */
  outcomeReason: string | null;
  envelopeOverall: "SUPPORTED" | "DEGRADED" | "UNSUPPORTED" | null;
  /** Wall-clock analysis latency measured on this device; null if unmeasured. */
  latencyMs: number | null;
  appVersion: string;
  engineVersion: string | null;
  modelBundleVersion: string | null;
  declaredStroke: string | null;
  claims: TrialClaims;
  limitingFactors: string[];
  userFlags: TrialUserFlag[];
  dims: TrialIndependenceDims;
  consent: {
    scope: "evaluation_telemetry";
    consentVersion: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isClaimStatus(value: unknown): value is TrialClaimStatus {
  return TRIAL_CLAIM_STATUSES.includes(value as TrialClaimStatus);
}

/**
 * Structural validation of an incoming trial record. Used by the upload
 * endpoint and the pipeline ingest — a record that fails here is rejected
 * with reasons, never repaired or partially trusted.
 */
export function validateEvaluationTrial(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["record: not an object"] };
  if (value.schemaVersion !== EVALUATION_TRIAL_SCHEMA_VERSION) {
    errors.push(`schemaVersion: expected ${EVALUATION_TRIAL_SCHEMA_VERSION}`);
  }
  for (const key of ["trialId", "captureId", "capturedAtIso", "recordedAtIso", "appVersion"]) {
    if (typeof value[key] !== "string" || value[key].length === 0)
      errors.push(`${key}: required string`);
  }
  if (!isStringOrNull(value.analysisId)) errors.push("analysisId: string or null");
  if (!TRIAL_OUTCOME_KINDS.includes(value.outcomeKind as TrialOutcomeKind)) {
    errors.push("outcomeKind: invalid");
  }
  if (!isStringOrNull(value.outcomeReason)) errors.push("outcomeReason: string or null");
  if (
    value.envelopeOverall !== null &&
    value.envelopeOverall !== "SUPPORTED" &&
    value.envelopeOverall !== "DEGRADED" &&
    value.envelopeOverall !== "UNSUPPORTED"
  ) {
    errors.push("envelopeOverall: invalid");
  }
  if (!isFiniteOrNull(value.latencyMs)) errors.push("latencyMs: finite number or null");
  if (!isStringOrNull(value.engineVersion)) errors.push("engineVersion: string or null");
  if (!isStringOrNull(value.modelBundleVersion)) errors.push("modelBundleVersion: string or null");
  if (!isStringOrNull(value.declaredStroke)) errors.push("declaredStroke: string or null");

  const claims = value.claims;
  if (!isRecord(claims)) {
    errors.push("claims: missing");
  } else {
    const checkStatus = (name: string, claim: unknown): claim is Record<string, unknown> => {
      if (!isRecord(claim) || !isClaimStatus(claim.status)) {
        errors.push(`claims.${name}: invalid status`);
        return false;
      }
      return true;
    };
    checkStatus("targetLock", claims.targetLock);
    if (checkStatus("eventSelection", claims.eventSelection)) {
      const c = claims.eventSelection as Record<string, unknown>;
      if (!isFiniteOrNull(c.startMs) || !isFiniteOrNull(c.endMs)) {
        errors.push("claims.eventSelection: bounds must be finite or null");
      }
    }
    if (checkStatus("strokeLabel", claims.strokeLabel)) {
      const c = claims.strokeLabel as Record<string, unknown>;
      if (!isStringOrNull(c.label)) errors.push("claims.strokeLabel.label: string or null");
      if (!isFiniteOrNull(c.confidence))
        errors.push("claims.strokeLabel.confidence: finite or null");
    }
    if (checkStatus("contactMarker", claims.contactMarker)) {
      const c = claims.contactMarker as Record<string, unknown>;
      if (!isFiniteOrNull(c.estimatedContactMs)) {
        errors.push("claims.contactMarker.estimatedContactMs: finite or null");
      }
      if (typeof c.ballConfirmed !== "boolean" || typeof c.paddleConfirmed !== "boolean") {
        errors.push("claims.contactMarker: confirmations must be booleans");
      }
    }
    if (checkStatus("phaseRender", claims.phaseRender)) {
      const c = claims.phaseRender as Record<string, unknown>;
      if (!isFiniteOrNull(c.contactMs) || !isFiniteOrNull(c.followThroughEndMs)) {
        errors.push("claims.phaseRender: boundaries must be finite or null");
      }
    }
    if (checkStatus("resultScore", claims.resultScore)) {
      const c = claims.resultScore as Record<string, unknown>;
      if (!isFiniteOrNull(c.overallScore))
        errors.push("claims.resultScore.overallScore: finite or null");
      if (!isFiniteOrNull(c.analysisConfidence)) {
        errors.push("claims.resultScore.analysisConfidence: finite or null");
      }
      if (
        c.presentation !== null &&
        c.presentation !== "normal" &&
        c.presentation !== "lower_confidence" &&
        c.presentation !== "abstain"
      ) {
        errors.push("claims.resultScore.presentation: invalid");
      }
    }
  }

  if (
    !Array.isArray(value.limitingFactors) ||
    value.limitingFactors.some((f) => typeof f !== "string")
  ) {
    errors.push("limitingFactors: string array");
  }
  if (
    !Array.isArray(value.userFlags) ||
    value.userFlags.some((f) => !TRIAL_USER_FLAGS.includes(f as TrialUserFlag))
  ) {
    errors.push("userFlags: array of known flags");
  }

  const dims = value.dims;
  if (!isRecord(dims)) {
    errors.push("dims: missing");
  } else {
    if (!isStringOrNull(dims.userPseudonym)) errors.push("dims.userPseudonym: string or null");
    if (!isStringOrNull(dims.sessionId)) errors.push("dims.sessionId: string or null");
    if (!isStringOrNull(dims.courtId)) errors.push("dims.courtId: string or null");
    if (!isStringOrNull(dims.deviceModel)) errors.push("dims.deviceModel: string or null");
    if (dims.devicePlatform !== "ios" && dims.devicePlatform !== "android") {
      errors.push("dims.devicePlatform: invalid");
    }
    if (!isStringOrNull(dims.osVersion)) errors.push("dims.osVersion: string or null");
  }

  const consent = value.consent;
  if (
    !isRecord(consent) ||
    consent.scope !== "evaluation_telemetry" ||
    typeof consent.consentVersion !== "string" ||
    consent.consentVersion.length === 0
  ) {
    errors.push("consent: must reference an evaluation_telemetry grant version");
  }

  return { ok: errors.length === 0, errors };
}
