import type { CheckpointKey } from "@pickle/shared-types";
import { describe, expect, it } from "vitest";
import {
  correctionPhrase,
  formatSpokenScore,
  improvementPhrase,
  INITIAL_COACH_STATE,
  INITIAL_LIVE_COACH_STATE,
  selectCue,
  selectLiveCue,
  sessionEndLine,
  type CoachState,
  type LiveCoachSessionState,
  type LiveRepObservation,
  type RepObservation,
} from "../../src/index.js";
import { runScenario, stableDump } from "./boundaryCampaign.js";

/**
 * Minimized repros from the boundary-malformed stress campaign
 * (campaign seed 20260904, 450 iterations × 7 targets).
 *
 * `it.fails` blocks pin CURRENT behaviour that violates a stated invariant:
 * they assert the DESIRED behaviour and vitest passes only while that
 * assertion still fails. When production hardens the engine, the block
 * starts failing — delete it and drop the violation class from TOLERATED in
 * boundaryMalformed.stress.test.ts. Plain `it` blocks are invariants that HELD.
 *
 * Replay any campaign row with `runScenario(target, seed)`.
 */

const scoredRep = (overrides: Partial<LiveRepObservation> = {}): LiveRepObservation => ({
  repIndex: 4,
  kind: "scored",
  overallScore: 7.5,
  checkpoints: [],
  ...overrides,
});

describe("BROKEN — non-finite numbers are spoken verbatim (seeds formatSpokenScore:*, selectLiveCue:3058401685, sessionEndLine:1594797066/2370675991)", () => {
  it.fails(
    "formatSpokenScore(NaN / ±Infinity / 1e21) should not yield NaN/Infinity/exponent text",
    () => {
      for (const score of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        1e21,
        -1e308,
      ]) {
        expect(formatSpokenScore(score)).not.toMatch(/NaN|Infinity|e\+/);
      }
    },
  );

  it.fails("selectLiveCue with overallScore=-1e308 should not announce '-1e+308'", () => {
    const { decision } = selectLiveCue(
      INITIAL_LIVE_COACH_STATE,
      scoredRep({ overallScore: -1e308 }),
    );
    expect(decision.text).not.toMatch(/e\+/);
  });

  it.fails(
    "selectLiveCue with overallScore=Infinity should not announce Infinity nor pin bestOverall to Infinity",
    () => {
      const { decision, nextState } = selectLiveCue(
        INITIAL_LIVE_COACH_STATE,
        scoredRep({ overallScore: Number.POSITIVE_INFINITY }),
      );
      expect(decision.text).not.toContain("Infinity");
      expect(decision.announcedScore === null || Number.isFinite(decision.announcedScore)).toBe(
        true,
      );
      expect(Number.isFinite(nextState.bestOverall ?? 0)).toBe(true);
    },
  );

  it.fails(
    "sessionEndLine should not say 'Best swing today: NaN.' / '-Infinity' / 'down Infinity'",
    () => {
      expect(
        sessionEndLine({ scoredCount: 5, startAverage: null, endAverage: null, best: Number.NaN }),
      ).not.toContain("NaN");
      expect(
        sessionEndLine({
          scoredCount: 3,
          startAverage: null,
          endAverage: null,
          best: Number.NEGATIVE_INFINITY,
        }),
      ).not.toContain("Infinity");
      expect(
        sessionEndLine({
          scoredCount: 3,
          startAverage: 1.8,
          endAverage: Number.NEGATIVE_INFINITY,
          best: 2,
        }),
      ).not.toContain("Infinity");
    },
  );

  it.fails(
    "sparse coach: -Infinity overallScore / Infinity lastStableRepIndex should behave the same after a JSON round trip (seeds selectCue:3361626196/2361825748)",
    () => {
      const rep: RepObservation = {
        repIndex: 5,
        resultKind: "scored",
        overallScore: 7.5,
        focusCheckpoint: "athletic_base",
        focusScore: 62,
        focusDirection: "low",
        focusSeverity: 0.1,
      };
      const state: CoachState = {
        ...INITIAL_COACH_STATE,
        lastStableRepIndex: Number.POSITIVE_INFINITY,
      };
      const direct = selectCue(state, rep).decision;
      const hydrated = selectCue(JSON.parse(JSON.stringify(state)) as CoachState, rep).decision;
      expect(stableDump(hydrated)).toBe(stableDump(direct));
    },
  );
});

describe("BROKEN — negative zero is spoken as '-0.0' (seeds formatSpokenScore:*, sessionEndLine:2861681595)", () => {
  it.fails("formatSpokenScore(-0.04) / (-1e-7) should not read '-0.0'", () => {
    expect(formatSpokenScore(-0.04)).not.toBe("-0.0");
    expect(formatSpokenScore(-1e-7)).not.toBe("-0.0");
  });

  it.fails("sessionEndLine with endAverage=-0.04 should not say 'finished around -0.0'", () => {
    const text = sessionEndLine({
      scoredCount: 4,
      startAverage: 4.1,
      endAverage: -0.04,
      best: 4.1,
    });
    expect(text).not.toContain("-0.0");
  });
});

describe("BROKEN — in-domain rounding: start and end round to the same spoken number yet a trend is announced", () => {
  it.fails(
    "4.95 → 5.04 should not be read as 'started around 5.0 and finished around 5.0 — up 0.1'",
    () => {
      const text = sessionEndLine({
        scoredCount: 6,
        startAverage: 4.95,
        endAverage: 5.04,
        best: 5.04,
      });
      const spoken = [...text.matchAll(/around (\d+\.\d)/g)].map((m) => m[1]);
      expect(spoken).toHaveLength(2);
      if (/(up|down) \d/.test(text)) expect(spoken[0]).not.toBe(spoken[1]);
    },
  );
});

describe("BROKEN — prototype-chain keys make phrase lookups return non-strings (seeds phrases:3303886526/1907347206/2666357392)", () => {
  const protoKeys = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"];

  it.fails("improvementPhrase(<Object.prototype member>) should return a string", () => {
    for (const key of protoKeys) {
      expect(typeof improvementPhrase(key as CheckpointKey)).toBe("string");
    }
  });

  it.fails("correctionPhrase('constructor', '__proto__') should return a string", () => {
    expect(typeof correctionPhrase("constructor" as CheckpointKey, "__proto__" as never)).toBe(
      "string",
    );
    expect(typeof correctionPhrase("toString" as CheckpointKey, "__proto__" as never)).toBe(
      "string",
    );
  });
});

describe("BROKEN — unknown checkpoint keys are interpolated raw into spoken text (seeds phrases:2896274742/1194779652, selectLiveCue:2493585321)", () => {
  it.fails("a 64 KiB checkpoint key should not produce a 64 KiB utterance", () => {
    const text = correctionPhrase("x".repeat(65536) as CheckpointKey, "late");
    expect(text.length).toBeLessThan(200);
  });

  it.fails("NUL bytes / RTL override / '1e999' in a key should not reach the utterance", () => {
    expect(correctionPhrase("a\u0000b" as CheckpointKey, "late")).not.toContain("\u0000");
    expect(correctionPhrase("\u202Eevil\u202C" as CheckpointKey, "late")).not.toContain("\u202E");
    expect(correctionPhrase("1e999" as CheckpointKey, "late")).not.toContain("1e999");
  });

  it.fails("selectLiveCue with a NUL-filled checkpoint key should not speak the key", () => {
    const rep = scoredRep({
      checkpoints: [
        {
          key: "\u0000".repeat(1024) as CheckpointKey,
          score: 10,
          direction: "late",
          severity: 0.9,
          applicable: true,
        },
      ],
    });
    const { decision } = selectLiveCue(INITIAL_LIVE_COACH_STATE, rep);
    expect(decision.text).not.toContain("\u0000");
  });
});

describe("BROKEN — a live state missing fields (older/future schema, `{}`) is accepted silently (seeds selectLiveCue:455180406/3869053717, hydrateState:4122005962)", () => {
  it.fails("noReadCounter missing should not become a permanent NaN counter", () => {
    const state = { ...INITIAL_LIVE_COACH_STATE } as Partial<LiveCoachSessionState>;
    delete state.noReadCounter;
    const { nextState } = selectLiveCue(state as LiveCoachSessionState, {
      repIndex: 1,
      kind: "low_confidence",
      overallScore: null,
      checkpoints: [],
    });
    expect(Number.isFinite(nextState.noReadCounter)).toBe(true);
  });

  it.fails("noReadStreak missing should not silence SETUP_GUIDANCE forever", () => {
    let state = { ...INITIAL_LIVE_COACH_STATE } as Partial<LiveCoachSessionState>;
    delete state.noReadStreak;
    const categories: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const step = selectLiveCue(state as LiveCoachSessionState, {
        repIndex: i,
        kind: "low_confidence",
        overallScore: null,
        checkpoints: [],
      });
      categories.push(step.decision.category);
      state = step.nextState;
    }
    expect(categories).toContain("SETUP_GUIDANCE");
  });

  it.fails(
    "JSON '{}' hydrated as state should be rejected, not throw on the first scored rep",
    () => {
      const state = JSON.parse("{}") as LiveCoachSessionState;
      expect(() => selectLiveCue(state, scoredRep())).not.toThrow();
    },
  );
});

describe("HELD — invariants that survived every campaign row", () => {
  it("__proto__ / constructor.prototype keys in hydrated JSON never pollute Object.prototype", () => {
    const state = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},' +
        '"bestOverall":null,"lastSpoken":null,"previousCheckpointScores":{"__proto__":{"polluted":true}},' +
        '"praiseCounter":0,"noReadCounter":0,"noReadStreak":0}',
    ) as LiveCoachSessionState;
    const { nextState } = selectLiveCue(state, scoredRep());
    selectLiveCue(nextState, scoredRep({ repIndex: 5 }));
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("checkpoint key '__proto__' in a rep never pollutes Object.prototype via previousCheckpointScores", () => {
    const rep = scoredRep({
      checkpoints: [
        {
          key: "__proto__" as CheckpointKey,
          score: 10,
          direction: "late",
          severity: 0.9,
          applicable: true,
        },
      ],
    });
    const { nextState } = selectLiveCue(INITIAL_LIVE_COACH_STATE, rep);
    expect(Object.getPrototypeOf(nextState.previousCheckpointScores)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("boundary numbers in numeric slots never throw (NaN, ±Infinity, -0, 2^53, 1e308)", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0,
      2 ** 53,
      1e308,
    ]) {
      expect(() =>
        selectLiveCue(INITIAL_LIVE_COACH_STATE, scoredRep({ overallScore: value })),
      ).not.toThrow();
      expect(() =>
        selectLiveCue(
          {
            ...INITIAL_LIVE_COACH_STATE,
            praiseCounter: value,
            noReadCounter: value,
            noReadStreak: value,
          },
          scoredRep(),
        ),
      ).not.toThrow();
      expect(() =>
        sessionEndLine({ scoredCount: value, startAverage: value, endAverage: value, best: value }),
      ).not.toThrow();
    }
  });

  it("malformed JSON text is rejected by JSON.parse with a SyntaxError (truncated, single quotes, NaN literal, BOM, NUL in key)", () => {
    for (const text of [
      '{"bestOverall":nu',
      "{'a':1}",
      '{"a":NaN}',
      '\uFEFF{"a":1}',
      '{"\u0000a":1}',
      '{"a":1,}',
    ]) {
      expect(() => JSON.parse(text)).toThrow(SyntaxError);
    }
  });

  it("campaign rows replay bit-for-bit from their seed", () => {
    expect(runScenario("selectLiveCue", 3058401685)).toEqual(
      runScenario("selectLiveCue", 3058401685),
    );
    expect(runScenario("phrases", 3303886526).violations).toContain("non-string-phrase");
    expect(runScenario("sessionEndLine", 2861681595).violations).toContain("negative-zero-in-text");
    expect(runScenario("selectLiveCue", 455180406).violations).toContain("non-finite-in-state");
  });
});
