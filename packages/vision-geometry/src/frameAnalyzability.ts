import { median } from "./kinematics.js";

/**
 * Frame-statistic analyzability — the pose-free half of the pre-analysis
 * gate. `captureQuality.ts` decides analyzability from measured POSE data;
 * this module decides it from raw FRAME statistics, so out-of-distribution
 * inputs (a still image exported as video, a solid-color clip, a letterboxed
 * title card, a single-frame file) are rejected BEFORE pose extraction is
 * ever trusted. Same contract as capture quality: specific reason codes,
 * nothing not measured is claimed (`notEvaluated`).
 *
 * Luma values are on the 0–255 scale of an 8-bit grayscale decode.
 */

export interface FrameStats {
  frameCount: number;
  /** Container duration; 0 when the demuxer cannot report one. */
  durationMs: number;
  width: number;
  height: number;
  /** Mean absolute luma difference per consecutive frame pair (length = frameCount − 1). */
  interFrameDiffs: number[];
  /** Per-frame spatial luma standard deviation. */
  spatialLumaStd: number[];
  /**
   * Fraction of image rows belonging to uniform near-black horizontal bars
   * at the top/bottom of the frame, averaged over frames.
   */
  letterboxRowFraction: number;
}

export interface FrameAnalyzabilityReport {
  analyzable: boolean;
  reasons: string[];
  notEvaluated: string[];
  stats: {
    frameCount: number;
    durationMs: number;
    medianInterFrameDiff: number;
    medianSpatialLumaStd: number;
    letterboxRowFraction: number;
  };
}

export const FRAME_ANALYZABILITY_VERSION = "frame-analyzability-1";

export const FRAME_THRESHOLDS = {
  /** Below two frames there is no motion signal at all. */
  minFrames: 2,
  /** A stroke cannot be captured in less than this. */
  minDurationMs: 500,
  /** Beyond this the clip is not a single-stroke capture. */
  maxDurationMs: 10 * 60 * 1000,
  /** Median inter-frame diff at or below this = still image played as video. */
  stillImageMaxDiff: 0.5,
  /** Median spatial luma std at or below this = solid-color frames. */
  solidColorMaxStd: 2,
  /** At or above this fraction of bar rows the content area is a letterboxed card. */
  letterboxMaxFraction: 0.4,
} as const;

/** Reason codes this gate can emit (closed set, used by the fuzz suite). */
export const FRAME_ANALYZABILITY_REASONS = [
  "single_frame_clip",
  "duration_too_short",
  "duration_implausibly_long",
  "still_image_video",
  "solid_color_frames",
  "letterbox_dominant",
] as const;

export function evaluateFrameAnalyzability(stats: FrameStats): FrameAnalyzabilityReport {
  const reasons: string[] = [];
  const medianDiff = stats.interFrameDiffs.length > 0 ? median(stats.interFrameDiffs) : 0;
  const medianStd = stats.spatialLumaStd.length > 0 ? median(stats.spatialLumaStd) : 0;

  if (stats.frameCount < FRAME_THRESHOLDS.minFrames) {
    reasons.push("single_frame_clip");
  } else {
    if (stats.durationMs > 0 && stats.durationMs < FRAME_THRESHOLDS.minDurationMs) {
      reasons.push("duration_too_short");
    }
    if (stats.durationMs > FRAME_THRESHOLDS.maxDurationMs) {
      reasons.push("duration_implausibly_long");
    }
    if (medianDiff <= FRAME_THRESHOLDS.stillImageMaxDiff) {
      reasons.push("still_image_video");
    }
  }
  if (stats.frameCount > 0 && medianStd <= FRAME_THRESHOLDS.solidColorMaxStd) {
    reasons.push("solid_color_frames");
  }
  if (stats.letterboxRowFraction >= FRAME_THRESHOLDS.letterboxMaxFraction) {
    reasons.push("letterbox_dominant");
  }

  return {
    analyzable: reasons.length === 0,
    reasons,
    notEvaluated: [
      "camera_motion", // needs feature tracking, not per-frame statistics
      "scene_cuts", // owned by swing-lab sceneValidity (luma-histogram detector)
      "exposure_flicker", // needs temporal luma-histogram analysis we do not run yet
    ],
    stats: {
      frameCount: stats.frameCount,
      durationMs: stats.durationMs,
      medianInterFrameDiff: medianDiff,
      medianSpatialLumaStd: medianStd,
      letterboxRowFraction: stats.letterboxRowFraction,
    },
  };
}
