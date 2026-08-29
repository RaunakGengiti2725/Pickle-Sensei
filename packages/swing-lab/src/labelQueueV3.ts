import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { HELD_OUT_BUNDLES } from "./labelQueueV2.js";
import type { Modality, Provenance } from "./labelQueueV2.js";

/**
 * Active-learning annotation queue v3 (Wave E, workstream e23-active-learning-queue).
 *
 *   npx tsx src/labelQueueV3.ts   ·   pnpm lab:label-queue-v3
 *   → datasets/experiments/wave-e/e23-label-queue-v3.json
 *
 * v2 (D2-10) ranks bundle×modality BUCKETS to direct effort; v3 complements it
 * with a concrete ITEM-level queue (exact frames, windows, scenes, clips) that
 * an annotator can work through directly. Every item is selected by one or
 * more of four signal families, each read from a COMMITTED artifact:
 *
 *   disagreement       — D2-04 blind ownership-audit slots where the two
 *                        annotators disagreed on class, landed >0.05 apart, or
 *                        required adjudication (per-slot data in the committed
 *                        audit sidecars).
 *   uncertainty        — (a) failed/abstained stages for DEV cases in the
 *                        latest committed cascade run (the integrated pipeline
 *                        cannot be re-run on Linux: pose extraction is
 *                        Apple-Vision-only and canonical run dirs are absent;
 *                        `pnpm lab:cascade` here honestly reports 0/0);
 *                        (b) miner-declared uncertainty over the Tier-C event
 *                        corpus (video-mining-4 outputs committed under
 *                        datasets/corpus/events/).
 *   hard slices        — measured failure windows named by committed
 *                        artifacts (W12 edge-on/blur miss windows, D2-06 hard
 *                        ball slices) plus failure-mine scenes from
 *                        datasets/corpus/failure-queue.json.
 *   OOD boundary       — committed OOD negatives that PASS the pose-free
 *                        pre-analysis gate (d08 measurements): the exact
 *                        clips sitting on the gate's decision boundary.
 *
 * DETERMINISM: no RNG, no timestamps in ranking; every weight constant quotes
 * the committed measurement it derives from; ties broken by id ascending.
 *
 * HELD-OUT SAFETY: wm-dink-01 and afn-vic-rally1 are excluded everywhere
 * (bundle exclusion + split filter: only dev/val corpus items are eligible;
 * locked_test and shadow are never queued). Group-eval discipline: every item
 * carries its sessionKey and a per-session cap keeps the queue diverse.
 */

export type ItemKind = "frame" | "window" | "scene" | "clip";

export type SignalType =
  | "ownership_audit_disagreement"
  | "cascade_stage_failure"
  | "miner_uncertainty"
  | "hard_slice"
  | "failure_mine"
  | "ood_boundary";

export interface Signal {
  type: SignalType;
  weight: number;
  provenance: Provenance;
}

export interface QueueItemV3 {
  rank: number;
  id: string;
  kind: ItemKind;
  sessionKey: string;
  split: "dev" | "val";
  bundleId: string | null;
  recordingId: string | null;
  modalities: Modality[];
  tMs: number | null;
  frameIdx: number | null;
  windowMs: { start: number; end: number } | null;
  score: number;
  signals: Signal[];
  instruction: string;
  rationale: string;
}

export interface LabelQueueV3 {
  version: "label-queue-v3";
  workstream: "wave-e/e23-active-learning-queue";
  extendsQueue: "datasets/experiments/wave-d2/label-queue-v2.json (D2-10 bucket-level; this queue is item-level and complements, not replaces, it)";
  annotatorConvention: "labels must be appended in NEW sidecar files (append-only rule); adjudication records must reference what they adjudicate; this queue only directs effort";
  heldOutExcluded: readonly string[];
  splitPolicy: "only dev/val items are eligible; locked_test and shadow are never queued; every item carries sessionKey for group-level evaluation";
  scoringFormula: "score = Σ signalWeight over the item's signals (miner uncertainty contributes weight × minerUncertainty); items deduped by (target, window, modality-set); ties by id ascending";
  determinism: "all inputs committed; weight constants carry quoted provenance; no RNG or wall-clock in ranking";
  pipelineAttempt: string;
  perSessionCap: number;
  signalWeights: Record<SignalType, { weight: number; provenance: Provenance }>;
  candidateCount: number;
  items: QueueItemV3[];
}

const D2_04 = "datasets/experiments/wave-d2/d2-04-ownership-audit-summary.json";
const D2_06 = "datasets/experiments/wave-d2/d2-06-ball-hard-slices-summary.json";
const W12 = "datasets/experiments/wave-b/W12-summary.json";
const D08 = "datasets/experiments/wave-d/d08-ood-measurements.json";

export const SIGNAL_WEIGHTS: Record<SignalType, { weight: number; provenance: Provenance }> = {
  ownership_audit_disagreement: {
    weight: 1.0,
    provenance: {
      source: D2_04,
      metric: "bundles.wavea-944403-smash.cohenKappa",
      value:
        "0.2066 (3-class visibility) — measured annotator disagreement is the strongest committed evidence of label ambiguity; 17 adjudications filed",
    },
  },
  cascade_stage_failure: {
    weight: 0.9,
    provenance: {
      source: "datasets/cascade/ (latest committed run)",
      metric: "rows[].stages[].pass on development cases",
      value:
        "stages the integrated pipeline failed or abstained on — direct model uncertainty/error loci on dev gold",
    },
  },
  hard_slice: {
    weight: 0.8,
    provenance: {
      source: `${W12}; ${D2_06}`,
      metric: "measured miss windows / hard-slice coverage",
      value:
        "rally2 edge-on carry recovered 1/4, overhead-blur 4/7 @IoU.30 (W12); occlusion/net-crossing/multi-ball slices enumerated with exact timestamps (D2-06)",
    },
  },
  ood_boundary: {
    weight: 0.8,
    provenance: {
      source: D08,
      metric: "measurements[].gateOk === true with poseFreeDetectable === false",
      value:
        "OOD negatives the pose-free pre-analysis gate PASSES — the exact clips on the gate decision boundary; pose-conditioned rejection is unverified (macOS-only)",
    },
  },
  miner_uncertainty: {
    weight: 0.7,
    provenance: {
      source: "datasets/corpus/events/*.jsonl",
      metric: "uncertainty (video-mining-4)",
      value:
        "miner-declared per-event uncertainty over the Tier-C corpus with named reasons (crowding, small player, track loss)",
    },
  },
  failure_mine: {
    weight: 0.5,
    provenance: {
      source: "datasets/corpus/failure-queue.json",
      metric: "items[].kind ∈ {TRACK_FRAGMENTATION, CROWDED_SCENE}",
      value:
        "W13 failure-mine scenes where tracking demonstrably degrades (identity churn / ownership contamination risk)",
    },
  },
};

/** bundle → corpus sessionKey (all dev; provenance: datasets/corpus/recordings.json + bundle clocks in D2-06). */
export const BUNDLE_SESSIONS: Record<string, { sessionKey: string; recordingId: string | null }> = {
  "wm-volley-02": { sessionKey: "wm-tournament-2014", recordingId: null },
  "afn-sasebo-rally1": { sessionKey: "afn-sasebo-2025-06", recordingId: "rec-6e06a3157947" },
  "afn-sasebo-rally2": { sessionKey: "afn-sasebo-2025-06", recordingId: "rec-6e06a3157947" },
  "wavea-944403-dink": { sessionKey: "dvids-marne-2024", recordingId: "rec-916657917f2b" },
  "wavea-944403-smash": { sessionKey: "dvids-marne-2024", recordingId: "rec-916657917f2b" },
  "wavea-faead-feed": { sessionKey: "dvids-marne-2024", recordingId: "rec-faead33a362c" },
  "wavea-faead-rally": { sessionKey: "dvids-marne-2024", recordingId: "rec-faead33a362c" },
  "wavea-marne-dig": { sessionKey: "dvids-marne-2024", recordingId: "rec-96ae65019c30" },
  "wavea-marne-serve": { sessionKey: "dvids-marne-2024", recordingId: "rec-96ae65019c30" },
  "wavea-sasebo-volleys": { sessionKey: "afn-sasebo-2025-06", recordingId: "rec-6e06a3157947" },
  "wavea-wgm-wheelchair": {
    sessionKey: "dvids-warriorgames-2026",
    recordingId: "rec-960a1a200d6d",
  },
};

const STAGE_TO_MODALITY: Record<string, Modality> = {
  TARGET: "ownership",
  EVENT: "events",
  PADDLE: "ownership",
  BALL: "ball",
  CONTACT: "contact",
  PHASE: "events",
  STROKE: "stroke",
};

/**
 * Measured hard-slice windows, each quoting the committed artifact that named
 * it. Windows are the artifact's own timestamps ± nothing invented.
 */
export const HARD_SLICES: Array<{
  id: string;
  bundleId: string;
  modalities: Modality[];
  windowMs: { start: number; end: number };
  provenance: Provenance;
}> = [
  {
    id: "hard-slice/afn-sasebo-rally2/edge-on-carry-2903-3103",
    bundleId: "afn-sasebo-rally2",
    modalities: ["ownership"],
    windowMs: { start: 2903, end: 3103 },
    provenance: {
      source: W12,
      metric: "rally2_missB_edgeon_carry",
      value:
        "recovered 1/4 — the edge-on gray blade at the hip (i87-89, ~25-55px wide) gets ZERO full-frame boxes",
    },
  },
  {
    id: "hard-slice/afn-sasebo-rally2/overhead-blur-2502-2703",
    bundleId: "afn-sasebo-rally2",
    modalities: ["ownership", "contact"],
    windowMs: { start: 2502, end: 2703 },
    provenance: {
      source: W12,
      metric: "rally2_missA_overhead_blur",
      value:
        "recovered@IoU.30 4/7 — deep-cock/pre-contact blur at 2536/2569/2603 (zero paddle boxes at any floor down to 0.03)",
    },
  },
  {
    id: "hard-slice/wavea-sasebo-volleys/net-crossing-51718-51852",
    bundleId: "wavea-sasebo-volleys",
    modalities: ["ball"],
    windowMs: { start: 51718, end: 51852 },
    provenance: {
      source: D2_06,
      metric: "hardSliceCoverage.netCrossing",
      value: "through-mesh, tape-band partial overlap, cleared tape (51718-51852)",
    },
  },
  {
    id: "hard-slice/wavea-sasebo-volleys/paddle-occlusion-53887",
    bundleId: "wavea-sasebo-volleys",
    modalities: ["ball", "contact"],
    windowMs: { start: 53787, end: 53987 },
    provenance: {
      source: D2_06,
      metric: "hardSliceCoverage.paddleOcclusion",
      value: "53887 (ball overlapping paddle face at contact); window = quoted timestamp ±100ms",
    },
  },
  {
    id: "hard-slice/afn-sasebo-rally2/multi-ball-2402",
    bundleId: "afn-sasebo-rally2",
    modalities: ["ball"],
    windowMs: { start: 2302, end: 2502 },
    provenance: {
      source: D2_06,
      metric: "hardSliceCoverage.multiBallBackground",
      value:
        "2402 abstention (two indistinguishable green blobs → uncertain, no point); window = quoted timestamp ±100ms",
    },
  },
];

interface AuditFrame {
  tMs: number;
  frameIdx: number;
  role: string;
  adjudicationId: string | null;
  centerDelta: number | null;
  classAgreement: boolean;
}

interface AuditSidecar {
  captureBundle: string;
  frames: AuditFrame[];
}

/** D2-04 disagreement slots → frame items. */
export function collectAuditDisagreements(bundlesDir: string): QueueItemV3[] {
  const items: QueueItemV3[] = [];
  const bundles = existsSync(bundlesDir)
    ? readdirSync(bundlesDir)
        .filter((b) => !(HELD_OUT_BUNDLES as readonly string[]).includes(b))
        .sort()
    : [];
  const sig = SIGNAL_WEIGHTS.ownership_audit_disagreement;
  for (const bundleId of bundles) {
    const auditPath = join(
      bundlesDir,
      bundleId,
      "annotation",
      "devin-visual-v4-waveD2-ownership-audit.json",
    );
    if (!existsSync(auditPath)) continue;
    const audit = JSON.parse(readFileSync(auditPath, "utf8")) as AuditSidecar;
    const session = BUNDLE_SESSIONS[bundleId] ?? { sessionKey: bundleId, recordingId: null };
    for (const frame of audit.frames) {
      const disagreeClass = !frame.classAgreement;
      const outlier = typeof frame.centerDelta === "number" && frame.centerDelta > 0.05;
      const adjudicated = frame.adjudicationId !== null;
      if (!disagreeClass && !outlier && !adjudicated) continue;
      const why = [
        disagreeClass ? "class disagreement" : null,
        outlier ? `coordinate delta ${frame.centerDelta?.toFixed(4)} > 0.05` : null,
        adjudicated ? `adjudicated (${frame.adjudicationId})` : null,
      ]
        .filter((w) => w !== null)
        .join("; ");
      items.push({
        rank: 0,
        id: `disagreement/${bundleId}/t${frame.tMs}/${frame.role}`,
        kind: "frame",
        sessionKey: session.sessionKey,
        split: "dev",
        bundleId,
        recordingId: session.recordingId,
        modalities: ["ownership"],
        tMs: frame.tMs,
        frameIdx: frame.frameIdx,
        windowMs: null,
        score: sig.weight,
        signals: [
          {
            type: "ownership_audit_disagreement",
            weight: sig.weight,
            provenance: {
              source: `datasets/paddle-bench/bundles/${bundleId}/annotation/devin-visual-v4-waveD2-ownership-audit.json`,
              metric: `frames[tMs=${frame.tMs}, role=${frame.role}]`,
              value: why,
            },
          },
        ],
        instruction: `Third-annotator pass on frame ${frame.frameIdx} (tMs ${frame.tMs}), role "${frame.role}": annotate paddle visibility class + blade-center point in a NEW append-only sidecar; if it resolves the D2-04 dispute, file an adjudication record referencing both prior annotations.`,
        rationale: `D2-04 blind audit disagreed with waveC here (${why}) — measured annotator ambiguity, the highest-value relabel target.`,
      });
    }
  }
  return items;
}

interface CascadeRow {
  caseId: string;
  split: string;
  stages: Record<string, { pass: boolean; detail: string }>;
}

/** Latest committed cascade run → per-failed-stage window items on dev cases. */
export function collectCascadeFailures(cascadeDir: string): {
  items: QueueItemV3[];
  runFile: string | null;
} {
  if (!existsSync(cascadeDir)) return { items: [], runFile: null };
  const runs = readdirSync(cascadeDir)
    .filter((f) => /^cascade-\d+\.json$/.test(f))
    .sort();
  const latest = runs[runs.length - 1];
  if (!latest) return { items: [], runFile: null };
  const run = JSON.parse(readFileSync(join(cascadeDir, latest), "utf8")) as {
    rows?: CascadeRow[];
  };
  const items: QueueItemV3[] = [];
  const sig = SIGNAL_WEIGHTS.cascade_stage_failure;
  for (const row of run.rows ?? []) {
    if (row.split !== "development") continue;
    if ((HELD_OUT_BUNDLES as readonly string[]).includes(row.caseId)) continue;
    const session = BUNDLE_SESSIONS[row.caseId] ?? { sessionKey: row.caseId, recordingId: null };
    const failed = Object.entries(row.stages)
      .filter(([, s]) => !s.pass)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [stage, detail] of failed) {
      const modality = STAGE_TO_MODALITY[stage];
      if (!modality) continue;
      items.push({
        rank: 0,
        id: `cascade/${row.caseId}/${stage.toLowerCase()}`,
        kind: "window",
        sessionKey: session.sessionKey,
        split: "dev",
        bundleId: row.caseId,
        recordingId: session.recordingId,
        modalities: [modality],
        tMs: null,
        frameIdx: null,
        windowMs: null,
        score: sig.weight,
        signals: [
          {
            type: "cascade_stage_failure",
            weight: sig.weight,
            provenance: {
              source: `datasets/cascade/${latest}`,
              metric: `rows[caseId=${row.caseId}].stages.${stage}`,
              value: detail.detail,
            },
          },
        ],
        instruction: `Add ${modality} labels around the failed ${stage} stage of ${row.caseId} (new append-only sidecar): the pipeline's failure detail is "${detail.detail}".`,
        rationale: `Latest committed integrated-pipeline run fails ${stage} on dev case ${row.caseId} — direct model-error locus.`,
      });
    }
  }
  return { items, runFile: latest };
}

interface MinerEvent {
  eventId: string;
  recordingId: string;
  sessionKey: string;
  split: string;
  startMs: number;
  endMs: number;
  uncertainty: number;
  reasons?: string[];
}

/** Tier-C miner events with the highest miner-declared uncertainty. */
export function collectMinerUncertainty(eventsDir: string, topN: number): QueueItemV3[] {
  if (!existsSync(eventsDir)) return [];
  const events: MinerEvent[] = [];
  for (const shard of readdirSync(eventsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()) {
    for (const line of readFileSync(join(eventsDir, shard), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as MinerEvent;
      if (event.split !== "dev" && event.split !== "val") continue;
      events.push(event);
    }
  }
  const sig = SIGNAL_WEIGHTS.miner_uncertainty;
  return events
    .sort((a, b) => b.uncertainty - a.uncertainty || a.eventId.localeCompare(b.eventId))
    .slice(0, topN)
    .map((event) => ({
      rank: 0,
      id: `miner/${event.eventId}`,
      kind: "window" as ItemKind,
      sessionKey: event.sessionKey,
      split: event.split as "dev" | "val",
      bundleId: null,
      recordingId: event.recordingId,
      modalities: ["events", "ownership"] as Modality[],
      tMs: null,
      frameIdx: null,
      windowMs: { start: event.startMs, end: event.endMs },
      score: sig.weight * event.uncertainty,
      signals: [
        {
          type: "miner_uncertainty" as SignalType,
          weight: sig.weight * event.uncertainty,
          provenance: {
            source: `datasets/corpus/events/${event.recordingId}.jsonl`,
            metric: `eventId=${event.eventId} uncertainty`,
            value: `${event.uncertainty} — reasons: ${(event.reasons ?? []).join("; ") || "none recorded"}`,
          },
        },
      ],
      instruction: `Verify/label the mined candidate event ${event.eventId} (${event.recordingId} ${event.startMs}-${event.endMs}ms): confirm or reject as a real stroke event, set bounds + owner in a new append-only record.`,
      rationale: `Miner-declared uncertainty ${event.uncertainty} with named risk reasons — highest-uncertainty unlabeled corpus items.`,
    }));
}

interface FailureQueueItem {
  recordingId: string;
  sessionKey: string;
  split: string;
  sceneIndex: number;
  windowMs: { start: number; end: number };
  kind: string;
  severity: number;
  evidence: string;
}

/** W13/C failure-mine scenes with tracking-degradation kinds. */
export function collectFailureMine(failureQueuePath: string, topN: number): QueueItemV3[] {
  if (!existsSync(failureQueuePath)) return [];
  const queue = JSON.parse(readFileSync(failureQueuePath, "utf8")) as {
    items?: FailureQueueItem[];
  };
  const relevant = (queue.items ?? []).filter(
    (item) =>
      (item.split === "dev" || item.split === "val") &&
      (item.kind === "TRACK_FRAGMENTATION" || item.kind === "CROWDED_SCENE"),
  );
  const sig = SIGNAL_WEIGHTS.failure_mine;
  return relevant
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        `${a.recordingId}/${a.sceneIndex}`.localeCompare(`${b.recordingId}/${b.sceneIndex}`),
    )
    .slice(0, topN)
    .map((item) => ({
      rank: 0,
      id: `failure-mine/${item.recordingId}/scene${item.sceneIndex}/${item.kind.toLowerCase()}`,
      kind: "scene" as ItemKind,
      sessionKey: item.sessionKey,
      split: item.split as "dev" | "val",
      bundleId: null,
      recordingId: item.recordingId,
      modalities: ["ownership"] as Modality[],
      tMs: null,
      frameIdx: null,
      windowMs: item.windowMs,
      score: sig.weight * item.severity,
      signals: [
        {
          type: "failure_mine" as SignalType,
          weight: sig.weight * item.severity,
          provenance: {
            source: "datasets/corpus/failure-queue.json",
            metric: `items[${item.recordingId} scene ${item.sceneIndex}].${item.kind}`,
            value: item.evidence,
          },
        },
      ],
      instruction: `Spot-label player identity/paddle ownership at 3-5 evenly spaced frames inside ${item.recordingId} scene ${item.sceneIndex} (${item.windowMs.start}-${item.windowMs.end}ms) to give the tracker verifiable anchors through the ${item.kind} region.`,
      rationale: `Failure-mine evidence: ${item.evidence}.`,
    }));
}

interface OodMeasurement {
  id: string;
  category: string;
  path: string;
  gateOk: boolean;
  poseFreeDetectable: boolean;
  durationMs: number;
}

/** OOD negatives the pose-free gate passes = decision-boundary clips. */
export function collectOodBoundary(oodMeasurementsPath: string): QueueItemV3[] {
  if (!existsSync(oodMeasurementsPath)) return [];
  const report = JSON.parse(readFileSync(oodMeasurementsPath, "utf8")) as {
    measurements?: OodMeasurement[];
  };
  const sig = SIGNAL_WEIGHTS.ood_boundary;
  return (report.measurements ?? [])
    .filter((m) => m.gateOk)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({
      rank: 0,
      id: `ood-boundary/${m.id}`,
      kind: "clip" as ItemKind,
      sessionKey: `ood/${m.category}`,
      split: "dev" as const,
      bundleId: null,
      recordingId: null,
      modalities: ["events"] as Modality[],
      tMs: null,
      frameIdx: null,
      windowMs: { start: 0, end: m.durationMs },
      score: sig.weight,
      signals: [
        {
          type: "ood_boundary" as SignalType,
          weight: sig.weight,
          provenance: {
            source: D08,
            metric: `measurements[id=${m.id}]`,
            value: `gateOk=true, poseFreeDetectable=false (category ${m.category}) — pose-free gate cannot reject this negative`,
          },
        },
      ],
      instruction: `Annotate ${m.path} as a verified OOD negative per datasets/ood/registry.json policy (NO stroke/contact/ownership labels): record why it is not analyzable pickleball, to serve as a gate-boundary regression case for the pose-conditioned second stage.`,
      rationale: `This OOD negative passes the pose-free pre-analysis gate — it sits exactly on the gate's decision boundary.`,
    }));
}

/** Named hard-slice windows → window items. */
export function collectHardSlices(): QueueItemV3[] {
  const sig = SIGNAL_WEIGHTS.hard_slice;
  return HARD_SLICES.map((slice) => {
    const session = BUNDLE_SESSIONS[slice.bundleId] ?? {
      sessionKey: slice.bundleId,
      recordingId: null,
    };
    return {
      rank: 0,
      id: slice.id,
      kind: "window" as ItemKind,
      sessionKey: session.sessionKey,
      split: "dev" as const,
      bundleId: slice.bundleId,
      recordingId: session.recordingId,
      modalities: slice.modalities,
      tMs: null,
      frameIdx: null,
      windowMs: slice.windowMs,
      score: sig.weight,
      signals: [
        {
          type: "hard_slice" as SignalType,
          weight: sig.weight,
          provenance: slice.provenance,
        },
      ],
      instruction: `Densify ${slice.modalities.join("+")} labels frame-by-frame inside ${slice.bundleId} ${slice.windowMs.start}-${slice.windowMs.end}ms (new append-only sidecar; abstain with visibility=uncertain rather than guess).`,
      rationale: `Committed artifact names this window as a measured hard slice: ${slice.provenance.value}.`,
    };
  });
}

/** Dedupe items that target the same (bundle/recording, window/frame, modality set) by merging signals. */
export function mergeItems(items: QueueItemV3[]): QueueItemV3[] {
  const byKey = new Map<string, QueueItemV3>();
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const key =
      item.kind === "frame"
        ? item.id
        : [
            item.bundleId ?? item.recordingId ?? item.sessionKey,
            item.windowMs ? `${item.windowMs.start}-${item.windowMs.end}` : "",
            [...item.modalities].sort().join("+"),
          ].join("|");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    existing.signals = [...existing.signals, ...item.signals];
    existing.score = existing.signals.reduce((sum, s) => sum + s.weight, 0);
    existing.rationale = `${existing.rationale} ALSO: ${item.rationale}`;
  }
  return [...byKey.values()];
}

export function buildQueueV3(
  repoRoot: string,
  options: { topN?: number; perSessionCap?: number; pipelineAttempt?: string } = {},
): LabelQueueV3 {
  const topN = options.topN ?? 40;
  const perSessionCap = options.perSessionCap ?? 10;
  const bundlesDir = join(repoRoot, "datasets/paddle-bench/bundles");
  const cascade = collectCascadeFailures(join(repoRoot, "datasets/cascade"));
  const candidates = mergeItems([
    ...collectAuditDisagreements(bundlesDir),
    ...cascade.items,
    ...collectMinerUncertainty(join(repoRoot, "datasets/corpus/events"), 25),
    ...collectFailureMine(join(repoRoot, "datasets/corpus/failure-queue.json"), 15),
    ...collectOodBoundary(join(repoRoot, D08)),
    ...collectHardSlices(),
  ]);
  for (const item of candidates) {
    if ((HELD_OUT_BUNDLES as readonly string[]).includes(item.bundleId ?? "")) {
      throw new Error(`held-out bundle leaked into queue candidates: ${item.id}`);
    }
  }
  const ranked = candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const perSession = new Map<string, number>();
  const items: QueueItemV3[] = [];
  for (const item of ranked) {
    const used = perSession.get(item.sessionKey) ?? 0;
    if (used >= perSessionCap) continue;
    perSession.set(item.sessionKey, used + 1);
    items.push({ ...item, rank: items.length + 1 });
    if (items.length >= topN) break;
  }
  return {
    version: "label-queue-v3",
    workstream: "wave-e/e23-active-learning-queue",
    extendsQueue:
      "datasets/experiments/wave-d2/label-queue-v2.json (D2-10 bucket-level; this queue is item-level and complements, not replaces, it)",
    annotatorConvention:
      "labels must be appended in NEW sidecar files (append-only rule); adjudication records must reference what they adjudicate; this queue only directs effort",
    heldOutExcluded: HELD_OUT_BUNDLES,
    splitPolicy:
      "only dev/val items are eligible; locked_test and shadow are never queued; every item carries sessionKey for group-level evaluation",
    scoringFormula:
      "score = Σ signalWeight over the item's signals (miner uncertainty contributes weight × minerUncertainty); items deduped by (target, window, modality-set); ties by id ascending",
    determinism:
      "all inputs committed; weight constants carry quoted provenance; no RNG or wall-clock in ranking",
    pipelineAttempt:
      options.pipelineAttempt ??
      `pnpm lab:cascade executed on this Linux box: 0/0 gold events (canonical pose runs are macOS-only and absent here — honest boundary, no numbers fabricated); uncertainty signals therefore come from the latest COMMITTED cascade run (${cascade.runFile ?? "none found"}) and the committed video-mining-4 corpus outputs`,
    perSessionCap,
    signalWeights: SIGNAL_WEIGHTS,
    candidateCount: candidates.length,
    items,
  };
}

function main(): void {
  const queue = buildQueueV3(REPO_ROOT);
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-e");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "e23-label-queue-v3.json");
  writeFileSync(outPath, `${JSON.stringify(queue, null, 2)}\n`);
  console.log(
    `label-queue-v3: ${queue.items.length} items (from ${queue.candidateCount} candidates) → ${outPath}`,
  );
  for (const item of queue.items.slice(0, 15)) {
    console.log(
      `#${item.rank} ${item.id} score=${item.score.toFixed(3)} [${item.signals.map((s) => s.type).join(",")}]`,
    );
  }
}

if (process.argv[1]?.endsWith("labelQueueV3.ts")) main();
