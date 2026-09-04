import { describe, expect, it } from "vitest";
import type { Measurement } from "@pickle/shared-types";
import {
  CheckpointThresholdFaultDetector,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
  getShotScoringConfig,
  scoreShot,
} from "../../src/index.js";

/**
 * EXECUTION AUDIT HARNESS (pkg-analysis-pipeline, pass 2) — @pickle/scoring.
 * New file only. Feeds the pure scoring engine inputs outside the documented
 * domain (Measurement.value finite, confidence in 0..1) and checks that the
 * engine never emits a non-finite numeric grade under a "normal"
 * presentation. A failing assertion is an audit finding.
 */

const config = getShotScoringConfig("forehand_drive");

function cleanMeasurements(): Measurement[] {
  // Midpoint of every configured target interval, full confidence.
  const out: Measurement[] = [];
  for (const checkpoint of config.checkpoints) {
    for (const target of checkpoint.metrics) {
      out.push({
        metricKey: target.metricKey,
        value: (target.lower + target.upper) / 2,
        confidence: 1,
        unit: "normalized",
        source: "real",
      });
    }
  }
  return out;
}

const isFiniteOrNull = (value: number | null): boolean => value === null || Number.isFinite(value);

describe("AUDIT scoreShot — non-finite / out-of-domain inputs", () => {
  it("baseline: clean midpoints score 10 with presentation normal", () => {
    const outcome = scoreShot(config, cleanMeasurements());
    expect(outcome.presentation).toBe("normal");
    expect(outcome.overallScore).toBe(10);
  });

  it("one NaN measurement value must not produce a NaN overallScore under presentation 'normal'", () => {
    const measurements = cleanMeasurements();
    measurements[0] = { ...measurements[0]!, value: Number.NaN };
    const outcome = scoreShot(config, measurements);
    expect(isFiniteOrNull(outcome.overallScore)).toBe(true);
    for (const checkpoint of outcome.checkpoints) {
      expect(isFiniteOrNull(checkpoint.score)).toBe(true);
    }
  });

  it("one Infinity measurement value yields a finite (worst-case) score, not NaN", () => {
    const measurements = cleanMeasurements();
    measurements[0] = { ...measurements[0]!, value: Number.POSITIVE_INFINITY };
    const outcome = scoreShot(config, measurements);
    expect(isFiniteOrNull(outcome.overallScore)).toBe(true);
    for (const checkpoint of outcome.checkpoints) {
      expect(isFiniteOrNull(checkpoint.score)).toBe(true);
    }
  });

  it("a NaN confidence on one measurement must not poison analysisConfidence", () => {
    const measurements = cleanMeasurements();
    measurements[0] = { ...measurements[0]!, confidence: Number.NaN };
    const outcome = scoreShot(config, measurements);
    expect(Number.isFinite(outcome.analysisConfidence)).toBe(true);
    expect(isFiniteOrNull(outcome.overallScore)).toBe(true);
  });

  it("confidence outside 0..1 (negative) must not yield a negative or >10 overall score", () => {
    const measurements = cleanMeasurements();
    measurements[0] = { ...measurements[0]!, confidence: -1 };
    const outcome = scoreShot(config, measurements);
    if (outcome.overallScore !== null) {
      expect(outcome.overallScore).toBeGreaterThanOrEqual(0);
      expect(outcome.overallScore).toBeLessThanOrEqual(10);
    }
    expect(outcome.analysisConfidence).toBeGreaterThanOrEqual(0);
    expect(outcome.analysisConfidence).toBeLessThanOrEqual(1);
  });

  it("confidence > 1 must not yield analysisConfidence > 1", () => {
    const measurements = cleanMeasurements().map((m) => ({ ...m, confidence: 5 }));
    const outcome = scoreShot(config, measurements);
    expect(outcome.analysisConfidence).toBeLessThanOrEqual(1);
  });

  it("empty measurements abstain with null score and guidance", () => {
    const outcome = scoreShot(config, []);
    expect(outcome.presentation).toBe("abstain");
    expect(outcome.overallScore).toBeNull();
    expect(outcome.guidance).not.toBeNull();
    for (const checkpoint of outcome.checkpoints) {
      expect(checkpoint.score).toBeNull();
      expect(checkpoint.band).toBe("unscored");
    }
  });

  it("duplicate metric keys: last measurement wins deterministically", () => {
    const measurements = cleanMeasurements();
    const first = measurements[0]!;
    const dupA = [...measurements, { ...first, value: first.value + 100 }];
    const dupB = [{ ...first, value: first.value + 100 }, ...measurements];
    const a = scoreShot(config, dupA);
    const b = scoreShot(config, dupB);
    // Order-dependent result: documents the (undocumented) last-wins rule.
    expect(a.overallScore).not.toBe(b.overallScore);
    expect(scoreShot(config, dupA)).toEqual(a);
  });
});

describe("AUDIT scoring adapters — unsupported stroke and incompatible internals", () => {
  const unsupported = "not_a_stroke" as unknown as Parameters<
    Sm1TechniqueScorer["score"]
  >[0]["shotType"];

  it("Sm1TechniqueScorer returns a typed failure for an unknown stroke slug", async () => {
    const result = await new Sm1TechniqueScorer().score({
      shotType: unsupported,
      measurements: [],
      embedding: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("scoring.unsupported_stroke");
  });

  it("PriorityCoachingRanker with an unknown stroke slug returns a typed failure (never throws)", async () => {
    const scorer = new Sm1TechniqueScorer();
    const scored = await scorer.score({
      shotType: "forehand_drive",
      measurements: cleanMeasurements(),
      embedding: null,
    });
    expect(scored.ok).toBe(true);
    if (!scored.ok) return;
    const ranker = new PriorityCoachingRanker();
    // Valid sm-v1 internal, but a slug the config registry does not know.
    const outcome = await ranker
      .rank({ shotType: unsupported, scorerInternal: scored.value.internal })
      .then(
        (value) => ({ threw: false as const, value }),
        (error: unknown) => ({ threw: true as const, error }),
      );
    expect(outcome.threw).toBe(false);
  });

  it("CheckpointThresholdFaultDetector tolerates foreign scorer internals", async () => {
    const detector = new CheckpointThresholdFaultDetector();
    const result = await detector.detectFaults({
      shotType: "forehand_drive",
      checkpoints: [
        {
          key: "contact_position",
          score: 10,
          confidence: 0.9,
          band: "red",
          direction: "late",
          severity: 0.9,
          applicable: true,
        },
      ],
      scorerInternal: { unrelated: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.evidence[0]!.metricKeys).toEqual([]);
  });
});
