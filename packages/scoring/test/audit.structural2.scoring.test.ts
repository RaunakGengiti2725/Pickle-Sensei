import { describe, expect, it } from "vitest";
import type { Measurement, ShotTypeSlug } from "@pickle/shared-types";
import {
  AnalysisRunLedger,
  bandFor,
  getAllShotScoringConfigs,
  getShotScoringConfig,
  PriorityCoachingRanker,
  scoreMetric,
  scoreShot,
  Sm1TechniqueScorer,
} from "../src/index.js";

/**
 * STRUCTURAL AUDIT #2 (pass 1) — @pickle/scoring reproducers.
 * Failing test = finding; passing test = verified invariant.
 */

function m(metricKey: string, value: number, confidence = 0.95): Measurement {
  return { metricKey, value, confidence, unit: "normalized", source: "fixture" };
}

function perfectMeasurements(shotType: ShotTypeSlug, confidence = 0.95): Measurement[] {
  const config = getShotScoringConfig(shotType);
  const out: Measurement[] = [];
  for (const cp of config.checkpoints) {
    for (const t of cp.metrics) out.push(m(t.metricKey, (t.lower + t.upper) / 2, confidence));
  }
  return out;
}

describe("AUDIT scoring engine — non-finite input containment", () => {
  it("SC2-A: a NaN measurement value must never surface as a NaN user-facing score (abstain, exclude, or fail — never NaN)", () => {
    const config = getShotScoringConfig("forehand_drive");
    const measurements = perfectMeasurements("forehand_drive");
    measurements[0] = { ...measurements[0]!, value: Number.NaN };
    const outcome = scoreShot(config, measurements);
    console.log(
      JSON.stringify({
        audit: "SC2-A NaN measurement",
        overallScore: String(outcome.overallScore),
        presentation: outcome.presentation,
        analysisConfidence: outcome.analysisConfidence,
        checkpoints: outcome.checkpoints.map((c) => ({
          key: c.key,
          score: String(c.score),
          band: c.band,
          severity: String(c.severity),
        })),
      }),
    );
    for (const checkpoint of outcome.checkpoints) {
      expect(checkpoint.score === null || Number.isFinite(checkpoint.score)).toBe(true);
    }
    expect(outcome.overallScore === null || Number.isFinite(outcome.overallScore)).toBe(true);
  });

  it("SC2-B: an Infinity measurement decays to q=0 (verified invariant) and a -Infinity too", () => {
    const target = getShotScoringConfig("forehand_drive").checkpoints[0]!.metrics[0]!;
    expect(scoreMetric(target, Number.POSITIVE_INFINITY).q).toBe(0);
    expect(scoreMetric(target, Number.NEGATIVE_INFINITY).q).toBe(0);
  });
});

describe("AUDIT scoring config v1 — arithmetic preconditions", () => {
  it("SC2-C: every configured target has sigma>0, lower<=upper, importance>0 and finite bounds (verified invariant)", () => {
    for (const config of getAllShotScoringConfigs()) {
      for (const checkpoint of config.checkpoints) {
        for (const target of checkpoint.metrics) {
          const where = `${config.shotType}/${checkpoint.key}/${target.metricKey}`;
          expect(target.sigma, where).toBeGreaterThan(0);
          expect(target.importance, where).toBeGreaterThan(0);
          expect(target.lower, where).toBeLessThanOrEqual(target.upper);
          expect(Number.isFinite(target.lower) && Number.isFinite(target.upper), where).toBe(true);
        }
      }
      expect(config.minAnalysisConfidence).toBeLessThan(config.lowerConfidenceThreshold);
    }
  });

  it("SC2-D: bandFor boundaries are inclusive at 80/65 (verified invariant)", () => {
    expect(bandFor(80)).toBe("green");
    expect(bandFor(79.999)).toBe("yellow");
    expect(bandFor(65)).toBe("yellow");
    expect(bandFor(64.999)).toBe("red");
    expect(bandFor(null)).toBe("unscored");
  });
});

describe("AUDIT scoring adapters — typed failures vs throws", () => {
  it("SC2-E: Sm1TechniqueScorer returns a typed failure for an unsupported slug (verified invariant)", async () => {
    const result = await new Sm1TechniqueScorer().score({
      shotType: "around_the_post" as ShotTypeSlug,
      measurements: [],
      embedding: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("scoring.unsupported_stroke");
  });

  it("SC2-F: PriorityCoachingRanker returns a typed failure for an unsupported slug — not a rejected promise (contract parity with the scorer)", async () => {
    let threw: string | null = null;
    let result: Awaited<ReturnType<PriorityCoachingRanker["rank"]>> | null = null;
    try {
      result = await new PriorityCoachingRanker().rank({
        shotType: "around_the_post" as ShotTypeSlug,
        scorerInternal: { checkpointResults: [], shotType: "around_the_post" },
      });
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    expect(threw).toBeNull();
    expect(result?.ok).toBe(false);
  });
});

describe("AUDIT score-version governance — exported ledger", () => {
  it("SC2-G: AnalysisRunLedger.reprocess() (the ledger exported from @pickle/scoring) rejects a same-version reprocess (docstring: 'under a NEW model version')", () => {
    const ledger = new AnalysisRunLedger();
    ledger.record({
      runId: "run-1",
      shotId: "shot-1",
      scoringModelVersion: "sm-v1",
      overallScore: 6.1,
      capturedAt: "2026-08-01T10:00:00.000Z",
      scoredAt: "2026-08-01T10:00:05.000Z",
      reprocessedFromRunId: null,
    });
    expect(() =>
      ledger.reprocess("run-1", {
        runId: "run-2",
        scoringModelVersion: "sm-v1",
        overallScore: 7.4,
        scoredAt: "2026-08-02T10:00:05.000Z",
      }),
    ).toThrow();
  });
});
