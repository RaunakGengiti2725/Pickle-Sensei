/**
 * ADVERSARIAL PASS 3 / tester #4 — live cue policy under hostile sequences.
 * Pure state-machine level (selectLiveCue): the S4/S5 questions plus a
 * seeded fuzz over long random sessions checking the invariants the coach
 * layer relies on. Seed recorded in each test name.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_CUE_RULES,
  INITIAL_LIVE_COACH_STATE,
  formatSpokenScore,
  selectLiveCue,
  type LiveCheckpointObservation,
  type LiveCoachSessionState,
  type LiveCueDecision,
  type LiveCueRules,
  type LiveRepObservation,
} from "../src/index.js";

function checkpoint(
  partial: Partial<LiveCheckpointObservation> & { key: LiveCheckpointObservation["key"] },
): LiveCheckpointObservation {
  return { score: 85, direction: "none", severity: 0, applicable: true, ...partial };
}

function rep(partial: Partial<LiveRepObservation> & { repIndex: number }): LiveRepObservation {
  return { kind: "scored", overallScore: 7.0, checkpoints: [], ...partial };
}

function run(reps: LiveRepObservation[], rules: LiveCueRules = DEFAULT_LIVE_CUE_RULES) {
  const decisions: LiveCueDecision[] = [];
  const states: LiveCoachSessionState[] = [];
  let state: LiveCoachSessionState = INITIAL_LIVE_COACH_STATE;
  for (const r of reps) {
    const { decision, nextState } = selectLiveCue(state, r, rules);
    decisions.push(decision);
    states.push(nextState);
    state = nextState;
  }
  return { decisions, states, state };
}

const kneeLow = (score: number, severity = 0.5) =>
  checkpoint({ key: "athletic_base", score, direction: "low", severity });

describe("S4 — improvement acknowledgement across an intervening no-read", () => {
  it("CORRECTION(athletic_base) → NO_READ → +12 on athletic_base is acknowledged as IMPROVEMENT", () => {
    const { decisions, states } = run([
      rep({ repIndex: 1, overallScore: 6.0, checkpoints: [kneeLow(40)] }),
      rep({ repIndex: 2, kind: "low_confidence", overallScore: null }),
      rep({ repIndex: 3, overallScore: 5.9, checkpoints: [kneeLow(52, 0.35)] }),
    ]);
    expect(decisions[0]!.category).toBe("CORRECTION");
    expect(decisions[1]!.category).toBe("NO_READ");
    // The comparison data survived the no-read (documented: "previous SCORED
    // rep's checkpoint scores")...
    expect(states[1]!.previousCheckpointScores["athletic_base"]).toBe(40);
    // ...so the improvement must be acknowledged.
    expect(decisions[2]!.category).toBe("IMPROVEMENT");
    expect(decisions[2]!.targetCheckpoint).toBe("athletic_base");
  });

  it("observed today: the no-read overwrites lastSpoken, so rep 3 is a FRESH correction", () => {
    const { decisions, states } = run([
      rep({ repIndex: 1, overallScore: 6.0, checkpoints: [kneeLow(40)] }),
      rep({ repIndex: 2, kind: "low_confidence", overallScore: null }),
      rep({ repIndex: 3, overallScore: 5.9, checkpoints: [kneeLow(52, 0.35)] }),
    ]);
    expect(states[1]!.lastSpoken?.category).toBe("NO_READ");
    expect(decisions[2]!.category).toBe("CORRECTION");
  });

  it("control: without the no-read the same +12 is an IMPROVEMENT", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.0, checkpoints: [kneeLow(40)] }),
      rep({ repIndex: 2, overallScore: 5.9, checkpoints: [kneeLow(52, 0.35)] }),
    ]);
    expect(decisions.map((d) => d.category)).toEqual(["CORRECTION", "IMPROVEMENT"]);
  });

  it("a stale correction is not acknowledged after the player fixed it and got PRAISE in between", () => {
    // CORRECTION → PRAISE (clean rep, no athletic_base observation) → knee
    // 40→52: lastSpoken is PRAISE, so no IMPROVEMENT; expected and honest.
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.0, checkpoints: [kneeLow(40)] }),
      rep({
        repIndex: 2,
        overallScore: 5.5,
        checkpoints: [checkpoint({ key: "contact_position" })],
      }),
      rep({ repIndex: 3, overallScore: 5.4, checkpoints: [kneeLow(52, 0.35)] }),
    ]);
    expect(decisions.map((d) => d.category)).toEqual(["CORRECTION", "PRAISE", "CORRECTION"]);
  });
});

describe("S5 — personalBestMinRep counted over terminal reps including no-reads", () => {
  it("[abstained, abstained, 6.0, 6.5] — the SECOND scored swing must not be a PERSONAL_BEST", () => {
    const { decisions } = run([
      rep({ repIndex: 1, kind: "abstained", overallScore: null }),
      rep({ repIndex: 2, kind: "abstained", overallScore: null }),
      rep({ repIndex: 3, overallScore: 6.0 }),
      rep({ repIndex: 4, overallScore: 6.5 }),
    ]);
    expect(decisions.slice(0, 3).map((d) => d.category)).toEqual(["NO_READ", "NO_READ", "PRAISE"]);
    expect(decisions[3]!.category).not.toBe("PERSONAL_BEST");
  });

  it("observed today: rep 4 (second scored swing) IS announced as a personal best", () => {
    const { decisions } = run([
      rep({ repIndex: 1, kind: "abstained", overallScore: null }),
      rep({ repIndex: 2, kind: "abstained", overallScore: null }),
      rep({ repIndex: 3, overallScore: 6.0 }),
      rep({ repIndex: 4, overallScore: 6.5 }),
    ]);
    expect(decisions[3]!.category).toBe("PERSONAL_BEST");
    expect(decisions[3]!.text).toBe(`New best — ${formatSpokenScore(6.5)}.`);
  });

  it("control: [6.0, 6.5] with no no-reads is PRAISE, PRAISE (rep 2 < personalBestMinRep 3)", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.0 }),
      rep({ repIndex: 2, overallScore: 6.5 }),
    ]);
    expect(decisions.map((d) => d.category)).toEqual(["PRAISE", "PRAISE"]);
  });

  it("[no-read ×2, 6.0, 6.5] with personalBestMinRep=3 vs [6.0, 6.5]: identical scored history, different verdict", () => {
    const withNoReads = run([
      rep({ repIndex: 1, kind: "low_confidence", overallScore: null }),
      rep({ repIndex: 2, kind: "low_confidence", overallScore: null }),
      rep({ repIndex: 3, overallScore: 6.0 }),
      rep({ repIndex: 4, overallScore: 6.5 }),
    ]).decisions.at(-1)!.category;
    const without = run([
      rep({ repIndex: 1, overallScore: 6.0 }),
      rep({ repIndex: 2, overallScore: 6.5 }),
    ]).decisions.at(-1)!.category;
    // Pins the inconsistency the finding describes.
    expect([withNoReads, without]).toEqual(["PERSONAL_BEST", "PRAISE"]);
  });
});

describe("seeded fuzz — invariants over 2,000 random sessions (seed 0xC0FFEE)", () => {
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }
  const KEYS: LiveCheckpointObservation["key"][] = [
    "ready_position",
    "athletic_base",
    "preparation",
    "paddle_set",
    "swing_length",
    "sequencing",
    "paddle_path",
    "contact_position",
    "face_wrist_stability",
    "follow_through",
    "recovery",
  ];
  const DIRS: LiveCheckpointObservation["direction"][] = [
    "low",
    "high",
    "none",
    "late",
    "early",
    "short",
    "long",
  ];

  function randomRep(next: () => number, repIndex: number): LiveRepObservation {
    const roll = next();
    if (roll < 0.15) return rep({ repIndex, kind: "low_confidence", overallScore: null });
    if (roll < 0.25) return rep({ repIndex, kind: "abstained", overallScore: null });
    const count = Math.floor(next() * 4);
    const checkpoints: LiveCheckpointObservation[] = [];
    for (let i = 0; i < count; i += 1) {
      checkpoints.push(
        checkpoint({
          key: KEYS[Math.floor(next() * KEYS.length)]!,
          score: next() < 0.1 ? null : Math.round(next() * 100),
          direction: DIRS[Math.floor(next() * DIRS.length)]!,
          severity: Math.round(next() * 100) / 100,
          applicable: next() > 0.1,
        }),
      );
    }
    return rep({
      repIndex,
      overallScore: next() < 0.05 ? null : Math.round(next() * 100) / 10,
      checkpoints,
    });
  }

  it("never emits empty text, PERSONAL_BEST only on a strict new best at/after minRep, REPEAT only after same correction, deterministic", () => {
    const next = lcg(0xc0ffee);
    for (let session = 0; session < 2000; session += 1) {
      const length = 1 + Math.floor(next() * 30);
      const reps: LiveRepObservation[] = [];
      for (let i = 0; i < length; i += 1) reps.push(randomRep(next, i + 1));
      const first = run(reps);
      const second = run(reps);
      expect(second.decisions).toEqual(first.decisions);
      let best: number | null = null;
      let previous: LiveCueDecision | null = null;
      for (const [i, decision] of first.decisions.entries()) {
        const r = reps[i]!;
        expect(decision.text.length).toBeGreaterThan(0);
        if (r.kind !== "scored") {
          expect(["NO_READ", "SETUP_GUIDANCE"]).toContain(decision.category);
        } else {
          expect(["NO_READ", "SETUP_GUIDANCE"]).not.toContain(decision.category);
          if (decision.category === "PERSONAL_BEST") {
            expect(r.overallScore).not.toBeNull();
            expect(best).not.toBeNull();
            expect(r.overallScore!).toBeGreaterThan(best!);
            expect(r.repIndex).toBeGreaterThanOrEqual(DEFAULT_LIVE_CUE_RULES.personalBestMinRep);
          }
          if (decision.category === "REPEAT_CORRECTION") {
            expect(previous).not.toBeNull();
            expect(["CORRECTION", "REPEAT_CORRECTION"]).toContain(previous!.category);
            expect(previous!.targetCheckpoint).toBe(decision.targetCheckpoint);
          }
          if (r.overallScore !== null) {
            best = best === null ? r.overallScore : Math.max(best, r.overallScore);
          }
        }
        previous = decision;
      }
    }
  });

  it("no-read streaks: SETUP_GUIDANCE exactly every setupGuidanceAfter consecutive unreadable reps, streak reset by a scored rep", () => {
    const next = lcg(0xbeef);
    for (let session = 0; session < 500; session += 1) {
      const reps: LiveRepObservation[] = [];
      const length = 1 + Math.floor(next() * 40);
      for (let i = 0; i < length; i += 1) {
        reps.push(
          next() < 0.6
            ? rep({ repIndex: i + 1, kind: "low_confidence", overallScore: null })
            : rep({ repIndex: i + 1, overallScore: 6 }),
        );
      }
      const { decisions } = run(reps);
      let streak = 0;
      for (const [i, decision] of decisions.entries()) {
        if (reps[i]!.kind === "scored") {
          streak = 0;
          continue;
        }
        streak += 1;
        if (streak >= DEFAULT_LIVE_CUE_RULES.setupGuidanceAfter) {
          expect(decision.category).toBe("SETUP_GUIDANCE");
          streak = 0;
        } else {
          expect(decision.category).toBe("NO_READ");
        }
      }
    }
  });
});

describe("hostile inputs", () => {
  it("a huge checkpoint list (10,000 entries) still picks the single worst and stays fast", () => {
    const checkpoints: LiveCheckpointObservation[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      checkpoints.push(
        checkpoint({ key: "recovery", severity: 0.01 * (i % 20), score: 50 + (i % 40) }),
      );
    }
    checkpoints.push(kneeLow(10, 0.99));
    const started = Date.now();
    const { decisions } = run([rep({ repIndex: 1, overallScore: 3.2, checkpoints })]);
    expect(Date.now() - started).toBeLessThan(500);
    expect(decisions[0]!.category).toBe("CORRECTION");
    expect(decisions[0]!.targetCheckpoint).toBe("athletic_base");
  });

  it("scored rep with a null overall score never announces a score, never a personal best", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 4.0 }),
      rep({ repIndex: 2, overallScore: 5.0 }),
      rep({ repIndex: 3, overallScore: null }),
      rep({ repIndex: 4, overallScore: null, checkpoints: [kneeLow(20)] }),
    ]);
    expect(decisions[2]!.category).toBe("PRAISE");
    expect(decisions[2]!.announcedScore).toBeNull();
    expect(decisions[2]!.text).not.toMatch(/^\d/);
    expect(decisions[3]!.category).toBe("CORRECTION");
    expect(decisions[3]!.announcedScore).toBeNull();
  });

  it("repIndex regression / duplicates (coach counter glitch) cannot crash the policy", () => {
    const { decisions } = run([
      rep({ repIndex: 5, overallScore: 6 }),
      rep({ repIndex: 5, overallScore: 7 }),
      rep({ repIndex: 1, overallScore: 8 }),
      rep({ repIndex: -3, overallScore: 9 }),
    ]);
    expect(decisions).toHaveLength(4);
    expect(decisions.every((d) => d.text.length > 0)).toBe(true);
    // Negative/regressed repIndex silently disables the personal-best call.
    expect(decisions[3]!.category).toBe("PRAISE");
  });

  it("praise / no-read rotation counters stay bounded semantics over 100k reps", () => {
    let state: LiveCoachSessionState = INITIAL_LIVE_COACH_STATE;
    for (let i = 1; i <= 100_000; i += 1) {
      const r =
        i % 2 === 0
          ? rep({ repIndex: i, overallScore: 5 })
          : rep({ repIndex: i, kind: "low_confidence", overallScore: null });
      const { decision, nextState } = selectLiveCue(state, r);
      expect(decision.text.length).toBeGreaterThan(0);
      state = nextState;
    }
    expect(state.praiseCounter).toBe(50_000);
    expect(state.noReadCounter).toBe(50_000);
    expect(state.noReadStreak).toBe(0);
  });
});
