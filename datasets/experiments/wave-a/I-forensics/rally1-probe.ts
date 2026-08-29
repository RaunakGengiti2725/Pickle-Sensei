/** rally1 attribution probe: is the selected primary in body-occlusion mode?
 * (If not, every linking decision runs the legacy branches, byte-identical
 * to the pre-change tracker — any sandbox-vs-canonical delta is estimator
 * drift in the working tree, not workstream I.) */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePoseSequence } from "@pickle/swing-domain";
import {
  buildBallTracks,
  selectPrimaryBallTrack,
  type BallCandidateFile,
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
  debug.paddle?.observations?.map(
    (o: { t: number; x: number; y: number; w: number; h: number; conf: number }) => ({
      timestampMs: o.t,
      box: { x: o.x, y: o.y, width: o.w, height: o.h },
      center: { x: o.x + o.w / 2, y: o.y + o.h / 2 },
      detectorScore: o.conf,
      trackId: debug.paddle.trackId,
      confidence: o.conf,
      nearWrist: true,
    }),
  ) ?? null;
const file = JSON.parse(
  readFileSync(join(runDir, "ball-candidates.json"), "utf8"),
) as BallCandidateFile;
const { gated, fragments, ablation } = buildBallTracks(file, sequence, window, paddle);
const outcome = selectPrimaryBallTrack(gated, ablation, window, {
  paddleTrackExists: (paddle?.length ?? 0) > 0,
  fragments,
});
if (outcome.status === "tracked") {
  console.log("primary #", outcome.lab.trackId, "selection:", outcome.selection);
  console.log("bodyOcclusion:", JSON.stringify(outcome.lab.bodyOcclusion));
  console.log("first-pass timeline:", outcome.timeline.states.map((s) => s.state).join(" → "));
  console.log("first-pass reacq:", JSON.stringify(outcome.timeline.reacquisition));
}
