import type { CoachReview, QueueItem } from "./types";

/**
 * Blind-review policy: coaches must not see each other's reviews while an
 * item is still collecting them. Review CONTENTS for a queue item are
 * disclosed only when
 *  - the viewer is a coach who has already submitted their own review for
 *    the item (they can no longer be influenced), or
 *  - the item has reached its requiredReviewsTarget of real reviews
 *    (collection is complete; adjudication/agreement need the side-by-side).
 * Counts are always visible; contents are what blindness protects.
 */

/** True while REAL reviews are still being collected for an item: some exist
 * but the target is not reached. In this state review-derived CONTENT
 * (labels, per-pair rates, mismatch reasons) must be withheld from shared
 * surfaces like the agreement table — n=2 aggregates let a coach who knows
 * their own answer reconstruct the other's. Counts stay visible. Items with
 * zero real reviews (e.g. synthetic-only dev fixtures) have nothing to
 * protect. */
export function isBlindInProgress(requiredReviewsTarget: number, realReviewCount: number): boolean {
  return realReviewCount > 0 && realReviewCount < requiredReviewsTarget;
}

export function canSeeOtherReviews(
  item: QueueItem,
  realReviewsForItem: CoachReview[],
  viewerCoachId: string | null,
): boolean {
  if (realReviewsForItem.length >= item.requiredReviewsTarget) return true;
  return (
    viewerCoachId !== null && realReviewsForItem.some((review) => review.coachId === viewerCoachId)
  );
}
