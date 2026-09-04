/**
 * ADVERSARIAL PASS — audio-coach-core (BROKEN set).
 *
 * Each test asserts the contract the cue engines are supposed to honour and
 * FAILS against 4d812e1a — a documented finding. When the production fix
 * lands these tests move into the HELD file unchanged. No production code is
 * touched here.
 */
import { describe, expect, it } from "vitest";
import {
  INITIAL_COACH_STATE,
  INITIAL_LIVE_COACH_STATE,
  selectCue,
  selectLiveCue,
  sessionEndLine,
  type LiveRepObservation,
  type RepObservation,
} from "../src/index.js";

function liveRep(partial: Partial<LiveRepObservation> & { repIndex: number }): LiveRepObservation {
  return { kind: "scored", overallScore: 6.5, checkpoints: [], ...partial };
}

function rep(partial: Partial<RepObservation> & { repIndex: number }): RepObservation {
  return {
    resultKind: "scored",
    overallScore: 7.0,
    focusCheckpoint: "contact_position",
    focusScore: 70,
    focusDirection: "late",
    focusSeverity: 0.05,
    ...partial,
  };
}

// ─── corrupt scores poison the session ─────────────────────────────────────

describe("selectLiveCue — non-finite overallScore (corrupt state)", () => {
  it("never speaks 'NaN.' and a NaN rep must not poison bestOverall for the rest of the session", () => {
    let state = INITIAL_LIVE_COACH_STATE;
    const first = selectLiveCue(state, liveRep({ repIndex: 1, overallScore: 6.0 }));
    state = first.nextState;
    const poison = selectLiveCue(state, liveRep({ repIndex: 2, overallScore: Number.NaN }));
    state = poison.nextState;
    // EXPECTED: a non-finite score is not a score — spoken as a no-read (or
    // at least without the number) and ignored for the best-of-session.
    // OBSERVED: text "NaN. Great rep…", bestOverall becomes NaN and every
    // later personal best is silently lost (NaN comparisons are false).
    expect(poison.decision.text).not.toMatch(/NaN/);
    expect(Number.isFinite(state.bestOverall)).toBe(true);
    const pb = selectLiveCue(state, liveRep({ repIndex: 3, overallScore: 9.9 }));
    expect(pb.decision.category).toBe("PERSONAL_BEST");
  });

  it("an Infinity score is not announced and does not make every later swing a non-best", () => {
    let state = INITIAL_LIVE_COACH_STATE;
    state = selectLiveCue(state, liveRep({ repIndex: 1, overallScore: 6.0 })).nextState;
    const inf = selectLiveCue(
      state,
      liveRep({ repIndex: 2, overallScore: Number.POSITIVE_INFINITY }),
    );
    state = inf.nextState;
    expect(inf.decision.text).not.toMatch(/Infinity/);
    expect(Number.isFinite(state.bestOverall)).toBe(true);
    const pb = selectLiveCue(state, liveRep({ repIndex: 3, overallScore: 9.9 }));
    expect(pb.decision.category).toBe("PERSONAL_BEST");
  });
});

describe("selectCue — non-finite overallScore (corrupt state)", () => {
  it("a NaN overall score must not poison bestOverallScore (personal bests lost for the whole session)", () => {
    let state = INITIAL_COACH_STATE;
    state = selectCue(state, rep({ repIndex: 1, overallScore: 6.0 })).nextState;
    state = selectCue(state, rep({ repIndex: 2, overallScore: Number.NaN })).nextState;
    expect(Number.isFinite(state.bestOverallScore)).toBe(true);
    const pb = selectCue(state, rep({ repIndex: 3, overallScore: 9.9 }));
    expect(pb.decision.category).toBe("PERSONAL_BEST");
  });
});

// ─── sessionEndLine self-consistency ───────────────────────────────────────

describe("sessionEndLine — the spoken numbers and the spoken trend must agree", () => {
  it("does not say 'started around 6.2 and finished around 6.3 — held steady at 6.3'", () => {
    const line = sessionEndLine({ scoredCount: 4, startAverage: 6.24, endAverage: 6.26, best: 7 });
    // EXPECTED: rounding happens BEFORE the trend decision so the two spoken
    // numbers and the verdict agree (either "6.2 → 6.3 — up 0.1" or
    // "6.2 → 6.2 — held steady"). OBSERVED: contradictory sentence.
    const [, start, end] = /started around ([\d.]+) and finished around ([\d.]+)/.exec(line) ?? [];
    if (line.includes("held steady")) expect(start).toBe(end);
    else expect(start).not.toBe(end);
  });

  it("does not say 'started around 6.3 and finished around 6.3 — up 0.1'", () => {
    const line = sessionEndLine({ scoredCount: 4, startAverage: 6.26, endAverage: 6.34, best: 7 });
    const [, start, end] = /started around ([\d.]+) and finished around ([\d.]+)/.exec(line) ?? [];
    if (start === end) expect(line).toContain("held steady");
    else expect(line).toMatch(/— (up|down) /);
  });

  it("non-finite averages/best never reach speech", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        sessionEndLine({ scoredCount: 3, startAverage: bad, endAverage: 6, best: 7 }),
      ).not.toMatch(/NaN|Infinity/);
      expect(
        sessionEndLine({ scoredCount: 1, startAverage: null, endAverage: null, best: bad }),
      ).not.toMatch(/NaN|Infinity/);
    }
  });
});
