import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUE_RULES,
  INITIAL_COACH_STATE,
  selectCue,
  type CoachState,
  type RepObservation,
} from "../src/index.js";

function rep(partial: Partial<RepObservation> & { repIndex: number }): RepObservation {
  return {
    resultKind: "scored",
    overallScore: 7.0,
    focusCheckpoint: "contact_position",
    focusScore: 70,
    focusDirection: "late",
    focusSeverity: 0.3,
    ...partial,
  };
}

/** Run a sequence of reps through the engine, returning categories spoken. */
function run(reps: RepObservation[], initial: CoachState = INITIAL_COACH_STATE) {
  const decisions = [];
  let state = initial;
  for (const r of reps) {
    const { decision, nextState } = selectCue(state, r);
    decisions.push(decision);
    state = nextState;
  }
  return { decisions, state };
}

describe("cue engine", () => {
  it("reproduces the spec's Live Court dialogue: correction → improvement → personal best", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 7.2, focusScore: 55, focusSeverity: 0.45 }),
      rep({ repIndex: 2, overallScore: 7.8, focusScore: 68, focusSeverity: 0.32 }),
      rep({ repIndex: 3, overallScore: 8.4, focusScore: 84, focusSeverity: 0.16 }),
    ]);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions[0]?.text).toMatch(/late/i);
    expect(decisions[1]?.category).toBe("IMPROVEMENT");
    expect(decisions[2]?.category).toBe("PERSONAL_BEST");
  });

  it("stays silent on a low-confidence rep, then coaches the SETUP after a streak", () => {
    const low = rep({
      repIndex: 1,
      resultKind: "low_confidence",
      overallScore: null,
      focusScore: null,
    });
    const { decisions } = run([low, { ...low, repIndex: 2 }, { ...low, repIndex: 3 }]);
    expect(decisions[0]?.category).toBe("SILENCE");
    expect(decisions[1]?.category).toBe("SILENCE");
    expect(decisions[2]?.category).toBe("CORRECTION");
    expect(decisions[2]?.text).toMatch(/framing/i);
  });

  it("uses REPEAT wording when the same fault persists back-to-back", () => {
    const { decisions } = run([
      rep({ repIndex: 1, focusScore: 55, focusSeverity: 0.45 }),
      rep({ repIndex: 2, focusScore: 54, focusSeverity: 0.46 }),
    ]);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions[1]?.category).toBe("REPEAT");
  });

  it("forces a quiet rep after max consecutive corrections — coach must not nag", () => {
    const faulty = (i: number) => rep({ repIndex: i, focusScore: 50, focusSeverity: 0.5 });
    const { decisions } = run([faulty(1), faulty(2), faulty(3), faulty(4)]);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions[1]?.category).toBe("REPEAT");
    expect(decisions[2]?.category).toBe("SILENCE");
    expect(decisions[3]?.category).toBe("CORRECTION");
  });

  it("praises stable reps sparsely with a cooldown, silence otherwise", () => {
    const good = (i: number, score: number) =>
      rep({ repIndex: i, overallScore: score, focusScore: 90, focusSeverity: 0.08 });
    // Descending scores so no personal best fires after rep 1.
    const { decisions } = run([
      good(1, 8.0),
      good(2, 7.9),
      good(3, 7.8),
      good(4, 7.7),
      good(5, 7.6),
    ]);
    const spoken = decisions.filter((d) => d.category !== "SILENCE");
    expect(decisions[0]?.category).toBe("STABLE");
    expect(spoken.length).toBeLessThanOrEqual(2);
    expect(decisions[1]?.category).toBe("SILENCE");
  });

  it("never announces a personal best on the first reps", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.0, focusSeverity: 0.1, focusScore: 88 }),
      rep({ repIndex: 2, overallScore: 9.0, focusSeverity: 0.05, focusScore: 95 }),
    ]);
    expect(decisions[1]?.category).not.toBe("PERSONAL_BEST");
  });

  it("every non-SILENCE decision carries text; SILENCE never does", () => {
    const seq = [
      rep({ repIndex: 1, focusSeverity: 0.5, focusScore: 50 }),
      rep({ repIndex: 2, resultKind: "low_confidence", overallScore: null, focusScore: null }),
      rep({ repIndex: 3, focusSeverity: 0.05, focusScore: 92 }),
    ];
    const { decisions } = run(seq);
    for (const d of decisions) {
      if (d.category === "SILENCE") expect(d.text).toBeNull();
      else expect(d.text).toBeTruthy();
    }
  });

  it("is deterministic — identical inputs yield identical outputs", () => {
    const seq = [
      rep({ repIndex: 1, focusSeverity: 0.4, focusScore: 58 }),
      rep({ repIndex: 2, focusSeverity: 0.2, focusScore: 72 }),
    ];
    const a = run(seq);
    const b = run(seq);
    expect(a.decisions).toEqual(b.decisions);
    expect(a.state).toEqual(b.state);
  });

  it("default rules match spec sparseness intent", () => {
    expect(DEFAULT_CUE_RULES.maxConsecutiveCorrections).toBeLessThanOrEqual(3);
    expect(DEFAULT_CUE_RULES.stableCooldownReps).toBeGreaterThanOrEqual(3);
  });
});
