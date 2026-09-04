import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { loadHeldOutCaseIds } from "./holdoutRotation.js";

/**
 * Active-learning label queue v2 (Wave D2, workstream D2-10).
 *
 *   npx tsx src/labelQueueV2.ts   ·   pnpm lab:label-queue
 *   → datasets/experiments/wave-d2/label-queue-v2.json
 *
 * Ranks the top-30 most valuable NEXT labels across modalities
 * (ownership, contact, ball, events, stroke) by
 *
 *   score = bucketThinness × measuredFailureImpact × slice boosts ÷ acquisitionCost
 *
 * DETERMINISM: every score input is read from a COMMITTED artifact
 * (bundle annotation files, wave-a/b/c experiment summaries, the cascade
 * waterfall experiment) or is a documented constant in this file whose
 * provenance quotes the committed artifact it was derived from. No RNG,
 * no timestamps in the ranking, stable tie-breaks (score desc, then id asc).
 *
 * HELD-OUT SAFETY: every case the holdout ledger holds out (retired holdouts
 * and designated SHADOW_HOLDOUT / LOCKED_TEST successors, see
 * datasets/holdouts/ledger.json) is excluded from candidate generation
 * entirely — the queue must never direct labeling effort at them
 * (HANDOFF_V3 rule 17: held-out iteration is forbidden). The list is derived
 * from the ledger at load time, never hand-copied; a missing or malformed
 * ledger fails the import (HoldoutLedgerError) rather than queueing blind.
 */

export const HELD_OUT_BUNDLES: readonly string[] = Object.freeze(
  [...loadHeldOutCaseIds(REPO_ROOT).all].sort(),
);

export type Modality = "ownership" | "contact" | "ball" | "events" | "stroke";

export interface Provenance {
  source: string;
  metric: string;
  value: number | string;
}

export interface ModalityImpact {
  modality: Modality;
  /** 0..1 relative measured-failure impact weight. */
  impact: number;
  provenance: Provenance[];
}

export interface AcquisitionCost {
  modality: Modality;
  /** Relative frames-to-view / verification effort per label (≥1). */
  cost: number;
  rationale: string;
}

export interface SliceBoost {
  id: string;
  bundleId: string;
  modality: Modality;
  multiplier: number;
  provenance: Provenance;
}

export interface BundleModalityCount {
  bundleId: string;
  modality: Modality;
  labelCount: number;
  sourceFiles: string[];
}

export interface QueueItem {
  rank: number;
  id: string;
  bundleId: string;
  modality: Modality;
  score: number;
  bucketThinness: number;
  labelCount: number;
  impact: number;
  acquisitionCost: number;
  boosts: SliceBoost[];
  reasoning: string;
  scoreInputs: {
    thinness: { formula: string; labelCount: number; countSources: string[] };
    impact: ModalityImpact;
    cost: AcquisitionCost;
    boosts: SliceBoost[];
  };
}

const CASCADE = "datasets/experiments/EXP-2026-08-28-cascade-waterfall.json";
const HANDOFF = "docs/HANDOFF_V3.md";
const W12 = "datasets/experiments/wave-b/W12-summary.json";
const C04 = "datasets/experiments/wave-c/c04-ball-gold-summary.json";
const C18 = "datasets/experiments/wave-c/c18-stroke-taxonomy-labels-summary.json";

/**
 * Measured failure impact per modality. Each weight is justified only by the
 * quoted committed measurement — change a weight only with a new measurement.
 */
export const MODALITY_IMPACTS: ModalityImpact[] = [
  {
    modality: "contact",
    impact: 1.0,
    provenance: [
      { source: CASCADE, metric: "results.conditionalSurvival.CONTACT", value: "2/5" },
      {
        source: HANDOFF,
        metric: "rule 17",
        value:
          "Held-out contact/stroke misses (dink 250ms, vic 245ms/BACKHAND) are DATA problems. Fix via new dev labels",
      },
    ],
  },
  {
    modality: "events",
    impact: 0.9,
    provenance: [
      {
        source: HANDOFF,
        metric: "§6 NEXT BOTTLENECKS #1",
        value: "EVENT disambiguation — the only stage that didn't move (3/5)",
      },
      {
        source: CASCADE,
        metric: "results.verdict (rally1)",
        value: "EVENT SELECTION picked a 0%-overlap window (paddle-speed proposal defect)",
      },
    ],
  },
  {
    modality: "stroke",
    impact: 0.8,
    provenance: [
      { source: CASCADE, metric: "results.conditionalSurvival.STROKE", value: "1/5" },
      { source: C18, metric: "measured.l3Known / measured.goldLabels", value: "8/22" },
    ],
  },
  {
    modality: "ball",
    impact: 0.7,
    provenance: [
      {
        source: CASCADE,
        metric: "results.verdict (rally2)",
        value:
          "ball untracked (BALL_BODY_OVERLAP) though contact still landed 62ms via paddle-only",
      },
      { source: C04, metric: "exactNumbers.occlusionAdjacentLabels", value: 8 },
    ],
  },
  {
    modality: "ownership",
    impact: 0.6,
    provenance: [
      {
        source: HANDOFF,
        metric: "§3 DATA / TRUTH",
        value: "wrong-player 4/41 — all one dink edge-on episode; edge-on/blur S0 blindness",
      },
      {
        source: W12,
        metric: "baseline.rally2_missA_overhead_blur",
        value: "recovered@IoU.30 4/7 — the S0 hole is the deep-cock/pre-contact window",
      },
    ],
  },
];

/**
 * Relative acquisition cost per label (frames that must actually be viewed
 * per the absolute-CFR extraction rule; no interpolation allowed).
 */
export const ACQUISITION_COSTS: AcquisitionCost[] = [
  {
    modality: "ball",
    cost: 1,
    rationale: "one extracted frame, one center point (or occluded state) per label",
  },
  {
    modality: "ownership",
    cost: 1.5,
    rationale:
      "one extracted frame but two boxes (target + other paddle) per dual-label convention",
  },
  {
    modality: "stroke",
    cost: 3,
    rationale: "whole-event review across its frames to assign L1/L2/L3 taxonomy with abstention",
  },
  {
    modality: "contact",
    cost: 4,
    rationale:
      "frame-stepping a window to the smallest visually defensible 1-2 frame contact window (C05 method)",
  },
  {
    modality: "events",
    cost: 6,
    rationale:
      "start/contact/end bounds + owner require scanning the full stroke neighborhood frame-by-frame",
  },
];

/**
 * Slice boosts: a bundle×modality bucket named by a committed artifact as a
 * measured failure locus gets a multiplier, with the naming evidence quoted.
 */
export const SLICE_BOOSTS: SliceBoost[] = [
  {
    id: "rally1-event-zero-support",
    bundleId: "afn-sasebo-rally1",
    modality: "events",
    multiplier: 2,
    provenance: {
      source: HANDOFF,
      metric: "§2 named losses (afn-sasebo-rally1)",
      value:
        "gold 2900 has zero tracked support in any modality — perception coverage problem, not fusion",
    },
  },
  {
    id: "rally1-ball-zero-support",
    bundleId: "afn-sasebo-rally1",
    modality: "ball",
    multiplier: 2,
    provenance: {
      source: HANDOFF,
      metric: "§6 NEXT BOTTLENECKS #2",
      value:
        "grow dev contact labels from the new event corpus (rally2-style raw-ball-candidate tracking: A found strong candidates near gold rejected by ball gates)",
    },
  },
  {
    id: "rally1-contact-anchor",
    bundleId: "afn-sasebo-rally1",
    modality: "contact",
    multiplier: 2,
    provenance: {
      source: CASCADE,
      metric: "results.verdict (rally1)",
      value: "rally1 → EVENT SELECTION picked a 0%-overlap window; poisons contact/phase/stroke",
    },
  },
  {
    id: "rally2-ownership-edge-on",
    bundleId: "afn-sasebo-rally2",
    modality: "ownership",
    multiplier: 2,
    provenance: {
      source: W12,
      metric: "status",
      value:
        "afn-sasebo-rally2 (DEV) miss windows dense (i75-81 @2502-2703, i87-93 @2903-3103) — overhead-blur + edge-on carry",
    },
  },
  {
    id: "rally2-ball-body-overlap",
    bundleId: "afn-sasebo-rally2",
    modality: "ball",
    multiplier: 2,
    provenance: {
      source: CASCADE,
      metric: "results.verdict (rally2)",
      value: "rally2 → ball untracked (BALL_BODY_OVERLAP)",
    },
  },
  {
    id: "dink-family-contact-anchors",
    bundleId: "wavea-944403-dink",
    modality: "contact",
    multiplier: 1.5,
    provenance: {
      source: HANDOFF,
      metric: "§6 NEXT BOTTLENECKS #2",
      value:
        "teach v4's priors per family from >3 anchors (held-out dink contact 250ms is a DATA problem)",
    },
  },
  {
    id: "faead-rally-ball-occlusion",
    bundleId: "wavea-faead-rally",
    modality: "ball",
    multiplier: 1.5,
    provenance: {
      source: C04,
      metric: "exactNumbers.occlusionSequences",
      value: "body occlusion sequence wavea-faead-rally 13458-13583ms",
    },
  },
];

interface AnnotationFile {
  eventLabels?: Array<{ contactMs?: number | null }>;
  ballFrames?: unknown[];
  paddleFrames?: unknown[];
  otherPaddleFrames?: unknown[];
  annotatedStrokeV3?: string | null;
}

/** Count committed labels per bundle×modality from the annotation sidecars. */
export function countBundleLabels(bundlesDir: string): BundleModalityCount[] {
  const counts: BundleModalityCount[] = [];
  const bundles = existsSync(bundlesDir)
    ? readdirSync(bundlesDir)
        .filter((b) => !HELD_OUT_BUNDLES.includes(b))
        .sort()
    : [];
  for (const bundleId of bundles) {
    const annotationDir = join(bundlesDir, bundleId, "annotation");
    if (!existsSync(annotationDir)) continue;
    const files = readdirSync(annotationDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const perModality: Record<Modality, number> = {
      ownership: 0,
      contact: 0,
      ball: 0,
      events: 0,
      stroke: 0,
    };
    const sourceFiles: string[] = [];
    for (const file of files) {
      sourceFiles.push(join("datasets/paddle-bench/bundles", bundleId, "annotation", file));
      const annotation = JSON.parse(
        readFileSync(join(annotationDir, file), "utf8"),
      ) as AnnotationFile;
      const events = annotation.eventLabels ?? [];
      perModality.events += events.length;
      perModality.contact += events.filter((e) => typeof e.contactMs === "number").length;
      perModality.ball += (annotation.ballFrames ?? []).length;
      perModality.ownership +=
        (annotation.paddleFrames ?? []).length + (annotation.otherPaddleFrames ?? []).length;
      perModality.stroke += annotation.annotatedStrokeV3 ? 1 : 0;
    }
    for (const modality of Object.keys(perModality).sort() as Modality[]) {
      counts.push({ bundleId, modality, labelCount: perModality[modality], sourceFiles });
    }
  }
  return counts;
}

/** Thinner buckets are worth more: 1 / (1 + committed label count). */
export function bucketThinness(labelCount: number): number {
  return 1 / (1 + labelCount);
}

export function scoreBucket(
  count: BundleModalityCount,
  impacts: ModalityImpact[],
  costs: AcquisitionCost[],
  boosts: SliceBoost[],
): QueueItem {
  const impact = impacts.find((i) => i.modality === count.modality);
  const cost = costs.find((c) => c.modality === count.modality);
  if (!impact || !cost)
    throw new Error(`missing impact/cost table entry for modality ${count.modality}`);
  const applicableBoosts = boosts
    .filter((b) => b.bundleId === count.bundleId && b.modality === count.modality)
    .sort((a, b) => a.id.localeCompare(b.id));
  const boostMultiplier = applicableBoosts.reduce((product, b) => product * b.multiplier, 1);
  const thinness = bucketThinness(count.labelCount);
  const score = (thinness * impact.impact * boostMultiplier) / cost.cost;
  const boostText = applicableBoosts.length
    ? ` Boosted ×${boostMultiplier} by measured failure loci: ${applicableBoosts
        .map((b) => `${b.provenance.value} [${b.provenance.source}]`)
        .join("; ")}.`
    : "";
  return {
    rank: 0,
    id: `${count.bundleId}/${count.modality}`,
    bundleId: count.bundleId,
    modality: count.modality,
    score,
    bucketThinness: thinness,
    labelCount: count.labelCount,
    impact: impact.impact,
    acquisitionCost: cost.cost,
    boosts: applicableBoosts,
    reasoning:
      `${count.bundleId} has ${count.labelCount} committed ${count.modality} label(s) ` +
      `(thinness ${thinness.toFixed(3)}) × modality failure impact ${impact.impact} ` +
      `(${impact.provenance.map((p) => `${p.metric}=${p.value} [${p.source}]`).join("; ")}) ` +
      `÷ acquisition cost ${cost.cost} (${cost.rationale}).${boostText}`,
    scoreInputs: {
      thinness: {
        formula: "1 / (1 + labelCount)",
        labelCount: count.labelCount,
        countSources: count.sourceFiles,
      },
      impact,
      cost,
      boosts: applicableBoosts,
    },
  };
}

export interface LabelQueueV2 {
  version: "label-queue-v2";
  workstream: "D2-10";
  annotatorConvention: "next labels must be appended in NEW sidecar files (append-only rule); this queue only directs effort";
  heldOutExcluded: readonly string[];
  scoringFormula: "score = (1/(1+labelCount)) × modalityImpact × sliceBoosts ÷ acquisitionCost";
  determinism: "all inputs committed; constants carry quoted provenance; ties broken by id ascending";
  modalityImpacts: ModalityImpact[];
  acquisitionCosts: AcquisitionCost[];
  sliceBoosts: SliceBoost[];
  items: QueueItem[];
}

export function buildQueue(bundlesDir: string, topN = 30): LabelQueueV2 {
  const counts = countBundleLabels(bundlesDir);
  const items = counts
    .map((count) => scoreBucket(count, MODALITY_IMPACTS, ACQUISITION_COSTS, SLICE_BOOSTS))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, topN)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  return {
    version: "label-queue-v2",
    workstream: "D2-10",
    annotatorConvention:
      "next labels must be appended in NEW sidecar files (append-only rule); this queue only directs effort",
    heldOutExcluded: HELD_OUT_BUNDLES,
    scoringFormula: "score = (1/(1+labelCount)) × modalityImpact × sliceBoosts ÷ acquisitionCost",
    determinism:
      "all inputs committed; constants carry quoted provenance; ties broken by id ascending",
    modalityImpacts: MODALITY_IMPACTS,
    acquisitionCosts: ACQUISITION_COSTS,
    sliceBoosts: SLICE_BOOSTS,
    items,
  };
}

function main(): void {
  const bundlesDir = join(REPO_ROOT, "datasets/paddle-bench/bundles");
  const queue = buildQueue(bundlesDir);
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-d2");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "label-queue-v2.json");
  writeFileSync(outPath, `${JSON.stringify(queue, null, 2)}\n`);
  console.log(`label-queue-v2: ${queue.items.length} items → ${outPath}`);
  for (const item of queue.items.slice(0, 10)) {
    console.log(`#${item.rank} ${item.id} score=${item.score.toFixed(4)} (n=${item.labelCount})`);
  }
}

if (process.argv[1]?.endsWith("labelQueueV2.ts")) main();
