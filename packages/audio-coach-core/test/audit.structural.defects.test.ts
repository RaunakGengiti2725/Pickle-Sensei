/**
 * STRUCTURAL AUDIT PROBES — @pickle/audio-coach-core (pass 1, auditor #2).
 *
 * Each test asserts what the module's own contracts promise (severity is
 * "0–1", overallScore is "0–10, one decimal", decisions are deterministic and
 * honest). A FAILING test in this file is a reproduced defect on the audited
 * commit (4d812e1a); behaviours that hold are pinned in
 * audit.structural.holds.test.ts.
 *
 * Run: pnpm --filter @pickle/audio-coach-core exec vitest run test/audit.structural.defects.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  INITIAL_COACH_STATE,
  INITIAL_LIVE_COACH_STATE,
  selectCue,
  selectLiveCue,
  worstCheckpoint,
  type LiveCheckpointObservation,
  type LiveCoachSessionState,
  type LiveCueDecision,
  type LiveRepObservation,
  type RepObservation,
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
    const { decision, nextState } = selectLiveCue(state, r);
    decisions.push(decision);
    state = nextState;
  }
  return { decisions, state };
}

const kneeBend = (severity: number) =>
  checkpoint({ key: "athletic_base", score: 55, direction: "low", severity });

describe("DEFECT PROBE: worstCheckpoint with a non-finite severity", () => {
  it("a NaN-severity checkpoint listed FIRST must not shadow a real 0.9-severity fault", () => {
    const worst = worstCheckpoint([
      checkpoint({ key: "preparation", severity: Number.NaN }),
      kneeBend(0.9),
    ]);
    expect(worst?.key).toBe("athletic_base");
  });

  it("selectLiveCue still corrects the real fault when a NaN-severity checkpoint precedes it", () => {
    const { decisions } = run([
      rep({
        repIndex: 1,
        overallScore: 6.0,
        checkpoints: [checkpoint({ key: "preparation", severity: Number.NaN }), kneeBend(0.9)],
      }),
    ]);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions[0]?.targetCheckpoint).toBe("athletic_base");
  });
});

describe("DEFECT PROBE: selectLiveCue with a non-finite overallScore", () => {
  it("never voices the literal 'NaN' as a score", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: Number.NaN, checkpoints: [kneeBend(0.5)] }),
    ]);
    expect(decisions[0]?.text).not.toContain("NaN");
    expect(
      decisions[0]?.announcedScore === null || Number.isFinite(decisions[0]?.announcedScore),
    ).toBe(true);
  });

  it("a NaN score must not poison bestOverall so later real bests stop being announced", () => {
    const { decisions, state } = run([
      rep({ repIndex: 1, overallScore: 6.0 }),
      rep({ repIndex: 2, overallScore: Number.NaN }),
      rep({ repIndex: 3, overallScore: 6.5 }),
      rep({ repIndex: 4, overallScore: 9.5 }),
    ]);
    expect(state.bestOverall).toBe(9.5);
    expect(decisions.map((d) => d.category)).toContain("PERSONAL_BEST");
  });
});

describe("DEFECT PROBE: sparse cueEngine with a non-finite overallScore", () => {
  it("a NaN score must not poison bestOverallScore so later real bests stop being announced", () => {
    const base: Omit<RepObservation, "repIndex" | "overallScore"> = {
      resultKind: "scored",
      focusCheckpoint: "contact_position",
      focusScore: 70,
      focusDirection: "late",
      focusSeverity: 0.2,
    };
    let state = INITIAL_COACH_STATE;
    const categories: string[] = [];
    for (const [repIndex, overallScore] of [
      [1, 6.0],
      [2, Number.NaN],
      [3, 6.5],
      [4, 9.5],
    ] as Array<[number, number]>) {
      const out = selectCue(state, { ...base, repIndex, overallScore });
      categories.push(out.decision.category);
      state = out.nextState;
    }
    expect(state.bestOverallScore).toBe(9.5);
    expect(categories).toContain("PERSONAL_BEST");
  });
});
