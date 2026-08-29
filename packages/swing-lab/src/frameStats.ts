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
/** Ring thickness (pixels on every edge) for the frozen-border-bezel signal. */
const RING_THICKNESS = 2;
/** A pixel is temporally frozen when its temporal luma std is at or below this. */
const FROZEN_PIXEL_MAX_STD = 0.5;
/** First raster row of the bottom third, where a broadcast score graphic sits. */
const BOTTOM_THIRD_START_ROW = Math.floor((STAT_HEIGHT * 2) / 3);

export function extractFrameStats(videoPath: string): FrameStats {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      videoPath,
      "-vf",
      `scale=${STAT_WIDTH}:${STAT_HEIGHT}`,
      "-pix_fmt",
      "gray",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  const frameSize = STAT_WIDTH * STAT_HEIGHT;
  const frameCount = Math.floor(raw.length / frameSize);

  const interFrameDiffs: number[] = [];
  const spatialLumaStd: number[] = [];
  let barRowFractionSum = 0;
  const pixelSum = new Float64Array(frameSize);
  const pixelSumSq = new Float64Array(frameSize);

  for (let f = 0; f < frameCount; f += 1) {
    const offset = f * frameSize;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const v = raw[offset + i]!;
      sum += v;
      sumSq += v * v;
      pixelSum[i] = pixelSum[i]! + v;
      pixelSumSq[i] = pixelSumSq[i]! + v * v;
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

  const pixelMean = new Float64Array(frameSize);
  const pixelStd = new Float64Array(frameSize);
  if (frameCount > 0) {
    for (let i = 0; i < frameSize; i += 1) {
      pixelMean[i] = pixelSum[i]! / frameCount;
      pixelStd[i] = Math.sqrt(Math.max(0, pixelSumSq[i]! / frameCount - pixelMean[i]! ** 2));
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
    ...(frameCount > 0
      ? {
          borderRing: measureBorderRing(pixelMean, pixelStd),
          bottomFrozenComponents: findBottomFrozenComponents(pixelMean, pixelStd),
        }
      : {}),
  };
}

function measureBorderRing(
  pixelMean: Float64Array,
  pixelStd: Float64Array,
): { temporalStd: number; meanLuma: number } {
  let stdSum = 0;
  let lumaSum = 0;
  let count = 0;
  for (let r = 0; r < STAT_HEIGHT; r += 1) {
    for (let c = 0; c < STAT_WIDTH; c += 1) {
      const onRing =
        r < RING_THICKNESS ||
        r >= STAT_HEIGHT - RING_THICKNESS ||
        c < RING_THICKNESS ||
        c >= STAT_WIDTH - RING_THICKNESS;
      if (!onRing) continue;
      const i = r * STAT_WIDTH + c;
      stdSum += pixelStd[i]!;
      lumaSum += pixelMean[i]!;
      count += 1;
    }
  }
  return { temporalStd: stdSum / count, meanLuma: lumaSum / count };
}

/**
 * 4-connected components of temporally frozen pixels whose bounding box lies
 * entirely in the bottom third of the raster; per component, the spatial std
 * of the temporal-mean luma inside it (a text graphic has high contrast, a
 * frozen patch of court does not).
 */
function findBottomFrozenComponents(
  pixelMean: Float64Array,
  pixelStd: Float64Array,
): Array<{ size: number; lumaStd: number }> {
  const frameSize = STAT_WIDTH * STAT_HEIGHT;
  const visited = new Uint8Array(frameSize);
  const components: Array<{ size: number; lumaStd: number }> = [];
  for (let start = 0; start < frameSize; start += 1) {
    if (visited[start] === 1 || pixelStd[start]! > FROZEN_PIXEL_MAX_STD) continue;
    visited[start] = 1;
    const stack = [start];
    const members: number[] = [];
    let minRow = STAT_HEIGHT;
    while (stack.length > 0) {
      const p = stack.pop()!;
      members.push(p);
      const row = Math.floor(p / STAT_WIDTH);
      const col = p % STAT_WIDTH;
      minRow = Math.min(minRow, row);
      const neighbors = [
        row > 0 ? p - STAT_WIDTH : -1,
        row < STAT_HEIGHT - 1 ? p + STAT_WIDTH : -1,
        col > 0 ? p - 1 : -1,
        col < STAT_WIDTH - 1 ? p + 1 : -1,
      ];
      for (const q of neighbors) {
        if (q >= 0 && visited[q] === 0 && pixelStd[q]! <= FROZEN_PIXEL_MAX_STD) {
          visited[q] = 1;
          stack.push(q);
        }
      }
    }
    if (minRow < BOTTOM_THIRD_START_ROW) continue;
    let sum = 0;
    let sumSq = 0;
    for (const p of members) {
      sum += pixelMean[p]!;
      sumSq += pixelMean[p]! ** 2;
    }
    const mean = sum / members.length;
    components.push({
      size: members.length,
      lumaStd: Math.sqrt(Math.max(0, sumSq / members.length - mean * mean)),
    });
  }
  return components;
}

function probeDurationMs(videoPath: string): number {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    { encoding: "utf8" },
  ).trim();
  const seconds = Number(out);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}
