import type {
  EnvelopeDimension,
  EnvelopeStatus,
  EnvelopeVerdict,
} from '@pickle/shared-types';
import { ENVELOPE_DIMENSIONS } from '@pickle/shared-types';
import {
  evaluateCaptureEnvelope,
  type CaptureEnvelopeMeasurements,
} from '@pickle/capture-envelope';
import type { CapturedClip, CaptureQualitySignalsV1 } from './capture';

/**
 * Capture envelope — the canonical EnvelopeVerdict from @pickle/shared-types
 * (C12), evaluated on-device by the shared checker in
 * @pickle/capture-envelope with its versioned provisional thresholds.
 *
 * Two evaluation points, both honest about what was actually measured:
 *  - LIVE (pre-Ready): readiness events supply player visibility; the typed
 *    native quality contract (CaptureQualitySignalsV1) supplies resolution,
 *    fps, brightness, blur and camera-motion proxies when an emitter exists.
 *    Everything else is NOT_MEASURED — never guessed.
 *  - ATTEMPT (at analysis time): the recorded clip's configured
 *    resolution/fps/duration are real capture-config values; preview-derived
 *    proxies and readiness visibility carry over from the live window.
 *
 * Ready gating blocks ONLY on UNSUPPORTED; DEGRADED guides but permits.
 * All functions are pure (no React, no IO) so jest pins them directly.
 */

/** Live readiness snapshot the envelope consumes (subset of the event). */
export interface ReadinessSnapshot {
  state: string;
  jointCoverage: number;
}

function readinessVisibility(
  readiness: ReadinessSnapshot | null,
): number | null {
  if (!readiness) return null;
  // no_person is an observed zero-visibility read, not an absence of data.
  if (readiness.state === 'no_person') return 0;
  return readiness.jointCoverage;
}

function qualityMeasurements(
  quality: CaptureQualitySignalsV1 | null,
): Pick<
  CaptureEnvelopeMeasurements,
  | 'frameWidthPx'
  | 'frameHeightPx'
  | 'avgFrameRateFps'
  | 'brightnessMeanLuma'
  | 'laplacianVarianceMedian'
  | 'meanAbsFrameDiff'
> {
  return {
    frameWidthPx: quality?.frameWidthPx ?? null,
    frameHeightPx: quality?.frameHeightPx ?? null,
    avgFrameRateFps: quality?.avgFrameRateFps ?? null,
    brightnessMeanLuma: quality?.brightnessMeanLuma ?? null,
    laplacianVarianceMedian: quality?.laplacianVarianceMedian ?? null,
    meanAbsFrameDiff: quality?.meanAbsFrameDiff ?? null,
  };
}

/**
 * Live pre-Ready envelope. Returns null when NOTHING has been measured yet
 * (no readiness event and no native quality signals) — no verdict is
 * fabricated from silence.
 */
export function liveCaptureEnvelope(
  readiness: ReadinessSnapshot | null,
  quality: CaptureQualitySignalsV1 | null,
): EnvelopeVerdict | null {
  if (!readiness && !quality) return null;
  return evaluateCaptureEnvelope({
    ...qualityMeasurements(quality),
    frameIntervalCv: null,
    brightnessStdLuma: null,
    clipDurationMs: null,
    playerPixelHeightFraction: null,
    playerMeanJointVisibility: readinessVisibility(readiness),
  });
}

/**
 * Attempt envelope evaluated when a recorded clip enters analysis.
 * Resolution, frame rate and duration come from the clip's real capture
 * configuration; preview-derived proxies and readiness visibility carry
 * over from the live window (null when never emitted/observed).
 */
export function attemptCaptureEnvelope(
  clip: Pick<CapturedClip, 'width' | 'height' | 'fps' | 'durationMs'>,
  quality: CaptureQualitySignalsV1 | null,
  readiness: ReadinessSnapshot | null,
): EnvelopeVerdict {
  const proxies = qualityMeasurements(quality);
  return evaluateCaptureEnvelope({
    ...proxies,
    frameWidthPx: clip.width,
    frameHeightPx: clip.height,
    avgFrameRateFps: clip.fps,
    frameIntervalCv: null,
    brightnessStdLuma: null,
    clipDurationMs: clip.durationMs,
    playerPixelHeightFraction: null,
    playerMeanJointVisibility: readinessVisibility(readiness),
  });
}

export interface CaptureGuidanceLine {
  dimension: EnvelopeDimension;
  status: Exclude<EnvelopeStatus, 'SUPPORTED' | 'NOT_MEASURED'>;
  /** Actionable instruction — tells the player what to change, not what failed. */
  text: string;
}

const GUIDANCE_COPY: Record<
  EnvelopeDimension,
  Record<'DEGRADED' | 'UNSUPPORTED', string>
> = {
  resolution: {
    DEGRADED:
      'Video resolution is low — a higher-quality setting sharpens the read.',
    UNSUPPORTED:
      'Video resolution is too low for analysis — raise the camera quality setting.',
  },
  frame_rate: {
    DEGRADED: 'Frame rate is a little low — 30fps or higher improves the read.',
    UNSUPPORTED:
      'Frame rate is too low to follow a swing — use 30fps or higher.',
  },
  brightness: {
    DEGRADED: 'It looks dim or washed out — better light sharpens the read.',
    UNSUPPORTED:
      'The scene is too dark or too bright to read — adjust the lighting.',
  },
  motion_blur: {
    DEGRADED: 'The image is a bit soft — more light or a cleaner lens helps.',
    UNSUPPORTED:
      'The image is too blurry to read — add light and steady the phone.',
  },
  camera_motion: {
    DEGRADED:
      'The camera is moving a little — a steadier mount improves the read.',
    UNSUPPORTED: 'The camera is moving too much — prop it on something stable.',
  },
  timing_stability: {
    DEGRADED:
      'Frame timing is uneven — closing other apps or a device restart helps.',
    UNSUPPORTED:
      'Frame timing is too uneven to follow a swing — close other apps and try again.',
  },
  clip_duration: {
    DEGRADED: 'The clip length is outside the ideal range for a clean read.',
    UNSUPPORTED: 'The clip is too short or too long to analyze a single swing.',
  },
  player_pixel_height: {
    DEGRADED: 'You look small in frame — moving closer improves the read.',
    UNSUPPORTED:
      'You are too small in frame to analyze — move the phone closer.',
  },
  player_visibility: {
    DEGRADED: 'Keep your full body visible — a joint keeps leaving the frame.',
    UNSUPPORTED: 'Keep your full body visible inside the corners.',
  },
};

/**
 * Actionable guidance lines for every MEASURED dimension that is DEGRADED
 * or UNSUPPORTED, in canonical dimension order. NOT_MEASURED dimensions
 * produce nothing: guidance is never invented for a condition nobody read.
 */
export function captureGuidanceLines(
  envelope: EnvelopeVerdict | null,
): CaptureGuidanceLine[] {
  if (!envelope) return [];
  const byDimension = new Map(envelope.dimensions.map(d => [d.dimension, d]));
  const lines: CaptureGuidanceLine[] = [];
  for (const dimension of ENVELOPE_DIMENSIONS) {
    const verdict = byDimension.get(dimension);
    if (!verdict) continue;
    if (verdict.status !== 'DEGRADED' && verdict.status !== 'UNSUPPORTED') {
      continue;
    }
    lines.push({
      dimension,
      status: verdict.status,
      text: GUIDANCE_COPY[dimension][verdict.status],
    });
  }
  return lines;
}

export interface ReadyGate {
  blocked: boolean;
  /** The UNSUPPORTED dimensions that block Ready (DEGRADED never blocks). */
  blockingDimensions: EnvelopeDimension[];
}

/** Ready is blocked ONLY by UNSUPPORTED dimensions; DEGRADED guides but permits. */
export function readyGate(envelope: EnvelopeVerdict | null): ReadyGate {
  if (!envelope) return { blocked: false, blockingDimensions: [] };
  const blockingDimensions = envelope.dimensions
    .filter(d => d.status === 'UNSUPPORTED')
    .map(d => d.dimension);
  return { blocked: blockingDimensions.length > 0, blockingDimensions };
}
