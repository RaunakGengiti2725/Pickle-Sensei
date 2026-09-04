import { beforeAll, describe, expect, it } from "vitest";
import type { Measurement } from "@pickle/shared-types";
import { ok } from "@pickle/shared-types";
import type { VideoClipRef, VisionProviderSet } from "@pickle/vision-contracts";
import { getShotScoringConfig, scoreShot } from "@pickle/scoring";
import { createFixtureVisionProviderSet } from "../../vision-contracts/test/support/fixtureProvider.js";
import { analyzeClip } from "../src/index.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #1 — scoring stage under corrupt measurements.
 * The scoring engine is "pure and deterministic" (scoring/src/engine.ts L11);
 * analyzeClip feeds it whatever the feature extractor returns with no
 * validation in between (analyzeClip.ts L62-L72). A vision layer that emits a
 * single NaN (0/0 from a degenerate pose — e.g. two coincident joints when
 * normalising by a zero-length segment) is the realistic partial failure.
 * The ONE production extractor (vision-geometry/src/featureExtractor.ts
 * `add()` L115-L127) drops non-finite values and clamps confidence to 0..1, so
 * these are defense-in-depth gaps of the engine itself (a second extractor or
 * a learned one behind the same contract would not be protected), not a
 * reachable P1 on the current geometry path.
 *
 * Same convention as the sibling attack files: HELD asserts the contract,
 * GAP/BROKEN pins the observed deviation and logs it.
 */

const clip: VideoClipRef = {
  uri: "fixture://forehand-demo",
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

const options = {
  analysisId: "3b9f2b60-1111-4222-8333-444455556666",
  sessionId: null,
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
  appVersion: "0.1.0",
  modelBundleVersion: "fixture-1",
  capturedAtIso: "2026-08-26T18:00:00.000Z",
};

beforeAll(() => {
  process.env["PICKLE_ENV"] = "development";
});

function m(metricKey: string, value: number, confidence = 0.95): Measurement {
  return { metricKey, value, confidence, unit: "normalized", source: "fixture" };
}

function perfectMeasurements(confidence = 0.95): Measurement[] {
  const config = getShotScoringConfig("forehand_drive");
  const out: Measurement[] = [];
  for (const cp of config.checkpoints) {
    for (const t of cp.metrics) out.push(m(t.metricKey, (t.lower + t.upper) / 2, confidence));
  }
  return out;
}

/** Fixture providers with the feature extractor replaced by a corruptor. */
function providersWithMeasurements(
  mutate: (measurements: Measurement[]) => Measurement[],
): VisionProviderSet {
  const base = createFixtureVisionProviderSet("forehand_drive");
  return {
    ...base,
    features: {
      ...base.features,
      async extractMeasurements(input) {
        const real = await base.features.extractMeasurements(input);
        if (!real.ok) return real;
        return ok(mutate(real.value));
      },
    },
  };
}

describe("ATTACK (own) — scoring engine over corrupt measurements", () => {
  it("GAP (P3, pre-existing, defense-in-depth — the only production extractor filters non-finite values at vision-geometry/src/featureExtractor.ts L120): ONE NaN measurement value poisons the whole shot — presentation 'normal', overallScore NaN, the owning checkpoint scores NaN with band 'red' (bandFor(NaN))", () => {
    const config = getShotScoringConfig("forehand_drive");
    const measurements = perfectMeasurements();
    measurements[0] = { ...measurements[0]!, value: NaN };
    const outcome = scoreShot(config, measurements);
    const poisoned = outcome.checkpointResults.filter((r) => Number.isNaN(r.score));
    console.log(
      JSON.stringify({
        scenario: "scoring-one-nan-value",
        overallScore: outcome.overallScore,
        overallIsNaN: Number.isNaN(outcome.overallScore),
        presentation: outcome.presentation,
        analysisConfidence: outcome.analysisConfidence,
        poisonedCheckpoints: poisoned.map((r) => r.key),
        bands: outcome.checkpoints.map((c) => [c.key, c.band, c.score]),
        guidance: outcome.guidance,
      }),
    );
    // CONTRACT (engine doc L11-L14: "0–10, one decimal; null when the engine
    // abstains"; ShotAnalysis.overallScore is number|null): a value that
    // cannot be scored must abstain or be excluded, never produce NaN.
    // OBSERVED (pinned): NaN flows q → checkpoint score → overallScore; the
    // presentation stays "normal" (NaN < threshold is false), the checkpoint
    // that owns the metric reports score NaN with band "red" (NaN >= 80 and
    // NaN >= 65 are both false → "red") and severity NaN.
    expect(outcome.presentation).toBe("normal");
    expect(Number.isNaN(outcome.overallScore)).toBe(true);
    expect(poisoned).toHaveLength(1);
    const poisonedView = outcome.checkpoints.find((c) => c.key === poisoned[0]!.key)!;
    expect(poisonedView.band).toBe("red");
    expect(Number.isNaN(poisonedView.severity)).toBe(true);
  });

  it("HELD: a NaN measurement CONFIDENCE degrades safely — the owning checkpoint becomes unobserved (weightSum > 0 is false for NaN), its confidence counts as 0, the abstention gate still fires", () => {
    const config = getShotScoringConfig("forehand_drive");
    const measurements = perfectMeasurements(0.2); // abstains (0.2 < 0.65)
    const control = scoreShot(config, measurements);
    measurements[0] = { ...measurements[0]!, confidence: NaN };
    const attacked = scoreShot(config, measurements);
    const highConfidence = perfectMeasurements(0.95);
    highConfidence[0] = { ...highConfidence[0]!, confidence: NaN };
    const highAttacked = scoreShot(config, highConfidence);
    console.log(
      JSON.stringify({
        scenario: "scoring-nan-confidence",
        control: { presentation: control.presentation, confidence: control.analysisConfidence },
        attacked: {
          presentation: attacked.presentation,
          confidence: attacked.analysisConfidence,
          overallScore: attacked.overallScore,
        },
        highAttacked: {
          presentation: highAttacked.presentation,
          confidence: highAttacked.analysisConfidence,
          overallScore: highAttacked.overallScore,
          unobserved: highAttacked.checkpointResults.filter((r) => !r.observed).map((r) => r.key),
        },
      }),
    );
    expect(control.presentation).toBe("abstain");
    expect(attacked.presentation).toBe("abstain");
    expect(attacked.analysisConfidence).toBeLessThan(control.analysisConfidence);
    expect(attacked.overallScore).toBeNull();
    expect(Number.isNaN(attacked.analysisConfidence)).toBe(false);
    // With otherwise-confident metrics the shot is still scored, the poisoned
    // checkpoint is simply unobserved — finite everywhere.
    expect(highAttacked.presentation).toBe("normal");
    expect(Number.isFinite(highAttacked.overallScore ?? NaN)).toBe(true);
    expect(highAttacked.checkpointResults.filter((r) => !r.observed)).toHaveLength(1);
  });

  it("GAP (P3, pre-existing, defense-in-depth — featureExtractor.ts L124 clamps confidence to 0..1): ±Infinity values and out-of-range confidences (>1, <0) are accepted — confidence 50 on one metric alone lifts a low-confidence shot past the abstention gate", () => {
    const config = getShotScoringConfig("forehand_drive");
    const infinite = perfectMeasurements();
    infinite[0] = { ...infinite[0]!, value: Infinity };
    infinite[1] = { ...infinite[1]!, value: -Infinity };
    const infOutcome = scoreShot(config, infinite);

    const lowConfidence = perfectMeasurements(0.2);
    const control = scoreShot(config, lowConfidence);
    lowConfidence[0] = { ...lowConfidence[0]!, confidence: 50 };
    const inflated = scoreShot(config, lowConfidence);

    const negative = perfectMeasurements(0.95);
    negative[0] = { ...negative[0]!, confidence: -5 };
    const negOutcome = scoreShot(config, negative);
    console.log(
      JSON.stringify({
        scenario: "scoring-infinity-and-confidence-range",
        infinity: {
          presentation: infOutcome.presentation,
          overallScore: infOutcome.overallScore,
          qs: infOutcome.checkpointResults
            .flatMap((r) => r.metricDetails.map((d) => d.q))
            .slice(0, 4),
        },
        control: { presentation: control.presentation, confidence: control.analysisConfidence },
        inflated: {
          presentation: inflated.presentation,
          confidence: inflated.analysisConfidence,
          overallScore: inflated.overallScore,
        },
        negative: {
          presentation: negOutcome.presentation,
          confidence: negOutcome.analysisConfidence,
          overallScore: negOutcome.overallScore,
          checkpointScores: negOutcome.checkpointResults.map((r) => r.score),
        },
      }),
    );
    // Infinity is at least numerically safe: q = 100·exp(−∞) = 0 → a hard
    // fault, scored normally. Pinned as HELD-ish behaviour.
    expect(infOutcome.presentation).toBe("normal");
    expect(Number.isFinite(infOutcome.overallScore ?? NaN)).toBe(true);
    // OBSERVED (pinned): a single confidence of 50 (spec range 0..1) on ONE
    // metric turns an abstaining shot into a normally presented one.
    expect(control.presentation).toBe("abstain");
    expect(inflated.presentation).toBe("normal");
    expect(inflated.analysisConfidence).toBeGreaterThan(1);
    // OBSERVED (pinned): negative confidence is accepted; the owning
    // checkpoint's weightSum can go ≤ 0 so it flips to "unobserved" (score
    // null) or, with other metrics, to a negative weighted mean.
    expect(
      negOutcome.checkpointResults.some((r) => r.score === null || r.score < 0 || r.score > 100),
    ).toBe(true);
  });

  it("HELD: duplicate metricKeys — last measurement wins deterministically; unknown metricKeys are ignored; an empty measurement list abstains", () => {
    const config = getShotScoringConfig("forehand_drive");
    const dupes = [...perfectMeasurements(), m(perfectMeasurements()[0]!.metricKey, 1e9, 0.99)];
    const dupesOutcome = scoreShot(config, dupes);
    expect(dupesOutcome.presentation).toBe("normal");
    expect(dupesOutcome.overallScore).toBeLessThan(10);
    const unknown = scoreShot(config, [
      ...perfectMeasurements(),
      m("🎾 not_a_metric", 1),
      m("", 1),
      m("a".repeat(100_000), 1),
    ]);
    expect(unknown.overallScore).toBe(10);
    const empty = scoreShot(config, []);
    expect(empty.presentation).toBe("abstain");
    expect(empty.overallScore).toBeNull();
    expect(empty.analysisConfidence).toBe(0);
  });
});

describe("ATTACK (own) — analyzeClip persists the poisoned outcome", () => {
  it("GAP (P3, pre-existing, defense-in-depth): a feature extractor emitting one NaN yields a 'scored' ShotAnalysis with overallScore NaN (serialises to null in JSON — indistinguishable from an abstention downstream, but resultKind says 'scored')", async () => {
    const providers = providersWithMeasurements((measurements) =>
      measurements.map((entry, index) => (index === 3 ? { ...entry, value: NaN } : entry)),
    );
    const result = await analyzeClip(providers, clip, options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const analysis = result.value;
    const json = JSON.parse(JSON.stringify(analysis)) as {
      overallScore: number | null;
      resultKind: string;
      checkpoints: Array<{
        key: string;
        score: number | null;
        band: string;
        severity: number | null;
      }>;
    };
    console.log(
      JSON.stringify({
        scenario: "analyzeClip-nan-measurement",
        resultKind: analysis.resultKind,
        overallScoreIsNaN: Number.isNaN(analysis.overallScore),
        analysisConfidence: analysis.analysisConfidence,
        priorityFix: analysis.priorityFix?.checkpoint ?? null,
        jsonOverallScore: json.overallScore,
        jsonCheckpoints: json.checkpoints.filter((c) => c.score === null || c.severity === null),
      }),
    );
    // CONTRACT: resultKind 'scored' ⇔ overallScore is a number in 0..10;
    // 'low_confidence' ⇔ overallScore null. OBSERVED (pinned): 'scored' with
    // NaN, which JSON (SQLite kv / sync payload) turns into null — a "scored"
    // shot with no score, and a checkpoint with band 'red' and score null.
    expect(analysis.resultKind).toBe("scored");
    expect(Number.isNaN(analysis.overallScore)).toBe(true);
    expect(json.overallScore).toBeNull();
    expect(json.checkpoints.some((c) => c.score === null && c.band === "red")).toBe(true);
  });

  it("HELD: an extractor that drops every measurement (partial failure, empty list) leads to an honest abstention — resultKind 'low_confidence', overallScore null, guidance present", async () => {
    const providers = providersWithMeasurements(() => []);
    const result = await analyzeClip(providers, clip, options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resultKind).toBe("low_confidence");
    expect(result.value.overallScore).toBeNull();
    expect(result.value.priorityFix).toBeNull();
    expect(result.value.guidance).toMatch(/Couldn't read this stroke clearly/);
    expect(result.value.checkpoints.every((c) => c.band === "unscored")).toBe(true);
  });
});
