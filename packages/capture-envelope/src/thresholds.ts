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

export const CAPTURE_ENVELOPE_THRESHOLDS_VERSION = "capture-envelope-thresholds-v0.3-provisional";
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
  /**
   * Average frame rate, fps. v0.2: 24fps footage repeatedly completed
   * downstream analysis (7 of 9 downstream-good corpus units measured at
   * 24fps, E15), so 24 is inside the supported band. The degraded floor
   * remains a hypothesis: no labeled evidence exists between 8fps
   * (synthetic UNSUPPORTED, D3-07) and 24fps.
   */
  frame_rate: {
    id: "frame-rate-avg-v0.2",
    unit: "fps",
    supported: { min: 24 },
    degraded: { min: 15 },
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
   *
   * v0.2 recalibration from E15 corpus evidence: the proxy conflates
   * subject motion with camera motion, and downstream-good units measured
   * 7.8–32.7 (v0.1 supported max 6 flagged 9/9 of them; AUC 0.38, i.e.
   * the old bands flagged the wrong side). Supported covers the observed
   * downstream-good range; degraded covers the rest of the observed corpus
   * range (max 45.6). p100-based with n=9 good units — still provisional.
   *
   * F18 construct check (controlled pan injection, wave-f
   * f18-degradation-ladders.json): the proxy rises monotonically with true
   * camera motion but cannot separate it from subject motion — injected
   * pans of 1–8 px @320w on most downstream-good units measure below the
   * subject-motion-only maximum (38.5), and 2 of 9 zero-camera-motion
   * controls already exceed the supported edge. Treat this dimension as a
   * weak global-motion screen, not a camera-stability verdict; fixing it
   * requires a background-registered motion estimate, not band re-tuning.
   */
  camera_motion: {
    id: "global-frame-diff-320w-v0.2",
    unit: "mean abs luma diff @320w",
    supported: { max: 33 },
    degraded: { max: 46 },
  },
  /**
   * Timing-stability proxy: coefficient of variation (std dev / mean) of
   * inter-frame presentation intervals. Near 0 for constant-frame-rate
   * capture; large for VFR clips whose AVERAGE frame rate still looks fine.
   */
  timing_stability: {
    id: "timing-stability-interval-cv-v0.2",
    unit: "cv of frame intervals",
    supported: { max: 0.15 },
    degraded: { max: 0.35 },
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
