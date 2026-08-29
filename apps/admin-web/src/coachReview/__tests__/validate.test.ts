import { describe, expect, it } from "vitest";
import { validateReview, type ValidationContext } from "../validate";
import { syntheticAgreeingPair } from "../syntheticFixtures";
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

/** A structurally valid record for a REAL (non-synthetic) coach id — used
 * only in-memory to prove the validator passes well-formed input. */
function validReview(): CoachReview {
  const [fixture] = syntheticAgreeingPair();
  return {
    ...fixture!,
    coachId: "coach-01",
    coachCredentialRef: "cred-2026-001",
    reviewId: "wm-dink-01-E1.coach-01",
  };
}

describe("validateReview", () => {
  it("accepts a fully-formed review", () => {
    expect(validateReview(validReview(), context)).toEqual([]);
  });

  it("rejects SYNTHETIC coach ids — dev fixtures may never persist", () => {
    const [fixture] = syntheticAgreeingPair();
    const problems = validateReview(fixture!, context);
    expect(problems.join(" ")).toMatch(/SYNTHETIC/);
  });

  it("requires coachId and credentialRef", () => {
    const review = { ...validReview(), coachId: "", coachCredentialRef: "" };
    const problems = validateReview(review, context);
    expect(problems.join(" ")).toMatch(/coachId required/);
    expect(problems.join(" ")).toMatch(/coachCredentialRef required/);
  });

  it("enforces the reviewId = queueItemId.coachId rule", () => {
    const review = { ...validReview(), reviewId: "some-other-id" };
    expect(validateReview(review, context).join(" ")).toMatch(/reviewId must equal/);
  });

  it("rejects unknown queue items and fault ids", () => {
    const review = validReview();
    const tampered: CoachReview = {
      ...review,
      queueItemId: "not-a-real-item",
      reviewId: "not-a-real-item.coach-01",
      eventRef: { caseId: "not-a-real", eventIndex: 0 },
      faults: [{ ...review.faults[0]!, faultId: "made.up_fault" }],
    };
    const problems = validateReview(tampered, context);
    expect(problems.join(" ")).toMatch(/not in the current queue/);
    expect(problems.join(" ")).toMatch(/made\.up_fault not in fault-taxonomy-v0-draft/);
  });

  it("requires ≥1 evidence timestamp per fault", () => {
    const review = validReview();
    const tampered: CoachReview = {
      ...review,
      faults: [{ ...review.faults[0]!, evidence: { timestampsMs: [], region: null } }],
    };
    expect(validateReview(tampered, context).join(" ")).toMatch(/timestampsMs requires ≥1/);
  });

  it("rejects out-of-range severity and region", () => {
    const review = validReview();
    const tampered = {
      ...review,
      faults: [
        {
          ...review.faults[0]!,
          severity: 5 as never,
          evidence: { timestampsMs: [100], region: { x: 2, y: 0, w: 0.5, h: 0.5 } },
        },
      ],
    };
    const problems = validateReview(tampered, context);
    expect(problems.join(" ")).toMatch(/severity must be 1\.\.3/);
    expect(problems.join(" ")).toMatch(/region must be normalized/);
  });

  it("treats cannotEvaluate as first-class: requires a reason, then relaxes rating/rationale", () => {
    const review: CoachReview = {
      ...validReview(),
      overallQuality: null,
      faults: [],
      rationale: "",
      cannotEvaluate: { reason: "camera angle hides the paddle entirely" },
    };
    expect(validateReview(review, context)).toEqual([]);
    const missingReason = { ...review, cannotEvaluate: { reason: "" } };
    expect(validateReview(missingReason, context).join(" ")).toMatch(
      /cannotEvaluate.reason required/,
    );
  });

  it("refuses an evaluable review with neither quality nor faults", () => {
    const review: CoachReview = { ...validReview(), overallQuality: null, faults: [] };
    expect(validateReview(review, context).join(" ")).toMatch(
      /must carry overallQuality and\/or faults/,
    );
  });

  it("requires corrected strokes to carry a note and a known label", () => {
    const review: CoachReview = {
      ...validReview(),
      strokeConfirmation: { kind: "corrected", stroke: "NOT_A_LABEL", note: "" },
    };
    const problems = validateReview(review, context);
    expect(problems.join(" ")).toMatch(/NOT_A_LABEL not in/);
    expect(problems.join(" ")).toMatch(/corrected stroke requires a note/);
  });

  it("bounds confidence to 0..1 and validates timestamps", () => {
    const review = { ...validReview(), confidence: 1.5, createdAtIso: "yesterday" };
    const problems = validateReview(review, context);
    expect(problems.join(" ")).toMatch(/confidence must be 0\.\.1/);
    expect(problems.join(" ")).toMatch(/createdAtIso must be an ISO timestamp/);
  });
});
