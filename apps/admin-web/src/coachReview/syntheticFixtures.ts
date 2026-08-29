import type { CoachReview, LoadedReview } from "./types";

/**
 * SYNTHETIC DEV FIXTURES — NOT REVIEWS.
 *
 * These exist ONLY so the agreement computation and its UI states can be
 * developed and unit-tested while the real review count is zero. Guarantees:
 *
 *  - coachIds begin with "SYNTHETIC-" — rejected by the validator, rejected
 *    by the persistence endpoint, and impossible to provision in
 *    coaches.json per docs/COACHING.md;
 *  - they are only injected client-side when the page is opened with
 *    ?synthetic=1, behind a screaming banner;
 *  - they are NEVER written to datasets/ and never counted in queue.json.
 */

export const SYNTHETIC_BANNER =
  "SYNTHETIC DEV FIXTURE — these are NOT coach reviews. Real review count is unchanged (see queue.json). Remove ?synthetic=1 to return to the truthful empty state.";

const BASE = {
  schemaVersion: 2,
  strokeTaxonomyVersion: "pickleball-stroke-taxonomy-v3",
  faultTaxonomyVersion: "fault-taxonomy-v0-draft",
  drillLibraryVersion: "drill-library-v0",
  coachCredentialRef: "SYNTHETIC-NO-CREDENTIAL",
  createdAtIso: "2026-08-28T00:00:00.000Z",
  submittedAtIso: "2026-08-28T00:00:00.000Z",
} as const;

/** Two synthetic reviewers on wm-dink-01-E1 who mostly AGREE. */
export function syntheticAgreeingPair(): CoachReview[] {
  return [
    {
      ...BASE,
      reviewId: "wm-dink-01-E1.SYNTHETIC-COACH-A",
      queueItemId: "wm-dink-01-E1",
      coachId: "SYNTHETIC-COACH-A",
      eventRef: { caseId: "wm-dink-01", eventIndex: 0 },
      strokeConfirmation: { kind: "confirmed", stroke: "BACKHAND_DINK" },
      overallQuality: { scaleId: "technique-quality-5pt-v1", value: 3 },
      faults: [
        {
          faultId: "dink.wristy_flick",
          severity: 2,
          evidence: { timestampsMs: [1240, 1300], region: null },
          rationale: "synthetic fixture rationale — face flips through contact",
        },
        {
          faultId: "global.no_recovery_to_ready",
          severity: 1,
          evidence: { timestampsMs: [1600], region: null },
          rationale: "synthetic fixture rationale — paddle hangs after contact",
        },
      ],
      drillSuggestions: [{ drillId: "drill.wall-dink-rally", freeText: "synthetic suggestion" }],
      confidence: 0.8,
      cannotEvaluate: null,
      rationale: "synthetic fixture — agreement-path development data only",
    },
    {
      ...BASE,
      reviewId: "wm-dink-01-E1.SYNTHETIC-COACH-B",
      queueItemId: "wm-dink-01-E1",
      coachId: "SYNTHETIC-COACH-B",
      eventRef: { caseId: "wm-dink-01", eventIndex: 0 },
      strokeConfirmation: { kind: "confirmed", stroke: "BACKHAND_DINK" },
      overallQuality: { scaleId: "technique-quality-5pt-v1", value: 3 },
      faults: [
        {
          faultId: "dink.wristy_flick",
          severity: 3,
          evidence: { timestampsMs: [1260], region: null },
          rationale: "synthetic fixture rationale — wrist dominates the push",
        },
      ],
      drillSuggestions: [],
      confidence: 0.7,
      cannotEvaluate: null,
      rationale: "synthetic fixture — agreement-path development data only",
    },
  ];
}

/** Two synthetic reviewers on afn-vic-rally1-E1 who DISAGREE (adjudication path). */
export function syntheticDisagreeingPair(): CoachReview[] {
  return [
    {
      ...BASE,
      reviewId: "afn-vic-rally1-E1.SYNTHETIC-COACH-A",
      queueItemId: "afn-vic-rally1-E1",
      coachId: "SYNTHETIC-COACH-A",
      eventRef: { caseId: "afn-vic-rally1", eventIndex: 0 },
      strokeConfirmation: { kind: "confirmed", stroke: "FOREHAND_DRIVE" },
      overallQuality: { scaleId: "technique-quality-5pt-v1", value: 4 },
      faults: [
        {
          faultId: "drive.late_preparation",
          severity: 1,
          evidence: { timestampsMs: [520], region: null },
          rationale: "synthetic fixture rationale — slightly late take-back",
        },
      ],
      drillSuggestions: [],
      confidence: 0.75,
      cannotEvaluate: null,
      rationale: "synthetic fixture — disagreement-path development data only",
    },
    {
      ...BASE,
      reviewId: "afn-vic-rally1-E1.SYNTHETIC-COACH-B",
      queueItemId: "afn-vic-rally1-E1",
      coachId: "SYNTHETIC-COACH-B",
      eventRef: { caseId: "afn-vic-rally1", eventIndex: 0 },
      strokeConfirmation: { kind: "corrected", stroke: "FOREHAND_VOLLEY", note: "synthetic: taken out of the air" },
      overallQuality: { scaleId: "technique-quality-5pt-v1", value: 2 },
      faults: [
        {
          faultId: "drive.arm_only_power",
          severity: 3,
          evidence: { timestampsMs: [640], region: null },
          rationale: "synthetic fixture rationale — no hip rotation into contact",
        },
      ],
      drillSuggestions: [],
      confidence: 0.65,
      cannotEvaluate: null,
      rationale: "synthetic fixture — disagreement-path development data only",
    },
  ];
}

/** One synthetic cannot-evaluate outcome on wm-volley-02-E1. */
export function syntheticCannotEvaluate(): CoachReview {
  return {
    ...BASE,
    reviewId: "wm-volley-02-E1.SYNTHETIC-COACH-C",
    queueItemId: "wm-volley-02-E1",
    coachId: "SYNTHETIC-COACH-C",
    eventRef: { caseId: "wm-volley-02", eventIndex: 0 },
    strokeConfirmation: { kind: "cannot_judge", reason: "synthetic: cannot see paddle face" },
    overallQuality: null,
    faults: [],
    drillSuggestions: [],
    confidence: 0.2,
    cannotEvaluate: { reason: "synthetic fixture — cannot-evaluate path" },
    rationale: "",
  };
}

export function syntheticLoadedReviews(): LoadedReview[] {
  return [...syntheticAgreeingPair(), ...syntheticDisagreeingPair(), syntheticCannotEvaluate()].map(
    (review) => ({ review, source: "SYNTHETIC-FIXTURE", synthetic: true }),
  );
}
