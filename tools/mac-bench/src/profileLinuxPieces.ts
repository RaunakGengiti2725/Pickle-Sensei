import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planTwoPassSchedule,
  type PaddleTrackCandidate,
  type TwoPassSchedule,
} from "@pickle/swing-lab";

/**
 * profileLinuxPieces — measures the Linux-measurable pieces of the Mac bench
 * pipeline so the eventual Mac run has a same-methodology baseline for the
 * non-Apple stages.
 *
 *   pnpm --filter @pickle/mac-bench profile:linux [--out <json>] [--iterations N]
 *
 * MEASUREMENT BOUNDARY (stated in the output document):
 *  - This is NOT the Mac benchmark. Nothing here touches Apple Vision pose
 *    extraction, the Swift extractor, the D-FINE detector, lab:regen, or
 *    lab:cascade. Numbers are LINUX-CPU-NOT-MAC and never substitute for the
 *    Mac results document.
 *  - Video inputs are ONLY the committed event-window bundle clips that are
 *    not held out (afn-sasebo-rally1, wm-volley-02). The held-out cases
 *    wm-dink-01 and afn-vic-rally1 are excluded by name.
 *  - The two-pass schedule profile runs the REAL planner
 *    (planTwoPassSchedule, paddle-two-pass-1) over SYNTHETIC sparse-track
 *    input derived from real clip metadata — it measures scheduling
 *    mechanics (planned invocation/frame counts and plan wall time), not
 *    detector accuracy, and the document labels the input synthetic.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const HELD_OUT_CASE_IDS = ["wm-dink-01", "afn-vic-rally1"] as const;
const PROFILE_CLIPS = [
  "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4",
  "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4",
] as const;
const PROFILE_JSON_ARTIFACTS = [
  "datasets/cascade/cascade-1787996827490.json",
  "datasets/paddle-bench/regen-manifest.json",
  "tools/mac-bench/test/fixtures/mac-bench-results.fixture.json",
] as const;

interface TimedSummary {
  iterations: number;
  wallMsPerIteration: number[];
  minMs: number;
  maxMs: number;
  meanMs: number;
}

function timed(iterations: number, run: () => void): TimedSummary {
  const wallMsPerIteration: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    run();
    wallMsPerIteration.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const meanMs =
    wallMsPerIteration.reduce((total, value) => total + value, 0) / wallMsPerIteration.length;
  return {
    iterations,
    wallMsPerIteration: wallMsPerIteration.map((value) => Math.round(value * 100) / 100),
    minMs: Math.round(Math.min(...wallMsPerIteration) * 100) / 100,
    maxMs: Math.round(Math.max(...wallMsPerIteration) * 100) / 100,
    meanMs: Math.round(meanMs * 100) / 100,
  };
}

function ffprobeMeta(video: string): {
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  nbFrames: number | null;
} {
  const raw = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,nb_frames,duration",
      "-of",
      "json",
      video,
    ],
    { encoding: "utf8" },
  );
  const stream = (
    JSON.parse(raw) as {
      streams: Array<{
        width: number;
        height: number;
        r_frame_rate: string;
        nb_frames?: string;
        duration?: string;
      }>;
    }
  ).streams[0];
  if (!stream) throw new Error(`ffprobe: no video stream in ${video}`);
  const [num, den] = stream.r_frame_rate.split("/").map(Number);
  const fps = (num ?? 0) / (den ?? 1);
  const nbFrames = stream.nb_frames ? Number(stream.nb_frames) : null;
  return {
    durationMs: Math.round(Number(stream.duration ?? "0") * 1000),
    fps,
    width: stream.width,
    height: stream.height,
    nbFrames: Number.isFinite(nbFrames) ? nbFrames : null,
  };
}

/** Synthetic-but-metadata-derived sparse track: one observation per sparse
 * frame across the middle 80% of the clip, confidence 0.5 with a dip below
 * the 0.3 low-confidence gate near the clip midpoint (forces at least one
 * uncertainty anchor, matching the H failure shape). SYNTHETIC — labeled. */
function syntheticSparseTrack(
  durationMs: number,
  frameIntervalMs: number,
  stride: number,
): PaddleTrackCandidate {
  const startMs = durationMs * 0.1;
  const endMs = durationMs * 0.9;
  const observations: PaddleTrackCandidate["observations"] = [];
  for (let tMs = startMs; tMs <= endMs; tMs += frameIntervalMs * stride) {
    const nearMidpoint = Math.abs(tMs - durationMs / 2) < frameIntervalMs * stride * 2;
    observations.push({
      timestampMs: tMs,
      box: { x: 0.45, y: 0.45, width: 0.1, height: 0.1 },
      center: { x: 0.5, y: 0.5 },
      detectorScore: nearMidpoint ? 0.2 : 0.5,
      trackId: 1,
      confidence: nearMidpoint ? 0.2 : 0.5,
      nearWrist: true,
    });
  }
  return {
    trackId: 1,
    observations,
    meanScore: 0.5,
    windowCoverage: 0.8,
    meanWristDistance: null,
  };
}

function flagValue(name: string, argv: readonly string[]): string | null {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return null;
  return argv[index + 1] ?? null;
}

const argv = process.argv.slice(2);
const iterations = Number(flagValue("--iterations", argv) ?? "5");
const outPath =
  flagValue("--out", argv) ?? join(REPO_ROOT, "datasets/experiments/wave-g/g24-linux-profile.json");

for (const clip of PROFILE_CLIPS) {
  for (const heldOut of HELD_OUT_CASE_IDS) {
    if (clip.includes(heldOut)) throw new Error(`held-out case in profile clip list: ${clip}`);
  }
}

const scratchRoot = mkdtempSync(join(tmpdir(), "g24-profile-"));
const clips = PROFILE_CLIPS.map((relative) => {
  const video = join(REPO_ROOT, relative);
  const meta = ffprobeMeta(video);
  const clipBytes = statSync(video).size;

  const probe = timed(iterations, () => {
    ffprobeMeta(video);
  });

  const fullDecode = timed(Math.min(iterations, 3), () => {
    execFileSync("ffmpeg", ["-v", "error", "-i", video, "-f", "null", "-"], { stdio: "ignore" });
  });

  // Frame extraction the way detect_paddle.py consumes windows: decode to
  // image frames on disk (JPEG q2), full clip, native fps.
  const framesDir = join(scratchRoot, relative.replaceAll("/", "_"));
  let extractedFrames = 0;
  let extractedBytes = 0;
  const frameExtract = timed(Math.min(iterations, 3), () => {
    rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", video, "-q:v", "2", join(framesDir, "frame-%05d.jpg")],
      { stdio: "ignore" },
    );
    const frames = readdirSync(framesDir);
    extractedFrames = frames.length;
    extractedBytes = frames.reduce(
      (total, frame) => total + statSync(join(framesDir, frame)).size,
      0,
    );
  });

  const readIo = timed(iterations, () => {
    readFileSync(video);
  });

  return {
    clip: relative,
    meta,
    clipBytes,
    ffprobeMetadataMs: probe,
    fullDecodeToNullMs: fullDecode,
    frameExtractJpegMs: frameExtract,
    extractedFrames,
    extractedBytes,
    readWholeFileMs: readIo,
  };
});

const jsonArtifacts = PROFILE_JSON_ARTIFACTS.map((relative) => {
  const path = join(REPO_ROOT, relative);
  const content = readFileSync(path, "utf8");
  const parse = timed(Math.max(iterations, 20), () => {
    JSON.parse(content);
  });
  const document = JSON.parse(content) as unknown;
  const stringify = timed(Math.max(iterations, 20), () => {
    JSON.stringify(document);
  });
  const roundTripWrite = timed(iterations, () => {
    writeFileSync(join(scratchRoot, "json-roundtrip.json"), JSON.stringify(document));
  });
  return { artifact: relative, bytes: content.length, parse, stringify, roundTripWrite };
});

// Two-pass paddle schedule mechanics over synthetic sparse tracks derived
// from each real clip's metadata (fps, duration). SYNTHETIC INPUT — measures
// plan wall time and planned invocation/frame counts only.
const schedulePlans = clips.map((clip) => {
  const frameIntervalMs = 1000 / clip.meta.fps;
  const stride = 3;
  const track = syntheticSparseTrack(clip.meta.durationMs, frameIntervalMs, stride);
  const input = {
    detectSpan: { startMs: 0, endMs: clip.meta.durationMs },
    frameIntervalMs,
    primaryTrack: track,
    paddleSpeeds: track.observations.map((observation, index) => ({
      timestampMs: observation.timestampMs,
      value: index % 7 === 0 ? 2.5 : 0.5,
    })),
    eventPeaksMs: [clip.meta.durationMs / 2],
  };
  let plan: TwoPassSchedule | null = null;
  const planTime = timed(Math.max(iterations * 40, 200), () => {
    plan = planTwoPassSchedule(input);
  });
  const schedule = plan as unknown as TwoPassSchedule;
  return {
    clip: clip.clip,
    inputProvenance: "SYNTHETIC sparse track derived from real clip metadata (fps, durationMs)",
    scheduleVersion: schedule.version,
    planWallMs: planTime,
    planned: schedule.planned,
    denseRegions: schedule.denseRegions.length,
    detectorProcessInvocations: {
      twoPass: 1 + schedule.denseRegions.length,
      singlePass: 1,
      note: "analyzeVideo two-pass = 1 sparse invocation + one per dense region; default path = 1 stride-1 invocation (or 1 per tight segment)",
    },
  };
});

const document = {
  generatedAtIso: new Date().toISOString(),
  boundary:
    "LINUX-CPU-NOT-MAC. Profiles only the Linux-measurable pieces (ffprobe/ffmpeg decode, frame extraction, file I/O, JSON serialization, two-pass schedule mechanics). No Apple Vision, no Swift extractor, no D-FINE detector, no lab:regen/lab:cascade. NOT a substitute for the Mac results document.",
  heldOutExcluded: HELD_OUT_CASE_IDS,
  host: {
    platform: process.platform,
    nodeVersion: process.version,
    ffmpegVersion:
      execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0] ?? "unknown",
  },
  provenance: {
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim(),
    gitBranch: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim(),
  },
  clips,
  jsonArtifacts,
  twoPassScheduleMechanics: schedulePlans,
};

rmSync(scratchRoot, { recursive: true, force: true });
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`written: ${outPath}`);
