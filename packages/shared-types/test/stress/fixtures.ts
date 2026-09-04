/**
 * Well-formed synthetic fixtures the hostile mutations start from. Synthetic
 * structure only — no labels, no fabricated product facts.
 */
import type { ConsentRecord } from "../../src/consent.js";
import {
  EVALUATION_TRIAL_SCHEMA_VERSION,
  TRIAL_CLAIM_STATUSES,
  TRIAL_OUTCOME_KINDS,
  TRIAL_USER_FLAGS,
  type EvaluationTrialRecord,
} from "../../src/evaluationTrial.js";
import type { StabilitySloEvent } from "../../src/stabilitySlo.js";
import type { PlayerRankAnalysisInput } from "../../src/playerRank.js";
import type { Rng } from "./prng.js";

export function makeTrialFixture(): EvaluationTrialRecord {
  return {
    schemaVersion: EVALUATION_TRIAL_SCHEMA_VERSION,
    trialId: "11111111-1111-4111-8111-111111111111",
    captureId: "cap-1",
    analysisId: "an-1",
    capturedAtIso: "2026-08-29T00:00:00.000Z",
    recordedAtIso: "2026-08-29T00:00:01.000Z",
    outcomeKind: "scored",
    outcomeReason: null,
    envelopeOverall: "SUPPORTED",
    latencyMs: 1234,
    appVersion: "0.1.0",
    engineVersion: "fusion-1",
    modelBundleVersion: "on-device-fusion-1",
    declaredStroke: null,
    claims: {
      targetLock: { status: "not_measured" },
      eventSelection: { status: "presented", startMs: 100, endMs: 900 },
      strokeLabel: { status: "presented", label: "FOREHAND", confidence: 0.7 },
      contactMarker: {
        status: "abstained",
        estimatedContactMs: null,
        ballConfirmed: false,
        paddleConfirmed: false,
      },
      phaseRender: { status: "presented", contactMs: 500, followThroughEndMs: 800 },
      resultScore: {
        status: "presented",
        overallScore: 71,
        analysisConfidence: 0.8,
        presentation: "normal",
      },
    },
    limitingFactors: [],
    userFlags: [],
    dims: {
      userPseudonym: null,
      sessionId: "sess-1",
      courtId: null,
      deviceModel: "iPhone15,2",
      devicePlatform: "ios",
      osVersion: "17.5",
    },
    consent: { scope: "evaluation_telemetry", consentVersion: "evaluation-telemetry-v1" },
  };
}

/**
 * Field contract of `validateEvaluationTrial`, expressed independently of the
 * validator so mutations have an oracle to compare against.
 */
export type TrialFieldKind =
  | { kind: "literal"; value: unknown }
  | { kind: "nonEmptyString" }
  | { kind: "nullableString" }
  | { kind: "finiteOrNull" }
  | { kind: "boolean" }
  | { kind: "enum"; allowed: readonly unknown[] }
  | { kind: "nullableEnum"; allowed: readonly unknown[] }
  | { kind: "stringArray" }
  | { kind: "flagArray" }
  | { kind: "record" };

export interface TrialFieldSpec {
  path: readonly string[];
  field: TrialFieldKind;
}

export const TRIAL_FIELD_SPECS: readonly TrialFieldSpec[] = [
  { path: ["schemaVersion"], field: { kind: "literal", value: EVALUATION_TRIAL_SCHEMA_VERSION } },
  { path: ["trialId"], field: { kind: "nonEmptyString" } },
  { path: ["captureId"], field: { kind: "nonEmptyString" } },
  { path: ["analysisId"], field: { kind: "nullableString" } },
  { path: ["capturedAtIso"], field: { kind: "nonEmptyString" } },
  { path: ["recordedAtIso"], field: { kind: "nonEmptyString" } },
  { path: ["outcomeKind"], field: { kind: "enum", allowed: TRIAL_OUTCOME_KINDS } },
  { path: ["outcomeReason"], field: { kind: "nullableString" } },
  {
    path: ["envelopeOverall"],
    field: { kind: "nullableEnum", allowed: ["SUPPORTED", "DEGRADED", "UNSUPPORTED"] },
  },
  { path: ["latencyMs"], field: { kind: "finiteOrNull" } },
  { path: ["appVersion"], field: { kind: "nonEmptyString" } },
  { path: ["engineVersion"], field: { kind: "nullableString" } },
  { path: ["modelBundleVersion"], field: { kind: "nullableString" } },
  { path: ["declaredStroke"], field: { kind: "nullableString" } },
  { path: ["claims"], field: { kind: "record" } },
  { path: ["claims", "targetLock"], field: { kind: "record" } },
  {
    path: ["claims", "targetLock", "status"],
    field: { kind: "enum", allowed: TRIAL_CLAIM_STATUSES },
  },
  { path: ["claims", "eventSelection"], field: { kind: "record" } },
  {
    path: ["claims", "eventSelection", "status"],
    field: { kind: "enum", allowed: TRIAL_CLAIM_STATUSES },
  },
  { path: ["claims", "eventSelection", "startMs"], field: { kind: "finiteOrNull" } },
  { path: ["claims", "eventSelection", "endMs"], field: { kind: "finiteOrNull" } },
  { path: ["claims", "strokeLabel"], field: { kind: "record" } },
  {
    path: ["claims", "strokeLabel", "status"],
    field: { kind: "enum", allowed: TRIAL_CLAIM_STATUSES },
  },
  { path: ["claims", "strokeLabel", "label"], field: { kind: "nullableString" } },
  { path: ["claims", "strokeLabel", "confidence"], field: { kind: "finiteOrNull" } },
  { path: ["claims", "contactMarker"], field: { kind: "record" } },
  {
    path: ["claims", "contactMarker", "status"],
    field: { kind: "enum", allowed: TRIAL_CLAIM_STATUSES },
  },
  { path: ["claims", "contactMarker", "estimatedContactMs"], field: { kind: "finiteOrNull" } },
  { path: ["claims", "contactMarker", "ballConfirmed"], field: { kind: "boolean" } },
  { path: ["claims", "contactMarker", "paddleConfirmed"], field: { kind: "boolean" } },
  { path: ["claims", "phaseRender"], field: { kind: "record" } },
  {
    path: ["claims", "phaseRender", "status"],
    field: { kind: "enum", allowed: TRIAL_CLAIM_STATUSES },
  },
  { path: ["claims", "phaseRender", "contactMs"], field: { kind: "finiteOrNull" } },
  { path: ["claims", "phaseRender", "followThroughEndMs"], field: { kind: "finiteOrNull" } },
  { path: ["claims", "resultScore"], field: { kind: "record" } },
  {
    path: ["claims", "resultScore", "status"],
    field: { kind: "enum", allowed: TRIAL_CLAIM_STATUSES },
  },
  { path: ["claims", "resultScore", "overallScore"], field: { kind: "finiteOrNull" } },
  { path: ["claims", "resultScore", "analysisConfidence"], field: { kind: "finiteOrNull" } },
  {
    path: ["claims", "resultScore", "presentation"],
    field: { kind: "nullableEnum", allowed: ["normal", "lower_confidence", "abstain"] },
  },
  { path: ["limitingFactors"], field: { kind: "stringArray" } },
  { path: ["userFlags"], field: { kind: "flagArray" } },
  { path: ["dims"], field: { kind: "record" } },
  { path: ["dims", "userPseudonym"], field: { kind: "nullableString" } },
  { path: ["dims", "sessionId"], field: { kind: "nullableString" } },
  { path: ["dims", "courtId"], field: { kind: "nullableString" } },
  { path: ["dims", "deviceModel"], field: { kind: "nullableString" } },
  { path: ["dims", "devicePlatform"], field: { kind: "enum", allowed: ["ios", "android"] } },
  { path: ["dims", "osVersion"], field: { kind: "nullableString" } },
  { path: ["consent"], field: { kind: "record" } },
  { path: ["consent", "scope"], field: { kind: "literal", value: "evaluation_telemetry" } },
  { path: ["consent", "consentVersion"], field: { kind: "nonEmptyString" } },
];

/** Whether the trial contract accepts `value` in a slot of the given kind. */
export function trialFieldAccepts(field: TrialFieldKind, value: unknown): boolean {
  switch (field.kind) {
    case "literal":
      return value === field.value;
    case "nonEmptyString":
      return typeof value === "string" && value.length > 0;
    case "nullableString":
      return value === null || typeof value === "string";
    case "finiteOrNull":
      return value === null || (typeof value === "number" && Number.isFinite(value));
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return field.allowed.includes(value);
    case "nullableEnum":
      return value === null || field.allowed.includes(value);
    case "stringArray":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "flagArray":
      return Array.isArray(value) && value.every((v) => TRIAL_USER_FLAGS.includes(v as never));
    case "record":
      // A hostile replacement of a whole sub-record never carries the
      // required inner fields, so the contract rejects it.
      return false;
  }
}

/** Set (or delete when `value` is the DELETE sentinel) a nested path on a deep copy. */
export const DELETE = Symbol("delete");

export function withPath(root: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string, ...string[]];
  const base = typeof root === "object" && root !== null ? root : {};
  if (Array.isArray(base)) {
    const copy = [...(base as unknown[])];
    const index = Number(head);
    if (rest.length === 0) {
      if (value === DELETE) copy.splice(index, 1);
      else copy[index] = value;
      return copy;
    }
    copy[index] = withPath(copy[index], rest, value);
    return copy;
  }
  const copy: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (rest.length === 0) {
    if (value === DELETE) delete copy[head];
    else copy[head] = value;
    return copy;
  }
  copy[head] = withPath(copy[head], rest, value);
  return copy;
}

const UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
];

export function makeConsentRecord(rng: Rng, seq: number | undefined): ConsentRecord {
  const action = rng.bool() ? "granted" : "withdrawn";
  return {
    id: `00000000-0000-4000-8000-${String(rng.int(0, 999_999)).padStart(12, "0")}`,
    subjectPseudonym: "00000000-0000-4000-8000-0000000000aa",
    scope: rng.pick(["video_analysis", "model_training", "evaluation_telemetry"] as const),
    action,
    consentVersion: rng.pick(["model-training-v1", "video-analysis-v1", "evaluation-telemetry-v1"]),
    source: rng.pick(["onboarding", "mobile_settings", "privacy_center", "support"] as const),
    device: rng.bool() ? null : "iPhone15,2",
    captureMode:
      action === "granted"
        ? rng.pick(["all_captures", "automatic_pose_trigger", "imported_video"] as const)
        : null,
    strokeIntent: rng.bool() ? null : "dink",
    recordedAtIso: rng.pick([
      "2026-08-29T00:00:00.000Z",
      "2026-08-29T00:00:00.123Z",
      "2026-08-29T00:00:01.000Z",
      "2026-08-30T12:00:00.000Z",
    ]),
    ...(seq === undefined ? {} : { seq }),
  };
}

export function makeRankInput(rng: Rng): PlayerRankAnalysisInput {
  const withId = rng.bool(0.7);
  return {
    shotType: rng.pick(["forehand_drive", "dink", "third_shot_drop", "serve", "volley"]),
    overallScore: rng.bool(0.85) ? Math.round(rng.float() * 1000) / 100 : null,
    resultKind: rng.bool(0.85) ? "scored" : "low_confidence",
    capturedAt: rng.pick([
      "2026-08-01T10:00:00.000Z",
      "2026-08-02T10:00:00.000Z",
      "2026-08-03T10:00:00.000Z",
      "2026-08-03T10:00:00.000Z",
      "2026-08-04T10:00:00.000Z",
    ]),
    ...(withId ? { id: rng.pick(UUIDS) + String(rng.int(0, 99_999)) } : {}),
    ...(rng.bool(0.3) ? { source: rng.pick(["real", "fixture"]) } : {}),
  };
}

export function makeStabilityEvent(rng: Rng, userIndex: number): StabilitySloEvent {
  const base = {
    userKey: `u${userIndex}`,
    sessionKey: rng.bool(0.9) ? `s${rng.int(0, 20)}` : null,
    at: "2026-09-01T00:00:00.000Z",
  };
  const kind = rng.int(0, 11);
  switch (kind) {
    case 0:
      return { ...base, kind: "session_started" };
    case 1:
      return { ...base, kind: "session_ended_clean" };
    case 2:
      return { ...base, kind: "crash", fatal: rng.bool(), fingerprint: `fp${rng.int(0, 9)}` };
    case 3:
      return { ...base, kind: "memory_pressure_termination" };
    case 4:
      return { ...base, kind: "analysis_started" };
    case 5:
      return { ...base, kind: "analysis_completed" };
    case 6:
      return { ...base, kind: "analysis_failed", failureKind: "timeout" };
    case 7:
      return { ...base, kind: "camera_startup_succeeded" };
    case 8:
      return { ...base, kind: "camera_startup_failed", reason: "permission" };
    case 9:
      return { ...base, kind: "try_again_rearmed" };
    case 10:
      return { ...base, kind: "try_again_failed", reason: "no_capture" };
    default:
      return { ...base, kind: "session_flow_failed", reason: "dispatch" };
  }
}
