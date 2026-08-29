import { describe, expect, it } from "vitest";
import {
  amendmentIdFor,
  mappingProposalIdFor,
  validateAdjudication,
  validateAmendment,
  validateAssignment,
  validateMappingProposal,
  type AdjudicationRecord,
  type ReviewAmendment,
} from "../records";
import { syntheticAgreeingPair } from "../syntheticFixtures";
import type { ValidationContext } from "../validate";
import type { CoachReview } from "../types";

const context: ValidationContext = {
  knownQueueItemIds: ["wm-dink-01-E1", "afn-vic-rally1-E1"],
  knownFaultIds: ["dink.wristy_flick", "global.no_recovery_to_ready", "drive.late_preparation"],
  knownDrillIds: ["drill.wall-dink-rally", "drill.skinny-singles"],
  strokeTaxonomyVersion: "pickleball-stroke-taxonomy-v3",
  strokeLabels: ["BACKHAND_DINK", "FOREHAND_DRIVE", "FOREHAND_VOLLEY"],
  faultTaxonomyVersion: "fault-taxonomy-v0-draft",
  qualityScaleId: "technique-quality-5pt-v1",
};

function realReview(): CoachReview {
  const [fixture] = syntheticAgreeingPair();
  return {
    ...fixture!,
    coachId: "coach-01",
    coachCredentialRef: "cred-2026-001",
    reviewId: "wm-dink-01-E1.coach-01",
  };
}

describe("validateAssignment", () => {
  const assignmentContext = {
    knownQueueItemIds: context.knownQueueItemIds,
    activeCoachIds: ["coach-01", "coach-02"],
  };
  const valid = {
    queueItemId: "wm-dink-01-E1",
    coachIds: ["coach-01", "coach-02"],
    assignedAtIso: "2026-08-29T00:00:00.000Z",
    assignedBy: "admin",
  };

  it("accepts a well-formed multi-coach assignment", () => {
    expect(validateAssignment(valid, assignmentContext)).toEqual([]);
  });

  it("rejects unknown items, unprovisioned coaches, SYNTHETIC ids, and duplicates", () => {
    expect(
      validateAssignment({ ...valid, queueItemId: "nope" }, assignmentContext).join(" "),
    ).toMatch(/not in the current queue/);
    expect(
      validateAssignment({ ...valid, coachIds: ["coach-99"] }, assignmentContext).join(" "),
    ).toMatch(/not an active entry/);
    expect(
      validateAssignment({ ...valid, coachIds: ["SYNTHETIC-COACH-A"] }, assignmentContext).join(
        " ",
      ),
    ).toMatch(/SYNTHETIC/);
    expect(
      validateAssignment({ ...valid, coachIds: ["coach-01", "coach-01"] }, assignmentContext).join(
        " ",
      ),
    ).toMatch(/unique/);
    expect(validateAssignment({ ...valid, coachIds: [] }, assignmentContext).join(" ")).toMatch(
      /≥1 provisioned coach/,
    );
  });
});

describe("validateAmendment", () => {
  function validAmendment(): ReviewAmendment {
    const review = realReview();
    return {
      schemaVersion: 1,
      amendmentId: amendmentIdFor(review.reviewId, 2),
      reviewId: review.reviewId,
      revision: 2,
      reason: "rewatched at 0.25x — severity was understated",
      review,
      createdAtIso: "2026-08-29T00:00:00.000Z",
    };
  }

  it("accepts a full-replacement revision ≥2 with a reason", () => {
    expect(validateAmendment(validAmendment(), context)).toEqual([]);
  });

  it("rejects revision 1 (the original), bad ids, and short reasons", () => {
    expect(
      validateAmendment(
        {
          ...validAmendment(),
          revision: 1,
          amendmentId: amendmentIdFor("wm-dink-01-E1.coach-01", 1),
        },
        context,
      ).join(" "),
    ).toMatch(/≥2/);
    expect(
      validateAmendment({ ...validAmendment(), amendmentId: "wrong" }, context).join(" "),
    ).toMatch(/amendmentId must equal/);
    expect(validateAmendment({ ...validAmendment(), reason: "typo" }, context).join(" ")).toMatch(
      /reason required/,
    );
  });

  it("validates the embedded review with the full review validator", () => {
    const amendment = validAmendment();
    const problems = validateAmendment(
      { ...amendment, review: { ...amendment.review, confidence: 9 } },
      context,
    );
    expect(problems.join(" ")).toMatch(/review: .*confidence must be 0\.\.1/);
  });

  it("requires the embedded review to keep the amended reviewId", () => {
    const amendment = validAmendment();
    const problems = validateAmendment(
      {
        ...amendment,
        review: { ...amendment.review, reviewId: "other", queueItemId: "afn-vic-rally1-E1" },
      },
      context,
    );
    expect(problems.join(" ")).toMatch(/must equal the amended reviewId/);
  });
});

describe("validateAdjudication", () => {
  const adjContext = {
    ...context,
    reviewerCoachIdsByReviewId: {
      "wm-dink-01-E1.coach-01": "coach-01",
      "wm-dink-01-E1.coach-02": "coach-02",
    },
  };
  const valid: AdjudicationRecord = {
    schemaVersion: 1,
    queueItemId: "wm-dink-01-E1",
    adjudicatorId: "coach-03",
    adjudicatorCredentialRef: "cred-2026-003",
    reviewedReviewIds: ["wm-dink-01-E1.coach-01", "wm-dink-01-E1.coach-02"],
    outcome: { kind: "uphold", reviewId: "wm-dink-01-E1.coach-01" },
    rationale: "coach-01's severity call matches the visible wrist action at contact",
    evidenceTimestampsMs: [1240],
    createdAtIso: "2026-08-29T00:00:00.000Z",
  };

  it("accepts a third-coach uphold adjudication", () => {
    expect(validateAdjudication(valid, adjContext)).toEqual([]);
  });

  it("refuses an adjudicator who was an original reviewer", () => {
    expect(
      validateAdjudication(
        { ...valid, adjudicatorId: "coach-01", adjudicatorCredentialRef: "x" },
        adjContext,
      ).join(" "),
    ).toMatch(/must not be one of the original reviewers/);
  });

  it("refuses SYNTHETIC adjudicators and unknown reviewed reviews", () => {
    expect(
      validateAdjudication({ ...valid, adjudicatorId: "SYNTHETIC-COACH-Z" }, adjContext).join(" "),
    ).toMatch(/SYNTHETIC/);
    expect(
      validateAdjudication(
        { ...valid, reviewedReviewIds: ["wm-dink-01-E1.coach-01", "ghost.review"] },
        adjContext,
      ).join(" "),
    ).toMatch(/no persisted review ghost.review/);
  });

  it("validates each outcome kind", () => {
    expect(
      validateAdjudication(
        { ...valid, outcome: { kind: "uphold", reviewId: "not-reviewed" } },
        adjContext,
      ).join(" "),
    ).toMatch(/must name one of reviewedReviewIds/);
    expect(
      validateAdjudication(
        {
          ...valid,
          outcome: {
            kind: "new_verdict",
            stroke: "NOT_A_LABEL",
            overallQuality: null,
            primaryFaultId: null,
            note: "because",
          },
        },
        adjContext,
      ).join(" "),
    ).toMatch(/NOT_A_LABEL not in/);
    expect(
      validateAdjudication(
        { ...valid, outcome: { kind: "unresolvable", reason: "short" } },
        adjContext,
      ).join(" "),
    ).toMatch(/requires a reason/);
  });

  it("requires a substantive rationale", () => {
    expect(validateAdjudication({ ...valid, rationale: "ok" }, adjContext).join(" ")).toMatch(
      /rationale required/,
    );
  });
});

describe("validateMappingProposal", () => {
  const valid = {
    schemaVersion: 1 as const,
    proposalId: mappingProposalIdFor("drill.wall-dink-rally", "dink.wristy_flick", "coach-01"),
    drillId: "drill.wall-dink-rally",
    faultId: "dink.wristy_flick",
    coachId: "coach-01",
    coachCredentialRef: "cred-2026-001",
    evidence: ["wm-dink-01-E1.coach-01"],
    rationale: "wall rallies isolate the wrist and force a stable paddle face",
    createdAtIso: "2026-08-29T00:00:00.000Z",
  };

  it("accepts a coach-backed drill→fault mapping proposal", () => {
    expect(validateMappingProposal(valid, context)).toEqual([]);
  });

  it("rejects unknown drills/faults, SYNTHETIC coaches, missing evidence, and id mismatches", () => {
    expect(validateMappingProposal({ ...valid, drillId: "drill.nope" }, context).join(" ")).toMatch(
      /not in the drill library/,
    );
    expect(validateMappingProposal({ ...valid, faultId: "made.up" }, context).join(" ")).toMatch(
      /not in fault-taxonomy-v0-draft/,
    );
    expect(
      validateMappingProposal({ ...valid, coachId: "SYNTHETIC-X" }, context).join(" "),
    ).toMatch(/SYNTHETIC/);
    expect(validateMappingProposal({ ...valid, evidence: [] }, context).join(" ")).toMatch(
      /≥1 reference/,
    );
    expect(validateMappingProposal({ ...valid, proposalId: "wrong" }, context).join(" ")).toMatch(
      /proposalId must equal/,
    );
  });
});
