import { describe, expect, it } from "vitest";
import { isBlindInProgress } from "../blind";
import { latestReviewVersions } from "../data";
import { cohenKappa, computePairKappas, strokeLabelExtractor } from "../kappa";
import { validateAdjudication, type AdjudicationRecord, type ReviewAmendment } from "../records";
import { syntheticAgreeingPair } from "../syntheticFixtures";
import { validateReview, type ValidationContext } from "../validate";
import type { CoachReview, LoadedReview } from "../types";

/**
 * D3-09 red-team regression tests. Each block pins a break found against the
 * portal's data layer:
 *  - non-finite numbers (NaN/Infinity) slipping through range checks;
 *  - adjudications citing duplicated or cross-item reviewedReviewIds;
 *  - agreement/kappa consumers using superseded revision-1 reviews;
 *  - degenerate kappa inputs (n=1, all-same labels).
 * All fixtures are SYNTHETIC (never persisted).
 */

const context: ValidationContext = {
  knownQueueItemIds: ["wm-dink-01-E1", "wm-volley-02-E1"],
  knownFaultIds: ["dink.wristy_flick", "global.no_recovery_to_ready"],
  knownDrillIds: ["drill.wall-dink-rally"],
  strokeTaxonomyVersion: "pickleball-stroke-taxonomy-v3",
  strokeLabels: ["BACKHAND_DINK", "FOREHAND_DRIVE"],
  faultTaxonomyVersion: "fault-taxonomy-v0-draft",
  qualityScaleId: "technique-quality-5pt-v1",
};

function review(coachId: string): CoachReview {
  const [fixture] = syntheticAgreeingPair();
  return {
    ...fixture!,
    coachId,
    coachCredentialRef: `cred-${coachId}`,
    reviewId: `wm-dink-01-E1.${coachId}`,
    provenance: {
      ...fixture!.provenance,
      coachQualificationSnapshot: {
        ...fixture!.provenance.coachQualificationSnapshot,
        coachId,
        credentialRef: `cred-${coachId}`,
      },
    },
  };
}

describe("validateReview rejects non-finite numbers", () => {
  it("rejects NaN and Infinity confidence (JSON cannot carry them, JS callers can)", () => {
    expect(validateReview({ ...review("coach-01"), confidence: NaN }, context)).toContain(
      "confidence must be 0..1",
    );
    expect(validateReview({ ...review("coach-01"), confidence: Infinity }, context)).toContain(
      "confidence must be 0..1",
    );
  });

  it("rejects NaN region coordinates", () => {
    const bad = review("coach-01");
    bad.faults = [
      {
        ...bad.faults[0]!,
        evidence: { timestampsMs: [100], frames: [], region: { x: NaN, y: 0, w: 0.5, h: 0.5 } },
      },
    ];
    expect(validateReview(bad, context)).toContain(
      "faults[0].evidence.region must be normalized 0..1 {x,y,w,h}",
    );
  });
});

describe("validateAdjudication integrity", () => {
  const adjudication: AdjudicationRecord = {
    schemaVersion: 1,
    queueItemId: "wm-dink-01-E1",
    adjudicatorId: "coach-03",
    adjudicatorCredentialRef: "cred-coach-03",
    reviewedReviewIds: ["wm-dink-01-E1.coach-01", "wm-dink-01-E1.coach-02"],
    outcome: { kind: "uphold", reviewId: "wm-dink-01-E1.coach-01" },
    rationale: "long enough rationale for the twenty character gate",
    evidenceTimestampsMs: [],
    createdAtIso: "2026-08-29T00:00:00.000Z",
  };
  const reviewerCoachIdsByReviewId = {
    "wm-dink-01-E1.coach-01": "coach-01",
    "wm-dink-01-E1.coach-02": "coach-02",
    "wm-volley-02-E1.coach-01": "coach-01",
  };
  const reviewQueueItemIdsByReviewId = {
    "wm-dink-01-E1.coach-01": "wm-dink-01-E1",
    "wm-dink-01-E1.coach-02": "wm-dink-01-E1",
    "wm-volley-02-E1.coach-01": "wm-volley-02-E1",
  };

  it("accepts a well-formed two-review adjudication", () => {
    expect(
      validateAdjudication(adjudication, {
        ...context,
        reviewerCoachIdsByReviewId,
        reviewQueueItemIdsByReviewId,
      }),
    ).toEqual([]);
  });

  it("rejects the same reviewId listed twice as if it were two reviews", () => {
    const problems = validateAdjudication(
      {
        ...adjudication,
        reviewedReviewIds: ["wm-dink-01-E1.coach-01", "wm-dink-01-E1.coach-01"],
      },
      { ...context, reviewerCoachIdsByReviewId, reviewQueueItemIdsByReviewId },
    );
    expect(problems.some((p) => p.includes("DISTINCT"))).toBe(true);
  });

  it("rejects a reviewedReviewId belonging to a different queue item", () => {
    const problems = validateAdjudication(
      {
        ...adjudication,
        reviewedReviewIds: ["wm-dink-01-E1.coach-01", "wm-volley-02-E1.coach-01"],
      },
      { ...context, reviewerCoachIdsByReviewId, reviewQueueItemIdsByReviewId },
    );
    expect(problems.some((p) => p.includes("not the adjudicated item"))).toBe(true);
  });
});

describe("latestReviewVersions (amendment-aware agreement inputs)", () => {
  it("resolves each review to its latest amendment revision", () => {
    const original = review("coach-01");
    const loaded: LoadedReview[] = [
      { review: original, source: "datasets/coach-review/reviews/a.json", synthetic: false },
    ];
    const amendment: ReviewAmendment = {
      schemaVersion: 1,
      amendmentId: `${original.reviewId}.r2`,
      reviewId: original.reviewId,
      revision: 2,
      reason: "rewatched at quarter speed",
      review: { ...original, confidence: 0.95 },
      createdAtIso: "2026-08-29T00:00:00.000Z",
    };
    const resolved = latestReviewVersions(loaded, [amendment]);
    expect(resolved[0]!.review.confidence).toBe(0.95);
    expect(resolved[0]!.synthetic).toBe(false);
    expect(latestReviewVersions(loaded, [])[0]!.review).toEqual(original);
  });
});

describe("isBlindInProgress (agreement-surface leakage gate)", () => {
  it("is in progress only while some but not all real reviews exist", () => {
    expect(isBlindInProgress(2, 0)).toBe(false);
    expect(isBlindInProgress(2, 1)).toBe(true);
    expect(isBlindInProgress(2, 2)).toBe(false);
    expect(isBlindInProgress(3, 2)).toBe(true);
  });
});

describe("kappa degenerate inputs", () => {
  it("is null with a single shared item (n=1)", () => {
    expect(cohenKappa([["A", "A"]])).toEqual({
      observedAgreement: null,
      expectedAgreement: null,
      kappa: null,
    });
  });

  it("is null when both coaches use one label everywhere (no variation)", () => {
    const result = cohenKappa([
      ["A", "A"],
      ["A", "A"],
      ["A", "A"],
    ]);
    expect(result.observedAgreement).toBe(1);
    expect(result.expectedAgreement).toBe(1);
    expect(result.kappa).toBeNull();
  });

  it("computePairKappas surfaces the null instead of fabricating a number", () => {
    const a1 = review("coach-01");
    const b1 = review("coach-02");
    const pairs = computePairKappas([a1, b1], strokeLabelExtractor);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.sharedItems).toBe(1);
    expect(pairs[0]!.kappa).toBeNull();
  });
});
