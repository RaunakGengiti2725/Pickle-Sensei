import { describe, expect, it } from "vitest";
import { cohenKappa, computePairKappas, primaryFaultLabelExtractor, strokeLabelExtractor } from "../kappa";
import { syntheticAgreeingPair, syntheticCannotEvaluate, syntheticDisagreeingPair } from "../syntheticFixtures";
import type { CoachReview } from "../types";

describe("cohenKappa", () => {
  it("returns nulls for <2 label pairs — never fabricated", () => {
    expect(cohenKappa([])).toEqual({ observedAgreement: null, expectedAgreement: null, kappa: null });
    expect(cohenKappa([["A", "A"]])).toEqual({ observedAgreement: null, expectedAgreement: null, kappa: null });
  });

  it("returns kappa null (undefined) when there is no label variation", () => {
    const result = cohenKappa([
      ["A", "A"],
      ["A", "A"],
    ]);
    expect(result.observedAgreement).toBe(1);
    expect(result.expectedAgreement).toBe(1);
    expect(result.kappa).toBeNull();
  });

  it("computes the textbook value on a 2x2 example", () => {
    // 20 items: agree on 10 A-A and 5 B-B, disagree on 5 (A,B): po=0.75
    const pairs: Array<[string, string]> = [
      ...Array.from({ length: 10 }, (): [string, string] => ["A", "A"]),
      ...Array.from({ length: 5 }, (): [string, string] => ["B", "B"]),
      ...Array.from({ length: 5 }, (): [string, string] => ["A", "B"]),
    ];
    const { observedAgreement, expectedAgreement, kappa } = cohenKappa(pairs);
    expect(observedAgreement).toBeCloseTo(0.75, 10);
    // marginals: rater1 A=15/20 B=5/20; rater2 A=10/20 B=10/20 → pe=0.375+0.125=0.5
    expect(expectedAgreement).toBeCloseTo(0.5, 10);
    expect(kappa).toBeCloseTo(0.5, 10);
  });

  it("is negative when observed agreement is below chance", () => {
    const { kappa } = cohenKappa([
      ["A", "B"],
      ["B", "A"],
    ]);
    expect(kappa).not.toBeNull();
    expect(kappa!).toBeLessThan(0);
  });
});

describe("computePairKappas", () => {
  const reviews: CoachReview[] = [...syntheticAgreeingPair(), ...syntheticDisagreeingPair()];

  it("pairs coaches across items and reports shared-item counts", () => {
    const pairs = computePairKappas(reviews, strokeLabelExtractor);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.coachA).toBe("SYNTHETIC-COACH-A");
    expect(pairs[0]!.coachB).toBe("SYNTHETIC-COACH-B");
    expect(pairs[0]!.sharedItems).toBe(2);
    // agree on wm-dink-01 stroke, disagree on afn-vic-rally1 → po = 0.5
    expect(pairs[0]!.observedAgreement).toBeCloseTo(0.5, 10);
  });

  it("excludes cannot-evaluate reviews from every pair", () => {
    const pairs = computePairKappas([...reviews, syntheticCannotEvaluate()], strokeLabelExtractor);
    expect(pairs.every((pair) => pair.coachA !== "SYNTHETIC-COACH-C" && pair.coachB !== "SYNTHETIC-COACH-C")).toBe(true);
  });

  it("labels zero-fault evaluable reviews CLEAN for the primary-fault kappa", () => {
    const [reviewA] = syntheticAgreeingPair();
    expect(primaryFaultLabelExtractor({ ...reviewA!, faults: [] })).toBe("CLEAN");
    expect(primaryFaultLabelExtractor(reviewA!)).toBe("dink.wristy_flick");
  });
});
