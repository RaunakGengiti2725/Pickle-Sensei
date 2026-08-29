import { describe, expect, it } from "vitest";
import { resolveStroke, type StrokeIdentity } from "../src/index.js";

const CLASSIFIER = {
  providerId: "classifier.none-yet",
  modelVersion: "0",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

const OPTIONS = { predictionConfidenceThreshold: 0.8 };

describe("declared vs predicted stroke resolution", () => {
  it("prefers a confident model prediction over the declaration", () => {
    const identity: StrokeIdentity = {
      declared: "dink",
      predicted: {
        shotType: "forehand_drive",
        confidence: 0.93,
        alternatives: [],
        producedBy: CLASSIFIER,
      },
    };
    expect(resolveStroke(identity, OPTIONS)).toEqual({
      kind: "predicted",
      shotType: "forehand_drive",
      confidence: 0.93,
    });
  });

  it("falls back to the declaration when the prediction is weak or unknown", () => {
    const weak: StrokeIdentity = {
      declared: "serve",
      predicted: {
        shotType: "forehand_drive",
        confidence: 0.4,
        alternatives: [],
        producedBy: CLASSIFIER,
      },
    };
    expect(resolveStroke(weak, OPTIONS)).toEqual({ kind: "declared", shotType: "serve" });

    const unknown: StrokeIdentity = {
      declared: "serve",
      predicted: {
        shotType: "unknown",
        confidence: 0.99,
        alternatives: [],
        producedBy: CLASSIFIER,
      },
    };
    expect(resolveStroke(unknown, OPTIONS)).toEqual({ kind: "declared", shotType: "serve" });
  });

  it("is honestly unresolved with neither declaration nor confident prediction", () => {
    const nothing = resolveStroke({ declared: null, predicted: null }, OPTIONS);
    expect(nothing.kind).toBe("unresolved");
  });
});
