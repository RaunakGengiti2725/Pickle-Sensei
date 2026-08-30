import { describe, expect, it } from "vitest";
import {
  SILENT_FAILURE_CLAIMS,
  SILENT_FAILURE_CONTRACT,
  SILENT_FAILURE_CONTRACT_V1_1,
  evaluateSilentFailure,
  type SilentFailureGold,
  type SilentFailureReportView,
} from "../src/silentFailure.js";

/**
 * silent-failure-v1 contract tests. Every report below is a SYNTHETIC FIXTURE
 * (clearly marked) — canonical run dirs are absent on this box, so these
 * verify the code path, never real cascade numbers.
 */

const FIXTURE_GOLD: SilentFailureGold = {
  eventStartMs: 1000,
  eventEndMs: 2000,
  contactMs: 1500,
  strokeLabel: "FOREHAND_DRIVE",
};

/** FIXTURE: every claim answered and correct. */
const FIXTURE_ALL_CORRECT: SilentFailureReportView = {
  player: { targetCoverage: 0.9 },
  targetEvent: { status: "selected", event: { startMs: 950, endMs: 2100 } },
  contact: { status: "estimated", estimatedContactMs: 1530 },
  temporalPhasesV2: {
    status: "segmented",
    boundaries: { contactMs: 1530, followThroughEndMs: 1900 },
  },
  strokePrediction: { label: "FOREHAND_DRIVE" },
};

describe("silent-failure-v1 contract", () => {
  it("is versioned and defines all five material claims", () => {
    expect(SILENT_FAILURE_CONTRACT.version).toBe("silent-failure-v1");
    expect(Object.keys(SILENT_FAILURE_CONTRACT.claims)).toHaveLength(SILENT_FAILURE_CLAIMS.length);
  });

  it("all-correct fixture: answered, no silent failure", () => {
    const verdict = evaluateSilentFailure(FIXTURE_ALL_CORRECT, FIXTURE_GOLD);
    expect(verdict.answered).toBe(true);
    expect(verdict.silentFailure).toBe(false);
    for (const claim of SILENT_FAILURE_CLAIMS) {
      expect(verdict.claims[claim].status).toBe("correct");
    }
  });

  it("abstentions are NOT silent failures (fully abstaining fixture)", () => {
    const verdict = evaluateSilentFailure(
      {
        contact: { status: "abstained" },
        temporalPhasesV2: { status: "abstained" },
        strokePrediction: { label: null },
      },
      FIXTURE_GOLD,
    );
    expect(verdict.answered).toBe(false);
    expect(verdict.silentFailure).toBe(false);
    for (const claim of SILENT_FAILURE_CLAIMS) {
      expect(verdict.claims[claim].status).toBe("abstained");
    }
  });

  it("wrong confident stroke L1 is a silent failure", () => {
    const verdict = evaluateSilentFailure(
      { ...FIXTURE_ALL_CORRECT, strokePrediction: { label: "BACKHAND_DRIVE" } },
      FIXTURE_GOLD,
    );
    expect(verdict.claims.STROKE_L1.status).toBe("silent_failure");
    expect(verdict.silentFailure).toBe(true);
  });

  it("explicit UNKNOWN label is an abstention, never a silent failure (2026-08-29 Mac re-measure regression)", () => {
    // stroke-heuristic-7's abstention gates emit the literal taxonomy-v3
    // "UNKNOWN" label (wm-dink-01 / afn-vic-rally1 on the real Mac cascade);
    // it claims no L1 side, so it cannot contradict gold.
    const verdict = evaluateSilentFailure(
      { ...FIXTURE_ALL_CORRECT, strokePrediction: { label: "UNKNOWN" } },
      FIXTURE_GOLD,
    );
    expect(verdict.claims.STROKE_L1.status).toBe("abstained");
    expect(verdict.silentFailure).toBe(false);
  });

  it("fabricated contact marker (>132ms) is a silent failure", () => {
    const verdict = evaluateSilentFailure(
      { ...FIXTURE_ALL_CORRECT, contact: { status: "estimated", estimatedContactMs: 1750 } },
      FIXTURE_GOLD,
    );
    expect(verdict.claims.CONTACT_MARKER.status).toBe("silent_failure");
  });

  it("merge-reactivation-style 695ms marker is a silent failure even when 'confirmed'", () => {
    // SYNTHETIC FIXTURE replaying the documented failure shape (STATUS_BOARD:
    // merge fabricated 695ms contact): a grossly wrong marker must count as a
    // silent failure regardless of any confirmation flags.
    const verdict = evaluateSilentFailure(
      {
        ...FIXTURE_ALL_CORRECT,
        contact: {
          status: "estimated",
          estimatedContactMs: (FIXTURE_GOLD.contactMs ?? 0) + 695,
          ballConfirmed: true,
          paddleConfirmed: true,
        },
      },
      FIXTURE_GOLD,
    );
    expect(verdict.claims.CONTACT_MARKER.status).toBe("silent_failure");
    expect(verdict.silentFailure).toBe(true);
  });

  it("66–132ms marker WITH confirmation is not a silent failure; WITHOUT is", () => {
    const confirmed = evaluateSilentFailure(
      {
        ...FIXTURE_ALL_CORRECT,
        contact: { status: "estimated", estimatedContactMs: 1600, paddleConfirmed: true },
      },
      FIXTURE_GOLD,
    );
    expect(confirmed.claims.CONTACT_MARKER.status).toBe("correct");
    const unconfirmed = evaluateSilentFailure(
      { ...FIXTURE_ALL_CORRECT, contact: { status: "estimated", estimatedContactMs: 1600 } },
      FIXTURE_GOLD,
    );
    expect(unconfirmed.claims.CONTACT_MARKER.status).toBe("silent_failure");
  });

  it("wrong target lock and wrong event selection are silent failures", () => {
    const verdict = evaluateSilentFailure(
      {
        ...FIXTURE_ALL_CORRECT,
        player: { targetCoverage: 0.2 },
        targetEvent: { status: "selected", event: { startMs: 4000, endMs: 5000 } },
      },
      FIXTURE_GOLD,
    );
    expect(verdict.claims.TARGET_IDENTITY.status).toBe("silent_failure");
    expect(verdict.claims.EVENT.status).toBe("silent_failure");
  });

  it("impossible phase ordering render is a silent failure", () => {
    const verdict = evaluateSilentFailure(
      {
        ...FIXTURE_ALL_CORRECT,
        temporalPhasesV2: {
          status: "segmented",
          boundaries: { contactMs: 1530, followThroughEndMs: 1400 },
        },
      },
      FIXTURE_GOLD,
    );
    expect(verdict.claims.PHASE_RENDER.status).toBe("silent_failure");
  });

  it("unverifiable claims count as neither correct nor silent failure", () => {
    const noGoldStroke = evaluateSilentFailure(FIXTURE_ALL_CORRECT, {
      ...FIXTURE_GOLD,
      strokeLabel: null,
    });
    expect(noGoldStroke.claims.STROKE_L1.status).toBe("unverifiable");
    const noGoldContact = evaluateSilentFailure(FIXTURE_ALL_CORRECT, {
      ...FIXTURE_GOLD,
      contactMs: null,
    });
    expect(noGoldContact.claims.CONTACT_MARKER.status).toBe("unverifiable");
    // A report answering ONLY unverifiable claims is not an answered trial.
    const onlyUnverifiable = evaluateSilentFailure(
      {
        contact: { status: "estimated", estimatedContactMs: 1500 },
        strokePrediction: { label: null },
      },
      { ...FIXTURE_GOLD, contactMs: null },
    );
    expect(onlyUnverifiable.answered).toBe(false);
    expect(onlyUnverifiable.silentFailure).toBe(false);
  });
});

describe("silent-failure-v1.1 additions (D3-10 red team; all fixtures SYNTHETIC)", () => {
  it("is re-versioned, never softened in place: v1 object untouched", () => {
    expect(SILENT_FAILURE_CONTRACT.version).toBe("silent-failure-v1");
    expect(SILENT_FAILURE_CONTRACT_V1_1.version).toBe("silent-failure-v1.1");
    expect(SILENT_FAILURE_CONTRACT_V1_1.claims).toEqual(SILENT_FAILURE_CONTRACT.claims);
    expect(SILENT_FAILURE_CONTRACT_V1_1.disputedGold).toMatch(/excluded/);
  });

  // REGRESSION (break B7): disputed gold (the C05 contact dispute pattern)
  // used to be silently counted as if the gold were reliable — the dispute
  // would decide the metric. It must be EXCLUDED AND DISCLOSED.
  it("disputed gold contact is excluded-and-disclosed, counted neither way (B7)", () => {
    const disputedGold: SilentFailureGold = { ...FIXTURE_GOLD, contactDisputed: true };
    // A marker that would be a fabricated silent failure vs the disputed value…
    const wouldBeFailure = evaluateSilentFailure(
      {
        contact: { status: "estimated", estimatedContactMs: 1750 },
        strokePrediction: { label: null },
      },
      disputedGold,
    );
    expect(wouldBeFailure.claims.CONTACT_MARKER.status).toBe("excluded_disputed_gold");
    expect(wouldBeFailure.claims.CONTACT_MARKER.detail).toMatch(/dispute/);
    expect(wouldBeFailure.silentFailure).toBe(false);
    expect(wouldBeFailure.answered).toBe(false);
    // …and a marker that would be "correct" vs the disputed value is excluded too.
    const wouldBeCorrect = evaluateSilentFailure(
      {
        contact: { status: "estimated", estimatedContactMs: 1510 },
        strokePrediction: { label: null },
      },
      disputedGold,
    );
    expect(wouldBeCorrect.claims.CONTACT_MARKER.status).toBe("excluded_disputed_gold");
  });

  it("disputed gold contact cannot rescue the EVENT claim via the contact-inside arm", () => {
    const verdict = evaluateSilentFailure(
      {
        // Selected window covers the disputed gold contact but only 5% of the gold span.
        targetEvent: { status: "selected", event: { startMs: 1450, endMs: 1550 } },
      },
      { ...FIXTURE_GOLD, contactDisputed: true },
    );
    expect(verdict.claims.EVENT.status).toBe("silent_failure");
  });

  it("disputed gold stroke label is excluded-and-disclosed", () => {
    const verdict = evaluateSilentFailure(
      { strokePrediction: { label: "BACKHAND_DRIVE" } },
      { ...FIXTURE_GOLD, strokeLabelDisputed: true },
    );
    expect(verdict.claims.STROKE_L1.status).toBe("excluded_disputed_gold");
    expect(verdict.silentFailure).toBe(false);
  });

  // REGRESSION (breaks B5/B6): NaN gold used to produce CONFIDENT
  // silent-failure verdicts ("err NaNms", "overlap NaN%"). Non-finite values
  // must yield unverifiable-with-disclosure, never a verdict either way.
  it("NaN gold contact / event bounds are unverifiable, not silent failures (B5/B6)", () => {
    const nanContact = evaluateSilentFailure(
      { contact: { status: "estimated", estimatedContactMs: 1500 } },
      { ...FIXTURE_GOLD, contactMs: NaN },
    );
    expect(nanContact.claims.CONTACT_MARKER.status).toBe("unverifiable");
    expect(nanContact.claims.CONTACT_MARKER.detail).toMatch(/non-finite/);

    const nanBounds = evaluateSilentFailure(
      { targetEvent: { status: "selected", event: { startMs: 1000, endMs: 2000 } } },
      { ...FIXTURE_GOLD, eventStartMs: NaN, eventEndMs: NaN },
    );
    expect(nanBounds.claims.EVENT.status).toBe("unverifiable");

    const nanEstimate = evaluateSilentFailure(
      { contact: { status: "estimated", estimatedContactMs: NaN } },
      FIXTURE_GOLD,
    );
    expect(nanEstimate.claims.CONTACT_MARKER.status).toBe("unverifiable");

    const nanCoverage = evaluateSilentFailure({ player: { targetCoverage: NaN } }, FIXTURE_GOLD);
    expect(nanCoverage.claims.TARGET_IDENTITY.status).toBe("unverifiable");
  });

  it("degenerate gold span (end <= start) is unverifiable for EVENT, not a division-by-zero verdict", () => {
    const verdict = evaluateSilentFailure(
      { targetEvent: { status: "selected", event: { startMs: 1000, endMs: 2000 } } },
      { ...FIXTURE_GOLD, eventStartMs: 1500, eventEndMs: 1500 },
    );
    expect(verdict.claims.EVENT.status).toBe("unverifiable");
  });

  it("a rendered timeline with a non-finite boundary is a silent failure (physically false render)", () => {
    const verdict = evaluateSilentFailure(
      {
        ...FIXTURE_ALL_CORRECT,
        temporalPhasesV2: {
          status: "segmented",
          boundaries: { contactMs: 1530, followThroughEndMs: NaN },
        },
      },
      FIXTURE_GOLD,
    );
    expect(verdict.claims.PHASE_RENDER.status).toBe("silent_failure");
    expect(verdict.claims.PHASE_RENDER.detail).toMatch(/non-finite/);
  });

  it("undisputed, well-formed gold behaves exactly as v1 (no weakening)", () => {
    const verdict = evaluateSilentFailure(FIXTURE_ALL_CORRECT, FIXTURE_GOLD);
    expect(verdict.answered).toBe(true);
    expect(verdict.silentFailure).toBe(false);
    const failure = evaluateSilentFailure(
      { ...FIXTURE_ALL_CORRECT, contact: { status: "estimated", estimatedContactMs: 1750 } },
      FIXTURE_GOLD,
    );
    expect(failure.claims.CONTACT_MARKER.status).toBe("silent_failure");
  });
});
