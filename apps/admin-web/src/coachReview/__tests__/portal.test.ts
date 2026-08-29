import { describe, expect, it } from "vitest";
import { canSeeOtherReviews } from "../blind";
import { buildAdjudicatedExport, currentReviewVersion } from "../data";
import { amendmentIdFor, type AdjudicationRecord, type ReviewAmendment } from "../records";
import { primaryFaultIndex } from "../ReviewForm";
import { syntheticAgreeingPair } from "../syntheticFixtures";
import type { CoachReview, LoadedReview, QueueItem } from "../types";

const item = { queueItemId: "wm-dink-01-E1", requiredReviewsTarget: 2 } as QueueItem;

function review(coachId: string): CoachReview {
  const [fixture] = syntheticAgreeingPair();
  return {
    ...fixture!,
    coachId,
    coachCredentialRef: `cred-${coachId}`,
    reviewId: `wm-dink-01-E1.${coachId}`,
  };
}

describe("canSeeOtherReviews (blind policy)", () => {
  it("hides contents from observers and non-submitted coaches while collecting", () => {
    const reviews = [review("coach-01")];
    expect(canSeeOtherReviews(item, reviews, null)).toBe(false);
    expect(canSeeOtherReviews(item, reviews, "coach-02")).toBe(false);
  });

  it("shows a coach their own already-submitted review", () => {
    expect(canSeeOtherReviews(item, [review("coach-01")], "coach-01")).toBe(true);
  });

  it("discloses everything once the item reaches its review target", () => {
    const reviews = [review("coach-01"), review("coach-02")];
    expect(canSeeOtherReviews(item, reviews, null)).toBe(true);
    expect(canSeeOtherReviews(item, reviews, "coach-03")).toBe(true);
  });
});

describe("currentReviewVersion (append-only versioning)", () => {
  const original = review("coach-01");
  const amended: CoachReview = { ...original, confidence: 0.9 };
  const amendment: ReviewAmendment = {
    schemaVersion: 1,
    amendmentId: amendmentIdFor(original.reviewId, 2),
    reviewId: original.reviewId,
    revision: 2,
    reason: "rewatched at quarter speed",
    review: amended,
    createdAtIso: "2026-08-29T00:00:00.000Z",
  };

  it("returns the original as revision 1 when no amendments exist", () => {
    expect(currentReviewVersion(original, [])).toEqual({ review: original, revision: 1, history: [] });
  });

  it("returns the latest amendment while preserving the full history", () => {
    const result = currentReviewVersion(original, [amendment]);
    expect(result.revision).toBe(2);
    expect(result.review.confidence).toBe(0.9);
    expect(result.history).toEqual([amendment]);
  });

  it("ignores amendments for other reviews", () => {
    const other = currentReviewVersion(review("coach-02"), [amendment]);
    expect(other.revision).toBe(1);
  });
});

describe("primaryFaultIndex", () => {
  it("is null with zero faults", () => {
    expect(primaryFaultIndex([])).toBeNull();
  });

  it("picks the first fault of the highest severity", () => {
    expect(primaryFaultIndex([{ severity: 1 }, { severity: 3 }, { severity: 3 }])).toBe(1);
    expect(primaryFaultIndex([{ severity: 2 }, { severity: 1 }])).toBe(0);
  });
});

describe("buildAdjudicatedExport", () => {
  const reviews: LoadedReview[] = [
    { review: review("coach-01"), source: "datasets/coach-review/reviews/a.json", synthetic: false },
    { review: review("coach-02"), source: "datasets/coach-review/reviews/b.json", synthetic: false },
    { review: syntheticAgreeingPair()[0]!, source: "SYNTHETIC-FIXTURE", synthetic: true },
  ];
  const adjudication: AdjudicationRecord = {
    schemaVersion: 1,
    queueItemId: "wm-dink-01-E1",
    adjudicatorId: "coach-03",
    adjudicatorCredentialRef: "cred-coach-03",
    reviewedReviewIds: ["wm-dink-01-E1.coach-01", "wm-dink-01-E1.coach-02"],
    outcome: { kind: "uphold", reviewId: "wm-dink-01-E1.coach-01" },
    rationale: "severity call matches the visible wrist action",
    evidenceTimestampsMs: [],
    createdAtIso: "2026-08-29T00:00:00.000Z",
  };

  it("exports adjudicated items with their reviews and excludes synthetic fixtures", () => {
    const exported = buildAdjudicatedExport(reviews, [], [adjudication], "2026-08-29T01:00:00.000Z");
    expect(exported.exportVersion).toBe("adjudicated-reviews-export-v1");
    expect(exported.generatedAtIso).toBe("2026-08-29T01:00:00.000Z");
    expect(exported.items).toHaveLength(1);
    expect(exported.items[0]!.reviews.map((entry) => entry.review.coachId).sort()).toEqual(["coach-01", "coach-02"]);
  });

  it("carries amendment history so consumers keep the disagreement trail", () => {
    const original = review("coach-01");
    const amendment: ReviewAmendment = {
      schemaVersion: 1,
      amendmentId: amendmentIdFor(original.reviewId, 2),
      reviewId: original.reviewId,
      revision: 2,
      reason: "rewatched at quarter speed",
      review: { ...original, confidence: 0.95 },
      createdAtIso: "2026-08-29T00:30:00.000Z",
    };
    const exported = buildAdjudicatedExport(reviews, [amendment], [adjudication]);
    const entry = exported.items[0]!.reviews.find((candidate) => candidate.review.coachId === "coach-01")!;
    expect(entry.revision).toBe(2);
    expect(entry.review.confidence).toBe(0.95);
    expect(entry.amendmentHistory).toHaveLength(1);
  });

  it("is empty while zero adjudications exist — nothing is fabricated", () => {
    expect(buildAdjudicatedExport(reviews, [], []).items).toEqual([]);
  });
});
