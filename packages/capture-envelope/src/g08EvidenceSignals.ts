import { spawnSync } from "node:child_process";
import {
  extractSampledGrayFrames,
  SAMPLE_FPS,
  laplacianVariance,
  meanAbsDiff,
  meanLuma,
  probeClipStream,
  type MeasureWindow,
} from "./clipProbe.js";

/**
 * g08-f22-evidence: bypass-resemblance signals for mining NATURAL corpus
 * examples of the label-dependent F22 bypass families (B1 blur-masked-by-
 * noise, B2 bimodal exposure, B3 strobing exposure, B4 upscaled content,
 * B5 tiny subject, B7 contrast-dependent shake).
 *
 * These signals are MINING HEURISTICS ONLY (Tier-C machine proposals used
 * to rank review candidates for humans). They are NOT verdicts, NOT
 * thresholds, and NOT ground truth; nothing here feeds the envelope
 * checker. The only truth for these families is the human label file
 * defined in g08LabelSchema.ts.
 *
 * Normalization: all signals are computed on the same sampled grayscale
 * frames as the envelope prober (SAMPLE_FPS, 320px wide), except the
 * high-frequency energy ratio, which additionally decodes at 640px wide to
 * compare fine-vs-coarse detail.
 */

export const G08_SIGNALS_VERSION = "g08-bypass-resemblance-signals-v1";

/** Luma at or below this counts as a crushed (clipped-dark) pixel. */
export const CLIP_LOW_LUMA = 20;
/** Luma at or above this counts as a blown (clipped-bright) pixel. */
export const CLIP_HIGH_LUMA = 235;
/** Per-pixel abs frame diff above this counts as motion-active. */
export const MOTION_ACTIVE_DIFF = 15;

const HF_SAMPLE_WIDTH = 640;

export interface G08BypassSignals {
  /** Fraction of sampled pixels with luma <= CLIP_LOW_LUMA. */
  lowClipFraction: number | null;
  /** Fraction of sampled pixels with luma >= CLIP_HIGH_LUMA. */
  highClipFraction: number | null;
  /**
   * B2 bimodal-exposure resemblance: min(lowClipFraction, highClipFraction)
   * — high only when BOTH tails are heavily populated at once.
   */
  bimodalClipScore: number | null;
  /**
   * B3 strobing resemblance: std dev of per-frame mean luma (the same
   * brightnessStdLuma the checker measures but no dimension consumes).
   */
  temporalLumaStd: number | null;
  /**
   * B1 blur-masked-by-noise resemblance: laplacian variance of the
   * temporally averaged frame divided by the median per-frame laplacian
   * variance. Temporally uncorrelated grain averages out of the numerator,
   * so grain-dominated "sharpness" drives this ratio toward 0. Subject or
   * camera motion also lowers it — meanAbsFrameDiff must be read alongside.
   */
  grainSharpnessRatio: number | null;
  /**
   * B4 upscale resemblance: median laplacian variance at 640px wide divided
   * by median laplacian variance at 320px wide. Content upscaled from a
   * lower true resolution lacks fine detail at 640w relative to its coarse
   * structure, pulling the ratio down. Only computed when the display width
   * is at least 1280px (otherwise null).
   */
  hfEnergyRatio: number | null;
  /**
   * B5 tiny-subject resemblance: median (over consecutive sampled frame
   * pairs) fraction of frame HEIGHT spanned by motion-active rows. A small
   * moving subject on a static background yields a small value.
   */
  motionHeightFraction: number | null;
  /** Median fraction of frame WIDTH spanned by motion-active columns. */
  motionWidthFraction: number | null;
  /** Median fraction of pixels that are motion-active between frames. */
  motionCoverage: number | null;
  /**
   * B7 shake resemblance: mean abs frame diff divided by the mean spatial
   * gradient magnitude (mean abs horizontal+vertical neighbor difference).
   * Normalizing by contrast removes the content-contrast dependence that
   * made the raw frame-diff proxy pass violent shake on low-contrast
   * footage (f22-B7).
   */
  contrastNormalizedMotion: number | null;
  /** contrastNormalizedMotion * motionCoverage: global (whole-frame) shake. */
  globalShakeScore: number | null;
  /** Mean abs frame diff on the sampled frames (context for B1/B5/B7). */
  meanAbsFrameDiff: number | null;
  /** Mean spatial gradient magnitude (context for B7 normalization). */
  meanSpatialGradient: number | null;
  sampledFrameCount: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

export function clipTailFractions(frame: Uint8Array): { low: number; high: number } {
  let low = 0;
  let high = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i]!;
    if (v <= CLIP_LOW_LUMA) low += 1;
    else if (v >= CLIP_HIGH_LUMA) high += 1;
  }
  return {
    low: frame.length > 0 ? low / frame.length : 0,
    high: frame.length > 0 ? high / frame.length : 0,
  };
}

export function meanSpatialGradient(frame: Uint8Array, width: number, height: number): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 0; x < width - 1; x += 1) {
      const i = row + x;
      sum += Math.abs(frame[i]! - frame[i + 1]!) + Math.abs(frame[i]! - frame[i + width]!);
      count += 2;
    }
  }
  return count > 0 ? sum / count : 0;
}

export interface MotionExtent {
  heightFraction: number;
  widthFraction: number;
  coverage: number;
}

export function motionExtent(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
): MotionExtent {
  let minRow = -1;
  let maxRow = -1;
  let minCol = width;
  let maxCol = -1;
  let active = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const i = row + x;
      if (Math.abs(a[i]! - b[i]!) > MOTION_ACTIVE_DIFF) {
        active += 1;
        if (minRow === -1) minRow = y;
        maxRow = y;
        if (x < minCol) minCol = x;
        if (x > maxCol) maxCol = x;
      }
    }
  }
  if (active === 0) return { heightFraction: 0, widthFraction: 0, coverage: 0 };
  return {
    heightFraction: (maxRow - minRow + 1) / height,
    widthFraction: (maxCol - minCol + 1) / width,
    coverage: active / (width * height),
  };
}

export function temporalMeanFrame(frames: Uint8Array[]): Uint8Array {
  const length = frames[0]?.length ?? 0;
  const acc = new Float64Array(length);
  for (const frame of frames) {
    for (let i = 0; i < length; i += 1) acc[i] = acc[i]! + frame[i]!;
  }
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.round(acc[i]! / frames.length);
  return out;
}

/** Compute all bypass-resemblance signals for one clip window. */
export function computeBypassSignals(clipPath: string, window?: MeasureWindow): G08BypassSignals {
  const info = probeClipStream(clipPath);
  const sampled = extractSampledGrayFrames(clipPath, info.displayWidth, info.displayHeight, window);
  const { width, height, frames } = sampled;

  if (frames.length === 0) {
    return {
      lowClipFraction: null,
      highClipFraction: null,
      bimodalClipScore: null,
      temporalLumaStd: null,
      grainSharpnessRatio: null,
      hfEnergyRatio: null,
      motionHeightFraction: null,
      motionWidthFraction: null,
      motionCoverage: null,
      contrastNormalizedMotion: null,
      globalShakeScore: null,
      meanAbsFrameDiff: null,
      meanSpatialGradient: null,
      sampledFrameCount: 0,
    };
  }

  const tails = frames.map((frame) => clipTailFractions(frame));
  const lowClipFraction = mean(tails.map((t) => t.low));
  const highClipFraction = mean(tails.map((t) => t.high));
  const bimodalClipScore =
    lowClipFraction !== null && highClipFraction !== null
      ? Math.min(lowClipFraction, highClipFraction)
      : null;

  const lumaMeans = frames.map((frame) => meanLuma(frame));
  const lumaMean = mean(lumaMeans)!;
  const temporalLumaStd = Math.sqrt(
    lumaMeans.reduce((acc, v) => acc + (v - lumaMean) * (v - lumaMean), 0) / lumaMeans.length,
  );

  const lapVars = frames.map((frame) => laplacianVariance(frame, width, height));
  const lapVarMedian = median(lapVars);
  const meanFrameLapVar = laplacianVariance(temporalMeanFrame(frames), width, height);
  const grainSharpnessRatio =
    lapVarMedian !== null && lapVarMedian > 0 ? meanFrameLapVar / lapVarMedian : null;

  let hfEnergyRatio: number | null = null;
  if (info.displayWidth >= 2 * HF_SAMPLE_WIDTH) {
    const fine = extractSampledGrayFramesAtWidth(
      clipPath,
      info.displayWidth,
      info.displayHeight,
      HF_SAMPLE_WIDTH,
      window,
    );
    const fineLap = median(
      fine.frames.map((frame) => laplacianVariance(frame, fine.width, fine.height)),
    );
    if (fineLap !== null && lapVarMedian !== null && lapVarMedian > 0) {
      hfEnergyRatio = fineLap / lapVarMedian;
    }
  }

  const diffs: number[] = [];
  const extents: MotionExtent[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    diffs.push(meanAbsDiff(frames[i - 1]!, frames[i]!));
    extents.push(motionExtent(frames[i - 1]!, frames[i]!, width, height));
  }
  const meanDiff = mean(diffs);
  const motionHeightFraction = median(extents.map((e) => e.heightFraction));
  const motionWidthFraction = median(extents.map((e) => e.widthFraction));
  const motionCoverage = median(extents.map((e) => e.coverage));

  const gradient = mean(frames.map((frame) => meanSpatialGradient(frame, width, height)));
  const contrastNormalizedMotion =
    meanDiff !== null && gradient !== null && gradient > 0 ? meanDiff / gradient : null;
  const globalShakeScore =
    contrastNormalizedMotion !== null && motionCoverage !== null
      ? contrastNormalizedMotion * motionCoverage
      : null;

  return {
    lowClipFraction,
    highClipFraction,
    bimodalClipScore,
    temporalLumaStd,
    grainSharpnessRatio,
    hfEnergyRatio,
    motionHeightFraction,
    motionWidthFraction,
    motionCoverage,
    contrastNormalizedMotion,
    globalShakeScore,
    meanAbsFrameDiff: meanDiff,
    meanSpatialGradient: gradient,
    sampledFrameCount: frames.length,
  };
}

function extractSampledGrayFramesAtWidth(
  clipPath: string,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  window?: MeasureWindow,
): { width: number; height: number; frames: Uint8Array[] } {
  const width = targetWidth;
  const height = Math.round((sourceHeight * width) / sourceWidth / 2) * 2;
  const windowArgs = window
    ? ["-ss", (window.startMs / 1000).toFixed(3), "-t", (window.durationMs / 1000).toFixed(3)]
    : [];
  const res = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      ...windowArgs,
      "-i",
      clipPath,
      "-vf",
      `fps=${SAMPLE_FPS},scale=${width}:${height},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`ffmpeg failed (${res.status}): ${res.stderr?.toString().slice(-2000)}`);
  }
  const raw = res.stdout;
  const frameBytes = width * height;
  const frameCount = Math.floor(raw.length / frameBytes);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    frames.push(new Uint8Array(raw.buffer, raw.byteOffset + i * frameBytes, frameBytes));
  }
  return { width, height, frames };
}
