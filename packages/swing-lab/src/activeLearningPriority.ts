import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  classifyDimension,
} from "@pickle/capture-envelope";
import { REPO_ROOT } from "./engine/corpus.js";
import { HELD_OUT_BUNDLES } from "./labelQueueV2.js";
import type { Modality, Provenance } from "./labelQueueV2.js";
import {
  BUNDLE_SESSIONS,
  collectAuditDisagreements,
  collectCascadeFailures,
  collectFailureMine,
  collectHardSlices,
  collectMinerUncertainty,
  collectOodBoundary,
  mergeItems,
} from "./labelQueueV3.js";
import type { QueueItemV3, SignalType } from "./labelQueueV3.js";

/**
 * Active-learning prioritization over the hard-case queue
 * (Wave I, workstream i11-active-learning).
 *
 *   npx tsx src/activeLearningPriority.ts   ·   pnpm lab:al-priority
 *   → datasets/experiments/wave-i/i11-active-learning-priority.json
 *
 * The v3 queue (e23) selects WHICH items are hard, each backed by a committed
 * artifact. This layer decides WHICH HARD ITEM TO LABEL FIRST by combining the
 * v3 base signals (disagreement, uncertainty, hard slices, failure-mine, OOD
 * boundary) with four informativeness boosts, every one computed from a real,
 * committed data structure — never invented:
 *
 *   rare stroke          — committed annotatedStrokeV3 counts across the
 *                          paddle-bench annotation sidecars: fewer existing
 *                          labels for the item's stroke class ⇒ higher boost.
 *   environment novelty  — committed labeled-item counts per corpus session
 *                          (datasets/corpus/recordings.json sessionKey +
 *                          sidecar counts): sparsely-labeled sessions ⇒ boost.
 *   device novelty       — recordings.json ffprobe profile (WxH@fps/codec):
 *                          capture profiles with few recordings ⇒ boost.
 *   envelope boundary    — probe measurements classified DEGRADED by the
 *                          versioned capture-envelope thresholds: items whose
 *                          recording sits on the envelope boundary ⇒ boost.
 *
 * Target/ownership/contact ambiguity is carried by the base signals
 * themselves (D2-04 blind-audit disagreement, cascade TARGET/CONTACT stage
 * failures, D2-06 contact hard slices) and receives a dedicated boost so an
 * ambiguity-bearing item outranks an equal-base-score item without one.
 *
 * DETERMINISM: no RNG, no wall-clock in scoring; boosts are pure functions of
 * committed counts/measurements; ties broken by id ascending. Easy repetitive
 * items — common stroke, well-covered session/device, mid-envelope, no
 * ambiguity, low base signal — are deliberately ranked LAST, not dropped.
 *
 * HELD-OUT SAFETY: held-out bundles are rejected (throw) and only dev/val
 * items are eligible, exactly as in v3.
 */

export type BoostType =
  "rare_stroke" | "environment_novelty" | "device_novelty" | "envelope_boundary" | "ambiguity";

export interface Boost {
  type: BoostType;
  /** weight × normalized boost value, both documented in BOOST_WEIGHTS. */
  contribution: number;
  provenance: Provenance;
}

export const BOOST_WEIGHTS: Record<BoostType, { weight: number; provenance: Provenance }> = {
  rare_stroke: {
    weight: 0.6,
    provenance: {
      source: "datasets/paddle-bench/bundles/*/annotation/*.json",
      metric: "count of committed annotatedStrokeV3 labels for the item's stroke class",
      value: "boost = weight / (1 + labelCount); pnpm lab:data-gaps names the same scarcity",
    },
  },
  environment_novelty: {
    weight: 0.5,
    provenance: {
      source: "datasets/corpus/recordings.json + annotation sidecar counts",
      metric: "committed labeled items in the item's sessionKey",
      value: "boost = weight / (1 + sessionLabeledItemCount); new environments have no labels yet",
    },
  },
  device_novelty: {
    weight: 0.4,
    provenance: {
      source: "datasets/corpus/recordings.json probe (width/height/fps/codec)",
      metric: "recordings sharing the item's capture profile",
      value: "boost = weight / (1 + profileRecordingCount); unseen capture profiles rank up",
    },
  },
  envelope_boundary: {
    weight: 0.5,
    provenance: {
      source: `@pickle/capture-envelope ${CAPTURE_ENVELOPE_THRESHOLDS_VERSION}`,
      metric: "probe dimensions classified DEGRADED (resolution, frame_rate, clip_duration)",
      value:
        "boost = weight × min(1, degradedDimensions/2); boundary captures are exactly where the envelope must be learned",
    },
  },
  ambiguity: {
    weight: 0.5,
    provenance: {
      source: "base-signal composition (D2-04 audit, cascade stages, D2-06 contact slices)",
      metric:
        "item carries ownership/contact-modality disagreement, cascade-failure, or hard-slice signals",
      value: "boost = weight when target/ownership/contact ambiguity evidence is present, else 0",
    },
  },
};

/** All boost inputs are real, committed counts/measurements — never invented. */
export interface HardCaseFeatures {
  /** Committed annotatedStrokeV3 for the item's bundle; null when unlabeled. */
  strokeClass: string | null;
  /** Committed label count for that stroke class across all sidecars. */
  strokeLabelCount: number | null;
  /** Committed labeled items in the item's sessionKey. */
  sessionLabeledItemCount: number;
  /** `${width}x${height}@${fps}/${codec}` from recordings.json probe. */
  deviceProfileKey: string | null;
  /** Recordings sharing that capture profile. */
  deviceProfileRecordingCount: number | null;
  /** Probe dimensions classified DEGRADED by the versioned thresholds. */
  envelopeBoundaryDimensions: string[];
}

export interface PrioritizedItem extends QueueItemV3 {
  baseScore: number;
  boosts: Boost[];
  priorityScore: number;
}

export interface ActiveLearningPriorityQueue {
  version: "active-learning-priority-v1";
  workstream: "wave-i/i11-active-learning";
  extendsQueue: "datasets/experiments/wave-e/e23-label-queue-v3.json (item selection); this layer orders labeling effort within it";
  scoringFormula: "priorityScore = baseScore (Σ v3 signal weights) + Σ boost contributions; boosts are pure functions of committed counts/measurements; ties by id ascending";
  determinism: "no RNG or wall-clock in scoring; every boost quotes the committed structure it reads";
  heldOutExcluded: readonly string[];
  splitPolicy: "only dev/val items are eligible; locked_test and shadow are never queued";
  envelopeThresholdsVersion: string;
  boostWeights: Record<BoostType, { weight: number; provenance: Provenance }>;
  perSessionCap: number;
  candidateCount: number;
  items: PrioritizedItem[];
}

const AMBIGUITY_SIGNALS: readonly SignalType[] = [
  "ownership_audit_disagreement",
  "cascade_stage_failure",
  "hard_slice",
];
const AMBIGUITY_MODALITIES: readonly Modality[] = ["ownership", "contact"];

/** Pure boost computation from real features; returns only non-zero boosts. */
export function computeBoosts(item: QueueItemV3, features: HardCaseFeatures): Boost[] {
  const boosts: Boost[] = [];

  if (features.strokeClass !== null && features.strokeLabelCount !== null) {
    const w = BOOST_WEIGHTS.rare_stroke;
    boosts.push({
      type: "rare_stroke",
      contribution: w.weight / (1 + features.strokeLabelCount),
      provenance: {
        source: w.provenance.source,
        metric: `annotatedStrokeV3=${features.strokeClass}`,
        value: `${features.strokeLabelCount} committed labels`,
      },
    });
  }

  {
    const w = BOOST_WEIGHTS.environment_novelty;
    const contribution = w.weight / (1 + features.sessionLabeledItemCount);
    if (contribution > 0) {
      boosts.push({
        type: "environment_novelty",
        contribution,
        provenance: {
          source: w.provenance.source,
          metric: `sessionKey=${item.sessionKey}`,
          value: `${features.sessionLabeledItemCount} committed labeled items`,
        },
      });
    }
  }

  if (features.deviceProfileKey !== null && features.deviceProfileRecordingCount !== null) {
    const w = BOOST_WEIGHTS.device_novelty;
    boosts.push({
      type: "device_novelty",
      contribution: w.weight / (1 + features.deviceProfileRecordingCount),
      provenance: {
        source: w.provenance.source,
        metric: `profile=${features.deviceProfileKey}`,
        value: `${features.deviceProfileRecordingCount} recordings share this profile`,
      },
    });
  }

  if (features.envelopeBoundaryDimensions.length > 0) {
    const w = BOOST_WEIGHTS.envelope_boundary;
    boosts.push({
      type: "envelope_boundary",
      contribution: w.weight * Math.min(1, features.envelopeBoundaryDimensions.length / 2),
      provenance: {
        source: w.provenance.source,
        metric: `DEGRADED dimensions: ${features.envelopeBoundaryDimensions.join(", ")}`,
        value: `${features.envelopeBoundaryDimensions.length} probe dimensions on the envelope boundary`,
      },
    });
  }

  const ambiguitySignals = item.signals.filter(
    (signal) =>
      AMBIGUITY_SIGNALS.includes(signal.type) &&
      item.modalities.some((modality) => AMBIGUITY_MODALITIES.includes(modality)),
  );
  if (ambiguitySignals.length > 0) {
    const w = BOOST_WEIGHTS.ambiguity;
    boosts.push({
      type: "ambiguity",
      contribution: w.weight,
      provenance: {
        source: w.provenance.source,
        metric: `signals: ${ambiguitySignals.map((signal) => signal.type).join(", ")}`,
        value: `modalities ${item.modalities.join("+")} carry target/ownership/contact ambiguity evidence`,
      },
    });
  }

  return boosts;
}

export function scoreItem(item: QueueItemV3, features: HardCaseFeatures): PrioritizedItem {
  const boosts = computeBoosts(item, features);
  const baseScore = item.signals.reduce((sum, signal) => sum + signal.weight, 0);
  const priorityScore = baseScore + boosts.reduce((sum, boost) => sum + boost.contribution, 0);
  return { ...item, baseScore, boosts, priorityScore };
}

/**
 * Deterministic ranking: priorityScore desc, ties by id asc; per-session cap
 * for queue diversity; held-out bundles are a hard error, never a skip.
 */
export function prioritizeHardCases(
  scored: PrioritizedItem[],
  options: { perSessionCap?: number; topN?: number } = {},
): PrioritizedItem[] {
  const perSessionCap = options.perSessionCap ?? 10;
  const topN = options.topN ?? scored.length;
  for (const item of scored) {
    if ((HELD_OUT_BUNDLES as readonly string[]).includes(item.bundleId ?? "")) {
      throw new Error(`held-out bundle leaked into priority candidates: ${item.id}`);
    }
    if (item.split !== "dev" && item.split !== "val") {
      throw new Error(`non-dev/val split leaked into priority candidates: ${item.id}`);
    }
  }
  const ranked = [...scored].sort(
    (a, b) => b.priorityScore - a.priorityScore || a.id.localeCompare(b.id),
  );
  const perSession = new Map<string, number>();
  const items: PrioritizedItem[] = [];
  for (const item of ranked) {
    const used = perSession.get(item.sessionKey) ?? 0;
    if (used >= perSessionCap) continue;
    perSession.set(item.sessionKey, used + 1);
    items.push({ ...item, rank: items.length + 1 });
    if (items.length >= topN) break;
  }
  return items;
}

interface RecordingEntry {
  recordingId: string;
  sessionKey: string;
  probe: {
    durationMs: number;
    fps: number;
    width: number;
    height: number;
    videoCodec: string;
  };
}

export function deviceProfileKeyFor(probe: RecordingEntry["probe"]): string {
  return `${probe.width}x${probe.height}@${probe.fps}/${probe.videoCodec}`;
}

export function envelopeBoundaryDimensionsFor(probe: RecordingEntry["probe"]): string[] {
  const dims: Array<{ name: string; value: number }> = [
    { name: "resolution", value: Math.min(probe.width, probe.height) },
    { name: "frame_rate", value: probe.fps },
    { name: "clip_duration", value: probe.durationMs },
  ];
  return dims
    .filter(
      ({ name, value }) =>
        classifyDimension(
          value,
          CAPTURE_ENVELOPE_THRESHOLDS[name as keyof typeof CAPTURE_ENVELOPE_THRESHOLDS],
        ) === "DEGRADED",
    )
    .map(({ name }) => name);
}

/** Committed stroke-label counts across annotation sidecars (dataGaps-style). */
export function collectStrokeLabelCounts(bundlesDir: string): {
  byClass: Map<string, number>;
  byBundle: Map<string, string>;
} {
  const byClass = new Map<string, number>();
  const byBundle = new Map<string, string>();
  if (!existsSync(bundlesDir)) return { byClass, byBundle };
  for (const bundleId of readdirSync(bundlesDir).sort()) {
    const dir = join(bundlesDir, bundleId, "annotation");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      const annotation = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        annotatedStrokeV3?: string;
      };
      const stroke = annotation.annotatedStrokeV3;
      if (!stroke) continue;
      if (!byBundle.has(bundleId)) {
        byBundle.set(bundleId, stroke);
        byClass.set(stroke, (byClass.get(stroke) ?? 0) + 1);
      }
    }
  }
  return { byClass, byBundle };
}

/** Committed labeled-item counts per corpus session (sidecar files per bundle). */
export function collectSessionLabelCounts(bundlesDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!existsSync(bundlesDir)) return counts;
  for (const bundleId of readdirSync(bundlesDir).sort()) {
    const dir = join(bundlesDir, bundleId, "annotation");
    if (!existsSync(dir)) continue;
    const sidecars = readdirSync(dir).filter((name) => name.endsWith(".json")).length;
    const sessionKey = BUNDLE_SESSIONS[bundleId]?.sessionKey ?? bundleId;
    counts.set(sessionKey, (counts.get(sessionKey) ?? 0) + sidecars);
  }
  return counts;
}

export function featuresForItem(
  item: QueueItemV3,
  context: {
    strokeByBundle: Map<string, string>;
    strokeCounts: Map<string, number>;
    sessionLabelCounts: Map<string, number>;
    recordingsById: Map<string, RecordingEntry>;
    profileCounts: Map<string, number>;
  },
): HardCaseFeatures {
  const strokeClass = item.bundleId ? (context.strokeByBundle.get(item.bundleId) ?? null) : null;
  const recording = item.recordingId
    ? (context.recordingsById.get(item.recordingId) ?? null)
    : null;
  const deviceProfileKey = recording ? deviceProfileKeyFor(recording.probe) : null;
  return {
    strokeClass,
    strokeLabelCount: strokeClass !== null ? (context.strokeCounts.get(strokeClass) ?? 0) : null,
    sessionLabeledItemCount: context.sessionLabelCounts.get(item.sessionKey) ?? 0,
    deviceProfileKey,
    deviceProfileRecordingCount:
      deviceProfileKey !== null ? (context.profileCounts.get(deviceProfileKey) ?? 0) : null,
    envelopeBoundaryDimensions: recording ? envelopeBoundaryDimensionsFor(recording.probe) : [],
  };
}

export function buildPriorityQueue(
  repoRoot: string,
  options: { topN?: number; perSessionCap?: number } = {},
): ActiveLearningPriorityQueue {
  const topN = options.topN ?? 40;
  const perSessionCap = options.perSessionCap ?? 10;
  const bundlesDir = join(repoRoot, "datasets/paddle-bench/bundles");
  const candidates = mergeItems([
    ...collectAuditDisagreements(bundlesDir),
    ...collectCascadeFailures(join(repoRoot, "datasets/cascade")).items,
    ...collectMinerUncertainty(join(repoRoot, "datasets/corpus/events"), 25),
    ...collectFailureMine(join(repoRoot, "datasets/corpus/failure-queue.json"), 15),
    ...collectOodBoundary(join(repoRoot, "datasets/experiments/wave-d/d08-ood-measurements.json")),
    ...collectHardSlices(),
  ]);

  const { byClass: strokeCounts, byBundle: strokeByBundle } = collectStrokeLabelCounts(bundlesDir);
  const sessionLabelCounts = collectSessionLabelCounts(bundlesDir);
  const recordingsPath = join(repoRoot, "datasets/corpus/recordings.json");
  const recordings: RecordingEntry[] = existsSync(recordingsPath)
    ? (JSON.parse(readFileSync(recordingsPath, "utf8")) as RecordingEntry[])
    : [];
  const recordingsById = new Map(recordings.map((r) => [r.recordingId, r]));
  const profileCounts = new Map<string, number>();
  for (const recording of recordings) {
    const key = deviceProfileKeyFor(recording.probe);
    profileCounts.set(key, (profileCounts.get(key) ?? 0) + 1);
  }

  const context = {
    strokeByBundle,
    strokeCounts,
    sessionLabelCounts,
    recordingsById,
    profileCounts,
  };
  const scored = candidates.map((item) => scoreItem(item, featuresForItem(item, context)));
  const items = prioritizeHardCases(scored, { perSessionCap, topN });
  return {
    version: "active-learning-priority-v1",
    workstream: "wave-i/i11-active-learning",
    extendsQueue:
      "datasets/experiments/wave-e/e23-label-queue-v3.json (item selection); this layer orders labeling effort within it",
    scoringFormula:
      "priorityScore = baseScore (Σ v3 signal weights) + Σ boost contributions; boosts are pure functions of committed counts/measurements; ties by id ascending",
    determinism:
      "no RNG or wall-clock in scoring; every boost quotes the committed structure it reads",
    heldOutExcluded: HELD_OUT_BUNDLES,
    splitPolicy: "only dev/val items are eligible; locked_test and shadow are never queued",
    envelopeThresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
    boostWeights: BOOST_WEIGHTS,
    perSessionCap,
    candidateCount: candidates.length,
    items,
  };
}

function main(): void {
  const queue = buildPriorityQueue(REPO_ROOT);
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-i");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "i11-active-learning-priority.json");
  writeFileSync(outPath, `${JSON.stringify(queue, null, 2)}\n`);
  console.log(
    `active-learning-priority: ${queue.items.length} items (from ${queue.candidateCount} candidates) → ${outPath}`,
  );
  for (const item of queue.items.slice(0, 15)) {
    console.log(
      `#${item.rank} ${item.id} priority=${item.priorityScore.toFixed(3)} base=${item.baseScore.toFixed(3)} boosts=[${item.boosts.map((boost) => `${boost.type}:${boost.contribution.toFixed(3)}`).join(",")}]`,
    );
  }
}

if (process.argv[1]?.endsWith("activeLearningPriority.ts")) main();
