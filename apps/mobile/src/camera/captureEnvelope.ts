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
    denoiseSurvivalRatio: null,
    clippedPixelFraction: null,
    contrastNormalizedFrameDiff: null,
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
    denoiseSurvivalRatio: null,
    clippedPixelFraction: null,
    contrastNormalizedFrameDiff: null,
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
  exposure_clipping: {
    DEGRADED:
      'Parts of the scene are fully dark or blown out — more even light helps.',
    UNSUPPORTED:
      'Too much of the scene is fully dark or blown out to read — fix the exposure.',
  },
  exposure_stability: {
    DEGRADED:
      'The exposure keeps changing — steadier lighting improves the read.',
    UNSUPPORTED:
      'The exposure is flickering too much to read — avoid flashing or pulsing light.',
  },
  motion_blur: {
    DEGRADED: 'The image is a bit soft — more light or a cleaner lens helps.',
    UNSUPPORTED:
      'The image is too blurry to read — add light and steady the phone.',
  },
  sensor_noise: {
    DEGRADED: 'The image looks grainy — more light reduces sensor noise.',
    UNSUPPORTED:
      'The image is too noisy to read — add light or lower the camera ISO.',
  },
  camera_motion: {
    DEGRADED:
      'The camera is moving a little — a steadier mount improves the read.',
    UNSUPPORTED: 'The camera is moving too much — prop it on something stable.',
  },
  camera_shake: {
    DEGRADED:
      'The camera is shaking a little — a steadier mount improves the read.',
    UNSUPPORTED:
      'The camera is shaking too much — prop it on something stable.',
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

/**
 * User-facing message for an analysis withheld on an UNSUPPORTED envelope.
 * Combines the pipeline's honest reason with the actionable guidance line
 * for every measured non-SUPPORTED dimension, so the player learns what to
 * CHANGE — not just which internal dimension names failed.
 */
export function qualityBlockedMessage(
  reason: string,
  envelope: EnvelopeVerdict | null,
): string {
  const lines = captureGuidanceLines(envelope);
  if (lines.length === 0) return reason;
  return `${reason}\n\n${lines.map(line => `• ${line.text}`).join('\n')}`;
}

/**
 * Where a camera event came from: the native capture that emitted it and
 * when. Both fields are what the native bridge stamps on every event
 * (`CameraEventBase`); either may be missing on older builds, in which case
 * the corresponding check is skipped rather than guessed.
 */
export interface AttemptEvidenceProvenance {
  captureId?: string | undefined;
  emittedAtIso?: string | undefined;
}

/**
 * Mutable per-attempt evidence buffer for the live camera signals the
 * attempt envelope consumes. Evidence describes exactly ONE clip, measured
 * inside its own attempt and — for readiness — at or before the stroke:
 *
 * - `beginAttempt()` MUST run when a new capture attempt starts. It opens a
 *   fresh attempt id and RETIRES the previous attempt's native capture id,
 *   so an event that drains late from the torn-down pipeline is rejected
 *   instead of being attributed to the new clip.
 * - The attempt binds to the native capture id carried by its first
 *   correlated event; evidence stamped with any other capture id is foreign
 *   and ignored.
 * - `noteStroke()` closes the readiness window at the stroke's emission
 *   time: a readiness frame observed after it (whether it arrives before or
 *   after the stroke event) cannot overwrite the swing-time visibility.
 *   Clip-level quality summaries may still land until the clip resolves.
 * - `sealAttempt()` (clip resolved or attempt ended) rejects everything.
 *
 * Every `note*` returns whether the evidence was accepted, so the caller
 * can skip UI derived from evidence that was not.
 */
export interface AttemptEvidenceBuffer {
  /** Correlation id of the open attempt. */
  readonly attemptId: string;
  /** Native capture id bound to this attempt; null until an event binds it. */
  readonly captureId: string | null;
  readonly readiness: ReadinessSnapshot | null;
  readonly quality: CaptureQualitySignalsV1 | null;
  beginAttempt(attemptId?: string): void;
  noteReadiness(
    readiness: ReadinessSnapshot,
    provenance?: AttemptEvidenceProvenance,
  ): boolean;
  noteQuality(
    quality: CaptureQualitySignalsV1,
    provenance?: AttemptEvidenceProvenance,
  ): boolean;
  noteStroke(provenance?: AttemptEvidenceProvenance): boolean;
  sealAttempt(): void;
}

/** Retired capture ids remembered for late-event rejection. */
const RETIRED_CAPTURE_IDS_KEPT = 8;

function observedAtMs(provenance: AttemptEvidenceProvenance): number | null {
  if (provenance.emittedAtIso === undefined) return null;
  const ms = Date.parse(provenance.emittedAtIso);
  return Number.isFinite(ms) ? ms : null;
}

export function createAttemptEvidenceBuffer(): AttemptEvidenceBuffer {
  let sequence = 0;
  let attemptId = `attempt-${sequence}`;
  let captureId: string | null = null;
  const retired: string[] = [];
  let readiness: {
    snapshot: ReadinessSnapshot;
    observedAtMs: number | null;
  } | null = null;
  let quality: CaptureQualitySignalsV1 | null = null;
  let strokeAtMs: number | null = null;
  let strokeSeen = false;
  let sealed = false;

  /** Correlates the event to this attempt, binding the capture id if new. */
  const belongs = (provenance: AttemptEvidenceProvenance): boolean => {
    const id = provenance.captureId;
    if (id === undefined) return true;
    if (retired.includes(id)) return false;
    if (captureId === null) {
      captureId = id;
      return true;
    }
    return captureId === id;
  };

  const insideStrokeWindow = (
    provenance: AttemptEvidenceProvenance,
  ): boolean => {
    if (!strokeSeen) return true;
    if (strokeAtMs === null) return false;
    const at = observedAtMs(provenance);
    return at !== null && at <= strokeAtMs;
  };

  return {
    get attemptId() {
      return attemptId;
    },
    get captureId() {
      return captureId;
    },
    get readiness() {
      return readiness?.snapshot ?? null;
    },
    get quality() {
      return quality;
    },
    beginAttempt(nextAttemptId?: string) {
      sequence += 1;
      attemptId = nextAttemptId ?? `attempt-${sequence}`;
      if (captureId !== null) {
        retired.push(captureId);
        if (retired.length > RETIRED_CAPTURE_IDS_KEPT) retired.shift();
      }
      captureId = null;
      readiness = null;
      quality = null;
      strokeAtMs = null;
      strokeSeen = false;
      sealed = false;
    },
    noteReadiness(next, provenance = {}) {
      if (sealed || !belongs(provenance) || !insideStrokeWindow(provenance)) {
        return false;
      }
      readiness = { snapshot: next, observedAtMs: observedAtMs(provenance) };
      return true;
    },
    noteQuality(next, provenance = {}) {
      if (sealed || !belongs(provenance)) return false;
      quality = next;
      return true;
    },
    noteStroke(provenance = {}) {
      if (!belongs(provenance)) return false;
      strokeSeen = true;
      strokeAtMs = observedAtMs(provenance);
      // Readiness measured after the stroke describes the follow-through or
      // the walk-off, not the swing: drop it now that the window is known.
      if (
        readiness !== null &&
        strokeAtMs !== null &&
        readiness.observedAtMs !== null &&
        readiness.observedAtMs > strokeAtMs
      ) {
        readiness = null;
      }
      return true;
    },
    sealAttempt() {
      sealed = true;
    },
  };
}

/**
 * Envelope for a per-event clip cut from a rolling session recording.
 * Resolution and frame rate are real capture-config values and are judged
 * with the shared thresholds. clip_duration is intentionally NOT judged:
 * the window length is chosen by the session engine's event bounds, not by
 * how the user captured, and the clip-duration band was derived for whole
 * user captures — applying it here would misclassify by construction. The
 * dimension is reported NOT_MEASURED so the omission stays visible.
 */
export function sessionEventClipEnvelope(
  clip: Pick<CapturedClip, 'width' | 'height' | 'fps'>,
): EnvelopeVerdict {
  return evaluateCaptureEnvelope({
    frameWidthPx: clip.width,
    frameHeightPx: clip.height,
    avgFrameRateFps: clip.fps,
    brightnessMeanLuma: null,
    brightnessStdLuma: null,
    clippedPixelFraction: null,
    laplacianVarianceMedian: null,
    denoiseSurvivalRatio: null,
    meanAbsFrameDiff: null,
    contrastNormalizedFrameDiff: null,
    frameIntervalCv: null,
    clipDurationMs: null,
    playerPixelHeightFraction: null,
    playerMeanJointVisibility: null,
  });
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
