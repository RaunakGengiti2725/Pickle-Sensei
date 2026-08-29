import { describe, expect, it } from "vitest";
import type { RightsProfile } from "../src/engine/rights.js";
import { gateEventForTraining, TRAINING_SPLITS } from "../src/trainingGate.js";

function rights(overrides: Partial<RightsProfile> = {}): RightsProfile {
  return {
    store: "yes",
    analyze: "yes",
    annotate: "yes",
    train: "yes",
    redistributeDerivatives: "yes",
    commercial: "yes",
    basis: "test fixture",
    reviewedBy: "test",
    reviewedAtIso: new Date().toISOString(),
    ...overrides,
  };
}

describe("gateEventForTraining", () => {
  it("only allows development-split events with fully cleared rights", () => {
    const gate = gateEventForTraining("development", rights());
    expect(gate.trainingEligible).toBe(true);
    expect(gate.quarantineReasons).toEqual([]);
  });

  it("quarantines every non-development split, including locked test, shadow, and coach holdout", () => {
    for (const split of [
      "held_out",
      "test_held_out",
      "shadow",
      "coach_holdout",
      "unassigned",
      "UNASSIGNED",
    ]) {
      const gate = gateEventForTraining(split, rights());
      expect(gate.trainingEligible).toBe(false);
      expect(gate.quarantineReasons.some((reason) => reason.includes(`split '${split}'`))).toBe(
        true,
      );
    }
  });

  it("quarantines events whose source has no resolvable rights record (unknown rights)", () => {
    const gate = gateEventForTraining("development", null);
    expect(gate.trainingEligible).toBe(false);
    expect(gate.quarantineReasons.some((reason) => reason.includes("unknown rights"))).toBe(true);
  });

  it("quarantines events whose rights lack training clearance — analysis permission never implies training", () => {
    const analysisOnly = rights({ train: "no" });
    const gate = gateEventForTraining("development", analysisOnly);
    expect(gate.trainingEligible).toBe(false);
    expect(gate.quarantineReasons.some((reason) => reason.includes("not training-eligible"))).toBe(
      true,
    );

    const unclear = rights({ train: "unclear" });
    expect(gateEventForTraining("development", unclear).trainingEligible).toBe(false);
  });

  it("a held-out event is quarantined even with fully cleared rights (holdout beats rights)", () => {
    const gate = gateEventForTraining("test_held_out", rights());
    expect(gate.trainingEligible).toBe(false);
  });

  it("training splits allow-list contains only development", () => {
    expect([...TRAINING_SPLITS]).toEqual(["development"]);
  });
});
