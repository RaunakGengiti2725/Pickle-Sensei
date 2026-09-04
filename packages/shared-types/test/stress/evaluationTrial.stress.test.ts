import { describe, it } from "vitest";
import {
  EVALUATION_TRIAL_SCHEMA_VERSION,
  TRIAL_CLAIM_STATUSES,
  TRIAL_OUTCOME_KINDS,
  TRIAL_USER_FLAGS,
  fail,
  failure,
  ok,
  validateEvaluationTrial,
  type EvaluationTrialRecord,
  type FailureKind,
  type TrialClaimStatus,
} from "../../src/index.js";
import {
  bump,
  check,
  checkEqual,
  expectCampaignHeld,
  runStressCampaign,
  stable,
  type Rng,
  type StressCampaign,
  stressTestTimeoutMs,
} from "./harness.js";

/**
 * Seeded stress of validateEvaluationTrial (evaluationTrial.ts):
 *  - a structurally valid record (any legal value per field, including every
 *    claim status, null-able numerics and empty arrays) is accepted with an
 *    empty error list;
 *  - every corruption the validator documents (wrong version, missing
 *    identity strings, unknown discriminants, NaN/±Infinity numerics, wrong
 *    types, unknown user flags, bad platform, bad consent scope) is rejected
 *    with EXACTLY the documented reasons — computed by an independent model
 *    that also mirrors the documented suppression (an invalid claim status
 *    hides that claim's inner checks; a missing claims/dims container hides
 *    its children);
 *  - ok ⇔ errors is empty; the record is never repaired or mutated;
 *  - validation is deterministic and total (never throws on junk).
 *
 * Second campaign: the Result helpers (errors.ts) — ok/fail round-trip and
 * `failure()` marks retryable exactly for timeout | retryable | network,
 * carrying `cause` only when one was given.
 */

type Mutable = Record<string, unknown>;

interface Corruption {
  /** Field path — a later corruption on the same path replaces the earlier. */
  path: string;
  apply: (record: Mutable) => void;
  error: string;
}

type Action =
  | { kind: "corrupt"; index: number; variant: number }
  | { kind: "repair"; path: string }
  | { kind: "legal_mutate"; field: number; variant: number }
  | { kind: "replace_record"; variant: number }
  | { kind: "reset" };

interface Model {
  record: Mutable;
  nonObject: { value: unknown } | null;
  corruptions: Map<string, Corruption>;
  seedRng: Rng;
}

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
const WRONG_TYPES: unknown[] = [1, true, {}, [], -0.5, Number.NaN];

function claimStatus(rng: Rng): TrialClaimStatus {
  return rng.pick(TRIAL_CLAIM_STATUSES);
}

function numOrNull(rng: Rng, min: number, max: number): number | null {
  return rng.chance(0.3) ? null : rng.int(min * 1000, max * 1000) / 1000;
}

function strOrNull(rng: Rng, prefix: string): string | null {
  return rng.chance(0.3) ? null : `${prefix}-${rng.int(0, 9999)}`;
}

function validRecord(rng: Rng): EvaluationTrialRecord {
  return {
    schemaVersion: EVALUATION_TRIAL_SCHEMA_VERSION,
    trialId: `trial-${rng.int(0, 1e9)}`,
    captureId: `cap-${rng.int(0, 1e9)}`,
    analysisId: strOrNull(rng, "analysis"),
    capturedAtIso: new Date(Date.UTC(2026, 8, rng.int(1, 28), rng.int(0, 23))).toISOString(),
    recordedAtIso: new Date(Date.UTC(2026, 8, rng.int(1, 28), rng.int(0, 23))).toISOString(),
    outcomeKind: rng.pick(TRIAL_OUTCOME_KINDS),
    outcomeReason: strOrNull(rng, "reason"),
    envelopeOverall: rng.pick(["SUPPORTED", "DEGRADED", "UNSUPPORTED", null] as const),
    latencyMs: numOrNull(rng, 0, 30000),
    appVersion: `1.${rng.int(0, 20)}.${rng.int(0, 9)}`,
    engineVersion: strOrNull(rng, "engine"),
    modelBundleVersion: strOrNull(rng, "bundle"),
    declaredStroke: strOrNull(rng, "FOREHAND"),
    claims: {
      targetLock: { status: claimStatus(rng) },
      eventSelection: {
        status: claimStatus(rng),
        startMs: numOrNull(rng, 0, 5000),
        endMs: numOrNull(rng, 0, 5000),
      },
      strokeLabel: {
        status: claimStatus(rng),
        label: strOrNull(rng, "label"),
        confidence: numOrNull(rng, 0, 1),
      },
      contactMarker: {
        status: claimStatus(rng),
        estimatedContactMs: numOrNull(rng, 0, 5000),
        ballConfirmed: rng.chance(0.5),
        paddleConfirmed: rng.chance(0.5),
      },
      phaseRender: {
        status: claimStatus(rng),
        contactMs: numOrNull(rng, 0, 5000),
        followThroughEndMs: numOrNull(rng, 0, 5000),
      },
      resultScore: {
        status: claimStatus(rng),
        overallScore: numOrNull(rng, 0, 10),
        analysisConfidence: numOrNull(rng, 0, 1),
        presentation: rng.pick(["normal", "lower_confidence", "abstain", null] as const),
      },
    },
    limitingFactors: Array.from({ length: rng.int(0, 3) }, () => `factor-${rng.int(0, 9)}`),
    userFlags: TRIAL_USER_FLAGS.filter(() => rng.chance(0.25)),
    dims: {
      userPseudonym: strOrNull(rng, "pseud"),
      sessionId: strOrNull(rng, "session"),
      courtId: strOrNull(rng, "court"),
      deviceModel: strOrNull(rng, "iPhone"),
      devicePlatform: rng.pick(["ios", "android"] as const),
      osVersion: strOrNull(rng, "17"),
    },
    consent: { scope: "evaluation_telemetry", consentVersion: `consent-v${rng.int(1, 9)}` },
  };
}

const setPath = (record: Mutable, path: string, value: unknown): void => {
  const parts = path.split(".");
  let cursor: Mutable = record;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Mutable;
  cursor[parts[parts.length - 1]!] = value;
};

const isRecordValue = (value: unknown): value is Mutable =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True when every container along `path` (excluding the leaf) is still an object. */
function parentIsRecord(record: Mutable, path: string): boolean {
  let cursor: unknown = record;
  for (const part of path.split(".").slice(0, -1)) {
    if (!isRecordValue(cursor)) return false;
    cursor = cursor[part];
  }
  return isRecordValue(cursor);
}

const CLAIM_NAMES = [
  "targetLock",
  "eventSelection",
  "strokeLabel",
  "contactMarker",
  "phaseRender",
  "resultScore",
] as const;

/** Every corruption variant the validator documents, keyed by field path. */
function corruptions(variant: number): Corruption[] {
  const pick = <T>(items: readonly T[]): T => items[variant % items.length]!;
  const wrongType = pick(WRONG_TYPES);
  const nonFinite = pick(NON_FINITE);
  const list: Corruption[] = [
    {
      path: "schemaVersion",
      apply: (r) => setPath(r, "schemaVersion", pick(["evaluation-trial-v0", 1, null, undefined])),
      error: `schemaVersion: expected ${EVALUATION_TRIAL_SCHEMA_VERSION}`,
    },
    ...["trialId", "captureId", "capturedAtIso", "recordedAtIso", "appVersion"].map((key) => ({
      path: key,
      apply: (r: Mutable) => setPath(r, key, pick(["", 5, null, undefined])),
      error: `${key}: required string`,
    })),
    {
      path: "analysisId",
      apply: (r) => setPath(r, "analysisId", wrongType),
      error: "analysisId: string or null",
    },
    {
      path: "outcomeKind",
      apply: (r) => setPath(r, "outcomeKind", pick(["SCORED", "", null, 3])),
      error: "outcomeKind: invalid",
    },
    {
      path: "outcomeReason",
      apply: (r) => setPath(r, "outcomeReason", wrongType),
      error: "outcomeReason: string or null",
    },
    {
      path: "envelopeOverall",
      apply: (r) => setPath(r, "envelopeOverall", pick(["supported", "", undefined, 1])),
      error: "envelopeOverall: invalid",
    },
    {
      path: "latencyMs",
      apply: (r) => setPath(r, "latencyMs", pick([...NON_FINITE, "12", true, undefined])),
      error: "latencyMs: finite number or null",
    },
    {
      path: "engineVersion",
      apply: (r) => setPath(r, "engineVersion", wrongType),
      error: "engineVersion: string or null",
    },
    {
      path: "modelBundleVersion",
      apply: (r) => setPath(r, "modelBundleVersion", wrongType),
      error: "modelBundleVersion: string or null",
    },
    {
      path: "declaredStroke",
      apply: (r) => setPath(r, "declaredStroke", wrongType),
      error: "declaredStroke: string or null",
    },
    {
      path: "claims",
      apply: (r) => setPath(r, "claims", pick([null, [], "claims", 1])),
      error: "claims: missing",
    },
    ...CLAIM_NAMES.map((name) => ({
      path: `claims.${name}.status`,
      apply: (r: Mutable) =>
        variant % 2 === 0
          ? setPath(r, `claims.${name}`, pick([null, [], 7]))
          : setPath(r, `claims.${name}.status`, pick(["shown", "", null, 1])),
      error: `claims.${name}: invalid status`,
    })),
    {
      path: "claims.eventSelection.startMs",
      apply: (r) =>
        setPath(r, "claims.eventSelection.startMs", pick([...NON_FINITE, "1", undefined])),
      error: "claims.eventSelection: bounds must be finite or null",
    },
    {
      path: "claims.eventSelection.endMs",
      apply: (r) => setPath(r, "claims.eventSelection.endMs", nonFinite),
      error: "claims.eventSelection: bounds must be finite or null",
    },
    {
      path: "claims.strokeLabel.label",
      apply: (r) => setPath(r, "claims.strokeLabel.label", wrongType),
      error: "claims.strokeLabel.label: string or null",
    },
    {
      path: "claims.strokeLabel.confidence",
      apply: (r) =>
        setPath(r, "claims.strokeLabel.confidence", pick([...NON_FINITE, "0.9", undefined])),
      error: "claims.strokeLabel.confidence: finite or null",
    },
    {
      path: "claims.contactMarker.estimatedContactMs",
      apply: (r) => setPath(r, "claims.contactMarker.estimatedContactMs", nonFinite),
      error: "claims.contactMarker.estimatedContactMs: finite or null",
    },
    {
      path: "claims.contactMarker.ballConfirmed",
      apply: (r) =>
        setPath(r, "claims.contactMarker.ballConfirmed", pick(["yes", null, 1, undefined])),
      error: "claims.contactMarker: confirmations must be booleans",
    },
    {
      path: "claims.contactMarker.paddleConfirmed",
      apply: (r) => setPath(r, "claims.contactMarker.paddleConfirmed", pick(["no", null, 0])),
      error: "claims.contactMarker: confirmations must be booleans",
    },
    {
      path: "claims.phaseRender.contactMs",
      apply: (r) => setPath(r, "claims.phaseRender.contactMs", nonFinite),
      error: "claims.phaseRender: boundaries must be finite or null",
    },
    {
      path: "claims.phaseRender.followThroughEndMs",
      apply: (r) => setPath(r, "claims.phaseRender.followThroughEndMs", pick([...NON_FINITE, "5"])),
      error: "claims.phaseRender: boundaries must be finite or null",
    },
    {
      path: "claims.resultScore.overallScore",
      apply: (r) => setPath(r, "claims.resultScore.overallScore", nonFinite),
      error: "claims.resultScore.overallScore: finite or null",
    },
    {
      path: "claims.resultScore.analysisConfidence",
      apply: (r) =>
        setPath(r, "claims.resultScore.analysisConfidence", pick([...NON_FINITE, {}, undefined])),
      error: "claims.resultScore.analysisConfidence: finite or null",
    },
    {
      path: "claims.resultScore.presentation",
      apply: (r) =>
        setPath(r, "claims.resultScore.presentation", pick(["hidden", undefined, 1, "NORMAL"])),
      error: "claims.resultScore.presentation: invalid",
    },
    {
      path: "limitingFactors",
      apply: (r) => setPath(r, "limitingFactors", pick(["x", [1], null, [null], undefined])),
      error: "limitingFactors: string array",
    },
    {
      path: "userFlags",
      apply: (r) =>
        setPath(r, "userFlags", pick([["bogus"], "not_my_shot", null, ["not_my_shot", 3]])),
      error: "userFlags: array of known flags",
    },
    {
      path: "dims",
      apply: (r) => setPath(r, "dims", pick([null, [], "dims", undefined])),
      error: "dims: missing",
    },
    ...["userPseudonym", "sessionId", "courtId", "deviceModel", "osVersion"].map((key) => ({
      path: `dims.${key}`,
      apply: (r: Mutable) => setPath(r, `dims.${key}`, wrongType),
      error: `dims.${key}: string or null`,
    })),
    {
      path: "dims.devicePlatform",
      apply: (r) => setPath(r, "dims.devicePlatform", pick(["web", "IOS", null, undefined])),
      error: "dims.devicePlatform: invalid",
    },
    {
      path: "consent",
      apply: (r) =>
        setPath(
          r,
          "consent",
          pick([
            null,
            { scope: "model_training", consentVersion: "v1" },
            { scope: "evaluation_telemetry", consentVersion: "" },
            { scope: "evaluation_telemetry" },
            [],
          ]),
        ),
      error: "consent: must reference an evaluation_telemetry grant version",
    },
  ];
  return list;
}

const CORRUPTION_COUNT = corruptions(0).length;

function suppressed(path: string, active: ReadonlySet<string>): boolean {
  if (path.startsWith("claims.") && active.has("claims")) return true;
  if (path.startsWith("dims.") && active.has("dims")) return true;
  const claim = /^claims\.([a-zA-Z]+)\./.exec(path);
  if (claim && !path.endsWith(".status") && active.has(`claims.${claim[1]}.status`)) return true;
  return false;
}

function expectedErrors(model: Model): string[] {
  const active = new Set(model.corruptions.keys());
  const errors = new Set<string>();
  for (const [path, corruption] of model.corruptions) {
    if (!suppressed(path, active)) errors.add(corruption.error);
  }
  return [...errors].sort();
}

const LEGAL_FIELDS = [
  "analysisId",
  "outcomeKind",
  "envelopeOverall",
  "latencyMs",
  "claims.resultScore.presentation",
  "claims.targetLock.status",
  "userFlags",
  "limitingFactors",
  "dims.devicePlatform",
  "claims.contactMarker.ballConfirmed",
  "claims.eventSelection.startMs",
] as const;

function legalValue(field: (typeof LEGAL_FIELDS)[number], rng: Rng): unknown {
  switch (field) {
    case "analysisId":
      return strOrNull(rng, "analysis");
    case "outcomeKind":
      return rng.pick(TRIAL_OUTCOME_KINDS);
    case "envelopeOverall":
      return rng.pick(["SUPPORTED", "DEGRADED", "UNSUPPORTED", null]);
    case "latencyMs":
      return rng.chance(0.2) ? null : rng.pick([0, -0, 1e-9, 1e12, 2 ** 31, -1, 0.1 + 0.2]);
    case "claims.resultScore.presentation":
      return rng.pick(["normal", "lower_confidence", "abstain", null]);
    case "claims.targetLock.status":
      return claimStatus(rng);
    case "userFlags":
      return TRIAL_USER_FLAGS.filter(() => rng.chance(0.5));
    case "limitingFactors":
      return Array.from({ length: rng.int(0, 5) }, () =>
        rng.pick(["", "occlusion", "lighting", "😀"]),
      );
    case "dims.devicePlatform":
      return rng.pick(["ios", "android"]);
    case "claims.contactMarker.ballConfirmed":
      return rng.chance(0.5);
    case "claims.eventSelection.startMs":
      return numOrNull(rng, -10, 10);
  }
}

/** Restores one path (and, for containers, everything beneath it) to a fresh legal value. */
function repair(model: Model, path: string): void {
  const fresh = validRecord(model.seedRng.fork()) as unknown as Mutable;
  const parts = path.split(".");
  if (path === "claims" || path === "dims") {
    setPath(model.record, path, fresh[path]);
    for (const key of [...model.corruptions.keys()])
      if (key === path || key.startsWith(`${path}.`)) model.corruptions.delete(key);
    return;
  }
  if (parts.length === 3 && parts[0] === "claims" && parts[2] === "status") {
    if (!parentIsRecord(model.record, `claims.${parts[1]}`)) return;
    setPath(model.record, `claims.${parts[1]}`, (fresh["claims"] as Mutable)[parts[1]!]);
    for (const key of [...model.corruptions.keys()])
      if (key.startsWith(`claims.${parts[1]}.`)) model.corruptions.delete(key);
    return;
  }
  if (!parentIsRecord(model.record, path)) return;
  let value: unknown = fresh;
  for (const part of parts) value = (value as Mutable)[part];
  setPath(model.record, path, value);
  model.corruptions.delete(path);
}

function genAction(rng: Rng): Action {
  const roll = rng.next();
  if (roll < 0.45)
    return { kind: "corrupt", index: rng.int(0, CORRUPTION_COUNT - 1), variant: rng.int(0, 7) };
  if (roll < 0.7)
    return { kind: "repair", path: corruptions(0)[rng.int(0, CORRUPTION_COUNT - 1)]!.path };
  if (roll < 0.88)
    return {
      kind: "legal_mutate",
      field: rng.int(0, LEGAL_FIELDS.length - 1),
      variant: rng.int(0, 0xffff),
    };
  if (roll < 0.94) return { kind: "replace_record", variant: rng.int(0, 5) };
  return { kind: "reset" };
}

const NON_OBJECTS: unknown[] = [null, undefined, [], "record", 42, true];

function makeValidatorCampaign(): StressCampaign<Action, Model> {
  const stats: Record<string, number> = {};
  return {
    name: "evaluation-trial-validator",
    stats,
    init: (rng) => ({
      record: validRecord(rng) as unknown as Mutable,
      nonObject: null,
      corruptions: new Map(),
      seedRng: rng.fork(),
    }),
    genAction: (rng) => genAction(rng),
    step(model, action) {
      switch (action.kind) {
        case "corrupt": {
          const corruption = corruptions(action.variant)[action.index]!;
          // A corruption beneath a container that is itself corrupted away
          // (claims = null) has nothing to write into; it is a no-op.
          if (model.nonObject === null && parentIsRecord(model.record, corruption.path)) {
            corruption.apply(model.record);
            model.corruptions.set(corruption.path, corruption);
          }
          break;
        }
        case "repair":
          if (model.nonObject === null) repair(model, action.path);
          break;
        case "legal_mutate": {
          const field = LEGAL_FIELDS[action.field]!;
          if (
            model.nonObject === null &&
            parentIsRecord(model.record, field) &&
            !suppressed(field, new Set(model.corruptions.keys())) &&
            !model.corruptions.has(field)
          ) {
            setPath(model.record, field, legalValue(field, model.seedRng.fork()));
          }
          break;
        }
        case "replace_record":
          model.nonObject = { value: NON_OBJECTS[action.variant % NON_OBJECTS.length] };
          break;
        case "reset":
          model.record = validRecord(model.seedRng.fork()) as unknown as Mutable;
          model.corruptions.clear();
          model.nonObject = null;
          break;
      }

      const subject: unknown = model.nonObject === null ? model.record : model.nonObject.value;
      const before = stable(subject);
      const result = validateEvaluationTrial(subject);
      checkEqual(stable(subject), before, "validator-never-mutates-input");
      checkEqual(validateEvaluationTrial(subject), result, "validator-deterministic");
      checkEqual(result.ok, result.errors.length === 0, "ok-iff-no-errors");
      check(
        result.errors.every((e) => typeof e === "string" && e.length > 0),
        "errors-are-non-empty-strings",
        () => stable(result),
      );
      checkEqual(new Set(result.errors).size, result.errors.length, "errors-are-unique");

      if (model.nonObject !== null) {
        checkEqual(
          result,
          { ok: false, errors: ["record: not an object"] },
          "non-object-rejected-with-single-reason",
        );
        bump(stats, "non_object");
        model.nonObject = null;
      } else {
        const expected = expectedErrors(model);
        checkEqual([...result.errors].sort(), expected, "errors-exactly-match-independent-model");
        bump(stats, expected.length === 0 ? "valid_accepted" : "corrupt_rejected");
        if (expected.length === 0) check(result.ok, "legal-record-accepted", () => stable(result));
      }
      return `${action.kind}:${result.ok ? "ok" : result.errors.length}`;
    },
  };
}

const FAILURE_KINDS: readonly FailureKind[] = [
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
];

type ResultAction =
  | { kind: "ok"; value: unknown }
  | {
      kind: "failure";
      failureKind: FailureKind;
      code: string;
      message: string;
      withCause: boolean;
    };

function makeResultCampaign(): StressCampaign<ResultAction, Record<string, never>> {
  const stats: Record<string, number> = {};
  return {
    name: "result-helpers",
    stats,
    init: () => ({}),
    genAction: (rng) =>
      rng.chance(0.4)
        ? {
            kind: "ok",
            value: rng.pick([null, undefined, 0, Number.NaN, "", { nested: [1, 2] }, false]),
          }
        : {
            kind: "failure",
            failureKind: rng.pick(FAILURE_KINDS),
            code: `code.${rng.int(0, 99)}`,
            message: `msg ${rng.int(0, 99)}`,
            withCause: rng.chance(0.5),
          },
    step(_model, action) {
      if (action.kind === "ok") {
        const result = ok(action.value);
        check(
          result.ok === true && Object.is(result.value, action.value),
          "ok-wraps-value-verbatim",
          () => stable(result),
        );
        checkEqual(Object.keys(result), ["ok", "value"], "ok-shape-exact");
        bump(stats, "ok");
        return "ok";
      }
      const cause = action.withCause ? new Error("cause") : undefined;
      const f = failure(action.failureKind, action.code, action.message, cause);
      const expectedRetryable =
        action.failureKind === "timeout" ||
        action.failureKind === "retryable" ||
        action.failureKind === "network";
      checkEqual(f.retryable, expectedRetryable, "retryable-only-for-timeout-retryable-network");
      checkEqual(
        [f.kind, f.code, f.message],
        [action.failureKind, action.code, action.message],
        "failure-fields-verbatim",
      );
      checkEqual("cause" in f, action.withCause, "cause-present-iff-given");
      if (action.withCause) check(f.cause === cause, "cause-identity-preserved", () => stable(f));
      const result = fail(f);
      check(result.ok === false && result.failure === f, "fail-wraps-failure-by-identity", () =>
        stable(result),
      );
      checkEqual(Object.keys(result), ["ok", "failure"], "fail-shape-exact");
      bump(stats, `failure_${f.retryable ? "retryable" : "final"}`);
      return `fail:${action.failureKind}:${f.retryable ? 1 : 0}`;
    },
  };
}

describe("evaluation trial validator — seeded randomized long-run", () => {
  it(
    "accepts every legal record and rejects every corruption with exactly the documented reasons",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeValidatorCampaign()));
    },
    stressTestTimeoutMs(),
  );
});

describe("result helpers — seeded randomized long-run", () => {
  it(
    "wraps values and typed failures verbatim with the frozen retryable rule",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeResultCampaign()));
    },
    stressTestTimeoutMs(),
  );
});
