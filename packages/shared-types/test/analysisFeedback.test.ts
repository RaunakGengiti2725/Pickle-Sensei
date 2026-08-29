import { describe, expect, it } from "vitest";
import {
  ANALYSIS_FEEDBACK_CATEGORIES,
  ANALYSIS_FEEDBACK_SIGNAL_KIND,
  CONSENT_SCOPES,
  feedsHardCaseQueue,
  isFeedbackReviewEligible,
  type ConsentRecord,
  type ConsentScope,
} from "../src/index.js";

/**
 * i08-user-feedback: review eligibility is decided ONLY by the real consent
 * ledger — an active model_training grant. Consent for analysis is separate
 * from consent for model improvement; no other scope, and no absence of
 * records, may make footage review-eligible.
 */

let seq = 0;
function record(
  scope: ConsentScope,
  action: ConsentRecord["action"],
  atIso: string,
): ConsentRecord {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    subjectPseudonym: "11111111-1111-1111-1111-111111111111",
    scope,
    action,
    consentVersion: `${scope.replaceAll("_", "-")}-v1`,
    source: "mobile_settings",
    device: null,
    captureMode: action === "granted" ? "all_captures" : null,
    strokeIntent: null,
    recordedAtIso: atIso,
    seq,
  };
}

describe("isFeedbackReviewEligible (consent ledger enforcement)", () => {
  it("an empty ledger is NOT review-eligible — the default is always off", () => {
    expect(isFeedbackReviewEligible([])).toBe(false);
  });

  it("only an active model_training grant makes footage review-eligible; no other scope does", () => {
    for (const scope of CONSENT_SCOPES) {
      const eligible = isFeedbackReviewEligible([
        record(scope, "granted", "2026-01-01T00:00:00.000Z"),
      ]);
      expect(eligible, `scope ${scope}`).toBe(scope === "model_training");
    }
  });

  it("a withdrawn model_training grant is NOT eligible — withdrawal wins", () => {
    expect(
      isFeedbackReviewEligible([
        record("model_training", "granted", "2026-01-01T00:00:00.000Z"),
        record("model_training", "withdrawn", "2026-01-02T00:00:00.000Z"),
      ]),
    ).toBe(false);
  });

  it("re-grant after withdrawal restores eligibility (ledger folded in order)", () => {
    expect(
      isFeedbackReviewEligible([
        record("model_training", "granted", "2026-01-01T00:00:00.000Z"),
        record("model_training", "withdrawn", "2026-01-02T00:00:00.000Z"),
        record("model_training", "granted", "2026-01-03T00:00:00.000Z"),
      ]),
    ).toBe(true);
  });

  it("granting every OTHER scope together still does not confer eligibility", () => {
    const others = CONSENT_SCOPES.filter((s) => s !== "model_training");
    expect(
      isFeedbackReviewEligible(
        others.map((scope) => record(scope, "granted", "2026-01-01T00:00:00.000Z")),
      ),
    ).toBe(false);
  });
});

describe("feedsHardCaseQueue", () => {
  it("only negative AND review-eligible feedback feeds the queue", () => {
    expect(feedsHardCaseQueue({ rating: "not_quite", reviewEligible: true })).toBe(true);
    expect(feedsHardCaseQueue({ rating: "not_quite", reviewEligible: false })).toBe(false);
    expect(feedsHardCaseQueue({ rating: "accurate", reviewEligible: true })).toBe(false);
    expect(feedsHardCaseQueue({ rating: "accurate", reviewEligible: false })).toBe(false);
  });
});

describe("feedback taxonomy", () => {
  it("categories are exactly the product's five failure buckets", () => {
    expect([...ANALYSIS_FEEDBACK_CATEGORIES]).toEqual([
      "wrong_stroke",
      "wrong_player",
      "contact_looks_wrong",
      "feedback_mismatch",
      "other",
    ]);
  });

  it("the signal kind names failure mining, never a label source", () => {
    expect(ANALYSIS_FEEDBACK_SIGNAL_KIND).toBe("user_feedback_failure_mining");
  });
});
