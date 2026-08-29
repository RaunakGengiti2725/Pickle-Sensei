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
export function canSeeOtherReviews(
  item: QueueItem,
  realReviewsForItem: CoachReview[],
  viewerCoachId: string | null,
): boolean {
  if (realReviewsForItem.length >= item.requiredReviewsTarget) return true;
  return viewerCoachId !== null && realReviewsForItem.some((review) => review.coachId === viewerCoachId);
}
