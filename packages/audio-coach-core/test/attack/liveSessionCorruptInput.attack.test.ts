/**
 * ADVERSARIAL extras (mobile-live-court-voice, pass 3) — corrupt numeric
 * input into the pure live cue engine (selectLiveCue / sessionEndLine).
 *
 * The engine documents 0–10 overall scores and 0–1 severities but performs no
 * validation. The observations below pin what a NaN / Infinity / out-of-range
 * score does to the spoken text and to the persistent session state
 * (bestOverall) — a single NaN permanently disables PERSONAL_BEST.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_CUE_RULES,
  INITIAL_LIVE_COACH_STATE,
  selectLiveCue,
  sessionEndLine,
  type LiveCheckpointObservation,
  type LiveCoachSessionState,
  type LiveCueDecision,
  type LiveRepObservation,
} from "../../src/index.js";

function checkpoint(
  partial: Partial<LiveCheckpointObservation> & { key: LiveCheckpointObservation["key"] },
): LiveCheckpointObservation {
  return { score: 85, direction: "none", severity: 0, applicable: true, ...partial };
}

function rep(partial: Partial<LiveRepObservation> & { repIndex: number }): LiveRepObservation {
  return { kind: "scored", overallScore: 7.0, checkpoints: [], ...partial };
}

function run(reps: LiveRepObservation[]): {
  decisions: LiveCueDecision[];
  state: LiveCoachSessionState;
} {
  let state = INITIAL_LIVE_COACH_STATE;
  const decisions: LiveCueDecision[] = [];
  for (const observation of reps) {
    const out = selectLiveCue(state, observation, DEFAULT_LIVE_CUE_RULES);
    decisions.push(out.decision);
    state = out.nextState;
  }
  return { decisions, state };
}

const SPOKEN_JUNK = /NaN|Infinity|undefined|null/;

describe("ADVERSARIAL: NaN / Infinity / out-of-range overall scores", () => {
  it("a NaN overallScore must not be spoken as text", () => {
    const { decisions } = run([rep({ repIndex: 1, overallScore: Number.NaN })]);
    expect(decisions[0]?.text).not.toMatch(SPOKEN_JUNK);
  });

  it("an Infinity overallScore must not be spoken as text", () => {
    const { decisions } = run([rep({ repIndex: 1, overallScore: Number.POSITIVE_INFINITY })]);
    expect(decisions[0]?.text).not.toMatch(SPOKEN_JUNK);
  });

  it("a NaN rep must not poison bestOverall for the rest of the session", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.0 }),
      rep({ repIndex: 2, overallScore: Number.NaN }),
      rep({ repIndex: 3, overallScore: 6.5 }),
      rep({ repIndex: 4, overallScore: 9.9 }),
    ]);
    expect(decisions[3]?.category).toBe("PERSONAL_BEST");
  });

  it("an Infinity rep must not make every later real score a non-best", () => {
    const { decisions, state } = run([
      rep({ repIndex: 1, overallScore: 6.0 }),
      rep({ repIndex: 2, overallScore: Number.POSITIVE_INFINITY }),
      rep({ repIndex: 3, overallScore: 6.5 }),
      rep({ repIndex: 4, overallScore: 9.9 }),
    ]);
    expect(Number.isFinite(state.bestOverall)).toBe(true);
    expect(decisions[3]?.category).toBe("PERSONAL_BEST");
  });

  it("scores outside 0–10 (-5, 999) are not announced verbatim", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: -5 }),
      rep({ repIndex: 2, overallScore: 999 }),
    ]);
    expect(decisions[0]?.announcedScore === null || decisions[0]!.announcedScore >= 0).toBe(true);
    expect(decisions[1]?.announcedScore === null || decisions[1]!.announcedScore <= 10).toBe(true);
  });

  it("sessionEndLine with NaN averages must not say 'NaN'", () => {
    const text = sessionEndLine({
      scoredCount: 4,
      startAverage: Number.NaN,
      endAverage: 6.5,
      best: 7.0,
    });
    expect(text).not.toMatch(SPOKEN_JUNK);
  });

  it("EVIDENCE: on 4d812e1a NaN is spoken and permanently disables PERSONAL_BEST", () => {
    const { decisions, state } = run([
      rep({ repIndex: 1, overallScore: 6.0 }),
      rep({ repIndex: 2, overallScore: Number.NaN }),
      rep({ repIndex: 3, overallScore: 6.5 }),
      rep({ repIndex: 4, overallScore: 9.9 }),
    ]);
    expect(decisions[1]?.text).toMatch(/^NaN\. /);
    expect(Number.isNaN(state.bestOverall)).toBe(true);
    expect(decisions[3]?.category).toBe("PRAISE");
    expect(
      sessionEndLine({ scoredCount: 4, startAverage: Number.NaN, endAverage: 6.5, best: 7.0 }),
    ).toContain("NaN");
  });
});

describe("ADVERSARIAL: severity / checkpoint corruption", () => {
  it("NaN severity never wins worst-checkpoint and never triggers a correction", () => {
    const { decisions } = run([
      rep({
        repIndex: 1,
        checkpoints: [
          checkpoint({ key: "athletic_base", severity: Number.NaN, direction: "too_low" }),
          checkpoint({ key: "paddle_set", severity: 0.1 }),
        ],
      }),
    ]);
    expect(decisions[0]?.category).toBe("PRAISE");
  });

  it("Infinity severity is treated as a correction (not a crash) with a real checkpoint", () => {
    const { decisions } = run([
      rep({
        repIndex: 1,
        checkpoints: [
          checkpoint({
            key: "athletic_base",
            severity: Number.POSITIVE_INFINITY,
            direction: "too_low",
          }),
        ],
      }),
    ]);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions[0]?.targetCheckpoint).toBe("athletic_base");
    expect(decisions[0]?.text).not.toMatch(SPOKEN_JUNK);
  });

  it("10k checkpoints in one rep resolve deterministically to the worst applicable one", () => {
    const checkpoints: LiveCheckpointObservation[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      checkpoints.push(checkpoint({ key: "paddle_set", severity: 0.01, score: 90 }));
    }
    checkpoints.push(checkpoint({ key: "recovery", severity: 0.9, direction: "too_slow" }));
    const { decisions } = run([rep({ repIndex: 1, checkpoints })]);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions[0]?.targetCheckpoint).toBe("recovery");
  });

  it("rapid identical faults escalate to REPEAT_CORRECTION and stay there (no flapping)", () => {
    const fault = checkpoint({
      key: "paddle_set",
      severity: 0.6,
      direction: "too_late",
      score: 40,
    });
    const reps = Array.from({ length: 25 }, (_, i) =>
      rep({ repIndex: i + 1, checkpoints: [fault] }),
    );
    const { decisions } = run(reps);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions.slice(1).every((d) => d.category === "REPEAT_CORRECTION")).toBe(true);
    expect(decisions.every((d) => d.text.length > 0 && !SPOKEN_JUNK.test(d.text))).toBe(true);
  });

  it("interleaving scored/no-read never lets the setup-guidance streak fire", () => {
    const reps: LiveRepObservation[] = [];
    for (let i = 0; i < 40; i += 1) {
      reps.push(
        i % 3 === 2
          ? rep({ repIndex: i + 1, overallScore: 6.5 })
          : rep({ repIndex: i + 1, kind: "low_confidence", overallScore: null }),
      );
    }
    const { decisions } = run(reps);
    expect(decisions.some((d) => d.category === "SETUP_GUIDANCE")).toBe(false);
    expect(decisions.filter((d) => d.category === "NO_READ")).toHaveLength(27);
  });

  it("repIndex going backwards / duplicated (clock skew) never throws and still speaks", () => {
    const { decisions } = run([
      rep({ repIndex: 5, overallScore: 6.0 }),
      rep({ repIndex: 5, overallScore: 6.1 }),
      rep({ repIndex: 1, overallScore: 9.5 }),
      rep({ repIndex: -3, overallScore: 9.9 }),
    ]);
    expect(decisions).toHaveLength(4);
    expect(decisions.every((d) => d.text.length > 0)).toBe(true);
    // personalBestMinRep gate uses the caller's repIndex: a backwards index
    // silently suppresses the best announcement.
    expect(decisions[2]?.category).toBe("PRAISE");
    expect(decisions[3]?.category).toBe("PRAISE");
  });
});
