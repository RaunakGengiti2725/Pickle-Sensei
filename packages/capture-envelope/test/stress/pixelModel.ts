import type { Rng } from "./prng.js";

/**
 * Independent re-implementation of the exported pixel statistics
 * (laplacianVariance, meanLuma, meanAbsDiff, spatialStd, clippedPixelFraction)
 * used as an oracle for seeded synthetic frames. Written straight from the
 * definitions in src/clipProbe.ts comments, not by copying the code.
 */

export interface SyntheticFrame {
  width: number;
  height: number;
  pattern: string;
  data: Uint8Array;
}

export const FRAME_PATTERNS = [
  "constant",
  "h_gradient",
  "v_gradient",
  "noise",
  "checker",
  "bimodal",
  "hot_pixel",
  "clipped_dark",
  "clipped_bright",
] as const;

export type FramePattern = (typeof FRAME_PATTERNS)[number];

export function buildFrame(
  rng: Rng,
  width: number,
  height: number,
  pattern: FramePattern,
): SyntheticFrame {
  const data = new Uint8Array(width * height);
  const constant = rng.int(0, 255);
  const period = rng.int(1, 6);
  const lo = rng.int(0, 120);
  const hi = rng.int(130, 255);
  const hotIndex = data.length > 0 ? rng.int(0, data.length - 1) : 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let value = 0;
      switch (pattern) {
        case "constant":
          value = constant;
          break;
        case "h_gradient":
          value = width > 1 ? Math.round((x / (width - 1)) * 255) : constant;
          break;
        case "v_gradient":
          value = height > 1 ? Math.round((y / (height - 1)) * 255) : constant;
          break;
        case "noise":
          value = rng.int(0, 255);
          break;
        case "checker":
          value = (Math.floor(x / period) + Math.floor(y / period)) % 2 === 0 ? lo : hi;
          break;
        case "bimodal":
          value = rng.chance(0.5) ? lo : hi;
          break;
        case "hot_pixel":
          value = index === hotIndex ? 255 : 0;
          break;
        case "clipped_dark":
          value = rng.chance(0.7) ? rng.int(0, 16) : rng.int(17, 255);
          break;
        case "clipped_bright":
          value = rng.chance(0.7) ? rng.int(235, 255) : rng.int(0, 234);
          break;
      }
      data[index] = value;
    }
  }
  return { width, height, pattern, data };
}

export function modelMeanLuma(frame: SyntheticFrame): number {
  if (frame.data.length === 0) return 0;
  let sum = 0;
  for (const v of frame.data) sum += v;
  return sum / frame.data.length;
}

export function modelSpatialStd(frame: SyntheticFrame): number {
  if (frame.data.length === 0) return 0;
  const mean = modelMeanLuma(frame);
  let acc = 0;
  for (const v of frame.data) acc += (v - mean) * (v - mean);
  return Math.sqrt(acc / frame.data.length);
}

/** Fraction of pixels at/beyond the luma clipping points (<=16, >=235) across frames; null when no pixels. */
export function modelClippedFraction(frames: SyntheticFrame[]): number | null {
  let clipped = 0;
  let total = 0;
  for (const frame of frames) {
    for (const v of frame.data) if (v <= 16 || v >= 235) clipped += 1;
    total += frame.data.length;
  }
  return total > 0 ? clipped / total : null;
}

/** Variance of the 4-neighbour Laplacian over interior pixels; 0 when there is no interior. */
export function modelLaplacianVariance(frame: SyntheticFrame): number {
  const { width, height, data } = frame;
  if (width < 3 || height < 3) return 0;
  const values: number[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const c = data[y * width + x]!;
      const up = data[(y - 1) * width + x]!;
      const down = data[(y + 1) * width + x]!;
      const left = data[y * width + x - 1]!;
      const right = data[y * width + x + 1]!;
      values.push(up + down + left + right - 4 * c);
    }
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
}

export function modelMeanAbsDiff(a: SyntheticFrame, b: SyntheticFrame): number {
  if (a.data.length === 0) return 0;
  let acc = 0;
  for (let i = 0; i < a.data.length; i += 1) acc += Math.abs(a.data[i]! - b.data[i]!);
  return acc / a.data.length;
}

export function approxEqual(
  actual: number,
  expected: number,
  relTol = 1e-9,
  absTol = 1e-9,
): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  return Math.abs(actual - expected) <= Math.max(absTol, relTol * Math.abs(expected));
}
