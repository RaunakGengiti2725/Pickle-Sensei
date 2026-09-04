/**
 * ADVERSARIAL PASS #3 — @pickle/audio-coach-core cue engines under
 * non-finite numbers, corrupt keys, huge inputs and seeded fuzz.
 *
 * Tests named BROKEN pin measured behaviour that contradicts the engine's
 * own contract ("honest", "never exaggerates", "0–10 overall") and are
 * reported as findings; HELD tests pin defences that survived.
 */
import { describe, expect, it } from "vitest";
import type { CheckpointKey, FaultDirection } from "@pickle/shared-types";
import {
  DEFAULT_CUE_RULES,
  DEFAULT_LIVE_CUE_RULES,
  formatSpokenScore,
  INITIAL_COACH_STATE,
  INITIAL_LIVE_COACH_STATE,
  selectCue,
  selectLiveCue,
  sessionEndLine,
  worstCheckpoint,
  type LiveCheckpointObservation,
  type LiveCoachSessionState,
  type LiveRepObservation,
} from "../src/index.js";

function cp(
  key: CheckpointKey,
  severity: number,
  extra: Partial<LiveCheckpointObservation> = {},
): LiveCheckpointObservation {
  return {
    key,
    score: 50,
    direction: "low" as FaultDirection,
    severity,
    applicable: true,
    ...extra,
  };
}

function scored(
  repIndex: number,
  overallScore: number | null,
  checkpoints: LiveCheckpointObservation[],
): LiveRepObservation {
  return { repIndex, kind: "scored", overallScore, checkpoints };
}

// ─── formatSpokenScore / sessionEndLine ─────────────────────────────────────

describe("formatSpokenScore + sessionEndLine with non-finite input", () => {
  it("BROKEN: formatSpokenScore(NaN|±Infinity) returns TTS-unfriendly literals", () => {
    expect(formatSpokenScore(Number.NaN)).toBe("NaN");
    expect(formatSpokenScore(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(formatSpokenScore(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
  });

  it("HELD: formatSpokenScore rounds half-up-ish via toFixed and never emits scientific notation for 0–10", () => {
    expect(formatSpokenScore(0)).toBe("0.0");
    expect(formatSpokenScore(10)).toBe("10.0");
    expect(formatSpokenScore(6.449999)).toBe("6.4");
    expect(formatSpokenScore(1e-7)).toBe("0.0");
    expect(formatSpokenScore(-0)).toBe("0.0");
  });

  it("BROKEN: sessionEndLine speaks 'held steady at NaN' when start average is NaN (|NaN| < 0.05 is false → 'down NaN')", () => {
    expect(
      sessionEndLine({ scoredCount: 2, startAverage: Number.NaN, endAverage: 7, best: 7 }),
    ).toBe("Session over. You started around NaN and finished around 7.0 — down NaN.");
    expect(
      sessionEndLine({
        scoredCount: 2,
        startAverage: Number.POSITIVE_INFINITY,
        endAverage: Number.POSITIVE_INFINITY,
        best: Number.POSITIVE_INFINITY,
      }),
      // Infinity - Infinity = NaN → not < 0.05 → "down NaN"
    ).toBe("Session over. You started around Infinity and finished around Infinity — down NaN.");
  });

  it("BROKEN: scoredCount NEGATIVE or fractional is accepted and produces a trend line", () => {
    expect(sessionEndLine({ scoredCount: -3, startAverage: 6, endAverage: 7, best: 7 })).toBe(
      "Session over. Best swing today: 7.0.",
    );
    expect(sessionEndLine({ scoredCount: 2.5, startAverage: 6, endAverage: 7, best: 7 })).toBe(
      "Session over. You started around 6.0 and finished around 7.0 — up 1.0.",
    );
  });

  it("HELD: scoredCount 1 with all-null numbers, and scoredCount 2 with null averages, fall to honest fallbacks", () => {
    expect(
      sessionEndLine({ scoredCount: 1, startAverage: null, endAverage: null, best: null }),
    ).toBe("Session over. Good work out there.");
    expect(sessionEndLine({ scoredCount: 2, startAverage: null, endAverage: null, best: 8 })).toBe(
      "Session over. Best swing today: 8.0.",
    );
  });

  it("HELD: a 0.049 delta is 'held steady'; 6.05-6 is 0.04999… in floating point so it is ALSO 'held steady'; 0.06 is 'up 0.1'", () => {
    expect(
      sessionEndLine({ scoredCount: 2, startAverage: 6, endAverage: 6.049, best: 6.049 }),
    ).toContain("held steady");
    expect(sessionEndLine({ scoredCount: 2, startAverage: 6, endAverage: 6.05, best: 6.05 })).toBe(
      "Session over. You started around 6.0 and finished around 6.0 — held steady at 6.0.",
    );
    expect(sessionEndLine({ scoredCount: 2, startAverage: 6, endAverage: 6.06, best: 6.06 })).toBe(
      "Session over. You started around 6.0 and finished around 6.1 — up 0.1.",
    );
  });
});

// ─── worstCheckpoint ────────────────────────────────────────────────────────

describe("worstCheckpoint with non-finite severities", () => {
  it("BROKEN: a NaN-severity checkpoint is chosen when listed first and can never be displaced (NaN > x, x > NaN, NaN === NaN all false)", () => {
    const nan = cp("paddle_set", Number.NaN);
    const real = cp("athletic_base", 0.9);
    expect(worstCheckpoint([nan, real])).toBe(nan);
    expect(worstCheckpoint([real, nan])).toBe(real);
  });

  it("BROKEN: -Infinity / negative severities are legal 'worst' checkpoints and outrank nothing, but are still returned when alone", () => {
    const neg = cp("paddle_set", Number.NEGATIVE_INFINITY);
    expect(worstCheckpoint([neg])).toBe(neg);
    expect(worstCheckpoint([neg, cp("athletic_base", 0)])?.key).toBe("athletic_base");
  });

  it("HELD: Infinity severity beats every finite severity regardless of order", () => {
    const inf = cp("sequencing", Number.POSITIVE_INFINITY);
    expect(worstCheckpoint([cp("athletic_base", 0.99), inf])).toBe(inf);
    expect(worstCheckpoint([inf, cp("athletic_base", 0.99)])).toBe(inf);
  });

  it("HELD: NaN/Infinity SCORES only affect tie-breaks; the tie-break with NaN score keeps the first (NaN < x is false)", () => {
    const a = cp("paddle_set", 0.5, { score: Number.NaN });
    const b = cp("athletic_base", 0.5, { score: 10 });
    // candidate b: 10 < NaN → false → keeps a. Order-dependent again.
    expect(worstCheckpoint([a, b])).toBe(a);
    expect(worstCheckpoint([b, a])).toBe(b);
  });

  it("HELD: 100k checkpoints resolve in linear time with a deterministic result (seed 0xC0FFEE)", () => {
    let seed = 0xc0ffee;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const many: LiveCheckpointObservation[] = [];
    for (let i = 0; i < 100_000; i += 1) {
      many.push(
        cp("athletic_base", Math.floor(rand() * 1000) / 1000, { score: Math.floor(rand() * 100) }),
      );
    }
    const t0 = performance.now();
    const worst = worstCheckpoint(many);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(worst?.severity).toBe(Math.max(...many.map((c) => c.severity)));
  });
});

// ─── selectLiveCue ──────────────────────────────────────────────────────────

describe("selectLiveCue with corrupt reps", () => {
  it("BROKEN: NaN overallScore is announced as 'NaN.' and the praise counter advances", () => {
    const { decision, nextState } = selectLiveCue(
      INITIAL_LIVE_COACH_STATE,
      scored(1, Number.NaN, []),
    );
    expect(decision.category).toBe("PRAISE");
    expect(decision.text).toBe("NaN. Great rep. Repeat that.");
    expect(decision.announcedScore).toBeNaN();
    expect(nextState.bestOverall).toBeNaN();
  });

  it("BROKEN: once bestOverall is NaN, PERSONAL_BEST is unreachable for the rest of the session", () => {
    let state: LiveCoachSessionState = INITIAL_LIVE_COACH_STATE;
    state = selectLiveCue(state, scored(1, Number.NaN, [])).nextState;
    state = selectLiveCue(state, scored(2, 5, [])).nextState;
    const r3 = selectLiveCue(state, scored(3, 9, []));
    const r4 = selectLiveCue(r3.nextState, scored(4, 10, []));
    expect(r3.decision.category).toBe("PRAISE");
    expect(r4.decision.category).toBe("PRAISE");
    expect(r4.nextState.bestOverall).toBeNaN();
  });

  it("BROKEN: a score OUTSIDE 0–10 (e.g. 250 or -4) is announced verbatim", () => {
    expect(selectLiveCue(INITIAL_LIVE_COACH_STATE, scored(1, 250, [])).decision.text).toBe(
      "250.0. Great rep. Repeat that.",
    );
    expect(selectLiveCue(INITIAL_LIVE_COACH_STATE, scored(1, -4, [])).decision.text).toBe(
      "-4.0. Great rep. Repeat that.",
    );
  });

  it("BROKEN: an unknown checkpoint key (runtime JSON) is voiced through the generic fallback, including any embedded text", () => {
    const bogus = cp("<script>alert(1)</script>" as CheckpointKey, 0.9, {
      direction: "sideways" as FaultDirection,
    });
    const { decision } = selectLiveCue(INITIAL_LIVE_COACH_STATE, scored(1, 5, [bogus]));
    expect(decision.category).toBe("CORRECTION");
    expect(decision.text).toBe("5.0. Focus on your <script>alert(1)</script>.");
  });

  it("HELD: kind 'low_confidence' / 'abstained' ignore checkpoints and score entirely", () => {
    const rep: LiveRepObservation = {
      repIndex: 1,
      kind: "low_confidence",
      overallScore: Number.NaN,
      checkpoints: [cp("athletic_base", Number.NaN)],
    };
    const { decision } = selectLiveCue(INITIAL_LIVE_COACH_STATE, rep);
    expect(decision.category).toBe("NO_READ");
    expect(decision.announcedScore).toBeNull();
    expect(decision.text).not.toContain("NaN");
  });

  it("HELD: scored with overallScore null and checkpoints undefined does not throw; praise without a score prefix", () => {
    const rep = { repIndex: 1, kind: "scored", overallScore: null } as LiveRepObservation;
    const { decision } = selectLiveCue(INITIAL_LIVE_COACH_STATE, rep);
    expect(decision).toEqual({
      category: "PRAISE",
      text: "Great rep. Repeat that.",
      targetCheckpoint: null,
      announcedScore: null,
    });
  });

  it("MIXED: a NaN previous checkpoint score never yields IMPROVEMENT (HELD), but a +Infinity score jump IS credited as IMPROVEMENT while the 0.9 fault persists (BROKEN)", () => {
    let state: LiveCoachSessionState = INITIAL_LIVE_COACH_STATE;
    state = selectLiveCue(
      state,
      scored(1, 5, [cp("athletic_base", 0.9, { score: Number.NaN })]),
    ).nextState;
    const afterNaN = selectLiveCue(state, scored(2, 6, [cp("athletic_base", 0.1, { score: 80 })]));
    expect(afterNaN.decision.category).toBe("PRAISE");

    state = INITIAL_LIVE_COACH_STATE;
    state = selectLiveCue(state, scored(1, 5, [cp("athletic_base", 0.9, { score: 10 })])).nextState;
    const inf = selectLiveCue(
      state,
      scored(2, 6, [cp("athletic_base", 0.9, { score: Number.POSITIVE_INFINITY })]),
    );
    // Severity still 0.9 (fault persists) yet IMPROVEMENT wins on the ∞ score.
    expect(inf.decision.category).toBe("IMPROVEMENT");
  });

  it("HELD: repIndex NaN / negative / huge never breaks selection (personal best just never fires for NaN)", () => {
    let state: LiveCoachSessionState = INITIAL_LIVE_COACH_STATE;
    state = selectLiveCue(state, scored(Number.NaN, 5, [])).nextState;
    const r = selectLiveCue(state, scored(Number.NaN, 9, []));
    expect(r.decision.category).toBe("PRAISE");
    expect(selectLiveCue(state, scored(-1, 9, [])).decision.category).toBe("PRAISE");
    expect(selectLiveCue(state, scored(Number.MAX_SAFE_INTEGER, 9, [])).decision.category).toBe(
      "PERSONAL_BEST",
    );
  });

  it("HELD: 20k-rep seeded fuzz (seed 0x5EED) never throws, every decision has a category and non-empty text, and state stays finite for finite input", () => {
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const keys: CheckpointKey[] = ["athletic_base", "paddle_set", "contact_position", "sequencing"];
    let state: LiveCoachSessionState = INITIAL_LIVE_COACH_STATE;
    for (let i = 1; i <= 20_000; i += 1) {
      const r = rand();
      const rep: LiveRepObservation =
        r < 0.15
          ? {
              repIndex: i,
              kind: r < 0.07 ? "low_confidence" : "abstained",
              overallScore: null,
              checkpoints: [],
            }
          : scored(
              i,
              Math.round(rand() * 100) / 10,
              Array.from({ length: Math.floor(rand() * 4) }, () =>
                cp(keys[Math.floor(rand() * keys.length)]!, Math.round(rand() * 100) / 100, {
                  score: Math.floor(rand() * 101),
                  applicable: rand() > 0.1,
                }),
              ),
            );
      const { decision, nextState } = selectLiveCue(state, rep);
      expect(decision.text.length).toBeGreaterThan(0);
      expect(decision.text).not.toMatch(/NaN|Infinity|undefined|null/);
      state = nextState;
    }
    expect(Number.isFinite(state.bestOverall ?? 0)).toBe(true);
  });
});

// ─── selectCue (sparse engine used by LiveCourtEngine) ─────────────────────

describe("selectCue (sparse engine) with non-finite input", () => {
  it("BROKEN: focusSeverity NaN is neither ≥ correction nor ≤ stable → SILENCE, and the fault is never coached; NaN focusScore blocks future improvements", () => {
    const r = selectCue(INITIAL_COACH_STATE, {
      repIndex: 1,
      resultKind: "scored",
      overallScore: 5,
      focusCheckpoint: "athletic_base",
      focusScore: Number.NaN,
      focusDirection: "low",
      focusSeverity: Number.NaN,
    });
    expect(r.decision.category).toBe("SILENCE");
    expect(r.nextState.previousFocusScore).toBeNaN();
  });

  it("BROKEN: overallScore NaN poisons bestOverallScore in the sparse engine too", () => {
    let state = INITIAL_COACH_STATE;
    const rep = (repIndex: number, overallScore: number) => ({
      repIndex,
      resultKind: "scored" as const,
      overallScore,
      focusCheckpoint: "athletic_base" as CheckpointKey,
      focusScore: 50,
      focusDirection: "none" as FaultDirection,
      focusSeverity: 0.2,
    });
    state = selectCue(state, rep(1, Number.NaN)).nextState;
    state = selectCue(state, rep(2, 5)).nextState;
    const r = selectCue(state, rep(3, 9.9));
    expect(r.decision.category).not.toBe("PERSONAL_BEST");
    expect(r.nextState.bestOverallScore).toBeNaN();
  });

  it("HELD: max-consecutive-corrections forced silence still applies with Infinity severity", () => {
    let state = INITIAL_COACH_STATE;
    const rep = (repIndex: number) => ({
      repIndex,
      resultKind: "scored" as const,
      overallScore: 4,
      focusCheckpoint: "athletic_base" as CheckpointKey,
      focusScore: 20,
      focusDirection: "low" as FaultDirection,
      focusSeverity: Number.POSITIVE_INFINITY,
    });
    const cats: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const r = selectCue(state, rep(i), DEFAULT_CUE_RULES);
      cats.push(r.decision.category);
      state = r.nextState;
    }
    expect(cats).toEqual(["CORRECTION", "REPEAT", "SILENCE", "CORRECTION", "REPEAT", "SILENCE"]);
  });

  it("HELD: DEFAULT_LIVE_CUE_RULES and DEFAULT_CUE_RULES are frozen-equivalent constants (no mutation leaks between calls)", () => {
    const before = JSON.stringify(DEFAULT_LIVE_CUE_RULES);
    selectLiveCue(INITIAL_LIVE_COACH_STATE, scored(1, 5, [cp("athletic_base", 0.9)]));
    expect(JSON.stringify(DEFAULT_LIVE_CUE_RULES)).toBe(before);
    expect(INITIAL_LIVE_COACH_STATE.praiseCounter).toBe(0);
    expect(INITIAL_LIVE_COACH_STATE.previousCheckpointScores).toEqual({});
  });
});
