import type { CoachReview } from "./types";

/**
 * Cross-item chance-corrected agreement (Cohen's kappa) per coach pair.
 *
 * Kappa is only meaningful ACROSS items (per-item percent agreement lives in
 * agreement.ts): for each pair of coaches, take every queue item BOTH
 * reviewed evaluably, compare the categorical label per item, and correct
 * observed agreement by the chance agreement implied by each coach's own
 * label marginals. Kappa is null (never fabricated) when a pair shares <2
 * items or when chance agreement is 1 (no label variation — undefined).
 */

export interface PairKappa {
  coachA: string;
  coachB: string;
  sharedItems: number;
  observedAgreement: number | null;
  expectedAgreement: number | null;
  kappa: number | null;
}

export function cohenKappa(labelPairs: Array<[string, string]>): {
  observedAgreement: number | null;
  expectedAgreement: number | null;
  kappa: number | null;
} {
  if (labelPairs.length < 2) return { observedAgreement: null, expectedAgreement: null, kappa: null };
  const n = labelPairs.length;
  const observed = labelPairs.filter(([a, b]) => a === b).length / n;
  const marginalsA = new Map<string, number>();
  const marginalsB = new Map<string, number>();
  for (const [a, b] of labelPairs) {
    marginalsA.set(a, (marginalsA.get(a) ?? 0) + 1);
    marginalsB.set(b, (marginalsB.get(b) ?? 0) + 1);
  }
  let expected = 0;
  for (const [label, countA] of marginalsA) {
    expected += (countA / n) * ((marginalsB.get(label) ?? 0) / n);
  }
  if (expected === 1) return { observedAgreement: observed, expectedAgreement: expected, kappa: null };
  return {
    observedAgreement: observed,
    expectedAgreement: expected,
    kappa: (observed - expected) / (1 - expected),
  };
}

/** Extracts one categorical label per evaluable review, or null to skip it. */
export type LabelExtractor = (review: CoachReview) => string | null;

export function computePairKappas(reviews: CoachReview[], extract: LabelExtractor): PairKappa[] {
  const evaluable = reviews.filter((review) => review.cannotEvaluate === null);
  const byCoach = new Map<string, Map<string, string>>();
  for (const review of evaluable) {
    const label = extract(review);
    if (label === null) continue;
    const items = byCoach.get(review.coachId) ?? new Map<string, string>();
    items.set(review.queueItemId, label);
    byCoach.set(review.coachId, items);
  }
  const coachIds = [...byCoach.keys()].sort();
  const out: PairKappa[] = [];
  for (let i = 0; i < coachIds.length; i += 1) {
    for (let j = i + 1; j < coachIds.length; j += 1) {
      const coachA = coachIds[i]!;
      const coachB = coachIds[j]!;
      const itemsA = byCoach.get(coachA)!;
      const itemsB = byCoach.get(coachB)!;
      const labelPairs: Array<[string, string]> = [];
      for (const [queueItemId, labelA] of itemsA) {
        const labelB = itemsB.get(queueItemId);
        if (labelB !== undefined) labelPairs.push([labelA, labelB]);
      }
      const { observedAgreement, expectedAgreement, kappa } = cohenKappa(labelPairs);
      out.push({ coachA, coachB, sharedItems: labelPairs.length, observedAgreement, expectedAgreement, kappa });
    }
  }
  return out;
}

export function strokeLabelExtractor(review: CoachReview): string | null {
  const confirmation = review.strokeConfirmation;
  return confirmation.kind === "cannot_judge" ? null : confirmation.stroke;
}

/** Primary fault as defined in agreement.ts; zero faults = the "CLEAN" category. */
export function primaryFaultLabelExtractor(review: CoachReview): string | null {
  if (review.faults.length === 0) return "CLEAN";
  const maxSeverity = Math.max(...review.faults.map((fault) => fault.severity));
  return review.faults.find((fault) => fault.severity === maxSeverity)?.faultId ?? "CLEAN";
}
