/**
 * ADVERSARIAL PASS — audio-coach-core (HELD set).
 *
 * Hostile inputs to the two deterministic cue engines (`selectCue`,
 * `selectLiveCue`) and the phrase helpers that the code at 4d812e1a is
 * expected to SURVIVE: purity of state, determinism, bounded time on huge
 * inputs, never-empty live text, no `undefined`/`null` leaking into speech
 * for well-formed input, cooldown/streak arithmetic under out-of-order and
 * clock-skewed rep indices. The sibling `attack.cueEngines.broken.test.ts`
 * holds the attacks that currently FAIL.
 *
 * Seeded randomness: LCG below, seed in the test name.
 */
import { describe, expect, it } from "vitest";
import { CHECKPOINTS, FAULT_DIRECTIONS } from "@pickle/shared-types";
import type { CheckpointKey, FaultDirection } from "@pickle/shared-types";
import {
  DEFAULT_CUE_RULES,
  DEFAULT_LIVE_CUE_RULES,
  INITIAL_COACH_STATE,
  INITIAL_LIVE_COACH_STATE,
  NO_READ_VARIANTS,
  PRAISE_VARIANTS,
  correctionPhrase,
  improvementPhrase,
  selectCue,
  selectLiveCue,
  sessionEndLine,
  worstCheckpoint,
  type CoachState,
  type LiveCheckpointObservation,
  type LiveCoachSessionState,
  type LiveRepObservation,
  type RepObservation,
} from "../src/index.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function cp(
  partial: Partial<LiveCheckpointObservation> & { key: CheckpointKey },
): LiveCheckpointObservation {
  return { score: 60, direction: "late", severity: 0.4, applicable: true, ...partial };
}

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
    focusSeverity: 0.3,
    ...partial,
  };
}

// ─── purity & determinism ──────────────────────────────────────────────────

describe("selectLiveCue — purity and determinism", () => {
  it("never mutates its input state or rep (deep-frozen inputs, 300 reps)", () => {
    const rnd = lcg(7);
    let state: LiveCoachSessionState = deepFreeze({ ...INITIAL_LIVE_COACH_STATE });
    for (let i = 1; i <= 300; i += 1) {
      const observation = deepFreeze(
        liveRep({
          repIndex: i,
          kind: rnd() < 0.2 ? "abstained" : rnd() < 0.3 ? "low_confidence" : "scored",
          overallScore: Math.round(rnd() * 100) / 10,
          checkpoints: CHECKPOINTS.map((key) =>
            cp({
              key,
              score: Math.round(rnd() * 100),
              direction: FAULT_DIRECTIONS[
                Math.floor(rnd() * FAULT_DIRECTIONS.length)
              ] as FaultDirection,
              severity: Math.round(rnd() * 100) / 100,
              applicable: rnd() < 0.9,
            }),
          ),
        }),
      );
      const { nextState } = selectLiveCue(state, observation);
      state = deepFreeze(nextState);
    }
    expect(INITIAL_LIVE_COACH_STATE).toEqual({
      bestOverall: null,
      lastSpoken: null,
      previousCheckpointScores: {},
      praiseCounter: 0,
      noReadCounter: 0,
      noReadStreak: 0,
    });
  });

  for (const seed of [3, 0xbeef, 20260904]) {
    it(`seed=${seed}: identical inputs → identical outputs; text never empty; no undefined/null/NaN leaks`, () => {
      const make = () => {
        const rnd = lcg(seed);
        const reps: LiveRepObservation[] = [];
        for (let i = 1; i <= 200; i += 1) {
          const kind = rnd() < 0.2 ? "abstained" : rnd() < 0.3 ? "low_confidence" : "scored";
          reps.push(
            liveRep({
              repIndex: i,
              kind,
              overallScore: kind === "scored" ? Math.round(rnd() * 100) / 10 : null,
              checkpoints:
                kind === "scored"
                  ? CHECKPOINTS.filter(() => rnd() < 0.7).map((key) =>
                      cp({
                        key,
                        score: rnd() < 0.1 ? null : Math.round(rnd() * 100),
                        direction: FAULT_DIRECTIONS[
                          Math.floor(rnd() * FAULT_DIRECTIONS.length)
                        ] as FaultDirection,
                        severity: Math.round(rnd() * 100) / 100,
                        applicable: rnd() < 0.85,
                      }),
                    )
                  : [],
            }),
          );
        }
        return reps;
      };
      const run = (reps: LiveRepObservation[]) => {
        let state = INITIAL_LIVE_COACH_STATE;
        const out = [];
        for (const r of reps) {
          const { decision, nextState } = selectLiveCue(state, r);
          out.push(decision);
          state = nextState;
        }
        return out;
      };
      const a = run(make());
      const b = run(make());
      expect(a).toEqual(b);
      for (const decision of a) {
        expect(decision.text.length).toBeGreaterThan(0);
        expect(decision.text).not.toMatch(/undefined|null|NaN|Infinity|\[object/);
        if (decision.announcedScore !== null) {
          expect(decision.text.startsWith(decision.announcedScore.toFixed(1))).toBe(
            decision.category !== "PERSONAL_BEST",
          );
        }
      }
    });
  }
});

describe("selectCue — purity and determinism", () => {
  it("never mutates its input state (deep-frozen, 300 reps incl. low-confidence and out-of-order indices)", () => {
    const rnd = lcg(11);
    let state: CoachState = deepFreeze({ ...INITIAL_COACH_STATE });
    for (let i = 0; i < 300; i += 1) {
      const observation = deepFreeze(
        rep({
          repIndex: Math.floor(rnd() * 50) - 5, // out of order, negative, zero
          resultKind: rnd() < 0.25 ? "low_confidence" : "scored",
          overallScore: rnd() < 0.1 ? null : Math.round(rnd() * 100) / 10,
          focusScore: rnd() < 0.1 ? null : Math.round(rnd() * 100),
          focusSeverity: Math.round(rnd() * 100) / 100,
          focusDirection: FAULT_DIRECTIONS[
            Math.floor(rnd() * FAULT_DIRECTIONS.length)
          ] as FaultDirection,
          focusCheckpoint: CHECKPOINTS[Math.floor(rnd() * CHECKPOINTS.length)] as CheckpointKey,
        }),
      );
      const { decision, nextState } = selectCue(state, observation);
      expect(decision.text === null).toBe(decision.category === "SILENCE");
      if (decision.text !== null) expect(decision.text).not.toMatch(/undefined|null|NaN/);
      state = deepFreeze(nextState);
    }
    expect(INITIAL_COACH_STATE.consecutiveCorrections).toBe(0);
    expect(INITIAL_COACH_STATE.bestOverallScore).toBeNull();
  });
});

// ─── rapid repeats / streak arithmetic ─────────────────────────────────────

describe("selectCue — sparse policy under rapid repeats", () => {
  it("the same fault 1 000 times in a row is spoken as CORRECTION, REPEAT, SILENCE, CORRECTION, REPEAT, SILENCE … (never more than 2 in a row)", () => {
    let state = INITIAL_COACH_STATE;
    const categories: string[] = [];
    for (let i = 1; i <= 1000; i += 1) {
      const { decision, nextState } = selectCue(state, rep({ repIndex: i, focusSeverity: 0.6 }));
      categories.push(decision.category);
      state = nextState;
    }
    expect(categories.slice(0, 6)).toEqual([
      "CORRECTION",
      "REPEAT",
      "SILENCE",
      "CORRECTION",
      "REPEAT",
      "SILENCE",
    ]);
    let run = 0;
    for (const category of categories) {
      run = category === "SILENCE" ? 0 : run + 1;
      expect(run).toBeLessThanOrEqual(DEFAULT_CUE_RULES.maxConsecutiveCorrections);
    }
  });

  it("1 000 perfect reps → STABLE praise exactly every stableCooldownReps, silence otherwise", () => {
    let state = INITIAL_COACH_STATE;
    const praisedAt: number[] = [];
    for (let i = 1; i <= 1000; i += 1) {
      const { decision, nextState } = selectCue(state, rep({ repIndex: i, focusSeverity: 0.05 }));
      if (decision.category === "STABLE") praisedAt.push(i);
      else expect(decision.category).toBe("SILENCE");
      state = nextState;
    }
    expect(praisedAt.length).toBe(Math.ceil(1000 / DEFAULT_CUE_RULES.stableCooldownReps));
    for (let i = 1; i < praisedAt.length; i += 1) {
      expect(praisedAt[i]! - praisedAt[i - 1]!).toBe(DEFAULT_CUE_RULES.stableCooldownReps);
    }
  });

  it("low-confidence streak: guidance at exactly N, streak resets after guidance and on any scored rep", () => {
    let state = INITIAL_COACH_STATE;
    const n = DEFAULT_CUE_RULES.lowConfidenceGuidanceAfter;
    const out: string[] = [];
    const feed = (r: RepObservation) => {
      const { decision, nextState } = selectCue(state, r);
      out.push(decision.category);
      state = nextState;
    };
    for (let i = 1; i <= 2 * n; i += 1)
      feed(rep({ repIndex: i, resultKind: "low_confidence", overallScore: null }));
    expect(out.filter((c) => c === "CORRECTION")).toHaveLength(2);
    expect(out[n - 1]).toBe("CORRECTION");
    expect(out[2 * n - 1]).toBe("CORRECTION");
    out.length = 0;
    for (let i = 1; i < n; i += 1)
      feed(rep({ repIndex: 100 + i, resultKind: "low_confidence", overallScore: null }));
    feed(rep({ repIndex: 200, focusSeverity: 0.05 }));
    feed(rep({ repIndex: 201, resultKind: "low_confidence", overallScore: null }));
    expect(out).not.toContain("CORRECTION");
  });

  it("clock-skewed / out-of-order repIndex never crashes and never produces a negative cooldown praise burst", () => {
    let state = INITIAL_COACH_STATE;
    const indices = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, -1, -2, 1_000_000, 1_000_001];
    let praised = 0;
    for (const repIndex of indices) {
      const { decision, nextState } = selectCue(state, rep({ repIndex, focusSeverity: 0.05 }));
      if (decision.category === "STABLE") praised += 1;
      state = nextState;
    }
    // 10 praised; 9..-2 are all "before" the last praise (negative distance)
    // so stay silent; 1_000_000 and +1: first praised, second is inside cooldown.
    expect(praised).toBe(2);
  });
});

describe("selectLiveCue — streaks, rotation and interleavings", () => {
  it("no-read streak: SETUP_GUIDANCE at exactly setupGuidanceAfter, rotation of NO_READ_VARIANTS is deterministic, a scored rep resets the streak", () => {
    const n = DEFAULT_LIVE_CUE_RULES.setupGuidanceAfter;
    let state = INITIAL_LIVE_COACH_STATE;
    const out: string[] = [];
    const texts: string[] = [];
    for (let i = 1; i <= 3 * n; i += 1) {
      const { decision, nextState } = selectLiveCue(
        state,
        liveRep({ repIndex: i, kind: "abstained", overallScore: null }),
      );
      out.push(decision.category);
      texts.push(decision.text);
      state = nextState;
    }
    for (let i = 0; i < 3 * n; i += 1) {
      expect(out[i]).toBe((i + 1) % n === 0 ? "SETUP_GUIDANCE" : "NO_READ");
    }
    const noReadTexts = texts.filter((_, i) => out[i] === "NO_READ");
    noReadTexts.forEach((text, i) =>
      expect(text).toBe(NO_READ_VARIANTS[i % NO_READ_VARIANTS.length]),
    );

    // Interleave: n-1 no-reads, one scored, n-1 no-reads → never guidance.
    state = INITIAL_LIVE_COACH_STATE;
    const categories: string[] = [];
    const feed = (r: LiveRepObservation) => {
      const { decision, nextState } = selectLiveCue(state, r);
      categories.push(decision.category);
      state = nextState;
    };
    for (let i = 1; i < n; i += 1)
      feed(liveRep({ repIndex: i, kind: "low_confidence", overallScore: null }));
    feed(liveRep({ repIndex: n, overallScore: 6.0 }));
    for (let i = 1; i < n; i += 1)
      feed(liveRep({ repIndex: n + i, kind: "abstained", overallScore: null }));
    expect(categories).not.toContain("SETUP_GUIDANCE");
  });

  it("praise rotation cycles PRAISE_VARIANTS in order for 1 000 clean reps and always prefixes the score", () => {
    let state = INITIAL_LIVE_COACH_STATE;
    for (let i = 1; i <= 1000; i += 1) {
      const { decision, nextState } = selectLiveCue(
        state,
        liveRep({ repIndex: i, overallScore: 7.0 }),
      );
      // 7.0 never beats bestOverall 7.0 → PRAISE every time.
      expect(decision.category).toBe("PRAISE");
      expect(decision.text).toBe(`7.0. ${PRAISE_VARIANTS[(i - 1) % PRAISE_VARIANTS.length]}`);
      state = nextState;
    }
  });

  it("personal best is announced only when strictly greater than the best AND repIndex >= personalBestMinRep", () => {
    let state = INITIAL_LIVE_COACH_STATE;
    const minRep = DEFAULT_LIVE_CUE_RULES.personalBestMinRep;
    const feed = (repIndex: number, overallScore: number) => {
      const r = selectLiveCue(state, liveRep({ repIndex, overallScore }));
      state = r.nextState;
      return r.decision.category;
    };
    expect(feed(1, 5.0)).toBe("PRAISE");
    expect(feed(2, 9.0)).toBe("PRAISE"); // beats best but before minRep
    expect(feed(minRep, 9.0)).toBe("PRAISE"); // ties never announce
    expect(feed(minRep + 1, 9.1)).toBe("PERSONAL_BEST");
    expect(feed(minRep + 2, 9.1)).toBe("PRAISE");
  });

  it("repeat wording only when the SAME checkpoint AND direction persists across consecutive spoken corrections", () => {
    let state = INITIAL_LIVE_COACH_STATE;
    const feed = (checkpoints: LiveCheckpointObservation[]) => {
      const r = selectLiveCue(state, liveRep({ repIndex: 1, checkpoints }));
      state = r.nextState;
      return r.decision;
    };
    expect(feed([cp({ key: "contact_position", direction: "late", severity: 0.5 })]).category).toBe(
      "CORRECTION",
    );
    expect(feed([cp({ key: "contact_position", direction: "late", severity: 0.5 })]).category).toBe(
      "REPEAT_CORRECTION",
    );
    // same checkpoint, different direction → fresh correction
    expect(
      feed([cp({ key: "contact_position", direction: "early", severity: 0.5 })]).category,
    ).toBe("CORRECTION");
    // a no-read in between breaks the chain
    state = selectLiveCue(
      state,
      liveRep({ repIndex: 5, kind: "abstained", overallScore: null }),
    ).nextState;
    expect(
      feed([cp({ key: "contact_position", direction: "early", severity: 0.5 })]).category,
    ).toBe("CORRECTION");
  });
});

// ─── hostile checkpoint payloads ───────────────────────────────────────────

describe("worstCheckpoint / selectLiveCue — hostile checkpoint payloads", () => {
  it("100 000 checkpoints (huge input) resolve in bounded time and pick the true argmax (ties → lower score → input order)", () => {
    const rnd = lcg(0xc0ffee);
    const checkpoints: LiveCheckpointObservation[] = [];
    for (let i = 0; i < 100_000; i += 1) {
      checkpoints.push(
        cp({
          key: CHECKPOINTS[i % CHECKPOINTS.length] as CheckpointKey,
          severity: Math.round(rnd() * 1000) / 1000,
          score: rnd() < 0.05 ? null : Math.round(rnd() * 100),
          applicable: rnd() < 0.95,
        }),
      );
    }
    const started = Date.now();
    const worst = worstCheckpoint(checkpoints);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(worst).not.toBeNull();
    const maxSeverity = Math.max(...checkpoints.filter((c) => c.applicable).map((c) => c.severity));
    expect(worst!.severity).toBe(maxSeverity);
    const candidates = checkpoints.filter((c) => c.applicable && c.severity === maxSeverity);
    const minScore = Math.min(...candidates.map((c) => c.score ?? 100));
    expect(worst!.score ?? 100).toBe(minScore);
    expect(worst).toBe(candidates.find((c) => (c.score ?? 100) === minScore));

    const { decision } = selectLiveCue(
      INITIAL_LIVE_COACH_STATE,
      liveRep({ repIndex: 1, checkpoints }),
    );
    expect(decision.category).toBe("CORRECTION");
    expect(decision.targetCheckpoint).toBe(worst!.key);
  });

  it("all-inapplicable, empty, and null-score checkpoint sets never crash; empty/inapplicable → PRAISE", () => {
    for (const checkpoints of [
      [],
      CHECKPOINTS.map((key) => cp({ key, applicable: false, severity: 1 })),
      CHECKPOINTS.map((key) => cp({ key, score: null, severity: 0 })),
    ]) {
      const { decision } = selectLiveCue(
        INITIAL_LIVE_COACH_STATE,
        liveRep({ repIndex: 1, checkpoints }),
      );
      expect(decision.category).toBe("PRAISE");
      expect(decision.text.length).toBeGreaterThan(0);
    }
  });

  it("severity outside 0–1 (negative, 1e9) and 'none' direction still produce a phrase, never a crash or empty text", () => {
    const { decision: neg } = selectLiveCue(
      INITIAL_LIVE_COACH_STATE,
      liveRep({ repIndex: 1, checkpoints: [cp({ key: "recovery", severity: -5 })] }),
    );
    expect(neg.category).toBe("PRAISE");
    const { decision: huge } = selectLiveCue(
      INITIAL_LIVE_COACH_STATE,
      liveRep({
        repIndex: 1,
        checkpoints: [cp({ key: "recovery", severity: 1e9, direction: "none" })],
      }),
    );
    expect(huge.category).toBe("CORRECTION");
    expect(huge.text).toBe("6.5. Focus on your recovery.");
  });

  it("every (checkpoint, direction) pair has a non-empty correction phrase without `undefined` and every checkpoint an improvement phrase", () => {
    for (const key of CHECKPOINTS) {
      for (const direction of FAULT_DIRECTIONS) {
        const phrase = correctionPhrase(key, direction);
        expect(phrase.length).toBeGreaterThan(0);
        expect(phrase).not.toMatch(/undefined|_/);
      }
      expect(improvementPhrase(key).length).toBeGreaterThan(0);
    }
  });

  it("improvement is detected against the PREVIOUS scored rep's checkpoint scores, even when duplicate keys are present (last wins)", () => {
    let state = INITIAL_LIVE_COACH_STATE;
    // Correction on contact_position at 50 (a duplicate earlier entry says 90).
    state = selectLiveCue(
      state,
      liveRep({
        repIndex: 1,
        checkpoints: [
          cp({ key: "contact_position", score: 90, severity: 0 }),
          cp({ key: "contact_position", score: 50, severity: 0.6 }),
        ],
      }),
    ).nextState;
    expect(state.previousCheckpointScores.contact_position).toBe(50);
    const { decision } = selectLiveCue(
      state,
      liveRep({
        repIndex: 2,
        checkpoints: [cp({ key: "contact_position", score: 60, severity: 0.6 })],
      }),
    );
    expect(decision.category).toBe("IMPROVEMENT");
  });
});

// ─── sessionEndLine ────────────────────────────────────────────────────────

describe("sessionEndLine — honest closing line", () => {
  it("zero scored swings always wins, regardless of contradictory averages/best", () => {
    expect(sessionEndLine({ scoredCount: 0, startAverage: 9, endAverage: 1, best: 10 })).toBe(
      "Session over. No swings could be scored this time.",
    );
  });

  it("a decline is spoken as 'down', never clamped; a single swing is reported as such", () => {
    expect(sessionEndLine({ scoredCount: 5, startAverage: 7.5, endAverage: 6.0, best: 8 })).toBe(
      "Session over. You started around 7.5 and finished around 6.0 — down 1.5.",
    );
    expect(sessionEndLine({ scoredCount: 1, startAverage: 6.2, endAverage: 6.2, best: 6.2 })).toBe(
      "Session over. One scored swing at 6.2.",
    );
  });

  it("negative / fractional / huge scoredCount and missing averages fall through to a non-empty honest line", () => {
    for (const scoredCount of [-1, 0.5, 2.5, Number.MAX_SAFE_INTEGER]) {
      const line = sessionEndLine({
        scoredCount,
        startAverage: null,
        endAverage: null,
        best: null,
      });
      expect(line.startsWith("Session over.")).toBe(true);
      expect(line).not.toMatch(/NaN|undefined|null/);
    }
  });
});
