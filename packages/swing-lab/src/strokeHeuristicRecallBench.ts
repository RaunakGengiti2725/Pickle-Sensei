import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { classifyStroke, STROKE_HEURISTIC_VERSION } from "./strokeHeuristic.js";
import {
  classifyStroke as classifyStrokeV5,
  STROKE_HEURISTIC_VERSION as STROKE_HEURISTIC_V5_VERSION,
} from "./strokeHeuristicV5Frozen.js";
import {
  evaluateGoldLabel,
  goldL1Class,
  loadCaseHandedness,
  loadCasePose,
  loadStrokeGold,
  STROKE_BENCH_POSE_CASES,
  type BenchPose,
  type BenchRow,
  type StrokeClassifier,
} from "./strokeHeuristicBench.js";

/**
 * STROKE HEURISTIC RECALL BENCH (wave-g g15-h6-recall) — did the v6
 * abstention gates (92e0c2c sparse-declared-wrist, 629a9fc median-
 * normalization OVERHEAD cross-check) destroy true OVERHEAD recall?
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/strokeHeuristicRecallBench.ts
 *
 * Runs stroke-heuristic-6 (HEAD) and stroke-heuristic-5 (frozen snapshot
 * of git d6f951f, strokeHeuristicV5Frozen.ts) over IDENTICAL inputs: the
 * same gold labels, pose tracks, handedness, contact references, and
 * wrist-speed series, built exactly once per row by the e03 bench loader
 * (strokeHeuristicBench.ts). Dev-tier gold only — the held-out cases
 * (wm-dink-01, afn-vic-rally1) have no committed pose and no gold rows
 * here by construction.
 *
 * Reported per version, ALWAYS as counts (never a bare percentage):
 *  - OVERHEAD recall: gold overhead_lob rows → predicted OVERHEAD /
 *    abstained / committed-wrong-family.
 *  - OVERHEAD precision: committed OVERHEAD predictions → gold overhead /
 *    gold non-overhead / gold unknown (indeterminate, reported separately).
 *  - per-family L1 accuracy (correct / wrong / abstained per gold family).
 *  - abstention rate: L1 abstentions over gold-known rows.
 *  - silent-wrong rate: committed (non-UNKNOWN) predictions wrong at L1 or
 *    L2, over committed predictions.
 */

export const STROKE_RECALL_BENCH_VERSION = "stroke-heuristic-recall-bench-v1";

export interface VersionCounts {
  /** Gold-known (L1 applicable) rows. */
  applicable: number;
  l1Correct: number;
  l1Wrong: number;
  l1Abstained: number;
  goldUnknown: number;
  /** Committed (non-UNKNOWN, non-pose-unavailable) predictions. */
  committed: number;
  /** Committed predictions wrong at L1 or L2 (silent wrong). */
  silentWrong: number;
  /** OVERHEAD recall numerators/denominator (gold overhead_lob rows). */
  overheadGold: number;
  overheadPredicted: number;
  overheadAbstained: number;
  overheadCommittedWrongFamily: number;
  /** OVERHEAD precision (committed OVERHEAD predictions). */
  overheadClaims: number;
  overheadClaimsGoldOverhead: number;
  overheadClaimsGoldOther: number;
  overheadClaimsGoldUnknown: number;
}

export function emptyVersionCounts(): VersionCounts {
  return {
    applicable: 0,
    l1Correct: 0,
    l1Wrong: 0,
    l1Abstained: 0,
    goldUnknown: 0,
    committed: 0,
    silentWrong: 0,
    overheadGold: 0,
    overheadPredicted: 0,
    overheadAbstained: 0,
    overheadCommittedWrongFamily: 0,
    overheadClaims: 0,
    overheadClaimsGoldOverhead: 0,
    overheadClaimsGoldOther: 0,
    overheadClaimsGoldUnknown: 0,
  };
}

export function accumulateVersionCounts(counts: VersionCounts, row: BenchRow): void {
  if (row.l1 === "pose_unavailable") return;
  const goldClass = goldL1Class(row.goldL1 as Parameters<typeof goldL1Class>[0]);
  if (goldClass === null) counts.goldUnknown += 1;
  else counts.applicable += 1;
  if (row.l1 === "correct") counts.l1Correct += 1;
  else if (row.l1 === "wrong") counts.l1Wrong += 1;
  else if (row.l1 === "abstained") counts.l1Abstained += 1;

  const isCommitted = row.predictedLabel !== "UNKNOWN" && row.predictedLabel !== "—";
  if (isCommitted) {
    counts.committed += 1;
    if (row.l1 === "wrong" || row.l2 === "wrong") counts.silentWrong += 1;
  }

  if (goldClass === "OVERHEAD") {
    counts.overheadGold += 1;
    if (row.predictedLabel === "OVERHEAD") counts.overheadPredicted += 1;
    else if (isCommitted) counts.overheadCommittedWrongFamily += 1;
    else counts.overheadAbstained += 1;
  }
  if (row.predictedLabel === "OVERHEAD") {
    counts.overheadClaims += 1;
    if (goldClass === "OVERHEAD") counts.overheadClaimsGoldOverhead += 1;
    else if (goldClass === null) counts.overheadClaimsGoldUnknown += 1;
    else counts.overheadClaimsGoldOther += 1;
  }
}

export interface PairedRow {
  caseId: string;
  group: string;
  owner: "target" | "other";
  eventStartMs: number;
  goldL1: string;
  goldL2: string;
  v5Predicted: string;
  v6Predicted: string;
  v5L1: string;
  v6L1: string;
  v5L2: string;
  v6L2: string;
  changed: boolean;
  v6LimitingFactors: string[];
  v5LimitingFactors: string[];
}

export interface RecallBenchReport {
  benchVersion: string;
  v6ClassifierVersion: string;
  v5ClassifierVersion: string;
  v5Provenance: string;
  goldLabelsTotal: number;
  evaluableLabels: number;
  unevaluableCases: Record<string, number>;
  holdoutStatement: string;
  v6: {
    overall: VersionCounts;
    byGroup: Record<string, VersionCounts>;
    byOwner: Record<string, VersionCounts>;
    byGoldFamily: Record<string, VersionCounts>;
  };
  v5: {
    overall: VersionCounts;
    byGroup: Record<string, VersionCounts>;
    byOwner: Record<string, VersionCounts>;
    byGoldFamily: Record<string, VersionCounts>;
  };
  changedRows: PairedRow[];
  rows: PairedRow[];
  disclosures: string[];
}

function sliceSet(): {
  overall: VersionCounts;
  byGroup: Record<string, VersionCounts>;
  byOwner: Record<string, VersionCounts>;
  byGoldFamily: Record<string, VersionCounts>;
} {
  return { overall: emptyVersionCounts(), byGroup: {}, byOwner: {}, byGoldFamily: {} };
}

function accumulateSlices(slices: ReturnType<typeof sliceSet>, row: BenchRow): void {
  accumulateVersionCounts(slices.overall, row);
  accumulateVersionCounts((slices.byGroup[row.group] ??= emptyVersionCounts()), row);
  accumulateVersionCounts((slices.byOwner[row.owner] ??= emptyVersionCounts()), row);
  accumulateVersionCounts((slices.byGoldFamily[row.goldL1] ??= emptyVersionCounts()), row);
}

export function runRecallBench(
  root: string = join(REPO_ROOT, "datasets/paddle-bench"),
): RecallBenchReport {
  const gold = loadStrokeGold(root);
  const unevaluableCases: Record<string, number> = {};
  const poseCache = new Map<string, BenchPose | null>();
  const v6Slices = sliceSet();
  const v5Slices = sliceSet();
  const rows: PairedRow[] = [];

  const classifiers: { v6: StrokeClassifier; v5: StrokeClassifier } = {
    v6: classifyStroke,
    v5: classifyStrokeV5 as StrokeClassifier,
  };

  for (const label of gold.labels) {
    if (!STROKE_BENCH_POSE_CASES[label.caseId]) {
      unevaluableCases[label.caseId] = (unevaluableCases[label.caseId] ?? 0) + 1;
      continue;
    }
    if (!poseCache.has(label.caseId)) poseCache.set(label.caseId, loadCasePose(label.caseId, root));
    const pose = poseCache.get(label.caseId)!;
    if (!pose) {
      unevaluableCases[label.caseId] = (unevaluableCases[label.caseId] ?? 0) + 1;
      continue;
    }
    const handedness = loadCaseHandedness(label.caseId, root) ?? "right";
    // Identical inputs by construction: evaluateGoldLabel rebuilds the same
    // track selection, sequence, wrist speeds, and contact reference from
    // the same pose + gold on both calls; only the classifier differs.
    const v6Row = evaluateGoldLabel(label, pose, handedness, classifiers.v6);
    const v5Row = evaluateGoldLabel(label, pose, handedness, classifiers.v5);
    accumulateSlices(v6Slices, v6Row);
    accumulateSlices(v5Slices, v5Row);
    rows.push({
      caseId: label.caseId,
      group: v6Row.group,
      owner: label.owner,
      eventStartMs: label.eventStartMs,
      goldL1: label.l1,
      goldL2: label.l2,
      v5Predicted: v5Row.predictedLabel,
      v6Predicted: v6Row.predictedLabel,
      v5L1: v5Row.l1,
      v6L1: v6Row.l1,
      v5L2: v5Row.l2,
      v6L2: v6Row.l2,
      changed:
        v5Row.predictedLabel !== v6Row.predictedLabel ||
        v5Row.l1 !== v6Row.l1 ||
        v5Row.l2 !== v6Row.l2,
      v6LimitingFactors: v6Row.limitingFactors,
      v5LimitingFactors: v5Row.limitingFactors,
    });
  }

  return {
    benchVersion: STROKE_RECALL_BENCH_VERSION,
    v6ClassifierVersion: STROKE_HEURISTIC_VERSION,
    v5ClassifierVersion: STROKE_HEURISTIC_V5_VERSION,
    v5Provenance:
      "strokeHeuristicV5Frozen.ts — byte-for-byte git show d6f951f:packages/swing-lab/src/strokeHeuristic.ts (last pre-v6 commit) plus a provenance header",
    goldLabelsTotal: gold.labels.length,
    evaluableLabels: rows.length,
    unevaluableCases,
    holdoutStatement:
      "Held-out cases wm-dink-01 and afn-vic-rally1 were never read, listed, or evaluated: they have no rows in stroke-gold.json and no committed pose in runs-wave-a.",
    v6: v6Slices,
    v5: v5Slices,
    changedRows: rows.filter((row) => row.changed),
    rows,
    disclosures: [
      "Dev-tier committed gold only; pose exists for the 8 wave-a corpus windows, so gold on afn-sasebo-rally1/2 and wm-volley-02 is not evaluable on this machine.",
      "paddle=null everywhere (no committed paddle track): contact points are wrist-derived for BOTH versions identically.",
      "Every rate is reported as counts; slice Ns are small (gold overhead_lob is single digits) — treat differences as per-row facts, not statistics.",
      "OVERHEAD-precision rows whose gold L1 is 'unknown' are indeterminate and reported in their own bucket, never counted as correct or wrong.",
      "OTHER-owned rows use heuristic window-coverage attribution (same policy for both versions) and are also reported as a separate owner slice.",
    ],
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("strokeHeuristicRecallBench.ts");
if (isMain) {
  const report = runRecallBench();
  const fmt = (counts: VersionCounts) =>
    `gold-known ${counts.applicable} · L1 ${counts.l1Correct}✓/${counts.l1Wrong}✗/${counts.l1Abstained}∅ · ` +
    `committed ${counts.committed} (silent-wrong ${counts.silentWrong}) · ` +
    `OVH recall ${counts.overheadPredicted}/${counts.overheadGold} (∅${counts.overheadAbstained} ✗${counts.overheadCommittedWrongFamily}) · ` +
    `OVH precision ${counts.overheadClaimsGoldOverhead}/${counts.overheadClaims} (gold? ${counts.overheadClaimsGoldUnknown})`;
  console.log(
    `${report.benchVersion} — ${report.evaluableLabels}/${report.goldLabelsTotal} gold labels evaluable`,
  );
  console.log(`v6: ${report.v6ClassifierVersion}`);
  console.log(`v5: ${report.v5ClassifierVersion} (${report.v5Provenance})`);
  console.log(`unevaluable (no committed pose): ${JSON.stringify(report.unevaluableCases)}`);
  console.log(`\nOVERALL v6  ${fmt(report.v6.overall)}`);
  console.log(`OVERALL v5  ${fmt(report.v5.overall)}`);
  for (const [name, slice] of Object.entries(report.v6.byGoldFamily)) {
    console.log(`FAMILY ${name.padEnd(16)} v6  ${fmt(slice)}`);
    console.log(`FAMILY ${name.padEnd(16)} v5  ${fmt(report.v5.byGoldFamily[name]!)}`);
  }
  for (const [name, slice] of Object.entries(report.v6.byOwner)) {
    console.log(`OWNER ${name.padEnd(17)} v6  ${fmt(slice)}`);
    console.log(`OWNER ${name.padEnd(17)} v5  ${fmt(report.v5.byOwner[name]!)}`);
  }
  for (const [name, slice] of Object.entries(report.v6.byGroup)) {
    console.log(`GROUP ${name.padEnd(17)} v6  ${fmt(slice)}`);
    console.log(`GROUP ${name.padEnd(17)} v5  ${fmt(report.v5.byGroup[name]!)}`);
  }
  console.log(`\nCHANGED ROWS (v5 → v6): ${report.changedRows.length}`);
  for (const row of report.changedRows) {
    console.log(
      `  ${row.caseId} @${row.eventStartMs} [${row.owner}] gold=${row.goldL1}/${row.goldL2} ` +
        `v5=${row.v5Predicted}(${row.v5L1}/${row.v5L2}) → v6=${row.v6Predicted}(${row.v6L1}/${row.v6L2})` +
        ` v6-limits=[${row.v6LimitingFactors.join(", ")}]`,
    );
  }
  console.log("\nDISCLOSURES");
  for (const disclosure of report.disclosures) console.log(`  - ${disclosure}`);

  const outDir = join(REPO_ROOT, "datasets/experiments/wave-g");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "g15-h6-recall-results.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nresults written: ${outPath}`);
}
