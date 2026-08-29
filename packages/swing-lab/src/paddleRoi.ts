/**
 * Dynamic target-ROI planning for the two-pass detector schedule (D4-04).
 *
 * Pass 1 of the adaptive schedule (paddleSchedule.ts) is a sparse scan whose
 * only job is to locate the paddle trajectory cheaply. The target's paddle
 * can only live near the target's hands, so pass 1 may crop inference to a
 * zone built from the TARGET's wrist positions over the detect span — the
 * detector then processes a fraction of the pixels per sparse frame.
 *
 * Scope is deliberately narrow:
 *   - ROI applies to PASS 1 ONLY. Pass 2 (dense, near contact/uncertainty)
 *     always runs full-frame — contact-zone evidence must never be cropped
 *     (H invalidated static stride-3+ROI exactly there).
 *   - BOTH wrists always contribute (W12: Apple Vision swaps L/R on rear
 *     views — handedness must never pick the wrist).
 *   - Any doubt → full frame. Missing pose coverage over the span, a zone
 *     that isn't meaningfully smaller than the frame, or a degenerate span
 *     all fall back to the untouched full-frame pass 1.
 *
 * This is a pure plan (pose in, rectangle out) so it is unit-testable on
 * Linux; the realized rectangle is recorded in paddle-schedule.json.
 */

export const PASS1_ROI_VERSION = "pass1-roi-v1";

export interface Pass1RoiConfig {
  /** Normalized pad added around the wrist envelope on every side. Sized to
   *  cover forearm + paddle reach beyond the wrist point. */
  padNorm: number;
  /** Minimum fraction of span pose frames with ≥1 visible wrist. */
  minWristCoverage: number;
  /** ROI area above this fraction of the frame buys nothing — full frame. */
  maxAreaFraction: number;
}

export const DEFAULT_PASS1_ROI_CONFIG: Pass1RoiConfig = {
  padNorm: 0.15,
  minWristCoverage: 0.5,
  maxAreaFraction: 0.8,
};

export type Pass1RoiPlan =
  | {
      status: "roi";
      version: typeof PASS1_ROI_VERSION;
      config: Pass1RoiConfig;
      /** x0,y0,x1,y1 — normalized top-left, detect_paddle.py --roi format. */
      roiNorm: [number, number, number, number];
      areaFraction: number;
      wristCoverage: number;
      wristFrames: number;
      spanFrames: number;
    }
  | {
      status: "full_frame";
      version: typeof PASS1_ROI_VERSION;
      config: Pass1RoiConfig;
      reason: "empty_span" | "insufficient_wrist_coverage" | "roi_not_smaller";
      wristCoverage: number;
      wristFrames: number;
      spanFrames: number;
    };

export interface Pass1RoiInput {
  /** Target-player wrist series (normalized top-left; both wrists). */
  wrists: ReadonlyArray<{ timestampMs: number; wrists: ReadonlyArray<{ x: number; y: number }> }>;
  detectSpan: { startMs: number; endMs: number };
  config?: Partial<Pass1RoiConfig>;
}

export function planPass1Roi(input: Pass1RoiInput): Pass1RoiPlan {
  const config: Pass1RoiConfig = { ...DEFAULT_PASS1_ROI_CONFIG, ...input.config };
  const inSpan = input.wrists.filter(
    (frame) =>
      frame.timestampMs >= input.detectSpan.startMs && frame.timestampMs <= input.detectSpan.endMs,
  );
  const withWrists = inSpan.filter((frame) => frame.wrists.length > 0);
  const base = {
    version: PASS1_ROI_VERSION,
    config,
    wristFrames: withWrists.length,
    spanFrames: inSpan.length,
  } as const;
  if (inSpan.length === 0) {
    return { ...base, status: "full_frame", reason: "empty_span", wristCoverage: 0 };
  }
  const wristCoverage = withWrists.length / inSpan.length;
  if (wristCoverage < config.minWristCoverage) {
    return { ...base, status: "full_frame", reason: "insufficient_wrist_coverage", wristCoverage };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const frame of withWrists) {
    for (const wrist of frame.wrists) {
      minX = Math.min(minX, wrist.x);
      minY = Math.min(minY, wrist.y);
      maxX = Math.max(maxX, wrist.x);
      maxY = Math.max(maxY, wrist.y);
    }
  }
  const x0 = clamp01(minX - config.padNorm);
  const y0 = clamp01(minY - config.padNorm);
  const x1 = clamp01(maxX + config.padNorm);
  const y1 = clamp01(maxY + config.padNorm);
  const areaFraction = (x1 - x0) * (y1 - y0);
  if (areaFraction > config.maxAreaFraction) {
    return { ...base, status: "full_frame", reason: "roi_not_smaller", wristCoverage };
  }
  return {
    ...base,
    status: "roi",
    roiNorm: [round4(x0), round4(y0), round4(x1), round4(y1)],
    areaFraction: round4(areaFraction),
    wristCoverage: round4(wristCoverage),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
