import { describe, expect, it } from "vitest";
import type { CheckpointKey } from "@pickle/shared-types";
import { getShotScoringConfig, selectPriorityFix } from "../src/index.js";
import type { CheckpointResultDetail } from "../src/index.js";

function result(key: CheckpointKey, score: number, confidence = 0.9): CheckpointResultDetail {
  return {
    key,
    score,
    confidence,
    severity: (100 - score) / 100,
    direction: "none",
    applicable: true,
    observed: true,
    metricDetails: [],
  };
}

describe("coaching priority engine", () => {
  const config = getShotScoringConfig("forehand_drive");

  it("reproduces the spec example: primary fix = Preparation, not Contact (spec p. 35)", () => {
    const results = [
      result("contact_position", 58),
      result("paddle_path", 63),
      result("preparation", 49),
    ];
    const fix = selectPriorityFix(config, results);
    expect(fix?.checkpoint).toBe("preparation");
    expect(fix?.reasonKey).toMatch(/root_cause_of:/);
  });

  it("promotes a faulty root cause over a worse-scoring downstream symptom", () => {
    // Contact scores worse than preparation, but preparation is materially
    // faulty and feeds both paddle_path and contact_position.
    const results = [
      result("contact_position", 52),
      result("paddle_path", 60),
      result("preparation", 62),
    ];
    const fix = selectPriorityFix(config, results);
    expect(fix?.checkpoint).toBe("preparation");
  });

  it("picks the symptom when upstream checkpoints are healthy", () => {
    const results = [
      result("contact_position", 55),
      result("paddle_path", 92),
      result("preparation", 95),
    ];
    const fix = selectPriorityFix(config, results);
    expect(fix?.checkpoint).toBe("contact_position");
    expect(fix?.reasonKey).toBe("highest_weighted_priority");
  });

  it("returns null when nothing is severe enough to coach", () => {
    const results = [result("contact_position", 95), result("preparation", 93)];
    expect(selectPriorityFix(config, results)).toBeNull();
  });

  it("ignores unobserved checkpoints entirely", () => {
    const unobserved: CheckpointResultDetail = {
      key: "paddle_path",
      score: null,
      confidence: 0,
      severity: 0,
      direction: "none",
      applicable: true,
      observed: false,
      metricDetails: [],
    };
    const fix = selectPriorityFix(config, [unobserved, result("athletic_base", 60)]);
    expect(fix?.checkpoint).toBe("athletic_base");
  });

  it("applies session-focus stickiness", () => {
    // Two comparable faults; the focus one wins.
    const results = [result("paddle_set", 68), result("swing_length", 66)];
    const fix = selectPriorityFix(config, results, { focusCheckpoint: "paddle_set" });
    expect(fix?.checkpoint).toBe("paddle_set");
  });

  it("respects goal relevance", () => {
    const results = [result("athletic_base", 70), result("follow_through", 65)];
    const fix = selectPriorityFix(config, results, {
      goalRelevance: { athletic_base: 2.0, follow_through: 0.5 },
    });
    expect(fix?.checkpoint).toBe("athletic_base");
  });
});
