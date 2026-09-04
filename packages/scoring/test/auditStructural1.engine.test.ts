import { describe, expect, it } from "vitest";
import type { Measurement } from "@pickle/shared-types";
import {
  getAllShotScoringConfigs,
  getShotScoringConfig,
  scoreMetric,
  scoreShot,
  Sm1TechniqueScorer,
} from "../src/index.js";

/**
 * STRUCTURAL AUDIT #1 (pass 1/3) — scoring-engine input hardening probes.
 *
 * `scoreShot` is a PUBLIC provider boundary (Sm1TechniqueScorer wraps it for
 * any biomechanics extractor, not only the geometry one that filters
 * non-finite values). A failing test is a reproduced finding; production
 * code is untouched.
 */

function m(metricKey: string, value: number, confidence = 0.95): Measurement {
  return { metricKey, value, confidence, unit: "normalized", source: "fixture" };
}

function perfectMeasurements(shotType: Parameters<typeof getShotScoringConfig>[0]): Measurement[] {
  const config = getShotScoringConfig(shotType);
  const out: Measurement[] = [];
  for (const cp of config.checkpoints) {
    for (const t of cp.metrics) out.push(m(t.metricKey, (t.lower + t.upper) / 2));
  }
  return out;
}

describe("audit: non-finite measurement values", () => {
  it("a NaN measurement never yields a NaN checkpoint/overall score — it is unobserved or abstains", () => {
    const measurements = perfectMeasurements("forehand_drive").map((entry) =>
      entry.metricKey === "contact_forward_of_hip_norm" ? { ...entry, value: Number.NaN } : entry,
    );
    const outcome = scoreShot(getShotScoringConfig("forehand_drive"), measurements);
    for (const cp of outcome.checkpoints) {
      if (cp.score !== null) expect(Number.isFinite(cp.score)).toBe(true);
    }
    expect(outcome.overallScore === null || Number.isFinite(outcome.overallScore)).toBe(true);
  });

  it("an Infinity measurement decays to zero credit (control)", () => {
    const target = getShotScoringConfig("forehand_drive").checkpoints[0]!.metrics[0]!;
    expect(scoreMetric(target, Number.POSITIVE_INFINITY).q).toBe(0);
    expect(scoreMetric(target, Number.NEGATIVE_INFINITY).q).toBe(0);
  });

  it("a NaN measurement confidence never leaks into analysisConfidence", () => {
    const measurements = perfectMeasurements("forehand_drive").map((entry) =>
      entry.metricKey === "contact_forward_of_hip_norm"
        ? { ...entry, confidence: Number.NaN }
        : entry,
    );
    const outcome = scoreShot(getShotScoringConfig("forehand_drive"), measurements);
    expect(Number.isFinite(outcome.analysisConfidence)).toBe(true);
  });
});

describe("audit: config invariants (v1 registry)", () => {
  it("every metric target has sigma > 0, lower ≤ upper, importance > 0, finite bounds", () => {
    for (const config of getAllShotScoringConfigs()) {
      for (const cp of config.checkpoints) {
        for (const t of cp.metrics) {
          expect(t.sigma, `${config.shotType}/${cp.key}/${t.metricKey}.sigma`).toBeGreaterThan(0);
          expect(t.lower, `${config.shotType}/${cp.key}/${t.metricKey}.lower`).toBeLessThanOrEqual(
            t.upper,
          );
          expect(t.importance).toBeGreaterThan(0);
          expect(Number.isFinite(t.lower) && Number.isFinite(t.upper)).toBe(true);
        }
      }
      expect(config.minAnalysisConfidence).toBeLessThanOrEqual(config.lowerConfidenceThreshold);
    }
  });

  it("registry configs are immutable — a consumer cannot mutate the shared instance", () => {
    const config = getShotScoringConfig("dink");
    const original = config.minAnalysisConfidence;
    let mutated = false;
    try {
      (config as { minAnalysisConfidence: number }).minAnalysisConfidence = 0;
      mutated = getShotScoringConfig("dink").minAnalysisConfidence === 0;
    } catch {
      // frozen — expected
    } finally {
      (config as { minAnalysisConfidence: number }).minAnalysisConfidence = original;
    }
    expect(mutated).toBe(false);
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe("audit: provider adapters over an unknown shot slug", () => {
  const unknownSlug = "audit_unknown_stroke" as Parameters<typeof getShotScoringConfig>[0];

  it("Sm1TechniqueScorer returns a typed failure (control)", async () => {
    const result = await new Sm1TechniqueScorer().score({
      shotType: unknownSlug,
      measurements: [],
      embedding: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("scoring.unsupported_stroke");
  });

  it("Sm1TechniqueScorer over a NaN measurement returns a finite or null overallScore", async () => {
    const measurements = perfectMeasurements("forehand_drive").map((entry) =>
      entry.metricKey === "contact_forward_of_hip_norm" ? { ...entry, value: Number.NaN } : entry,
    );
    const result = await new Sm1TechniqueScorer().score({
      shotType: "forehand_drive",
      measurements,
      embedding: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.overallScore === null || Number.isFinite(result.value.overallScore)).toBe(
      true,
    );
    expect(result.value.presentation).not.toBe("normal");
  });
});
