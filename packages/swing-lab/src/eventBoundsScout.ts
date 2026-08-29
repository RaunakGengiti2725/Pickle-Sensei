import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import { buildPlayerTracks, targetPoseSequence, type PeopleFile } from "./playerTracker.js";

/**
 * EVENT-BOUNDS SCOUT (wave-a labeling aid, read-only).
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/eventBoundsScout.ts <runDir> [windows a-b,c-d ...]
 *
 * Replicates EXACTLY what eventCompletionBench computes for a runDir:
 *  - whole-file player tracks, AUTO target = max(coverage × meanTorsoSpan)
 *  - the auto target's dominant-wrist speed series
 * and reports, for requested candidate windows (ms), how many wrist samples
 * fall inside, the in-window wrist peak, and the target's torso position
 * around the window — so a human annotator can (1) know whether a labeled
 * event would be USABLE by the bench and (2) find the target in rendered
 * frames before labeling. This tool writes NO labels.
 */

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: tsx src/eventBoundsScout.ts <runDir-with-people.json> [startMs-endMs ...]");
  process.exit(2);
}
const peoplePath = join(runDir.startsWith("/") ? runDir : join(REPO_ROOT, runDir), "people.json");
if (!existsSync(peoplePath)) {
  console.error(`missing ${peoplePath}`);
  process.exit(2);
}
const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
const tracks = buildPlayerTracks(people);
if (tracks.length === 0) {
  console.error("no tracks");
  process.exit(1);
}
const target = [...tracks].sort(
  (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
)[0]!;
const speeds = dominantWristSpeeds(targetPoseSequence(people, target).frames);
console.log(
  `tracks=${tracks.length} autoTarget=track#${target.trackId} coverage=${target.coverage.toFixed(3)} ` +
    `meanTorsoSpan=${target.meanTorsoSpan.toFixed(4)} frames=${target.frames.length} ` +
    `spanMs=[${target.frames[0]!.timestampMs}..${target.frames[target.frames.length - 1]!.timestampMs}] ` +
    `wristSamples=${speeds.length}`,
);
const others = tracks
  .filter((track) => track.trackId !== target.trackId)
  .slice(0, 6)
  .map(
    (track) =>
      `#${track.trackId} cov=${track.coverage.toFixed(2)} span=${track.meanTorsoSpan.toFixed(3)} ` +
      `[${track.frames[0]!.timestampMs}..${track.frames[track.frames.length - 1]!.timestampMs}]`,
  );
console.log(`runner-ups: ${others.join(" · ") || "none"}`);

const windows = process.argv.slice(3).flatMap((argument) => argument.split(","));
const dump: object[] = [];
for (const window of windows) {
  const [fromRaw, toRaw] = window.split("-");
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
  const inWindow = speeds.filter(
    (sample) => sample.timestampMs >= from && sample.timestampMs <= to,
  );
  const peak =
    inWindow.length > 0
      ? inWindow.reduce((best, sample) => (sample.value > best.value ? sample : best))
      : null;
  const torsoNear = (ms: number) => {
    const frame = [...target.frames].sort(
      (a, b) => Math.abs(a.timestampMs - ms) - Math.abs(b.timestampMs - ms),
    )[0];
    return frame
      ? {
          atMs: frame.timestampMs,
          x: Number(frame.torsoMid.x.toFixed(3)),
          y: Number(frame.torsoMid.y.toFixed(3)),
        }
      : null;
  };
  const row = {
    window: `${from}-${to}`,
    targetWristSamplesInside: inWindow.length,
    usableByBench: inWindow.length >= 3,
    inWindowPeak: peak ? { tMs: peak.timestampMs, speed: Number(peak.value.toFixed(3)) } : null,
    targetTorso: { start: torsoNear(from), mid: torsoNear((from + to) / 2), end: torsoNear(to) },
  };
  dump.push(row);
  console.log(JSON.stringify(row));
}
if (process.env.SCOUT_OUT) writeFileSync(process.env.SCOUT_OUT, JSON.stringify(dump, null, 2));
