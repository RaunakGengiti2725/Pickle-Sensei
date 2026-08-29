import { describe, expect, it } from "vitest";
import {
  LOCK_GATE_IDS,
  ROUTING_REASONS,
  enforceNoEngineeringPromotion,
  isHeldOutCase,
  mappingsNeedingEvidence,
  promotionDecision,
  routeReviewQueue,
  runProgramOps,
  trackProgramOps,
  type RoutableQueueItem,
  type RoutingContext,
} from "../src/coachProgramOps.js";
import { runCoachGates, type CoachGatesReport } from "../src/coachGates.js";
import { computeAgreement } from "../src/coachAgreement.js";
import {
  COACH_REVIEW_SCHEMA_VERSION,
  FAULT_TAXONOMY_V0_DRAFT_VERSION,
  TECHNIQUE_QUALITY_SCALE_V1,
  reviewIdFor,
  type CoachReview,
} from "../src/coachReview.js";
import { FAULT_DRILL_MAPPINGS_V1, type FaultDrillMappingV1 } from "../src/drillLibrary.js";

/** Structurally valid in-memory review used ONLY to exercise routing logic.
 * Never written to disk; never enters any production artifact. */
function reviewFixture(
  queueItemId: string,
  caseId: string,
  eventIndex: number,
  coachId: string,
  overrides: Partial<CoachReview> = {},
): CoachReview {
  return {
    schemaVersion: COACH_REVIEW_SCHEMA_VERSION,
    reviewId: reviewIdFor(queueItemId, coachId),
    queueItemId,
    coachId,
    coachCredentialRef: "cred-off-repo-001",
    eventRef: { caseId, eventIndex },
    strokeTaxonomyVersion: "pickleball-stroke-taxonomy-v3",
    faultTaxonomyVersion: FAULT_TAXONOMY_V0_DRAFT_VERSION,
    drillLibraryVersion: null,
    strokeConfirmation: { kind: "confirmed", stroke: "FOREHAND_DRIVE" },
    overallQuality: { scaleId: TECHNIQUE_QUALITY_SCALE_V1.id, value: 3 },
    phaseEvaluations: [{ phaseId: "preparation", assessment: "good", note: "fixture note" }],
    primaryFaultId: null,
    faults: [],
    drillSuggestions: [],
    confidence: 0.8,
    cannotEvaluate: null,
    rationale: "Test-only structural fixture for routing logic; never persisted.",
    provenance: {
      coachQualificationSnapshot: {
        coachId,
        credentialRef: "cred-off-repo-001",
        registryStatus: "active",
        provisionedAtIso: "2026-08-01T00:00:00.000Z",
        provisionedBy: "test-fixture-admin",
        snapshotAtIso: "2026-08-29T00:00:00.000Z",
      },
      videoRef: { path: "fixtures/none.mp4", annotatorId: null, annotationRevision: null },
      analysisVersions: {},
      rawLabelsShown: null,
      adjudicationState: "unadjudicated",
    },
    createdAtIso: "2026-08-29T00:00:00.000Z",
    submittedAtIso: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function queueItemFixture(
  queueItemId: string,
  caseId: string,
  overrides: Partial<RoutableQueueItem> = {},
): RoutableQueueItem {
  return {
    queueItemId,
    eventRef: { caseId, eventIndex: 0 },
    annotatedStrokeV3: "FOREHAND_DRIVE",
    strokeFamily: "drive",
    requiredReviewsTarget: 2,
    bundle: {
      analyzable: true,
      annotatorConfidence: 0.9,
      contactUncertainty: "exact",
      notAnalyzableReason: null,
    },
    ...overrides,
  };
}

const EMPTY_CONTEXT: RoutingContext = {
  currentAnalysisVersions: {},
  currentFaultTaxonomyVersion: FAULT_TAXONOMY_V0_DRAFT_VERSION,
  mappingsNeedingEvidence: [],
};

describe("review-queue routing", () => {
  it("routes every under-reviewed item for baseline_coverage with zero coaches", () => {
    const items = [
      queueItemFixture("case-a-E1", "case-a"),
      queueItemFixture("case-b-E1", "case-b"),
    ];
    const routed = routeReviewQueue(items, [], EMPTY_CONTEXT);
    expect(routed).toHaveLength(2);
    for (const item of routed) {
      expect(item.reasons).toEqual(["baseline_coverage"]);
      expect(item.countedReviews).toBe(0);
      expect(item.requiredAdditionalReviews).toBe(2);
    }
  });

  it("is deterministic: identical inputs produce identical routed queues", () => {
    const items = [
      queueItemFixture("case-b-E1", "case-b"),
      queueItemFixture("case-a-E1", "case-a", {
        bundle: {
          analyzable: false,
          annotatorConfidence: 0.9,
          contactUncertainty: "exact",
          notAnalyzableReason: "cropped",
        },
      }),
    ];
    const reviews = [reviewFixture("case-b-E1", "case-b", 0, "coach-real-01")];
    const first = routeReviewQueue(items, reviews, EMPTY_CONTEXT);
    const second = routeReviewQueue([...items].reverse(), [...reviews], EMPTY_CONTEXT);
    expect(second).toEqual(first);
  });

  it("routes hard cases from bundle signals and coach cannot-evaluate", () => {
    const items = [
      queueItemFixture("case-a-E1", "case-a", {
        bundle: {
          analyzable: true,
          annotatorConfidence: 0.5,
          contactUncertainty: "exact",
          notAnalyzableReason: null,
        },
      }),
      queueItemFixture("case-b-E1", "case-b"),
    ];
    const declined = reviewFixture("case-b-E1", "case-b", 0, "coach-real-01", {
      overallQuality: null,
      phaseEvaluations: [],
      cannotEvaluate: { reason: "camera angle hides the contact point entirely" },
      rationale: "",
    });
    const routed = routeReviewQueue(items, [declined], EMPTY_CONTEXT);
    expect(routed.find((r) => r.queueItemId === "case-a-E1")?.reasons).toContain("hard_case");
    expect(routed.find((r) => r.queueItemId === "case-b-E1")?.reasons).toContain("hard_case");
  });

  it("routes model/coach disagreement when a coach corrects the shown stroke", () => {
    const corrected = reviewFixture("case-a-E1", "case-a", 0, "coach-real-01", {
      strokeConfirmation: {
        kind: "corrected",
        stroke: "BACKHAND_DRIVE",
        note: "clearly a backhand from the grip",
      },
    });
    const routed = routeReviewQueue(
      [queueItemFixture("case-a-E1", "case-a")],
      [corrected],
      EMPTY_CONTEXT,
    );
    expect(routed[0]!.reasons[0]).toBe("model_coach_disagreement");
    expect(routed[0]!.priority).toBe(0);
  });

  it("routes new_model_version when reviews were made under superseded analysis versions", () => {
    const stale = reviewFixture("case-a-E1", "case-a", 0, "coach-real-01", {
      provenance: {
        ...reviewFixture("case-a-E1", "case-a", 0, "coach-real-01").provenance,
        analysisVersions: { "stroke-heuristic": "v5" },
      },
    });
    const context: RoutingContext = {
      ...EMPTY_CONTEXT,
      currentAnalysisVersions: { "stroke-heuristic": "v7" },
    };
    const routed = routeReviewQueue([queueItemFixture("case-a-E1", "case-a")], [stale], context);
    expect(routed[0]!.reasons).toContain("new_model_version");
    // stale review does not satisfy fresh coverage
    expect(routed[0]!.freshReviews).toBe(0);
    expect(routed[0]!.requiredAdditionalReviews).toBe(2);
  });

  it("routes taxonomy_change when a review references a superseded fault taxonomy", () => {
    const stale = reviewFixture("case-a-E1", "case-a", 0, "coach-real-01");
    const context: RoutingContext = {
      ...EMPTY_CONTEXT,
      currentFaultTaxonomyVersion: "fault-taxonomy-v1",
    };
    const routed = routeReviewQueue([queueItemFixture("case-a-E1", "case-a")], [stale], context);
    expect(routed[0]!.reasons).toContain("taxonomy_change");
    expect(routed[0]!.freshReviews).toBe(0);
  });

  it("routes drill_mapping_evidence to matching stroke families but never to held-out items", () => {
    const mapping = FAULT_DRILL_MAPPINGS_V1.find((m) => m.strokeFamilies.includes("dink"));
    expect(mapping).toBeDefined();
    const context: RoutingContext = {
      ...EMPTY_CONTEXT,
      mappingsNeedingEvidence: [mapping!],
    };
    const items = [
      queueItemFixture("case-a-E1", "case-a", { strokeFamily: "dink" }),
      queueItemFixture("wm-dink-01-E1", "wm-dink-01", { strokeFamily: "dink" }),
    ];
    const routed = routeReviewQueue(items, [], context);
    const normal = routed.find((r) => r.queueItemId === "case-a-E1")!;
    const heldOut = routed.find((r) => r.queueItemId === "wm-dink-01-E1")!;
    expect(normal.reasons).toContain("drill_mapping_evidence");
    expect(heldOut.heldOut).toBe(true);
    expect(heldOut.reasons).not.toContain("drill_mapping_evidence");
  });

  it("drops items that are fully covered by fresh reviews with no other reason", () => {
    const reviews = [
      reviewFixture("case-a-E1", "case-a", 0, "coach-real-01"),
      reviewFixture("case-a-E1", "case-a", 0, "coach-real-02"),
    ];
    const routed = routeReviewQueue(
      [queueItemFixture("case-a-E1", "case-a")],
      reviews,
      EMPTY_CONTEXT,
    );
    expect(routed).toHaveLength(0);
  });

  it("held-out detection matches the frozen holdout list", () => {
    expect(isHeldOutCase("wm-dink-01")).toBe(true);
    expect(isHeldOutCase("afn-vic-rally1")).toBe(true);
    expect(isHeldOutCase("case-a")).toBe(false);
  });

  it("priority order puts disagreement above hard cases above coverage", () => {
    expect(ROUTING_REASONS.indexOf("model_coach_disagreement")).toBeLessThan(
      ROUTING_REASONS.indexOf("hard_case"),
    );
    expect(ROUTING_REASONS.indexOf("hard_case")).toBeLessThan(
      ROUTING_REASONS.indexOf("baseline_coverage"),
    );
  });
});

describe("program tracking", () => {
  it("tracks counts, overlap, taxonomy versions, and drill evidence honestly at N=0", () => {
    const agreement = computeAgreement(
      { reviews: [], rejected: [], provenance: "production" },
      "2026-08-29T00:00:00.000Z",
    );
    const tracking = trackProgramOps(
      [],
      { reviewFileCount: 0, invalidReviewFiles: 0, heldOutReviewsExcluded: 0 },
      agreement,
      FAULT_DRILL_MAPPINGS_V1,
      FAULT_TAXONOMY_V0_DRAFT_VERSION,
    );
    expect(tracking.reviewCounts.totalCounted).toBe(0);
    expect(tracking.multiCoachOverlap.itemsWithMultipleCoaches).toBe(0);
    expect(tracking.agreement.strokeIdentityPercentAgreement).toBeNull();
    expect(tracking.agreement.primaryFaultPercentAgreement).toBeNull();
    expect(tracking.taxonomy.reviewsOnCurrentTaxonomy).toBe(0);
    // every seeded mapping is UNVALIDATED with zero endorsements
    expect(tracking.drillEvidence.coachValidatedMappings).toBe(0);
    expect(tracking.drillEvidence.totalEndorsements).toBe(0);
    expect(tracking.drillEvidence.mappingsNeedingEvidence.length).toBe(
      tracking.drillEvidence.totalMappings,
    );
  });

  it("tracks multi-coach overlap and per-coach counts on fixtures", () => {
    const reviews = [
      reviewFixture("case-a-E1", "case-a", 0, "coach-real-01"),
      reviewFixture("case-a-E1", "case-a", 0, "coach-real-02"),
      reviewFixture("case-b-E1", "case-b", 0, "coach-real-01"),
    ];
    const agreement = computeAgreement(
      { reviews, rejected: [], provenance: "production" },
      "2026-08-29T00:00:00.000Z",
    );
    const tracking = trackProgramOps(
      reviews,
      { reviewFileCount: 3, invalidReviewFiles: 0, heldOutReviewsExcluded: 0 },
      agreement,
      FAULT_DRILL_MAPPINGS_V1,
      FAULT_TAXONOMY_V0_DRAFT_VERSION,
    );
    expect(tracking.reviewCounts.totalCounted).toBe(3);
    expect(tracking.reviewCounts.perCoach).toEqual([
      { coachId: "coach-real-01", reviews: 2 },
      { coachId: "coach-real-02", reviews: 1 },
    ]);
    expect(tracking.multiCoachOverlap.itemsWithMultipleCoaches).toBe(1);
    expect(tracking.multiCoachOverlap.distinctCoachPairs).toBe(1);
    expect(tracking.reviewCounts.perItemHistogram).toEqual({ "1": 1, "2": 1 });
  });

  it("mappingsNeedingEvidence flags every mapping short of independent endorsements", () => {
    const needing = mappingsNeedingEvidence(FAULT_DRILL_MAPPINGS_V1);
    expect(needing.length).toBe(FAULT_DRILL_MAPPINGS_V1.length);
    const validated: FaultDrillMappingV1 = {
      ...FAULT_DRILL_MAPPINGS_V1[0]!,
      validationState: "COACH_VALIDATED",
      evidenceTier: "GOLD",
      endorsements: [
        {
          coachId: "coach-real-01",
          coachCredentialRef: "cred-1",
          reviewRef: "datasets/coach-review/reviews/x.coach-real-01.json",
          endorsedAtIso: "2026-08-29T00:00:00.000Z",
        },
        {
          coachId: "coach-real-02",
          coachCredentialRef: "cred-2",
          reviewRef: "datasets/coach-review/reviews/x.coach-real-02.json",
          endorsedAtIso: "2026-08-29T00:00:00.000Z",
        },
      ],
      agreement: { endorsed: 2, asked: 2, fraction: 1 },
    };
    expect(mappingsNeedingEvidence([validated])).toHaveLength(0);
  });
});

describe("promotion authority — engineering alone can never promote", () => {
  it("real repo: all validation gates NOT_EVALUABLE, promotion impossible, zero violations", () => {
    const report = runCoachGates();
    expect(report.evidenceCounts.countedReviews).toBe(0);
    for (const gate of report.gates) {
      if ((LOCK_GATE_IDS as readonly string[]).includes(gate.id)) continue;
      expect(gate.verdict).toBe("NOT_EVALUABLE");
    }
    expect(enforceNoEngineeringPromotion(report)).toEqual([]);
    const decision = promotionDecision(report);
    expect(decision.canPromote).toBe(false);
    expect(decision.reason).toMatch(/zero counted coach reviews/);
  });

  it("flags a validation gate that PASSes with zero coach evidence as a violation", () => {
    const report = runCoachGates();
    const tampered: CoachGatesReport = {
      ...report,
      gates: report.gates.map((gate) =>
        gate.id === "S1" ? { ...gate, verdict: "PASS" as const } : gate,
      ),
    };
    const violations = enforceNoEngineeringPromotion(tampered);
    expect(violations.some((v) => v.includes("gate S1 is PASS"))).toBe(true);
    expect(promotionDecision(tampered).canPromote).toBe(false);
  });

  it("flags a surface flipped RELEASABLE with zero coach evidence as a violation", () => {
    const report = runCoachGates();
    const tampered: CoachGatesReport = {
      ...report,
      surfaces: {
        ...report.surfaces,
        technique_score: {
          ...report.surfaces["technique_score"]!,
          verdict: "RELEASABLE" as const,
        },
      },
      overallVerdict: "RELEASABLE" as const,
    };
    const violations = enforceNoEngineeringPromotion(tampered);
    expect(violations.some((v) => v.includes("surface technique_score"))).toBe(true);
    expect(violations.some((v) => v.includes("overall verdict RELEASABLE"))).toBe(true);
    expect(promotionDecision(tampered).canPromote).toBe(false);
  });

  it("even with all gates green, promotion is refused when counted reviews are zero", () => {
    const report = runCoachGates();
    const allGreen: CoachGatesReport = {
      ...report,
      gates: report.gates.map((gate) => ({ ...gate, verdict: "PASS" as const })),
      surfaces: Object.fromEntries(
        Object.entries(report.surfaces).map(([surface, result]) => [
          surface,
          { ...result, verdict: "RELEASABLE" as const },
        ]),
      ),
      overallVerdict: "RELEASABLE" as const,
    };
    const decision = promotionDecision(allGreen);
    expect(decision.canPromote).toBe(false);
    expect(decision.violations.length).toBeGreaterThan(0);
  });
});

describe("end-to-end ops run on the real repo (zero coach data)", () => {
  const report = runProgramOps(undefined, "2026-08-29T00:00:00.000Z");

  it("reports AWAITING QUALIFIED COACHES with routing operational", () => {
    expect(report.status).toMatch(/AWAITING QUALIFIED COACHES/);
    expect(report.tracking.reviewCounts.totalCounted).toBe(0);
    expect(report.routing.routedItems.length).toBeGreaterThan(0);
    for (const item of report.routing.routedItems) {
      expect(item.reasons).toContain("baseline_coverage");
    }
  });

  it("gates stay RELEASE_BLOCKED and promotion is impossible", () => {
    expect(report.gates.overallVerdict).toBe("RELEASE_BLOCKED");
    expect(report.promotion.canPromote).toBe(false);
    expect(report.promotion.violations).toEqual([]);
  });

  it("drill evidence tracking shows zero validated mappings and zero endorsements", () => {
    expect(report.tracking.drillEvidence.coachValidatedMappings).toBe(0);
    expect(report.tracking.drillEvidence.totalEndorsements).toBe(0);
  });
});
