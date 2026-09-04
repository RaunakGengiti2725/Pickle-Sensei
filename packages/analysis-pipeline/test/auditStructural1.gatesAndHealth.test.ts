import { describe, expect, it } from "vitest";
import type { CaptureQualityReport, FrameAnalyzabilityReport } from "@pickle/vision-geometry";
import {
  evaluatePreAnalysisGate,
  preAnalysisGate,
  resolvePredictedProfile,
  type HierarchicalStrokePrediction,
} from "../src/index.js";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../src/sessionEngine.js";
import { SessionAnalysisScheduler } from "../src/sessionScheduler.js";
import { assessSessionOpsHealth } from "../src/sessionOpsHealth.js";

/**
 * STRUCTURAL AUDIT #1 (pass 1/3) — gate composition, AUTO-resolution input
 * validation, and ops-health pairing probes.
 */

function frameReport(analyzable: boolean, reasons: string[]): FrameAnalyzabilityReport {
  return {
    analyzable,
    reasons,
    notEvaluated: [],
  } as unknown as FrameAnalyzabilityReport;
}

function qualityReport(reasons: string[]): CaptureQualityReport {
  return { reasons } as unknown as CaptureQualityReport;
}

describe("audit: pre-analysis gate multi-reason composition", () => {
  it("failure kind and code stay consistent when frame AND pose reasons coexist", () => {
    const decision = evaluatePreAnalysisGate({
      frame: frameReport(false, ["still_image"]),
      pose: { frames: [] } as unknown as Parameters<typeof evaluatePreAnalysisGate>[0]["pose"],
      poseQuality: null,
    });
    expect(decision.analyzable).toBe(false);
    expect(decision.reasons).toEqual(["still_image", "no_person_found"]);
    const result = preAnalysisGate({
      frame: frameReport(false, ["still_image"]),
      pose: { frames: [] } as unknown as Parameters<typeof preAnalysisGate>[0]["pose"],
      poseQuality: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Frame reasons are evaluated first, so the code's reason and the kind
    // derived from "any frame reason present" always agree.
    expect(result.failure.kind).toBe("corrupted_media");
    expect(result.failure.code).toBe("capture.not_analyzable.still_image");
    expect(result.failure.message).toContain("no_person_found");
  });

  it("pose-only reasons never escalate to corrupted_media", () => {
    const result = preAnalysisGate({
      frame: frameReport(true, []),
      pose: { frames: [{}] } as unknown as Parameters<typeof preAnalysisGate>[0]["pose"],
      poseQuality: qualityReport(["player_too_small_in_frame"]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("capture.not_analyzable.person_implausible_scale");
  });
});

describe("audit: AUTO resolution confidence floor is total over the number domain", () => {
  const base: Omit<HierarchicalStrokePrediction, "confidence"> = {
    taxonomyVersion: "pickleball-stroke-taxonomy-v3",
    classifierVersion: "stroke-heuristic-1 (uncalibrated)",
    label: "FOREHAND_DRIVE",
    leaf: "FOREHAND_DRIVE",
    taxonomyDepth: 3,
    evidence: ["audit"],
    limitingFactors: [],
  };

  it("a NaN confidence abstains (it is not ≥ the 0.5 floor)", () => {
    const resolved = resolvePredictedProfile({ ...base, confidence: Number.NaN });
    expect(resolved.kind).toBe("abstain");
  });

  it("control: confidence exactly at the floor commits, just below abstains", () => {
    expect(resolvePredictedProfile({ ...base, confidence: 0.5 }).kind).toBe("leaf");
    expect(resolvePredictedProfile({ ...base, confidence: 0.4999 }).kind).toBe("abstain");
  });
});

function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs = 0,
  toMs = 8000,
  stepMs = 40,
): SpeedSample[] {
  const series: SpeedSample[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    let value = 0.08;
    for (const bump of bumps) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    series.push({ timestampMs: t, value });
  }
  return series;
}

const fakeAnalysis = { id: "synthetic-analysis" } as unknown as NonNullable<
  SessionStrokeEvent["analysis"]
>;

describe("audit: ops-health pairing of session snapshot and scheduler metrics", () => {
  it("scheduler metrics identify their session so a cross-session pairing is detectable", async () => {
    const stream = speedBumps(
      [
        { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
        { peakMs: 3600, height: 2.2, halfWidthMs: 120 },
        { peakMs: 6000, height: 1.8, halfWidthMs: 120 },
      ],
      0,
      8200,
    );
    const engineA = new SessionEventEngine({ sessionId: "audit-session-A" });
    const schedulerA = new SessionAnalysisScheduler({
      engine: engineA,
      executor: {
        executorId: "audit",
        execute: async () => ({ status: "ready", analysis: fakeAnalysis }),
      },
    });
    for (const sample of stream) schedulerA.pushSamples({ wrist: [sample] });
    schedulerA.endOfStream();
    await schedulerA.drained();

    // Session B detected the same three event ids but NOTHING was analyzed.
    const engineB = new SessionEventEngine({ sessionId: "audit-session-B" });
    for (const sample of stream) engineB.pushWristSample(sample);
    engineB.flush();
    for (const event of engineB.snapshot().events) expect(event.state).toBe("pending");

    const metrics = schedulerA.metrics();
    const paired = assessSessionOpsHealth(engineB.snapshot(), metrics, { endOfSession: true });
    // Either the metrics carry a session identity the report can check, or
    // the report must not describe B's unanalyzed events using A's task
    // records (attempts/latency copied across sessions).
    const metricsCarrySession = "sessionId" in metrics;
    const reportUsesForeignTasks = paired.events.some((event) => event.attempts > 0);
    expect(metricsCarrySession || !reportUsesForeignTasks).toBe(true);
  });
});
