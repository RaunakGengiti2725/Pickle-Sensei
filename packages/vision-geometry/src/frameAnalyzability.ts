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
  /**
   * Temporal statistics of the outermost border ring of pixels (all four
   * edges). A physical bezel around a re-filmed screen is temporally frozen
   * and dark on every edge — unlike letterbox bars, which are only
   * horizontal. Absent = not measured (reported in `notEvaluated`).
   */
  borderRing?: {
    /** Mean per-pixel temporal luma std over the ring. */
    temporalStd: number;
    /** Mean luma over the ring across all frames. */
    meanLuma: number;
  };
  /**
   * Temporally frozen (per-pixel temporal std ≤ ~0.5) 4-connected pixel
   * components lying entirely in the bottom third of the raster — where a
   * broadcast score graphic sits over otherwise-moving court content.
   * Absent = not measured (reported in `notEvaluated`).
   */
  bottomFrozenComponents?: Array<{
    /** Component size in raster pixels. */
    size: number;
    /** Spatial std of the mean-luma image inside the component (text contrast). */
    lumaStd: number;
  }>;
  /**
   * Container-declared source dimensions (before the stats rescale), used to
   * reject extreme aspect ratios no real capture device produces. Absent =
   * not measured (reported in `notEvaluated`).
   */
  source?: {
    width: number;
    height: number;
  };
  /**
   * Decode-integrity measurements from the stats decode pass. Absent = not
   * measured (reported in `notEvaluated`).
   */
  decode?: {
    /** Count of decoder error lines emitted while producing the raster. */
    errorCount: number;
    /**
     * Frames the container claims (duration × declared frame rate); null when
     * either is unknown.
     */
    expectedFrameCount: number | null;
  };
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

export const FRAME_ANALYZABILITY_VERSION = "frame-analyzability-3";

export const FRAME_THRESHOLDS = {
  /** Below two frames there is no motion signal at all. */
  minFrames: 2,
  /** A stroke cannot be captured in less than this. */
  minDurationMs: 500,
  /** Beyond this the clip is not a single-stroke capture. */
  maxDurationMs: 10 * 60 * 1000,
  /** A consecutive frame pair is frozen when its mean abs diff is at or below this. */
  frozenPairMaxDiff: 0.02,
  /** At or above this fraction of frozen pairs = still image(s) played as video. */
  stillImageMinFrozenFraction: 0.5,
  /** Median spatial luma std at or below this = solid-color frames. */
  solidColorMaxStd: 2,
  /** At or above this fraction of bar rows the content area is a letterboxed card. */
  letterboxMaxFraction: 0.4,
  /** Border ring at or below this temporal std = frozen frame border. */
  staticBorderMaxTemporalStd: 1,
  /** ...and at or below this mean luma = dark bezel, not scene content. */
  staticBorderMaxLuma: 48,
  /** A frozen bottom-third component this large... */
  overlayMinComponentSize: 8,
  /** ...with at least this internal luma contrast = static graphic overlay. */
  overlayMinComponentLumaStd: 12,
  /** Source width/height ratio above this (or below its inverse) = no real capture device. */
  maxAspectRatio: 4,
  /** With decoder errors present, decoding below this fraction of the declared frames = truncated/corrupt. */
  minDecodedFrameFraction: 0.9,
} as const;

/** Reason codes this gate can emit (closed set, used by the fuzz suite). */
export const FRAME_ANALYZABILITY_REASONS = [
  "single_frame_clip",
  "duration_too_short",
  "duration_implausibly_long",
  "still_image_video",
  "solid_color_frames",
  "letterbox_dominant",
  "static_border_frame",
  "static_overlay_suspected",
  "implausible_aspect_ratio",
  "undecodable_media",
  "decoded_frame_deficit",
] as const;

export function evaluateFrameAnalyzability(stats: FrameStats): FrameAnalyzabilityReport {
  const reasons: string[] = [];
  const medianDiff = stats.interFrameDiffs.length > 0 ? median(stats.interFrameDiffs) : 0;
  const medianStd = stats.spatialLumaStd.length > 0 ? median(stats.spatialLumaStd) : 0;
  const frozenPairFraction =
    stats.interFrameDiffs.length > 0
      ? stats.interFrameDiffs.filter((d) => d <= FRAME_THRESHOLDS.frozenPairMaxDiff).length /
        stats.interFrameDiffs.length
      : 1;

  if (stats.frameCount < FRAME_THRESHOLDS.minFrames) {
    reasons.push("single_frame_clip");
  } else {
    if (stats.durationMs > 0 && stats.durationMs < FRAME_THRESHOLDS.minDurationMs) {
      reasons.push("duration_too_short");
    }
    if (stats.durationMs > FRAME_THRESHOLDS.maxDurationMs) {
      reasons.push("duration_implausibly_long");
    }
    if (frozenPairFraction >= FRAME_THRESHOLDS.stillImageMinFrozenFraction) {
      reasons.push("still_image_video");
    }
  }
  if (stats.frameCount > 0 && medianStd <= FRAME_THRESHOLDS.solidColorMaxStd) {
    reasons.push("solid_color_frames");
  }
  if (stats.letterboxRowFraction >= FRAME_THRESHOLDS.letterboxMaxFraction) {
    reasons.push("letterbox_dominant");
  }
  if (
    stats.borderRing !== undefined &&
    stats.frameCount >= FRAME_THRESHOLDS.minFrames &&
    stats.borderRing.temporalStd <= FRAME_THRESHOLDS.staticBorderMaxTemporalStd &&
    stats.borderRing.meanLuma <= FRAME_THRESHOLDS.staticBorderMaxLuma
  ) {
    reasons.push("static_border_frame");
  }
  if (stats.source !== undefined && stats.source.width > 0 && stats.source.height > 0) {
    const aspect = stats.source.width / stats.source.height;
    if (aspect > FRAME_THRESHOLDS.maxAspectRatio || aspect < 1 / FRAME_THRESHOLDS.maxAspectRatio) {
      reasons.push("implausible_aspect_ratio");
    }
  }
  if (stats.decode !== undefined && stats.decode.errorCount > 0) {
    if (stats.frameCount === 0) {
      reasons.push("undecodable_media");
    } else if (
      stats.decode.expectedFrameCount !== null &&
      stats.decode.expectedFrameCount >= FRAME_THRESHOLDS.minFrames &&
      stats.frameCount < FRAME_THRESHOLDS.minDecodedFrameFraction * stats.decode.expectedFrameCount
    ) {
      reasons.push("decoded_frame_deficit");
    }
  }
  if (
    stats.bottomFrozenComponents !== undefined &&
    !reasons.includes("still_image_video") &&
    stats.bottomFrozenComponents.some(
      (component) =>
        component.size >= FRAME_THRESHOLDS.overlayMinComponentSize &&
        component.lumaStd >= FRAME_THRESHOLDS.overlayMinComponentLumaStd,
    )
  ) {
    reasons.push("static_overlay_suspected");
  }

  const notEvaluated = [
    "camera_motion", // needs feature tracking, not per-frame statistics
    "scene_cuts", // owned by swing-lab sceneValidity (luma-histogram detector)
    "exposure_flicker", // needs temporal luma-histogram analysis we do not run yet
    "playback_speed", // resampled (e.g. 2x) playback is statistically a normal capture here
  ];
  if (stats.borderRing === undefined) notEvaluated.push("static_border_frame");
  if (stats.bottomFrozenComponents === undefined) notEvaluated.push("static_overlay_suspected");
  if (stats.source === undefined) notEvaluated.push("source_aspect_ratio");
  if (stats.decode === undefined) notEvaluated.push("decode_integrity");

  return {
    analyzable: reasons.length === 0,
    reasons,
    notEvaluated,
    stats: {
      frameCount: stats.frameCount,
      durationMs: stats.durationMs,
      medianInterFrameDiff: medianDiff,
      medianSpatialLumaStd: medianStd,
      letterboxRowFraction: stats.letterboxRowFraction,
    },
  };
}
