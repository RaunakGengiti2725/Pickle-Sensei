import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PICKLEBALL_TECHNIQUES,
  STROKE_FAMILIES,
  STROKE_SIDES,
  type PickleballTechniqueSlug,
  type StrokeFamily,
} from "@pickle/shared-types";

/**
 * Canonical-taxonomy stroke benchmark: L1 family / L2 side / L3 exact
 * technique, scored against the v2 61-technique ontology
 * (packages/shared-types/src/pickleballTaxonomy.ts — the product-wide
 * source of truth per ml/README.md, versioned as "pickleball-taxonomy-v2"
 * in analysis-pipeline).
 *
 * Gold labels live in datasets/paddle-bench/stroke-gold.json (append-only,
 * one entry per labeled event; explicit "unknown" is a first-class label,
 * never a guess). Predictions arrive in the v3 recognition taxonomy
 * (STROKE_TAXONOMY_V3); a v3 leaf maps to a SET of compatible v2
 * techniques, so an L3 verdict of "ambiguous" means the prediction is
 * consistent with the gold technique but cannot commit to it exactly —
 * counted separately from correct, never folded in.
 *
 * Prediction-side metrics require canonical run dirs
 * (datasets/paddle-bench/runs/, regenerated only via pnpm lab:regen). On
 * machines without them the CLI reports gold coverage and says so; the
 * scoring paths are fixture-tested in test/strokeTaxonomyBench.test.ts.
 */

export const STROKE_GOLD_TAXONOMY_VERSION = "pickleball-taxonomy-v2" as const;
export const STROKE_GOLD_SCHEMA_VERSION = 1 as const;

const TECHNIQUE_SLUGS = new Set<string>(PICKLEBALL_TECHNIQUES.map((technique) => technique.slug));
const FAMILY_OF_SLUG = new Map<string, StrokeFamily>(
  PICKLEBALL_TECHNIQUES.map((technique) => [technique.slug, technique.family]),
);

export type GoldL2 = (typeof STROKE_SIDES)[number] | "unknown" | "not_applicable";

export interface StrokeGoldLabel {
  caseId: string;
  /** Event linkage: must match an eventLabels entry in the bundle annotation. */
  eventStartMs: number;
  contactMs: number | null;
  eventEndMs: number;
  owner: "target" | "other";
  l1: StrokeFamily | "unknown";
  l2: GoldL2;
  l3: PickleballTechniqueSlug | "unknown";
  reasoning: string;
  annotatorId: string;
  createdAtIso: string;
}

export interface StrokeGoldFile {
  schemaVersion: typeof STROKE_GOLD_SCHEMA_VERSION;
  taxonomyVersion: typeof STROKE_GOLD_TAXONOMY_VERSION;
  provenance: string;
  note: string;
  labels: StrokeGoldLabel[];
}

export function validateStrokeGoldFile(raw: unknown): string[] {
  const problems: string[] = [];
  const file = raw as Partial<StrokeGoldFile> | null;
  if (!file || typeof file !== "object") return ["stroke gold must be an object"];
  if (file.schemaVersion !== STROKE_GOLD_SCHEMA_VERSION) problems.push("bad schemaVersion");
  if (file.taxonomyVersion !== STROKE_GOLD_TAXONOMY_VERSION) {
    problems.push(`taxonomyVersion must be ${STROKE_GOLD_TAXONOMY_VERSION}`);
  }
  if (!Array.isArray(file.labels)) return [...problems, "labels must be an array"];
  file.labels.forEach((label, index) => {
    const at = `labels[${index}]`;
    if (!label.caseId) problems.push(`${at}: caseId required`);
    if (!label.annotatorId) problems.push(`${at}: annotatorId required`);
    if (!label.reasoning) problems.push(`${at}: reasoning required`);
    if (
      typeof label.eventStartMs !== "number" ||
      typeof label.eventEndMs !== "number" ||
      label.eventEndMs <= label.eventStartMs
    ) {
      problems.push(`${at}: eventStartMs < eventEndMs required`);
    }
    if (
      label.contactMs !== null &&
      (typeof label.contactMs !== "number" ||
        label.contactMs < label.eventStartMs ||
        label.contactMs > label.eventEndMs)
    ) {
      problems.push(`${at}: contactMs must lie inside the event or be null`);
    }
    if (!["target", "other"].includes(label.owner)) problems.push(`${at}: invalid owner`);
    if (label.l1 !== "unknown" && !STROKE_FAMILIES.includes(label.l1 as StrokeFamily)) {
      problems.push(`${at}: invalid l1 ${String(label.l1)}`);
    }
    if (
      label.l2 !== "unknown" &&
      label.l2 !== "not_applicable" &&
      !STROKE_SIDES.includes(label.l2 as (typeof STROKE_SIDES)[number])
    ) {
      problems.push(`${at}: invalid l2 ${String(label.l2)}`);
    }
    if (label.l3 !== "unknown" && !TECHNIQUE_SLUGS.has(label.l3 as string)) {
      problems.push(`${at}: invalid l3 ${String(label.l3)}`);
    }
    if (label.l3 !== "unknown" && label.l1 !== "unknown") {
      const family = FAMILY_OF_SLUG.get(label.l3 as string);
      if (family !== label.l1)
        problems.push(`${at}: l3 ${String(label.l3)} is not in family ${String(label.l1)}`);
    }
    if (label.l3 !== "unknown" && label.l1 === "unknown") {
      problems.push(`${at}: l3 committed while l1 unknown`);
    }
  });
  return problems;
}

// ── v3 recognition taxonomy → v2 canonical mapping ─────────────────────────

/** Family each v3 recognition leaf lands in (context-free; RETURN/SERVE are
 * families of their own in v2, DROP/RESET share drop_reset). */
export const V3_LEAF_FAMILY: Readonly<Record<string, StrokeFamily>> = {
  FOREHAND_DRIVE: "groundstroke",
  BACKHAND_DRIVE: "groundstroke",
  SERVE: "serve",
  RETURN: "return",
  FOREHAND_DINK: "dink",
  BACKHAND_DINK: "dink",
  FOREHAND_VOLLEY: "volley",
  BACKHAND_VOLLEY: "volley",
  DROP: "drop_reset",
  RESET: "drop_reset",
  OVERHEAD: "overhead_lob",
  SPEEDUP: "attack_counter",
};

/** v2 techniques a v3 leaf is compatible with. A non-singleton set means the
 * v3 vocabulary genuinely cannot express the exact v2 technique. */
export function compatibleTechniques(v3Leaf: string): readonly PickleballTechniqueSlug[] {
  const family = V3_LEAF_FAMILY[v3Leaf];
  if (!family) return [];
  const inFamily = PICKLEBALL_TECHNIQUES.filter((technique) => technique.family === family);
  const side = v3Leaf.startsWith("FOREHAND")
    ? "forehand"
    : v3Leaf.startsWith("BACKHAND")
      ? "backhand"
      : null;
  const filtered = inFamily.filter((technique) => {
    if (v3Leaf === "DROP") return technique.slug.includes("drop");
    if (v3Leaf === "RESET") return technique.slug.startsWith("reset_");
    if (v3Leaf === "SPEEDUP") return technique.slug.startsWith("speedup_");
    if (side === "forehand") return technique.slug.includes("forehand");
    if (side === "backhand") return technique.slug.includes("backhand");
    return true;
  });
  return filtered.map((technique) => technique.slug);
}

// ── hierarchical scoring ────────────────────────────────────────────────────

/** Structural subset of StrokePrediction / report.json strokePrediction. */
export interface StrokePredictionLike {
  label: string;
  leaf: string | null;
  taxonomyDepth: number;
  confidence: number;
}

export type L1Verdict = "correct" | "wrong" | "abstained" | "gold_unknown";
export type L2Verdict = "correct" | "wrong" | "abstained" | "gold_unknown" | "not_applicable";
export type L3Verdict = "correct" | "ambiguous" | "wrong" | "abstained" | "gold_unknown";

export interface LevelVerdicts {
  l1: L1Verdict;
  l2: L2Verdict;
  l3: L3Verdict;
}

function predictionSide(
  prediction: StrokePredictionLike,
): "forehand" | "backhand" | "overhead" | null {
  const label = prediction.leaf ?? prediction.label;
  if (label === "OVERHEAD") return "overhead";
  if (prediction.taxonomyDepth < 2) return null;
  if (label.startsWith("FOREHAND")) return "forehand";
  if (label.startsWith("BACKHAND")) return "backhand";
  return null;
}

/** Gold side reduced to the hand side a v3 prediction can express
 * (two_hand_backhand is a backhand at the side level). */
function goldHandSide(l2: GoldL2): "forehand" | "backhand" | "overhead" | null {
  if (l2 === "forehand" || l2 === "backhand" || l2 === "overhead") return l2;
  if (l2 === "two_hand_backhand") return "backhand";
  return null;
}

export function evaluatePrediction(
  gold: Pick<StrokeGoldLabel, "l1" | "l2" | "l3">,
  prediction: StrokePredictionLike | null,
): LevelVerdicts {
  // L1 family
  let l1: L1Verdict;
  if (gold.l1 === "unknown") {
    l1 = "gold_unknown";
  } else if (!prediction) {
    l1 = "abstained";
  } else {
    const leaf = prediction.leaf ?? prediction.label;
    const family = V3_LEAF_FAMILY[leaf];
    // depth-1/2 predictions (SWING, FOREHAND, BACKHAND, UNKNOWN) cannot name
    // one of the nine v2 families — honest abstention at L1.
    l1 = family ? (family === gold.l1 ? "correct" : "wrong") : "abstained";
  }

  // L2 side
  let l2: L2Verdict;
  const goldSide = goldHandSide(gold.l2);
  if (gold.l2 === "not_applicable") {
    l2 = "not_applicable";
  } else if (gold.l2 === "unknown" || goldSide === null) {
    l2 = "gold_unknown";
  } else if (!prediction) {
    l2 = "abstained";
  } else {
    const side = predictionSide(prediction);
    l2 = side === null ? "abstained" : side === goldSide ? "correct" : "wrong";
  }

  // L3 exact technique
  let l3: L3Verdict;
  if (gold.l3 === "unknown") {
    l3 = "gold_unknown";
  } else if (!prediction || prediction.taxonomyDepth < 3 || prediction.leaf === null) {
    l3 = "abstained";
  } else {
    const compatible = compatibleTechniques(prediction.leaf);
    if (!compatible.includes(gold.l3)) l3 = "wrong";
    else l3 = compatible.length === 1 ? "correct" : "ambiguous";
  }
  return { l1, l2, l3 };
}

// ── declared-intent-as-prior ────────────────────────────────────────────────

export interface DeclaredIntentLike {
  /** v3 canonical technique the user declared, or null for AUTO DETECT. */
  canonical: string | null;
}

export interface IntentPriorOutcome {
  prediction: StrokePredictionLike;
  intentPriorApplied: boolean;
  /** Observation contradicted the declared intent — intent is NEVER allowed
   * to override measured evidence, only to deepen an abstention. */
  intentConflict: boolean;
}

export function applyDeclaredIntentPrior(
  prediction: StrokePredictionLike,
  intent: DeclaredIntentLike | null,
): IntentPriorOutcome {
  if (!intent || intent.canonical === null || !V3_LEAF_FAMILY[intent.canonical]) {
    return { prediction, intentPriorApplied: false, intentConflict: false };
  }
  if (prediction.taxonomyDepth >= 3 && prediction.leaf !== null) {
    return {
      prediction,
      intentPriorApplied: false,
      intentConflict: prediction.leaf !== intent.canonical,
    };
  }
  const observedSide = predictionSide(prediction);
  const intentSide = predictionSide({
    label: intent.canonical,
    leaf: intent.canonical,
    taxonomyDepth: 3,
    confidence: 1,
  });
  if (observedSide !== null && intentSide !== null && observedSide !== intentSide) {
    return { prediction, intentPriorApplied: false, intentConflict: true };
  }
  return {
    prediction: {
      label: intent.canonical,
      leaf: intent.canonical,
      taxonomyDepth: 3,
      confidence: Math.min(prediction.confidence, 0.5),
    },
    intentPriorApplied: true,
    intentConflict: false,
  };
}

// ── aggregation + confusion matrices ────────────────────────────────────────

export interface BenchRow {
  gold: StrokeGoldLabel;
  prediction: StrokePredictionLike | null;
  declaredIntent?: DeclaredIntentLike | null;
}

export interface LevelSummary {
  applicable: number;
  correct: number;
  ambiguous: number;
  wrong: number;
  abstained: number;
  goldUnknown: number;
}

export interface BenchReport {
  rows: Array<{ gold: StrokeGoldLabel; verdicts: LevelVerdicts }>;
  l1: LevelSummary;
  l2: LevelSummary;
  l3: LevelSummary;
  /** goldLabel → predictedLabel → count. Predicted "ABSTAINED" is explicit. */
  confusion: {
    l1: Record<string, Record<string, number>>;
    l2: Record<string, Record<string, number>>;
    l3: Record<string, Record<string, number>>;
  };
}

function emptySummary(): LevelSummary {
  return { applicable: 0, correct: 0, ambiguous: 0, wrong: 0, abstained: 0, goldUnknown: 0 };
}

function bump(
  matrix: Record<string, Record<string, number>>,
  gold: string,
  predicted: string,
): void {
  matrix[gold] = matrix[gold] ?? {};
  matrix[gold]![predicted] = (matrix[gold]![predicted] ?? 0) + 1;
}

export function benchStrokeGold(
  rows: BenchRow[],
  options?: { useDeclaredIntent?: boolean },
): BenchReport {
  const report: BenchReport = {
    rows: [],
    l1: emptySummary(),
    l2: emptySummary(),
    l3: emptySummary(),
    confusion: { l1: {}, l2: {}, l3: {} },
  };
  for (const row of rows) {
    let prediction = row.prediction;
    if (prediction && options?.useDeclaredIntent) {
      prediction = applyDeclaredIntentPrior(prediction, row.declaredIntent ?? null).prediction;
    }
    const verdicts = evaluatePrediction(row.gold, prediction);
    report.rows.push({ gold: row.gold, verdicts });

    const leaf = prediction ? (prediction.leaf ?? prediction.label) : "ABSTAINED";
    const predictedL1 = prediction ? (V3_LEAF_FAMILY[leaf] ?? "ABSTAINED") : "ABSTAINED";
    const predictedL2 = prediction ? (predictionSide(prediction) ?? "ABSTAINED") : "ABSTAINED";
    const predictedL3 =
      prediction && prediction.taxonomyDepth >= 3 && prediction.leaf
        ? prediction.leaf
        : "ABSTAINED";
    bump(report.confusion.l1, row.gold.l1, predictedL1);
    if (row.gold.l2 !== "not_applicable") bump(report.confusion.l2, row.gold.l2, predictedL2);
    bump(report.confusion.l3, row.gold.l3, predictedL3);

    const apply = (summary: LevelSummary, verdict: string) => {
      if (verdict === "not_applicable") return;
      if (verdict === "gold_unknown") {
        summary.goldUnknown += 1;
        return;
      }
      summary.applicable += 1;
      if (verdict === "correct") summary.correct += 1;
      else if (verdict === "ambiguous") summary.ambiguous += 1;
      else if (verdict === "wrong") summary.wrong += 1;
      else summary.abstained += 1;
    };
    apply(report.l1, verdicts.l1);
    apply(report.l2, verdicts.l2);
    apply(report.l3, verdicts.l3);
  }
  return report;
}

export function formatConfusion(matrix: Record<string, Record<string, number>>): string[] {
  const lines: string[] = [];
  for (const gold of Object.keys(matrix).sort()) {
    const cells = Object.entries(matrix[gold]!)
      .sort((a, b) => b[1] - a[1])
      .map(([predicted, count]) => `${predicted}×${count}`)
      .join(" · ");
    lines.push(`  gold ${gold}: ${cells}`);
  }
  return lines;
}

function formatSummary(name: string, summary: LevelSummary): string {
  return (
    `${name}: ${summary.correct}/${summary.applicable} correct · ` +
    `${summary.ambiguous} ambiguous · ${summary.wrong} wrong · ` +
    `${summary.abstained} abstained · ${summary.goldUnknown} gold-unknown (excluded)`
  );
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("strokeTaxonomyBench.ts");
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const goldPath = resolve(
    process.argv[2] ?? join(repoRoot, "datasets/paddle-bench/stroke-gold.json"),
  );
  const gold = JSON.parse(readFileSync(goldPath, "utf8")) as StrokeGoldFile;
  const problems = validateStrokeGoldFile(gold);
  if (problems.length > 0) {
    console.error(`stroke gold INVALID (${goldPath}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log("═".repeat(66));
  console.log(`CANONICAL STROKE TAXONOMY BENCH [${STROKE_GOLD_TAXONOMY_VERSION}]`);
  console.log(`gold file: ${goldPath} [provenance: ${gold.provenance}]`);
  console.log(
    `labels: ${gold.labels.length} across ${new Set(gold.labels.map((label) => label.caseId)).size} cases`,
  );
  const byAnnotator = new Map<string, number>();
  for (const label of gold.labels) {
    byAnnotator.set(label.annotatorId, (byAnnotator.get(label.annotatorId) ?? 0) + 1);
  }
  console.log(`annotators: ${[...byAnnotator].map(([id, count]) => `${id}×${count}`).join(" · ")}`);
  const countBy = (extract: (label: StrokeGoldLabel) => string) => {
    const counts = new Map<string, number>();
    for (const label of gold.labels)
      counts.set(extract(label), (counts.get(extract(label)) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key}×${count}`)
      .join(" · ");
  };
  console.log(`L1 coverage: ${countBy((label) => label.l1)}`);
  console.log(`L2 coverage: ${countBy((label) => label.l2)}`);
  console.log(`L3 coverage: ${countBy((label) => label.l3)}`);

  // Prediction side: per-case report.json from canonical runs (regen-only).
  const manifestPath = join(repoRoot, "datasets/ball-bench/ball-bench.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    cases: Array<{ id: string; runDir: string }>;
  };
  const runDirOf = new Map(manifest.cases.map((benchCase) => [benchCase.id, benchCase.runDir]));
  const rows: BenchRow[] = [];
  let missingRuns = 0;
  for (const label of gold.labels) {
    if (label.owner !== "target") continue; // report.json strokePrediction is the TARGET's stroke
    const runDir = runDirOf.get(label.caseId);
    const reportPath = runDir ? resolve(dirname(manifestPath), runDir, "report.json") : null;
    if (!reportPath || !existsSync(reportPath)) {
      missingRuns += 1;
      continue;
    }
    const runReport = JSON.parse(readFileSync(reportPath, "utf8")) as {
      strokePrediction?: StrokePredictionLike | null;
    };
    rows.push({ gold: label, prediction: runReport.strokePrediction ?? null });
  }
  console.log("═".repeat(66));
  if (rows.length === 0) {
    console.log(
      `PREDICTION SIDE: no canonical run reports found (${missingRuns} target labels without a run dir).`,
    );
    console.log(
      "Canonical runs (datasets/paddle-bench/runs/) exist only where pnpm lab:regen has run" +
        " (macOS pose extraction); scoring paths are FIXTURE-TESTED in test/strokeTaxonomyBench.test.ts.",
    );
  } else {
    if (missingRuns > 0) {
      console.log(
        `NOTE: ${missingRuns} target labels skipped — no canonical run report on this machine.`,
      );
    }
    const benched = benchStrokeGold(rows);
    console.log(formatSummary("L1 family", benched.l1));
    console.log(formatSummary("L2 side  ", benched.l2));
    console.log(formatSummary("L3 exact ", benched.l3));
    console.log("confusion L1 (gold → predicted):");
    for (const line of formatConfusion(benched.confusion.l1)) console.log(line);
    console.log("confusion L2 (gold → predicted):");
    for (const line of formatConfusion(benched.confusion.l2)) console.log(line);
    console.log("confusion L3 (gold → predicted):");
    for (const line of formatConfusion(benched.confusion.l3)) console.log(line);
    console.log(
      "NOTE: multi-event cases pair the case-level strokePrediction with each target event label;" +
        " per-event predictions do not exist yet (single-stroke cases are the trustworthy rows).",
    );
  }
}
