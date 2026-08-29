import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePoseSequence } from "@pickle/swing-domain";
import type { PaddleFrameLabel } from "./annotationSchema.js";
import {
  buildPaddleTracks,
  selectPrimaryPaddleTrack,
  wristSeries,
  type PaddleTrackCandidate,
  mergePaddleTracklets,
  type RawPaddleDetectionFile,
} from "./paddleTracker.js";
import {
  buildPlayerTracks,
  otherPlayersWrists,
  selectTargetPlayer,
  targetPoseSequence,
  type PeopleFile,
} from "./playerTracker.js";

/**
 * PADDLE QUALITY-LOSS WATERFALL — forensic accounting of where recall dies.
 *
 * Measurement (2026-08-28): the raw D-FINE COCO proxy finds the paddle in
 * 27/27 visible labeled frames (R 1.00), but the end-to-end pipeline reports
 * R ~0.37. This tool replays the REAL pipeline stages against the SAME labels
 * and reports precision/recall after each stage, so the loss is localized to
 * a stage instead of blamed on the model.
 *
 *   pnpm lab:paddle-waterfall
 *
 * Stages
 *  S0 raw detector          every racket detection in the matched frame
 *  S1 candidate filter      score/size gates that admit detections to tracking
 *  S2 track formation       observations that survived association into tracks
 *  S3 ownership filter      tracks not rejected as another player's paddle
 *  S4 primary selection     the single selected track
 *  S5 final PaddleTrack     what the canonical analysis actually consumes
 */

const HIT_RADIUS = 0.08;
const MATCH_TOLERANCE_MS = 40;
const HERE = dirname(fileURLToPath(import.meta.url));
const PB = resolve(HERE, "../../../datasets/paddle-bench");

interface StageScore {
  stage: string;
  hits: number;
  visible: number;
  claims: number;
  precision: number | null;
  recall: number | null;
}

function score(
  stage: string,
  labels: readonly PaddleFrameLabel[],
  centers: ReadonlyArray<{ tMs: number; x: number; y: number }>,
): StageScore {
  let hits = 0;
  let visible = 0;
  let claims = 0;
  for (const label of labels) {
    const near = centers.filter((center) => Math.abs(center.tMs - label.tMs) <= MATCH_TOLERANCE_MS);
    if (label.visibility === "visible" && label.point) {
      visible += 1;
      if (near.length > 0) {
        claims += 1;
        const best = Math.min(
          ...near.map((center) => Math.hypot(center.x - label.point!.x, center.y - label.point!.y)),
        );
        if (best <= HIT_RADIUS) hits += 1;
      }
    } else if (near.length > 0) {
      claims += 1;
    }
  }
  return {
    stage,
    hits,
    visible,
    claims,
    precision: claims > 0 ? hits / claims : null,
    recall: visible > 0 ? hits / visible : null,
  };
}

const observationsToCenters = (candidates: readonly PaddleTrackCandidate[]) =>
  candidates.flatMap((candidate) =>
    candidate.observations.map((observation) => ({
      tMs: observation.timestampMs,
      x: observation.center.x,
      y: observation.center.y,
    })),
  );

const isMain = process.argv[1]?.endsWith("paddleWaterfall.ts");
if (isMain) {
  const bench = JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
    cases: Array<{ id: string; labels: string; runDir: string; role?: string }>;
  };
  const totals = new Map<string, StageScore>();
  const mergeStats: Array<{ caseId: string; before: number; after: number; links: number }> = [];
  const oracles: Array<{
    caseId: string;
    visible: number;
    oracleSelection: number;
    oracleMerge: number;
    contributingTracks: number;
    totalTracks: number;
  }> = [];
  const perCase: Array<{ id: string; role: string; stages: StageScore[] }> = [];

  const devOnly = process.argv.includes("--dev-only");
  const heldOnly = process.argv.includes("--held-out-only");
  for (const benchCase of bench.cases) {
    const role = benchCase.role ?? "unassigned";
    const isHeldOut = role.includes("held_out");
    if (devOnly && isHeldOut) continue;
    if (heldOnly && !isHeldOut) continue;
    const runDir = join(PB, benchCase.runDir);
    const detsPath = join(runDir, "paddle-dets.json");
    const posePath = join(runDir, "pose.json");
    const peoplePath = join(runDir, "people.json");
    const reportPath = join(runDir, "report.json");
    if (!existsSync(detsPath) || !existsSync(posePath) || !existsSync(reportPath)) continue;
    const annotation = JSON.parse(readFileSync(join(PB, benchCase.labels), "utf8")) as {
      paddleFrames?: PaddleFrameLabel[];
    };
    const labels = annotation.paddleFrames ?? [];
    if (labels.length === 0) continue;
    const dets = JSON.parse(readFileSync(detsPath, "utf8")) as RawPaddleDetectionFile;
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      window?: { startMs: number; endMs: number } | null;
      detectSpan?: { startMs: number; endMs: number } | null;
    };
    const window = report.window ?? { startMs: 0, endMs: 1e9 };

    // ── S0 raw detector ────────────────────────────────────────────────
    const { width, height } = dets.video;
    const raw = dets.frames.flatMap((frame) =>
      frame.detections.map((detection) => ({
        tMs: frame.tMs,
        score: detection.score,
        x: (detection.box[0] + detection.box[2]) / 2 / width,
        y: (detection.box[1] + detection.box[3]) / 2 / height,
        w: (detection.box[2] - detection.box[0]) / width,
        h: (detection.box[3] - detection.box[1]) / height,
      })),
    );
    // ── S1 candidate filter (the tracker's admission gates) ────────────
    const admitted = raw.filter((detection) => detection.score >= 0.15);
    // ── S2 track formation ─────────────────────────────────────────────
    const rawCandidates = buildPaddleTracks(dets, window);
    const { merged: candidates, links } = mergePaddleTracklets(rawCandidates, window);
    mergeStats.push({
      caseId: benchCase.id,
      before: rawCandidates.length,
      after: candidates.length,
      links,
    });
    // ── S3/S4 ownership + primary selection (real code path) ───────────
    const poseParsed = parsePoseSequence(readFileSync(posePath, "utf8"), {
      providerId: "pose.apple-vision",
      runtime: "vision_framework",
      executionTarget: "on_device",
      artifactHash: null,
    });
    let targetSequence = poseParsed.ok ? poseParsed.value : null;
    let otherWrists: ReturnType<typeof otherPlayersWrists> = [];
    if (existsSync(peoplePath) && targetSequence) {
      const peopleFile = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
      const tracks = buildPlayerTracks(peopleFile);
      const selection = selectTargetPlayer(tracks, { policy: "auto" }, null);
      if (selection.ok) {
        targetSequence = targetPoseSequence(peopleFile, selection.value.target);
        otherWrists = otherPlayersWrists(selection.value.allTracks, selection.value.target.trackId);
      }
    }
    const wrists = targetSequence ? wristSeries(targetSequence) : [];
    const outcome = selectPrimaryPaddleTrack(candidates, wrists, window, otherWrists);
    const ownershipSurvivors = candidates.filter(
      (candidate) =>
        !outcome.association ||
        outcome.association.rejectedOtherPlayerTracks === 0 ||
        (outcome.status === "tracked" && candidate.trackId === outcome.lab.trackId),
    );
    const primary = outcome.status === "tracked" ? [outcome.lab] : [];

    // ── S5 final canonical PaddleTrack ─────────────────────────────────
    const debugPath = join(runDir, "debug.json");
    const finalCenters: Array<{ tMs: number; x: number; y: number }> = [];
    if (existsSync(debugPath)) {
      const debug = JSON.parse(readFileSync(debugPath, "utf8")) as {
        paddle: {
          observations: Array<{ t: number; x: number; y: number; w: number; h: number }>;
        } | null;
      };
      for (const observation of debug.paddle?.observations ?? []) {
        finalCenters.push({
          tMs: observation.t,
          x: observation.x + observation.w / 2,
          y: observation.y + observation.h / 2,
        });
      }
    }

    // ── ORACLE studies (evaluation only — never runtime) ───────────────
    // O1: best achievable if primary SELECTION were perfect (pick the single
    //     best existing track). O2: best achievable if FRAGMENT MERGING were
    //     perfect (union of every track that touches the true paddle).
    const visibleLabels = labels.filter((label) => label.visibility === "visible" && label.point);
    const trackHits = candidates.map((candidate) => {
      const centers = observationsToCenters([candidate]);
      const hit = new Set<number>();
      for (const [index, label] of visibleLabels.entries()) {
        const near = centers.filter(
          (center) => Math.abs(center.tMs - label.tMs) <= MATCH_TOLERANCE_MS,
        );
        if (
          near.some(
            (center) =>
              Math.hypot(center.x - label.point!.x, center.y - label.point!.y) <= HIT_RADIUS,
          )
        ) {
          hit.add(index);
        }
      }
      return { candidate, hit };
    });
    const oracleSelectionHits = Math.max(0, ...trackHits.map((entry) => entry.hit.size));
    const oracleMergeSet = new Set<number>();
    let contributingTracks = 0;
    for (const entry of trackHits) {
      if (entry.hit.size === 0) continue;
      contributingTracks += 1;
      for (const index of entry.hit) oracleMergeSet.add(index);
    }
    oracles.push({
      caseId: benchCase.id,
      visible: visibleLabels.length,
      oracleSelection: oracleSelectionHits,
      oracleMerge: oracleMergeSet.size,
      contributingTracks,
      totalTracks: candidates.length,
    });

    const stages: StageScore[] = [
      score("S0 raw detector", labels, raw),
      score("S1 candidate filter", labels, admitted),
      score("S2 track formation", labels, observationsToCenters(rawCandidates)),
      score("S2b tracklet merge", labels, observationsToCenters(candidates)),
      score("S3 ownership filter", labels, observationsToCenters(ownershipSurvivors)),
      score("S4 primary selection", labels, observationsToCenters(primary)),
      score("S5 final PaddleTrack", labels, finalCenters),
    ];
    perCase.push({ id: benchCase.id, role: benchCase.role ?? "unassigned", stages });
    for (const stage of stages) {
      const running = totals.get(stage.stage) ?? {
        stage: stage.stage,
        hits: 0,
        visible: 0,
        claims: 0,
        precision: null,
        recall: null,
      };
      running.hits += stage.hits;
      running.visible += stage.visible;
      running.claims += stage.claims;
      totals.set(stage.stage, running);
    }
  }

  console.log("═".repeat(74));
  console.log("PADDLE QUALITY-LOSS WATERFALL — real pipeline stages, same labeled frames");
  console.log(
    `cases ${perCase.length}${devOnly ? " [DEVELOPMENT ONLY — tuning permitted]" : heldOnly ? " [HELD-OUT ONLY — no tuning]" : " [ALL]"} · ` +
      `hit radius ${HIT_RADIUS} · match ±${MATCH_TOLERANCE_MS}ms`,
  );
  console.log("═".repeat(74));
  const fmt = (value: number | null) => (value === null ? " n/a" : value.toFixed(2));
  let previousRecall: number | null = null;
  for (const [stageName, running] of totals) {
    const recall = running.visible > 0 ? running.hits / running.visible : null;
    const precision = running.claims > 0 ? running.hits / running.claims : null;
    const delta =
      previousRecall !== null && recall !== null
        ? `  Δrecall ${recall - previousRecall >= 0 ? "+" : ""}${(recall - previousRecall).toFixed(2)}`
        : "";
    console.log(
      `${stageName.padEnd(24)} P ${fmt(precision)} · R ${fmt(recall)} · hits ${running.hits}/${running.visible} · claims ${running.claims}${delta}`,
    );
    previousRecall = recall;
  }
  console.log("─".repeat(74));
  console.log("TRACKLET MERGE:");
  for (const stat of mergeStats) {
    console.log(
      `  ${stat.caseId}: ${stat.before} tracklets → ${stat.after} hypotheses (${stat.links} links)`,
    );
  }
  console.log("─".repeat(74));
  console.log("ORACLE CEILINGS (evaluation only — never runtime):");
  let selectionTotal = 0;
  let mergeTotal = 0;
  let visibleTotal = 0;
  for (const oracle of oracles) {
    selectionTotal += oracle.oracleSelection;
    mergeTotal += oracle.oracleMerge;
    visibleTotal += oracle.visible;
    console.log(
      `  ${oracle.caseId}: perfect-selection ${oracle.oracleSelection}/${oracle.visible} · ` +
        `perfect-merge ${oracle.oracleMerge}/${oracle.visible} · ` +
        `${oracle.contributingTracks} of ${oracle.totalTracks} tracks touch the true paddle`,
    );
  }
  console.log(
    `  CEILING: perfect selection R ${(selectionTotal / Math.max(1, visibleTotal)).toFixed(2)} · ` +
      `perfect fragment merge R ${(mergeTotal / Math.max(1, visibleTotal)).toFixed(2)} ` +
      `(current S5 R ${((totals.get("S5 final PaddleTrack")?.hits ?? 0) / Math.max(1, visibleTotal)).toFixed(2)})`,
  );
  console.log("─".repeat(74));
  console.log("PER CASE (recall by stage):");
  for (const entry of perCase) {
    console.log(
      `  ${entry.id} [${entry.role}]: ` +
        entry.stages.map((stage) => `${stage.stage.slice(0, 2)} ${fmt(stage.recall)}`).join(" → "),
    );
  }
}
