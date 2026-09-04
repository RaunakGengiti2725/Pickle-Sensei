/**
 * STRUCTURAL AUDIT PROBES — audio-coach-core cue engines. Inputs at the edge
 * of the declared contracts (non-finite numbers, empty/inapplicable
 * checkpoints, repIndex vs scored-count semantics). Probes assert the
 * documented intent; a failing probe is a reproduced defect on the audited
 * commit. "Holds" are pinned alongside.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUE_RULES,
  DEFAULT_LIVE_CUE_RULES,
  INITIAL_COACH_STATE,
  INITIAL_LIVE_COACH_STATE,
  selectCue,
  selectLiveCue,
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

function run(reps: LiveRepObservation[]) {
  const decisions: LiveCueDecision[] = [];
  let state: LiveCoachSessionState = INITIAL_LIVE_COACH_STATE;
  for (const r of reps) {
    const { decision, nextState } = selectLiveCue(state, r, DEFAULT_LIVE_CUE_RULES);
    decisions.push(decision);
    state = nextState;
  }
  return { decisions, state };
}

const kneeBend = (severity: number) =>
  checkpoint({ key: "athletic_base", score: 55, direction: "low", severity });

describe("AUDIT live cue policy — probes", () => {
  it("never puts 'NaN' in a player's ear: a non-finite overallScore is not announced", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: Number.NaN, checkpoints: [kneeBend(0.5)] }),
    ]);
    expect(decisions[0]?.text).not.toContain("NaN");
    expect(decisions[0]?.announcedScore).toBeNull();
  });

  it("a NaN-severity checkpoint listed FIRST must not mask a real fault behind it", () => {
    const worst = worstCheckpoint([
      checkpoint({ key: "paddle_set", severity: Number.NaN }),
      kneeBend(0.9),
    ]);
    expect(worst?.key).toBe("athletic_base");
    const { decisions } = run([
      rep({
        repIndex: 1,
        overallScore: 5.0,
        checkpoints: [checkpoint({ key: "paddle_set", severity: Number.NaN }), kneeBend(0.9)],
      }),
    ]);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions[0]?.targetCheckpoint).toBe("athletic_base");
  });

  it("a rep with Infinity overallScore is not a personal best", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.0 }),
      rep({ repIndex: 2, overallScore: 6.1 }),
      rep({ repIndex: 3, overallScore: Number.POSITIVE_INFINITY }),
    ]);
    expect(decisions[2]?.category).not.toBe("PERSONAL_BEST");
    expect(decisions[2]?.text).not.toContain("Infinity");
  });
});

describe("AUDIT live cue policy — holds", () => {
  it("a scored rep with only inapplicable checkpoints gets praise (with score), not a correction", () => {
    const { decisions } = run([
      rep({
        repIndex: 1,
        overallScore: 7.3,
        checkpoints: [checkpoint({ key: "recovery", severity: 0.9, applicable: false })],
      }),
    ]);
    expect(decisions[0]?.category).toBe("PRAISE");
    expect(decisions[0]?.text.startsWith("7.3. ")).toBe(true);
  });

  it("a scored rep whose overallScore is null is spoken as a no-read (kind mismatch is not trusted)", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: null, checkpoints: [kneeBend(0.9)] }),
    ]);
    // `kind` says scored but there is no score: the policy still corrects the
    // fault without a score prefix — never fabricates a number.
    expect(decisions[0]?.text).not.toMatch(/^\d/);
    expect(decisions[0]?.announcedScore).toBeNull();
  });

  it("improvement is only credited against the checkpoint that was actually corrected", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.0, checkpoints: [kneeBend(0.5)] }),
      rep({
        repIndex: 2,
        overallScore: 6.0,
        checkpoints: [
          kneeBend(0.5),
          checkpoint({ key: "preparation", score: 90, direction: "none", severity: 0.05 }),
        ],
      }),
    ]);
    expect(decisions[1]?.category).toBe("REPEAT_CORRECTION");
  });

  it("no-read streak is not advanced by scored reps and setup guidance resets the streak", () => {
    const noRead = (i: number) => rep({ repIndex: i, kind: "abstained", overallScore: null });
    const { decisions } = run([noRead(1), noRead(2), noRead(3), noRead(4), noRead(5), noRead(6)]);
    expect(decisions.map((d) => d.category)).toEqual([
      "NO_READ",
      "NO_READ",
      "SETUP_GUIDANCE",
      "NO_READ",
      "NO_READ",
      "SETUP_GUIDANCE",
    ]);
  });
});

describe("AUDIT sparse cue engine — holds", () => {
  it("a non-finite focusSeverity never produces a correction", () => {
    const { decision } = selectCue(INITIAL_COACH_STATE, {
      repIndex: 1,
      resultKind: "scored",
      overallScore: 7.0,
      focusCheckpoint: "contact_position",
      focusScore: 50,
      focusDirection: "late",
      focusSeverity: Number.NaN,
    });
    expect(decision.category).not.toBe("CORRECTION");
  });

  it("personal-best threshold is enforced against repIndex exactly as configured", () => {
    let state = INITIAL_COACH_STATE;
    const categories: string[] = [];
    const scores = [6.0, 6.5, 7.0, 7.5];
    for (let i = 0; i < scores.length; i += 1) {
      const { decision, nextState } = selectCue(state, {
        repIndex: i + 1,
        resultKind: "scored",
        overallScore: scores[i] ?? 0,
        focusCheckpoint: "contact_position",
        focusScore: 90,
        focusDirection: "none",
        focusSeverity: 0.05,
      });
      categories.push(decision.category);
      state = nextState;
    }
    for (let i = 0; i < DEFAULT_CUE_RULES.personalBestMinRep - 1; i += 1) {
      expect(categories[i]).not.toBe("PERSONAL_BEST");
    }
    expect(categories[DEFAULT_CUE_RULES.personalBestMinRep - 1]).toBe("PERSONAL_BEST");
  });
});
