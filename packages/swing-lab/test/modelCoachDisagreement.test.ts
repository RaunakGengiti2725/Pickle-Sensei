import { describe, expect, it } from "vitest";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  MIN_ADJUDICATION_REVIEWS,
  DISAGREEMENT_HYPOTHESES,
  detectModelCoachConflicts,
  openInvestigationCase,
  investigationIdFor,
  recordAdjudicationReview,
  adjudicateCase,
  updateHypothesis,
  truthStatusFor,
  validateInvestigationCase,
  qualityVerdict,
  type ModelStrokeAssessment,
  type ModelCoachConflict,
} from "../src/modelCoachDisagreement.js";
import type { CoachReview } from "../src/coachReview.js";

const NOW = "2026-08-29T12:00:00.000Z";

function review(overrides: Partial<CoachReview> & { coachId: string; item: string }): CoachReview {
  const { item, ...rest } = overrides;
  const base: CoachReview = {
    schemaVersion: 3,
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
    phaseEvaluations: [{ phaseId: "contact", assessment: "good", note: "" }],
    primaryFaultId: null,
    faults: [],
    drillSuggestions: [],
    confidence: 0.8,
    cannotEvaluate: null,
    rationale: "test fixture rationale long enough to pass validation",
    provenance: {
      coachQualificationSnapshot: {
        coachId: overrides.coachId,
        credentialRef: "cred-test",
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
  return { ...base, ...rest };
}

function assessment(overrides: Partial<ModelStrokeAssessment> = {}): ModelStrokeAssessment {
  return {
    queueItemId: "case-1-E1",
    eventRef: { caseId: "case-1", eventIndex: 0 },
    modelVersions: { "stroke-heuristic": "stroke-heuristic-7" },
    strokeV3: "FOREHAND_DRIVE",
    techniqueQuality: null,
    confidence: 0.92,
    generatedAtIso: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ *
 * conflict detection
 * ------------------------------------------------------------------------ */

describe("detectModelCoachConflicts", () => {
  it("flags a stroke conflict only when the model was high-confidence", () => {
    const coach = review({
      coachId: "coach-a",
      item: "case-1-E1",
      strokeConfirmation: { kind: "corrected", stroke: "BACKHAND_DRIVE", note: "clearly backhand" },
    });
    const high = detectModelCoachConflicts([assessment({ confidence: 0.92 })], [coach]);
    expect(high).toHaveLength(1);
    expect(high[0]!.dimension).toBe("stroke_identity");
    expect(high[0]!.modelVerdict).toBe("FOREHAND_DRIVE");
    expect(high[0]!.coachVerdict).toBe("BACKHAND_DRIVE");

    const low = detectModelCoachConflicts(
      [assessment({ confidence: HIGH_CONFIDENCE_THRESHOLD - 0.01 })],
      [coach],
    );
    expect(low).toEqual([]);
  });

  it("does not treat coach declines or model abstentions as conflicts", () => {
    const cannotJudge = review({
      coachId: "coach-a",
      item: "case-1-E1",
      strokeConfirmation: { kind: "cannot_judge", reason: "occluded angle" },
    });
    expect(detectModelCoachConflicts([assessment()], [cannotJudge])).toEqual([]);

    const coach = review({
      coachId: "coach-a",
      item: "case-1-E1",
      strokeConfirmation: { kind: "confirmed", stroke: "BACKHAND_DRIVE" },
    });
    expect(detectModelCoachConflicts([assessment({ strokeV3: null })], [coach])).toEqual([]);
  });

  it("flags a technique-quality conflict only at |Δ| >= 2 and both sides rated", () => {
    const model = assessment({
      strokeV3: null,
      techniqueQuality: { scaleId: "technique-quality-5pt-v1", value: 5 },
    });
    const far = review({
      coachId: "coach-a",
      item: "case-1-E1",
      overallQuality: { scaleId: "technique-quality-5pt-v1", value: 2 },
    });
    const conflicts = detectModelCoachConflicts([model], [far]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.dimension).toBe("technique_quality");
    expect(conflicts[0]!.modelVerdict).toBe("5");
    expect(conflicts[0]!.coachVerdict).toBe("2");

    const near = review({
      coachId: "coach-a",
      item: "case-1-E1",
      overallQuality: { scaleId: "technique-quality-5pt-v1", value: 4 },
    });
    expect(detectModelCoachConflicts([model], [near])).toEqual([]);

    const unrated = review({
      coachId: "coach-a",
      item: "case-1-E1",
      overallQuality: null,
      faults: [
        {
          faultId: "drive.no_unit_turn",
          severity: 2,
          evidence: { timestampsMs: [10], frames: [], region: null },
          rationale: "fixture rationale text",
        },
      ],
      primaryFaultId: "drive.no_unit_turn",
    });
    expect(detectModelCoachConflicts([model], [unrated])).toEqual([]);
  });

  it("never opens conflicts from synthetic coach identities", () => {
    const synthetic = review({
      coachId: "SYNTHETIC-coach",
      item: "case-1-E1",
      strokeConfirmation: { kind: "confirmed", stroke: "BACKHAND_DRIVE" },
    });
    expect(detectModelCoachConflicts([assessment()], [synthetic])).toEqual([]);
  });
});

describe("qualityVerdict", () => {
  it("reports honest declines distinctly from ratings", () => {
    expect(qualityVerdict(review({ coachId: "c", item: "i" }))).toBe("3");
    expect(qualityVerdict(review({ coachId: "c", item: "i", overallQuality: null }))).toBe(
      "NOT_RATED",
    );
    expect(
      qualityVerdict(
        review({
          coachId: "c",
          item: "i",
          overallQuality: null,
          cannotEvaluate: { reason: "fixture cannot-evaluate reason" },
        }),
      ),
    ).toBe("CANNOT_EVALUATE");
  });
});

/* ------------------------------------------------------------------------ *
 * investigation case lifecycle
 * ------------------------------------------------------------------------ */

function strokeConflict(): ModelCoachConflict {
  const coach = review({
    coachId: "coach-a",
    item: "case-1-E1",
    strokeConfirmation: { kind: "confirmed", stroke: "BACKHAND_DRIVE" },
  });
  return detectModelCoachConflicts([assessment()], [coach])[0]!;
}

describe("openInvestigationCase", () => {
  it("enumerates the FULL hypothesis space, all open, nothing concluded", () => {
    const investigation = openInvestigationCase(strokeConflict(), NOW);
    expect(investigation.investigationId).toBe(investigationIdFor("case-1-E1", "stroke_identity"));
    expect(investigation.status).toBe("open");
    expect(investigation.hypotheses.map((h) => h.hypothesisId)).toEqual([
      ...DISAGREEMENT_HYPOTHESES,
    ]);
    expect(investigation.hypotheses.every((h) => h.status === "open")).toBe(true);
    expect(investigation.hypotheses.every((h) => h.changedBy === null)).toBe(true);
    expect(investigation.requiredAdjudicationReviews).toBe(MIN_ADJUDICATION_REVIEWS);
    expect(validateInvestigationCase(investigation)).toEqual([]);
  });

  it("escalates priority to critical only when both sides were very confident", () => {
    const conflict = strokeConflict();
    expect(openInvestigationCase({ ...conflict, coachConfidence: 0.95 }, NOW).priority).toBe(
      "critical",
    );
    expect(openInvestigationCase({ ...conflict, coachConfidence: 0.7 }, NOW).priority).toBe("high");
  });
});

describe("recordAdjudicationReview", () => {
  const opened = openInvestigationCase(strokeConflict(), NOW);

  it("refuses the original coach, duplicates, synthetic ids, off-item reviews, and declines", () => {
    const original = review({ coachId: "coach-a", item: "case-1-E1" });
    expect(recordAdjudicationReview(opened, original, NOW).problems.join(" ")).toMatch(
      /independent/,
    );

    const synthetic = review({ coachId: "SYNTHETIC-adjudicator", item: "case-1-E1" });
    expect(recordAdjudicationReview(opened, synthetic, NOW).problems.join(" ")).toMatch(
      /synthetic/i,
    );

    const offItem = review({ coachId: "coach-b", item: "case-2-E1" });
    expect(recordAdjudicationReview(opened, offItem, NOW).problems.join(" ")).toMatch(
      /case is for case-1-E1/,
    );

    const decline = review({
      coachId: "coach-b",
      item: "case-1-E1",
      strokeConfirmation: { kind: "cannot_judge", reason: "occluded angle" },
    });
    expect(recordAdjudicationReview(opened, decline, NOW).problems.join(" ")).toMatch(
      /honest decline/,
    );

    const first = recordAdjudicationReview(
      opened,
      review({ coachId: "coach-b", item: "case-1-E1" }),
      NOW,
    );
    expect(first.problems).toEqual([]);
    const duplicate = recordAdjudicationReview(
      first.investigation,
      review({ coachId: "coach-b", item: "case-1-E1" }),
      NOW,
    );
    expect(duplicate.problems.join(" ")).toMatch(/already adjudicated/);
    // append-only: the rejected call returned the ORIGINAL case unchanged
    expect(duplicate.investigation).toBe(first.investigation);
    expect(opened.adjudicationEntries).toEqual([]);
  });
});

describe("adjudicateCase + truthStatusFor", () => {
  const conflict = strokeConflict();

  function adjudicated(strokes: Array<{ coachId: string; stroke: string }>) {
    let investigation = openInvestigationCase(conflict, NOW);
    for (const { coachId, stroke } of strokes) {
      const result = recordAdjudicationReview(
        investigation,
        review({ coachId, item: "case-1-E1", strokeConfirmation: { kind: "confirmed", stroke } }),
        NOW,
      );
      expect(result.problems).toEqual([]);
      investigation = result.investigation;
    }
    return adjudicateCase(investigation, NOW);
  }

  it("is NEITHER_SIDE_IS_TRUTH until enough independent reviews exist", () => {
    const investigation = openInvestigationCase(conflict, NOW);
    expect(truthStatusFor(investigation).kind).toBe("NEITHER_SIDE_IS_TRUTH");
    const one = adjudicated([{ coachId: "coach-b", stroke: "BACKHAND_DRIVE" }]);
    expect(one.status).toBe("open");
    expect(one.resolution).toBeNull();
    const status = truthStatusFor(one);
    expect(status.kind).toBe("NEITHER_SIDE_IS_TRUTH");
    expect(status.kind === "NEITHER_SIDE_IS_TRUTH" && status.reason).toMatch(/1 more/);
  });

  it("upholds the coach when adjudicators unanimously agree with the coach", () => {
    const resolved = adjudicated([
      { coachId: "coach-b", stroke: "BACKHAND_DRIVE" },
      { coachId: "coach-c", stroke: "BACKHAND_DRIVE" },
    ]);
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution!.outcome).toBe("coach_upheld");
    expect(truthStatusFor(resolved)).toEqual({
      kind: "ADJUDICATED",
      verdict: "BACKHAND_DRIVE",
      outcome: "coach_upheld",
    });
    expect(validateInvestigationCase(resolved)).toEqual([]);
  });

  it("upholds the model when adjudicators unanimously agree with the model", () => {
    const resolved = adjudicated([
      { coachId: "coach-b", stroke: "FOREHAND_DRIVE" },
      { coachId: "coach-c", stroke: "FOREHAND_DRIVE" },
    ]);
    expect(resolved.resolution!.outcome).toBe("model_upheld");
    expect(truthStatusFor(resolved).kind).toBe("ADJUDICATED");
  });

  it("records a new verdict when adjudicators agree with neither side", () => {
    const resolved = adjudicated([
      { coachId: "coach-b", stroke: "SPEEDUP" },
      { coachId: "coach-c", stroke: "SPEEDUP" },
    ]);
    expect(resolved.resolution!.outcome).toBe("new_verdict");
    expect(resolved.resolution!.adjudicatedVerdict).toBe("SPEEDUP");
  });

  it("preserves split adjudications as UNRESOLVED — neither side becomes truth", () => {
    const split = adjudicated([
      { coachId: "coach-b", stroke: "FOREHAND_DRIVE" },
      { coachId: "coach-c", stroke: "BACKHAND_DRIVE" },
    ]);
    expect(split.status).toBe("open");
    expect(split.resolution!.outcome).toBe("unresolved");
    expect(split.resolution!.adjudicatedVerdict).toBeNull();
    const status = truthStatusFor(split);
    expect(status.kind).toBe("NEITHER_SIDE_IS_TRUTH");
    expect(status.kind === "NEITHER_SIDE_IS_TRUTH" && status.reason).toMatch(/split/);
  });

  it("never auto-closes root-cause hypotheses on resolution", () => {
    const resolved = adjudicated([
      { coachId: "coach-b", stroke: "BACKHAND_DRIVE" },
      { coachId: "coach-c", stroke: "BACKHAND_DRIVE" },
    ]);
    expect(resolved.hypotheses.every((h) => h.status === "open")).toBe(true);
  });
});

describe("updateHypothesis", () => {
  it("requires attributed, written rationale for any status change", () => {
    const investigation = openInvestigationCase(strokeConflict(), NOW);
    const bare = updateHypothesis(investigation, "perception", "ruled_out", "", "eng-1", NOW);
    expect(bare.problems.join(" ")).toMatch(/rationale/);
    expect(bare.investigation).toBe(investigation);

    const good = updateHypothesis(
      investigation,
      "perception",
      "ruled_out",
      "pose + tracking replay clean on this clip; inputs verified frame-by-frame",
      "eng-1",
      NOW,
    );
    expect(good.problems).toEqual([]);
    const changed = good.investigation.hypotheses.find((h) => h.hypothesisId === "perception")!;
    expect(changed.status).toBe("ruled_out");
    expect(changed.changedBy).toBe("eng-1");
    // untouched hypotheses stay open
    expect(good.investigation.hypotheses.filter((h) => h.hypothesisId !== "perception")).toEqual(
      investigation.hypotheses.filter((h) => h.hypothesisId !== "perception"),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * record validation — append-only store hygiene
 * ------------------------------------------------------------------------ */

describe("validateInvestigationCase", () => {
  it("rejects narrowed hypothesis spaces, low-confidence conflicts, and premature resolutions", () => {
    const investigation = openInvestigationCase(strokeConflict(), NOW);

    const narrowed = {
      ...investigation,
      hypotheses: investigation.hypotheses.filter((h) => h.hypothesisId !== "coach_variance"),
    };
    expect(validateInvestigationCase(narrowed).join(" ")).toMatch(/coach_variance missing/);

    const lowConfidence = {
      ...investigation,
      conflict: { ...investigation.conflict, modelConfidence: 0.5 },
    };
    expect(validateInvestigationCase(lowConfidence).join(" ")).toMatch(/high-confidence/);

    const premature = { ...investigation, status: "resolved" as const };
    expect(validateInvestigationCase(premature).join(" ")).toMatch(/standing verdict/);

    const underReviewed = {
      ...investigation,
      status: "resolved" as const,
      resolution: {
        outcome: "coach_upheld" as const,
        adjudicatedVerdict: "BACKHAND_DRIVE",
        adjudicatorIds: ["coach-b"],
        rationale: "fixture",
        adjudicatedAtIso: NOW,
      },
    };
    expect(validateInvestigationCase(underReviewed).join(" ")).toMatch(
      /fewer adjudication reviews/,
    );

    const synthetic = {
      ...investigation,
      conflict: { ...investigation.conflict, coachId: "SYNTHETIC-coach" },
    };
    expect(validateInvestigationCase(synthetic).join(" ")).toMatch(/synthetic/i);
  });
});
