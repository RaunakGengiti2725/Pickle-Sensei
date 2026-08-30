import { describe, expect, it } from "vitest";
import { evaluateCommittedRuns, retroTrial } from "../src/silentFailureRetro.js";

const row = (stages: Record<string, { pass: boolean; detail: string }>) => ({
  caseId: "synthetic",
  split: "development",
  stages,
});

const baseStages = {
  TARGET: { pass: true, detail: "policy user_tapped_person · coverage 1.00 · conf 0.97" },
  EVENT: { pass: true, detail: "selected 100–200 vs gold 100–200 (overlap 100%, contact inside)" },
  CONTACT: { pass: true, detail: "error 30ms (est 150 vs gold 180)" },
  PHASE: { pass: true, detail: "segmented, ordering valid" },
  STROKE: { pass: true, detail: "predicted FOREHAND vs gold FOREHAND_VOLLEY" },
};

describe("retroTrial (synthetic rows)", () => {
  it("all-correct row is answered with no silent failure", () => {
    const trial = retroTrial(row(baseStages));
    expect(trial.answered).toBe(true);
    expect(trial.silentFailure).toBe(false);
    for (const claim of Object.values(trial.claims)) expect(claim.status).toBe("correct");
  });

  it("wrong confident stroke and >132ms contact are silent failures; abstentions are not", () => {
    const trial = retroTrial(
      row({
        ...baseStages,
        EVENT: { pass: false, detail: "targetEvent status ambiguous" },
        CONTACT: { pass: false, detail: "error 250ms (est 1510 vs gold 1260)" },
        STROKE: { pass: false, detail: "predicted BACKHAND vs gold FOREHAND_DRIVE" },
      }),
    );
    expect(trial.claims.EVENT.status).toBe("abstained");
    expect(trial.claims.CONTACT_MARKER.status).toBe("silent_failure");
    expect(trial.claims.STROKE_L1.status).toBe("silent_failure");
    expect(trial.silentFailure).toBe(true);
  });

  it("contact 66<err<=132ms is unverifiable_retro (no confirmation data in rows); null stroke abstains", () => {
    const trial = retroTrial(
      row({
        ...baseStages,
        CONTACT: { pass: false, detail: "error 100ms (est 1000 vs gold 1100)" },
        STROKE: { pass: false, detail: "predicted none vs gold BACKHAND_VOLLEY" },
      }),
    );
    expect(trial.claims.CONTACT_MARKER.status).toBe("unverifiable_retro");
    expect(trial.claims.STROKE_L1.status).toBe("abstained");
    expect(trial.silentFailure).toBe(false);
  });

  it("'predicted UNKNOWN' rows abstain, never silent-fail (2026-08-29 Mac re-measure regression)", () => {
    const trial = retroTrial(
      row({
        ...baseStages,
        STROKE: { pass: false, detail: "predicted UNKNOWN vs gold FOREHAND_DRIVE" },
      }),
    );
    expect(trial.claims.STROKE_L1.status).toBe("abstained");
    expect(trial.silentFailure).toBe(false);
  });

  it("unrecognized detail strings throw instead of guessing", () => {
    expect(() =>
      retroTrial(row({ ...baseStages, CONTACT: { pass: true, detail: "something new" } })),
    ).toThrow();
  });
});

describe("evaluateCommittedRuns (committed cascade artifacts)", () => {
  it("evaluates development rows only and excludes held-out rows from parsing", () => {
    const runs = evaluateCommittedRuns();
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.developmentTrials).toBe(3);
      expect(run.heldOutRowsExcluded).toBe(2);
      expect(
        run.trials.every((trial) => !["wm-dink-01", "afn-vic-rally1"].includes(trial.caseId)),
      ).toBe(true);
      expect(run.silentFailureTrials).toBeLessThanOrEqual(run.answeredTrials);
    }
  });
});
