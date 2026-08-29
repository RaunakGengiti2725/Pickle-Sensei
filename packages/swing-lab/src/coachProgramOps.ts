import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { FAULT_TAXONOMY_V0_DRAFT_VERSION, type CoachReview } from "./coachReview.js";
import {
  collectCoachEvidence,
  runCoachGates,
  HELD_OUT_CASE_IDS,
  type CoachGatesReport,
} from "./coachGates.js";
import { computeAgreement, type AgreementReport } from "./coachAgreement.js";
import {
  FAULT_DRILL_MAPPINGS_V1,
  MIN_INDEPENDENT_COACH_ENDORSEMENTS,
  type FaultDrillMappingV1,
} from "./drillLibrary.js";

/**
 * COACH PROGRAM OPERATIONS — continuous review-queue routing + tracking.
 *
 *   pnpm --filter @pickle/swing-lab coach:program-ops   # emit ops report
 *
 * This is the OPERATIONS layer of the real-coach program: it decides WHICH
 * queue items need (more) coach attention and WHY, and tracks the program's
 * evidence state over time. It produces work-routing and bookkeeping only —
 * it never produces labels, never changes a gate verdict, and never
 * manufactures evidence. With zero real coaches every routing reason reduces
 * to "awaiting qualified coaches" and every gate stays NOT_EVALUABLE.
 *
 * PROMOTION AUTHORITY (enforced by enforceNoEngineeringPromotion + tests):
 * sports-science truth (technique score / fault taxonomy / drill mappings)
 * can only be promoted by real, provisioned coach evidence flowing through
 * the frozen coach gates. Engineering work — new models, new code, new
 * routing, new reports — can only ever ADD items to the review queue; it can
 * never flip a validation gate to PASS or a surface to RELEASABLE.
 */

export const PROGRAM_OPS_VERSION = "coach-program-ops-v1" as const;
export const PROGRAM_OPS_DIR = "datasets/coach-review/program-ops" as const;

/** Gate ids whose PASS does NOT require coach evidence: structural locks
 * (profiles locked, registry clean, drills unvalidated). Every other gate is
 * a validation gate and may only leave NOT_EVALUABLE via real coach data. */
export const LOCK_GATE_IDS = ["L1", "L2", "L4"] as const;

/* ------------------------------------------------------------------------ *
 * REVIEW-QUEUE ROUTING
 * ------------------------------------------------------------------------ */

/** Why an item needs (more) coach review, highest priority first. */
export const ROUTING_REASONS = [
  "model_coach_disagreement",
  "hard_case",
  "new_model_version",
  "taxonomy_change",
  "drill_mapping_evidence",
  "baseline_coverage",
] as const;

export type RoutingReason = (typeof ROUTING_REASONS)[number];

/** The queue.json fields routing needs (subset of the emitted queue item). */
export interface RoutableQueueItem {
  queueItemId: string;
  eventRef: { caseId: string; eventIndex: number };
  annotatedStrokeV3: string | null;
  strokeFamily: string;
  requiredReviewsTarget: number;
  bundle: {
    analyzable: boolean;
    annotatorConfidence: number;
    contactUncertainty: string | null;
    notAnalyzableReason?: string | null;
  };
}

export interface RoutedQueueItem {
  queueItemId: string;
  /** All reasons that apply, in ROUTING_REASONS priority order. */
  reasons: RoutingReason[];
  /** Index of the strongest reason in ROUTING_REASONS (0 = most urgent). */
  priority: number;
  /** Human-auditable one-liner per reason. */
  reasonDetails: string[];
  /** Counted (valid, provisioned, non-held-out) reviews on this item. */
  countedReviews: number;
  /** Distinct provisioned coaches among counted reviews. */
  distinctCoaches: number;
  /** Counted reviews that are FRESH: current taxonomy version AND made with
   * the current analysis versions visible. Stale reviews stay valid history
   * but do not satisfy coverage after a model/taxonomy change. */
  freshReviews: number;
  requiredAdditionalReviews: number;
  /** Held-out items may be reviewed, but their reviews count toward NOTHING
   * (no gate evidence, no drill evidence, no taxonomy tuning). */
  heldOut: boolean;
}

export interface RoutingContext {
  /** tool → version of the analysis stack currently shipping. Reviews made
   * under different versions trigger new_model_version re-review. */
  currentAnalysisVersions: Record<string, string>;
  /** The fault-taxonomy version reviews must reference to count as fresh. */
  currentFaultTaxonomyVersion: string;
  /** Mappings still needing endorsement evidence (UNVALIDATED or short of
   * the independent-endorsement minimum). */
  mappingsNeedingEvidence: readonly FaultDrillMappingV1[];
}

export function isHeldOutCase(caseId: string): boolean {
  return (HELD_OUT_CASE_IDS as readonly string[]).includes(caseId);
}

export function mappingsNeedingEvidence(
  mappings: readonly FaultDrillMappingV1[],
): FaultDrillMappingV1[] {
  return mappings.filter(
    (mapping) =>
      mapping.validationState !== "COACH_VALIDATED" ||
      new Set(mapping.endorsements.map((endorsement) => endorsement.coachId)).size <
        MIN_INDEPENDENT_COACH_ENDORSEMENTS,
  );
}

function analysisVersionsMatch(
  reviewVersions: Record<string, string>,
  currentVersions: Record<string, string>,
): boolean {
  return Object.entries(currentVersions).every(([tool, version]) => {
    const seen = reviewVersions[tool];
    return seen === undefined || seen === version;
  });
}

function isHardCaseBundle(bundle: RoutableQueueItem["bundle"]): string | null {
  if (!bundle.analyzable) {
    return `not analyzable: ${bundle.notAnalyzableReason ?? "no reason recorded"}`;
  }
  if (bundle.annotatorConfidence < 0.7) {
    return `low annotator confidence (${bundle.annotatorConfidence})`;
  }
  if (bundle.contactUncertainty !== null && bundle.contactUncertainty !== "exact") {
    return `contact uncertainty ${bundle.contactUncertainty}`;
  }
  return null;
}

/** Deterministic routing: same inputs always produce the same routed queue.
 * Only COUNTED reviews (valid + provisioned + non-held-out, as collected by
 * coachGates.collectCoachEvidence) influence evidence-driven reasons; nothing
 * here can be steered by synthetic or unprovisioned review files. */
export function routeReviewQueue(
  items: RoutableQueueItem[],
  countedReviews: CoachReview[],
  context: RoutingContext,
): RoutedQueueItem[] {
  const reviewsByItem = new Map<string, CoachReview[]>();
  for (const review of countedReviews) {
    reviewsByItem.set(review.queueItemId, [
      ...(reviewsByItem.get(review.queueItemId) ?? []),
      review,
    ]);
  }

  const routed: RoutedQueueItem[] = [];
  for (const item of [...items].sort((a, b) => a.queueItemId.localeCompare(b.queueItemId))) {
    const itemReviews = (reviewsByItem.get(item.queueItemId) ?? []).sort((a, b) =>
      a.reviewId.localeCompare(b.reviewId),
    );
    const heldOut = isHeldOutCase(item.eventRef.caseId);
    const reasons: RoutingReason[] = [];
    const reasonDetails: string[] = [];
    const push = (reason: RoutingReason, detail: string) => {
      if (!reasons.includes(reason)) {
        reasons.push(reason);
        reasonDetails.push(`${reason}: ${detail}`);
      }
    };

    for (const review of itemReviews) {
      const shownLabel = review.provenance.rawLabelsShown?.annotatedStrokeV3 ?? null;
      const confirmation = review.strokeConfirmation;
      if (confirmation.kind === "corrected") {
        push(
          "model_coach_disagreement",
          `coach ${review.coachId} corrected the shown stroke to ${confirmation.stroke}`,
        );
      } else if (
        confirmation.kind === "confirmed" &&
        shownLabel !== null &&
        confirmation.stroke !== shownLabel
      ) {
        push(
          "model_coach_disagreement",
          `coach ${review.coachId} stroke ${confirmation.stroke} differs from shown label ${shownLabel}`,
        );
      }
    }

    const hardBundle = isHardCaseBundle(item.bundle);
    if (hardBundle !== null) push("hard_case", hardBundle);
    for (const review of itemReviews) {
      if (review.cannotEvaluate !== null) {
        push(
          "hard_case",
          `coach ${review.coachId} could not evaluate: ${review.cannotEvaluate.reason}`,
        );
      } else if (review.confidence < 0.5) {
        push("hard_case", `coach ${review.coachId} low review confidence (${review.confidence})`);
      } else if (review.strokeConfirmation.kind === "cannot_judge") {
        push("hard_case", `coach ${review.coachId} could not judge the stroke`);
      }
    }

    const staleModel = itemReviews.filter(
      (review) =>
        !analysisVersionsMatch(review.provenance.analysisVersions, context.currentAnalysisVersions),
    );
    if (staleModel.length > 0) {
      push(
        "new_model_version",
        `${staleModel.length}/${itemReviews.length} reviews made under superseded analysis versions`,
      );
    }

    const staleTaxonomy = itemReviews.filter(
      (review) => review.faultTaxonomyVersion !== context.currentFaultTaxonomyVersion,
    );
    if (staleTaxonomy.length > 0) {
      push(
        "taxonomy_change",
        `${staleTaxonomy.length}/${itemReviews.length} reviews reference a superseded fault taxonomy`,
      );
    }

    if (!heldOut) {
      const relevantMappings = context.mappingsNeedingEvidence.filter((mapping) =>
        mapping.strokeFamilies.some(
          (family) => family === "global" || family === item.strokeFamily,
        ),
      );
      if (relevantMappings.length > 0) {
        push(
          "drill_mapping_evidence",
          `${relevantMappings.length} fault→drill mappings for family ${item.strokeFamily} still need endorsement evidence`,
        );
      }
    }

    const freshReviews = itemReviews.filter(
      (review) =>
        review.faultTaxonomyVersion === context.currentFaultTaxonomyVersion &&
        analysisVersionsMatch(review.provenance.analysisVersions, context.currentAnalysisVersions),
    );
    const requiredAdditionalReviews = Math.max(0, item.requiredReviewsTarget - freshReviews.length);
    if (requiredAdditionalReviews > 0) {
      push(
        "baseline_coverage",
        `${freshReviews.length}/${item.requiredReviewsTarget} fresh independent reviews on file`,
      );
    }

    if (reasons.length === 0) continue;
    const ordered = [...reasons].sort(
      (a, b) => ROUTING_REASONS.indexOf(a) - ROUTING_REASONS.indexOf(b),
    );
    routed.push({
      queueItemId: item.queueItemId,
      reasons: ordered,
      priority: ROUTING_REASONS.indexOf(ordered[0]!),
      reasonDetails: [...reasonDetails].sort(
        (a, b) =>
          ROUTING_REASONS.indexOf(a.split(":")[0] as RoutingReason) -
          ROUTING_REASONS.indexOf(b.split(":")[0] as RoutingReason),
      ),
      countedReviews: itemReviews.length,
      distinctCoaches: new Set(itemReviews.map((review) => review.coachId)).size,
      freshReviews: freshReviews.length,
      requiredAdditionalReviews,
      heldOut,
    });
  }
  routed.sort((a, b) => a.priority - b.priority || a.queueItemId.localeCompare(b.queueItemId));
  return routed;
}

/* ------------------------------------------------------------------------ *
 * PROGRAM TRACKING
 * ------------------------------------------------------------------------ */

export interface ProgramOpsTracking {
  reviewCounts: {
    totalCounted: number;
    reviewFilesOnDisk: number;
    invalidReviewFiles: number;
    heldOutReviewsExcluded: number;
    perCoach: Array<{ coachId: string; reviews: number }>;
    perItemHistogram: Record<string, number>;
  };
  multiCoachOverlap: {
    itemsWithMultipleCoaches: number;
    distinctCoachPairs: number;
    itemsAtTarget: number;
  };
  agreement: {
    engineStatus: string;
    itemsWithMultipleReviews: number;
    strokeIdentityPercentAgreement: number | null;
    primaryFaultPercentAgreement: number | null;
    surfacedDisagreements: number;
  };
  taxonomy: {
    currentFaultTaxonomyVersion: string;
    reviewsOnCurrentTaxonomy: number;
    reviewsOnSupersededTaxonomies: number;
  };
  drillEvidence: {
    totalMappings: number;
    coachValidatedMappings: number;
    unvalidatedMappings: number;
    totalEndorsements: number;
    mappingsNeedingEvidence: string[];
  };
}

export function trackProgramOps(
  countedReviews: CoachReview[],
  evidenceCounts: {
    reviewFileCount: number;
    invalidReviewFiles: number;
    heldOutReviewsExcluded: number;
  },
  agreement: AgreementReport,
  mappings: readonly FaultDrillMappingV1[],
  currentFaultTaxonomyVersion: string,
): ProgramOpsTracking {
  const perCoach = new Map<string, number>();
  const perItem = new Map<string, number>();
  const itemCoaches = new Map<string, Set<string>>();
  for (const review of countedReviews) {
    perCoach.set(review.coachId, (perCoach.get(review.coachId) ?? 0) + 1);
    perItem.set(review.queueItemId, (perItem.get(review.queueItemId) ?? 0) + 1);
    const coaches = itemCoaches.get(review.queueItemId) ?? new Set<string>();
    coaches.add(review.coachId);
    itemCoaches.set(review.queueItemId, coaches);
  }
  const histogram: Record<string, number> = {};
  for (const count of perItem.values()) {
    histogram[String(count)] = (histogram[String(count)] ?? 0) + 1;
  }
  const pairs = new Set<string>();
  for (const coaches of itemCoaches.values()) {
    const sorted = [...coaches].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        pairs.add(`${sorted[i]}|${sorted[j]}`);
      }
    }
  }
  const needing = mappingsNeedingEvidence(mappings);
  const onCurrentTaxonomy = countedReviews.filter(
    (review) => review.faultTaxonomyVersion === currentFaultTaxonomyVersion,
  ).length;
  return {
    reviewCounts: {
      totalCounted: countedReviews.length,
      reviewFilesOnDisk: evidenceCounts.reviewFileCount,
      invalidReviewFiles: evidenceCounts.invalidReviewFiles,
      heldOutReviewsExcluded: evidenceCounts.heldOutReviewsExcluded,
      perCoach: [...perCoach.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([coachId, reviews]) => ({ coachId, reviews })),
      perItemHistogram: histogram,
    },
    multiCoachOverlap: {
      itemsWithMultipleCoaches: [...itemCoaches.values()].filter((coaches) => coaches.size >= 2)
        .length,
      distinctCoachPairs: pairs.size,
      itemsAtTarget: [...itemCoaches.values()].filter((coaches) => coaches.size >= 2).length,
    },
    agreement: {
      engineStatus: agreement.status,
      itemsWithMultipleReviews: agreement.itemsWithMultipleReviews,
      strokeIdentityPercentAgreement: agreement.strokeIdentity.percentAgreementItems,
      primaryFaultPercentAgreement: agreement.primaryFault.percentAgreementItems,
      surfacedDisagreements: agreement.disagreements.length,
    },
    taxonomy: {
      currentFaultTaxonomyVersion,
      reviewsOnCurrentTaxonomy: onCurrentTaxonomy,
      reviewsOnSupersededTaxonomies: countedReviews.length - onCurrentTaxonomy,
    },
    drillEvidence: {
      totalMappings: mappings.length,
      coachValidatedMappings: mappings.filter(
        (mapping) => mapping.validationState === "COACH_VALIDATED",
      ).length,
      unvalidatedMappings: mappings.filter(
        (mapping) => mapping.validationState !== "COACH_VALIDATED",
      ).length,
      totalEndorsements: mappings.reduce((sum, mapping) => sum + mapping.endorsements.length, 0),
      mappingsNeedingEvidence: needing.map((mapping) => mapping.mappingId).sort(),
    },
  };
}

/* ------------------------------------------------------------------------ *
 * PROMOTION AUTHORITY — engineering can never promote sports-science truth
 * ------------------------------------------------------------------------ */

/** Violations mean someone (or some code path) tried to promote coach-owned
 * truth without coach evidence. An empty list is NOT permission to release —
 * release still requires the frozen gates to be RELEASABLE on real evidence. */
export function enforceNoEngineeringPromotion(report: CoachGatesReport): string[] {
  const violations: string[] = [];
  const lockIds = LOCK_GATE_IDS as readonly string[];
  const zeroEvidence = report.evidenceCounts.countedReviews === 0;
  for (const gate of report.gates) {
    if (lockIds.includes(gate.id)) continue;
    if (zeroEvidence && gate.verdict !== "NOT_EVALUABLE") {
      violations.push(
        `gate ${gate.id} is ${gate.verdict} with zero counted coach reviews — validation gates must stay NOT_EVALUABLE until real coach evidence exists`,
      );
    }
  }
  for (const [surface, result] of Object.entries(report.surfaces)) {
    if (zeroEvidence && result.verdict === "RELEASABLE") {
      violations.push(
        `surface ${surface} is RELEASABLE with zero counted coach reviews — engineering alone can never promote`,
      );
    }
  }
  if (zeroEvidence && report.overallVerdict === "RELEASABLE") {
    violations.push("overall verdict RELEASABLE with zero counted coach reviews");
  }
  return violations;
}

export interface PromotionDecision {
  canPromote: boolean;
  reason: string;
  violations: string[];
}

/** The single sanctioned promotion check: real coach evidence AND all frozen
 * gates RELEASABLE AND no promotion-authority violations. */
export function promotionDecision(report: CoachGatesReport): PromotionDecision {
  const violations = enforceNoEngineeringPromotion(report);
  if (violations.length > 0) {
    return {
      canPromote: false,
      reason: "promotion-authority violations detected — see violations",
      violations,
    };
  }
  if (report.evidenceCounts.countedReviews === 0) {
    return {
      canPromote: false,
      reason:
        "zero counted coach reviews — sports-science truth can only be promoted by real coach evidence; engineering work only adds review-queue items",
      violations,
    };
  }
  if (report.overallVerdict !== "RELEASABLE") {
    return {
      canPromote: false,
      reason: `frozen coach gates verdict is ${report.overallVerdict}`,
      violations,
    };
  }
  return {
    canPromote: true,
    reason: "all frozen coach gates RELEASABLE on real coach evidence",
    violations,
  };
}

/* ------------------------------------------------------------------------ *
 * REPORT ASSEMBLY + CLI
 * ------------------------------------------------------------------------ */

export interface ProgramOpsReport {
  version: typeof PROGRAM_OPS_VERSION;
  generatedAtIso: string;
  status: string;
  routing: {
    context: {
      currentAnalysisVersions: Record<string, string>;
      currentFaultTaxonomyVersion: string;
      mappingsNeedingEvidence: string[];
    };
    routedItems: RoutedQueueItem[];
  };
  tracking: ProgramOpsTracking;
  gates: {
    specId: CoachGatesReport["specId"];
    overallVerdict: CoachGatesReport["overallVerdict"];
    verdicts: Array<{ id: string; verdict: string }>;
  };
  promotion: PromotionDecision;
}

interface QueueFile {
  queue: Array<
    RoutableQueueItem & {
      video: string;
    }
  >;
}

export function runProgramOps(
  repoRoot: string = REPO_ROOT,
  nowIso: string = new Date().toISOString(),
  currentAnalysisVersions: Record<string, string> = {},
): ProgramOpsReport {
  const queuePath = join(repoRoot, "datasets/coach-review/queue.json");
  const queueItems = existsSync(queuePath)
    ? (JSON.parse(readFileSync(queuePath, "utf8")) as QueueFile).queue
    : [];
  const evidence = collectCoachEvidence(repoRoot);
  const gatesReport = runCoachGates(repoRoot);
  const needing = mappingsNeedingEvidence(FAULT_DRILL_MAPPINGS_V1);
  const context: RoutingContext = {
    currentAnalysisVersions,
    currentFaultTaxonomyVersion: FAULT_TAXONOMY_V0_DRAFT_VERSION,
    mappingsNeedingEvidence: needing,
  };
  const routedItems = routeReviewQueue(queueItems, evidence.countedReviews, context);
  const agreement = computeAgreement(
    { reviews: evidence.countedReviews, rejected: [], provenance: "production" },
    nowIso,
  );
  const tracking = trackProgramOps(
    evidence.countedReviews,
    {
      reviewFileCount: evidence.reviewFileCount,
      invalidReviewFiles: evidence.invalidReviewFiles.length,
      heldOutReviewsExcluded: evidence.heldOutReviewsExcluded,
    },
    agreement,
    FAULT_DRILL_MAPPINGS_V1,
    FAULT_TAXONOMY_V0_DRAFT_VERSION,
  );
  const promotion = promotionDecision(gatesReport);
  return {
    version: PROGRAM_OPS_VERSION,
    generatedAtIso: nowIso,
    status:
      evidence.countedReviews.length === 0
        ? "AWAITING QUALIFIED COACHES — routing/tracking operational; zero counted reviews; all validation gates NOT_EVALUABLE; promotion impossible"
        : `${evidence.countedReviews.length} counted coach reviews — routing/tracking measured on real evidence`,
    routing: {
      context: {
        currentAnalysisVersions,
        currentFaultTaxonomyVersion: FAULT_TAXONOMY_V0_DRAFT_VERSION,
        mappingsNeedingEvidence: needing.map((mapping) => mapping.mappingId).sort(),
      },
      routedItems,
    },
    tracking,
    gates: {
      specId: gatesReport.specId,
      overallVerdict: gatesReport.overallVerdict,
      verdicts: gatesReport.gates.map((gate) => ({ id: gate.id, verdict: gate.verdict })),
    },
    promotion,
  };
}

const isMain = process.argv[1]?.endsWith("coachProgramOps.ts");
if (isMain) {
  const report = runProgramOps();
  const outDir = join(REPO_ROOT, PROGRAM_OPS_DIR);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "program-ops-report.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `program ops: ${report.routing.routedItems.length} routed queue items, ` +
      `${report.tracking.reviewCounts.totalCounted} counted reviews, ` +
      `gates ${report.gates.overallVerdict}, promotion ${report.promotion.canPromote ? "POSSIBLE" : "IMPOSSIBLE"} → ${outPath}`,
  );
  console.log(`status: ${report.status}`);
  if (report.promotion.violations.length > 0) {
    for (const violation of report.promotion.violations) console.error(`VIOLATION: ${violation}`);
    process.exitCode = 1;
  }
}
