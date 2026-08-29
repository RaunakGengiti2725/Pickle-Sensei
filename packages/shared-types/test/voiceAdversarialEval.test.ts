/**
 * Adversarial voice-intent evaluation (wave-f f27) — attacks the E20 bound
 * (100% accuracy / 0% false activation on the 73-utterance corpus) with the
 * harder corpus in voiceAdversarialCorpus.ts. Metrics at the projection level:
 *
 *  - FALSE-ACCEPT RATE: projection resolves when gold isn't resolved, or
 *    resolves the wrong canonical — a silent mis-selection.
 *  - MIS-SELECTION RATE: outcome differs from gold but still re-prompts
 *    (softer miss — the UI recovers, but the narrowing was wrong).
 *
 * The hard invariant matches the E20 harness: zero false accepts. Negated
 * and ambient utterances must re-prompt, never silently select.
 */
import { describe, expect, it } from "vitest";
import { projectVoiceResolution, resolveVoiceTechniqueIntent } from "../src/index.js";
import {
  VOICE_ADVERSARIAL_CORPUS,
  type AdversarialCategory,
  type AdversarialUtterance,
} from "./voiceAdversarialCorpus.js";

interface Outcome {
  utterance: AdversarialUtterance;
  status: string;
  canonical: string | null;
  correct: boolean;
  falseAccept: boolean;
}

function evaluate(utterance: AdversarialUtterance): Outcome {
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

const outcomes = VOICE_ADVERSARIAL_CORPUS.map(evaluate);

function metrics(subset: readonly Outcome[]) {
  const total = subset.length;
  const correct = subset.filter((outcome) => outcome.correct).length;
  const falseAccepts = subset.filter((outcome) => outcome.falseAccept).length;
  const misSelections = subset.filter((outcome) => !outcome.correct && !outcome.falseAccept).length;
  return {
    total,
    correct,
    accuracy: total === 0 ? 1 : correct / total,
    falseAccepts,
    falseAcceptRate: total === 0 ? 0 : falseAccepts / total,
    misSelections,
    misSelectionRate: total === 0 ? 0 : misSelections / total,
  };
}

describe("voice-intent ADVERSARIAL eval (wave-f f27)", () => {
  it("reports per-category adversarial metrics", () => {
    const categories = [...new Set(outcomes.map((outcome) => outcome.utterance.category))];
    const report: Record<string, ReturnType<typeof metrics>> = {
      overall: metrics(outcomes),
    };
    for (const category of categories) {
      report[category] = metrics(
        outcomes.filter((outcome) => outcome.utterance.category === category),
      );
    }
    console.log("VOICE_ADVERSARIAL_METRICS " + JSON.stringify(report));
    const mismatches = outcomes
      .filter((outcome) => !outcome.correct)
      .map(
        (outcome) =>
          `"${outcome.utterance.transcript}" → ${outcome.status}` +
          `${outcome.canonical ? `(${outcome.canonical})` : ""} wanted ${outcome.utterance.gold.kind}` +
          `${outcome.utterance.gold.kind === "resolved" ? `(${outcome.utterance.gold.canonical})` : ""}` +
          `${outcome.falseAccept ? " [FALSE ACCEPT]" : ""}`,
      );
    console.log("VOICE_ADVERSARIAL_MISMATCHES " + JSON.stringify(mismatches));
    expect(outcomes.length).toBeGreaterThanOrEqual(90);
  });

  it("HARD INVARIANT: zero false accepts — never silently mis-select", () => {
    const falseAccepted = outcomes.filter((outcome) => outcome.falseAccept);
    expect(
      falseAccepted.map((outcome) => `"${outcome.utterance.transcript}" → ${outcome.canonical}`),
      "false accepts",
    ).toEqual([]);
  });

  it("overall adversarial accuracy ≥ 95% (residual misses are safe re-prompts)", () => {
    expect(metrics(outcomes).accuracy).toBeGreaterThanOrEqual(0.95);
  });

  it.each(["negation", "ambient_speech"] as AdversarialCategory[])(
    "%s utterances never resolve a technique the player did not declare",
    (category) => {
      for (const outcome of outcomes.filter((o) => o.utterance.category === category)) {
        if (outcome.utterance.gold.kind !== "resolved") {
          expect(outcome.status, outcome.utterance.transcript).not.toBe("resolved");
        }
      }
    },
  );
});
