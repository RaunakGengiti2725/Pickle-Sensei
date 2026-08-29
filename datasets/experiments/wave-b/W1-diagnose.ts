import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePoseSequence } from "@pickle/swing-domain";
import {
  buildPaddleTracks,
  mergePaddleTracklets,
  selectPrimaryPaddleTrack,
  segmentTrackByWristOwnership,
  wristSeries,
} from "../../../packages/swing-lab/src/paddleTracker.js";
import {
  buildPlayerTracks,
  duplicateAliasesOf,
  otherPlayersWrists,
  selectTargetPlayer,
  targetPoseSequence,
  type PeopleFile,
} from "../../../packages/swing-lab/src/playerTracker.js";
import type { PaddleFrameLabel } from "../../../packages/swing-lab/src/annotationSchema.js";

/**
 * W1 DIAGNOSTIC (workstream W1 — flip-segmentation). Read-only replay of the
 * REAL selector over the waterfall configuration (merged tracklets, auto
 * target, no alias suppression) and the production configuration (raw
 * tracklets + alias suppression), dumping the winner, its recomputed score
 * terms and its gold coverage, plus the segment table for any track.
 *
 * Run: cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-b/W1-diagnose.ts <case> [trackId]
 */

const HIT_RADIUS = 0.08;
const MATCH_TOLERANCE_MS = 40;
const HERE = dirname(fileURLToPath(import.meta.url));
const PB = resolve(HERE, "../../paddle-bench");

const caseId = process.argv[2] ?? "afn-sasebo-rally1";
const segTrackId = process.argv[3] ? Number(process.argv[3]) : null;

const bench = JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
  cases: Array<{ id: string; labels: string; runDir: string; role?: string }>;
};
const benchCase = bench.cases.find((entry) => entry.id === caseId)!;
const runDir = join(PB, benchCase.runDir);
const dets = JSON.parse(readFileSync(join(runDir, "paddle-dets.json"), "utf8"));
const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as {
  window: { startMs: number; endMs: number };
};
const window = report.window;
const annotation = JSON.parse(readFileSync(join(PB, benchCase.labels), "utf8")) as {
  paddleFrames?: PaddleFrameLabel[];
};
const visibleLabels = (annotation.paddleFrames ?? []).filter(
  (label) => label.visibility === "visible" && label.point,
);

const rawCandidates = buildPaddleTracks(dets, window);
const { merged: mergedCandidates } = mergePaddleTracklets(rawCandidates, window);
const poseParsed = parsePoseSequence(readFileSync(join(runDir, "pose.json"), "utf8"), {
  providerId: "pose.apple-vision",
  runtime: "vision_framework",
  executionTarget: "on_device",
  artifactHash: null,
});
let targetSequence = poseParsed.ok ? poseParsed.value : null;
let otherWrists: ReturnType<typeof otherPlayersWrists> = [];
let aliasOtherWrists: ReturnType<typeof otherPlayersWrists> = [];
const peopleFile = JSON.parse(readFileSync(join(runDir, "people.json"), "utf8")) as PeopleFile;
const playerTracks = buildPlayerTracks(peopleFile);
const selection = selectTargetPlayer(playerTracks, { policy: "auto" }, null);
if (selection.ok && targetSequence) {
  targetSequence = targetPoseSequence(peopleFile, selection.value.target);
  otherWrists = otherPlayersWrists(selection.value.allTracks, selection.value.target.trackId);
  const aliases = duplicateAliasesOf(selection.value.target, selection.value.allTracks);
  aliasOtherWrists = otherPlayersWrists(
    selection.value.allTracks,
    selection.value.target.trackId,
    aliases,
  );
}
const wrists = targetSequence ? wristSeries(targetSequence) : [];

function goldHits(
  observations: ReadonlyArray<{ timestampMs: number; center: { x: number; y: number } }>,
): number {
  let hits = 0;
  for (const label of visibleLabels) {
    if (!label.point) continue;
    const covered = observations.some(
      (observation) =>
        Math.abs(observation.timestampMs - label.tMs) <= MATCH_TOLERANCE_MS &&
        Math.hypot(observation.center.x - label.point!.x, observation.center.y - label.point!.y) <=
          HIT_RADIUS,
    );
    if (covered) hits += 1;
  }
  return hits;
}

for (const [name, candidates, others] of [
  ["WATERFALL (merged, no alias suppression)", mergedCandidates, otherWrists],
  ["PRODUCTION (raw, alias suppression)", rawCandidates, aliasOtherWrists],
] as const) {
  const outcome = selectPrimaryPaddleTrack([...candidates], wrists, window, others);
  console.log(`── ${caseId} · ${name}`);
  if (outcome.status === "tracked") {
    console.log(
      `winner T${outcome.lab.trackId} · obs ${outcome.lab.observations.length} · cov ${outcome.lab.windowCoverage.toFixed(3)} · ` +
        `meanScore ${outcome.lab.meanScore.toFixed(3)} · wristD ${outcome.lab.meanWristDistance?.toFixed(3)} · ` +
        `gold ${goldHits(outcome.lab.observations)}/${visibleLabels.length} · switches ${outcome.association.switchEvents.length}`,
    );
  } else {
    console.log(`untracked: ${outcome.reason}`);
  }
  const ranked = outcome.allTracks.slice(0, 8);
  for (const candidate of ranked) {
    console.log(
      `  T${String(candidate.trackId).padEnd(4)} obs ${String(candidate.observations.length).padStart(4)} · cov ${candidate.windowCoverage.toFixed(3)} · ` +
        `meanScore ${candidate.meanScore.toFixed(3)} · wristD ${candidate.meanWristDistance === null ? " null" : candidate.meanWristDistance.toFixed(3)} · ` +
        `gold ${goldHits(candidate.observations)}`,
    );
  }
  if (segTrackId !== null) {
    const track = candidates.find((candidate) => candidate.trackId === segTrackId);
    if (track) {
      for (const segment of segmentTrackByWristOwnership(
        track.observations,
        wrists,
        others,
        window,
      )) {
        console.log(
          `  T${segTrackId} seg ${Math.round(segment.startMs)}–${Math.round(segment.endMs)} · n ${segment.observations.length} · ` +
            `flipRun ${segment.sustainedFlipRun} · ownedByOther ${segment.ownedByOtherPlayer} · ` +
            `tD ${segment.meanTargetWristDistance?.toFixed(3)} · oD ${segment.meanOtherWristDistance?.toFixed(3)} · gold ${goldHits(segment.observations)}`,
        );
      }
    }
  }
}
