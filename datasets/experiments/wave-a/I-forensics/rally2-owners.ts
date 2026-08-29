/** Which internal tracks own the true-ball trail points in rally2? */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePoseSequence } from "@pickle/swing-domain";
import {
  buildBallTracks,
  type BallCandidateFile,
  type BallTrackCandidate,
} from "../../../../packages/swing-lab/src/ballTracker.js";
import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  targetPoseSequence,
  type PeopleFile,
} from "../../../../packages/swing-lab/src/playerTracker.js";

const runDir = resolve(process.argv[2] ?? "../../datasets/experiments/wave-a/I-runs/afn-sasebo-rally2");
const tap = (process.argv[3] ?? "0.7923,0.702").split(",").map(Number);

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
const tracks = buildPlayerTracks(peopleFile);
const seeded = initializeTargetFromSeed(tracks, {
  mode: "user_tapped_person",
  point: { x: tap[0]!, y: tap[1]! },
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
const { gated, all, fragments } = buildBallTracks(file, sequence, window, paddle);

const POINTS: Array<[number, number, number]> = [
  [2404, 0.546, 0.16],
  [2438, 0.564, 0.164],
  [2471, 0.583, 0.168],
  [2504, 0.56, 0.19],
  [2504, 0.594, 0.169],
  [2538, 0.624, 0.19],
  [2571, 0.645, 0.202],
  [2605, 0.667, 0.219],
  [2638, 0.69, 0.239],
];

function owners(pool: readonly BallTrackCandidate[], poolName: string) {
  for (const [t, x, y] of POINTS) {
    for (const c of pool) {
      for (const o of c.observations) {
        if (Math.abs(o.timestampMs - t) <= 5 && Math.hypot(o.x - x, o.y - y) < 0.01) {
          console.log(
            `point t=${t} (${x},${y}) → ${poolName} #${c.trackId} [${Math.round(c.observations[0]!.timestampMs)}-${Math.round(c.observations[c.observations.length - 1]!.timestampMs)} n=${c.observations.length} bodyDwell ${c.bodyDwellFraction.toFixed(2)}]`,
          );
        }
      }
    }
  }
}
owners(gated, "gated");
owners(fragments, "fragment");
owners(
  all.filter((c) => !gated.some((g) => g.trackId === c.trackId)),
  "assoc-only(failed stage C)",
);

for (const id of [121, 165, 262, 297, 248, 274, 249]) {
  const c = [...gated, ...fragments, ...all].find((k) => k.trackId === id);
  if (!c) continue;
  console.log(`\n#${id} obs:`);
  for (const o of c.observations)
    console.log(`  t=${Math.round(o.timestampMs)} (${o.x.toFixed(3)},${o.y.toFixed(3)}) area ${Math.round(o.areaPx)}`);
}
