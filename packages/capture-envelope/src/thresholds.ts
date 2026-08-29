/**
 * Capture-envelope thresholds — VERSIONED and PROVISIONAL.
 *
 * Every constant below is a starting hypothesis, NOT a validated envelope.
 * The mandate is empirical: these bands must be re-learned from labeled
 * evidence (clips whose downstream analyzability is known) and re-versioned
 * when they change. Until then every verdict carries `provisional: true`.
 *
 * Band semantics: measured value inside `supported` → SUPPORTED, else inside
 * `degraded` → DEGRADED, else UNSUPPORTED. Bounds are inclusive.
 */

export const CAPTURE_ENVELOPE_THRESHOLDS_VERSION = "capture-envelope-thresholds-v0.1-provisional";
export const CAPTURE_ENVELOPE_THRESHOLDS_PROVISIONAL = true;

export interface EnvelopeBand {
  min?: number;
  max?: number;
}

export interface DimensionThreshold {
  id: string;
  unit: string;
  supported: EnvelopeBand;
  degraded: EnvelopeBand;
}

export const CAPTURE_ENVELOPE_THRESHOLDS = {
  /** Short side of the frame, px. */
  resolution: {
    id: "resolution-short-side-v0.1",
    unit: "px (short side)",
    supported: { min: 720 },
    degraded: { min: 480 },
  },
  /** Average frame rate, fps. */
  frame_rate: {
    id: "frame-rate-avg-v0.1",
    unit: "fps",
    supported: { min: 29 },
    degraded: { min: 24 },
  },
  /** Mean luma of sampled grayscale frames, 0–255. */
  brightness: {
    id: "brightness-mean-luma-v0.1",
    unit: "luma 0-255",
    supported: { min: 60, max: 200 },
    degraded: { min: 40, max: 220 },
  },
  /**
   * Motion-blur proxy: median Laplacian variance of sampled frames,
   * computed on 320px-wide grayscale downscales (scale-sensitive — the
   * measurement pipeline must match this normalization).
   */
  motion_blur: {
    id: "laplacian-variance-320w-median-v0.1",
    unit: "laplacian variance @320w",
    supported: { min: 100 },
    degraded: { min: 30 },
  },
  /**
   * Camera-motion proxy: mean absolute per-pixel luma difference between
   * consecutive sampled frames (same 320px-wide grayscale normalization).
   * High values ⇒ global motion / unstable mount.
   */
  camera_motion: {
    id: "global-frame-diff-320w-v0.1",
    unit: "mean abs luma diff @320w",
    supported: { max: 6 },
    degraded: { max: 14 },
  },
  /** Clip duration, ms. */
  clip_duration: {
    id: "clip-duration-v0.1",
    unit: "ms",
    supported: { min: 2000, max: 90_000 },
    degraded: { min: 1000, max: 180_000 },
  },
  /** Player bounding height as a fraction of frame height (pose required). */
  player_pixel_height: {
    id: "player-pixel-height-fraction-v0.1",
    unit: "fraction of frame height",
    supported: { min: 0.25 },
    degraded: { min: 0.12 },
  },
  /** Mean joint visibility across pose frames (pose required). */
  player_visibility: {
    id: "player-mean-joint-visibility-v0.1",
    unit: "mean visibility 0-1",
    supported: { min: 0.5 },
    degraded: { min: 0.3 },
  },
} as const satisfies Record<string, DimensionThreshold>;
