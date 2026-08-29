import { execFileSync } from "node:child_process";
import type { FrameStats } from "@pickle/vision-geometry";

/**
 * Pose-free frame statistics for the pre-analysis OOD gate: decodes the clip
 * once with ffmpeg to a small grayscale raster and measures inter-frame
 * change, spatial texture, and letterbox bars. Deterministic over the same
 * file + ffmpeg build; feeds vision-geometry's evaluateFrameAnalyzability.
 */

const STAT_WIDTH = 64;
const STAT_HEIGHT = 36;
/** A row is a letterbox bar row when its mean luma is at or below this. */
const BAR_ROW_MAX_LUMA = 12;
/** ...and its own std is at or below this (uniform, not dark content). */
const BAR_ROW_MAX_STD = 4;

export function extractFrameStats(videoPath: string): FrameStats {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v", "error",
      "-i", videoPath,
      "-vf", `scale=${STAT_WIDTH}:${STAT_HEIGHT}`,
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      "-",
    ],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  const frameSize = STAT_WIDTH * STAT_HEIGHT;
  const frameCount = Math.floor(raw.length / frameSize);

  const interFrameDiffs: number[] = [];
  const spatialLumaStd: number[] = [];
  let barRowFractionSum = 0;

  for (let f = 0; f < frameCount; f += 1) {
    const offset = f * frameSize;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const v = raw[offset + i]!;
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / frameSize;
    spatialLumaStd.push(Math.sqrt(Math.max(0, sumSq / frameSize - mean * mean)));

    let barRows = 0;
    for (let half = 0; half < 2; half += 1) {
      // Walk inward from the top and from the bottom; stop at first non-bar row.
      for (let r = 0; r < Math.floor(STAT_HEIGHT / 2); r += 1) {
        const row = half === 0 ? r : STAT_HEIGHT - 1 - r;
        let rowSum = 0;
        let rowSumSq = 0;
        for (let c = 0; c < STAT_WIDTH; c += 1) {
          const v = raw[offset + row * STAT_WIDTH + c]!;
          rowSum += v;
          rowSumSq += v * v;
        }
        const rowMean = rowSum / STAT_WIDTH;
        const rowStd = Math.sqrt(Math.max(0, rowSumSq / STAT_WIDTH - rowMean * rowMean));
        if (rowMean <= BAR_ROW_MAX_LUMA && rowStd <= BAR_ROW_MAX_STD) barRows += 1;
        else break;
      }
    }
    barRowFractionSum += barRows / STAT_HEIGHT;

    if (f > 0) {
      const prev = (f - 1) * frameSize;
      let diff = 0;
      for (let i = 0; i < frameSize; i += 1) {
        diff += Math.abs(raw[offset + i]! - raw[prev + i]!);
      }
      interFrameDiffs.push(diff / frameSize);
    }
  }

  return {
    frameCount,
    durationMs: probeDurationMs(videoPath),
    width: STAT_WIDTH,
    height: STAT_HEIGHT,
    interFrameDiffs,
    spatialLumaStd,
    letterboxRowFraction: frameCount > 0 ? barRowFractionSum / frameCount : 0,
  };
}

function probeDurationMs(videoPath: string): number {
  const out = execFileSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    { encoding: "utf8" },
  ).trim();
  const seconds = Number(out);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}
