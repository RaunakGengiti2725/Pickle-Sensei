import {
  isConfirmationTimestamp,
  isStrokeIntentEnvelope,
  type CaptureAnalysisRecord,
} from '@pickle/analysis-pipeline';
import { ApiError } from '../data/api';
import type { LocalDb } from '../data/db';
import type { RunJournalEntry, RunJournalIdentity } from './runJournal';

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

/** The authority's contract statement, used only when its body carried none. */
export const RELEASE_NOT_AUTHORIZED_MESSAGE =
  'Validated ratings are not available right now. No rating was counted.';

const REASON_CODE_MAX_LENGTH = 128;
const MESSAGE_MAX_LENGTH = 512;

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

/** Normalizes the settled refusal once; storage, replay and Result all read
 * this same bounded marker. */
export function partialOutcomeMarker(refusal: ApiError): PartialOutcomeMarker {
  const raw: unknown = refusal.message;
  const message =
    typeof raw === 'string' && raw.length > 0
      ? raw.slice(0, MESSAGE_MAX_LENGTH)
      : RELEASE_NOT_AUTHORIZED_MESSAGE;
  return marker(RELEASE_NOT_AUTHORIZED_CODE, message);
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

/** A run the authority refused before any permit existed: terminal
 * `reservation_rejected`, permit-less, so nothing about it is chargeable. */
export function isSettledRefusalRun(run: RunJournalEntry): boolean {
  return (
    run.state === 'terminal' &&
    run.permitId === null &&
    run.resultId === null &&
    run.terminalReason === 'reservation_rejected'
  );
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
    !text(stored.reasonCode, REASON_CODE_MAX_LENGTH) ||
    !text(stored.message, MESSAGE_MAX_LENGTH)
  )
    return null;
  return marker(stored.reasonCode, stored.message);
}

/**
 * Durable copy of the authority's settled refusal for one run, written in the
 * same transaction that settles the journal row. If the mechanics record
 * write fails afterwards, the same operation can still deliver its partial
 * later without a second reservation and without inventing a reason.
 */
export async function saveReservationRefusal(
  db: LocalDb,
  run: RunJournalIdentity,
  marker: PartialOutcomeMarker,
  nowMs = Date.now(),
): Promise<void> {
  await db.execute(
    `INSERT INTO analysis_reservation_refusal
      (owner_key, operation_id, analysis_id, capture_id, reason_code, message, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      run.ownerKey,
      run.operationId,
      run.analysisId,
      run.captureId,
      marker.reasonCode,
      marker.message,
      Math.max(0, Math.trunc(nowMs)),
    ],
  );
}

/** The settled refusal of exactly this terminal, permit-less run, or null. */
export async function readReservationRefusal(
  db: LocalDb,
  run: RunJournalEntry,
): Promise<PartialOutcomeMarker | null> {
  if (!isSettledRefusalRun(run)) return null;
  const { rows } = await db.execute(
    `SELECT reason_code, message FROM analysis_reservation_refusal
     WHERE owner_key = ? AND operation_id = ? AND analysis_id = ? AND capture_id = ?`,
    [run.ownerKey, run.operationId, run.analysisId, run.captureId],
  );
  const row = rows[0];
  if (!row) return null;
  const reasonCode = row['reason_code'];
  const message = row['message'];
  if (
    !text(reasonCode, REASON_CODE_MAX_LENGTH) ||
    !text(message, MESSAGE_MAX_LENGTH)
  )
    return null;
  return marker(reasonCode, message);
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
