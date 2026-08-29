import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePoseSequence } from "@pickle/swing-domain";
import { buildPlayerTracks, targetPoseSequence, type PeopleFile } from "./playerTracker.js";
import { type ScenesFile } from "./sceneValidity.js";
import { proposeStrokeEvents } from "./strokeEvents.js";

/**
 * VIDEO MINING — the data factory front end.
 *
 *   pnpm lab:mine <video> [--out <dir>] [--max-events 40]
 *
 * Long legitimate footage → scene segmentation → multi-person tracks →
 * per-player kinematic event proposals → ranked candidate StrokeEvents with
 * uncertainty scores, so human annotation is spent where information value is
 * highest (active learning) instead of on random easy frames.
 *
 * Mining output is TIER-C CANDIDATE material: proposals, never labels. Each
 * candidate records why it was proposed and how uncertain it is.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const SWIFT_BIN = join(REPO_ROOT, "native/swing-lab/.build/release/swing-lab");

interface Candidate {
  candidateId: string;
  sceneIndex: number;
  playerTrackId: number;
  startMs: number;
  peakMs: number;
  endMs: number;
  peakSpeed: number;
  prominence: number;
  /** Higher = more informative to annotate (active-learning priority). */
  uncertainty: number;
  reasons: string[];
}

const isMain = process.argv[1]?.endsWith("mineVideo.ts");
if (isMain) {
  const positional = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const video = positional[0];
  if (!video) {
    console.error("usage: pnpm lab:mine <video> [--out <dir>] [--max-events 40]");
    process.exit(2);
  }
  const flag = (name: string) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? (process.argv[index + 1] ?? null) : null;
  };
  const videoPath = resolve(video);
  const outDir = resolve(
    flag("--out") ?? join(REPO_ROOT, "datasets/mining", basename(videoPath, ".mp4")),
  );
  const maxEvents = Number(flag("--max-events") ?? 40);
  mkdirSync(outDir, { recursive: true });

  // ── 1. Native extraction (pose + all people + scene cuts) ──────────────
  const started = Date.now();
  if (!existsSync(join(outDir, "people.json"))) {
    console.log("extracting pose + people + scenes…");
    execFileSync(SWIFT_BIN, ["extract", videoPath, "--out", outDir], { stdio: "inherit" });
  }
  const extractMs = Date.now() - started;
  const peopleFile = JSON.parse(readFileSync(join(outDir, "people.json"), "utf8")) as PeopleFile;
  const scenes = JSON.parse(readFileSync(join(outDir, "scenes.json"), "utf8")) as ScenesFile;
  const poseJson = readFileSync(join(outDir, "pose.json"), "utf8");
  const parsed = parsePoseSequence(poseJson, {
    providerId: "pose.apple-vision",
    runtime: "vision_framework",
    executionTarget: "on_device",
    artifactHash: null,
  });
  const durationSec =
    peopleFile.frames.length > 0
      ? (peopleFile.frames[peopleFile.frames.length - 1]!.t - peopleFile.frames[0]!.t) / 1000
      : 0;

  // ── 2. Mine each scene independently (never across a cut) ──────────────
  const mineStarted = Date.now();
  const candidates: Candidate[] = [];
  const usableSegments = scenes.segments.filter(
    (segment) => segment.endMs - segment.startMs >= 1500,
  );
  for (const [sceneIndex, segment] of usableSegments.entries()) {
    const sceneFrames = peopleFile.frames.filter(
      (frame) => frame.t >= segment.startMs && frame.t < segment.endMs,
    );
    if (sceneFrames.length < 20) continue;
    const sceneFile: PeopleFile = { ...peopleFile, frames: sceneFrames };
    const tracks = buildPlayerTracks(sceneFile);
    // Mine EVERY sufficiently-covered player, not only the auto target: a
    // rally contains multiple people worth labeling.
    for (const track of tracks.filter((entry) => entry.coverage >= 0.25).slice(0, 4)) {
      const sequence = targetPoseSequence(sceneFile, track);
      const wristSpeeds = dominantWristSpeeds(sequence.frames);
      const { events } = proposeStrokeEvents({
        paddleSpeeds: null,
        wristSpeeds,
        clipStartMs: segment.startMs,
        clipEndMs: segment.endMs,
      });
      for (const event of events) {
        const reasons: string[] = [];
        // Active-learning score: prefer motions that are plausible strokes but
        // NOT trivially obvious, and situations known to break the pipeline.
        let uncertainty = 0.35;
        if (event.prominence < 4) {
          uncertainty += 0.2;
          reasons.push("low prominence (is this a stroke at all?)");
        }
        if (event.peakSpeed > 2.2) {
          uncertainty += 0.15;
          reasons.push("very fast swing (blur risk)");
        }
        if (tracks.length >= 3) {
          uncertainty += 0.2;
          reasons.push(`${tracks.length} people in scene (ownership/contamination risk)`);
        }
        if (track.meanTorsoSpan < 0.08) {
          uncertainty += 0.2;
          reasons.push("small player (far court / small paddle+ball)");
        }
        if (track.lossPeriods.length > 0) {
          uncertainty += 0.15;
          reasons.push("target track has loss periods");
        }
        candidates.push({
          candidateId: `${basename(videoPath, ".mp4")}-s${sceneIndex}-p${track.trackId}-${Math.round(event.startMs)}`,
          sceneIndex,
          playerTrackId: track.trackId,
          startMs: event.startMs,
          peakMs: event.peakMs,
          endMs: event.endMs,
          peakSpeed: Number(event.peakSpeed.toFixed(3)),
          prominence: Number(event.prominence.toFixed(2)),
          uncertainty: Number(Math.min(1, uncertainty).toFixed(2)),
          reasons,
        });
      }
    }
  }
  const mineMs = Date.now() - mineStarted;
  candidates.sort((a, b) => b.uncertainty - a.uncertainty || b.prominence - a.prominence);
  const selected = candidates.slice(0, maxEvents);

  const manifest = {
    schemaVersion: 1,
    tier: "C_CANDIDATE (proposals only — NOT labels)",
    miner:
      "video-mining-1 (scene → player tracks → kinematic event proposals → uncertainty ranking)",
    video: videoPath.replace(`${REPO_ROOT}/`, ""),
    poseFramesParsed: parsed.ok ? parsed.value.frames.length : 0,
    durationSec: Number(durationSec.toFixed(1)),
    scenes: {
      cuts: scenes.cuts.length,
      segments: scenes.segments.length,
      mined: usableSegments.length,
    },
    timing: {
      extractMs,
      mineMs,
      secondsOfVideoPerSecondOfMining: Number(
        (durationSec / Math.max(0.001, (extractMs + mineMs) / 1000)).toFixed(2),
      ),
    },
    candidateCount: candidates.length,
    candidates: selected,
  };
  writeFileSync(join(outDir, "mining.json"), JSON.stringify(manifest, null, 2));

  console.log("═".repeat(66));
  console.log(`MINED ${manifest.video}`);
  console.log(
    `${durationSec.toFixed(0)}s of video · ${scenes.cuts.length} cuts · ${usableSegments.length} scenes mined · ` +
      `${candidates.length} candidate stroke events (${(candidates.length / Math.max(1, durationSec / 60)).toFixed(1)}/min)`,
  );
  console.log(
    `mining throughput: ${manifest.timing.secondsOfVideoPerSecondOfMining}s video per second of compute (pose-only pass)`,
  );
  console.log("─".repeat(66));
  console.log("TOP ANNOTATION PRIORITIES (active learning):");
  for (const candidate of selected.slice(0, 12)) {
    console.log(
      `  ${candidate.candidateId} · ${Math.round(candidate.startMs)}–${Math.round(candidate.endMs)}ms · ` +
        `unc ${candidate.uncertainty} · prom ${candidate.prominence} · ${candidate.reasons.join("; ") || "clean candidate"}`,
    );
  }
  console.log(`written: ${join(outDir, "mining.json")}`);
}

function dominantWristSpeeds(
  frames: ReadonlyArray<{
    timestampMs: number;
    landmarks: ReadonlyArray<{ name: string; x: number; y: number; visibility: number }>;
  }>,
): Array<{ timestampMs: number; value: number }> {
  const perWrist: Record<"left" | "right", Array<{ timestampMs: number; value: number }>> = {
    left: [],
    right: [],
  };
  const travel = { left: 0, right: 0 };
  const last: Record<string, { x: number; y: number } | undefined> = {};
  for (const frame of frames) {
    for (const side of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${side}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      const prior = last[side];
      if (prior) {
        const previousSample = perWrist[side][perWrist[side].length - 1];
        const dtSec = previousSample
          ? (frame.timestampMs - previousSample.timestampMs) / 1000
          : 0.04;
        const step = Math.hypot(mark.x - prior.x, mark.y - prior.y);
        if (dtSec > 0 && dtSec <= 0.15) {
          perWrist[side].push({ timestampMs: frame.timestampMs, value: step / dtSec });
          travel[side] += step;
        }
      }
      last[side] = { x: mark.x, y: mark.y };
    }
  }
  return travel.right >= travel.left ? perWrist.right : perWrist.left;
}
