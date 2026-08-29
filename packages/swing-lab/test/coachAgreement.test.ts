import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cohenKappa,
  weightedKappa,
  fleissKappa,
  icc2_1,
  spearman,
  jaccard,
  planAssignments,
  primaryFault,
  strokeVerdict,
  computeAgreement,
  loadProductionReviews,
  loadExampleReviews,
  isSyntheticIdentity,
  EXAMPLE_REVIEWS_PATH,
  type LoadedReviews,
} from "../src/coachAgreement.js";
import type { CoachReview } from "../src/coachReview.js";

/* ------------------------------------------------------------------------ *
 * statistics — hand-computed fixtures
 * ------------------------------------------------------------------------ */

describe("cohenKappa", () => {
  it("matches a hand-computed value", () => {
    // observed = 3/4; expected = .5*.25 + .5*.75 = .5; kappa = .25/.5 = .5
    const { observedAgreement, expectedAgreement, kappa } = cohenKappa([
      ["x", "x"],
      ["x", "y"],
      ["y", "y"],
      ["y", "y"],
    ]);
    expect(observedAgreement).toBeCloseTo(0.75, 10);
    expect(expectedAgreement).toBeCloseTo(0.5, 10);
    expect(kappa).toBeCloseTo(0.5, 10);
  });

  it("is null (not fabricated) with <2 pairs or no variation", () => {
    expect(cohenKappa([["a", "a"]]).kappa).toBeNull();
    expect(
      cohenKappa([
        ["a", "a"],
        ["a", "a"],
      ]).kappa,
    ).toBeNull(); // expected agreement 1 → undefined
  });
});

describe("weightedKappa (linear, ordinal)", () => {
  it("is 1 for perfect agreement with variation", () => {
    const { kappa } = weightedKappa(
      [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      [1, 2, 3],
    );
    expect(kappa).toBeCloseTo(1, 10);
  });

  it("matches a hand-computed value", () => {
    // Po_w = (1 + .5 + 1)/3 = .8333…; Pe_w = .5; kappa = 2/3
    const { kappa } = weightedKappa(
      [
        [1, 1],
        [1, 2],
        [3, 3],
      ],
      [1, 2, 3],
    );
    expect(kappa).toBeCloseTo(2 / 3, 10);
  });
});

describe("fleissKappa", () => {
  it("matches a hand-computed value", () => {
    // Pbar = .75; category marginals a=3/8, b=5/8 → Pe = 34/64; kappa = .4666…
    const { kappa, items, ratersPerItem } = fleissKappa([
      ["a", "a"],
      ["a", "b"],
      ["b", "b"],
      ["b", "b"],
    ]);
    expect(items).toBe(4);
    expect(ratersPerItem).toBe(2);
    expect(kappa).toBeCloseTo((0.75 - 34 / 64) / (1 - 34 / 64), 10);
  });

  it("is null with unequal rater counts or <2 items", () => {
    expect(
      fleissKappa([
        ["a", "a"],
        ["a", "b", "b"],
      ]).kappa,
    ).toBeNull();
    expect(fleissKappa([["a", "b"]]).kappa).toBeNull();
  });
});

describe("icc2_1", () => {
  it("matches the Shrout & Fleiss (1979) worked example", () => {
    // 6 targets × 4 judges; published ICC(2,1) = 0.29
    const matrix = [
      [9, 2, 5, 8],
      [6, 1, 3, 2],
      [8, 4, 6, 8],
      [7, 1, 2, 6],
      [10, 5, 6, 9],
      [6, 2, 4, 7],
    ];
    const { icc } = icc2_1(matrix);
    expect(icc).toBeCloseTo(0.29, 2);
  });

  it("is 1 for identical raters with between-item variance", () => {
    const { icc } = icc2_1([
      [1, 1],
      [5, 5],
      [3, 3],
    ]);
    expect(icc).toBeCloseTo(1, 10);
  });

  it("is null with <2 items or <2 raters", () => {
    expect(icc2_1([[1, 2]]).icc).toBeNull();
    expect(icc2_1([[1], [2]]).icc).toBeNull();
  });
});

describe("spearman", () => {
  it("is 1 for a monotonic relation and -1 when reversed", () => {
    expect(
      spearman([
        [1, 2],
        [2, 4],
        [3, 5],
      ]).rho,
    ).toBeCloseTo(1, 10);
    expect(
      spearman([
        [1, 5],
        [2, 4],
        [3, 2],
      ]).rho,
    ).toBeCloseTo(-1, 10);
  });

  it("uses average ranks for ties and is null with zero variance", () => {
    // A: [1,1,2] → ranks [1.5, 1.5, 3]; B: [2,3,4] → [1,2,3]
    // cov = 1.125, sd = sqrt(1.5)*sqrt(2) → rho = 0.8660…
    expect(
      spearman([
        [1, 2],
        [1, 3],
        [2, 4],
      ]).rho,
    ).toBeCloseTo(Math.sqrt(3) / 2, 10);
    expect(
      spearman([
        [2, 1],
        [2, 3],
      ]).rho,
    ).toBeNull();
  });
});

describe("jaccard", () => {
  it("computes overlap and is null for two empty sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3, 10);
    expect(jaccard(new Set(), new Set())).toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * blind assignment planner
 * ------------------------------------------------------------------------ */

describe("planAssignments", () => {
  it("is deterministic, balanced, and never assigns the same coach twice per item", () => {
    const items = ["i1", "i2", "i3", "i4", "i5"];
    const coaches = ["coach-a", "coach-b", "coach-c"];
    const first = planAssignments(items, coaches, 2);
    const second = planAssignments([...items].reverse(), [...coaches].reverse(), 2);
    expect(first.feasible).toBe(true);
    expect(first.plan).toEqual(second.plan);
    const load = new Map<string, number>();
    for (const entry of first.plan) {
      expect(new Set(entry.coachIds).size).toBe(2);
      expect(entry.blindProtocol).toContain("independent");
      for (const coachId of entry.coachIds) load.set(coachId, (load.get(coachId) ?? 0) + 1);
    }
    const loads = [...load.values()];
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
  });

  it("reports infeasibility honestly instead of inventing coaches", () => {
    const { feasible, plan, reason } = planAssignments(["i1"], ["only-one"], 2);
    expect(feasible).toBe(false);
    expect(plan).toEqual([]);
    expect(reason).toContain("registry has 1");
  });
});

/* ------------------------------------------------------------------------ *
 * review fixtures for agreement computation
 * ------------------------------------------------------------------------ */

function review(overrides: Partial<CoachReview> & { coachId: string; item: string }): CoachReview {
  const { item, ...rest } = overrides;
  const base: CoachReview = {
    schemaVersion: 2,
    reviewId: `${item}.${overrides.coachId}`,
    queueItemId: item,
    coachId: overrides.coachId,
    coachCredentialRef: "cred-test",
    eventRef: { caseId: item.replace(/-E\d+$/, ""), eventIndex: 0 },
    strokeTaxonomyVersion: "pickleball-stroke-taxonomy-v3",
    faultTaxonomyVersion: "fault-taxonomy-v0-draft",
    drillLibraryVersion: "drill-library-v0",
    strokeConfirmation: { kind: "confirmed", stroke: "FOREHAND_DINK" },
    overallQuality: { scaleId: "technique-quality-5pt-v1", value: 3 },
    faults: [],
    drillSuggestions: [],
    confidence: 0.8,
    cannotEvaluate: null,
    rationale: "test fixture rationale long enough to pass validation",
    createdAtIso: "2026-08-29T00:00:00.000Z",
    submittedAtIso: "2026-08-29T00:00:00.000Z",
  };
  return { ...base, ...rest };
}

function loaded(reviews: CoachReview[]): LoadedReviews {
  return { reviews, rejected: [], provenance: "production" };
}

const NOW = "2026-08-29T12:00:00.000Z";

describe("computeAgreement", () => {
  it("emits an honest N=0 report with every metric null", () => {
    const report = computeAgreement(loaded([]), NOW);
    expect(report.realReviewCount).toBe(0);
    expect(report.status).toContain("N=0 real reviews");
    expect(report.banner).toContain("N=0 REAL COACH REVIEWS");
    expect(report.strokeIdentity.fleiss.kappa).toBeNull();
    expect(report.strokeIdentity.percentAgreementItems).toBeNull();
    expect(report.primaryFault.fleiss.kappa).toBeNull();
    expect(report.techniqueRating.icc2_1.icc).toBeNull();
    expect(report.strokeIdentity.pairwiseCohen).toEqual([]);
    expect(report.disagreements).toEqual([]);
  });

  it("surfaces every disagreement dimension without collapsing", () => {
    const reviews = [
      review({
        coachId: "coach-a",
        item: "case-1-E1",
        strokeConfirmation: { kind: "confirmed", stroke: "FOREHAND_DRIVE" },
        overallQuality: { scaleId: "technique-quality-5pt-v1", value: 2 },
        faults: [
          {
            faultId: "drive.arm_only_power",
            severity: 3,
            evidence: { timestampsMs: [100], region: null },
            rationale: "fixture rationale text",
          },
        ],
        drillSuggestions: [{ drillId: "drill.skinny-singles", freeText: "" }],
      }),
      review({
        coachId: "coach-b",
        item: "case-1-E1",
        strokeConfirmation: { kind: "confirmed", stroke: "BACKHAND_DRIVE" },
        overallQuality: { scaleId: "technique-quality-5pt-v1", value: 4 },
        faults: [
          {
            faultId: "drive.late_preparation",
            severity: 1,
            evidence: { timestampsMs: [90], region: null },
            rationale: "fixture rationale text",
          },
        ],
        drillSuggestions: [{ drillId: "drill.wall-dink-rally", freeText: "" }],
      }),
      review({ coachId: "coach-a", item: "case-2-E1" }),
      review({
        coachId: "coach-b",
        item: "case-2-E1",
        strokeConfirmation: { kind: "cannot_judge", reason: "fixture angle reason" },
        cannotEvaluate: { reason: "fixture cannot-evaluate reason" },
        overallQuality: null,
        rationale: "",
      }),
    ];
    const report = computeAgreement(loaded(reviews), NOW);
    const dimensions = report.disagreements.map((d) => d.dimension).sort();
    expect(dimensions).toEqual([
      "cannot_evaluate_split",
      "drill_selection",
      "primary_fault",
      "stroke_identity",
      "stroke_identity",
      "technique_rating",
    ]);
    const strokeRows = report.disagreements.filter((d) => d.dimension === "stroke_identity");
    // per-coach verdicts preserved verbatim — nothing averaged away
    expect(strokeRows[0]!.perCoach).toEqual([
      { coachId: "coach-a", verdict: "FOREHAND_DRIVE" },
      { coachId: "coach-b", verdict: "BACKHAND_DRIVE" },
    ]);
    expect(report.cannotEvaluate.splitItems).toBe(1);
    expect(report.cannotEvaluate.perCoach.find((c) => c.coachId === "coach-b")!.rate).toBe(0.5);
  });

  it("computes pairwise and pooled agreement on agreeing reviews", () => {
    const reviews = ["case-1-E1", "case-2-E1", "case-3-E1"].flatMap((item, index) => {
      const stroke = index === 0 ? "FOREHAND_DINK" : "SERVE";
      const value = (index + 1) as 1 | 2 | 3 satisfies 1 | 2 | 3;
      return ["coach-a", "coach-b"].map((coachId) =>
        review({
          coachId,
          item,
          strokeConfirmation: { kind: "confirmed", stroke },
          overallQuality: { scaleId: "technique-quality-5pt-v1", value },
        }),
      );
    });
    const report = computeAgreement(loaded(reviews), NOW);
    expect(report.itemsWithMultipleReviews).toBe(3);
    expect(report.strokeIdentity.percentAgreementItems).toBe(1);
    expect(report.strokeIdentity.pairwiseCohen[0]!.kappa).toBeCloseTo(1, 10);
    expect(report.strokeIdentity.fleiss.kappa).toBeCloseTo(1, 10);
    expect(report.techniqueRating.icc2_1.icc).toBeCloseTo(1, 10);
    expect(report.techniqueRating.pairwiseExactAgreement[0]!.exactAgreement).toBe(1);
    expect(report.techniqueRating.calibration.map((c) => c.meanOffsetFromItemMean)).toEqual([0, 0]);
    expect(report.disagreements).toEqual([]);
  });

  it("treats cannot-judge as a real stroke category and compares severity only on the same primary fault", () => {
    const fault = (severity: 1 | 2 | 3) => ({
      faultId: "dink.wristy_flick",
      severity,
      evidence: { timestampsMs: [10], region: null },
      rationale: "fixture rationale text",
    });
    const reviews = [
      review({ coachId: "coach-a", item: "case-1-E1", faults: [fault(2)] }),
      review({ coachId: "coach-b", item: "case-1-E1", faults: [fault(3)] }),
    ];
    const report = computeAgreement(loaded(reviews), NOW);
    expect(report.severity.pairwiseWeightedKappa[0]!.comparablePairs).toBe(1);
    expect(report.disagreements.some((d) => d.dimension === "severity")).toBe(true);
    expect(
      strokeVerdict(
        review({
          coachId: "x",
          item: "i",
          strokeConfirmation: { kind: "cannot_judge", reason: "angle bad" },
        }),
      ),
    ).toBe("CANNOT_JUDGE");
  });
});

describe("primaryFault", () => {
  it("is the coach's FIRST listed fault (priority order), CLEAN when none", () => {
    const twoFaults = review({
      coachId: "c",
      item: "i",
      faults: [
        {
          faultId: "dink.backswing_too_big",
          severity: 1,
          evidence: { timestampsMs: [1], region: null },
          rationale: "fixture rationale",
        },
        {
          faultId: "dink.wristy_flick",
          severity: 3,
          evidence: { timestampsMs: [2], region: null },
          rationale: "fixture rationale",
        },
      ],
    });
    expect(primaryFault(twoFaults)).toBe("dink.backswing_too_big");
    expect(primaryFault(review({ coachId: "c", item: "i" }))).toBe("CLEAN");
  });
});

/* ------------------------------------------------------------------------ *
 * loaders — synthetic containment
 * ------------------------------------------------------------------------ */

describe("synthetic containment", () => {
  it("production loader rejects synthetic identities so example data can never become gold", () => {
    const dir = mkdtempSync(join(tmpdir(), "coach-agreement-"));
    const reviewsDir = join(dir, "reviews");
    mkdirSync(reviewsDir);
    const synthetic = review({ coachId: "SYNTHETIC-coach-a", item: "case-1-E1" });
    synthetic.reviewId = "case-1-E1.SYNTHETIC-coach-a";
    writeFileSync(join(reviewsDir, "case-1-E1.SYNTHETIC-coach-a.json"), JSON.stringify(synthetic));
    const result = loadProductionReviews(reviewsDir);
    expect(result.reviews).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.problems.join(" ")).toMatch(/synthetic/i);
  });

  it("example loader refuses files without the NOT_GOLD marker and non-synthetic identities", () => {
    const dir = mkdtempSync(join(tmpdir(), "coach-agreement-"));
    const unmarked = join(dir, "unmarked.json");
    writeFileSync(unmarked, JSON.stringify({ reviews: [] }));
    expect(() => loadExampleReviews(unmarked)).toThrow(/NOT_GOLD_SYNTHETIC_EXAMPLE/);

    const realIdentity = join(dir, "real-identity.json");
    writeFileSync(
      realIdentity,
      JSON.stringify({
        marker: "NOT_GOLD_SYNTHETIC_EXAMPLE",
        reviews: [review({ coachId: "coach-real", item: "case-1-E1" })],
      }),
    );
    const result = loadExampleReviews(realIdentity);
    expect(result.reviews).toEqual([]);
    expect(result.rejected[0]!.problems.join(" ")).toMatch(/synthetic identities/i);
  });

  it("the committed EXAMPLE file loads, is marked NOT-GOLD, and its provenance can never read as production", () => {
    const result = loadExampleReviews(EXAMPLE_REVIEWS_PATH);
    expect(result.provenance).toBe("EXAMPLE_NOT_GOLD");
    expect(result.rejected).toEqual([]);
    expect(result.reviews.length).toBeGreaterThanOrEqual(4);
    expect(result.reviews.every((r) => isSyntheticIdentity(r.coachId))).toBe(true);
    const report = computeAgreement(result, NOW);
    expect(report.realReviewCount).toBe(0);
    expect(report.banner).toContain("NOT-GOLD");
    expect(report.provenance).toBe("EXAMPLE_NOT_GOLD");
  });
});
