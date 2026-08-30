import { spawnSync } from "node:child_process";
import type { CaptureEnvelopeMeasurements } from "./envelope.js";

/**
 * CPU clip prober: derives the video-only envelope measurements from a clip
 * via ffprobe/ffmpeg. Pose-derived dimensions are returned null — this
 * prober never fabricates pose signals.
 *
 * Normalization contract (must match thresholds.ts ids): sampled frames are
 * decoded at SAMPLE_FPS, downscaled so the LONG side is 320px (aspect
 * preserved), grayscale. Long-side normalization makes the sampling scale
 * orientation-invariant: rotation metadata swaps display width/height but
 * cannot change the effective downscale factor. Laplacian variance and
 * frame diffs are computed on those normalized frames.
 */

export const SAMPLE_FPS = 4;
export const SAMPLE_LONG_SIDE = 320;

export interface ClipStreamInfo {
  /** Stored (pre-rotation) dimensions. */
  width: number;
  height: number;
  /** Rotation metadata in degrees (0 when absent), normalized to 0/90/180/270. */
  rotationDegrees: number;
  /** Dimensions as displayed after applying rotation metadata. */
  displayWidth: number;
  displayHeight: number;
  avgFrameRateFps: number;
  durationMs: number;
}

function run(cmd: string, args: string[], maxBuffer = 512 * 1024 * 1024): Buffer {
  const res = spawnSync(cmd, args, { maxBuffer });
  if (res.status !== 0) {
    throw new Error(`${cmd} failed (${res.status}): ${res.stderr?.toString().slice(-2000)}`);
  }
  return res.stdout;
}

export function probeClipStream(clipPath: string): ClipStreamInfo {
  const out = run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    clipPath,
  ]).toString();
  const parsed = JSON.parse(out) as {
    streams?: Array<{
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration?: string;
      tags?: { rotate?: string };
      side_data_list?: Array<{ rotation?: number }>;
    }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  if (!stream || typeof stream.width !== "number" || typeof stream.height !== "number") {
    throw new Error(`ffprobe returned no video stream for ${clipPath}`);
  }
  const rate = stream.avg_frame_rate ?? "0/1";
  const [num, den] = rate.split("/").map(Number);
  const fps = num !== undefined && den !== undefined && den !== 0 ? num / den : 0;
  const durationSec = Number(stream.duration ?? parsed.format?.duration ?? "0");
  const sideDataRotation = stream.side_data_list?.find(
    (entry) => typeof entry.rotation === "number",
  )?.rotation;
  const tagRotation = stream.tags?.rotate !== undefined ? Number(stream.tags.rotate) : undefined;
  const rawRotation = sideDataRotation ?? tagRotation ?? 0;
  const rotationDegrees = Number.isFinite(rawRotation)
    ? ((Math.round(rawRotation) % 360) + 360) % 360
    : 0;
  const swapped = rotationDegrees === 90 || rotationDegrees === 270;
  return {
    width: stream.width,
    height: stream.height,
    rotationDegrees,
    displayWidth: swapped ? stream.height : stream.width,
    displayHeight: swapped ? stream.width : stream.height,
    avgFrameRateFps: fps,
    durationMs: Math.round(durationSec * 1000),
  };
}

/**
 * Coefficient of variation (std dev / mean) of inter-frame presentation
 * intervals, from packet timestamps sorted into presentation order. Returns
 * null when fewer than 3 usable intervals exist (too short to judge timing).
 *
 * Zero-length intervals (duplicate PTS — two frames sharing a presentation
 * time) are stutter evidence and are INCLUDED: dropping them would let a
 * duplicate-PTS re-timed clip measure as perfectly stable.
 */
export function probeFrameIntervalCv(clipPath: string, window?: MeasureWindow): number | null {
  const intervalArgs = window
    ? [
        "-read_intervals",
        `${(window.startMs / 1000).toFixed(3)}%+${(window.durationMs / 1000).toFixed(3)}`,
      ]
    : [];
  const out = run("ffprobe", [
    "-v",
    "error",
    ...intervalArgs,
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts_time",
    "-of",
    "csv=p=0",
    clipPath,
  ]).toString();
  const times = out
    .split("\n")
    .map((line) => line.trim().replace(/,+$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => Number(line))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const intervals: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const delta = times[index]! - times[index - 1]!;
    if (delta >= 0) intervals.push(delta);
  }
  if (intervals.length < 3) return null;
  const mean = intervals.reduce((acc, value) => acc + value, 0) / intervals.length;
  if (mean <= 0) return null;
  const variance =
    intervals.reduce((acc, value) => acc + (value - mean) * (value - mean), 0) / intervals.length;
  return Math.sqrt(variance) / mean;
}

/** Restrict measurement to a sub-window of the clip (e.g. one scene). */
export interface MeasureWindow {
  startMs: number;
  durationMs: number;
}

export interface SampledGrayFrames {
  width: number;
  height: number;
  frames: Uint8Array[];
}

/**
 * Decode sampled grayscale frames. ffmpeg auto-applies rotation metadata
 * when decoding, so callers must pass DISPLAY dimensions (post-rotation) —
 * passing stored dimensions for a 90°/270°-rotated clip silently distorts
 * the aspect ratio and corrupts the Laplacian/frame-diff normalization.
 * The LONG side is normalized to SAMPLE_LONG_SIDE so the effective
 * downscale factor is identical for landscape and portrait orientations.
 * An optional ffmpeg filter (e.g. a median denoise) can be applied before
 * grayscale conversion.
 */
export function extractSampledGrayFrames(
  clipPath: string,
  sourceWidth: number,
  sourceHeight: number,
  window?: MeasureWindow,
  preGrayFilter?: string,
): SampledGrayFrames {
  const landscape = sourceWidth >= sourceHeight;
  const long = SAMPLE_LONG_SIDE;
  const short =
    Math.round(
      ((landscape ? sourceHeight : sourceWidth) * long) /
        (landscape ? sourceWidth : sourceHeight) /
        2,
    ) * 2;
  const width = landscape ? long : short;
  const height = landscape ? short : long;
  const windowArgs = window
    ? ["-ss", (window.startMs / 1000).toFixed(3), "-t", (window.durationMs / 1000).toFixed(3)]
    : [];
  const filterSuffix = preGrayFilter ? `,${preGrayFilter}` : "";
  const raw = run("ffmpeg", [
    "-v",
    "error",
    ...windowArgs,
    "-i",
    clipPath,
    "-vf",
    `fps=${SAMPLE_FPS},scale=${width}:${height}${filterSuffix},format=gray`,
    "-f",
    "rawvideo",
    "-",
  ]);
  const frameBytes = width * height;
  const frameCount = Math.floor(raw.length / frameBytes);
  const frames: Uint8Array[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    frames.push(new Uint8Array(raw.buffer, raw.byteOffset + index * frameBytes, frameBytes));
  }
  return { width, height, frames };
}

export function meanLuma(frame: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < frame.length; index += 1) sum += frame[index]!;
  return frame.length > 0 ? sum / frame.length : 0;
}

/** Variance of the 4-neighbor Laplacian over interior pixels. */
export function laplacianVariance(frame: Uint8Array, width: number, height: number): number {
  const count = (width - 2) * (height - 2);
  if (count <= 0) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const i = row + x;
      const lap =
        frame[i - width]! + frame[i + width]! + frame[i - 1]! + frame[i + 1]! - 4 * frame[i]!;
      sum += lap;
      sumSq += lap * lap;
    }
  }
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index]! - b[index]!);
  return a.length > 0 ? sum / a.length : 0;
}

/** Std dev of pixel luma within one frame (spatial contrast). */
export function spatialStd(frame: Uint8Array): number {
  if (frame.length === 0) return 0;
  const mean = meanLuma(frame);
  let sumSq = 0;
  for (let index = 0; index < frame.length; index += 1) {
    const d = frame[index]! - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / frame.length);
}

/** Fraction of pixels at or beyond the luma clipping points (<=16, >=235). */
export function clippedPixelFraction(frames: Uint8Array[]): number | null {
  let clipped = 0;
  let total = 0;
  for (const frame of frames) {
    for (let index = 0; index < frame.length; index += 1) {
      const v = frame[index]!;
      if (v <= 16 || v >= 235) clipped += 1;
    }
    total += frame.length;
  }
  return total > 0 ? clipped / total : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stdDev(values: number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance =
    values.reduce((acc, value) => acc + (value - mean) * (value - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/** Measure the video-only envelope signals for a clip on CPU. */
export function measureClip(clipPath: string, window?: MeasureWindow): CaptureEnvelopeMeasurements {
  const info = probeClipStream(clipPath);
  const sampled = extractSampledGrayFrames(clipPath, info.displayWidth, info.displayHeight, window);

  const lumaMeans = sampled.frames.map((frame) => meanLuma(frame));
  const lapVars = sampled.frames.map((frame) =>
    laplacianVariance(frame, sampled.width, sampled.height),
  );
  const diffs: number[] = [];
  for (let index = 1; index < sampled.frames.length; index += 1) {
    diffs.push(meanAbsDiff(sampled.frames[index - 1]!, sampled.frames[index]!));
  }

  const brightnessMean =
    lumaMeans.length > 0
      ? lumaMeans.reduce((acc, value) => acc + value, 0) / lumaMeans.length
      : null;

  const rawLapMedian = median(lapVars);
  let denoiseSurvivalRatio: number | null = null;
  if (rawLapMedian !== null && rawLapMedian > 0) {
    const denoised = extractSampledGrayFrames(
      clipPath,
      info.displayWidth,
      info.displayHeight,
      window,
      "median=radius=1",
    );
    const denoisedLapMedian = median(
      denoised.frames.map((frame) => laplacianVariance(frame, denoised.width, denoised.height)),
    );
    denoiseSurvivalRatio = denoisedLapMedian !== null ? denoisedLapMedian / rawLapMedian : null;
  }

  const meanDiff =
    diffs.length > 0 ? diffs.reduce((acc, value) => acc + value, 0) / diffs.length : null;
  const meanSpatialStd =
    sampled.frames.length > 0
      ? sampled.frames.reduce((acc, frame) => acc + spatialStd(frame), 0) / sampled.frames.length
      : null;
  const contrastNormalizedFrameDiff =
    meanDiff !== null && meanSpatialStd !== null && meanSpatialStd > 0
      ? meanDiff / meanSpatialStd
      : null;

  return {
    frameWidthPx: info.displayWidth,
    frameHeightPx: info.displayHeight,
    avgFrameRateFps: info.avgFrameRateFps,
    brightnessMeanLuma: brightnessMean,
    brightnessStdLuma: stdDev(lumaMeans),
    laplacianVarianceMedian: rawLapMedian,
    meanAbsFrameDiff: meanDiff,
    denoiseSurvivalRatio,
    clippedPixelFraction: clippedPixelFraction(sampled.frames),
    contrastNormalizedFrameDiff,
    frameIntervalCv: probeFrameIntervalCv(clipPath, window),
    clipDurationMs: window ? Math.round(window.durationMs) : info.durationMs,
    playerPixelHeightFraction: null,
    playerMeanJointVisibility: null,
  };
}
