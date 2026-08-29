import { describe, expect, it } from "vitest";
import {
  EVALUATION_TRIAL_SCHEMA_VERSION,
  SILENT_FAILURE_EVENT_KINDS,
  validateEvaluationTrial,
  type EvaluationTrialRecord,
} from "../src/evaluationTrial.js";
import { isEvaluationTelemetryConsentActive, type ConsentRecord } from "../src/consent.js";

export function makeTrial(overrides: Partial<EvaluationTrialRecord> = {}): EvaluationTrialRecord {
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
    ...overrides,
  };
}

describe("evaluation trial contract", () => {
  it("names the six explicit silent-failure event kinds", () => {
    expect(SILENT_FAILURE_EVENT_KINDS).toEqual([
      "WRONG_TARGET",
      "WRONG_EVENT",
      "WRONG_STROKE",
      "FALSE_CONTACT",
      "IMPOSSIBLE_PHASE",
      "FALSE_HIGH_CONFIDENCE_RESULT",
    ]);
  });

  it("accepts a well-formed trial record", () => {
    expect(validateEvaluationTrial(makeTrial())).toEqual({ ok: true, errors: [] });
  });

  it("rejects a record without an evaluation_telemetry consent reference", () => {
    const bad = { ...makeTrial(), consent: { scope: "model_training", consentVersion: "x" } };
    const verdict = validateEvaluationTrial(bad);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(" ")).toContain("evaluation_telemetry");
  });

  it("rejects non-finite numeric claim fields", () => {
    const trial = makeTrial();
    trial.claims.eventSelection.startMs = Number.NaN;
    const verdict = validateEvaluationTrial(trial);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(" ")).toContain("eventSelection");
  });

  it("rejects unknown user flags and claim statuses", () => {
    const flagged = makeTrial({ userFlags: ["made_up_flag" as never] });
    expect(validateEvaluationTrial(flagged).ok).toBe(false);
    const trial = makeTrial();
    (trial.claims.targetLock as { status: string }).status = "correct";
    expect(validateEvaluationTrial(trial).ok).toBe(false);
  });

  it("evaluation_telemetry consent defaults to NOT active", () => {
    expect(isEvaluationTelemetryConsentActive([])).toBe(false);
    const grant: ConsentRecord = {
      id: "r1",
      subjectPseudonym: "p1",
      scope: "evaluation_telemetry",
      action: "granted",
      consentVersion: "evaluation-telemetry-v1",
      source: "mobile_settings",
      device: null,
      captureMode: "all_captures",
      strokeIntent: null,
      recordedAtIso: "2026-08-29T00:00:00.000Z",
    };
    expect(isEvaluationTelemetryConsentActive([grant])).toBe(true);
    expect(
      isEvaluationTelemetryConsentActive([
        grant,
        { ...grant, id: "r2", action: "withdrawn", recordedAtIso: "2026-08-29T01:00:00.000Z" },
      ]),
    ).toBe(false);
  });
});
