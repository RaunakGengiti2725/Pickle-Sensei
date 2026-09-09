import {
  isConfirmationTimestamp,
  isStrokeIntentEnvelope,
  type CaptureAnalysisRecord,
  type ConfirmationRecordRowBinding,
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

/** The app-owned statement of the settled refusal. It is the ONLY copy a
 * partial ever stores, replays or renders: the authority's free-text body is
 * never persisted or shown, so no score, confidence, range, percentage or
 * forbidden term can reach the athlete through it. */
export const RELEASE_NOT_AUTHORIZED_MESSAGE =
  'Validated ratings are not available right now. No rating was counted.';

/** Allow-listed refusal codes and the statement Result shows for each. */
const PARTIAL_OUTCOME_STATEMENTS: ReadonlyMap<string, string> = new Map([
  [RELEASE_NOT_AUTHORIZED_CODE, RELEASE_NOT_AUTHORIZED_MESSAGE],
]);

const REASON_CODE_MAX_LENGTH = 128;
const MESSAGE_MAX_LENGTH = 512;

export type PartialOutcomeWithheld = 'technique_benchmark';

export interface PartialOutcomeMarker {
  readonly status: 'partial';
  readonly billingDisposition: 'not_chargeable';
  readonly withheld: PartialOutcomeWithheld;
  /** Typed refusal code the release authority answered the reservation with. */
  readonly reasonCode: string;
  /** The app-owned statement for `reasonCode` ("No rating was counted"). */
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
 * this same bounded marker. Only the typed code is taken from the refusal. */
export function partialOutcomeMarker(refusal: ApiError): PartialOutcomeMarker {
  if (!isReleaseNotAuthorized(refusal))
    throw new TypeError('Not a settled release refusal.');
  return marker(RELEASE_NOT_AUTHORIZED_CODE, RELEASE_NOT_AUTHORIZED_MESSAGE);
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

/** A stored code/message pair becomes a marker only when the code is
 * allow-listed; the stored message is bounded text but never trusted — the
 * app-owned statement for that code is what carries. */
function storedMarker(
  reasonCode: unknown,
  message: unknown,
): PartialOutcomeMarker | null {
  if (
    !text(reasonCode, REASON_CODE_MAX_LENGTH) ||
    !text(message, MESSAGE_MAX_LENGTH)
  )
    return null;
  const statement = PARTIAL_OUTCOME_STATEMENTS.get(reasonCode);
  return statement === undefined ? null : marker(reasonCode, statement);
}

/** The attempt technical failure a settled refusal may carry: none, or the
 * transport failure of the reservation try whose recovery re-reserve the
 * authority then refused. Any other failure is a different, unsettled run. */
export function isSettledRefusalTechnicalFailure(
  technicalFailure: string | null,
): technicalFailure is null | 'reservation_transport' {
  return (
    technicalFailure === null || technicalFailure === 'reservation_transport'
  );
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

/**
 * Mechanics evidence stays; the unvalidated product result is withheld. An
 * AUTO DETECT record that would otherwise ask for a technique confirmation
 * settles the same way: with no permit there is no continuation to confirm
 * into, so its measured mechanics are kept as the durable partial and the
 * open confirmation question is dropped rather than left half-settled.
 */
export function toPartialCaptureAnalysisRecord(
  record: CaptureAnalysisRecord,
  marker: PartialOutcomeMarker,
): PartialCaptureAnalysisRecord {
  if (record.kind === 'needs_technique_confirmation') {
    const { confirmationReason: _confirmationReason, ...mechanics } = record;
    return {
      ...mechanics,
      kind: 'analyzed',
      result: null,
      partialOutcome: marker,
    };
  }
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
    stored.withheld !== 'technique_benchmark'
  )
    return null;
  return storedMarker(stored.reasonCode, stored.message);
}

/**
 * Durable copy of the authority's settled refusal for one run, written in the
 * same transaction that settles the journal row (either journal storage
 * version). If the mechanics record write fails afterwards, the same
 * operation can still deliver its partial later without a second reservation
 * and without inventing a reason.
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
  return storedMarker(row['reason_code'], row['message']);
}

/**
 * Storage validation for a stored partial about to be replayed: the record
 * must be the analyzed mechanics record of exactly its stored row (id,
 * capture, timestamp, engine, abstained score version), carry a valid marker
 * and no result. Never a new scoring gate.
 */
export function readPartialCaptureAnalysisRecord(
  stored: unknown,
  row: ConfirmationRecordRowBinding,
): PartialCaptureAnalysisRecord | null {
  const value = stored;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !(value.kind === undefined || value.kind === 'analyzed') ||
    value.confirmationReason !== undefined ||
    !text(value.id, 64) ||
    value.id !== row.id ||
    !text(value.captureId, 64) ||
    value.captureId !== row.captureId ||
    !isConfirmationTimestamp(value.createdAtIso) ||
    value.createdAtIso !== row.createdAtIso ||
    !text(value.engineVersion, 64) ||
    value.engineVersion !== row.engineVersion ||
    row.scoringModelVersion !== 'abstained' ||
    !isStrokeIntentEnvelope(value.strokeIntent)
  )
    return null;
  const partialOutcome = readPartialOutcome(value);
  if (partialOutcome === null) return null;
  return {
    ...(stored as PartialCaptureAnalysisRecord),
    result: null,
    partialOutcome,
  };
}
