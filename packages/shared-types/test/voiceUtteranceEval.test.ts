/**
 * Voice-intent robustness evaluation over the expanded synthetic corpus
 * (voiceUtteranceEvalCorpus.ts). Measures, at the projection level the
 * picker acts on:
 *
 *  - resolution accuracy: projected outcome exactly matches the gold label
 *    (status, and canonical when resolved);
 *  - FALSE-ACCEPT RATE (the metric that matters): fraction of utterances
 *    where projection silently resolves a technique the gold label does not
 *    declare — resolved when gold isn't, or resolved to the wrong canonical.
 *
 * The hard invariant is false accepts = 0: unknowns and ambiguity must
 * re-prompt, never silently mis-select.
 */
import { describe, expect, it } from "vitest";
import { projectVoiceResolution, resolveVoiceTechniqueIntent } from "../src/index.js";
import {
  VOICE_EVAL_CORPUS,
  type EvalCategory,
  type EvalUtterance,
} from "./voiceUtteranceEvalCorpus.js";

interface Outcome {
  utterance: EvalUtterance;
  status: string;
  canonical: string | null;
  correct: boolean;
  falseAccept: boolean;
}

function evaluate(utterance: EvalUtterance): Outcome {
  const projected = projectVoiceResolution(resolveVoiceTechniqueIntent(utterance.transcript));
  const canonical = projected.status === "resolved" ? projected.technique.canonical : null;
  const gold = utterance.gold;
  const correct =
    gold.kind === "resolved"
      ? projected.status === "resolved" && canonical === gold.canonical
      : projected.status === gold.kind;
  const falseAccept =
    projected.status === "resolved" && (gold.kind !== "resolved" || canonical !== gold.canonical);
  return { utterance, status: projected.status, canonical, correct, falseAccept };
}

const outcomes = VOICE_EVAL_CORPUS.map(evaluate);

function metrics(subset: readonly Outcome[]) {
  const total = subset.length;
  const correct = subset.filter((outcome) => outcome.correct).length;
  const falseAccepts = subset.filter((outcome) => outcome.falseAccept).length;
  return {
    total,
    correct,
    accuracy: total === 0 ? 1 : correct / total,
    falseAccepts,
    falseAcceptRate: total === 0 ? 0 : falseAccepts / total,
  };
}

describe("voice-intent robustness eval (expanded synthetic corpus)", () => {
  it("reports per-category metrics", () => {
    const categories = [...new Set(outcomes.map((outcome) => outcome.utterance.category))];
    const report: Record<string, ReturnType<typeof metrics>> = {
      overall: metrics(outcomes),
    };
    for (const category of categories) {
      report[category] = metrics(
        outcomes.filter((outcome) => outcome.utterance.category === category),
      );
    }
    console.log("VOICE_EVAL_METRICS " + JSON.stringify(report));
    const mismatches = outcomes
      .filter((outcome) => !outcome.correct)
      .map(
        (outcome) =>
          `"${outcome.utterance.transcript}" → ${outcome.status}` +
          `${outcome.canonical ? `(${outcome.canonical})` : ""} wanted ${outcome.utterance.gold.kind}` +
          `${outcome.utterance.gold.kind === "resolved" ? `(${outcome.utterance.gold.canonical})` : ""}`,
      );
    console.log("VOICE_EVAL_MISMATCHES " + JSON.stringify(mismatches));
    expect(outcomes.length).toBeGreaterThanOrEqual(70);
  });

  it("HARD INVARIANT: zero false accepts — never silently mis-select", () => {
    const falseAccepted = outcomes.filter((outcome) => outcome.falseAccept);
    expect(
      falseAccepted.map((outcome) => outcome.utterance.transcript),
      "false accepts",
    ).toEqual([]);
  });

  it("overall resolution accuracy ≥ 95%", () => {
    expect(metrics(outcomes).accuracy).toBeGreaterThanOrEqual(0.95);
  });

  it.each(["multi_intent", "non_technique"] as EvalCategory[])(
    "%s utterances never resolve silently",
    (category) => {
      for (const outcome of outcomes.filter((o) => o.utterance.category === category)) {
        expect(outcome.status, outcome.utterance.transcript).not.toBe("resolved");
      }
    },
  );
});
