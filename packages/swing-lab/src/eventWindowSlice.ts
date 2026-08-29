import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import { buildPlayerTracks, targetPoseSequence, type PeopleFile } from "./playerTracker.js";

/**
 * EVENT-WINDOW SLICER (wave-a labeling aid).
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/eventWindowSlice.ts \
 *     <srcRunDir> <fromMs> <toMs> <outRunDir> [markersOut.json]
 *
 * Emits a WINDOWED people.json (frames within [fromMs..toMs], timestamps kept
 * ABSOLUTE on the recording clock) into <outRunDir>, so a bench case can be
 * scoped to one candidate event the same way the miner's own windowing scoped
 * its per-window tracks. This is a derived VIEW of the machine pose artifact —
 * no pose values are altered; labels remain human/visual.
 *
 * Prints the window's auto-target (the bench's coverage x torsoSpan policy)
 * and its wrist-speed profile, and optionally writes a markers file (target
 * torso per frame) for render.py so the annotator can verify WHO the bench
 * will treat as target before labeling owner=target events.
 */

const [srcRunDirArg, fromArg, toArg, outRunDirArg, markersArg] = process.argv.slice(2);
if (!srcRunDirArg || !fromArg || !toArg || !outRunDirArg) {
  console.error(
    "usage: tsx src/eventWindowSlice.ts <srcRunDir> <fromMs> <toMs> <outRunDir> [markersOut.json]",
  );
  process.exit(2);
}
const abs = (p: string) => (p.startsWith("/") ? p : join(REPO_ROOT, p));
const from = Number(fromArg);
const to = Number(toArg);
const srcPath = join(abs(srcRunDirArg), "people.json");
if (!existsSync(srcPath)) {
  console.error(`missing ${srcPath}`);
  process.exit(2);
}
const people = JSON.parse(readFileSync(srcPath, "utf8")) as PeopleFile;
const frames = people.frames.filter((frame) => frame.t >= from && frame.t <= to);
const sliced: PeopleFile = {
  schemaVersion: people.schemaVersion,
  poseModelVersion: people.poseModelVersion,
  video: people.video,
  frames,
};
mkdirSync(abs(outRunDirArg), { recursive: true });
writeFileSync(join(abs(outRunDirArg), "people.json"), JSON.stringify(sliced));
writeFileSync(
  join(abs(outRunDirArg), "window-meta.json"),
  JSON.stringify(
    {
      derivedFrom: srcRunDirArg,
      windowMs: { from, to },
      note: "windowed VIEW of the source people.json (frames filtered, timestamps absolute); created for event-bounds gold labeling (wave-a)",
      createdAtIso: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const tracks = buildPlayerTracks(sliced);
if (tracks.length === 0) {
  console.error("no tracks in window");
  process.exit(1);
}
const byScore = [...tracks].sort(
  (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
);
const target = byScore[0]!;
console.log(`window ${from}-${to}ms frames=${frames.length} tracks=${tracks.length}`);
for (const track of byScore.slice(0, 5)) {
  const mid = track.frames[Math.floor(track.frames.length / 2)]!;
  console.log(
    `  track#${track.trackId}${track === target ? " (AUTO-TARGET)" : ""} cov=${track.coverage.toFixed(2)} ` +
      `span=${track.meanTorsoSpan.toFixed(3)} score=${(track.coverage * track.meanTorsoSpan).toFixed(4)} ` +
      `life=[${track.frames[0]!.timestampMs}..${track.frames[track.frames.length - 1]!.timestampMs}] ` +
      `torsoMid@${mid.timestampMs}=(${mid.torsoMid.x.toFixed(2)},${mid.torsoMid.y.toFixed(2)})`,
  );
}
const speeds = dominantWristSpeeds(targetPoseSequence(sliced, target).frames);
console.log(`auto-target wrist samples=${speeds.length}`);
const peaks = [...speeds].sort((a, b) => b.value - a.value).slice(0, 6);
console.log(
  `top wrist speeds: ${peaks.map((sample) => `${sample.timestampMs}ms=${sample.value.toFixed(2)}`).join(" · ")}`,
);

if (markersArg) {
  const points = target.frames.map((frame) => ({
    ms: frame.timestampMs,
    x: frame.torsoMid.x,
    y: frame.torsoMid.y,
    label: "T",
  }));
  writeFileSync(abs(markersArg), JSON.stringify({ points }, null, 1));
  console.log(`markers: ${markersArg} (${points.length} target torso points)`);
}
