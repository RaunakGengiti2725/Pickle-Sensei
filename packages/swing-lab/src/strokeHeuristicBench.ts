import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import {
  buildPlayerTracks,
  targetPoseSequence,
  type PeopleFile,
  type PlayerTrack,
} from "./playerTracker.js";
import {
  classifyStroke,
  STROKE_HEURISTIC_VERSION,
  type StrokePrediction,
} from "./strokeHeuristic.js";
import {
  validateStrokeGoldFile,
  type StrokeGoldFile,
  type StrokeGoldLabel,
} from "./strokeTaxonomyBench.js";

/**
 * STROKE HEURISTIC BENCH (wave-E e03) — L1/L2 evaluation of classifyStroke
 * that runs ENTIRELY off committed data, so it works on Linux where the
 * canonical run dirs (datasets/paddle-bench/runs/) and Apple-Vision pose
 * extraction are absent.
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/strokeHeuristicBench.ts
 *
 * Evaluation unit: one stroke-gold label (datasets/paddle-bench/stroke-gold
 * .json, append-only) whose case has a COMMITTED windowed pose run
 * (datasets/paddle-bench/runs-wave-a/<case>/people.json — the wave-a corpus
 * slices, Apple Vision pose extracted on macOS and committed). Held-out
 * cases (wm-dink-01, afn-vic-rally1) have no committed pose here and are
 * additionally excluded by construction. Grouping is BY SOURCE SESSION
 * (corpus recordings.json sessionKey), never a random frame split.
 *
 * Data reality (disclosed in every report):
 *  - Pose exists ONLY for the 8 wave-a cases; gold on the five original
 *    bench cases (afn-sasebo-rally1/2, wm-volley-02) is NOT evaluable here.
 *  - No committed paddle track exists for these windows, so classifyStroke
 *    runs with paddle=null: the contact point is always wrist-derived and
 *    L3/intensity uses the measured dominant-wrist speed series (the same
 *    dominantWristSpeeds used by the production miner — identical units).
 *  - The gold contactMs (visual, recording clock) is the reference; when a
 *    gold event has contactMs=null the measured wrist-speed peak inside the
 *    event window is passed as eventPeakMs (never a window midpoint).
 *  - TARGET-owned events use the auto-selected target track (coverage ×
 *    torso-span, same policy as production). OTHER-owned events use the
 *    non-duplicate track with the most frames inside the event window;
 *    attribution risk is disclosed per row and the slice is reported
 *    separately, never folded into the target slice.
 *  - Handedness comes from the committed bundle annotations (majority of
 *    explicit right/left votes; "unsure" votes do not count).
 */

export const STROKE_HEURISTIC_BENCH_VERSION = "stroke-heuristic-bench-v1";

const PB = join(REPO_ROOT, "datasets/paddle-bench");

/** Committed-pose cases only. group = corpus sessionKey of the recording the
 *  windowed people.json was derived from (datasets/corpus/recordings.json). */
export const STROKE_BENCH_POSE_CASES: Record<string, { group: string; poseRunDir: string }> = {
  "wavea-944403-dink": { group: "dvids-marne-2024", poseRunDir: "runs-wave-a/wavea-944403-dink" },
  "wavea-944403-smash": { group: "dvids-marne-2024", poseRunDir: "runs-wave-a/wavea-944403-smash" },
  "wavea-faead-feed": { group: "dvids-marne-2024", poseRunDir: "runs-wave-a/wavea-faead-feed" },
  "wavea-faead-rally": { group: "dvids-marne-2024", poseRunDir: "runs-wave-a/wavea-faead-rally" },
  "wavea-marne-dig": { group: "dvids-marne-2024", poseRunDir: "runs-wave-a/wavea-marne-dig" },
  "wavea-marne-serve": { group: "dvids-marne-2024", poseRunDir: "runs-wave-a/wavea-marne-serve" },
  "wavea-sasebo-volleys": {
    group: "afn-sasebo-2025-06",
    poseRunDir: "runs-wave-a/wavea-sasebo-volleys",
  },
  "wavea-wgm-wheelchair": {
    group: "dvids-warriorgames-2026",
    poseRunDir: "runs-wave-a/wavea-wgm-wheelchair",
  },
};

// ── scoring (pure — fixture-tested) ───────────────────────────────────────

/** L1 in this bench is the coarse class the heuristic can actually claim:
 *  OVERHEAD vs SWING (bounce is unobserved, so families inside SWING are
 *  not separable by design — that is a taxonomy limit, not an error). */
export type BenchL1 = "OVERHEAD" | "SWING";

export function goldL1Class(l1: StrokeGoldLabel["l1"]): BenchL1 | null {
  if (l1 === "unknown") return null;
  return l1 === "overhead_lob" ? "OVERHEAD" : "SWING";
}

export function predictedL1Class(prediction: StrokePrediction): BenchL1 | "ABSTAINED" {
  if (prediction.label === "UNKNOWN") return "ABSTAINED";
  if (prediction.label === "OVERHEAD") return "OVERHEAD";
  return "SWING";
}

export type L1Verdict = "correct" | "wrong" | "abstained" | "gold_unknown";
export type L2Verdict = "correct" | "wrong" | "abstained" | "gold_unknown" | "not_applicable";

export function scoreL1(gold: StrokeGoldLabel, prediction: StrokePrediction): L1Verdict {
  const expected = goldL1Class(gold.l1);
  if (expected === null) return "gold_unknown";
  const predicted = predictedL1Class(prediction);
  if (predicted === "ABSTAINED") return "abstained";
  return predicted === expected ? "correct" : "wrong";
}

export function scoreL2(gold: StrokeGoldLabel, prediction: StrokePrediction): L2Verdict {
  if (gold.l2 === "unknown") return "gold_unknown";
  if (gold.l2 === "not_applicable") return "not_applicable";
  const predicted = predictedL1Class(prediction);
  if (predicted === "ABSTAINED") return "abstained";
  if (gold.l2 === "overhead") {
    // An OVERHEAD claim carries no forehand/backhand side; the L2 question
    // for an overhead-side gold is exactly "did it claim OVERHEAD".
    return predicted === "OVERHEAD" ? "correct" : "wrong";
  }
  // forehand / backhand / two_hand_backhand gold sides.
  const side = prediction.label.startsWith("FOREHAND")
    ? "forehand"
    : prediction.label.startsWith("BACKHAND")
      ? "backhand"
      : null;
  if (side === null) return "abstained"; // e.g. OVERHEAD claim vs side gold
  const goldSide = gold.l2 === "two_hand_backhand" ? "backhand" : gold.l2;
  return side === goldSide ? "correct" : "wrong";
}

// ── data loading ──────────────────────────────────────────────────────────

export function loadStrokeGold(root: string = PB): StrokeGoldFile {
  const raw = JSON.parse(readFileSync(join(root, "stroke-gold.json"), "utf8")) as StrokeGoldFile;
  const problems = validateStrokeGoldFile(raw);
  if (problems.length > 0) {
    throw new Error(`stroke-gold.json failed validation: ${problems.join("; ")}`);
  }
  return raw;
}

/** Majority of the explicit right/left handedness votes across the case's
 *  committed annotation passes; "unsure" votes never count. Null when no
 *  explicit vote exists. */
export function loadCaseHandedness(caseId: string, root: string = PB): "right" | "left" | null {
  const dir = join(root, "bundles", caseId, "annotation");
  if (!existsSync(dir)) return null;
  const votes = { right: 0, left: 0 };
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const annotation = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        handedness?: string;
      };
      if (annotation.handedness === "right") votes.right += 1;
      if (annotation.handedness === "left") votes.left += 1;
    } catch {
      // unreadable pass: not a vote
    }
  }
  if (votes.right === 0 && votes.left === 0) return null;
  return votes.right >= votes.left ? "right" : "left";
}

export interface BenchPose {
  file: PeopleFile;
  tracks: PlayerTrack[];
}

export function loadCasePose(caseId: string, root: string = PB): BenchPose | null {
  const info = STROKE_BENCH_POSE_CASES[caseId];
  if (!info) return null;
  const peoplePath = join(root, info.poseRunDir, "people.json");
  if (!existsSync(peoplePath)) return null;
  const file = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
  return { file, tracks: buildPlayerTracks(file) };
}

function framesInWindow(track: PlayerTrack, window: { startMs: number; endMs: number }): number {
  return track.frames.filter(
    (frame) => frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs,
  ).length;
}

/** Auto target policy — coverage × torso span, the production auto rule. */
export function pickTargetTrack(tracks: PlayerTrack[]): PlayerTrack | null {
  let best: PlayerTrack | null = null;
  let bestScore = -Infinity;
  for (const track of tracks) {
    const score = track.coverage * track.meanTorsoSpan;
    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }
  return best;
}

/** For OTHER-owned events: the non-target, non-duplicate track with the most
 *  frames inside the event window. Attribution is heuristic — disclosed. */
export function pickOtherTrack(
  tracks: PlayerTrack[],
  target: PlayerTrack,
  window: { startMs: number; endMs: number },
): PlayerTrack | null {
  let best: PlayerTrack | null = null;
  let bestFrames = 0;
  for (const track of tracks) {
    if (track.trackId === target.trackId) continue;
    // Duplicate-of-target suppression (same rule as otherPlayersWrists).
    let coincident = 0;
    let compared = 0;
    for (const frame of track.frames) {
      const targetFrame = target.frames.find(
        (candidate) => Math.abs(candidate.timestampMs - frame.timestampMs) <= 40,
      );
      if (!targetFrame) continue;
      compared += 1;
      if (
        Math.hypot(
          frame.torsoMid.x - targetFrame.torsoMid.x,
          frame.torsoMid.y - targetFrame.torsoMid.y,
        ) < 0.12
      ) {
        coincident += 1;
      }
    }
    if (compared > 0 && coincident / compared > 0.5) continue;
    const count = framesInWindow(track, window);
    if (count > bestFrames) {
      bestFrames = count;
      best = track;
    }
  }
  return bestFrames > 0 ? best : null;
}

// ── evaluation ────────────────────────────────────────────────────────────

export interface BenchRow {
  caseId: string;
  group: string;
  owner: "target" | "other";
  eventStartMs: number;
  eventEndMs: number;
  contactMs: number | null;
  referenceUsed: "gold_contact" | "wrist_speed_peak" | "none";
  goldL1: string;
  goldL2: string;
  predictedLabel: string;
  taxonomyDepth: number | null;
  confidence: number | null;
  l1: L1Verdict | "pose_unavailable";
  l2: L2Verdict | "pose_unavailable";
  limitingFactors: string[];
  attributionRisk: string | null;
}

export interface SliceCounts {
  n: number;
  l1Correct: number;
  l1Wrong: number;
  l1Abstained: number;
  l1GoldUnknown: number;
  l2Correct: number;
  l2Wrong: number;
  l2Abstained: number;
  l2GoldUnknown: number;
  l2NotApplicable: number;
  /** Committed (non-UNKNOWN) predictions that are wrong at L1 or L2. */
  confidentlyWrong: number;
}

export interface StrokeHeuristicBenchReport {
  benchVersion: string;
  classifierVersion: string;
  goldLabelsTotal: number;
  evaluableLabels: number;
  unevaluableCases: Record<string, number>;
  rows: BenchRow[];
  overall: SliceCounts;
  byGroup: Record<string, SliceCounts>;
  byOwner: Record<string, SliceCounts>;
  byCase: Record<string, SliceCounts>;
  byGoldFamily: Record<string, SliceCounts>;
  disclosures: string[];
}

function emptyCounts(): SliceCounts {
  return {
    n: 0,
    l1Correct: 0,
    l1Wrong: 0,
    l1Abstained: 0,
    l1GoldUnknown: 0,
    l2Correct: 0,
    l2Wrong: 0,
    l2Abstained: 0,
    l2GoldUnknown: 0,
    l2NotApplicable: 0,
    confidentlyWrong: 0,
  };
}

function accumulate(counts: SliceCounts, row: BenchRow): void {
  counts.n += 1;
  if (row.l1 === "correct") counts.l1Correct += 1;
  else if (row.l1 === "wrong") counts.l1Wrong += 1;
  else if (row.l1 === "abstained") counts.l1Abstained += 1;
  else if (row.l1 === "gold_unknown") counts.l1GoldUnknown += 1;
  if (row.l2 === "correct") counts.l2Correct += 1;
  else if (row.l2 === "wrong") counts.l2Wrong += 1;
  else if (row.l2 === "abstained") counts.l2Abstained += 1;
  else if (row.l2 === "gold_unknown") counts.l2GoldUnknown += 1;
  else if (row.l2 === "not_applicable") counts.l2NotApplicable += 1;
  if (row.predictedLabel !== "UNKNOWN" && (row.l1 === "wrong" || row.l2 === "wrong")) {
    counts.confidentlyWrong += 1;
  }
}

export function evaluateGoldLabel(
  gold: StrokeGoldLabel,
  pose: BenchPose,
  handedness: "right" | "left",
): BenchRow {
  const info = STROKE_BENCH_POSE_CASES[gold.caseId]!;
  const window = { startMs: gold.eventStartMs, endMs: gold.eventEndMs };
  const target = pickTargetTrack(pose.tracks);
  let track: PlayerTrack | null = null;
  let attributionRisk: string | null = null;
  if (gold.owner === "target") {
    track = target;
  } else if (target) {
    track = pickOtherTrack(pose.tracks, target, window);
    attributionRisk =
      track === null
        ? "no non-duplicate other track inside the event window"
        : "other-player track chosen by window coverage; identity not gold-verified";
  }
  const base = {
    caseId: gold.caseId,
    group: info.group,
    owner: gold.owner,
    eventStartMs: gold.eventStartMs,
    eventEndMs: gold.eventEndMs,
    contactMs: gold.contactMs,
    goldL1: gold.l1,
    goldL2: gold.l2,
    attributionRisk,
  };
  if (!track || framesInWindow(track, window) === 0) {
    return {
      ...base,
      referenceUsed: "none",
      predictedLabel: "—",
      taxonomyDepth: null,
      confidence: null,
      l1: "pose_unavailable",
      l2: "pose_unavailable",
      limitingFactors: ["no_pose_track_inside_event_window"],
    };
  }
  const sequence = targetPoseSequence(pose.file, track);
  const wristSpeeds = dominantWristSpeeds(sequence.frames);
  let referenceUsed: BenchRow["referenceUsed"] = "gold_contact";
  let eventPeakMs: number | null = null;
  if (gold.contactMs === null) {
    const inWindow = wristSpeeds.filter(
      (sample) => sample.timestampMs >= window.startMs && sample.timestampMs <= window.endMs,
    );
    const peak = inWindow.reduce(
      (best: { timestampMs: number; value: number } | null, sample) =>
        best === null || sample.value > best.value ? sample : best,
      null,
    );
    eventPeakMs = peak?.timestampMs ?? null;
    referenceUsed = eventPeakMs !== null ? "wrist_speed_peak" : "none";
  }
  const prediction = classifyStroke({
    sequence,
    window,
    contactMs: gold.contactMs,
    eventPeakMs,
    handedness,
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds,
  });
  return {
    ...base,
    referenceUsed,
    predictedLabel: prediction.label,
    taxonomyDepth: prediction.taxonomyDepth,
    confidence: prediction.confidence,
    l1: scoreL1(gold, prediction),
    l2: scoreL2(gold, prediction),
    limitingFactors: prediction.limitingFactors,
  };
}

export function runStrokeHeuristicBench(root: string = PB): StrokeHeuristicBenchReport {
  const gold = loadStrokeGold(root);
  const rows: BenchRow[] = [];
  const unevaluableCases: Record<string, number> = {};
  const poseCache = new Map<string, BenchPose | null>();
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
    rows.push(evaluateGoldLabel(label, pose, handedness));
  }
  const overall = emptyCounts();
  const byGroup: Record<string, SliceCounts> = {};
  const byOwner: Record<string, SliceCounts> = {};
  const byCase: Record<string, SliceCounts> = {};
  const byGoldFamily: Record<string, SliceCounts> = {};
  for (const row of rows) {
    accumulate(overall, row);
    accumulate((byGroup[row.group] ??= emptyCounts()), row);
    accumulate((byOwner[row.owner] ??= emptyCounts()), row);
    accumulate((byCase[row.caseId] ??= emptyCounts()), row);
    accumulate((byGoldFamily[row.goldL1] ??= emptyCounts()), row);
  }
  const classifierVersion =
    rows.length > 0 ? STROKE_HEURISTIC_VERSION : "no rows — classifier not exercised";
  return {
    benchVersion: STROKE_HEURISTIC_BENCH_VERSION,
    classifierVersion,
    goldLabelsTotal: gold.labels.length,
    evaluableLabels: rows.length,
    unevaluableCases,
    rows,
    overall,
    byGroup,
    byOwner,
    byCase,
    byGoldFamily,
    disclosures: [
      "Pose is committed ONLY for the 8 wave-a corpus windows; gold on afn-sasebo-rally1/2 and wm-volley-02 is not evaluable on this machine (no fabricated numbers).",
      "paddle=null everywhere: no committed paddle track exists for these windows, so every contact point is wrist-derived (production would also see the paddle track).",
      "OTHER-owned rows use heuristic window-coverage attribution — reported as a separate slice, never folded into the target slice.",
      "L1 here is the class the heuristic can claim (OVERHEAD vs SWING); families inside SWING are not separable without bounce observation, by design.",
      "Grouping is by corpus sessionKey; all three dvids-marne recordings share one session group.",
    ],
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("strokeHeuristicBench.ts");
if (isMain) {
  const report = runStrokeHeuristicBench();
  const fmt = (counts: SliceCounts) =>
    `n=${counts.n} · L1 ${counts.l1Correct}✓/${counts.l1Wrong}✗/${counts.l1Abstained}∅ (gold? ${counts.l1GoldUnknown}) · ` +
    `L2 ${counts.l2Correct}✓/${counts.l2Wrong}✗/${counts.l2Abstained}∅ (gold? ${counts.l2GoldUnknown}) · conf-wrong ${counts.confidentlyWrong}`;
  console.log(
    `${report.benchVersion} — ${report.evaluableLabels}/${report.goldLabelsTotal} gold labels evaluable`,
  );
  console.log(`unevaluable (no committed pose): ${JSON.stringify(report.unevaluableCases)}`);
  console.log(`\nOVERALL   ${fmt(report.overall)}`);
  for (const [name, slice] of Object.entries(report.byGroup))
    console.log(`GROUP ${name.padEnd(24)} ${fmt(slice)}`);
  for (const [name, slice] of Object.entries(report.byOwner))
    console.log(`OWNER ${name.padEnd(24)} ${fmt(slice)}`);
  for (const [name, slice] of Object.entries(report.byGoldFamily))
    console.log(`FAMILY ${name.padEnd(23)} ${fmt(slice)}`);
  console.log("\nROWS");
  for (const row of report.rows) {
    console.log(
      `  ${row.caseId} @${row.eventStartMs} [${row.owner}] gold=${row.goldL1}/${row.goldL2} → ${row.predictedLabel} ` +
        `(L1 ${row.l1}, L2 ${row.l2}${row.confidence !== null ? `, conf ${row.confidence.toFixed(2)}` : ""})` +
        `${row.limitingFactors.length > 0 ? ` limits=[${row.limitingFactors.join(", ")}]` : ""}`,
    );
  }
  console.log("\nDISCLOSURES");
  for (const disclosure of report.disclosures) console.log(`  - ${disclosure}`);
}
