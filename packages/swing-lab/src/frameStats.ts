import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { FrameStats } from "@pickle/vision-geometry";

const execFileAsync = promisify(execFile);

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

const DECODE_ARGS = (videoPath: string) => [
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
];

function countDecodeErrors(stderrText: string, exitedNonZero: boolean): number {
  const count = stderrText
    .split("\n")
    .filter((line) => /error|invalid data|partial file|truncat|corrupt|missing/i.test(line)).length;
  return exitedNonZero && count === 0 ? 1 : count;
}

export function extractFrameStats(videoPath: string): FrameStats {
  const decode = spawnSync("ffmpeg", DECODE_ARGS(videoPath), { maxBuffer: 1024 * 1024 * 1024 });
  const raw = decode.stdout ?? Buffer.alloc(0);
  const stderrText = decode.stderr?.toString("utf8") ?? "";
  const decodeErrorCount = countDecodeErrors(stderrText, decode.status !== 0);
  const source = probeSource(videoPath);
  const durationMs = probeDurationMs(videoPath);
  return computeFrameStats(raw, decodeErrorCount, source, durationMs);
}

/**
 * Same statistics as extractFrameStats but with the ffmpeg/ffprobe subprocess
 * waits off the event loop; byte-identical inputs produce identical outputs.
 */
export async function extractFrameStatsAsync(videoPath: string): Promise<FrameStats> {
  let raw: Buffer = Buffer.alloc(0);
  let stderrText = "";
  let exitedNonZero = false;
  try {
    const decode = await execFileAsync("ffmpeg", DECODE_ARGS(videoPath), {
      maxBuffer: 1024 * 1024 * 1024,
      encoding: "buffer",
    });
    raw = decode.stdout;
    stderrText = decode.stderr.toString("utf8");
  } catch (error) {
    exitedNonZero = true;
    const failed = error as { stdout?: Buffer; stderr?: Buffer };
    if (Buffer.isBuffer(failed.stdout)) raw = failed.stdout;
    if (Buffer.isBuffer(failed.stderr)) stderrText = failed.stderr.toString("utf8");
  }
  const decodeErrorCount = countDecodeErrors(stderrText, exitedNonZero);
  const source = probeSource(videoPath);
  const durationMs = probeDurationMs(videoPath);
  return computeFrameStats(raw, decodeErrorCount, source, durationMs);
}

function computeFrameStats(
  raw: Buffer,
  decodeErrorCount: number,
  source: { width: number; height: number; fps: number | null } | null,
  durationMs: number,
): FrameStats {
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

  const expectedFrameCount =
    source !== null && source.fps !== null && durationMs > 0
      ? Math.round((durationMs / 1000) * source.fps)
      : null;
  return {
    frameCount,
    durationMs,
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
    ...(source !== null ? { source: { width: source.width, height: source.height } } : {}),
    decode: { errorCount: decodeErrorCount, expectedFrameCount },
  };
}

/** Container-declared source dimensions and frame rate; null when unprobeable. */
function probeSource(
  videoPath: string,
): { width: number; height: number; fps: number | null } | null {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate",
      "-of",
      "csv=p=0",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) return null;
  const [w, h, rate] = (probe.stdout ?? "").trim().split(",");
  const width = Number(w);
  const height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  let fps: number | null = null;
  if (rate !== undefined && rate.includes("/")) {
    const [num, den] = rate.split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den! > 0 && num! > 0) fps = num! / den!;
  }
  return { width, height, fps };
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
  const probe = spawnSync(
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
  );
  if (probe.status !== 0) return 0;
  const seconds = Number((probe.stdout ?? "").trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}
