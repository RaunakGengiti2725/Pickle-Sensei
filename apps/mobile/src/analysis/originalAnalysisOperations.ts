import { Platform } from 'react-native';
import {
  isAnalysisInputSelectionSnapshot,
  isVerifiedCompletedCaptureRecord,
  parseNeedsTechniqueConfirmationRecord,
  type CaptureAnalysisRecord,
} from '@pickle/analysis-pipeline';
import type { ShotAnalysis } from '@pickle/shared-types';
import { parsePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  getApiSession,
  subscribeToApiSession,
  useApiSessionStore,
} from '../account/apiSession';
import {
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../camera/capture';
import {
  assertDataOwnerContext,
  isDataOwnerContextCurrent,
  subscribeToDataOwner,
  type DataOwnerContext,
} from '../data/accountScope';
import type { LocalDb } from '../data/db';
import { readOfflineReceiptForOperation } from '../data/offlineCapabilities';
import { forDataOwner, withTransaction } from '../data/transactions';
import {
  markCaptureAnalyzed,
  saveAnalysis,
  saveAnalysisRecord,
  saveLocalOnlyAnalysis,
} from '../data/repository';
import { makeUuid } from '../util/uuid';
import {
  isSettledRefusalRun,
  readPartialCaptureAnalysisRecord,
  readPartialOutcome,
  readReservationRefusal,
  type PartialOutcomeMarker,
} from './partialOutcome';
import { commitPracticeSet } from './practiceSet';
import {
  analysisAttemptJournal,
  runJournal,
  type RunJournalEntry,
  type RunJournalIdentity,
  type RunJournalReleaseOutcome,
} from './runJournal';
import { ANALYSIS_RETRYABLE_FAILURES } from './runJournalSchema';
import {
  assertOriginalAnalysisSnapshot,
  assertOriginalClip,
  assertOriginalEnvelope,
  boundedOriginalData,
  captureExecutionDefinitionHash,
  originalAnalysisId,
  originalCanonicalJson,
  originalClipMatches,
  originalDigest,
  originalModelPolicyHash,
  originalSettingsHash,
  type OriginalAnalysisSnapshot,
} from './originalAnalysisSnapshot';
import {
  confirmationInputsMatch,
  receiptPaidRun,
} from './savedTechniqueConfirmation';
import type { SavedConfirmationUnavailableReason } from './savedTechniqueConfirmation';

export type AnalysisTechnicalFailure =
  (typeof ANALYSIS_RETRYABLE_FAILURES)[number];
export class OriginalAnalysisHeldError extends Error {
  constructor(readonly reason: string) {
    super(`Original analysis held: ${reason}`);
    this.name = 'OriginalAnalysisHeldError';
  }
}
function held(reason: string): never {
  throw new OriginalAnalysisHeldError(reason);
}

/** Capture this lease before asynchronous preparation/extraction. A service
 * A-B-A invalidates it synchronously; ordinary bearer rotation does not. The
 * caller must dispose it, and use a NEW lease for a later explicit retry. */
export class OriginalAnalysisExecution {
  readonly ownerContext: DataOwnerContext;
  readonly scope: { readonly ownerKey: string; readonly apiOrigin: string };
  private invalidated = false;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly unsubscribe: () => void;
  constructor(
    owner: DataOwnerContext,
    apiOrigin: string,
    signal?: AbortSignal,
  ) {
    this.ownerContext = Object.freeze({
      ownerKey: owner.ownerKey,
      generation: owner.generation,
    });
    this.scope = runJournal.scope({ ownerKey: owner.ownerKey, apiOrigin });
    if (signal?.aborted) this.controller.abort();
    this.assertCurrent();
    const invalidate = () => {
      this.invalidated = true;
      this.controller.abort();
    };
    const recheck = () => {
      try {
        this.assertCurrent();
      } catch {
        invalidate();
      }
    };
    const stopSession = subscribeToApiSession(recheck);
    const stopOwner = subscribeToDataOwner(recheck);
    signal?.addEventListener('abort', invalidate, { once: true });
    this.unsubscribe = () => {
      stopSession();
      stopOwner();
      signal?.removeEventListener('abort', invalidate);
    };
  }
  assertCurrent(): void {
    assertDataOwnerContext(this.ownerContext);
    if (this.invalidated || this.signal?.aborted) held('stale_execution');
    const session = getApiSession();
    if (!session) held('origin_mismatch');
    const current = runJournal.scope({
      ownerKey: session.canonicalAppUserId,
      apiOrigin: session.apiBaseUrl,
    });
    if (
      current.ownerKey !== this.scope.ownerKey ||
      current.apiOrigin !== this.scope.apiOrigin
    )
      held('origin_mismatch');
  }
  dispose(): void {
    this.invalidated = true;
    this.controller.abort();
    this.unsubscribe();
  }
}
/** An inspection address, never an execution lease or a cached byte proof. */
export interface SavedOriginalAnalysisReference {
  readonly operationId: string;
  readonly captureId: string;
  readonly ownerContext: DataOwnerContext;
  readonly apiOrigin: string;
}
export interface SavedOriginalAnalysisEntry {
  readonly reference: SavedOriginalAnalysisReference;
  readonly clip: CapturedClip;
}
export type SavedOriginalAnalysisLoad =
  | { kind: 'ready'; saved: SavedOriginalAnalysisEntry }
  | { kind: 'load_result' }
  | { kind: 'unavailable'; reason: SavedConfirmationUnavailableReason };
export interface LoadSavedOriginalAnalysisRequest {
  db: LocalDb;
  ownerContext: DataOwnerContext;
  captureId: string;
  apiOrigin: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}

export interface OriginalObservationSeal {
  readonly version: 'original-observation-v1';
  readonly clip: CapturedClip;
  readonly observationHash: string;
  readonly captureEnvelope: ReturnType<typeof assertOriginalEnvelope>;
}
export interface OriginalAnalysisOperation {
  readonly operationId: string;
  readonly analysisId: string;
  readonly snapshot: OriginalAnalysisSnapshot;
  readonly settingsHash: string;
  readonly modelPolicyHash: string | null;
  readonly observation: OriginalObservationSeal | null;
  readonly executionHash: string | null;
  readonly currentAttemptId: string | null;
  readonly finalRecordId: string | null;
  readonly winningAttemptId: string | null;
  readonly completionKind:
    | 'scored'
    | 'low_confidence'
    | 'needs_technique_confirmation'
    | 'partial'
    | null;
}
export interface OriginalAnalysisAttempt {
  readonly run: RunJournalEntry;
  readonly ordinal: number;
  readonly predecessorOperationId: string | null;
  readonly technicalFailure: AnalysisTechnicalFailure | null;
}
export type OriginalAnalysisAdmission =
  | {
      kind: 'created' | 'existing';
      operation: OriginalAnalysisOperation;
      attempt: OriginalAnalysisAttempt;
    }
  | { kind: 'replay'; operation: OriginalAnalysisOperation }
  | {
      kind: 'held';
      reason: string;
      operation?: OriginalAnalysisOperation;
      attempt?: OriginalAnalysisAttempt;
    };

function rawOnly(db: LocalDb): void {
  if (db.ownerContext) held('raw_database_required');
}
async function currentTransaction<T>(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operation: (tx: LocalDb) => Promise<T>,
): Promise<T> {
  rawOnly(db);
  execution.assertCurrent();
  const value = await withTransaction(db, async tx => {
    execution.assertCurrent();
    const result = await operation(tx);
    execution.assertCurrent();
    return result;
  });
  execution.assertCurrent();
  return value;
}
function nullableId(value: unknown): string | null {
  return value === null ? null : originalAnalysisId(value);
}
/** Every operation read is followed by its PARTIAL completion (kept beside
 * the row so the operation table itself never changes shape across installs);
 * the operation statement stays the one existing installs and fences pin. */
async function readOperationRows(
  db: LocalDb,
  ownerKey: string,
  column: 'operation_id' | 'capture_id' | 'analysis_id',
  value: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await db.execute(
    `SELECT * FROM analysis_logical_operations WHERE owner_key = ? AND ${column} = ?`,
    [ownerKey, value],
  );
  const joined: Record<string, unknown>[] = [];
  for (const row of rows) {
    const partial = await db.execute(
      `SELECT attempt_id, analysis_id FROM analysis_partial_completion
       WHERE owner_key = ? AND operation_id = ?`,
      [ownerKey, originalAnalysisId(row.operation_id)],
    );
    if (partial.rows.length > 1) held('invalid_result_pointer');
    const offline = await db.execute(
      `SELECT attempt_id, analysis_id FROM analysis_offline_completion
       WHERE owner_key = ? AND operation_id = ?`,
      [ownerKey, originalAnalysisId(row.operation_id)],
    );
    if (offline.rows.length > 1) held('invalid_result_pointer');
    joined.push({
      ...row,
      partial_attempt_id: partial.rows[0]?.attempt_id ?? null,
      partial_analysis_id: partial.rows[0]?.analysis_id ?? null,
      offline_attempt_id: offline.rows[0]?.attempt_id ?? null,
      offline_analysis_id: offline.rows[0]?.analysis_id ?? null,
    });
  }
  return joined;
}
function sealHash(
  snapshot: OriginalAnalysisSnapshot,
  seal: OriginalObservationSeal,
): string {
  const modelPolicyHash = originalModelPolicyHash(snapshot.modelPolicy);
  if (modelPolicyHash === null) held('missing_model_policy');
  return captureExecutionDefinitionHash(
    { ...snapshot, clip: seal.clip, captureEnvelope: seal.captureEnvelope },
    modelPolicyHash,
    seal.observationHash,
  );
}
function decodeOperation(
  row: Record<string, unknown>,
): OriginalAnalysisOperation {
  if (
    typeof row.original_settings !== 'string' ||
    row.original_settings.length > 65536
  )
    held('invalid_settings');
  const snapshot = assertOriginalAnalysisSnapshot(
    JSON.parse(row.original_settings),
  );
  const settingsHash = originalSettingsHash(snapshot);
  const modelPolicyHash = originalModelPolicyHash(snapshot.modelPolicy);
  if (
    settingsHash !== row.settings_hash ||
    modelPolicyHash !== row.model_policy_hash ||
    snapshot.ownerKey !== row.owner_key ||
    snapshot.apiOrigin !== row.api_origin ||
    snapshot.captureId !== row.capture_id
  )
    held('invalid_settings');
  let observation: OriginalObservationSeal | null = null;
  if (row.observation_seal !== null) {
    if (
      typeof row.observation_seal !== 'string' ||
      row.observation_seal.length > 131072
    )
      held('invalid_observation');
    const value = boundedOriginalData(
      JSON.parse(row.observation_seal),
      131072,
    ) as Record<string, unknown>;
    if (
      !value ||
      Object.keys(value).sort().join(',') !==
        'captureEnvelope,clip,observationHash,version' ||
      value.version !== 'original-observation-v1'
    )
      held('invalid_observation');
    observation = Object.freeze({
      version: 'original-observation-v1',
      clip: assertOriginalClip(value.clip),
      observationHash: originalDigest(value.observationHash),
      captureEnvelope: assertOriginalEnvelope(value.captureEnvelope),
    });
    if (
      !originalClipMatches(snapshot.clip, observation.clip) ||
      observation.clip.poseSequence?.sha256 !== observation.observationHash ||
      sealHash(snapshot, observation) !== row.execution_hash ||
      modelPolicyHash === null
    )
      held('invalid_observation');
  } else if (row.execution_hash !== null) held('invalid_observation');
  if (!('partial_attempt_id' in row) || !('offline_attempt_id' in row))
    held('invalid_result_pointer');
  const partialAttemptId = nullableId(row.partial_attempt_id);
  const offlineAttemptId = nullableId(row.offline_attempt_id);
  if (partialAttemptId !== null) {
    if (
      row.final_record_id !== null ||
      row.winning_attempt_id !== null ||
      row.completion_kind !== null ||
      offlineAttemptId !== null ||
      row.partial_analysis_id !== row.analysis_id
    )
      held('invalid_result_pointer');
  }
  if (offlineAttemptId !== null) {
    if (
      row.final_record_id !== null ||
      row.winning_attempt_id !== null ||
      row.completion_kind !== null ||
      row.offline_analysis_id !== row.analysis_id
    )
      held('invalid_result_pointer');
  }
  const sideAttemptId = partialAttemptId ?? offlineAttemptId;
  const operation: OriginalAnalysisOperation = Object.freeze({
    operationId: originalAnalysisId(row.operation_id),
    analysisId: originalAnalysisId(row.analysis_id),
    snapshot,
    settingsHash,
    modelPolicyHash,
    observation,
    executionHash:
      row.execution_hash === null ? null : originalDigest(row.execution_hash),
    currentAttemptId: nullableId(row.current_attempt_id),
    finalRecordId:
      sideAttemptId === null
        ? nullableId(row.final_record_id)
        : originalAnalysisId(row.analysis_id),
    winningAttemptId:
      sideAttemptId === null
        ? nullableId(row.winning_attempt_id)
        : sideAttemptId,
    completionKind:
      sideAttemptId === null
        ? (row.completion_kind as OriginalAnalysisOperation['completionKind'])
        : partialAttemptId !== null
          ? 'partial'
          : 'scored',
  });
  if (
    operation.finalRecordId === null
      ? operation.winningAttemptId !== null || operation.completionKind !== null
      : operation.finalRecordId !== operation.analysisId ||
        operation.winningAttemptId === null ||
        operation.winningAttemptId !== operation.currentAttemptId ||
        ![
          'scored',
          'low_confidence',
          'needs_technique_confirmation',
          'partial',
        ].includes(operation.completionKind ?? '')
  )
    held('invalid_result_pointer');
  return operation;
}
/** A PARTIAL completion is backed by exactly one settled, permit-less attempt:
 * the authority refused the reservation, so nothing was ever chargeable. The
 * same attempt is what a later run of the operation reconnects to when its
 * mechanics record has not landed yet. */
export function isSettledRefusal(attempt: OriginalAnalysisAttempt): boolean {
  return isSettledRefusalRun(attempt.run);
}
/** An unfinished operation whose current attempt is a settled refusal with
 * durable refusal metadata: re-running the SAME operation delivers its
 * PARTIAL without another reservation, so a reconcile must not hold it. */
async function hasSettledRefusal(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operation: OriginalAnalysisOperation,
): Promise<boolean> {
  if (operation.finalRecordId !== null || operation.currentAttemptId === null)
    return false;
  const attempt = await readAttempt(db, operation, operation.currentAttemptId);
  execution.assertCurrent();
  if (!isSettledRefusal(attempt)) return false;
  const refusal = await readReservationRefusal(db, attempt.run);
  execution.assertCurrent();
  return refusal !== null;
}
async function read(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
): Promise<OriginalAnalysisOperation | null> {
  rawOnly(db);
  execution.assertCurrent();
  const rows = await readOperationRows(
    db,
    execution.scope.ownerKey,
    'operation_id',
    originalAnalysisId(operationId),
  );
  execution.assertCurrent();
  if (!rows[0]) return null;
  const operation = decodeOperation(rows[0]);
  if (operation.snapshot.apiOrigin !== execution.scope.apiOrigin)
    held('origin_mismatch');
  return operation;
}
async function requireOperation(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
) {
  return (
    (await read(db, execution, operationId)) ?? held('legacy_unverifiable')
  );
}
async function readAttempt(
  db: LocalDb,
  operation: OriginalAnalysisOperation,
  attemptId: string,
): Promise<OriginalAnalysisAttempt> {
  const scope = {
    ownerKey: operation.snapshot.ownerKey,
    apiOrigin: operation.snapshot.apiOrigin,
  };
  const run = await analysisAttemptJournal.read(db, {
    ...scope,
    operationId: attemptId,
  });
  if (
    !run ||
    run.captureId !== operation.snapshot.captureId ||
    run.analysisId !== operation.analysisId ||
    run.requestHash !== operation.executionHash
  )
    held('missing_attempt_proof');
  const { rows } = await db.execute(
    'SELECT attempt_ordinal, predecessor_operation_id, technical_failure FROM analysis_execution_attempts WHERE owner_key = ? AND operation_id = ?',
    [scope.ownerKey, attemptId],
  );
  const row = rows[0];
  if (
    !row ||
    !Number.isSafeInteger(row.attempt_ordinal) ||
    Number(row.attempt_ordinal) < 1 ||
    !(
      row.technical_failure === null ||
      ANALYSIS_RETRYABLE_FAILURES.includes(row.technical_failure as never)
    )
  )
    held('invalid_attempt');
  const predecessorOperationId = nullableId(row.predecessor_operation_id);
  if ((row.attempt_ordinal === 1) !== (predecessorOperationId === null))
    held('invalid_attempt');
  return Object.freeze({
    run,
    ordinal: Number(row.attempt_ordinal),
    predecessorOperationId,
    technicalFailure: row.technical_failure as AnalysisTechnicalFailure | null,
  });
}
async function hasProduct(
  db: LocalDb,
  operation: OriginalAnalysisOperation,
): Promise<boolean> {
  const owner = operation.snapshot.ownerKey;
  // An unreadable owner outbox row cannot prove that no product exists.
  // Treat it as blocking evidence, never as permission to retry or refund.
  const { rows } = await db.execute(
    `SELECT 1 AS found FROM local_analysis_record WHERE owner_key = ? AND capture_id = ?
    UNION ALL SELECT 1 FROM local_shot WHERE owner_key = ? AND id = ?
    UNION ALL SELECT 1 FROM outbox WHERE owner_key = ? AND kind = 'shot.sync'
      AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') = ? ELSE 1 END
    UNION ALL SELECT 1 FROM sync_receipt WHERE owner_key = ? AND kind = 'shot.sync' AND entity_id = ? LIMIT 1`,
    [
      owner,
      operation.snapshot.captureId,
      owner,
      operation.analysisId,
      owner,
      operation.analysisId,
      owner,
      operation.analysisId,
    ],
  );
  return rows.length > 0;
}
async function readCapture(
  db: LocalDb,
  operation: Pick<OriginalAnalysisOperation, 'snapshot'>,
): Promise<CapturedClip> {
  const original = operation.snapshot;
  const { rows } = await db.execute(
    'SELECT * FROM local_capture WHERE owner_key = ? AND id = ?',
    [original.ownerKey, original.captureId],
  );
  const row = rows[0];
  if (!row || typeof row.payload !== 'string' || row.payload.length > 65536)
    held('missing_capture');
  const clip = assertOriginalClip(JSON.parse(row.payload));
  if (
    !originalClipMatches(original.clip, clip) ||
    row.uri !== clip.uri ||
    row.captured_at !== clip.capturedAtIso ||
    row.duration_ms !== clip.durationMs ||
    row.fps !== clip.fps ||
    row.width !== clip.width ||
    row.height !== clip.height ||
    row.declared_stroke !== original.declaredStroke
  )
    held('capture_changed');
  let target: unknown = null;
  if (row.target_seed !== null) {
    if (typeof row.target_seed !== 'string' || row.target_seed.length > 1024)
      held('target_changed');
    target = boundedOriginalData(JSON.parse(row.target_seed));
  }
  if (
    originalCanonicalJson(target) !== originalCanonicalJson(original.targetSeed)
  )
    held('target_changed');
  return clip;
}

/** Cold Library lookup only. Local viewing may precede API session restoration;
 * execution still requires OriginalAnalysisExecution and a new explicit check.
 * The transaction reads one consistent snapshot, without recovering attempts,
 * reading native files, or turning stored hashes into current-byte authority. */
export async function loadSavedOriginalAnalysis(
  request: LoadSavedOriginalAnalysisRequest,
): Promise<SavedOriginalAnalysisLoad> {
  const {
    db,
    captureId,
    apiOrigin,
    signal,
    assertCurrent: assertRoute,
  } = request;
  const owner = Object.freeze({
    ownerKey: request.ownerContext.ownerKey,
    generation: request.ownerContext.generation,
  });
  const unavailable = (
    reason: SavedConfirmationUnavailableReason,
  ): SavedOriginalAnalysisLoad => ({ kind: 'unavailable', reason });
  let originChanged = false;
  let stopSession: (() => void) | undefined;
  try {
    assertDataOwnerContext(owner);
    if (signal?.aborted) return unavailable('cancelled');
    rawOnly(db);
    try {
      originalAnalysisId(captureId);
    } catch {
      return unavailable('missing');
    }
    const scope = runJournal.scope({ ownerKey: owner.ownerKey, apiOrigin });
    let hadSession = getApiSession() !== null;
    const checkSession = (session = getApiSession()) => {
      // Initial absence is allowed. Losing an observed session invalidates this
      // load, including A -> absent -> A; a fresh local lookup remains allowed.
      if (!session) {
        if (hadSession) originChanged = true;
        return;
      }
      hadSession = true;
      try {
        const current = runJournal.scope({
          ownerKey: session.canonicalAppUserId,
          apiOrigin: session.apiBaseUrl,
        });
        if (
          current.ownerKey !== scope.ownerKey ||
          current.apiOrigin !== scope.apiOrigin
        )
          originChanged = true;
      } catch {
        originChanged = true;
      }
    };
    const checkScope = () => {
      assertDataOwnerContext(owner); // Captured generation fences owner A-B-A.
      if (signal?.aborted) held('cancelled');
      checkSession();
      if (originChanged) held('origin_mismatch');
    };
    const assertCurrent = () => {
      checkScope();
      try {
        assertRoute?.();
      } catch {
        held('cancelled');
      }
      checkScope();
    };
    // Latch both ends of each transition. An earlier subscriber may restore A
    // while B is being notified; sampling only the latest session misses that
    // reentrant A-B-A. Matching restoration/bearer rotation is still allowed.
    stopSession = useApiSessionStore.subscribe((current, previous) => {
      checkSession(previous.session);
      checkSession(current.session);
    });
    assertCurrent();
    const result = await withTransaction(db, async transaction => {
      const tx: LocalDb = {
        ...transaction,
        async execute(sql, params) {
          assertCurrent();
          const value = await transaction.execute(sql, params);
          assertCurrent();
          return value;
        },
      };
      const rows = await readOperationRows(
        tx,
        scope.ownerKey,
        'capture_id',
        captureId,
      );
      if (rows.length > 1) held('ambiguous_operation');
      const captures = await tx.execute(
        'SELECT owner_key, id, status FROM local_capture WHERE owner_key = ? AND id = ?',
        [scope.ownerKey, captureId],
      );
      const capture = captures.rows[0];
      if (!capture) return unavailable('missing');
      if (
        captures.rows.length !== 1 ||
        capture.owner_key !== scope.ownerKey ||
        capture.id !== captureId ||
        !['awaiting_model', 'analyzed'].includes(String(capture.status))
      )
        held('invalid_capture');
      const row = rows[0];
      if (!row) return unavailable('legacy');
      const operation = decodeOperation(row);
      if (
        operation.snapshot.ownerKey !== scope.ownerKey ||
        operation.snapshot.captureId !== captureId
      )
        held('scope_mismatch');
      if (operation.snapshot.apiOrigin !== scope.apiOrigin)
        held('origin_mismatch');
      const heads = await tx.execute(
        'SELECT operation_id FROM analysis_execution_attempts WHERE owner_key = ? AND analysis_id = ? ORDER BY attempt_ordinal DESC LIMIT 1',
        [scope.ownerKey, operation.analysisId],
      );
      if ((heads.rows[0]?.operation_id ?? null) !== operation.currentAttemptId)
        held('invalid_attempt');
      const attempt =
        operation.currentAttemptId === null
          ? null
          : await readAttempt(tx, operation, operation.currentAttemptId);
      if (
        attempt &&
        (!operation.observation ||
          attempt.run.operationId !== operation.currentAttemptId)
      )
        held('invalid_attempt');
      // Check the persisted chain with the same validator, not a release flag
      // supplied by the caller. This validates addresses, not retry admission.
      for (let cursor = attempt; cursor?.predecessorOperationId;) {
        const previous = await readAttempt(
          tx,
          operation,
          cursor.predecessorOperationId,
        );
        if (
          previous.run.operationId !== cursor.predecessorOperationId ||
          previous.ordinal + 1 !== cursor.ordinal
        )
          held('invalid_attempt');
        cursor = previous;
      }
      if (operation.finalRecordId !== null) {
        if (
          !attempt ||
          (operation.completionKind === 'partial'
            ? !isSettledRefusal(attempt)
            : attempt.technicalFailure !== null ||
              (operation.completionKind === 'scored'
                ? (attempt.run.state !== 'committed' ||
                    attempt.run.resultId !== operation.finalRecordId) &&
                  !(await receiptPaidCompletion(tx, operation, attempt))
                : (attempt.run.permitId === null &&
                    attempt.run.state !== 'release_pending') ||
                  attempt.run.releaseOutcome !== 'low_confidence' ||
                  !['release_pending', 'released', 'terminal'].includes(
                    attempt.run.state,
                  )))
        )
          held('invalid_result_pointer');
        // Do NOT compare the current declaration with the original here: the
        // supported exact-technique continuation may have changed it. This is
        // only delegation; the saved-technique/result loader validates the
        // actual latest record, evidence, journal and any subsequent result.
        return { kind: 'load_result' } as const;
      }
      if (attempt?.run.state === 'committed' || attempt?.run.resultId != null)
        held('invalid_result_pointer');
      const clip = await readCapture(tx, operation);
      if (
        operation.observation &&
        !originalClipMatches(operation.observation.clip, clip)
      )
        held('observation_changed');
      if (
        capture.status !== 'awaiting_model' ||
        (await hasProduct(tx, operation))
      )
        held('existing_product');
      // hasProduct covers this capture and its shot/outbox/receipt. Also hold
      // mixed legacy history or a record that stole the stable result id while
      // claiming a different capture; neither can become an original retry.
      const conflicts = await tx.execute(
        `SELECT id FROM local_analysis_record WHERE owner_key = ? AND id = ?
        UNION ALL SELECT analysis_id FROM analysis_run_journal WHERE owner_key = ? AND (capture_id = ? OR analysis_id = ?) LIMIT 1`,
        [
          scope.ownerKey,
          operation.analysisId,
          scope.ownerKey,
          captureId,
          operation.analysisId,
        ],
      );
      if (conflicts.rows.length) held('existing_product');
      if (!operation.snapshot.clip.nativeMediaIdentity)
        return unavailable('legacy');
      assertCurrent();
      return {
        kind: 'ready',
        saved: Object.freeze({
          reference: Object.freeze({
            operationId: operation.operationId,
            captureId,
            ownerContext: owner,
            apiOrigin: scope.apiOrigin,
          }),
          clip,
        }),
      } as const;
    });
    assertCurrent();
    return result;
  } catch (error) {
    if (!isDataOwnerContextCurrent(owner))
      return unavailable('account_changed');
    if (signal?.aborted) return unavailable('cancelled');
    if (originChanged) return unavailable('origin_mismatch');
    if (error instanceof OriginalAnalysisHeldError) {
      if (error.reason === 'cancelled' || error.reason === 'origin_mismatch')
        return unavailable(error.reason);
      if (
        ['capture_changed', 'target_changed', 'observation_changed'].includes(
          error.reason,
        )
      )
        return unavailable('evidence_changed');
      if (error.reason === 'missing_capture') return unavailable('missing');
    }
    return unavailable('corrupt');
  } finally {
    stopSession?.();
  }
}

async function prepare(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  value: unknown,
  operationId = makeUuid(),
): Promise<OriginalAnalysisOperation> {
  rawOnly(db);
  execution.assertCurrent();
  const snapshot = assertOriginalAnalysisSnapshot(value);
  if (
    snapshot.ownerKey !== execution.scope.ownerKey ||
    snapshot.apiOrigin !== execution.scope.apiOrigin
  )
    held('scope_mismatch');
  originalAnalysisId(operationId);
  return currentTransaction(db, execution, async tx => {
    execution.assertCurrent();
    const existing = await readOperationRows(
      tx,
      snapshot.ownerKey,
      'capture_id',
      snapshot.captureId,
    );
    if (existing[0]) {
      const operation = decodeOperation(existing[0]);
      if (operation.settingsHash !== originalSettingsHash(snapshot))
        held('definition_changed');
      execution.assertCurrent();
      return operation;
    }
    const legacy = await tx.execute(
      `SELECT 1 FROM analysis_run_journal WHERE owner_key = ? AND capture_id = ?
      UNION ALL SELECT 1 FROM local_analysis_record WHERE owner_key = ? AND capture_id = ? LIMIT 1`,
      [
        snapshot.ownerKey,
        snapshot.captureId,
        snapshot.ownerKey,
        snapshot.captureId,
      ],
    );
    if (legacy.rows.length) held('legacy_unverifiable');
    await readCapture(tx, { snapshot });
    const now = Date.now();
    await tx.execute(
      `INSERT INTO analysis_logical_operations
      (owner_key, operation_id, capture_id, analysis_id, api_origin, original_settings, settings_hash, model_policy_hash, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.ownerKey,
        operationId,
        snapshot.captureId,
        makeUuid(),
        snapshot.apiOrigin,
        originalCanonicalJson(snapshot),
        originalSettingsHash(snapshot),
        originalModelPolicyHash(snapshot.modelPolicy),
        now,
        now,
      ],
    );
    execution.assertCurrent();
    return requireOperation(tx, execution, operationId);
  });
}

/** Seals actual sidecar bytes once they exist; never generates an observation
 * hash or a target selection to fill a missing receipt. No permit is reserved. */
async function sealObservation(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
  input: {
    clip: CapturedClip;
    sidecarJson: string;
    captureEnvelope: unknown;
  },
): Promise<OriginalAnalysisOperation> {
  execution.assertCurrent();
  const clip = assertOriginalClip(input.clip);
  const pose = clip.poseSequence;
  if (
    !pose ||
    typeof input.sidecarJson !== 'string' ||
    input.sidecarJson.length > 16_000_000 ||
    sha256Hex(input.sidecarJson) !== pose.sha256
  )
    held('observation_unverifiable');
  const parsed = parsePoseSequence(input.sidecarJson, {
    providerId:
      Platform.OS === 'android' ? 'pose.mediapipe' : 'pose.apple-vision',
    runtime: Platform.OS === 'android' ? 'mediapipe' : 'vision_framework',
    executionTarget: 'on_device',
    artifactHash: null,
  });
  if (
    !parsed.ok ||
    parsed.value.frames.length !== pose.frameCount ||
    parsed.value.producedBy.modelVersion !== pose.poseModelVersion ||
    parsed.value.video.width !== clip.width ||
    parsed.value.video.height !== clip.height ||
    parsed.value.video.fps !== clip.fps
  )
    held('observation_unverifiable');
  const observation: OriginalObservationSeal = Object.freeze({
    version: 'original-observation-v1',
    clip,
    observationHash: pose.sha256,
    captureEnvelope: assertOriginalEnvelope(input.captureEnvelope),
  });
  return currentTransaction(db, execution, async tx => {
    const operation = await requireOperation(tx, execution, operationId);
    const current = await readCapture(tx, operation);
    if (
      !originalClipMatches(clip, current) ||
      !originalClipMatches(operation.snapshot.clip, clip) ||
      operation.modelPolicyHash === null
    )
      held('definition_changed');
    if (
      operation.snapshot.captureEnvelope !== null &&
      originalCanonicalJson(operation.snapshot.captureEnvelope) !==
        originalCanonicalJson(observation.captureEnvelope)
    )
      held('envelope_changed');
    const hash = sealHash(operation.snapshot, observation);
    if (operation.observation) {
      if (operation.executionHash !== hash) held('observation_changed');
      execution.assertCurrent();
      return operation;
    }
    if (operation.currentAttemptId || (await hasProduct(tx, operation)))
      held('existing_product');
    await tx.execute(
      'UPDATE analysis_logical_operations SET observation_seal = ?, execution_hash = ?, updated_at_ms = ? WHERE owner_key = ? AND operation_id = ? AND observation_seal IS NULL',
      [
        originalCanonicalJson(observation),
        hash,
        Date.now(),
        execution.scope.ownerKey,
        operationId,
      ],
    );
    execution.assertCurrent();
    return requireOperation(tx, execution, operationId);
  });
}
interface AdmissionRequest {
  settingsHash: string;
  modelPolicyHash: string;
  /** Exact attempt the user saw fail; stale callbacks cannot skip a successor. */
  predecessorAttemptId?: string;
}
async function inspectAdmission(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
  request: AdmissionRequest,
): Promise<
  | OriginalAnalysisAdmission
  | {
      kind: 'candidate';
      operation: OriginalAnalysisOperation;
      predecessor: OriginalAnalysisAttempt | null;
    }
> {
  const operation = await requireOperation(db, execution, operationId);
  if (operation.finalRecordId !== null) return { kind: 'replay', operation };
  if (await hasProduct(db, operation))
    return { kind: 'held', reason: 'existing_product', operation };
  let predecessor: OriginalAnalysisAttempt | null = null;
  if (operation.currentAttemptId !== null) {
    const current = await readAttempt(
      db,
      operation,
      operation.currentAttemptId,
    );
    if (request.predecessorAttemptId !== operation.currentAttemptId) {
      if (request.predecessorAttemptId === undefined && current.ordinal === 1)
        return { kind: 'existing', operation, attempt: current };
      if (request.predecessorAttemptId) {
        const { rows } = await db.execute(
          'SELECT operation_id FROM analysis_execution_attempts WHERE owner_key = ? AND predecessor_operation_id = ?',
          [
            execution.scope.ownerKey,
            originalAnalysisId(request.predecessorAttemptId),
          ],
        );
        if (rows[0])
          return {
            kind: 'existing',
            operation,
            attempt: await readAttempt(
              db,
              operation,
              originalAnalysisId(rows[0].operation_id),
            ),
          };
      }
      return {
        kind: 'held',
        reason: 'stale_predecessor',
        operation,
        attempt: current,
      };
    }
    const run = current.run;
    if (
      runJournal.activeOperationIds(execution.scope).includes(run.operationId)
    )
      return { kind: 'held', reason: 'active', operation, attempt: current };
    // `released` is written ONLY after the journal's release call acknowledged
    // success. Empty/terminal/FK/404/reserve-replay responses are not this proof.
    if (
      run.state !== 'released' ||
      run.releaseOutcome !== 'failed' ||
      run.permitId === null ||
      run.resultId !== null ||
      run.terminalReason !== null ||
      run.lastHttpStatus !== null ||
      run.attemptCount < 1 ||
      current.technicalFailure === null
    ) {
      return {
        kind: 'held',
        reason: 'reconcile_original_only',
        operation,
        attempt: current,
      };
    }
    predecessor = current;
  } else if (request.predecessorAttemptId !== undefined)
    return { kind: 'held', reason: 'missing_predecessor_proof', operation };
  if (
    !operation.observation ||
    !operation.snapshot.clip.nativeMediaIdentity ||
    operation.modelPolicyHash === null
  )
    return { kind: 'held', reason: 'original_unverifiable', operation };
  if (
    operation.settingsHash !== request.settingsHash ||
    operation.modelPolicyHash !== request.modelPolicyHash
  )
    return { kind: 'held', reason: 'definition_changed', operation };
  execution.assertCurrent();
  return { kind: 'candidate', operation, predecessor };
}
async function admitOnce(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
  request: AdmissionRequest,
): Promise<OriginalAnalysisAdmission> {
  rawOnly(db);
  // Freeze the caller's expected definition before the first await.
  const expected = Object.freeze({ ...request });
  try {
    const inspected = await currentTransaction(db, execution, tx =>
      inspectAdmission(tx, execution, operationId, expected),
    );
    if (inspected.kind !== 'candidate') return inspected;
    const clip = await readCapture(db, inspected.operation);
    if (!originalClipMatches(inspected.operation.observation!.clip, clip))
      held('observation_changed');
    execution.assertCurrent();
    // Mandatory real read boundary. Never substitute a metadata/hash comparison
    // for this call or persist its return value as a reusable authorization.
    const verified = await verifyCapturedClipCurrentBytes(
      clip,
      execution.ownerContext,
      { operationId: makeUuid(), signal: execution.signal },
    );
    execution.assertCurrent();
    if (
      verified.status !== 'verified-current-bytes' ||
      originalCanonicalJson(verified.comparedExpectation) !==
        originalCanonicalJson(
          inspected.operation.snapshot.clip.nativeMediaIdentity,
        )
    ) {
      return {
        kind: 'held',
        reason: 'original_bytes_unverified',
        operation: inspected.operation,
      };
    }
    return await currentTransaction(db, execution, async tx => {
      const fresh = await inspectAdmission(
        tx,
        execution,
        operationId,
        expected,
      );
      if (fresh.kind !== 'candidate') return fresh;
      if (fresh.operation.executionHash !== inspected.operation.executionHash)
        held('definition_changed');
      const current = await readCapture(tx, fresh.operation);
      if (!originalClipMatches(clip, current)) held('capture_changed');
      execution.assertCurrent();
      const run: RunJournalIdentity = {
        ...execution.scope,
        operationId: makeUuid(),
        ownerGeneration: execution.ownerContext.generation,
        captureId: fresh.operation.snapshot.captureId,
        analysisId: fresh.operation.analysisId,
        reservationKey: makeUuid(),
        requestHash: fresh.operation.executionHash!,
      };
      const begun = await analysisAttemptJournal.begin(tx, run, Date.now(), {
        ordinal: (fresh.predecessor?.ordinal ?? 0) + 1,
        predecessorOperationId: fresh.predecessor?.run.operationId ?? null,
      });
      if (!begun.created) held('attempt_identity_collision');
      await tx.execute(
        'UPDATE analysis_logical_operations SET current_attempt_id = ?, updated_at_ms = ? WHERE owner_key = ? AND operation_id = ?',
        [run.operationId, Date.now(), execution.scope.ownerKey, operationId],
      );
      execution.assertCurrent();
      const operation = await requireOperation(tx, execution, operationId);
      return {
        kind: 'created',
        operation,
        attempt: await readAttempt(tx, operation, run.operationId),
      };
    });
  } catch (error) {
    return {
      kind: 'held',
      reason:
        error instanceof OriginalAnalysisHeldError
          ? error.reason
          : 'unknown_admission',
    };
  }
}
const admissionFlights = new WeakMap<
  LocalDb,
  Map<string, Promise<OriginalAnalysisAdmission>>
>();
/** The native reader has a busy barrier. Same-definition taps share this ONE
 * in-flight comparison, not a cached proof. Only its creator may execute the
 * resulting attempt; waiters get existing/held and still check their lease. */
async function admit(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
  request: AdmissionRequest,
): Promise<OriginalAnalysisAdmission> {
  try {
    rawOnly(db);
    execution.assertCurrent();
    const expected = Object.freeze({
      settingsHash: originalDigest(request.settingsHash),
      modelPolicyHash: originalDigest(request.modelPolicyHash),
      ...(request.predecessorAttemptId === undefined
        ? {}
        : {
            predecessorAttemptId: originalAnalysisId(
              request.predecessorAttemptId,
            ),
          }),
    });
    const key = JSON.stringify([
      execution.scope,
      execution.ownerContext.generation,
      originalAnalysisId(operationId),
      expected,
    ]);
    let flights = admissionFlights.get(db);
    if (!flights) {
      flights = new Map();
      admissionFlights.set(db, flights);
    }
    const previous = flights.get(key);
    if (previous) {
      const result = await previous;
      execution.assertCurrent();
      return result.kind === 'created'
        ? { ...result, kind: 'existing' }
        : result;
    }
    const pending = admitOnce(db, execution, operationId, expected);
    flights.set(key, pending);
    try {
      return await pending;
    } finally {
      if (flights.get(key) === pending) flights.delete(key);
      if (flights.size === 0) admissionFlights.delete(db);
    }
  } catch (error) {
    return {
      kind: 'held',
      reason:
        error instanceof OriginalAnalysisHeldError
          ? error.reason
          : 'unknown_admission',
    };
  }
}
function sameRun(a: RunJournalIdentity, b: RunJournalIdentity): boolean {
  return (
    a.ownerKey === b.ownerKey &&
    a.apiOrigin === b.apiOrigin &&
    a.operationId === b.operationId &&
    a.ownerGeneration === b.ownerGeneration &&
    a.captureId === b.captureId &&
    a.analysisId === b.analysisId &&
    a.reservationKey === b.reservationKey &&
    a.requestHash === b.requestHash
  );
}
async function assertCurrentAttempt(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
  run: RunJournalIdentity,
): Promise<OriginalAnalysisOperation> {
  const operation = await requireOperation(db, execution, operationId);
  const actual = await readAttempt(db, operation, run.operationId);
  if (
    operation.currentAttemptId !== run.operationId ||
    run.ownerGeneration !== execution.ownerContext.generation ||
    !sameRun(actual.run, run)
  )
    held('stale_attempt');
  execution.assertCurrent();
  return operation;
}
/** Cleanup is original-owner/raw-DB bound even when that UI/account has gone.
 * Technical classification and release intent land together. Unknown result
 * reads roll back; they never authorize release or a new execution. */
async function requestRelease(
  db: LocalDb,
  run: RunJournalIdentity,
  outcome: RunJournalReleaseOutcome,
  technical: AnalysisTechnicalFailure | null = null,
): Promise<void> {
  rawOnly(db);
  if (
    technical !== null &&
    (!ANALYSIS_RETRYABLE_FAILURES.includes(technical) || outcome !== 'failed')
  )
    held('invalid_failure');
  await withTransaction(db, async tx => {
    const rows = await readOperationRows(
      tx,
      run.ownerKey,
      'analysis_id',
      run.analysisId,
    );
    if (!rows[0]) held('missing_operation');
    const operation = decodeOperation(rows[0]);
    const actual = await readAttempt(tx, operation, run.operationId);
    if (!sameRun(actual.run, run)) held('stale_attempt');
    if (operation.finalRecordId !== null || (await hasProduct(tx, operation)))
      return;
    if (operation.currentAttemptId !== run.operationId) return;
    if (
      technical &&
      ['reserve_pending', 'reserved'].includes(actual.run.state)
    ) {
      await tx.execute(
        `UPDATE analysis_execution_attempts SET technical_failure = ? WHERE owner_key = ? AND operation_id = ? AND technical_failure IS NULL AND state IN ('reserve_pending','reserved')`,
        [technical, run.ownerKey, run.operationId],
      );
    }
    await analysisAttemptJournal.requestRelease(tx, run, outcome);
  });
}
function recordMatches(
  operation: OriginalAnalysisOperation,
  run: RunJournalEntry,
  record: CaptureAnalysisRecord,
): boolean {
  const metadata = {
    id: operation.analysisId,
    captureId: operation.snapshot.captureId,
    createdAtIso: record.createdAtIso,
    engineVersion: operation.snapshot.modelPolicy?.[0],
    scoringModelVersion:
      record.result?.versionVector.scoringModelVersion ?? 'abstained',
  };
  if (
    record.kind === 'needs_technique_confirmation'
      ? !parseNeedsTechniqueConfirmationRecord(record, metadata).ok
      : readPartialOutcome(record) !== null
        ? readPartialCaptureAnalysisRecord(record, metadata) === null
        : !isVerifiedCompletedCaptureRecord(record, metadata)
  )
    return false;
  const selection = record.inputSelection;
  return (
    originalCanonicalJson(record.captureEnvelope ?? null) ===
      originalCanonicalJson(operation.observation?.captureEnvelope) &&
    isAnalysisInputSelectionSnapshot(selection) &&
    record.id === operation.analysisId &&
    record.captureId === operation.snapshot.captureId &&
    record.observationHash === operation.observation?.observationHash &&
    selection.definitionHash === operation.executionHash &&
    selection.modelPolicyHash === operation.modelPolicyHash &&
    selection.ownerKey === run.ownerKey &&
    selection.apiOrigin === run.apiOrigin &&
    selection.ownerGeneration === run.ownerGeneration &&
    selection.handedness === operation.snapshot.handedness &&
    selection.cameraView === operation.snapshot.cameraView &&
    selection.focusCheckpoint === operation.snapshot.focusCheckpoint &&
    selection.declaredStroke === operation.snapshot.declaredStroke &&
    selection.declaredCanonical === operation.snapshot.declaredCanonical &&
    confirmationInputsMatch(
      selection,
      operation.observation!.clip,
      operation.snapshot.targetSeed,
    ) &&
    (record.result === null ||
      (record.result.id === operation.analysisId &&
        record.result.sessionId === operation.snapshot.sessionId &&
        record.result.versionVector.appVersion ===
          operation.snapshot.appVersion &&
        record.result.versionVector.modelBundleVersion ===
          operation.snapshot.modelPolicy?.[2]))
  );
}
/** The receipt-paid completion of a court-offline scored original: the
 * attempt never held a permit and stays on its unanswered reservation; the
 * receipt names this exact result and output digest. */
async function receiptPaidCompletion(
  db: LocalDb,
  operation: OriginalAnalysisOperation,
  attempt: OriginalAnalysisAttempt,
): Promise<boolean> {
  if (attempt.technicalFailure !== null) return false;
  const { rows } = await db.execute(
    `SELECT payload FROM local_shot WHERE owner_key = ? AND id = ? AND source = 'real' AND result_kind = 'scored'`,
    [operation.snapshot.ownerKey, operation.analysisId],
  );
  const payload = rows[0]?.payload;
  if (typeof payload !== 'string') return false;
  let result: ShotAnalysis;
  try {
    result = JSON.parse(payload) as ShotAnalysis;
  } catch {
    return false;
  }
  if (
    typeof result !== 'object' ||
    result === null ||
    result.id !== operation.analysisId ||
    result.resultKind !== 'scored'
  )
    return false;
  return receiptPaidRun(db, attempt.run, result);
}
/** Finalize an original whose scored rating was paid by a held grant inside
 * the caller's transaction: the rating, the receipt and the run's unanswered
 * reservation are already durable there. Like the PARTIAL completion, the
 * pointer lives beside the operation row (`analysis_offline_completion`,
 * whose admission trigger re-proves the whole chain); the row itself keeps
 * its permit-backed contract. */
async function commitReceiptPaid(
  tx: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
  run: RunJournalIdentity,
  record: CaptureAnalysisRecord,
): Promise<void> {
  rawOnly(tx);
  const operation = await assertCurrentAttempt(tx, execution, operationId, run);
  const attempt = await readAttempt(tx, operation, run.operationId);
  const receipt = await readOfflineReceiptForOperation(tx, run.operationId);
  if (
    record.result?.resultKind !== 'scored' ||
    readPartialOutcome(record) !== null ||
    record.result.id !== record.id ||
    !recordMatches(operation, attempt.run, record) ||
    operation.finalRecordId !== null ||
    receipt === null ||
    receipt.resultId !== record.id ||
    !(await receiptPaidCompletion(tx, operation, attempt))
  )
    held('commit_not_admitted');
  const { rows } = await tx.execute(
    `SELECT 1 AS found FROM local_analysis_record WHERE owner_key = ? AND id = ? AND capture_id = ?`,
    [run.ownerKey, record.id, run.captureId],
  );
  if (!rows[0]) held('commit_not_admitted');
  await tx.execute(
    `INSERT INTO analysis_offline_completion
    (owner_key, operation_id, attempt_id, analysis_id, capture_id, receipt_id, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      run.ownerKey,
      operationId,
      run.operationId,
      record.id,
      run.captureId,
      receipt.receiptId,
      Date.now(),
    ],
  );
  execution.assertCurrent();
}
async function commit(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
  run: RunJournalIdentity,
  record: CaptureAnalysisRecord,
  withheld: PartialOutcomeMarker | null = null,
  reservation: 'reserved' | 'unanswered' = 'reserved',
): Promise<void> {
  await currentTransaction(db, execution, async tx => {
    const operation = await assertCurrentAttempt(
      tx,
      execution,
      operationId,
      run,
    );
    const attempt = await readAttempt(tx, operation, run.operationId);
    const partial = readPartialOutcome(record);
    // A court-offline abstention never got its reservation answered and
    // spends nothing: it completes on the pending reservation, which
    // recovery releases as `low_confidence` once the service answers.
    const admittedState =
      reservation === 'reserved'
        ? attempt.run.state === 'reserved'
        : attempt.run.state === 'reserve_pending' &&
          attempt.run.permitId === null &&
          record.result?.resultKind !== 'scored';
    if (
      (withheld === null
        ? !admittedState ||
          partial !== null ||
          attempt.technicalFailure !== null
        : !isSettledRefusal(attempt) ||
          partial === null ||
          originalCanonicalJson(partial) !== originalCanonicalJson(withheld) ||
          originalCanonicalJson(
            await readReservationRefusal(tx, attempt.run),
          ) !== originalCanonicalJson(withheld)) ||
      !recordMatches(operation, attempt.run, record) ||
      operation.finalRecordId !== null ||
      (await hasProduct(tx, operation))
    )
      held('commit_not_admitted');
    const ownerDb = forDataOwner(tx, execution.ownerContext);
    await saveAnalysisRecord(ownerDb, record);
    execution.assertCurrent();
    if (record.kind !== 'needs_technique_confirmation')
      await markCaptureAnalyzed(ownerDb, run.captureId);
    const scored = record.result?.resultKind === 'scored';
    if (scored) {
      if (operation.snapshot.practiceSet)
        await commitPracticeSet(ownerDb, operation.snapshot.practiceSet);
      await saveAnalysis(ownerDb, record.result!, attempt.run.permitId!);
      await analysisAttemptJournal.commit(tx, run, record.id);
    } else if (partial !== null) {
      await tx.execute(
        `INSERT INTO analysis_partial_completion
        (owner_key, operation_id, attempt_id, analysis_id, capture_id, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          run.ownerKey,
          operationId,
          run.operationId,
          record.id,
          run.captureId,
          Date.now(),
        ],
      );
      execution.assertCurrent();
      return;
    } else {
      if (record.result) await saveLocalOnlyAnalysis(ownerDb, record.result);
      await analysisAttemptJournal.requestRelease(tx, run, 'low_confidence');
    }
    await tx.execute(
      `UPDATE analysis_logical_operations SET final_record_id = ?, winning_attempt_id = ?, completion_kind = ?, updated_at_ms = ?
      WHERE owner_key = ? AND operation_id = ? AND final_record_id IS NULL`,
      [
        record.id,
        run.operationId,
        scored
          ? 'scored'
          : record.kind === 'needs_technique_confirmation'
            ? 'needs_technique_confirmation'
            : 'low_confidence',
        Date.now(),
        run.ownerKey,
        operationId,
      ],
    );
    execution.assertCurrent();
  });
}
async function loadCompletion(
  db: LocalDb,
  execution: OriginalAnalysisExecution,
  operationId: string,
): Promise<{
  operation: OriginalAnalysisOperation;
  attempt: OriginalAnalysisAttempt;
  record: CaptureAnalysisRecord;
} | null> {
  return currentTransaction(db, execution, async tx => {
    const operation = await requireOperation(tx, execution, operationId);
    if (!operation.finalRecordId || !operation.winningAttemptId) return null;
    const attempt = await readAttempt(
      tx,
      operation,
      operation.winningAttemptId,
    );
    const { rows } = await tx.execute(
      `SELECT r.*, s.id AS shot_id, s.payload AS shot_payload, s.captured_at AS shot_captured_at, s.session_id AS shot_session_id,
      s.shot_type AS shot_type, s.overall_score AS shot_score, s.confidence AS shot_confidence, s.result_kind AS shot_kind, s.source AS shot_source
      FROM local_analysis_record r LEFT JOIN local_shot s ON s.owner_key = r.owner_key AND s.id = r.id WHERE r.owner_key = ? AND r.id = ?`,
      [execution.scope.ownerKey, operation.analysisId],
    );
    const row = rows[0];
    if (!row || typeof row.record !== 'string' || row.record.length > 8_000_000)
      held('missing_result');
    const value: unknown = JSON.parse(row.record);
    const metadata = {
      id: row.id,
      captureId: row.capture_id,
      createdAtIso: row.created_at,
      engineVersion: row.engine_version,
      scoringModelVersion: row.scoring_model_version,
    };
    let record: CaptureAnalysisRecord;
    if (operation.completionKind === 'needs_technique_confirmation') {
      const parsed = parseNeedsTechniqueConfirmationRecord(value, metadata);
      if (!parsed.ok || row.shot_id !== null) held('invalid_result');
      record = parsed.value;
    } else if (operation.completionKind === 'partial') {
      const partial = readPartialCaptureAnalysisRecord(value, metadata);
      if (
        partial === null ||
        row.shot_id !== null ||
        !isSettledRefusal(attempt) ||
        originalCanonicalJson(await readReservationRefusal(tx, attempt.run)) !==
          originalCanonicalJson(partial.partialOutcome)
      )
        held('invalid_result');
      record = partial;
    } else {
      if (!isVerifiedCompletedCaptureRecord(value, metadata))
        held('invalid_result');
      record = value;
      const result = value.result;
      if (
        typeof row.shot_payload !== 'string' ||
        originalCanonicalJson(JSON.parse(row.shot_payload)) !==
          originalCanonicalJson(result) ||
        row.shot_id !== result.id ||
        row.shot_captured_at !== result.capturedAtIso ||
        row.shot_session_id !== result.sessionId ||
        row.shot_type !== result.shotType ||
        row.shot_score !== result.overallScore ||
        row.shot_confidence !== result.analysisConfidence ||
        row.shot_kind !== result.resultKind ||
        row.shot_source !== result.source ||
        operation.completionKind !== result.resultKind
      )
        held('invalid_result');
    }
    if (
      !recordMatches(operation, attempt.run, record) ||
      (operation.completionKind === 'scored'
        ? (attempt.run.state !== 'committed' ||
            attempt.run.resultId !== record.id) &&
          !(await receiptPaidCompletion(tx, operation, attempt))
        : operation.completionKind === 'partial'
          ? readPartialOutcome(record) === null
          : attempt.run.releaseOutcome !== 'low_confidence' ||
            readPartialOutcome(record) !== null)
    )
      held('invalid_result');
    execution.assertCurrent();
    return { operation, attempt, record };
  });
}

export const originalAnalysisOperations = Object.freeze({
  prepare,
  read,
  readCapture,
  readAttempt,
  hasSettledRefusal,
  sealObservation,
  admit,
  assertCurrentAttempt,
  requestRelease,
  commit,
  commitReceiptPaid,
  loadCompletion,
  loadSavedOriginalAnalysis,
});
