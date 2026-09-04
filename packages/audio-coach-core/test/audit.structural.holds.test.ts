/**
 * STRUCTURAL AUDIT — @pickle/audio-coach-core behaviours VERIFIED TO HOLD on
 * 4d812e1a (pass 1, auditor #2). Every test here PASSES on the audited commit
 * and pins edge cases the existing suites did not cover.
 *
 * Run: pnpm --filter @pickle/audio-coach-core exec vitest run test/audit.structural.holds.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_CUE_RULES,
  INITIAL_COACH_STATE,
  INITIAL_LIVE_COACH_STATE,
  NO_READ_VARIANTS,
  PRAISE_VARIANTS,
  selectCue,
  selectLiveCue,
  sessionEndLine,
  worstCheckpoint,
  type LiveCheckpointObservation,
  type LiveCoachSessionState,
  type LiveCueDecision,
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

function run(reps: LiveRepObservation[], initial = INITIAL_LIVE_COACH_STATE) {
  const decisions: LiveCueDecision[] = [];
  let state: LiveCoachSessionState = initial;
  for (const r of reps) {
    const { decision, nextState } = selectLiveCue(state, r);
    decisions.push(decision);
    state = nextState;
  }
  return { decisions, state };
}

const kneeBend = (severity: number, score = 55) =>
  checkpoint({ key: "athletic_base", score, direction: "low", severity });

describe("HOLDS: selectLiveCue always speaks and never mutates its input", () => {
  it("every category yields non-empty text and the input state object is left untouched", () => {
    const frozen = Object.freeze({ ...INITIAL_LIVE_COACH_STATE });
    const seq = [
      rep({ repIndex: 1, overallScore: 6.0, checkpoints: [kneeBend(0.5)] }),
      rep({ repIndex: 2, overallScore: 6.1, checkpoints: [kneeBend(0.5)] }),
      // Same overall score → not a personal best, so the focus gain is voiced.
      rep({ repIndex: 3, overallScore: 6.1, checkpoints: [kneeBend(0.05, 90)] }),
      rep({ repIndex: 4, kind: "abstained", overallScore: null }),
      rep({ repIndex: 5, kind: "low_confidence", overallScore: null }),
      rep({ repIndex: 6, kind: "abstained", overallScore: null }),
      rep({ repIndex: 7, overallScore: 9.0, checkpoints: [] }),
    ];
    const { decisions } = run(seq, frozen);
    expect(decisions.map((d) => d.category)).toEqual([
      "CORRECTION",
      "REPEAT_CORRECTION",
      "IMPROVEMENT",
      "NO_READ",
      "NO_READ",
      "SETUP_GUIDANCE",
      "PERSONAL_BEST",
    ]);
    for (const decision of decisions) expect(decision.text.trim().length).toBeGreaterThan(0);
    expect(frozen).toEqual(INITIAL_LIVE_COACH_STATE);
  });

  it("a no-read between two identical faults breaks the REPEAT chain (fresh phrase, not 'Still there')", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.0, checkpoints: [kneeBend(0.5)] }),
      rep({ repIndex: 2, kind: "abstained", overallScore: null }),
      rep({ repIndex: 3, overallScore: 6.0, checkpoints: [kneeBend(0.5)] }),
    ]);
    expect(decisions.map((d) => d.category)).toEqual(["CORRECTION", "NO_READ", "CORRECTION"]);
    expect(decisions[2]?.text.startsWith("Still there")).toBe(false);
  });

  it("no-read and praise rotations wrap deterministically over their variant tables", () => {
    const noReads = Array.from({ length: NO_READ_VARIANTS.length * 2 }, (_, i) =>
      rep({ repIndex: i + 1, kind: "abstained", overallScore: null }),
    );
    const noReadRun = run(noReads, { ...INITIAL_LIVE_COACH_STATE });
    const noReadTexts = noReadRun.decisions
      .filter((d) => d.category === "NO_READ")
      .map((d) => d.text);
    expect(new Set(noReadTexts).size).toBe(NO_READ_VARIANTS.length);

    const praises = Array.from({ length: PRAISE_VARIANTS.length * 2 }, (_, i) =>
      rep({ repIndex: i + 1, overallScore: 7.0, checkpoints: [kneeBend(0.0, 95)] }),
    );
    const praiseRun = run(praises);
    expect(praiseRun.decisions.every((d) => d.category === "PRAISE")).toBe(true);
    const praiseBodies = praiseRun.decisions.map((d) => d.text.replace(/^7\.0\. /, ""));
    expect(praiseBodies).toEqual([...PRAISE_VARIANTS, ...PRAISE_VARIANTS]);
  });

  it("announceScores=false strips the score prefix everywhere and announcedScore is null", () => {
    let state = INITIAL_LIVE_COACH_STATE;
    const rules = { ...DEFAULT_LIVE_CUE_RULES, announceScores: false };
    const out = selectLiveCue(
      state,
      rep({ repIndex: 1, overallScore: 6.4, checkpoints: [kneeBend(0.5)] }),
      rules,
    );
    state = out.nextState;
    expect(out.decision.text).toBe("Bend the knees more.");
    expect(out.decision.announcedScore).toBeNull();
  });
});

describe("HOLDS: worstCheckpoint tie-breaking and applicability", () => {
  it("ties break to the lower score, then to input order; inapplicable entries are skipped; empty → null", () => {
    expect(
      worstCheckpoint([
        checkpoint({ key: "preparation", severity: 0.5, score: 60 }),
        checkpoint({ key: "athletic_base", severity: 0.5, score: 40 }),
        checkpoint({ key: "recovery", severity: 0.5, score: 40 }),
      ])?.key,
    ).toBe("athletic_base");
    expect(
      worstCheckpoint([
        checkpoint({ key: "preparation", severity: 0.9, applicable: false }),
        checkpoint({ key: "athletic_base", severity: 0.2 }),
      ])?.key,
    ).toBe("athletic_base");
    expect(worstCheckpoint([])).toBeNull();
    expect(worstCheckpoint([checkpoint({ key: "preparation", applicable: false })])).toBeNull();
  });
});

describe("HOLDS: sparse cueEngine with a non-finite focus severity", () => {
  it("NaN focusSeverity falls through to SILENCE without corrupting counters", () => {
    const out = selectCue(INITIAL_COACH_STATE, {
      repIndex: 1,
      resultKind: "scored",
      overallScore: 7.0,
      focusCheckpoint: "contact_position",
      focusScore: 70,
      focusDirection: "late",
      focusSeverity: Number.NaN,
    });
    expect(out.decision).toEqual({ category: "SILENCE", text: null });
    expect(out.nextState.consecutiveCorrections).toBe(0);
    expect(out.nextState.lastStableRepIndex).toBeNull();
  });
});

describe("HOLDS: sessionEndLine honesty", () => {
  it("never reports a trend without both averages and is honest about 0/1 scored swings", () => {
    expect(
      sessionEndLine({ scoredCount: 0, startAverage: null, endAverage: null, best: null }),
    ).toMatch(/no swings|couldn't read|no read/i);
    const single = sessionEndLine({
      scoredCount: 1,
      startAverage: null,
      endAverage: null,
      best: 6.4,
    });
    expect(single).toContain("6.4");
    expect(single).not.toMatch(/up|down|improv/i);
    const trend = sessionEndLine({
      scoredCount: 6,
      startAverage: 6.0,
      endAverage: 7.2,
      best: 7.8,
    });
    expect(trend).toContain("6.0");
    expect(trend).toContain("7.2");
    expect(trend).toMatch(/up 1\.2/);
  });
});
