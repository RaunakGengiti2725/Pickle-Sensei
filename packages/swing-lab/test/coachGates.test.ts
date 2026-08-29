import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COACH_GATES_SPEC_PATH,
  COACH_GATES_V1_SHA256,
  HELD_OUT_CASE_IDS,
  collectCoachEvidence,
  loadCoachGatesSpec,
  runCoachGates,
} from "../src/coachGates.js";
import {
  COACH_REVIEW_SCHEMA_VERSION,
  FAULT_TAXONOMY_V0_DRAFT_VERSION,
  TECHNIQUE_QUALITY_SCALE_V1,
  reviewIdFor,
  validateCoachReview,
} from "../src/coachReview.js";

const REPO_ROOT = resolve(__dirname, "../../..");

/** A structurally VALID review used only inside throwaway tmp dirs to prove
 * the checker's exclusion rules. Never written into the repo. */
function validReviewFixture(
  queueItemId: string,
  caseId: string,
  eventIndex: number,
  coachId: string,
) {
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
    phaseEvaluations: [{ phaseId: "preparation", assessment: "good", note: "fixture phase note" }],
    primaryFaultId: null,
    faults: [],
    drillSuggestions: [],
    confidence: 0.8,
    cannotEvaluate: null,
    rationale: "Test-only structural fixture used to exercise checker exclusion rules.",
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
  };
}

function makeTmpRepo(options: {
  coaches: Array<{ coachId: string; credentialRef: string; status: string }>;
  reviews: Array<ReturnType<typeof validReviewFixture>>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "coach-gates-"));
  mkdirSync(join(root, "datasets/coach-review/gates"), { recursive: true });
  mkdirSync(join(root, "datasets/coach-review/reviews"), { recursive: true });
  cpSync(join(REPO_ROOT, COACH_GATES_SPEC_PATH), join(root, COACH_GATES_SPEC_PATH));
  writeFileSync(
    join(root, "datasets/coach-review/coaches.json"),
    JSON.stringify({ schemaVersion: 1, coaches: options.coaches }),
  );
  for (const review of options.reviews) {
    writeFileSync(
      join(root, "datasets/coach-review/reviews", `${review.reviewId}.json`),
      JSON.stringify(review),
    );
  }
  return root;
}

describe("frozen spec integrity", () => {
  it("loads the frozen spec and the SHA-256 pin matches", () => {
    const { spec, sha256 } = loadCoachGatesSpec();
    expect(spec.specId).toBe("coach-gates-frozen-v1");
    expect(sha256).toBe(COACH_GATES_V1_SHA256);
  });

  it("refuses a tampered spec (weakened threshold)", () => {
    const root = makeTmpRepo({ coaches: [], reviews: [] });
    const specPath = join(root, COACH_GATES_SPEC_PATH);
    const tampered = readFileSync(specPath, "utf8").replace('"minEvents": 30', '"minEvents": 1');
    expect(tampered).not.toBe(readFileSync(specPath, "utf8"));
    writeFileSync(specPath, tampered);
    expect(() => loadCoachGatesSpec(root)).toThrow(/hash mismatch/);
  });

  it("held-out cases are frozen into the spec", () => {
    const { spec } = loadCoachGatesSpec();
    expect(spec.heldOutCases).toEqual([...HELD_OUT_CASE_IDS]);
    expect(HELD_OUT_CASE_IDS).toContain("wm-dink-01");
    expect(HELD_OUT_CASE_IDS).toContain("afn-vic-rally1");
  });
});

describe("gate evaluation on the real repo (zero coach data)", () => {
  const report = runCoachGates();

  it("lock gates PASS: profiles locked, registry clean, drills unvalidated", () => {
    for (const id of ["L1", "L2", "L4"]) {
      expect(report.gates.find((gate) => gate.id === id)?.verdict).toBe("PASS");
    }
  });

  it("every validation gate is NOT_EVALUABLE — no coach evidence exists and none is fabricated", () => {
    for (const gate of report.gates) {
      if (["L1", "L2", "L4"].includes(gate.id)) continue;
      expect(gate.verdict).toBe("NOT_EVALUABLE");
    }
    expect(report.evidenceCounts.activeCoaches).toBe(0);
    expect(report.evidenceCounts.countedReviews).toBe(0);
  });

  it("NOT_EVALUABLE blocks release exactly like FAIL: all three surfaces RELEASE_BLOCKED", () => {
    expect(Object.keys(report.surfaces).sort()).toEqual([
      "drill_recommendation",
      "fault_diagnosis",
      "technique_score",
    ]);
    for (const surface of Object.values(report.surfaces)) {
      expect(surface.verdict).toBe("RELEASE_BLOCKED");
    }
    expect(report.overallVerdict).toBe("RELEASE_BLOCKED");
  });

  it("every surface gate set includes the perturbation hard gate path or lock gates", () => {
    expect(report.surfaces["technique_score"]!.gateIds).toContain("S6");
    expect(report.surfaces["fault_diagnosis"]!.gateIds).toContain("F4");
    expect(report.surfaces["drill_recommendation"]!.gateIds).toContain("D1");
  });
});

describe("evidence exclusion rules", () => {
  it("reviews on held-out cases count toward NOTHING", () => {
    const fixture = validReviewFixture("wm-dink-01-E1", "wm-dink-01", 0, "coach-real-01");
    expect(validateCoachReview(fixture)).toEqual([]);
    const root = makeTmpRepo({
      coaches: [{ coachId: "coach-real-01", credentialRef: "cred-off-repo-001", status: "active" }],
      reviews: [fixture],
    });
    const evidence = collectCoachEvidence(root);
    expect(evidence.heldOutReviewsExcluded).toBe(1);
    expect(evidence.countedReviews).toHaveLength(0);
  });

  it("reviews by unprovisioned coaches count toward NOTHING", () => {
    const fixture = validReviewFixture(
      "afn-sasebo-rally1-E1",
      "afn-sasebo-rally1",
      0,
      "coach-unknown",
    );
    const root = makeTmpRepo({ coaches: [], reviews: [fixture] });
    const evidence = collectCoachEvidence(root);
    expect(evidence.unprovisionedReviewFiles).toHaveLength(1);
    expect(evidence.countedReviews).toHaveLength(0);
  });

  it("synthetic coach ids in the registry are flagged (and fail gate L2)", () => {
    const root = makeTmpRepo({
      coaches: [{ coachId: "synthetic-coach-1", credentialRef: "none", status: "active" }],
      reviews: [],
    });
    const evidence = collectCoachEvidence(root);
    expect(evidence.syntheticRegistryIds).toEqual(["synthetic-coach-1"]);
    expect(evidence.activeCoaches).toHaveLength(0);
  });

  it("a valid non-held-out review by an active coach IS counted (evidence path works)", () => {
    const fixture = validReviewFixture(
      "afn-sasebo-rally1-E1",
      "afn-sasebo-rally1",
      0,
      "coach-real-01",
    );
    expect(validateCoachReview(fixture)).toEqual([]);
    const root = makeTmpRepo({
      coaches: [{ coachId: "coach-real-01", credentialRef: "cred-off-repo-001", status: "active" }],
      reviews: [fixture],
    });
    const evidence = collectCoachEvidence(root);
    expect(evidence.countedReviews).toHaveLength(1);
  });
});
