/** rally1: selected primary + owners of gold-label-adjacent candidates. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePoseSequence } from "@pickle/swing-domain";
import {
  buildBallTracks,
  selectPrimaryBallTrack,
  type BallCandidateFile,
  type BallTrackCandidate,
} from "../../../../packages/swing-lab/src/ballTracker.js";
import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  targetPoseSequence,
  type PeopleFile,
} from "../../../../packages/swing-lab/src/playerTracker.js";

const runDir = resolve("../../datasets/experiments/wave-a/I-runs/afn-sasebo-rally1");
const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"));
const window = report.window as { startMs: number; endMs: number };
const parsed = parsePoseSequence(readFileSync(join(runDir, "pose.json"), "utf8"), {
  providerId: "pose.apple-vision",
  runtime: "vision_framework",
  executionTarget: "on_device",
  artifactHash: null,
});
if (!parsed.ok) throw new Error("pose parse failed");
const peopleFile = JSON.parse(readFileSync(join(runDir, "people.json"), "utf8")) as PeopleFile;
const seeded = initializeTargetFromSeed(buildPlayerTracks(peopleFile), {
  mode: "user_tapped_person",
  point: { x: 0.5644, y: 0.4665 },
} as never);
if (!seeded.ok) throw new Error("seed failed");
const sequence = targetPoseSequence(peopleFile, seeded.value.target);
const debug = JSON.parse(readFileSync(join(runDir, "debug.json"), "utf8"));
const paddle =
  debug.paddle?.observations?.map((o: { t: number; x: number; y: number; w: number; h: number; conf: number }) => ({
    timestampMs: o.t,
    box: { x: o.x, y: o.y, width: o.w, height: o.h },
    center: { x: o.x + o.w / 2, y: o.y + o.h / 2 },
    detectorScore: o.conf,
    trackId: debug.paddle.trackId,
    confidence: o.conf,
    nearWrist: true,
  })) ?? null;

const file = JSON.parse(readFileSync(join(runDir, "ball-candidates.json"), "utf8")) as BallCandidateFile;
const { gated, all, fragments, ablation } = buildBallTracks(file, sequence, window, paddle);
const outcome = selectPrimaryBallTrack(gated, ablation, window, {
  paddleTrackExists: (paddle?.length ?? 0) > 0,
  fragments,
});
if (outcome.status === "tracked") {
  const first = outcome.lab.observations[0]!;
  const last = outcome.lab.observations[outcome.lab.observations.length - 1]!;
  console.log(
    `PRIMARY #${outcome.lab.trackId} ${Math.round(first.timestampMs)}-${Math.round(last.timestampMs)}ms n=${outcome.lab.observations.length}`,
  );
  console.log(`timeline: ${outcome.timeline.states.map((s) => `${s.state} ${Math.round(s.fromMs)}-${Math.round(s.toMs)}`).join(" → ")}`);
  console.log(`reacq: ${JSON.stringify(outcome.timeline.reacquisition)}`);
  for (const o of outcome.lab.observations)
    console.log(`  t=${Math.round(o.timestampMs)} (${o.x.toFixed(3)},${o.y.toFixed(3)})`);
}

// Raw candidates near the four gold labels
const GOLD: Array<[number, number, number]> = [
  [2830, 0.366, 0.49],
  [2900, 0.457, 0.495],
  [2960, 0.359, 0.503],
  [3030, 0.272, 0.438],
];
console.log("\nRAW candidates within 80ms & 0.12 of gold labels:");
for (const frame of file.frames) {
  for (const [t, x, y] of GOLD) {
    if (Math.abs(frame.tMs - t) > 80) continue;
    for (const c of frame.candidates) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < 0.12)
        console.log(
          `gold@${t} ← t=${Math.round(frame.tMs)} (${c.x.toFixed(3)},${c.y.toFixed(3)}) d=${d.toFixed(3)} area ${Math.round(c.areaPx)}`,
        );
    }
  }
}
console.log("\nOwners of those candidates:");
function owners(pool: readonly BallTrackCandidate[], poolName: string) {
  for (const c of pool) {
    for (const o of c.observations) {
      for (const [t, x, y] of GOLD) {
        if (Math.abs(o.timestampMs - t) <= 80 && Math.hypot(o.x - x, o.y - y) < 0.12) {
          const f = c.observations[0]!;
          const l = c.observations[c.observations.length - 1]!;
          console.log(
            `gold@${t} ← ${poolName} #${c.trackId} obs t=${Math.round(o.timestampMs)} (${o.x.toFixed(3)},${o.y.toFixed(3)}) [track ${Math.round(f.timestampMs)}-${Math.round(l.timestampMs)} n=${c.observations.length} bodyDwell ${c.bodyDwellFraction.toFixed(2)} medSpd ${c.medianSpeed.toFixed(2)} padDist ${c.minPaddleDistance?.toFixed(3) ?? "null"}]`,
          );
        }
      }
    }
  }
}
owners(gated, "gated");
owners(fragments, "fragment");
owners(all.filter((c) => !gated.some((g) => g.trackId === c.trackId)), "assocOnly");
console.log(`\npaddle obs span: ${paddle?.[0]?.timestampMs} .. ${paddle?.[paddle.length - 1]?.timestampMs} (${paddle?.length})`);
