import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import {
  selectPrimaryPaddleTrack,
  wristSeries,
  type PaddleTrackCandidate,
  type TrackedPaddleObservation,
} from "./paddleTracker.js";
import {
  buildPlayerTracks,
  otherPlayersWrists,
  selectTargetPlayer,
  targetPoseSequence,
  type PeopleFile,
} from "./playerTracker.js";
import type { PaddleFrameLabel } from "./annotationSchema.js";

/**
 * OWNERSHIP-GUARD GOLD REPLAY (wave-D3 d3-03) — evaluation only, never runtime.
 *
 *   npx tsx src/ownershipGuardBench.ts
 *
 * Measures ownership-guard-v1 against the COMMITTED wave-C ownership gold
 * (dev wave-a bundles only; held-out cases are never read). Canonical
 * detector runs are absent on this fleet, so candidate tracks are SYNTHETIC
 * GEOMETRY threaded through the committed label points (piecewise-linear at
 * 50ms steps, 0.06 boxes, score 0.5 — clearly synthetic, no detector claim).
 * Wrist series are REAL: people.json player tracks + auto target selection,
 * the same code path the paddle waterfall uses.
 *
 * Reported per case and in total, guard OFF vs ON:
 *   goldKept   — committed TARGET labels covered by the selected track
 *   wrongOwner — committed OTHER labels covered by the selected track
 * The guard must not buy wrong-owner reductions with blanket abstention:
 * the goldKept delta is the honesty check.
 */

const PB = join(REPO_ROOT, "datasets/paddle-bench");
const RUNS = join(PB, "runs-wave-a");
const STEP_MS = 50;
const HIT_RADIUS = 0.05;
const MATCH_TOLERANCE_MS = 60;

const DEV_CASES = [
  "wavea-944403-dink",
  "wavea-944403-smash",
  "wavea-faead-feed",
  "wavea-faead-rally",
  "wavea-marne-dig",
] as const;

interface OwnershipAnnotation {
  paddleFrames?: PaddleFrameLabel[];
  otherPaddleFrames?: PaddleFrameLabel[];
}

function labelPoints(
  labels: readonly PaddleFrameLabel[],
): Array<{ tMs: number; x: number; y: number }> {
  return labels
    .filter((label) => label.visibility === "visible" && label.point)
    .map((label) => ({ tMs: label.tMs, x: label.point!.x, y: label.point!.y }))
    .sort((a, b) => a.tMs - b.tMs);
}

/** Chain label points into per-paddle clusters (greedy nearest, 0.18 radius). */
function clusterPoints(
  points: Array<{ tMs: number; x: number; y: number }>,
): Array<Array<{ tMs: number; x: number; y: number }>> {
  const clusters: Array<Array<{ tMs: number; x: number; y: number }>> = [];
  for (const point of points) {
    let best: Array<{ tMs: number; x: number; y: number }> | null = null;
    let bestDistance = Infinity;
    for (const cluster of clusters) {
      const last = cluster[cluster.length - 1]!;
      if (point.tMs <= last.tMs) continue;
      const distance = Math.hypot(point.x - last.x, point.y - last.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = cluster;
      }
    }
    if (best && bestDistance <= 0.18) best.push(point);
    else clusters.push([point]);
  }
  return clusters;
}

/** SYNTHETIC track threaded through label points (piecewise-linear, 50ms). */
function syntheticTrack(
  trackId: number,
  points: Array<{ tMs: number; x: number; y: number }>,
): PaddleTrackCandidate {
  const observations: TrackedPaddleObservation[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    for (let tMs = from.tMs; tMs < to.tMs; tMs += STEP_MS) {
      const alpha = (tMs - from.tMs) / (to.tMs - from.tMs);
      const x = from.x + alpha * (to.x - from.x);
      const y = from.y + alpha * (to.y - from.y);
      observations.push({
        timestampMs: tMs,
        box: { x: x - 0.03, y: y - 0.03, width: 0.06, height: 0.06 },
        center: { x, y },
        detectorScore: 0.5,
        trackId,
        confidence: 0.5,
        nearWrist: false,
      });
    }
  }
  const last = points[points.length - 1];
  if (last) {
    observations.push({
      timestampMs: last.tMs,
      box: { x: last.x - 0.03, y: last.y - 0.03, width: 0.06, height: 0.06 },
      center: { x: last.x, y: last.y },
      detectorScore: 0.5,
      trackId,
      confidence: 0.5,
      nearWrist: false,
    });
  }
  return { trackId, observations, meanScore: 0.5, windowCoverage: 0, meanWristDistance: null };
}

function countCovered(
  kept: readonly TrackedPaddleObservation[],
  labels: Array<{ tMs: number; x: number; y: number }>,
): number {
  let covered = 0;
  for (const label of labels) {
    const near = kept.filter(
      (observation) => Math.abs(observation.timestampMs - label.tMs) <= MATCH_TOLERANCE_MS,
    );
    if (
      near.some(
        (observation) =>
          Math.hypot(observation.center.x - label.x, observation.center.y - label.y) <= HIT_RADIUS,
      )
    ) {
      covered += 1;
    }
  }
  return covered;
}

interface CaseResult {
  caseId: string;
  goldTarget: number;
  goldOther: number;
  off: { status: string; goldKept: number; wrongOwner: number; risks: string[] };
  on: { status: string; goldKept: number; wrongOwner: number; risks: string[] };
}

export function runOwnershipGuardBench(): CaseResult[] {
  const results: CaseResult[] = [];
  for (const caseId of DEV_CASES) {
    const annotationPath = join(
      PB,
      "bundles",
      caseId,
      "annotation",
      "devin-visual-v2-waveC-ownership.json",
    );
    const peoplePath = join(RUNS, caseId, "people.json");
    const metaPath = join(RUNS, caseId, "window-meta.json");
    if (!existsSync(annotationPath) || !existsSync(peoplePath) || !existsSync(metaPath)) continue;
    const annotation = JSON.parse(readFileSync(annotationPath, "utf8")) as OwnershipAnnotation;
    const targetLabels = labelPoints(annotation.paddleFrames ?? []);
    const otherLabels = labelPoints(annotation.otherPaddleFrames ?? []);
    if (targetLabels.length === 0) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      windowMs: { from: number; to: number };
    };
    const window = { startMs: meta.windowMs.from, endMs: meta.windowMs.to };
    const peopleFile = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
    const playerTracks = buildPlayerTracks(peopleFile);
    const selection = selectTargetPlayer(playerTracks, { policy: "auto" }, window);
    if (!selection.ok) continue;
    const wrists = wristSeries(targetPoseSequence(peopleFile, selection.value.target));
    const others = otherPlayersWrists(selection.value.allTracks, selection.value.target.trackId);

    const candidates: PaddleTrackCandidate[] = [
      syntheticTrack(1, targetLabels),
      ...clusterPoints(otherLabels).map((cluster, index) => syntheticTrack(2 + index, cluster)),
    ].filter((candidate) => candidate.observations.length > 0);

    const evaluate = (ownershipGuard: boolean) => {
      const outcome = selectPrimaryPaddleTrack(
        candidates.map((candidate) => ({
          ...candidate,
          observations: candidate.observations.map((observation) => ({ ...observation })),
        })),
        wrists,
        window,
        others,
        { ownershipGuard },
      );
      const kept = outcome.status === "tracked" ? outcome.lab.observations : [];
      return {
        status: outcome.status === "tracked" ? "tracked" : outcome.reason,
        goldKept: countCovered(kept, targetLabels),
        wrongOwner: countCovered(kept, otherLabels),
        risks: outcome.association?.risks ?? [],
      };
    };
    results.push({
      caseId,
      goldTarget: targetLabels.length,
      goldOther: otherLabels.length,
      off: evaluate(false),
      on: evaluate(true),
    });
  }
  return results;
}

const isMain = process.argv[1]?.endsWith("ownershipGuardBench.ts");
if (isMain) {
  const results = runOwnershipGuardBench();
  let offGold = 0;
  let onGold = 0;
  let offWrong = 0;
  let onWrong = 0;
  let gold = 0;
  console.log(
    "OWNERSHIP-GUARD GOLD REPLAY (dev wave-a ownership labels; synthetic tracks through committed points)",
  );
  for (const result of results) {
    gold += result.goldTarget;
    offGold += result.off.goldKept;
    onGold += result.on.goldKept;
    offWrong += result.off.wrongOwner;
    onWrong += result.on.wrongOwner;
    console.log(
      `  ${result.caseId}: gold ${result.goldTarget}/other ${result.goldOther} · ` +
        `OFF ${result.off.status} kept ${result.off.goldKept} wrong ${result.off.wrongOwner} · ` +
        `ON ${result.on.status} kept ${result.on.goldKept} wrong ${result.on.wrongOwner}` +
        (result.on.risks.length > 0 ? ` · risks ${result.on.risks.join(" | ")}` : ""),
    );
  }
  console.log(
    `TOTAL positive gold ${gold}: guard OFF kept ${offGold}, wrong-owner ${offWrong} → guard ON kept ${onGold}, wrong-owner ${onWrong}`,
  );
}
