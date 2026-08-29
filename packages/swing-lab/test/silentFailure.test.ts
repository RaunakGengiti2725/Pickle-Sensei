import { describe, expect, it } from "vitest";
import {
  SILENT_FAILURE_CLAIMS,
  SILENT_FAILURE_CONTRACT,
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
  temporalPhasesV2: { status: "segmented", boundaries: { contactMs: 1530, followThroughEndMs: 1900 } },
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

  it("fabricated contact marker (>132ms) is a silent failure", () => {
    const verdict = evaluateSilentFailure(
      { ...FIXTURE_ALL_CORRECT, contact: { status: "estimated", estimatedContactMs: 1750 } },
      FIXTURE_GOLD,
    );
    expect(verdict.claims.CONTACT_MARKER.status).toBe("silent_failure");
  });

  it("66–132ms marker WITH confirmation is not a silent failure; WITHOUT is", () => {
    const confirmed = evaluateSilentFailure(
      { ...FIXTURE_ALL_CORRECT, contact: { status: "estimated", estimatedContactMs: 1600, paddleConfirmed: true } },
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
        temporalPhasesV2: { status: "segmented", boundaries: { contactMs: 1530, followThroughEndMs: 1400 } },
      },
      FIXTURE_GOLD,
    );
    expect(verdict.claims.PHASE_RENDER.status).toBe("silent_failure");
  });

  it("unverifiable claims count as neither correct nor silent failure", () => {
    const noGoldStroke = evaluateSilentFailure(FIXTURE_ALL_CORRECT, { ...FIXTURE_GOLD, strokeLabel: null });
    expect(noGoldStroke.claims.STROKE_L1.status).toBe("unverifiable");
    const noGoldContact = evaluateSilentFailure(FIXTURE_ALL_CORRECT, { ...FIXTURE_GOLD, contactMs: null });
    expect(noGoldContact.claims.CONTACT_MARKER.status).toBe("unverifiable");
    // A report answering ONLY unverifiable claims is not an answered trial.
    const onlyUnverifiable = evaluateSilentFailure(
      { contact: { status: "estimated", estimatedContactMs: 1500 }, strokePrediction: { label: null } },
      { ...FIXTURE_GOLD, contactMs: null },
    );
    expect(onlyUnverifiable.answered).toBe(false);
    expect(onlyUnverifiable.silentFailure).toBe(false);
  });
});
