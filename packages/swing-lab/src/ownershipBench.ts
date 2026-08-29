import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { TRACKER_GATES } from "./paddleTracker.js";
import {
  buildPlayerTracks,
  otherPlayersWrists,
  type PeopleFile,
  type PlayerFrame,
} from "./playerTracker.js";
import type { SwingAnnotation } from "./annotationSchema.js";

/**
 * OWNERSHIP BENCH (wave-D D02) — frame-level paddle-ownership evaluation that
 * runs ENTIRELY off committed data, so it works on Linux where canonical run
 * dirs and Apple-Vision pose extraction are absent.
 *
 *   pnpm --filter @pickle/swing-lab own:bench            # dev groups only
 *   pnpm --filter @pickle/swing-lab own:bench --include-held-out
 *
 * Evaluation unit: a DUAL FRAME — one labeled timestamp holding ≥1 visible
 * TARGET paddle point and ≥1 visible OTHER paddle point, aggregated across
 * all annotator passes in bundles/<case>/annotation/*.json (append-only gold).
 * The task: given all labeled paddle points of a frame as candidates, pick
 * the target's paddle. Wrong pick = the wrong-player failure S3 exists to
 * prevent. Grouping is BY SOURCE SESSION, never a random frame split.
 *
 * Data reality (disclosed in every report):
 *  - Pose (wrists/torso) is committed ONLY for the wave-a windowed corpus
 *    runs (datasets/paddle-bench/runs-wave-a/<case>/people.json). The five
 *    original bench cases have NO committed pose, so wrist/geometry methods
 *    honestly ABSTAIN there and only labels-only methods produce picks.
 *  - The incumbent S3 heuristic is wrist-ratio-based (TRACKER_GATES.
 *    otherOwnershipFactor); it can only be replayed where pose exists.
 *  - Box geometry (pixel boxes, detector scores) exists only for frames
 *    still present in ownership-review/queue.json.
 *  - Error buckets come from the ownership-review sidecar notes (committed,
 *    human-written at labeling time) plus candidate multiplicity.
 */

export const OWNERSHIP_BENCH_VERSION = "ownership-bench-v1";

const PB = join(REPO_ROOT, "datasets/paddle-bench");

// ── case registry: source-session groups + split discipline ──────────────

export interface OwnershipCaseInfo {
  group: string;
  split: "dev" | "held_out";
  /** Committed windowed people.json (wave-a corpus slices), when present. */
  poseRunDir?: string;
}

/** Source-session grouping (sessionKey from datasets/paddle-bench/registry.json
 *  and corpus recordings). wm-dink-01 / afn-vic-rally1 are the held-out cases
 *  named in HANDOFF_V3 — never iterate against them. */
export const OWNERSHIP_CASES: Record<string, OwnershipCaseInfo> = {
  "wm-dink-01": { group: "wm-tournament-2014", split: "held_out" },
  "wm-volley-02": { group: "wm-tournament-2014", split: "dev" },
  "afn-sasebo-rally1": { group: "afn-sasebo-2025-06", split: "dev" },
  "afn-sasebo-rally2": { group: "afn-sasebo-2025-06", split: "dev" },
  "afn-vic-rally1": { group: "afn-vic-2025", split: "held_out" },
  "wavea-944403-dink": {
    group: "dvids-944403",
    split: "dev",
    poseRunDir: "runs-wave-a/wavea-944403-dink",
  },
  "wavea-944403-smash": {
    group: "dvids-944403",
    split: "dev",
    poseRunDir: "runs-wave-a/wavea-944403-smash",
  },
  "wavea-faead-feed": {
    group: "dvids-faead",
    split: "dev",
    poseRunDir: "runs-wave-a/wavea-faead-feed",
  },
  "wavea-faead-rally": {
    group: "dvids-faead",
    split: "dev",
    poseRunDir: "runs-wave-a/wavea-faead-rally",
  },
  "wavea-marne-dig": {
    group: "dvids-marne-2024",
    split: "dev",
    poseRunDir: "runs-wave-a/wavea-marne-dig",
  },
};

// ── core data model ───────────────────────────────────────────────────────

export interface OwnershipCandidate {
  point: { x: number; y: number };
  owner: "target" | "other";
  annotatorId: string;
  /** Pixel box from ownership-review queue when this point matches one. */
  boxPx?: [number, number, number, number];
  detectorScore?: number;
}

export interface PoseContext {
  targetWrists: Array<{ x: number; y: number }>;
  otherWrists: Array<{ x: number; y: number }>;
  torsoMid: { x: number; y: number };
  torsoSpan: number;
  videoH: number;
}

export interface DualFrame {
  caseId: string;
  group: string;
  split: "dev" | "held_out";
  tMs: number;
  candidates: OwnershipCandidate[];
  buckets: string[];
  pose: PoseContext | null;
}

export type Bucket =
  "edge_on" | "dark_on_dark" | "blur" | "net_post_occlusion" | "multi_paddle" | "clean";

// ── loading committed gold ────────────────────────────────────────────────

interface SidecarEntry {
  caseId: string;
  tMs: number;
  owners: Record<string, string>;
  note?: string;
  annotator?: string;
}

interface QueueFrame {
  caseId: string;
  tMs: number;
  videoSize: { width: number; height: number };
  boxes: Array<{ index: number; boxPx: [number, number, number, number]; score: number }>;
}

function timeKey(tMs: number): string {
  return String(Math.round(tMs));
}

/** Two labeled points closer than this (normalized) are the same physical
 *  label placed by two annotator passes — deduped, first pass kept. */
const DUPLICATE_POINT_DISTANCE = 0.01;

export function bucketsFromNote(note: string | undefined, candidateCount: number): string[] {
  const buckets = new Set<string>();
  const text = (note ?? "").toLowerCase();
  if (/edge[- ]?on/.test(text)) buckets.add("edge_on");
  if (/dark/.test(text)) buckets.add("dark_on_dark");
  if (/blur/.test(text)) buckets.add("blur");
  if (/net[- ]?(post|strip|tape)|occlu/.test(text)) buckets.add("net_post_occlusion");
  if (candidateCount >= 3) buckets.add("multi_paddle");
  if (buckets.size === 0) buckets.add("clean");
  return [...buckets].sort();
}

export interface AnnotationPass {
  annotatorId: string;
  paddleFrames: Array<{ tMs: number; point: { x: number; y: number } | null; visibility: string }>;
  otherPaddleFrames: Array<{
    tMs: number;
    point: { x: number; y: number } | null;
    visibility: string;
  }>;
}

/** Assemble dual frames from in-memory annotation passes (pure — unit-testable). */
export function assembleDualFrames(
  caseId: string,
  info: OwnershipCaseInfo,
  passes: AnnotationPass[],
  sidecar: SidecarEntry[],
  queueFrames: QueueFrame[],
): DualFrame[] {
  const byTime = new Map<string, { tMs: number; candidates: OwnershipCandidate[] }>();
  for (const pass of passes) {
    for (const [owner, frames] of [
      ["target", pass.paddleFrames],
      ["other", pass.otherPaddleFrames],
    ] as const) {
      for (const frame of frames) {
        if (frame.visibility !== "visible" || !frame.point) continue;
        const key = timeKey(frame.tMs);
        const slot = byTime.get(key) ?? { tMs: frame.tMs, candidates: [] };
        const duplicate = slot.candidates.some(
          (candidate) =>
            candidate.owner === owner &&
            Math.hypot(candidate.point.x - frame.point!.x, candidate.point.y - frame.point!.y) <
              DUPLICATE_POINT_DISTANCE,
        );
        if (!duplicate) {
          slot.candidates.push({ point: frame.point, owner, annotatorId: pass.annotatorId });
        }
        byTime.set(key, slot);
      }
    }
  }

  const queueByTime = new Map<string, QueueFrame>();
  for (const frame of queueFrames) {
    if (frame.caseId === caseId) queueByTime.set(timeKey(frame.tMs), frame);
  }
  const notesByTime = new Map<string, string>();
  for (const entry of sidecar) {
    if (entry.caseId !== caseId || !entry.note) continue;
    const key = timeKey(entry.tMs);
    notesByTime.set(key, [notesByTime.get(key), entry.note].filter(Boolean).join(" | "));
  }

  const duals: DualFrame[] = [];
  for (const [key, slot] of byTime) {
    const hasTarget = slot.candidates.some((candidate) => candidate.owner === "target");
    const hasOther = slot.candidates.some((candidate) => candidate.owner === "other");
    if (!hasTarget || !hasOther) continue;
    const queueFrame = queueByTime.get(key);
    if (queueFrame) {
      for (const candidate of slot.candidates) {
        let best: { box: QueueFrame["boxes"][number]; distance: number } | null = null;
        for (const box of queueFrame.boxes) {
          const center = {
            x: (box.boxPx[0] + box.boxPx[2]) / 2 / queueFrame.videoSize.width,
            y: (box.boxPx[1] + box.boxPx[3]) / 2 / queueFrame.videoSize.height,
          };
          const distance = Math.hypot(center.x - candidate.point.x, center.y - candidate.point.y);
          if (distance < 0.02 && (best === null || distance < best.distance)) {
            best = { box, distance };
          }
        }
        if (best) {
          candidate.boxPx = best.box.boxPx;
          candidate.detectorScore = best.box.score;
        }
      }
    }
    duals.push({
      caseId,
      group: info.group,
      split: info.split,
      tMs: slot.tMs,
      candidates: slot.candidates,
      buckets: bucketsFromNote(notesByTime.get(key), slot.candidates.length),
      pose: null,
    });
  }
  return duals.sort((a, b) => a.tMs - b.tMs);
}

// ── committed pose context (wave-a windowed corpus runs only) ─────────────

const WRIST_VISIBILITY_FLOOR = 0.2;
const POSE_MATCH_TOLERANCE_MS = 40;

export function poseContextAt(people: PeopleFile, tMs: number): PoseContext | null {
  const tracks = buildPlayerTracks(people);
  if (tracks.length === 0) return null;
  // Auto target policy (coverage × size) — same policy as eventCompletionBench
  // and the pipeline pre-seed.
  const target = [...tracks].sort(
    (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
  )[0]!;
  let targetFrame: PlayerFrame | null = null;
  let bestDelta = Infinity;
  for (const frame of target.frames) {
    const delta = Math.abs(frame.timestampMs - tMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      targetFrame = frame;
    }
  }
  if (!targetFrame || bestDelta > POSE_MATCH_TOLERANCE_MS) return null;
  // NEVER trust handedness for wrist selection: Apple Vision swaps L/R on
  // rear views (W12 discovery) — always consider both wrists.
  const targetWrists = targetFrame.joints
    .filter((joint) => joint.n.endsWith("wrist") && joint.v >= WRIST_VISIBILITY_FLOOR)
    .map((joint) => ({ x: joint.x, y: joint.y }));
  const others = otherPlayersWrists(tracks, target.trackId);
  let otherWrists: Array<{ x: number; y: number }> = [];
  let bestOtherDelta = Infinity;
  for (const entry of others) {
    const delta = Math.abs(entry.timestampMs - tMs);
    if (delta < bestOtherDelta && delta <= POSE_MATCH_TOLERANCE_MS) {
      bestOtherDelta = delta;
      otherWrists = entry.wrists;
    }
  }
  if (targetWrists.length === 0) return null;
  return {
    targetWrists,
    otherWrists,
    torsoMid: targetFrame.torsoMid,
    torsoSpan: targetFrame.torsoSpan,
    videoH: people.video.h,
  };
}

// ── methods ───────────────────────────────────────────────────────────────

export type MethodId =
  | "incumbent_wrist_ratio"
  | "b1_wrist_distance_only"
  | "b2_target_geometry"
  | "b3_temporal_continuity";

export interface Pick {
  /** Chosen candidate index, or null = honest abstention (no evidence). */
  index: number | null;
  reason: string;
}

function distanceToNearest(
  point: { x: number; y: number },
  wrists: Array<{ x: number; y: number }>,
): number | null {
  if (wrists.length === 0) return null;
  return Math.min(...wrists.map((wrist) => Math.hypot(wrist.x - point.x, wrist.y - point.y)));
}

/** Frame-level analog of the incumbent S3 rule: a candidate is other-owned
 *  when an other wrist is decisively closer (TRACKER_GATES.otherOwnershipFactor);
 *  among the not-other-owned candidates the nearest-to-target-wrist wins. */
export function pickIncumbent(frame: DualFrame): Pick {
  if (!frame.pose) return { index: null, reason: "no committed pose for this case" };
  let best: { index: number; dTarget: number } | null = null;
  for (const [index, candidate] of frame.candidates.entries()) {
    const dTarget = distanceToNearest(candidate.point, frame.pose.targetWrists);
    if (dTarget === null) continue;
    const dOther = distanceToNearest(candidate.point, frame.pose.otherWrists);
    const otherOwned = dOther !== null && dOther < TRACKER_GATES.otherOwnershipFactor * dTarget;
    if (otherOwned) continue;
    if (best === null || dTarget < best.dTarget) best = { index, dTarget };
  }
  return best
    ? { index: best.index, reason: "nearest target wrist among not-other-owned" }
    : { index: null, reason: "all candidates other-owned by wrist ratio" };
}

/** B1 — wrist distance only: nearest target wrist wins, no other-wrist veto. */
export function pickWristDistanceOnly(frame: DualFrame): Pick {
  if (!frame.pose) return { index: null, reason: "no committed pose for this case" };
  let best: { index: number; dTarget: number } | null = null;
  for (const [index, candidate] of frame.candidates.entries()) {
    const dTarget = distanceToNearest(candidate.point, frame.pose.targetWrists);
    if (dTarget === null) continue;
    if (best === null || dTarget < best.dTarget) best = { index, dTarget };
  }
  return best
    ? { index: best.index, reason: "nearest target wrist" }
    : { index: null, reason: "no visible target wrist" };
}

/** Expected paddle-box-height : torso-span ratio for the scale plausibility
 *  term (dev-set constant; wave-a duals are all dev). */
const PADDLE_TO_TORSO_RATIO = 0.3;
const SCALE_TERM_WEIGHT = 0.5;

/** B2 — target-relative geometry: distance to target torso normalized by
 *  torso span, plus a scale-plausibility penalty when box geometry exists. */
export function pickTargetGeometry(frame: DualFrame): Pick {
  if (!frame.pose) return { index: null, reason: "no committed pose for this case" };
  const { torsoMid, torsoSpan, videoH } = frame.pose;
  if (torsoSpan <= 0) return { index: null, reason: "degenerate torso span" };
  let best: { index: number; cost: number } | null = null;
  for (const [index, candidate] of frame.candidates.entries()) {
    const positionTerm =
      Math.hypot(candidate.point.x - torsoMid.x, candidate.point.y - torsoMid.y) / torsoSpan;
    let scaleTerm = 0;
    if (candidate.boxPx) {
      const boxHeightNorm = (candidate.boxPx[3] - candidate.boxPx[1]) / videoH;
      if (boxHeightNorm > 0) {
        scaleTerm = Math.abs(Math.log(boxHeightNorm / (PADDLE_TO_TORSO_RATIO * torsoSpan)));
      }
    }
    const cost = positionTerm + SCALE_TERM_WEIGHT * scaleTerm;
    if (best === null || cost < best.cost) best = { index, cost };
  }
  return best
    ? { index: best.index, reason: "nearest to target torso (span-normalized) + scale" }
    : { index: null, reason: "no candidates" };
}

export interface TemporalPick extends Pick {
  /** True when this frame supplied the seed (gold or geometry) rather than a
   *  causal continuity prediction — excluded from accuracy scoring. */
  seeded: boolean;
  seedSource?: "geometry" | "gold";
}

/** B3 — temporal continuity: causal chain per case; each frame picks the
 *  candidate nearest the PREVIOUS frame's picked point. The first frame of a
 *  case is seeded by B2 where pose exists, else by the gold label (disclosed;
 *  seed frames never score). */
export function pickTemporalContinuity(caseFrames: DualFrame[]): TemporalPick[] {
  const picks: TemporalPick[] = [];
  let anchor: { x: number; y: number } | null = null;
  for (const frame of caseFrames) {
    if (anchor === null) {
      const geometry = pickTargetGeometry(frame);
      if (geometry.index !== null) {
        anchor = frame.candidates[geometry.index]!.point;
        picks.push({
          index: geometry.index,
          reason: "seed: geometry",
          seeded: true,
          seedSource: "geometry",
        });
      } else {
        const goldIndex = frame.candidates.findIndex((candidate) => candidate.owner === "target");
        anchor = frame.candidates[goldIndex]!.point;
        picks.push({
          index: goldIndex,
          reason: "seed: gold label (disclosed)",
          seeded: true,
          seedSource: "gold",
        });
      }
      continue;
    }
    let best: { index: number; distance: number } | null = null;
    for (const [index, candidate] of frame.candidates.entries()) {
      const distance = Math.hypot(candidate.point.x - anchor.x, candidate.point.y - anchor.y);
      if (best === null || distance < best.distance) best = { index, distance };
    }
    anchor = best ? frame.candidates[best.index]!.point : anchor;
    picks.push({
      index: best?.index ?? null,
      reason: "nearest to previous pick",
      seeded: false,
    });
  }
  return picks;
}

// ── scoring ───────────────────────────────────────────────────────────────

export interface MethodBucketRow {
  n: number;
  correct: number;
  abstained: number;
  accuracy: number | null;
  smallN: boolean;
}

export interface MethodReport {
  method: MethodId;
  scoredFrames: number;
  correct: number;
  abstained: number;
  /** correct / scoredFrames (abstentions count as not-correct). */
  accuracy: number | null;
  /** correct / (scoredFrames - abstained). */
  accuracyWhenAnswering: number | null;
  coverage: number | null;
  byBucket: Record<string, MethodBucketRow>;
  byGroup: Record<string, MethodBucketRow>;
  failures: Array<{ caseId: string; tMs: number; buckets: string[]; pickedOwner: string | null }>;
}

const SMALL_N_THRESHOLD = 10;

export function scoreMethod(
  method: MethodId,
  frames: DualFrame[],
  picks: Array<Pick | TemporalPick>,
  subset: "all" | "pose" = "all",
): MethodReport {
  const byBucket: Record<string, { n: number; correct: number; abstained: number }> = {};
  const byGroup: Record<string, { n: number; correct: number; abstained: number }> = {};
  const failures: MethodReport["failures"] = [];
  let scoredFrames = 0;
  let correct = 0;
  let abstained = 0;
  for (const [index, frame] of frames.entries()) {
    const pick = picks[index]!;
    if ("seeded" in pick && pick.seeded) continue; // seed frames never score
    if (subset === "pose" && frame.pose === null) continue;
    scoredFrames += 1;
    const isCorrect = pick.index !== null && frame.candidates[pick.index]!.owner === "target";
    const isAbstain = pick.index === null;
    if (isCorrect) correct += 1;
    if (isAbstain) abstained += 1;
    if (!isCorrect) {
      failures.push({
        caseId: frame.caseId,
        tMs: frame.tMs,
        buckets: frame.buckets,
        pickedOwner: pick.index === null ? null : frame.candidates[pick.index]!.owner,
      });
    }
    for (const bucket of frame.buckets) {
      byBucket[bucket] ??= { n: 0, correct: 0, abstained: 0 };
      byBucket[bucket].n += 1;
      if (isCorrect) byBucket[bucket].correct += 1;
      if (isAbstain) byBucket[bucket].abstained += 1;
    }
    const groupRow = (byGroup[frame.group] ??= { n: 0, correct: 0, abstained: 0 });
    groupRow.n += 1;
    if (isCorrect) groupRow.correct += 1;
    if (isAbstain) groupRow.abstained += 1;
  }
  const finalize = (row: { n: number; correct: number; abstained: number }): MethodBucketRow => ({
    ...row,
    accuracy: row.n > 0 ? Number((row.correct / row.n).toFixed(3)) : null,
    smallN: row.n < SMALL_N_THRESHOLD,
  });
  return {
    method,
    scoredFrames,
    correct,
    abstained,
    accuracy: scoredFrames > 0 ? Number((correct / scoredFrames).toFixed(3)) : null,
    accuracyWhenAnswering:
      scoredFrames - abstained > 0
        ? Number((correct / (scoredFrames - abstained)).toFixed(3))
        : null,
    coverage:
      scoredFrames > 0 ? Number(((scoredFrames - abstained) / scoredFrames).toFixed(3)) : null,
    byBucket: Object.fromEntries(
      Object.entries(byBucket).map(([bucket, row]) => [bucket, finalize(row)]),
    ),
    byGroup: Object.fromEntries(
      Object.entries(byGroup).map(([group, row]) => [group, finalize(row)]),
    ),
    failures,
  };
}

// ── loader + CLI ──────────────────────────────────────────────────────────

export function loadDualFrames(includeHeldOut: boolean): DualFrame[] {
  const sidecarPath = join(PB, "ownership-review/ownership-review.json");
  const queuePath = join(PB, "ownership-review/queue.json");
  const sidecar = existsSync(sidecarPath)
    ? (JSON.parse(readFileSync(sidecarPath, "utf8")) as SidecarEntry[])
    : [];
  const queueFrames = existsSync(queuePath)
    ? (JSON.parse(readFileSync(queuePath, "utf8")) as { frames: QueueFrame[] }).frames
    : [];
  const frames: DualFrame[] = [];
  for (const [caseId, info] of Object.entries(OWNERSHIP_CASES)) {
    if (info.split === "held_out" && !includeHeldOut) continue;
    const annotationDir = join(PB, "bundles", caseId, "annotation");
    if (!existsSync(annotationDir)) continue;
    const passes: AnnotationPass[] = [];
    for (const file of readdirSync(annotationDir).filter((name) => name.endsWith(".json"))) {
      const annotation = JSON.parse(
        readFileSync(join(annotationDir, file), "utf8"),
      ) as SwingAnnotation;
      passes.push({
        annotatorId: annotation.annotatorId,
        paddleFrames: annotation.paddleFrames ?? [],
        otherPaddleFrames: annotation.otherPaddleFrames ?? [],
      });
    }
    const caseFrames = assembleDualFrames(caseId, info, passes, sidecar, queueFrames);
    if (info.poseRunDir) {
      const peoplePath = join(PB, info.poseRunDir, "people.json");
      if (existsSync(peoplePath)) {
        const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
        for (const frame of caseFrames) frame.pose = poseContextAt(people, frame.tMs);
      }
    }
    frames.push(...caseFrames);
  }
  return frames;
}

export function runBench(includeHeldOut: boolean): {
  benchVersion: string;
  generatedAtIso: string;
  includeHeldOut: boolean;
  dualFrames: number;
  framesWithPose: number;
  perCase: Record<string, { dualFrames: number; withPose: number }>;
  dataDisclosure: string[];
  methods: MethodReport[];
  /** Same methods scored ONLY on frames with committed pose — the
   *  apples-to-apples comparison surface (all methods can answer there). */
  poseSubsetMethods: MethodReport[];
} {
  const frames = loadDualFrames(includeHeldOut);
  const byCase = new Map<string, DualFrame[]>();
  for (const frame of frames) {
    byCase.set(frame.caseId, [...(byCase.get(frame.caseId) ?? []), frame]);
  }
  const orderedFrames: DualFrame[] = [];
  const temporalPicks: TemporalPick[] = [];
  for (const caseFrames of byCase.values()) {
    orderedFrames.push(...caseFrames);
    temporalPicks.push(...pickTemporalContinuity(caseFrames));
  }
  const pickSets: Array<{ method: MethodId; picks: Array<Pick | TemporalPick> }> = [
    {
      method: "incumbent_wrist_ratio",
      picks: orderedFrames.map((frame) => pickIncumbent(frame)),
    },
    {
      method: "b1_wrist_distance_only",
      picks: orderedFrames.map((frame) => pickWristDistanceOnly(frame)),
    },
    {
      method: "b2_target_geometry",
      picks: orderedFrames.map((frame) => pickTargetGeometry(frame)),
    },
    { method: "b3_temporal_continuity", picks: temporalPicks },
  ];
  const methods = pickSets.map((set) => scoreMethod(set.method, orderedFrames, set.picks));
  const poseSubsetMethods = pickSets.map((set) =>
    scoreMethod(set.method, orderedFrames, set.picks, "pose"),
  );
  const perCase: Record<string, { dualFrames: number; withPose: number }> = {};
  for (const [caseId, caseFrames] of byCase) {
    perCase[caseId] = {
      dualFrames: caseFrames.length,
      withPose: caseFrames.filter((frame) => frame.pose !== null).length,
    };
  }
  return {
    benchVersion: OWNERSHIP_BENCH_VERSION,
    generatedAtIso: new Date().toISOString(),
    includeHeldOut,
    dualFrames: orderedFrames.length,
    framesWithPose: orderedFrames.filter((frame) => frame.pose !== null).length,
    perCase,
    dataDisclosure: [
      "pose (wrists/torso) is committed only for wave-a windowed corpus runs; the five original bench cases have no committed pose, so wrist/geometry methods and the incumbent analog ABSTAIN there",
      "the incumbent S3 heuristic is replayed as a frame-level analog (otherOwnershipFactor wrist-ratio veto + nearest target wrist), not the full track/segment machinery — canonical run dirs are absent on Linux",
      "b3 temporal continuity seeds each case's first dual frame (geometry where pose exists, otherwise the gold label, disclosed); seed frames never score",
      "buckets come from committed sidecar notes + candidate multiplicity; frames without notes are 'clean'",
      "accuracy counts abstentions as not-correct; accuracyWhenAnswering and coverage are reported alongside",
    ],
    methods,
    poseSubsetMethods,
  };
}

const isMain = process.argv[1]?.endsWith("ownershipBench.ts");
if (isMain) {
  const includeHeldOut = process.argv.includes("--include-held-out");
  const report = runBench(includeHeldOut);
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-d");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(
    outDir,
    includeHeldOut ? "d02-ownership-eval-with-held-out.json" : "d02-ownership-eval.json",
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(
    `${OWNERSHIP_BENCH_VERSION} · ${report.dualFrames} dual frames (${report.framesWithPose} with committed pose) · held-out ${includeHeldOut ? "INCLUDED" : "excluded"}`,
  );
  console.log("per-case:", JSON.stringify(report.perCase));
  for (const method of [
    ...report.methods,
    ...report.poseSubsetMethods.map((m) => ({
      ...m,
      method: `${m.method} [pose subset]` as MethodId,
    })),
  ]) {
    console.log(
      `\n${method.method}: acc ${method.accuracy} (${method.correct}/${method.scoredFrames}) · answering ${method.accuracyWhenAnswering} · coverage ${method.coverage}`,
    );
    for (const [bucket, row] of Object.entries(method.byBucket)) {
      console.log(
        `  ${bucket.padEnd(20)} n=${String(row.n).padStart(3)} acc=${row.accuracy}${row.smallN ? " (small-n)" : ""} abstain=${row.abstained}`,
      );
    }
    for (const [group, row] of Object.entries(method.byGroup)) {
      console.log(
        `  [${group}] n=${row.n} acc=${row.accuracy}${row.smallN ? " (small-n)" : ""} abstain=${row.abstained}`,
      );
    }
  }
  console.log(`\nreport → ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}
