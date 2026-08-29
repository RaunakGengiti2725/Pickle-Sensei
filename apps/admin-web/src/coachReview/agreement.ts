import type { CoachReview } from "./types";

/**
 * Inter-coach agreement for one queue item.
 *
 * Policy (queue.json program block): disagreement is DATA — it is computed,
 * displayed, and preserved; it is never averaged away. With fewer than two
 * evaluable reviews every metric is null and status is "awaiting_reviews"
 * (which is the truthful state of the whole program today: 0 reviews).
 *
 * Metrics are pairwise over evaluable reviews (cannotEvaluate excluded,
 * counted separately):
 *  - stroke:       both coaches' resolved stroke labels match
 *  - rating:       exact-match rate + mean |Δ| on the anchored 1–5 scale
 *  - primaryFault: first listed fault of highest severity (null = "clean")
 *  - severity:     for faultIds BOTH coaches flagged, exact rate + mean |Δ|
 *  - faultOverlap: Jaccard of the two coaches' faultId sets
 */

export interface PairwiseRate {
  comparablePairs: number;
  agreeingPairs: number;
  rate: number | null;
}

export interface ItemAgreement {
  queueItemId: string;
  reviewCount: number;
  evaluableCount: number;
  cannotEvaluateCount: number;
  requiredReviewsTarget: number;
  coachIds: string[];
  status: "awaiting_reviews" | "computed";
  stroke: PairwiseRate & { resolvedByCoach: Record<string, string | null> };
  rating: {
    comparablePairs: number;
    exactMatchRate: number | null;
    meanAbsDiff: number | null;
    valuesByCoach: Record<string, number | null>;
  };
  primaryFault: PairwiseRate & { primaryByCoach: Record<string, string | null> };
  severity: {
    sharedFaultComparisons: number;
    exactRate: number | null;
    meanAbsDiff: number | null;
  };
  faultOverlap: { comparablePairs: number; meanJaccard: number | null };
  adjudication: { required: boolean; reasons: string[] };
}

function pairs<T>(items: T[]): Array<[T, T]> {
  const out: Array<[T, T]> = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      out.push([items[i]!, items[j]!]);
    }
  }
  return out;
}

function resolvedStroke(review: CoachReview): string | null {
  const confirmation = review.strokeConfirmation;
  if (confirmation.kind === "cannot_judge") return null;
  return confirmation.stroke;
}

/** Primary fault = coach's first listed fault among those of max severity;
 * an evaluable review with zero faults has primary null ("clean stroke"). */
function primaryFault(review: CoachReview): string | null {
  if (review.faults.length === 0) return null;
  const maxSeverity = Math.max(...review.faults.map((fault) => fault.severity));
  const primary = review.faults.find((fault) => fault.severity === maxSeverity);
  return primary ? primary.faultId : null;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((id) => b.has(id)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

export function computeItemAgreement(
  queueItemId: string,
  requiredReviewsTarget: number,
  reviews: CoachReview[],
): ItemAgreement {
  const forItem = reviews.filter((review) => review.queueItemId === queueItemId);
  const evaluable = forItem.filter((review) => review.cannotEvaluate === null);
  const cannotEvaluateCount = forItem.length - evaluable.length;
  const base: ItemAgreement = {
    queueItemId,
    reviewCount: forItem.length,
    evaluableCount: evaluable.length,
    cannotEvaluateCount,
    requiredReviewsTarget,
    coachIds: forItem.map((review) => review.coachId),
    status: evaluable.length >= 2 ? "computed" : "awaiting_reviews",
    stroke: { comparablePairs: 0, agreeingPairs: 0, rate: null, resolvedByCoach: {} },
    rating: { comparablePairs: 0, exactMatchRate: null, meanAbsDiff: null, valuesByCoach: {} },
    primaryFault: { comparablePairs: 0, agreeingPairs: 0, rate: null, primaryByCoach: {} },
    severity: { sharedFaultComparisons: 0, exactRate: null, meanAbsDiff: null },
    faultOverlap: { comparablePairs: 0, meanJaccard: null },
    adjudication: { required: false, reasons: [] },
  };
  for (const review of forItem) {
    base.stroke.resolvedByCoach[review.coachId] = resolvedStroke(review);
    base.rating.valuesByCoach[review.coachId] = review.overallQuality?.value ?? null;
    base.primaryFault.primaryByCoach[review.coachId] = review.cannotEvaluate
      ? null
      : primaryFault(review);
  }
  if (base.status === "awaiting_reviews") return base;

  const reasons: string[] = [];

  // Stroke agreement: pairs where both resolved a stroke.
  const strokePairs = pairs(evaluable).filter(
    ([a, b]) => resolvedStroke(a) !== null && resolvedStroke(b) !== null,
  );
  base.stroke.comparablePairs = strokePairs.length;
  base.stroke.agreeingPairs = strokePairs.filter(
    ([a, b]) => resolvedStroke(a) === resolvedStroke(b),
  ).length;
  base.stroke.rate = strokePairs.length > 0 ? base.stroke.agreeingPairs / strokePairs.length : null;
  for (const [a, b] of strokePairs) {
    if (resolvedStroke(a) !== resolvedStroke(b)) {
      reasons.push(
        `stroke mismatch: ${a.coachId}=${resolvedStroke(a)} vs ${b.coachId}=${resolvedStroke(b)}`,
      );
    }
  }

  // Rating agreement: pairs where both rated.
  const ratedPairs = pairs(evaluable).filter(
    ([a, b]) => a.overallQuality !== null && b.overallQuality !== null,
  );
  base.rating.comparablePairs = ratedPairs.length;
  if (ratedPairs.length > 0) {
    const diffs = ratedPairs.map(([a, b]) =>
      Math.abs(a.overallQuality!.value - b.overallQuality!.value),
    );
    base.rating.exactMatchRate = diffs.filter((d) => d === 0).length / diffs.length;
    base.rating.meanAbsDiff = diffs.reduce((sum, d) => sum + d, 0) / diffs.length;
    for (const [index, diff] of diffs.entries()) {
      if (diff >= 2) {
        const [a, b] = ratedPairs[index]!;
        reasons.push(
          `rating gap ≥2: ${a.coachId}=${a.overallQuality!.value} vs ${b.coachId}=${b.overallQuality!.value}`,
        );
      }
    }
  }

  // Primary fault agreement (null==null counts as agreement: both say clean).
  const primaryPairs = pairs(evaluable);
  base.primaryFault.comparablePairs = primaryPairs.length;
  base.primaryFault.agreeingPairs = primaryPairs.filter(
    ([a, b]) => primaryFault(a) === primaryFault(b),
  ).length;
  base.primaryFault.rate =
    primaryPairs.length > 0 ? base.primaryFault.agreeingPairs / primaryPairs.length : null;
  for (const [a, b] of primaryPairs) {
    const pa = primaryFault(a);
    const pb = primaryFault(b);
    if (pa !== null && pb !== null && pa !== pb) {
      reasons.push(`primary fault mismatch: ${a.coachId}=${pa} vs ${b.coachId}=${pb}`);
    }
  }

  // Severity agreement on shared faults + fault-set overlap.
  const severityDiffs: number[] = [];
  const jaccards: number[] = [];
  for (const [a, b] of pairs(evaluable)) {
    const setA = new Set(a.faults.map((fault) => fault.faultId));
    const setB = new Set(b.faults.map((fault) => fault.faultId));
    jaccards.push(jaccard(setA, setB));
    for (const id of setA) {
      if (!setB.has(id)) continue;
      const severityA = a.faults.find((fault) => fault.faultId === id)!.severity;
      const severityB = b.faults.find((fault) => fault.faultId === id)!.severity;
      severityDiffs.push(Math.abs(severityA - severityB));
    }
  }
  base.severity.sharedFaultComparisons = severityDiffs.length;
  if (severityDiffs.length > 0) {
    base.severity.exactRate = severityDiffs.filter((d) => d === 0).length / severityDiffs.length;
    base.severity.meanAbsDiff = severityDiffs.reduce((sum, d) => sum + d, 0) / severityDiffs.length;
  }
  base.faultOverlap.comparablePairs = jaccards.length;
  base.faultOverlap.meanJaccard =
    jaccards.length > 0 ? jaccards.reduce((sum, j) => sum + j, 0) / jaccards.length : null;

  base.adjudication = { required: reasons.length > 0, reasons };
  return base;
}

export function computeAllAgreements(
  items: Array<{ queueItemId: string; requiredReviewsTarget: number }>,
  reviews: CoachReview[],
): ItemAgreement[] {
  return items.map((item) =>
    computeItemAgreement(item.queueItemId, item.requiredReviewsTarget, reviews),
  );
}
