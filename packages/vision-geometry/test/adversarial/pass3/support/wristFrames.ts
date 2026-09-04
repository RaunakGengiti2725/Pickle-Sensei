import type { PoseFrame } from "@pickle/shared-types";
import type { StrokeEvent } from "@pickle/vision-contracts";

/**
 * Adversarial fixture builders (pass 3, pkg-vision-geometry). Every frame is
 * built from exact binary fractions (multiples of 1/1024) so path lengths and
 * central-difference speeds are bit-exact and reproducible across runs.
 */

export const FRAME_MS = 1000 / 60;
export const UNIT = 1 / 1024;

export function wristFrame(
  timestampMs: number,
  x: number,
  y: number,
  options: { visibility?: number; confidence?: number; name?: "right_wrist" | "left_wrist" } = {},
): PoseFrame {
  return {
    timestampMs,
    space: "normalized-image",
    confidence: options.confidence ?? 1,
    landmarks: [
      { name: options.name ?? "right_wrist", x, y, visibility: options.visibility ?? 0.9 },
    ],
  };
}

/**
 * Frames whose right wrist advances along +x by `steps[i]` units (1/1024)
 * between frame i-1 and i. Central-difference speed at frame i is therefore
 * (steps[i] + steps[i+1]) / (2·FRAME_MS) exactly.
 */
export function framesFromSteps(steps: readonly number[], startMs = 0): PoseFrame[] {
  const frames: PoseFrame[] = [];
  let x = 0;
  for (let index = 0; index < steps.length; index += 1) {
    x += (steps[index] ?? 0) * UNIT;
    frames.push(wristFrame(startMs + index * FRAME_MS, x, 0.5));
  }
  return frames;
}

/** Triangular step bump of half-width `halfWidth` frames centred at `center`. */
export function bumpSteps(
  length: number,
  centers: readonly number[],
  options: { base?: number; peak?: number; halfWidth?: number } = {},
): number[] {
  const base = options.base ?? 1;
  const peak = options.peak ?? 40;
  const halfWidth = options.halfWidth ?? 6;
  return Array.from({ length }, (_, index) => {
    let value = base;
    for (const center of centers) {
      const distance = Math.abs(index - center);
      if (distance <= halfWidth) {
        value = Math.max(
          value,
          base + Math.round(((halfWidth - distance) / halfWidth) * (peak - base)),
        );
      }
    }
    return value;
  });
}

export function stroke(
  startMs: number,
  endMs: number,
  contactMs: number | null = null,
  confidence = 0.9,
): StrokeEvent {
  return { startMs, endMs, contactMs, shotTypeHypothesis: null, confidence };
}

/** Deterministic PRNG (mulberry32) so any randomised attack records its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
