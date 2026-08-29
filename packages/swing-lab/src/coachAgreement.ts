import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import {
  type CoachReview,
  validateCoachReview,
  allFaultIds,
  DRILL_LIBRARY_V0,
} from "./coachReview.js";

/**
 * MULTI-COACH AGREEMENT MEASUREMENT ENGINE
 *
 *   pnpm lab:coach-agreement              # production path: real reviews only
 *   pnpm lab:coach-agreement -- --example # NOT-GOLD pipeline proof on the
 *                                         # synthetic EXAMPLE file (never
 *                                         # enters any production artifact)
 *
 * Runs the day real coach reviews exist. Until then it emits an honest
 * "N=0 real reviews" report — every metric is null, never fabricated.
 *
 * What it measures once >=2 independent reviews per item exist:
 *   - stroke identity          — Cohen's kappa per coach pair + Fleiss' kappa
 *   - primary fault            — Cohen's kappa per coach pair + Fleiss' kappa
 *   - primary-fault severity   — linear-weighted Cohen's kappa (ordinal 1..3)
 *   - technique rating (1..5)  — ICC(2,1), Spearman rank correlation,
 *                                exact %, mean |Δ|, per-coach calibration
 *   - drill selection          — pairwise Jaccard overlap of suggested drill
 *                                id sets (free-text-only suggestions counted,
 *                                not matched)
 *   - cannot-evaluate          — per-coach frequency + per-item splits
 *
 * DISAGREEMENT IS SURFACED, NEVER COLLAPSED: every item where reviewers
 * differ on stroke, primary fault, severity, |rating Δ| >= 2, or split on
 * cannot-evaluate is listed with the per-coach verdicts so adjudication
 * (docs/COACHING.md §6) starts from the full record. No consensus label is
 * produced here — agreement statistics are measurement, not truth-making.
 *
 * Blind assignment: assignments ask N independent coaches per item; the
 * portal's disclosure policy (apps/admin-web coachReview/blind.ts) hides
 * other reviews until a coach has submitted their own. The planner below is
 * deterministic (seeded by ids, not randomness) so re-runs are reproducible.
 */

export const AGREEMENT_ENGINE_VERSION = "coach-agreement-v1" as const;

export const COACH_REVIEW_DIR = join(REPO_ROOT, "datasets/coach-review");
export const AGREEMENT_DIR = join(COACH_REVIEW_DIR, "agreement");
export const EXAMPLE_REVIEWS_PATH = join(
  COACH_REVIEW_DIR,
  "examples",
  "EXAMPLE-synthetic-reviews.NOT-GOLD.json",
);

/* ------------------------------------------------------------------------ *
 * STATISTICS — pure functions, unit-tested against hand-computed values
 * ------------------------------------------------------------------------ */

/** Cohen's kappa over paired categorical labels. Null when n<2 or when
 * chance agreement is 1 (no variation — kappa undefined, never fabricated). */
export function cohenKappa(pairs: Array<[string, string]>): {
  n: number;
  observedAgreement: number | null;
  expectedAgreement: number | null;
  kappa: number | null;
} {
  const n = pairs.length;
  if (n < 2) return { n, observedAgreement: null, expectedAgreement: null, kappa: null };
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const marginalsA = new Map<string, number>();
  const marginalsB = new Map<string, number>();
  for (const [a, b] of pairs) {
    marginalsA.set(a, (marginalsA.get(a) ?? 0) + 1);
    marginalsB.set(b, (marginalsB.get(b) ?? 0) + 1);
  }
  let expected = 0;
  for (const [label, countA] of marginalsA) {
    expected += (countA / n) * ((marginalsB.get(label) ?? 0) / n);
  }
  if (expected === 1) return { n, observedAgreement: observed, expectedAgreement: 1, kappa: null };
  return {
    n,
    observedAgreement: observed,
    expectedAgreement: expected,
    kappa: (observed - expected) / (1 - expected),
  };
}

/** Linear-weighted Cohen's kappa for ordinal categories (e.g. severity 1..3,
 * rating 1..5). Weight = 1 - |i-j|/(k-1). Null when n<2 or undefined. */
export function weightedKappa(
  pairs: Array<[number, number]>,
  categories: number[],
): { n: number; kappa: number | null } {
  const n = pairs.length;
  const k = categories.length;
  if (n < 2 || k < 2) return { n, kappa: null };
  const index = new Map(categories.map((c, i) => [c, i]));
  const weight = (a: number, b: number) =>
    1 - Math.abs((index.get(a) ?? 0) - (index.get(b) ?? 0)) / (k - 1);
  const marginalsA = new Map<number, number>();
  const marginalsB = new Map<number, number>();
  let observedW = 0;
  for (const [a, b] of pairs) {
    observedW += weight(a, b);
    marginalsA.set(a, (marginalsA.get(a) ?? 0) + 1);
    marginalsB.set(b, (marginalsB.get(b) ?? 0) + 1);
  }
  observedW /= n;
  let expectedW = 0;
  for (const [a, countA] of marginalsA) {
    for (const [b, countB] of marginalsB) {
      expectedW += (countA / n) * (countB / n) * weight(a, b);
    }
  }
  if (expectedW === 1) return { n, kappa: null };
  return { n, kappa: (observedW - expectedW) / (1 - expectedW) };
}

/** Fleiss' kappa over items each rated by the SAME number of raters (>=2).
 * Items with a different rater count are excluded (reported by the caller).
 * Null when <2 usable items or undefined (no variation). */
export function fleissKappa(itemLabels: string[][]): {
  items: number;
  ratersPerItem: number | null;
  kappa: number | null;
} {
  const usable = itemLabels.filter((labels) => labels.length >= 2);
  if (usable.length < 2) return { items: usable.length, ratersPerItem: null, kappa: null };
  const raters = usable[0]!.length;
  if (!usable.every((labels) => labels.length === raters)) {
    return { items: usable.length, ratersPerItem: null, kappa: null };
  }
  const categories = [...new Set(usable.flat())].sort();
  const nItems = usable.length;
  const categoryTotals = new Map<string, number>(categories.map((c) => [c, 0]));
  let sumPi = 0;
  for (const labels of usable) {
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    let agreePairs = 0;
    for (const [label, count] of counts) {
      agreePairs += count * (count - 1);
      categoryTotals.set(label, (categoryTotals.get(label) ?? 0) + count);
    }
    sumPi += agreePairs / (raters * (raters - 1));
  }
  const pBar = sumPi / nItems;
  let peBar = 0;
  for (const total of categoryTotals.values()) {
    const pj = total / (nItems * raters);
    peBar += pj * pj;
  }
  if (peBar === 1) return { items: nItems, ratersPerItem: raters, kappa: null };
  return { items: nItems, ratersPerItem: raters, kappa: (pBar - peBar) / (1 - peBar) };
}

/** ICC(2,1) — two-way random effects, absolute agreement, single rater —
 * over a complete items × raters matrix. Null when <2 items or <2 raters. */
export function icc2_1(matrix: number[][]): { items: number; raters: number; icc: number | null } {
  const n = matrix.length;
  const k = matrix[0]?.length ?? 0;
  if (n < 2 || k < 2 || !matrix.every((row) => row.length === k)) {
    return { items: n, raters: k, icc: null };
  }
  const grand = matrix.flat().reduce((sum, v) => sum + v, 0) / (n * k);
  const rowMeans = matrix.map((row) => row.reduce((s, v) => s + v, 0) / k);
  const colMeans = Array.from(
    { length: k },
    (_, j) => matrix.reduce((s, row) => s + row[j]!, 0) / n,
  );
  const ssRows = k * rowMeans.reduce((s, m) => s + (m - grand) ** 2, 0);
  const ssCols = n * colMeans.reduce((s, m) => s + (m - grand) ** 2, 0);
  let ssTotal = 0;
  for (const row of matrix) for (const v of row) ssTotal += (v - grand) ** 2;
  const ssError = ssTotal - ssRows - ssCols;
  const msRows = ssRows / (n - 1);
  const msCols = ssCols / (k - 1);
  const msError = ssError / ((n - 1) * (k - 1));
  const denominator = msRows + (k - 1) * msError + (k * (msCols - msError)) / n;
  if (denominator === 0) return { items: n, raters: k, icc: null };
  return { items: n, raters: k, icc: (msRows - msError) / denominator };
}

/** Spearman rank correlation with average ranks for ties. Null when n<2 or
 * either side has zero variance. */
export function spearman(pairs: Array<[number, number]>): { n: number; rho: number | null } {
  const n = pairs.length;
  if (n < 2) return { n, rho: null };
  const rank = (values: number[]): number[] => {
    const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(values.length);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1]!.v === sorted[i]!.v) j += 1;
      const avgRank = (i + j) / 2 + 1;
      for (let m = i; m <= j; m += 1) ranks[sorted[m]!.i] = avgRank;
      i = j + 1;
    }
    return ranks;
  };
  const ranksA = rank(pairs.map(([a]) => a));
  const ranksB = rank(pairs.map(([, b]) => b));
  const meanA = ranksA.reduce((s, v) => s + v, 0) / n;
  const meanB = ranksB.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let idx = 0; idx < n; idx += 1) {
    const dA = ranksA[idx]! - meanA;
    const dB = ranksB[idx]! - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }
  if (varA === 0 || varB === 0) return { n, rho: null };
  return { n, rho: cov / Math.sqrt(varA * varB) };
}

/** Jaccard overlap of two sets; null when both are empty (0/0 undefined). */
export function jaccard(setA: Set<string>, setB: Set<string>): number | null {
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return null;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  return intersection / union.size;
}

/* ------------------------------------------------------------------------ *
 * REVIEW LOADING — production path refuses synthetic identities
 * ------------------------------------------------------------------------ */

export interface LoadedReviews {
  reviews: CoachReview[];
  rejected: Array<{ source: string; problems: string[] }>;
  /** "production" reviews come only from datasets/coach-review/reviews/. */
  provenance: "production" | "EXAMPLE_NOT_GOLD";
}

export function isSyntheticIdentity(coachId: string): boolean {
  return /synthetic|example|fixture|demo/i.test(coachId);
}

/** Production loader: one file per review from the append-only reviews dir.
 * Synthetic/example identities are REJECTED here — they can never reach a
 * production agreement report. */
export function loadProductionReviews(reviewsDir: string): LoadedReviews {
  const rejected: Array<{ source: string; problems: string[] }> = [];
  const reviews: CoachReview[] = [];
  if (!existsSync(reviewsDir)) return { reviews, rejected, provenance: "production" };
  for (const file of readdirSync(reviewsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const source = join(reviewsDir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(source, "utf8"));
    } catch {
      rejected.push({ source, problems: ["invalid JSON"] });
      continue;
    }
    const problems = validateCoachReview(parsed);
    const review = parsed as CoachReview;
    if (review.coachId && isSyntheticIdentity(review.coachId)) {
      problems.push("synthetic/example coach identity refused on the production path");
    }
    if (problems.length > 0) rejected.push({ source, problems });
    else reviews.push(review);
  }
  return { reviews, rejected, provenance: "production" };
}

/** EXAMPLE loader: reads the clearly-marked NOT-GOLD synthetic file, used
 * ONLY to prove the pipeline executes. Refuses files not marked NOT_GOLD. */
export function loadExampleReviews(examplePath: string): LoadedReviews {
  const parsed = JSON.parse(readFileSync(examplePath, "utf8")) as {
    marker?: string;
    reviews?: unknown[];
  };
  if (parsed.marker !== "NOT_GOLD_SYNTHETIC_EXAMPLE") {
    throw new Error(`example file ${examplePath} is missing the NOT_GOLD_SYNTHETIC_EXAMPLE marker`);
  }
  const rejected: Array<{ source: string; problems: string[] }> = [];
  const reviews: CoachReview[] = [];
  for (const [index, raw] of (parsed.reviews ?? []).entries()) {
    const problems = validateCoachReview(raw).filter(
      // Synthetic ids are the POINT of the example file; every other schema
      // rule still applies so the example exercises the real validator.
      (problem) => !problem.includes("SYNTHETIC coach ids"),
    );
    const review = raw as CoachReview;
    if (!isSyntheticIdentity(review.coachId ?? "")) {
      problems.push("example reviews MUST use synthetic identities (coachId containing SYNTHETIC)");
    }
    if (problems.length > 0) rejected.push({ source: `${examplePath}[${index}]`, problems });
    else reviews.push(review);
  }
  return { reviews, rejected, provenance: "EXAMPLE_NOT_GOLD" };
}

/* ------------------------------------------------------------------------ *
 * BLIND ASSIGNMENT PLANNER — deterministic, load-balanced, no randomness
 * ------------------------------------------------------------------------ */

export interface AssignmentPlanItem {
  queueItemId: string;
  coachIds: string[];
  blindProtocol: string;
}

/** Deterministically assigns `reviewersPerItem` distinct coaches to each
 * queue item, balancing load (least-loaded first, id order as tiebreak).
 * Returns an empty plan with the honest reason when the registry cannot
 * support the target. Never invents coaches. */
export function planAssignments(
  queueItemIds: string[],
  activeCoachIds: string[],
  reviewersPerItem = 2,
): { plan: AssignmentPlanItem[]; feasible: boolean; reason: string | null } {
  const coaches = [...new Set(activeCoachIds)].sort();
  if (coaches.length < reviewersPerItem) {
    return {
      plan: [],
      feasible: false,
      reason: `need >=${reviewersPerItem} active coaches for independent review; registry has ${coaches.length}`,
    };
  }
  const load = new Map<string, number>(coaches.map((id) => [id, 0]));
  const blindProtocol =
    "independent review: coaches must not see or discuss other reviews of this item before submitting " +
    "(enforced by the portal disclosure policy, apps/admin-web coachReview/blind.ts)";
  const plan: AssignmentPlanItem[] = [];
  for (const queueItemId of [...queueItemIds].sort()) {
    const chosen = [...coaches]
      .sort((a, b) => load.get(a)! - load.get(b)! || a.localeCompare(b))
      .slice(0, reviewersPerItem);
    for (const coachId of chosen) load.set(coachId, load.get(coachId)! + 1);
    plan.push({ queueItemId, coachIds: chosen.sort(), blindProtocol });
  }
  return { plan, feasible: true, reason: null };
}

/* ------------------------------------------------------------------------ *
 * AGREEMENT COMPUTATION
 * ------------------------------------------------------------------------ */

export type StrokeVerdict = string; // v3 label or "CANNOT_JUDGE"
export const CLEAN = "CLEAN" as const;
export const CANNOT_JUDGE = "CANNOT_JUDGE" as const;
export const CANNOT_EVALUATE = "CANNOT_EVALUATE" as const;

export function strokeVerdict(review: CoachReview): StrokeVerdict {
  const confirmation = review.strokeConfirmation;
  return confirmation.kind === "cannot_judge" ? CANNOT_JUDGE : confirmation.stroke;
}

/** Primary fault = the coach's FIRST listed fault (order is the coach's
 * priority order per the CoachReview schema); zero faults => CLEAN. */
export function primaryFault(review: CoachReview): string {
  return review.faults[0]?.faultId ?? CLEAN;
}

export interface ItemDisagreement {
  queueItemId: string;
  dimension:
    | "stroke_identity"
    | "primary_fault"
    | "severity"
    | "technique_rating"
    | "cannot_evaluate_split"
    | "drill_selection";
  detail: string;
  perCoach: Array<{ coachId: string; verdict: string }>;
}

export interface PairMetric {
  coachA: string;
  coachB: string;
  sharedItems: number;
  [metric: string]: unknown;
}

export interface AgreementReport {
  engineVersion: typeof AGREEMENT_ENGINE_VERSION;
  generatedAtIso: string;
  provenance: "production" | "EXAMPLE_NOT_GOLD";
  /** Screaming banner duplicated at top level so no consumer can miss it. */
  banner: string;
  realReviewCount: number;
  coachCount: number;
  itemsWithMultipleReviews: number;
  rejectedInputs: Array<{ source: string; problems: string[] }>;
  status: string;
  strokeIdentity: {
    pairwiseCohen: PairMetric[];
    fleiss: { items: number; ratersPerItem: number | null; kappa: number | null };
    excludedFromFleiss: number;
    percentAgreementItems: number | null;
  };
  primaryFault: {
    pairwiseCohen: PairMetric[];
    fleiss: { items: number; ratersPerItem: number | null; kappa: number | null };
    excludedFromFleiss: number;
    percentAgreementItems: number | null;
  };
  severity: {
    pairwiseWeightedKappa: PairMetric[];
    note: string;
  };
  techniqueRating: {
    icc2_1: { items: number; raters: number; icc: number | null };
    iccNote: string;
    pairwiseSpearman: PairMetric[];
    pairwiseExactAgreement: PairMetric[];
    pairwiseMeanAbsDiff: PairMetric[];
    calibration: Array<{
      coachId: string;
      ratings: number;
      meanRating: number | null;
      meanOffsetFromItemMean: number | null;
    }>;
  };
  drillSelection: {
    pairwiseJaccard: PairMetric[];
    freeTextOnlySuggestions: number;
    note: string;
  };
  cannotEvaluate: {
    perCoach: Array<{ coachId: string; reviews: number; cannotEvaluate: number; rate: number }>;
    splitItems: number;
  };
  disagreements: ItemDisagreement[];
  disagreementPolicy: string;
}

interface PairAccumulator {
  strokePairs: Array<[string, string]>;
  faultPairs: Array<[string, string]>;
  severityPairs: Array<[number, number]>;
  ratingPairs: Array<[number, number]>;
  drillJaccards: number[];
  sharedItems: number;
}

export function computeAgreement(loaded: LoadedReviews, nowIso: string): AgreementReport {
  const { reviews, rejected, provenance } = loaded;
  const byItem = new Map<string, CoachReview[]>();
  for (const review of reviews) {
    byItem.set(review.queueItemId, [...(byItem.get(review.queueItemId) ?? []), review]);
  }
  const multiItems = [...byItem.entries()]
    .filter(([, itemReviews]) => itemReviews.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b));
  const coachIds = [...new Set(reviews.map((review) => review.coachId))].sort();

  /* --- pairwise accumulation ------------------------------------------- */
  const pairKey = (a: string, b: string) => `${a}\u0000${b}`;
  const pairs = new Map<string, PairAccumulator>();
  const pairOf = (a: string, b: string): PairAccumulator => {
    const key = pairKey(a, b);
    let accumulator = pairs.get(key);
    if (!accumulator) {
      accumulator = {
        strokePairs: [],
        faultPairs: [],
        severityPairs: [],
        ratingPairs: [],
        drillJaccards: [],
        sharedItems: 0,
      };
      pairs.set(key, accumulator);
    }
    return accumulator;
  };

  const disagreements: ItemDisagreement[] = [];
  const fleissStroke: string[][] = [];
  const fleissFault: string[][] = [];
  let strokeAgreeItems = 0;
  let strokeComparableItems = 0;
  let faultAgreeItems = 0;
  let faultComparableItems = 0;
  let cannotEvaluateSplitItems = 0;
  let freeTextOnlySuggestions = 0;

  /** rating matrix rows for ICC: only items where EVERY coach in the modal
   * complete-rater set rated (ICC needs a complete matrix; the rest are
   * covered pairwise). Built below after modal raters are known. */

  for (const [queueItemId, itemReviews] of multiItems) {
    const ordered = [...itemReviews].sort((a, b) => a.coachId.localeCompare(b.coachId));
    const evaluable = ordered.filter((review) => review.cannotEvaluate === null);
    const cannotCount = ordered.length - evaluable.length;
    if (cannotCount > 0 && cannotCount < ordered.length) {
      cannotEvaluateSplitItems += 1;
      disagreements.push({
        queueItemId,
        dimension: "cannot_evaluate_split",
        detail: `${cannotCount}/${ordered.length} reviewers declined to evaluate`,
        perCoach: ordered.map((review) => ({
          coachId: review.coachId,
          verdict: review.cannotEvaluate
            ? `${CANNOT_EVALUATE}: ${review.cannotEvaluate.reason}`
            : "evaluated",
        })),
      });
    }

    /* stroke identity — CANNOT_JUDGE is a real category, kept in the data */
    const strokes = ordered.map((review) => strokeVerdict(review));
    fleissStroke.push(strokes);
    strokeComparableItems += 1;
    if (new Set(strokes).size === 1) strokeAgreeItems += 1;
    else {
      disagreements.push({
        queueItemId,
        dimension: "stroke_identity",
        detail: `verdicts: ${[...new Set(strokes)].sort().join(" vs ")}`,
        perCoach: ordered.map((review) => ({
          coachId: review.coachId,
          verdict: strokeVerdict(review),
        })),
      });
    }

    /* primary fault + severity + rating + drills over evaluable reviews */
    if (evaluable.length >= 2) {
      const faults = evaluable.map((review) => primaryFault(review));
      fleissFault.push(faults);
      faultComparableItems += 1;
      if (new Set(faults).size === 1) faultAgreeItems += 1;
      else {
        disagreements.push({
          queueItemId,
          dimension: "primary_fault",
          detail: `primary faults: ${[...new Set(faults)].sort().join(" vs ")}`,
          perCoach: evaluable.map((review) => ({
            coachId: review.coachId,
            verdict: primaryFault(review),
          })),
        });
      }

      const severityByCoach = new Map(
        evaluable
          .filter((review) => review.faults.length > 0)
          .map((review) => [review.coachId, review.faults[0]!.severity]),
      );
      const ratings = evaluable.filter((review) => review.overallQuality !== null);
      const ratingValues = ratings.map((review) => review.overallQuality!.value);
      if (ratingValues.length >= 2 && Math.max(...ratingValues) - Math.min(...ratingValues) >= 2) {
        disagreements.push({
          queueItemId,
          dimension: "technique_rating",
          detail: `rating spread ${Math.min(...ratingValues)}..${Math.max(...ratingValues)} (|Δ| >= 2)`,
          perCoach: ratings.map((review) => ({
            coachId: review.coachId,
            verdict: String(review.overallQuality!.value),
          })),
        });
      }

      for (let i = 0; i < evaluable.length; i += 1) {
        for (let j = i + 1; j < evaluable.length; j += 1) {
          const reviewA = evaluable[i]!;
          const reviewB = evaluable[j]!;
          const accumulator = pairOf(reviewA.coachId, reviewB.coachId);
          accumulator.sharedItems += 1;
          accumulator.strokePairs.push([strokeVerdict(reviewA), strokeVerdict(reviewB)]);
          accumulator.faultPairs.push([primaryFault(reviewA), primaryFault(reviewB)]);
          const severityA = severityByCoach.get(reviewA.coachId);
          const severityB = severityByCoach.get(reviewB.coachId);
          // severity only comparable when both coaches named the SAME primary fault
          if (
            severityA !== undefined &&
            severityB !== undefined &&
            primaryFault(reviewA) === primaryFault(reviewB)
          ) {
            accumulator.severityPairs.push([severityA, severityB]);
            if (severityA !== severityB) {
              disagreements.push({
                queueItemId,
                dimension: "severity",
                detail: `same primary fault (${primaryFault(reviewA)}), severity ${severityA} vs ${severityB}`,
                perCoach: [
                  { coachId: reviewA.coachId, verdict: String(severityA) },
                  { coachId: reviewB.coachId, verdict: String(severityB) },
                ],
              });
            }
          }
          if (reviewA.overallQuality && reviewB.overallQuality) {
            accumulator.ratingPairs.push([
              reviewA.overallQuality.value,
              reviewB.overallQuality.value,
            ]);
          }
          const drillsA = new Set(
            reviewA.drillSuggestions.flatMap((s) => (s.drillId ? [s.drillId] : [])),
          );
          const drillsB = new Set(
            reviewB.drillSuggestions.flatMap((s) => (s.drillId ? [s.drillId] : [])),
          );
          const overlap = jaccard(drillsA, drillsB);
          if (overlap !== null) {
            accumulator.drillJaccards.push(overlap);
            if (overlap < 1) {
              disagreements.push({
                queueItemId,
                dimension: "drill_selection",
                detail: `drill sets differ (Jaccard ${overlap.toFixed(2)})`,
                perCoach: [
                  { coachId: reviewA.coachId, verdict: [...drillsA].sort().join(",") || "(none)" },
                  { coachId: reviewB.coachId, verdict: [...drillsB].sort().join(",") || "(none)" },
                ],
              });
            }
          }
        }
      }
      for (const review of evaluable) {
        freeTextOnlySuggestions += review.drillSuggestions.filter((s) => s.drillId === null).length;
      }
    }
  }

  /* --- Fleiss: only items with the modal rater count -------------------- */
  const fleissOn = (itemLabels: string[][]) => {
    const counts = new Map<number, number>();
    for (const labels of itemLabels)
      counts.set(labels.length, (counts.get(labels.length) ?? 0) + 1);
    let modal = 0;
    let modalCount = 0;
    for (const [raters, count] of counts) {
      if (count > modalCount || (count === modalCount && raters > modal)) {
        modal = raters;
        modalCount = count;
      }
    }
    const usable = itemLabels.filter((labels) => labels.length === modal && modal >= 2);
    return { result: fleissKappa(usable), excluded: itemLabels.length - usable.length };
  };
  const strokeFleiss = fleissOn(fleissStroke);
  const faultFleiss = fleissOn(fleissFault);

  /* --- ICC over the largest complete items × raters matrix -------------- */
  const ratingByItemCoach = new Map<string, Map<string, number>>();
  for (const [queueItemId, itemReviews] of multiItems) {
    for (const review of itemReviews) {
      if (review.cannotEvaluate === null && review.overallQuality) {
        const row = ratingByItemCoach.get(queueItemId) ?? new Map<string, number>();
        row.set(review.coachId, review.overallQuality.value);
        ratingByItemCoach.set(queueItemId, row);
      }
    }
  }
  // choose the coach set appearing together on the most items
  const iccMatrix: number[][] = [];
  let iccCoachSet: string[] = [];
  const coachSetCounts = new Map<string, number>();
  for (const row of ratingByItemCoach.values()) {
    if (row.size < 2) continue;
    const key = [...row.keys()].sort().join("|");
    coachSetCounts.set(key, (coachSetCounts.get(key) ?? 0) + 1);
  }
  let bestKey: string | null = null;
  for (const [key, count] of [...coachSetCounts.entries()].sort()) {
    if (bestKey === null || count > coachSetCounts.get(bestKey)!) bestKey = key;
  }
  if (bestKey) {
    iccCoachSet = bestKey.split("|");
    for (const [, row] of [...ratingByItemCoach.entries()].sort()) {
      if (iccCoachSet.every((coachId) => row.has(coachId))) {
        iccMatrix.push(iccCoachSet.map((coachId) => row.get(coachId)!));
      }
    }
  }
  const icc = icc2_1(iccMatrix);

  /* --- calibration: per-coach mean offset from the per-item mean -------- */
  const calibration = coachIds.map((coachId) => {
    const own: number[] = [];
    const offsets: number[] = [];
    for (const row of ratingByItemCoach.values()) {
      const value = row.get(coachId);
      if (value === undefined) continue;
      own.push(value);
      if (row.size >= 2) {
        const itemMean = [...row.values()].reduce((s, v) => s + v, 0) / row.size;
        offsets.push(value - itemMean);
      }
    }
    return {
      coachId,
      ratings: own.length,
      meanRating: own.length > 0 ? own.reduce((s, v) => s + v, 0) / own.length : null,
      meanOffsetFromItemMean:
        offsets.length > 0 ? offsets.reduce((s, v) => s + v, 0) / offsets.length : null,
    };
  });

  /* --- pairwise metric tables ------------------------------------------- */
  const pairEntries = [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b));
  const pairBase = (key: string, accumulator: PairAccumulator) => {
    const [coachA, coachB] = key.split("\u0000") as [string, string];
    return { coachA, coachB, sharedItems: accumulator.sharedItems };
  };
  const strokePairwise = pairEntries.map(([key, acc]) => ({
    ...pairBase(key, acc),
    ...cohenKappa(acc.strokePairs),
  }));
  const faultPairwise = pairEntries.map(([key, acc]) => ({
    ...pairBase(key, acc),
    ...cohenKappa(acc.faultPairs),
  }));
  const severityPairwise = pairEntries.map(([key, acc]) => ({
    ...pairBase(key, acc),
    ...weightedKappa(acc.severityPairs, [1, 2, 3]),
    comparablePairs: acc.severityPairs.length,
  }));
  const spearmanPairwise = pairEntries.map(([key, acc]) => ({
    ...pairBase(key, acc),
    ...spearman(acc.ratingPairs),
  }));
  const exactPairwise = pairEntries.map(([key, acc]) => ({
    ...pairBase(key, acc),
    ratedItems: acc.ratingPairs.length,
    exactAgreement:
      acc.ratingPairs.length > 0
        ? acc.ratingPairs.filter(([a, b]) => a === b).length / acc.ratingPairs.length
        : null,
  }));
  const absDiffPairwise = pairEntries.map(([key, acc]) => ({
    ...pairBase(key, acc),
    ratedItems: acc.ratingPairs.length,
    meanAbsDiff:
      acc.ratingPairs.length > 0
        ? acc.ratingPairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / acc.ratingPairs.length
        : null,
  }));
  const drillPairwise = pairEntries.map(([key, acc]) => ({
    ...pairBase(key, acc),
    comparablePairs: acc.drillJaccards.length,
    meanJaccard:
      acc.drillJaccards.length > 0
        ? acc.drillJaccards.reduce((s, v) => s + v, 0) / acc.drillJaccards.length
        : null,
  }));

  const cannotPerCoach = coachIds.map((coachId) => {
    const own = reviews.filter((review) => review.coachId === coachId);
    const declined = own.filter((review) => review.cannotEvaluate !== null).length;
    return {
      coachId,
      reviews: own.length,
      cannotEvaluate: declined,
      rate: own.length > 0 ? declined / own.length : 0,
    };
  });

  const realReviewCount = provenance === "production" ? reviews.length : 0;
  const banner =
    provenance === "production"
      ? realReviewCount === 0
        ? "N=0 REAL COACH REVIEWS — no agreement exists; every metric below is null. " +
          "Technique score / fault diagnosis / drill recommendation remain BLOCKED_ON_VALIDATION."
        : `${realReviewCount} real coach reviews on file — agreement measured, disagreement preserved below.`
      : "NOT-GOLD SYNTHETIC EXAMPLE RUN — inputs are fabricated fixtures used ONLY to prove the " +
        "pipeline executes. NOTHING here is evidence about real technique truth; real review count is 0. " +
        "This artifact must never feed any production path.";

  return {
    engineVersion: AGREEMENT_ENGINE_VERSION,
    generatedAtIso: nowIso,
    provenance,
    banner,
    realReviewCount,
    coachCount: coachIds.length,
    itemsWithMultipleReviews: multiItems.length,
    rejectedInputs: rejected,
    status:
      provenance === "production" && realReviewCount === 0
        ? "AWAITING QUALIFIED COACHES — engine ready; N=0 real reviews"
        : provenance === "production"
          ? "MEASURED on real reviews"
          : "EXAMPLE_NOT_GOLD pipeline proof",
    strokeIdentity: {
      pairwiseCohen: strokePairwise,
      fleiss: strokeFleiss.result,
      excludedFromFleiss: strokeFleiss.excluded,
      percentAgreementItems:
        strokeComparableItems > 0 ? strokeAgreeItems / strokeComparableItems : null,
    },
    primaryFault: {
      pairwiseCohen: faultPairwise,
      fleiss: faultFleiss.result,
      excludedFromFleiss: faultFleiss.excluded,
      percentAgreementItems:
        faultComparableItems > 0 ? faultAgreeItems / faultComparableItems : null,
    },
    severity: {
      pairwiseWeightedKappa: severityPairwise,
      note: "linear-weighted kappa over primary-fault severity, compared only when both coaches named the same primary fault",
    },
    techniqueRating: {
      icc2_1: icc,
      iccNote:
        iccMatrix.length > 0
          ? `ICC(2,1) over the ${icc.items}×${icc.raters} complete matrix for coach set [${iccCoachSet.join(", ")}]; items rated by other coach sets are covered pairwise`
          : "no complete items×raters rating matrix yet",
      pairwiseSpearman: spearmanPairwise,
      pairwiseExactAgreement: exactPairwise,
      pairwiseMeanAbsDiff: absDiffPairwise,
      calibration,
    },
    drillSelection: {
      pairwiseJaccard: drillPairwise,
      freeTextOnlySuggestions,
      note: "Jaccard over suggested drill-id sets; free-text-only suggestions are counted but not matched (taxonomy grows from coach language)",
    },
    cannotEvaluate: {
      perCoach: cannotPerCoach,
      splitItems: cannotEvaluateSplitItems,
    },
    disagreements,
    disagreementPolicy:
      "Disagreement is DATA: every divergence is listed here with per-coach verdicts and is never " +
      "auto-collapsed into a consensus label. Resolution happens only through recorded adjudication " +
      "(docs/COACHING.md §6), preserved separately from the original reviews.",
  };
}

/* ------------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------------ */

const isMain = process.argv[1]?.endsWith("coachAgreement.ts");
if (isMain) {
  const exampleMode = process.argv.includes("--example");
  mkdirSync(AGREEMENT_DIR, { recursive: true });
  const nowIso = new Date().toISOString();

  const queuePath = join(COACH_REVIEW_DIR, "queue.json");
  const queue = existsSync(queuePath)
    ? (
        JSON.parse(readFileSync(queuePath, "utf8")) as {
          queue: Array<{ queueItemId: string }>;
        }
      ).queue.map((item) => item.queueItemId)
    : [];
  const registry = JSON.parse(readFileSync(join(COACH_REVIEW_DIR, "coaches.json"), "utf8")) as {
    coaches: Array<{ coachId: string; status: string }>;
  };
  const activeCoaches = registry.coaches
    .filter((coach) => coach.status === "active" && !isSyntheticIdentity(coach.coachId))
    .map((coach) => coach.coachId);

  const assignmentPlan = planAssignments(queue, activeCoaches, 2);
  writeFileSync(
    join(AGREEMENT_DIR, "assignment-plan.json"),
    JSON.stringify(
      {
        engineVersion: AGREEMENT_ENGINE_VERSION,
        generatedAtIso: nowIso,
        reviewersPerItem: 2,
        activeCoaches: activeCoaches.length,
        feasible: assignmentPlan.feasible,
        reason: assignmentPlan.reason,
        note:
          "Deterministic blind-assignment PLAN derived from queue.json + coaches.json. " +
          "It becomes real assignments only when an admin applies it through the portal " +
          "(datasets/coach-review/assignments.json); it never invents coaches.",
        plan: assignmentPlan.plan,
      },
      null,
      2,
    ),
  );

  const production = loadProductionReviews(join(COACH_REVIEW_DIR, "reviews"));
  const productionReport = computeAgreement(production, nowIso);
  writeFileSync(
    join(AGREEMENT_DIR, "agreement-report.json"),
    JSON.stringify(productionReport, null, 2),
  );
  console.log(
    `production agreement report: ${productionReport.realReviewCount} real reviews, ` +
      `${productionReport.coachCount} coaches, ${productionReport.itemsWithMultipleReviews} multi-review items ` +
      `→ datasets/coach-review/agreement/agreement-report.json`,
  );
  console.log(`status: ${productionReport.status}`);
  console.log(
    `assignment plan: ${assignmentPlan.feasible ? `${assignmentPlan.plan.length} items planned` : `INFEASIBLE — ${assignmentPlan.reason}`}`,
  );

  if (exampleMode) {
    const example = loadExampleReviews(EXAMPLE_REVIEWS_PATH);
    const exampleReport = computeAgreement(example, nowIso);
    writeFileSync(
      join(AGREEMENT_DIR, "EXAMPLE-agreement-report.NOT-GOLD.json"),
      JSON.stringify(exampleReport, null, 2),
    );
    console.log(
      `EXAMPLE (NOT-GOLD) run: ${example.reviews.length} synthetic reviews, ` +
        `${exampleReport.disagreements.length} surfaced disagreements ` +
        `→ datasets/coach-review/agreement/EXAMPLE-agreement-report.NOT-GOLD.json`,
    );
  }

  // sanity anchors so a broken checkout fails loudly instead of silently
  if (allFaultIds().length === 0 || DRILL_LIBRARY_V0.drills.length === 0) {
    console.error("taxonomy/drill library unexpectedly empty");
    process.exitCode = 1;
  }
}
