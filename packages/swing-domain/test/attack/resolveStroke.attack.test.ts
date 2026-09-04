/**
 * Adversarial pass 3 / tester #4 — resolveStroke threshold inclusivity.
 *
 * `resolveStroke` compares `predicted.confidence >= predictionConfidenceThreshold`
 * (capture.ts). The fusion engine passes PREDICTION_CONFIDENCE_THRESHOLD = 0.8.
 * Attack the boundary at exactly 0.8, 0.7999999, the nearest representable
 * double below 0.8, and pathological confidences (NaN, Infinity, negative).
 */
import { describe, expect, it } from "vitest";
import { resolveStroke, type StrokeIdentity, type StrokePrediction } from "../../src/index.js";

const THRESHOLD = 0.8;

function prediction(
  confidence: number,
  shotType: StrokePrediction["shotType"] = "dink",
): StrokePrediction {
  return {
    shotType,
    confidence,
    alternatives: [],
    producedBy: {
      providerId: "stroke.attack",
      modelVersion: "attack-1",
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
    },
  };
}

const identity = (
  confidence: number,
  declared: StrokeIdentity["declared"] = "forehand_drive",
): StrokeIdentity => ({
  declared,
  predicted: prediction(confidence),
});

describe("[attack] resolveStroke — threshold inclusivity at 0.8", () => {
  it("confidence exactly 0.8 is INCLUSIVE: the prediction wins over the declaration", () => {
    const resolution = resolveStroke(identity(0.8), { predictionConfidenceThreshold: THRESHOLD });
    expect(resolution).toEqual({ kind: "predicted", shotType: "dink", confidence: 0.8 });
  });

  it("confidence 0.7999999 falls back to the declaration", () => {
    const resolution = resolveStroke(identity(0.7999999), {
      predictionConfidenceThreshold: THRESHOLD,
    });
    expect(resolution).toEqual({ kind: "declared", shotType: "forehand_drive" });
  });

  it("the nearest double below 0.8 (0.8 - Number.EPSILON) falls back; 0.8 + EPSILON wins", () => {
    const justBelow = 0.8 - Number.EPSILON;
    const justAbove = 0.8 + Number.EPSILON;
    expect(justBelow).toBeLessThan(0.8);
    expect(
      resolveStroke(identity(justBelow), { predictionConfidenceThreshold: THRESHOLD }).kind,
    ).toBe("declared");
    expect(
      resolveStroke(identity(justAbove), { predictionConfidenceThreshold: THRESHOLD }).kind,
    ).toBe("predicted");
  });

  it("0.7999999 with no declaration is honestly unresolved with the 'not confident enough' reason", () => {
    const resolution = resolveStroke(identity(0.7999999, null), {
      predictionConfidenceThreshold: THRESHOLD,
    });
    expect(resolution.kind).toBe("unresolved");
    if (resolution.kind !== "unresolved") return;
    expect(resolution.reason).toMatch(/not confident enough/);
  });

  it("NaN confidence never wins (NaN >= 0.8 is false) and falls back to declaration", () => {
    const resolution = resolveStroke(identity(Number.NaN), {
      predictionConfidenceThreshold: THRESHOLD,
    });
    expect(resolution.kind).toBe("declared");
  });

  it("out-of-range confidence (Infinity) never throws and resolves identically on repeat", () => {
    const first = resolveStroke(identity(Number.POSITIVE_INFINITY), {
      predictionConfidenceThreshold: THRESHOLD,
    });
    const second = resolveStroke(identity(Number.POSITIVE_INFINITY), {
      predictionConfidenceThreshold: THRESHOLD,
    });
    expect(second).toEqual(first);
    // resolveStroke performs only the lower-bound comparison; range validation
    // of classifier output is the classifier contract's job, so >1 is accepted.
    expect(first.kind).toBe("predicted");
  });

  it("'unknown' prediction at 1.0 confidence never wins", () => {
    const resolution = resolveStroke(
      { declared: "serve", predicted: prediction(1, "unknown") },
      { predictionConfidenceThreshold: THRESHOLD },
    );
    expect(resolution).toEqual({ kind: "declared", shotType: "serve" });
  });

  it("threshold itself NaN: nothing ever resolves as predicted (documents comparison semantics)", () => {
    const resolution = resolveStroke(identity(0.99), { predictionConfidenceThreshold: Number.NaN });
    expect(resolution.kind).toBe("declared");
  });
});
