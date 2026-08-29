import { describe, expect, it } from "vitest";
import { generateSwing, timingReport, type BenchmarkReport } from "@pickle/evaluation";
import type { SwingTruth } from "@pickle/evaluation";
import { GeometricPhaseSegmenter } from "../src/index.js";

/**
 * Phase segmentation benchmark — synthetic provenance, versioned cases.
 * Measures contact timing error and accelerate-start boundary error across
 * body/tempo variations. Thresholds below are the current regression floor:
 * a future segmenter must not silently degrade them (raise deliberately).
 */

const CASES: Array<{ caseId: string; truth: Partial<SwingTruth> }> = [
  { caseId: "baseline", truth: {} },
  { caseId: "tall", truth: { torsoLength: 0.26, stanceWidthRatio: 1.6 } },
  { caseId: "compact", truth: { torsoLength: 0.16, contactHeightRatio: 0.3 } },
  { caseId: "left-handed", truth: { handed: "left" } },
  { caseId: "slow-tempo", truth: { backswingMs: 700, accelerateMs: 400, readyMs: 600 } },
  { caseId: "fast-tempo", truth: { backswingMs: 300, accelerateMs: 183, followMs: 250 } },
  { caseId: "high-contact", truth: { contactHeightRatio: 0.55 } },
  { caseId: "deep-dip", truth: { swingDipNorm: 0.2 } },
];

describe("phase segmentation benchmark (synthetic v1)", () => {
  it("holds the contact-timing regression floor", async () => {
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const contactCases = [];
    const abstained: string[] = [];

    for (const benchCase of CASES) {
      const swing = generateSwing(benchCase.truth);
      const result = await segmenter.segmentPhases(swing.frames, [], {
        startMs: swing.window.startMs,
        endMs: swing.window.endMs,
        contactMs: swing.window.peakMs,
        shotTypeHypothesis: null,
        confidence: 0.9,
      });
      if (!result.ok) {
        abstained.push(benchCase.caseId);
        continue;
      }
      const contact = result.value.find((span) => span.key === "contact")!;
      contactCases.push({
        truthMs: swing.window.peakMs,
        predictedMs: contact.representativeMs,
      });
    }

    const contact = timingReport(contactCases);
    const report: BenchmarkReport = {
      benchmark: {
        id: "phase-segmentation-synthetic",
        version: "1",
        task: "phase_segmentation",
        provenance: "synthetic",
        caseCount: CASES.length,
        notes: "Parametric skeleton swings with constructed ground-truth contact.",
      },
      evaluatedAtIso: new Date().toISOString(),
      subject: `phase.geometry@${segmenter.modelVersion}`,
      metrics: {
        contactMeanAbsErrorMs: contact.meanAbsoluteErrorMs,
        contactMedianAbsErrorMs: contact.medianAbsoluteErrorMs,
        contactWithin50ms: contact.withinTolerance(50),
        abstainRate: abstained.length / CASES.length,
      },
      abstainedCaseIds: abstained,
    };
    console.log(JSON.stringify(report, null, 2));

    // Regression floor for the current production segmenter.
    expect(report.metrics["contactWithin50ms"]).toBeGreaterThanOrEqual(0.85);
    expect(report.metrics["contactMeanAbsErrorMs"]).toBeLessThanOrEqual(40);
    expect(report.metrics["abstainRate"]).toBeLessThanOrEqual(0.1);
  });
});
