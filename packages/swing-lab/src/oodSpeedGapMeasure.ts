import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchExcludedCaseIds, heldOutCaseIds, loadHoldoutLedger } from "./holdoutRotation.js";

/**
 * F10 speed-gap experiment: measures pose-free TEMPORAL signals over the
 * committed positive corpus, the fresh-candidate coverage floor, and
 * speed-resampled variants (1.5x / 2x / 3x, built with the exact ffmpeg
 * recipe the red-team fixture uses) of the non-held-out committed clips.
 *
 * Signals measured per clip:
 *  - motion magnitude: inter-frame mean-abs-diff distribution (64x36 gray)
 *  - temporal smoothness: lag-2 / lag-1 median diff ratio
 *  - inter-frame timing: container frame-timestamp delta statistics
 *  - optical-flow proxy: block-matching velocity distribution (128x72 gray)
 *
 * Held-out cases (per datasets/holdouts/ledger.json — the governed holdouts
 * and their designated SHADOW_HOLDOUT successors) are never read. Fresh
 * candidates are measured for verification only (would a candidate signal
 * falsely reject them) — no thresholds are fit to them.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOLDOUT_LEDGER = loadHoldoutLedger(repoRoot);
const HELD_OUT = new Set(heldOutCaseIds(HOLDOUT_LEDGER));
const LEDGER_EXCLUDED = new Set(benchExcludedCaseIds(HOLDOUT_LEDGER));
const TUNE_POSITIVES = ["afn-sasebo-rally1", "wm-volley-02"];
const SPEED_FACTORS = [1.5, 2, 3];
/** Bound decode work on long fresh candidates; deterministic prefix. */
const MAX_ANALYSIS_SECONDS = 60;

const DIFF_WIDTH = 64;
const DIFF_HEIGHT = 36;
const FLOW_WIDTH = 128;
const FLOW_HEIGHT = 72;
const FLOW_BLOCK = 8;
const FLOW_SEARCH_RADIUS = 7;
/** Blocks with spatial std at or below this carry no texture to match. */
const FLOW_MIN_BLOCK_STD = 4;

export interface SpeedGapMeasurement {
  id: string;
  group: "tune_positive" | "fresh_candidate" | "speed_variant";
  speedFactor: number | null;
  sourceId: string | null;
  frameCount: number;
  fps: number | null;
  diff: { mean: number; p50: number; p90: number; p99: number };
  lag2OverLag1MedianDiffRatio: number | null;
  /**
   * Resampling-aliasing probe: mean |d[i] − d[i−1]| over the lag-1 diff
   * series, normalized by mean d. Non-integer frame-rate resampling makes
   * consecutive output frames span alternating source-frame counts, which
   * raises this alternation index.
   */
  diffAlternationIndex: number | null;
  timing: { meanDeltaMs: number | null; stdDeltaMs: number | null; cv: number | null };
  flow: {
    matchedBlocks: number;
    p50: number;
    p90: number;
    p99: number;
    /** Fraction of matched blocks whose best match saturates the search radius. */
    saturatedFraction: number;
  };
}

function decodeGray(path: string, width: number, height: number): Buffer {
  const out = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-t",
      String(MAX_ANALYSIS_SECONDS),
      "-i",
      path,
      "-vf",
      `scale=${width}:${height}`,
      "-pix_fmt",
      "gray",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  return out.stdout ?? Buffer.alloc(0);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function interFrameDiffs(raw: Buffer, frameSize: number, lag: number): number[] {
  const frameCount = Math.floor(raw.length / frameSize);
  const diffs: number[] = [];
  for (let f = lag; f < frameCount; f += 1) {
    const a = (f - lag) * frameSize;
    const b = f * frameSize;
    let sum = 0;
    for (let i = 0; i < frameSize; i += 1) sum += Math.abs(raw[b + i]! - raw[a + i]!);
    diffs.push(sum / frameSize);
  }
  return diffs;
}

/** Frame presentation-timestamp deltas from the container (ms). */
function timestampDeltas(path: string): number[] {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-read_intervals",
      `%+${MAX_ANALYSIS_SECONDS}`,
      "-show_entries",
      "frame=best_effort_timestamp_time",
      "-of",
      "csv=p=0",
      path,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const times = (probe.stdout ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => line.length > 0)
    .map(Number)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i += 1) deltas.push((times[i]! - times[i - 1]!) * 1000);
  return deltas;
}

/**
 * Block-matching optical-flow proxy: for each textured 8x8 block, the
 * displacement (Chebyshev radius search) minimizing SAD against the next
 * frame; velocity is the L2 norm of that displacement in px/frame.
 */
function flowVelocities(raw: Buffer): { velocities: number[]; saturated: number } {
  const frameSize = FLOW_WIDTH * FLOW_HEIGHT;
  const frameCount = Math.floor(raw.length / frameSize);
  const velocities: number[] = [];
  let saturated = 0;
  for (let f = 0; f + 1 < frameCount; f += 1) {
    const cur = f * frameSize;
    const nxt = (f + 1) * frameSize;
    for (let by = 0; by + FLOW_BLOCK <= FLOW_HEIGHT; by += FLOW_BLOCK) {
      for (let bx = 0; bx + FLOW_BLOCK <= FLOW_WIDTH; bx += FLOW_BLOCK) {
        let sum = 0;
        let sumSq = 0;
        for (let y = 0; y < FLOW_BLOCK; y += 1) {
          for (let x = 0; x < FLOW_BLOCK; x += 1) {
            const v = raw[cur + (by + y) * FLOW_WIDTH + bx + x]!;
            sum += v;
            sumSq += v * v;
          }
        }
        const n = FLOW_BLOCK * FLOW_BLOCK;
        const mean = sum / n;
        const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
        if (std <= FLOW_MIN_BLOCK_STD) continue;
        let bestSad = Infinity;
        let bestDx = 0;
        let bestDy = 0;
        for (let dy = -FLOW_SEARCH_RADIUS; dy <= FLOW_SEARCH_RADIUS; dy += 1) {
          const ty = by + dy;
          if (ty < 0 || ty + FLOW_BLOCK > FLOW_HEIGHT) continue;
          for (let dx = -FLOW_SEARCH_RADIUS; dx <= FLOW_SEARCH_RADIUS; dx += 1) {
            const tx = bx + dx;
            if (tx < 0 || tx + FLOW_BLOCK > FLOW_WIDTH) continue;
            let sad = 0;
            for (let y = 0; y < FLOW_BLOCK; y += 1) {
              const rowA = cur + (by + y) * FLOW_WIDTH + bx;
              const rowB = nxt + (ty + y) * FLOW_WIDTH + tx;
              for (let x = 0; x < FLOW_BLOCK; x += 1) {
                sad += Math.abs(raw[rowA + x]! - raw[rowB + x]!);
              }
            }
            if (sad < bestSad) {
              bestSad = sad;
              bestDx = dx;
              bestDy = dy;
            }
          }
        }
        velocities.push(Math.hypot(bestDx, bestDy));
        if (
          Math.max(Math.abs(bestDx), Math.abs(bestDy)) >= FLOW_SEARCH_RADIUS ||
          bestSad === Infinity
        ) {
          saturated += 1;
        }
      }
    }
  }
  return { velocities, saturated };
}

function probeFps(path: string): number | null {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate",
      "-of",
      "csv=p=0",
      path,
    ],
    { encoding: "utf8" },
  );
  const rate = (probe.stdout ?? "").trim().replace(/,$/, "");
  if (!rate.includes("/")) return null;
  const [num, den] = rate.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den! <= 0 || num! <= 0) return null;
  return num! / den!;
}

export function measureClip(
  id: string,
  path: string,
  group: SpeedGapMeasurement["group"],
  speedFactor: number | null,
  sourceId: string | null,
): SpeedGapMeasurement {
  const diffRaw = decodeGray(path, DIFF_WIDTH, DIFF_HEIGHT);
  const diffFrameSize = DIFF_WIDTH * DIFF_HEIGHT;
  const lag1 = interFrameDiffs(diffRaw, diffFrameSize, 1);
  const lag2 = interFrameDiffs(diffRaw, diffFrameSize, 2);
  const sorted1 = [...lag1].sort((a, b) => a - b);
  const sorted2 = [...lag2].sort((a, b) => a - b);
  const median1 = percentile(sorted1, 50);
  const median2 = percentile(sorted2, 50);
  const meanDiff = lag1.length > 0 ? lag1.reduce((a, b) => a + b, 0) / lag1.length : 0;
  let alternation = 0;
  for (let i = 1; i < lag1.length; i += 1) alternation += Math.abs(lag1[i]! - lag1[i - 1]!);
  const alternationIndex =
    lag1.length > 1 && meanDiff > 0 ? alternation / (lag1.length - 1) / meanDiff : null;
  const deltas = timestampDeltas(path);
  const meanDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  const stdDelta =
    meanDelta !== null
      ? Math.sqrt(deltas.reduce((a, d) => a + (d - meanDelta) ** 2, 0) / deltas.length)
      : null;
  const flowRaw = decodeGray(path, FLOW_WIDTH, FLOW_HEIGHT);
  const { velocities, saturated } = flowVelocities(flowRaw);
  const sortedV = [...velocities].sort((a, b) => a - b);
  return {
    id,
    group,
    speedFactor,
    sourceId,
    frameCount: Math.floor(diffRaw.length / diffFrameSize),
    fps: probeFps(path),
    diff: {
      mean: meanDiff,
      p50: median1,
      p90: percentile(sorted1, 90),
      p99: percentile(sorted1, 99),
    },
    lag2OverLag1MedianDiffRatio: median1 > 0 ? median2 / median1 : null,
    diffAlternationIndex: alternationIndex,
    timing: {
      meanDeltaMs: meanDelta,
      stdDeltaMs: stdDelta,
      cv: meanDelta !== null && meanDelta > 0 && stdDelta !== null ? stdDelta / meanDelta : null,
    },
    flow: {
      matchedBlocks: velocities.length,
      p50: percentile(sortedV, 50),
      p90: percentile(sortedV, 90),
      p99: percentile(sortedV, 99),
      saturatedFraction: velocities.length > 0 ? saturated / velocities.length : 0,
    },
  };
}

export function runSpeedGapExperiment(): SpeedGapMeasurement[] {
  const measurements: SpeedGapMeasurement[] = [];
  const bundles = join(repoRoot, "datasets", "paddle-bench", "bundles");
  const workDir = mkdtempSync(join(tmpdir(), "ood-speed-gap-"));
  try {
    for (const bundle of TUNE_POSITIVES) {
      if (HELD_OUT.has(bundle)) throw new Error(`held-out bundle in tune set: ${bundle}`);
      const clip = join(bundles, bundle, "clip.mp4");
      measurements.push(measureClip(bundle, clip, "tune_positive", null, null));
      for (const factor of SPEED_FACTORS) {
        const variant = join(workDir, `${bundle}-x${factor}.mp4`);
        // Exact red-team fixture recipe (oodGateRedTeam.test.ts, generalized).
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-i",
          clip,
          "-vf",
          `setpts=PTS/${factor}`,
          "-r",
          "30",
          "-an",
          variant,
        ]);
        measurements.push(
          measureClip(`${bundle}-x${factor}`, variant, "speed_variant", factor, bundle),
        );
      }
    }
    const freshDir = join(repoRoot, "datasets", "pickleball", "fresh-candidates");
    for (const file of readdirSync(freshDir).filter((f) => f.endsWith(".mp4"))) {
      if (LEDGER_EXCLUDED.has(file.replace(/\.mp4$/, ""))) continue;
      measurements.push(
        measureClip(
          file.replace(/\.mp4$/, ""),
          join(freshDir, file),
          "fresh_candidate",
          null,
          null,
        ),
      );
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return measurements;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isMain) {
  const measurements = runSpeedGapExperiment();
  const outPath = join(
    repoRoot,
    "datasets",
    "experiments",
    "wave-f",
    "f10-speed-gap-measurements.json",
  );
  writeFileSync(outPath, `${JSON.stringify({ measurements }, null, 2)}\n`);
  console.warn(`wrote ${measurements.length} measurements to ${outPath}`);
}
