import {
  isConfirmationTimestamp,
  isStrokeIntentEnvelope,
  type CaptureAnalysisRecord,
} from '@pickle/analysis-pipeline';
import { ApiError } from '../data/api';

/**
 * Mechanics-only PARTIAL outcome (shared-types `AnalysisOutcome.partial`
 * projected onto the mobile record store).
 *
 * The release authority answers the permit reservation with the settled,
 * typed HTTP 409 `access.release_not_authorized` ("no rating was counted").
 * That is not an outage: mechanics can still be measured and delivered, but
 * no validated technique benchmark exists, so nothing may be charged and no
 * score, confidence or benchmark range may be presented. The run therefore
 * never holds a permit, never writes a `local_shot` product row and never
 * enters the outbox — the record carries this marker instead of a result.
 */
export const RELEASE_NOT_AUTHORIZED_CODE = 'access.release_not_authorized';

export type PartialOutcomeWithheld = 'technique_benchmark';

export interface PartialOutcomeMarker {
  readonly status: 'partial';
  readonly billingDisposition: 'not_chargeable';
  readonly withheld: PartialOutcomeWithheld;
  /** Typed refusal code the release authority answered the reservation with. */
  readonly reasonCode: string;
  /** The server's own settled statement ("No rating was counted"). */
  readonly message: string;
}

export type PartialCaptureAnalysisRecord = Extract<
  CaptureAnalysisRecord,
  { kind?: 'analyzed' }
> & {
  result: null;
  partialOutcome: PartialOutcomeMarker;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

export function isReleaseNotAuthorized(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === RELEASE_NOT_AUTHORIZED_CODE
  );
}

export function partialOutcomeMarker(refusal: ApiError): PartialOutcomeMarker {
  return marker(refusal.code, refusal.message);
}

function marker(reasonCode: string, message: string): PartialOutcomeMarker {
  return Object.freeze({
    status: 'partial',
    billingDisposition: 'not_chargeable',
    withheld: 'technique_benchmark',
    reasonCode,
    message,
  });
}

/** Mechanics evidence stays; the unvalidated product result is withheld. */
export function toPartialCaptureAnalysisRecord(
  record: Extract<CaptureAnalysisRecord, { kind?: 'analyzed' }>,
  marker: PartialOutcomeMarker,
): PartialCaptureAnalysisRecord {
  return { ...record, result: null, partialOutcome: marker };
}

export function readPartialOutcome(
  value: unknown,
): PartialOutcomeMarker | null {
  if (!isRecord(value) || value.result !== null) return null;
  const stored = value.partialOutcome;
  if (
    !isRecord(stored) ||
    stored.status !== 'partial' ||
    stored.billingDisposition !== 'not_chargeable' ||
    stored.withheld !== 'technique_benchmark' ||
    !text(stored.reasonCode, 128) ||
    !text(stored.message, 512)
  )
    return null;
  return marker(stored.reasonCode, stored.message);
}

/**
 * Storage validation for a stored partial about to be replayed: the record
 * must be the analyzed mechanics record of exactly this run (id + capture),
 * carry a valid marker and no result. Never a new scoring gate.
 */
export function readPartialCaptureAnalysisRecord(
  stored: unknown,
  binding: { id: string; captureId: string },
): PartialCaptureAnalysisRecord | null {
  const value = stored;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !(value.kind === undefined || value.kind === 'analyzed') ||
    value.confirmationReason !== undefined ||
    value.id !== binding.id ||
    value.captureId !== binding.captureId ||
    !isConfirmationTimestamp(value.createdAtIso) ||
    !text(value.engineVersion, 64) ||
    !isStrokeIntentEnvelope(value.strokeIntent) ||
    readPartialOutcome(value) === null
  )
    return null;
  return stored as PartialCaptureAnalysisRecord;
}
