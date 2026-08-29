import type { CameraEvent } from './capture';

/**
 * Pre-Ready capture envelope — a typed verdict over the capture conditions
 * the live pipeline can actually measure, surfaced BEFORE the user swings.
 *
 * `@pickle/shared-types` does not export an EnvelopeVerdict contract today,
 * so this module defines a minimal local interface with 'capture envelope
 * checker' semantics (SUPPORTED / DEGRADED / UNSUPPORTED per dimension).
 * When a shared contract lands, this shape is additive-mergeable: same
 * per-dimension verdict vocabulary, dimensions optional so unmeasured
 * conditions stay honestly absent rather than fabricated.
 *
 * All functions are pure (no React, no IO) so jest pins them directly.
 */

export const ENVELOPE_DIMENSION_VERDICTS = [
  'SUPPORTED',
  'DEGRADED',
  'UNSUPPORTED',
] as const;
export type EnvelopeDimensionVerdict =
  (typeof ENVELOPE_DIMENSION_VERDICTS)[number];

export const CAPTURE_ENVELOPE_DIMENSIONS = [
  'subject_visibility',
  'subject_distance',
  'stability',
  'lighting',
] as const;
export type CaptureEnvelopeDimension =
  (typeof CAPTURE_ENVELOPE_DIMENSIONS)[number];

export interface EnvelopeDimensionRead {
  verdict: EnvelopeDimensionVerdict;
  /** Machine reason token recorded with the read (never shown raw). */
  reason?: string;
}

/**
 * A dimension absent from `dimensions` was NOT measured — its guidance is
 * never shown and it never blocks Ready. Absence is honest, not SUPPORTED.
 */
export interface EnvelopeVerdict {
  schemaVersion: 1;
  source: 'live_readiness_events';
  dimensions: Partial<Record<CaptureEnvelopeDimension, EnvelopeDimensionRead>>;
}

export interface CaptureGuidanceLine {
  dimension: CaptureEnvelopeDimension;
  verdict: Exclude<EnvelopeDimensionVerdict, 'SUPPORTED'>;
  /** Actionable instruction — tells the player what to change, not what failed. */
  text: string;
}

const GUIDANCE_COPY: Record<
  CaptureEnvelopeDimension,
  Record<Exclude<EnvelopeDimensionVerdict, 'SUPPORTED'>, string>
> = {
  subject_visibility: {
    DEGRADED: 'Keep your full body visible — a joint keeps leaving the frame.',
    UNSUPPORTED: 'Keep your full body visible inside the corners.',
  },
  subject_distance: {
    DEGRADED: 'Adjust your distance until your whole body fits comfortably.',
    UNSUPPORTED: 'Move the phone closer or step back until you fill the frame.',
  },
  stability: {
    DEGRADED: 'Hold still for a moment so the camera can lock on.',
    UNSUPPORTED: 'Hold still — the camera has not locked onto you yet.',
  },
  lighting: {
    DEGRADED: 'It looks dim — more light will sharpen the read.',
    UNSUPPORTED: 'Too dark — add light or move somewhere brighter.',
  },
};

const DIMENSION_ORDER = CAPTURE_ENVELOPE_DIMENSIONS;

/**
 * Actionable guidance lines for every MEASURED dimension that is not
 * SUPPORTED, in fixed dimension order. Unmeasured dimensions produce
 * nothing: guidance is never invented for a condition nobody read.
 */
export function captureGuidanceLines(
  envelope: EnvelopeVerdict | null,
): CaptureGuidanceLine[] {
  if (!envelope) return [];
  const lines: CaptureGuidanceLine[] = [];
  for (const dimension of DIMENSION_ORDER) {
    const read = envelope.dimensions[dimension];
    if (!read || read.verdict === 'SUPPORTED') continue;
    lines.push({
      dimension,
      verdict: read.verdict,
      text: GUIDANCE_COPY[dimension][read.verdict],
    });
  }
  return lines;
}

export interface ReadyGate {
  blocked: boolean;
  /** The UNSUPPORTED dimensions that block Ready (DEGRADED never blocks). */
  blockingDimensions: CaptureEnvelopeDimension[];
}

/** Ready is blocked ONLY by UNSUPPORTED dimensions; DEGRADED guides but permits. */
export function readyGate(envelope: EnvelopeVerdict | null): ReadyGate {
  if (!envelope) return { blocked: false, blockingDimensions: [] };
  const blockingDimensions = DIMENSION_ORDER.filter(
    dimension => envelope.dimensions[dimension]?.verdict === 'UNSUPPORTED',
  );
  return { blocked: blockingDimensions.length > 0, blockingDimensions };
}

/** Full-body joint coverage below this reads as DEGRADED visibility. */
export const DEGRADED_JOINT_COVERAGE = 0.85;
/** Stability holds shorter than this read as DEGRADED (not yet settled). */
export const DEGRADED_STABILITY_MS = 500;

/**
 * Derives an envelope verdict from a live readiness event — the only live
 * capture-condition signal this build emits. Mapping claims exactly what
 * the event measured:
 *  - `no_person` / `full_body_required` → subject_visibility UNSUPPORTED;
 *    otherwise jointCoverage < 0.85 → DEGRADED, else SUPPORTED.
 *  - `move_closer` / `move_farther` → subject_distance UNSUPPORTED; any
 *    other person-visible state → SUPPORTED (distance passed native checks).
 *  - `hold_still` → stability UNSUPPORTED; `ready` with a short stable hold
 *    → DEGRADED, else SUPPORTED.
 *  - lighting: NOT measured by readiness events — always absent here, so
 *    no lighting guidance can be fabricated from this source.
 * Non-readiness events return null (no verdict, nothing to show).
 */
export function envelopeFromReadinessEvent(
  event: CameraEvent,
): EnvelopeVerdict | null {
  if (event.type !== 'readiness') return null;
  const dimensions: EnvelopeVerdict['dimensions'] = {};

  if (event.state === 'no_person' || event.state === 'full_body_required') {
    dimensions.subject_visibility = {
      verdict: 'UNSUPPORTED',
      reason: event.state,
    };
  } else if (event.jointCoverage < DEGRADED_JOINT_COVERAGE) {
    dimensions.subject_visibility = {
      verdict: 'DEGRADED',
      reason: 'partial_joint_coverage',
    };
  } else {
    dimensions.subject_visibility = { verdict: 'SUPPORTED' };
  }

  if (event.state === 'move_closer' || event.state === 'move_farther') {
    dimensions.subject_distance = {
      verdict: 'UNSUPPORTED',
      reason: event.state,
    };
  } else if (event.state !== 'no_person') {
    dimensions.subject_distance = { verdict: 'SUPPORTED' };
  }

  if (event.state === 'hold_still') {
    dimensions.stability = { verdict: 'UNSUPPORTED', reason: event.state };
  } else if (event.state === 'ready') {
    dimensions.stability =
      event.stableForMs < DEGRADED_STABILITY_MS
        ? { verdict: 'DEGRADED', reason: 'short_stable_hold' }
        : { verdict: 'SUPPORTED' };
  }

  return { schemaVersion: 1, source: 'live_readiness_events', dimensions };
}
