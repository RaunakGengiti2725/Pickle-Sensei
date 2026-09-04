import { describe, expect, it } from "vitest";
import type { Measurement } from "@pickle/shared-types";
import { getShotScoringConfig, scoreShot } from "../../src/index.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #2 — scoring engine input hardening. The
 * engine is documented "pure and deterministic" and is the LAST stage before
 * a number reaches the athlete; here we feed it the kinds of values a CV
 * stage can leak (NaN from a 0/0 ratio, ±Infinity from a zero-length
 * segment, out-of-range confidences) and check that the outcome is either a
 * finite 0–10 score or an explicit abstention — never a NaN/out-of-range
 * number presented as "normal".
 */

function m(metricKey: string, value: number, confidence = 0.95): Measurement {
  return { metricKey, value, confidence, unit: "normalized", source: "fixture" };
}

function perfect(confidence = 0.95): Measurement[] {
  const config = getShotScoringConfig("forehand_drive");
  const out: Measurement[] = [];
  for (const cp of config.checkpoints) {
    for (const t of cp.metrics) out.push(m(t.metricKey, (t.lower + t.upper) / 2, confidence));
  }
  return out;
}

function firstMetricKey(): string {
  return getShotScoringConfig("forehand_drive").checkpoints[0]!.metrics[0]!.metricKey;
}

// Float-sum slack: Σ(importance·c·100)/Σ(importance·c) lands on
// 100.00000000000001 for perfect input; that is not a range violation.
const EPS = 1e-9;

function assertSane(outcome: ReturnType<typeof scoreShot>, label: string) {
  const detail = JSON.stringify(
    {
      overallScore: outcome.overallScore,
      analysisConfidence: outcome.analysisConfidence,
      presentation: outcome.presentation,
      checkpoints: outcome.checkpoints.map((c) => ({
        key: c.key,
        score: c.score,
        band: c.band,
        severity: c.severity,
      })),
    },
    (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? `<<${String(v)}>>` : v),
  );
  if (outcome.presentation !== "abstain") {
    expect(outcome.overallScore, `${label}: overallScore ${detail}`).not.toBeNull();
    expect(
      Number.isFinite(outcome.overallScore!),
      `${label}: overallScore not finite ${detail}`,
    ).toBe(true);
    expect(
      outcome.overallScore!,
      `${label}: overallScore out of range ${detail}`,
    ).toBeGreaterThanOrEqual(-EPS);
    expect(
      outcome.overallScore!,
      `${label}: overallScore out of range ${detail}`,
    ).toBeLessThanOrEqual(10 + EPS);
  }
  expect(
    Number.isFinite(outcome.analysisConfidence),
    `${label}: analysisConfidence ${detail}`,
  ).toBe(true);
  for (const cp of outcome.checkpoints) {
    if (cp.score !== null) {
      expect(Number.isFinite(cp.score), `${label}: ${cp.key}.score ${detail}`).toBe(true);
      expect(cp.score, `${label}: ${cp.key}.score range ${detail}`).toBeGreaterThanOrEqual(-EPS);
      expect(cp.score, `${label}: ${cp.key}.score range ${detail}`).toBeLessThanOrEqual(100 + EPS);
    }
    expect(Number.isFinite(cp.severity), `${label}: ${cp.key}.severity ${detail}`).toBe(true);
    expect(Number.isFinite(cp.confidence), `${label}: ${cp.key}.confidence ${detail}`).toBe(true);
  }
}

describe("scoreShot — hostile measurement values", () => {
  const config = getShotScoringConfig("forehand_drive");

  it("(control) perfect measurements score finite 10.0 / normal", () => {
    const outcome = scoreShot(config, perfect());
    assertSane(outcome, "control");
    expect(outcome.overallScore).toBe(10);
    expect(outcome.presentation).toBe("normal");
  });

  it("a NaN metric VALUE must not yield a NaN overall score presented as 'normal'", () => {
    const measurements = perfect().map((x) =>
      x.metricKey === firstMetricKey() ? { ...x, value: NaN } : x,
    );
    assertSane(scoreShot(config, measurements), "NaN value");
  });

  it("an Infinity metric VALUE (zero-length segment ratio) stays finite", () => {
    const measurements = perfect().map((x) =>
      x.metricKey === firstMetricKey() ? { ...x, value: Infinity } : x,
    );
    assertSane(scoreShot(config, measurements), "Infinity value");
    const negative = perfect().map((x) =>
      x.metricKey === firstMetricKey() ? { ...x, value: -Infinity } : x,
    );
    assertSane(scoreShot(config, negative), "-Infinity value");
  });

  it("a NaN metric CONFIDENCE must not poison analysisConfidence / abstention gating", () => {
    const measurements = perfect().map((x) =>
      x.metricKey === firstMetricKey() ? { ...x, confidence: NaN } : x,
    );
    assertSane(scoreShot(config, measurements), "NaN confidence");
  });

  it("a NEGATIVE confidence must not push a checkpoint score outside 0–100 / overall outside 0–10", () => {
    // Two metrics in one checkpoint: one perfect with c=1, one terrible with
    // c=-0.9 → weightSum = 0.1·importance, weighted = 100·importance → 1000.
    const cp = config.checkpoints.find((c) => c.metrics.length >= 2);
    expect(cp, "need a checkpoint with ≥2 metrics").toBeDefined();
    const [good, bad] = cp!.metrics;
    const measurements = perfect(1).map((x) => {
      if (x.metricKey === good!.metricKey) return { ...x, confidence: 1 };
      if (x.metricKey === bad!.metricKey)
        return { ...x, value: bad!.upper + 50 * bad!.sigma, confidence: -0.9 };
      return x;
    });
    assertSane(scoreShot(config, measurements), "negative confidence");
  });

  it("confidence > 1 must not inflate analysisConfidence above 1 or scores above range", () => {
    const measurements = perfect(7);
    const outcome = scoreShot(config, measurements);
    assertSane(outcome, "confidence 7");
    expect(
      outcome.analysisConfidence,
      `analysisConfidence=${outcome.analysisConfidence}`,
    ).toBeLessThanOrEqual(1);
  });

  it("duplicate metric keys: last one wins deterministically and does not double-count", () => {
    const key = firstMetricKey();
    const base = perfect();
    const dupFirst = [...base, m(key, 1e6, 0.95)];
    const dupLast = [m(key, 1e6, 0.95), ...base];
    const a = scoreShot(config, dupFirst);
    const b = scoreShot(config, dupLast);
    assertSane(a, "dup-first");
    assertSane(b, "dup-last");
    // With the far-off value LAST the metric scores 0; with it FIRST the
    // perfect value overrides. Both are finite; both are recorded.
    expect(a.overallScore).not.toBeNull();
    expect(b.overallScore).toBe(10);
  });

  it("empty and unknown-only measurement sets abstain (never NaN)", () => {
    assertSane(scoreShot(config, []), "empty");
    expect(scoreShot(config, []).presentation).toBe("abstain");
    const unknown = [m("no_such_metric_\u{1F3D3}", 0.5), m("Ω_metric", 1)];
    assertSane(scoreShot(config, unknown), "unknown keys");
    expect(scoreShot(config, unknown).presentation).toBe("abstain");
  });
});
