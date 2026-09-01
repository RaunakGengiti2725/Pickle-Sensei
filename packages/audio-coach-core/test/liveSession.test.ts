import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_CUE_RULES,
  formatSpokenScore,
  INITIAL_LIVE_COACH_STATE,
  NO_READ_VARIANTS,
  selectLiveCue,
  sessionEndLine,
  sessionStartLine,
  worstCheckpoint,
  type LiveCheckpointObservation,
  type LiveCoachSessionState,
  type LiveCueDecision,
  type LiveCueRules,
  type LiveRepObservation,
} from "../src/index.js";

const CATEGORIES = [
  "CORRECTION",
  "REPEAT_CORRECTION",
  "IMPROVEMENT",
  "PERSONAL_BEST",
  "PRAISE",
  "NO_READ",
  "SETUP_GUIDANCE",
];

function checkpoint(
  partial: Partial<LiveCheckpointObservation> & { key: LiveCheckpointObservation["key"] },
): LiveCheckpointObservation {
  return { score: 85, direction: "none", severity: 0, applicable: true, ...partial };
}

function rep(partial: Partial<LiveRepObservation> & { repIndex: number }): LiveRepObservation {
  return { kind: "scored", overallScore: 7.0, checkpoints: [], ...partial };
}

/** Run a sequence of reps through the live engine, collecting every decision. */
function run(reps: LiveRepObservation[], rules: LiveCueRules = DEFAULT_LIVE_CUE_RULES) {
  const decisions: LiveCueDecision[] = [];
  let state: LiveCoachSessionState = INITIAL_LIVE_COACH_STATE;
  for (const r of reps) {
    const { decision, nextState } = selectLiveCue(state, r, rules);
    decisions.push(decision);
    state = nextState;
  }
  return { decisions, state };
}

const kneeBend = (severity: number) =>
  checkpoint({ key: "athletic_base", score: 55, direction: "low", severity });

describe("live session cue policy", () => {
  it("always speaks — every decision has text, whatever the swing looked like", () => {
    const matrix: LiveRepObservation[] = [
      rep({ repIndex: 1, checkpoints: [kneeBend(0.5)] }),
      rep({ repIndex: 2, kind: "low_confidence", overallScore: null }),
      rep({ repIndex: 3, overallScore: null, checkpoints: [kneeBend(0.9)] }),
      rep({ repIndex: 4, kind: "abstained", overallScore: null }),
      rep({ repIndex: 5, checkpoints: [] }),
      rep({
        repIndex: 6,
        overallScore: 9.9,
        checkpoints: [checkpoint({ key: "contact_position", score: null, severity: 0.2 })],
      }),
      rep({ repIndex: 7, kind: "abstained", overallScore: null }),
      rep({ repIndex: 8, kind: "low_confidence", overallScore: null }),
      rep({ repIndex: 9, kind: "abstained", overallScore: null }),
      rep({
        repIndex: 10,
        checkpoints: [
          checkpoint({ key: "preparation", score: 40, direction: "short", severity: 0.6 }),
          checkpoint({ key: "recovery", severity: 0.9, applicable: false }),
        ],
      }),
      rep({ repIndex: 11, checkpoints: [checkpoint({ key: "recovery", severity: 0 })] }),
      rep({ repIndex: 12, overallScore: 0, checkpoints: [kneeBend(1)] }),
    ];
    const { decisions } = run(matrix);
    expect(decisions).toHaveLength(matrix.length);
    for (const d of decisions) {
      expect(d.text.length).toBeGreaterThan(0);
      expect(CATEGORIES).toContain(d.category);
    }
  });

  it("calls the knee bend: correction text, target checkpoint, and spoken score prefix", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.4, checkpoints: [kneeBend(0.5)] }),
    ]);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions[0]?.text).toContain("Bend the knees more");
    expect(decisions[0]?.text.startsWith("6.4. ")).toBe(true);
    expect(decisions[0]?.targetCheckpoint).toBe("athletic_base");
    expect(decisions[0]?.announcedScore).toBe(6.4);
  });

  describe("worstCheckpoint", () => {
    it("picks the highest severity regardless of order", () => {
      const worst = worstCheckpoint([
        checkpoint({ key: "preparation", severity: 0.2 }),
        checkpoint({ key: "athletic_base", severity: 0.7 }),
        checkpoint({ key: "recovery", severity: 0.4 }),
      ]);
      expect(worst?.key).toBe("athletic_base");
    });

    it("ignores inapplicable checkpoints", () => {
      const worst = worstCheckpoint([
        checkpoint({ key: "recovery", severity: 0.9, applicable: false }),
        checkpoint({ key: "swing_length", severity: 0.3 }),
      ]);
      expect(worst?.key).toBe("swing_length");
    });

    it("breaks severity ties by lower score; null score loses the tie", () => {
      const worst = worstCheckpoint([
        checkpoint({ key: "paddle_set", severity: 0.5, score: null }),
        checkpoint({ key: "paddle_path", severity: 0.5, score: 60 }),
        checkpoint({ key: "contact_position", severity: 0.5, score: 40 }),
      ]);
      expect(worst?.key).toBe("contact_position");
    });

    it("returns the max item even at severity 0, and null only when nothing applies", () => {
      expect(worstCheckpoint([checkpoint({ key: "recovery", severity: 0 })])?.key).toBe("recovery");
      expect(worstCheckpoint([])).toBeNull();
      expect(
        worstCheckpoint([checkpoint({ key: "recovery", severity: 0.5, applicable: false })]),
      ).toBeNull();
    });
  });

  it("uses REPEAT wording when the same fault persists back-to-back", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.2, checkpoints: [kneeBend(0.5)] }),
      rep({ repIndex: 2, overallScore: 6.1, checkpoints: [kneeBend(0.55)] }),
    ]);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions[1]?.category).toBe("REPEAT_CORRECTION");
    expect(decisions[1]?.text).toContain("Still there — bend the knees more");
    expect(decisions[1]?.targetCheckpoint).toBe("athletic_base");
  });

  it("acknowledges improvement on the corrected checkpoint", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.2, checkpoints: [kneeBend(0.5)] }),
      rep({
        repIndex: 2,
        overallScore: 6.0,
        checkpoints: [
          checkpoint({ key: "athletic_base", score: 70, direction: "low", severity: 0.1 }),
        ],
      }),
    ]);
    expect(decisions[0]?.category).toBe("CORRECTION");
    expect(decisions[1]?.category).toBe("IMPROVEMENT");
    expect(decisions[1]?.targetCheckpoint).toBe("athletic_base");
    expect(decisions[1]?.text.length).toBeGreaterThan(0);
  });

  it("announces a personal best with the score, beating a same-rep correction", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 7.0 }),
      rep({ repIndex: 2, overallScore: 6.5 }),
      rep({ repIndex: 3, overallScore: 8.2, checkpoints: [kneeBend(0.5)] }),
    ]);
    expect(decisions[2]?.category).toBe("PERSONAL_BEST");
    expect(decisions[2]?.text).toContain("New best");
    expect(decisions[2]?.text).toContain("8.2");
    expect(decisions[2]?.announcedScore).toBe(8.2);
  });

  it("never announces a personal best before personalBestMinRep", () => {
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 6.0 }),
      rep({ repIndex: 2, overallScore: 9.0 }),
    ]);
    expect(decisions[1]?.category).not.toBe("PERSONAL_BEST");
  });

  it("rotates praise lines so consecutive clean reps never repeat", () => {
    // Descending scores so no personal best fires after rep 1.
    const { decisions } = run([
      rep({ repIndex: 1, overallScore: 8.0 }),
      rep({ repIndex: 2, overallScore: 7.9 }),
      rep({ repIndex: 3, overallScore: 7.8 }),
      rep({ repIndex: 4, overallScore: 7.7 }),
      rep({ repIndex: 5, overallScore: 7.6 }),
    ]);
    for (const d of decisions) {
      expect(d.category).toBe("PRAISE");
      expect(d.text.length).toBeGreaterThan(0);
    }
    for (let i = 1; i < decisions.length; i += 1) {
      expect(decisions[i]?.text).not.toBe(decisions[i - 1]?.text);
    }
  });

  it("stays honest on no-reads, then coaches the SETUP after a streak", () => {
    const { decisions } = run([
      rep({ repIndex: 1, kind: "low_confidence", overallScore: null }),
      rep({ repIndex: 2, kind: "abstained", overallScore: null }),
      rep({ repIndex: 3, kind: "low_confidence", overallScore: null }),
    ]);
    expect(decisions[0]?.category).toBe("NO_READ");
    expect(decisions[1]?.category).toBe("NO_READ");
    expect(NO_READ_VARIANTS).toContain(decisions[0]?.text);
    expect(NO_READ_VARIANTS).toContain(decisions[1]?.text);
    expect(decisions[0]?.text).not.toBe(decisions[1]?.text);
    expect(decisions[2]?.category).toBe("SETUP_GUIDANCE");
    expect(decisions[2]?.text).toMatch(/framing/i);
  });

  it("resets the no-read streak on a scored rep", () => {
    const { decisions } = run([
      rep({ repIndex: 1, kind: "low_confidence", overallScore: null }),
      rep({ repIndex: 2, kind: "abstained", overallScore: null }),
      rep({ repIndex: 3, overallScore: 7.0 }),
      rep({ repIndex: 4, kind: "low_confidence", overallScore: null }),
    ]);
    expect(decisions[3]?.category).toBe("NO_READ");
  });

  it("omits the score prefix when announceScores is false", () => {
    const rules: LiveCueRules = { ...DEFAULT_LIVE_CUE_RULES, announceScores: false };
    const { decisions } = run(
      [rep({ repIndex: 1, overallScore: 6.4, checkpoints: [kneeBend(0.5)] })],
      rules,
    );
    expect(decisions[0]?.text).toBe("Bend the knees more.");
    expect(decisions[0]?.announcedScore).toBeNull();
  });

  it("is deterministic — identical inputs yield identical decision sequences", () => {
    const seq = [
      rep({ repIndex: 1, overallScore: 6.2, checkpoints: [kneeBend(0.45)] }),
      rep({ repIndex: 2, kind: "abstained", overallScore: null }),
      rep({ repIndex: 3, overallScore: 7.1 }),
      rep({ repIndex: 4, overallScore: 7.4, checkpoints: [kneeBend(0.6)] }),
      rep({ repIndex: 5, overallScore: 7.2 }),
    ];
    const a = run(seq);
    const b = run(seq);
    expect(a.decisions).toEqual(b.decisions);
    expect(a.state).toEqual(b.state);
  });

  describe("session framing lines", () => {
    it("has a non-empty start line", () => {
      expect(sessionStartLine().length).toBeGreaterThan(0);
    });

    it("formats spoken scores to one decimal", () => {
      expect(formatSpokenScore(7)).toBe("7.0");
      expect(formatSpokenScore(6.8)).toBe("6.8");
    });

    it("admits when nothing could be scored", () => {
      expect(
        sessionEndLine({ scoredCount: 0, startAverage: null, endAverage: null, best: null }),
      ).toBe("Session over. No swings could be scored this time.");
    });

    it("reports a single scored swing as such", () => {
      expect(
        sessionEndLine({ scoredCount: 1, startAverage: 6.4, endAverage: null, best: 6.4 }),
      ).toContain("One scored swing at 6.4");
    });

    it("calls the trend up, down, or steady", () => {
      const up = sessionEndLine({ scoredCount: 6, startAverage: 6.1, endAverage: 6.9, best: 7.4 });
      expect(up).toContain("6.1");
      expect(up).toContain("6.9");
      expect(up).toContain("up 0.8");

      const down = sessionEndLine({
        scoredCount: 4,
        startAverage: 7.0,
        endAverage: 6.5,
        best: 7.2,
      });
      expect(down).toContain("down 0.5");

      const steady = sessionEndLine({
        scoredCount: 4,
        startAverage: 6.5,
        endAverage: 6.52,
        best: 6.9,
      });
      expect(steady).toContain("held steady at 6.5");
    });
  });
});
