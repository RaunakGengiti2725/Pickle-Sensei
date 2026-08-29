import { describe, expect, it } from "vitest";
import { computeAllAgreements, computeItemAgreement } from "../agreement";
import {
  syntheticAgreeingPair,
  syntheticCannotEvaluate,
  syntheticDisagreeingPair,
} from "../syntheticFixtures";
import type { CoachReview } from "../types";

/**
 * Agreement computation on SYNTHETIC fixtures (coachIds all "SYNTHETIC-*",
 * never persisted, see syntheticFixtures.ts). Real review count is 0, so the
 * awaiting_reviews branch is the production-truth path.
 */

describe("computeItemAgreement", () => {
  it("reports awaiting_reviews with all metrics null when 0 reviews exist (today's real state)", () => {
    const result = computeItemAgreement("wm-dink-01-E1", 2, []);
    expect(result.status).toBe("awaiting_reviews");
    expect(result.reviewCount).toBe(0);
    expect(result.stroke.rate).toBeNull();
    expect(result.rating.exactMatchRate).toBeNull();
    expect(result.primaryFault.rate).toBeNull();
    expect(result.severity.exactRate).toBeNull();
    expect(result.faultOverlap.meanJaccard).toBeNull();
    expect(result.adjudication.required).toBe(false);
  });

  it("reports awaiting_reviews with a single review (target is ≥2)", () => {
    const [first] = syntheticAgreeingPair();
    const result = computeItemAgreement("wm-dink-01-E1", 2, [first!]);
    expect(result.status).toBe("awaiting_reviews");
    expect(result.reviewCount).toBe(1);
    expect(result.stroke.rate).toBeNull();
  });

  it("computes agreement for an agreeing pair", () => {
    const result = computeItemAgreement("wm-dink-01-E1", 2, syntheticAgreeingPair());
    expect(result.status).toBe("computed");
    expect(result.stroke.comparablePairs).toBe(1);
    expect(result.stroke.rate).toBe(1);
    expect(result.rating.exactMatchRate).toBe(1);
    expect(result.rating.meanAbsDiff).toBe(0);
    // Both coaches' max-severity fault is dink.wristy_flick.
    expect(result.primaryFault.rate).toBe(1);
    // Shared fault dink.wristy_flick: severity 2 vs 3.
    expect(result.severity.sharedFaultComparisons).toBe(1);
    expect(result.severity.exactRate).toBe(0);
    expect(result.severity.meanAbsDiff).toBe(1);
    // Sets {wristy_flick, no_recovery} vs {wristy_flick} → Jaccard 1/2.
    expect(result.faultOverlap.meanJaccard).toBeCloseTo(0.5);
    expect(result.adjudication.required).toBe(false);
  });

  it("flags adjudication for a disagreeing pair (stroke mismatch, rating gap ≥2, primary-fault mismatch)", () => {
    const result = computeItemAgreement("afn-vic-rally1-E1", 2, syntheticDisagreeingPair());
    expect(result.status).toBe("computed");
    expect(result.stroke.rate).toBe(0);
    expect(result.rating.meanAbsDiff).toBe(2);
    expect(result.primaryFault.rate).toBe(0);
    expect(result.adjudication.required).toBe(true);
    expect(result.adjudication.reasons.join(" ")).toMatch(/stroke mismatch/);
    expect(result.adjudication.reasons.join(" ")).toMatch(/rating gap/);
    expect(result.adjudication.reasons.join(" ")).toMatch(/primary fault mismatch/);
  });

  it("excludes cannotEvaluate reviews from metrics but counts them", () => {
    const pair = syntheticAgreeingPair();
    const declined: CoachReview = {
      ...syntheticCannotEvaluate(),
      reviewId: "wm-dink-01-E1.SYNTHETIC-COACH-C",
      queueItemId: "wm-dink-01-E1",
      eventRef: { caseId: "wm-dink-01", eventIndex: 0 },
    };
    const result = computeItemAgreement("wm-dink-01-E1", 2, [...pair, declined]);
    expect(result.reviewCount).toBe(3);
    expect(result.evaluableCount).toBe(2);
    expect(result.cannotEvaluateCount).toBe(1);
    // Metrics identical to the pure agreeing pair (declined excluded).
    expect(result.stroke.comparablePairs).toBe(1);
    expect(result.stroke.rate).toBe(1);
  });

  it("treats two clean evaluable reviews (no faults) as primary-fault agreement", () => {
    const [a, b] = syntheticAgreeingPair();
    const cleanA: CoachReview = { ...a!, faults: [] };
    const cleanB: CoachReview = { ...b!, faults: [] };
    const result = computeItemAgreement("wm-dink-01-E1", 2, [cleanA, cleanB]);
    expect(result.primaryFault.rate).toBe(1);
    // Empty vs empty fault sets → Jaccard defined as 1 (both say clean).
    expect(result.faultOverlap.meanJaccard).toBe(1);
    expect(result.adjudication.required).toBe(false);
  });

  it("ignores reviews for other queue items", () => {
    const result = computeItemAgreement("wm-dink-01-E1", 2, syntheticDisagreeingPair());
    expect(result.reviewCount).toBe(0);
    expect(result.status).toBe("awaiting_reviews");
  });
});

describe("computeAllAgreements", () => {
  it("maps each queue item and preserves the awaiting state for unreviewed items", () => {
    const items = [
      { queueItemId: "wm-dink-01-E1", requiredReviewsTarget: 2 },
      { queueItemId: "afn-vic-rally1-E1", requiredReviewsTarget: 2 },
      { queueItemId: "afn-sasebo-rally2-E1", requiredReviewsTarget: 2 },
    ];
    const reviews = [...syntheticAgreeingPair(), ...syntheticDisagreeingPair()];
    const results = computeAllAgreements(items, reviews);
    expect(results).toHaveLength(3);
    expect(results[0]!.status).toBe("computed");
    expect(results[1]!.status).toBe("computed");
    expect(results[1]!.adjudication.required).toBe(true);
    expect(results[2]!.status).toBe("awaiting_reviews");
  });
});
