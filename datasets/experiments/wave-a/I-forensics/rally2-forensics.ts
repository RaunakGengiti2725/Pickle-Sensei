/**
 * Workstream I forensics — afn-sasebo-rally2 ball candidate/fragment picture
 * around the gold contact (2620ms). Reconstructs the EXACT runtime inputs
 * (target pose sequence, tracked paddle) from the sandbox run dir, replays
 * buildBallTracks + selectPrimaryBallTrack, and dumps why every candidate
 * was rejected as primary and what exists around the occlusion.
 *
 * Run from packages/swing-lab:
 *   npx tsx ../../datasets/experiments/wave-a/I-forensics/rally2-forensics.ts <runDir>
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePoseSequence, toLegacyPoseFrames } from "@pickle/swing-domain";
import {
  BALL_GATES2,
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

const runDir = resolve(process.argv[2] ?? "../../datasets/experiments/wave-a/I-runs/afn-sasebo-rally2");
const tap = (process.argv[3] ?? "0.7923,0.702").split(",").map(Number);
const goldContactMs = Number(process.argv[4] ?? 2620);

const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"));
const window = report.window as { startMs: number; endMs: number };
const poseJson = readFileSync(join(runDir, "pose.json"), "utf8");
const parsed = parsePoseSequence(poseJson, {
  providerId: "pose.apple-vision",
  runtime: "vision_framework",
  executionTarget: "on_device",
  artifactHash: null,
});
if (!parsed.ok) throw new Error("pose parse failed");
let sequence = parsed.value;
const peopleFile = JSON.parse(readFileSync(join(runDir, "people.json"), "utf8")) as PeopleFile;
const tracks = buildPlayerTracks(peopleFile);
const seeded = initializeTargetFromSeed(tracks, {
  mode: "user_tapped_person",
  point: { x: tap[0]!, y: tap[1]! },
} as never);
if (!seeded.ok) throw new Error("seed failed");
sequence = targetPoseSequence(peopleFile, seeded.value.target);

// Paddle observations exactly as the runtime saw them (debug.json boxes).
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
const { gated, fragments, ablation } = buildBallTracks(file, sequence, window, paddle);
const outcome = selectPrimaryBallTrack(gated, ablation, window, {
  paddleTrackExists: (paddle?.length ?? 0) > 0,
  fragments,
});

const fmt = (n: number | null, d = 3) => (n === null ? "null" : n.toFixed(d));
function describe(c: BallTrackCandidate): string {
  const first = c.observations[0]!;
  const last = c.observations[c.observations.length - 1]!;
  const gates = [
    c.windowOverlapMs >= BALL_GATES2.minWindowOverlapMs ? "" : "OVERLAP",
    c.medianSpeed >= BALL_GATES2.minPrimaryMedianSpeed ? "" : "SLOW",
    c.bodyDwellFraction <= BALL_GATES2.maxBodyDwellFraction ? "" : "BODY",
    (c.minPaddleDistance !== null
      ? c.minPaddleDistance <= BALL_GATES2.maxPrimaryPaddleDistance
      : !(paddle?.length ?? 0))
      ? ""
      : "PADDLE",
  ].filter(Boolean);
  return (
    `#${String(c.trackId).padStart(3)} ${String(Math.round(first.timestampMs)).padStart(4)}-${String(Math.round(last.timestampMs)).padEnd(4)}ms ` +
    `n=${String(c.observations.length).padStart(2)} (${first.x.toFixed(3)},${first.y.toFixed(3)})→(${last.x.toFixed(3)},${last.y.toFixed(3)}) ` +
    `medSpd ${c.medianSpeed.toFixed(2)} bodyDwell ${c.bodyDwellFraction.toFixed(2)} padDist ${fmt(c.minPaddleDistance)} ` +
    `overlap ${Math.round(c.windowOverlapMs)}ms area ${Math.round(c.medianArea)} straight ${c.straightness.toFixed(2)}` +
    (gates.length ? `  REJECT[${gates.join(",")}]` : "  PRIMARY-ELIGIBLE")
  );
}

console.log(`window ${window.startMs}-${window.endMs} · gold contact ${goldContactMs}ms`);
console.log(`outcome: ${outcome.status}${outcome.status === "untracked" ? " — " + outcome.reason : ""}`);
console.log(`gated ${gated.length} · fragments ${fragments.length}`);
console.log("\n── GATED TRACKS overlapping [contact-800, contact+800] ──");
for (const c of gated) {
  const first = c.observations[0]!.timestampMs;
  const last = c.observations[c.observations.length - 1]!.timestampMs;
  if (last < goldContactMs - 800 || first > goldContactMs + 800) continue;
  console.log(describe(c));
}
console.log("\n── FRAGMENTS overlapping [contact-800, contact+800] ──");
for (const c of fragments) {
  const first = c.observations[0]!.timestampMs;
  const last = c.observations[c.observations.length - 1]!.timestampMs;
  if (last < goldContactMs - 800 || first > goldContactMs + 800) continue;
  console.log(describe(c));
}
console.log("\n── ALL GATED (whole window) sorted by overlap ──");
for (const c of [...gated].sort((a, b) => b.windowOverlapMs - a.windowOverlapMs).slice(0, 15)) console.log(describe(c));

// Target body region around contact (for the occlusion geometry).
console.log("\n── TARGET BODY around contact ──");
for (const frame of toLegacyPoseFrames(sequence)) {
  if (Math.abs(frame.timestampMs - goldContactMs) > 350) continue;
  const xs = frame.landmarks.filter((l) => l.visibility >= 0.25).map((l) => l.x);
  const ys = frame.landmarks.filter((l) => l.visibility >= 0.25).map((l) => l.y);
  if (xs.length === 0) continue;
  console.log(
    `t=${Math.round(frame.timestampMs)} body x[${Math.min(...xs).toFixed(3)},${Math.max(...xs).toFixed(3)}] y[${Math.min(...ys).toFixed(3)},${Math.max(...ys).toFixed(3)}]`,
  );
}

// Paddle location near contact.
console.log("\n── PADDLE near contact ──");
for (const p of paddle ?? []) {
  if (Math.abs(p.timestampMs - goldContactMs) > 300) continue;
  console.log(`t=${Math.round(p.timestampMs)} center (${p.center.x.toFixed(3)},${p.center.y.toFixed(3)})`);
}

// Raw candidates near the gold ball labels.
console.log("\n── RAW CANDIDATES near gold path (t within contact±450, x>0.45, y<0.45) ──");
for (const frame of file.frames) {
  if (Math.abs(frame.tMs - goldContactMs) > 450) continue;
  for (const cand of frame.candidates) {
    if (cand.x < 0.45 || cand.y > 0.45) continue;
    console.log(
      `t=${Math.round(frame.tMs)} (${cand.x.toFixed(3)},${cand.y.toFixed(3)}) area ${Math.round(cand.areaPx)} elong ${cand.elong.toFixed(1)}`,
    );
  }
}
