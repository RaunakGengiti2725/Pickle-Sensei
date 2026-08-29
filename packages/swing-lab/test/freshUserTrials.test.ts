import { describe, expect, it } from "vitest";
import type { EvaluationTrialRecord } from "@pickle/shared-types";
import {
  buildFreshUserReport,
  countSilentFailures,
  independenceCoverage,
  ingestTrials,
  type TrialLabel,
} from "../src/freshUserTrials.js";

function trial(overrides: Partial<EvaluationTrialRecord> = {}): EvaluationTrialRecord {
  return {
    schemaVersion: "evaluation-trial-v1",
    trialId: "11111111-1111-4111-8111-111111111111",
    captureId: "cap-1",
    analysisId: "an-1",
    capturedAtIso: "2026-08-29T00:00:00.000Z",
    recordedAtIso: "2026-08-29T00:00:01.000Z",
    outcomeKind: "scored",
    outcomeReason: null,
    envelopeOverall: "SUPPORTED",
    latencyMs: 900,
    appVersion: "0.1.0",
    engineVersion: "fusion-1",
    modelBundleVersion: "on-device-fusion-1",
    declaredStroke: null,
    claims: {
      targetLock: { status: "not_measured" },
      eventSelection: { status: "presented", startMs: 0, endMs: 900 },
      strokeLabel: { status: "presented", label: "dink", confidence: 0.8 },
      contactMarker: {
        status: "presented",
        estimatedContactMs: 450,
        ballConfirmed: false,
        paddleConfirmed: false,
      },
      phaseRender: { status: "presented", contactMs: 450, followThroughEndMs: 800 },
      resultScore: {
        status: "presented",
        overallScore: 72,
        analysisConfidence: 0.85,
        presentation: "normal",
      },
    },
    limitingFactors: [],
    userFlags: [],
    dims: {
      userPseudonym: "u1",
      sessionId: "s1",
      courtId: "court-a",
      deviceModel: "iPhone15,2",
      devicePlatform: "ios",
      osVersion: "17.5",
    },
    consent: { scope: "evaluation_telemetry", consentVersion: "evaluation-telemetry-v1" },
    ...overrides,
  };
}

function label(trialId: string, overrides: Partial<TrialLabel["claims"]> = {}): TrialLabel {
  return {
    trialId,
    labelerId: "labeler-1",
    labeledAtIso: "2026-08-29T02:00:00.000Z",
    claims: {
      targetLock: "not_labeled",
      eventSelection: "correct",
      strokeLabel: "correct",
      contactMarker: "correct",
      phaseRender: "correct",
      ...overrides,
    },
  };
}

describe("fresh-user trial ingest", () => {
  it("rejects invalid records and duplicate trialIds, never repairing them", () => {
    const good = trial();
    const result = ingestTrials([good, { junk: true }, good]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[1]!.errors).toEqual(["trialId: duplicate"]);
  });
});

describe("explicit silent-failure counting", () => {
  it("counts each event kind separately and compounds normal-confidence Results", () => {
    const t1 = trial({ trialId: "t1" });
    const t2 = trial({
      trialId: "t2",
      claims: {
        ...trial().claims,
        resultScore: { ...trial().claims.resultScore, presentation: "lower_confidence" },
      },
    });
    const counts = countSilentFailures(
      [t1, t2],
      [label("t1", { strokeLabel: "wrong" }), label("t2", { contactMarker: "wrong" })],
    );
    expect(counts.byEvent.WRONG_STROKE).toBe(1);
    expect(counts.byEvent.FALSE_CONTACT).toBe(1);
    expect(counts.byEvent.WRONG_TARGET).toBe(0);
    expect(counts.byEvent.WRONG_EVENT).toBe(0);
    expect(counts.byEvent.IMPOSSIBLE_PHASE).toBe(0);
    // Only t1 presented at normal confidence with a wrong claim.
    expect(counts.byEvent.FALSE_HIGH_CONFIDENCE_RESULT).toBe(1);
  });

  it("never counts abstained or unverifiable claims in any denominator", () => {
    const t = trial({
      trialId: "t3",
      claims: {
        ...trial().claims,
        strokeLabel: { status: "abstained", label: null, confidence: null },
      },
    });
    const counts = countSilentFailures(
      [t],
      [label("t3", { strokeLabel: "wrong", eventSelection: "unverifiable" })],
    );
    // Abstained stroke cannot silent-fail even if mislabeled wrong.
    expect(counts.byEvent.WRONG_STROKE).toBe(0);
    expect(counts.labeledPresentedByClaim.strokeLabel).toBe(0);
    expect(counts.labeledPresentedByClaim.eventSelection).toBe(0);
    expect(counts.labeledPresentedByClaim.contactMarker).toBe(1);
  });

  it("keeps unlabeled trials out of counts and visible in the report", () => {
    const counts = countSilentFailures([trial({ trialId: "t4" })], []);
    expect(counts.trialsLabeled).toBe(0);
    expect(counts.trialsUnlabeled).toBe(1);
  });
});

describe("learning-curve independence coverage", () => {
  it("counts distinct users/sessions/courts/devices and keeps unknowns separate", () => {
    const trials = [
      trial({ trialId: "a" }),
      trial({
        trialId: "b",
        dims: { ...trial().dims, userPseudonym: "u2", sessionId: "s2", courtId: null },
      }),
      trial({
        trialId: "c",
        dims: { ...trial().dims, userPseudonym: null, deviceModel: "iPhone14,5" },
      }),
    ];
    const coverage = independenceCoverage(trials);
    expect(coverage.users).toBe(2);
    expect(coverage.sessions).toBe(2);
    expect(coverage.courts).toBe(1);
    expect(coverage.devices).toBe(2);
    expect(coverage.events).toBe(3);
    expect(coverage.unknown.users).toBe(1);
    expect(coverage.unknown.courts).toBe(1);
  });
});

describe("fresh-user report", () => {
  it("reports outcome mix, per-event failures, coverage, and user flags — no single aggregate", () => {
    const trials = [
      trial({ trialId: "a", userFlags: ["score_seems_wrong"] }),
      trial({ trialId: "b", outcomeKind: "quality_blocked", outcomeReason: "unsupported" }),
    ];
    const report = buildFreshUserReport(trials, [label("a")], () => "2026-08-29T03:00:00.000Z");
    expect(report.trialCount).toBe(2);
    expect(report.outcomes).toEqual({ scored: 1, quality_blocked: 1 });
    expect(report.userFlagCounts).toEqual({ score_seems_wrong: 1 });
    expect(report.silentFailures.trialsUnlabeled).toBe(1);
    expect(report.coverage.events).toBe(2);
    expect(report).not.toHaveProperty("accuracy");
  });
});
