import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PICKLEBALL_TECHNIQUES } from "@pickle/shared-types";
import {
  applyDeclaredIntentPrior,
  benchStrokeGold,
  compatibleTechniques,
  evaluatePrediction,
  validateStrokeGoldFile,
  V3_LEAF_FAMILY,
  type StrokeGoldFile,
  type StrokeGoldLabel,
  type StrokePredictionLike,
} from "../src/strokeTaxonomyBench.js";
import { STROKE_TAXONOMY_V3 } from "../src/strokeHeuristic.js";

const REPO_ROOT = resolve(__dirname, "../../..");

function goldLabel(overrides: Partial<StrokeGoldLabel>): StrokeGoldLabel {
  return {
    caseId: "fixture-case",
    eventStartMs: 0,
    contactMs: 100,
    eventEndMs: 500,
    owner: "target",
    l1: "volley",
    l2: "backhand",
    l3: "punch_volley_backhand",
    reasoning: "fixture",
    annotatorId: "fixture-annotator",
    createdAtIso: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function prediction(overrides: Partial<StrokePredictionLike>): StrokePredictionLike {
  return {
    label: "BACKHAND_VOLLEY",
    leaf: "BACKHAND_VOLLEY",
    taxonomyDepth: 3,
    confidence: 0.7,
    ...overrides,
  };
}

describe("v3 → v2 canonical taxonomy mapping", () => {
  it("maps every non-UNKNOWN v3 leaf into a v2 family", () => {
    for (const leaf of STROKE_TAXONOMY_V3.labels) {
      if (leaf === "UNKNOWN") continue;
      expect(V3_LEAF_FAMILY[leaf], leaf).toBeDefined();
    }
  });

  it("compatible technique sets are non-empty subsets of the leaf's family", () => {
    for (const leaf of STROKE_TAXONOMY_V3.labels) {
      if (leaf === "UNKNOWN") continue;
      const slugs = compatibleTechniques(leaf);
      expect(slugs.length, leaf).toBeGreaterThan(0);
      for (const slug of slugs) {
        const technique = PICKLEBALL_TECHNIQUES.find((entry) => entry.slug === slug)!;
        expect(technique.family).toBe(V3_LEAF_FAMILY[leaf]);
      }
    }
  });

  it("no v3 leaf can express an exact dink technique (sets stay ambiguous)", () => {
    expect(compatibleTechniques("FOREHAND_DINK").length).toBeGreaterThan(1);
  });
});

describe("hierarchical L1/L2/L3 scoring", () => {
  it("scores an exactly-compatible singleton leaf correct at all levels", () => {
    // OVERHEAD → { overhead_smash, backhand_overhead, lobs } is NOT singleton;
    // use a gold where the leaf's set is >1 to show ambiguity, and a
    // synthetic singleton via SPEEDUP side filtering.
    const verdicts = evaluatePrediction(
      goldLabel({ l1: "attack_counter", l2: "forehand", l3: "speedup_forehand" }),
      prediction({ label: "SPEEDUP", leaf: "SPEEDUP", taxonomyDepth: 3 }),
    );
    expect(verdicts.l1).toBe("correct");
    // SPEEDUP carries no side in v3 → side abstains, set {speedup_forehand,speedup_backhand} → ambiguous
    expect(verdicts.l2).toBe("abstained");
    expect(verdicts.l3).toBe("ambiguous");
  });

  it("marks consistent-but-inexact leaves ambiguous, never correct", () => {
    const verdicts = evaluatePrediction(
      goldLabel({ l1: "volley", l2: "backhand", l3: "punch_volley_backhand" }),
      prediction({}),
    );
    expect(verdicts).toEqual({ l1: "correct", l2: "correct", l3: "ambiguous" });
  });

  it("scores wrong family/side/leaf as wrong", () => {
    const verdicts = evaluatePrediction(
      goldLabel({ l1: "dink", l2: "backhand", l3: "dink_straight_backhand" }),
      prediction({ label: "FOREHAND_DRIVE", leaf: "FOREHAND_DRIVE" }),
    );
    expect(verdicts).toEqual({ l1: "wrong", l2: "wrong", l3: "wrong" });
  });

  it("depth-2 predictions abstain at L1 (side names no v2 family) and L3", () => {
    const verdicts = evaluatePrediction(
      goldLabel({}),
      prediction({ label: "BACKHAND", leaf: null, taxonomyDepth: 2 }),
    );
    expect(verdicts).toEqual({ l1: "abstained", l2: "correct", l3: "abstained" });
  });

  it("gold unknown levels are excluded, not scored", () => {
    const verdicts = evaluatePrediction(
      goldLabel({ l1: "unknown", l2: "unknown", l3: "unknown" }),
      prediction({}),
    );
    expect(verdicts).toEqual({ l1: "gold_unknown", l2: "gold_unknown", l3: "gold_unknown" });
  });

  it("treats two_hand_backhand gold as backhand at the side level", () => {
    const verdicts = evaluatePrediction(
      goldLabel({ l1: "dink", l2: "two_hand_backhand", l3: "dink_two_hand_backhand" }),
      prediction({ label: "BACKHAND_DINK", leaf: "BACKHAND_DINK" }),
    );
    expect(verdicts.l2).toBe("correct");
  });

  it("missing prediction abstains everywhere", () => {
    const verdicts = evaluatePrediction(goldLabel({}), null);
    expect(verdicts).toEqual({ l1: "abstained", l2: "abstained", l3: "abstained" });
  });
});

describe("declared-intent-as-prior", () => {
  it("AUTO (null canonical) never changes the prediction", () => {
    const raw = prediction({ label: "FOREHAND", leaf: null, taxonomyDepth: 2 });
    const outcome = applyDeclaredIntentPrior(raw, { canonical: null });
    expect(outcome).toEqual({ prediction: raw, intentPriorApplied: false, intentConflict: false });
  });

  it("deepens an abstention consistent with the declared side", () => {
    const outcome = applyDeclaredIntentPrior(
      prediction({ label: "FOREHAND", leaf: null, taxonomyDepth: 2, confidence: 0.8 }),
      { canonical: "FOREHAND_DINK" },
    );
    expect(outcome.intentPriorApplied).toBe(true);
    expect(outcome.prediction.leaf).toBe("FOREHAND_DINK");
    expect(outcome.prediction.taxonomyDepth).toBe(3);
    expect(outcome.prediction.confidence).toBeLessThanOrEqual(0.5);
  });

  it("never overrides a measured side that contradicts the intent", () => {
    const raw = prediction({ label: "BACKHAND", leaf: null, taxonomyDepth: 2 });
    const outcome = applyDeclaredIntentPrior(raw, { canonical: "FOREHAND_DINK" });
    expect(outcome.prediction).toEqual(raw);
    expect(outcome.intentPriorApplied).toBe(false);
    expect(outcome.intentConflict).toBe(true);
  });

  it("never rewrites a depth-3 observation; disagreement is flagged", () => {
    const raw = prediction({});
    const outcome = applyDeclaredIntentPrior(raw, { canonical: "FOREHAND_DINK" });
    expect(outcome.prediction).toEqual(raw);
    expect(outcome.intentConflict).toBe(true);
  });

  it("bench with intent recovers depth on abstained rows and leaves conflicts alone", () => {
    const rows = [
      {
        gold: goldLabel({ l1: "dink", l2: "forehand", l3: "dink_crosscourt_forehand" }),
        prediction: prediction({ label: "FOREHAND", leaf: null, taxonomyDepth: 2 }),
        declaredIntent: { canonical: "FOREHAND_DINK" },
      },
      {
        gold: goldLabel({ l1: "dink", l2: "backhand", l3: "dink_straight_backhand" }),
        prediction: prediction({ label: "BACKHAND", leaf: null, taxonomyDepth: 2 }),
        declaredIntent: { canonical: "FOREHAND_DINK" },
      },
    ];
    const without = benchStrokeGold(rows);
    const withIntent = benchStrokeGold(rows, { useDeclaredIntent: true });
    expect(without.l1.abstained).toBe(2);
    // row 1: intent deepens FOREHAND → FOREHAND_DINK (family correct, L3 ambiguous);
    // row 2: conflict → untouched abstention.
    expect(withIntent.l1.correct).toBe(1);
    expect(withIntent.l1.abstained).toBe(1);
    expect(withIntent.l3.ambiguous).toBe(1);
  });
});

describe("stroke gold file", () => {
  it("validator rejects taxonomy violations", () => {
    const bad: StrokeGoldFile = {
      schemaVersion: 1,
      taxonomyVersion: "pickleball-taxonomy-v2",
      provenance: "fixture",
      note: "",
      labels: [
        goldLabel({ l1: "dink", l3: "punch_volley_backhand" }), // family mismatch
        goldLabel({ l1: "unknown", l3: "dink_straight_backhand" }), // l3 without l1
        goldLabel({ l3: "not_a_slug" as never }),
      ],
    };
    const problems = validateStrokeGoldFile(bad);
    expect(problems.some((problem) => problem.includes("not in family"))).toBe(true);
    expect(problems.some((problem) => problem.includes("l3 committed while l1 unknown"))).toBe(
      true,
    );
    expect(problems.some((problem) => problem.includes("invalid l3"))).toBe(true);
  });

  it("the committed stroke gold file is valid and append-only annotated", () => {
    const goldPath = join(REPO_ROOT, "datasets/paddle-bench/stroke-gold.json");
    const gold = JSON.parse(readFileSync(goldPath, "utf8")) as StrokeGoldFile;
    expect(validateStrokeGoldFile(gold)).toEqual([]);
    expect(gold.labels.length).toBeGreaterThanOrEqual(15);
    for (const label of gold.labels) {
      expect(["devin-visual-v2-waveC", "devin-visual-v3-waveD"]).toContain(label.annotatorId);
      expect(["wm-dink-01", "afn-vic-rally1"]).not.toContain(label.caseId); // held-out untouched
      expect(label.reasoning.length).toBeGreaterThan(20);
    }
  });
});
