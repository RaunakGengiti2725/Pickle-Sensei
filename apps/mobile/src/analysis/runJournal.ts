import type { LocalDb } from '../data/db';
import { withTransaction } from '../data/transactions';
import {
  isReleaseNotAuthorized,
  isSettledRefusalRun,
  partialOutcomeMarker,
  saveReservationRefusal,
} from './partialOutcome';
import {
  RUN_JOURNAL_RELEASE_OUTCOMES,
  RUN_JOURNAL_STATES,
  RUN_JOURNAL_TERMINAL_REASONS,
} from './runJournalSchema';

export interface RunJournalScope {
  readonly ownerKey: string;
  readonly apiOrigin: string;
}

export interface RunJournalReference extends RunJournalScope {
  readonly operationId: string;
}

export interface RunJournalIdentity extends RunJournalReference {
  readonly ownerGeneration: number;
  readonly captureId: string;
  readonly analysisId: string;
  readonly reservationKey: string;
  readonly requestHash: string;
}

export type RunJournalState = (typeof RUN_JOURNAL_STATES)[number];
export type RunJournalReleaseOutcome =
  (typeof RUN_JOURNAL_RELEASE_OUTCOMES)[number];
export type RunJournalTerminalReason =
  (typeof RUN_JOURNAL_TERMINAL_REASONS)[number];

export interface RunJournalAttemptMetadata {
  readonly ordinal: number;
  readonly predecessorOperationId: string | null;
}

export interface RunJournalEntry extends RunJournalIdentity {
  readonly state: RunJournalState;
  readonly permitId: string | null;
  readonly resultId: string | null;
  readonly releaseOutcome: RunJournalReleaseOutcome | null;
  readonly terminalReason: RunJournalTerminalReason | null;
  readonly lastHttpStatus: number | null;
  readonly attemptCount: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface RunJournalPermitPort extends RunJournalScope {
  reserve(idempotencyKey: string): Promise<{
    permit: { id: string; status: string };
  }>;
  release(permitId: string, outcome: RunJournalReleaseOutcome): Promise<void>;
}

export type RunJournalCommitStatus =
  | { kind: 'committed'; resultId: string; run: RunJournalEntry }
  | { kind: 'not_committed'; run: RunJournalEntry }
  | { kind: 'missing' }
  | { kind: 'unknown' };

export interface RunJournalRecoveryItem {
  readonly operationId: string;
  readonly kind:
    | 'released'
    | 'pending'
    | 'terminal'
    | 'committed'
    | 'missing'
    | 'held'
    | 'active';
}

export interface RunJournalRecoveryOptions {
  readonly operationId?: string;
  readonly limit?: number;
  readonly excludeOperationIds?: readonly string[];
  readonly now?: () => number;
}

export class RunJournalError extends Error {
  constructor(
    readonly code:
      | 'invalid_identity'
      | 'raw_db_required'
      | 'identity_conflict'
      | 'missing_capture'
      | 'missing_run'
      | 'invalid_transition'
      | 'execution_active'
      | 'scope_mismatch'
      | 'invalid_row'
      | 'invalid_options'
      | 'invalid_response',
  ) {
    super(`Analysis run journal: ${code}`);
    this.name = 'RunJournalError';
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_KEYS: readonly (keyof RunJournalIdentity)[] = [
  'ownerKey',
  'apiOrigin',
  'operationId',
  'ownerGeneration',
  'captureId',
  'analysisId',
  'reservationKey',
  'requestHash',
];
const WHERE_RUN = 'WHERE owner_key = ? AND operation_id = ? AND api_origin = ?';

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new RunJournalError('invalid_identity');
  }
  return value.toLowerCase();
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RunJournalError('invalid_identity');
  }
  return value;
}

function member<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[?#]/.test(value)) {
    throw new RunJournalError('invalid_identity');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RunJournalError('invalid_identity');
  }
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw new RunJournalError('invalid_identity');
  }
  return url.href.replace(/\/+$/, '');
}

function scopeSnapshot(scope: RunJournalScope): RunJournalScope {
  return Object.freeze({
    ownerKey: uuid(scope.ownerKey),
    apiOrigin: origin(scope.apiOrigin),
  });
}

function referenceSnapshot(ref: RunJournalReference): RunJournalReference {
  return Object.freeze({
    ...scopeSnapshot(ref),
    operationId: uuid(ref.operationId),
  });
}

function identitySnapshot(run: RunJournalIdentity): RunJournalIdentity {
  if (
    typeof run.requestHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(run.requestHash)
  ) {
    throw new RunJournalError('invalid_identity');
  }
  return Object.freeze({
    ...referenceSnapshot(run),
    ownerGeneration: integer(run.ownerGeneration),
    captureId: uuid(run.captureId),
    analysisId: uuid(run.analysisId),
    reservationKey: uuid(run.reservationKey),
    requestHash: run.requestHash.toLowerCase(),
  });
}

const activeExecutions = new Map<string, Map<string, symbol>>();
const protectedAdmissions = new Map<string, Map<string, symbol>>();

function scopeKey(scope: RunJournalScope): string {
  return JSON.stringify([scope.ownerKey, scope.apiOrigin]);
}

function activeOperationIds(owner: RunJournalScope): readonly string[] {
  return Object.freeze([
    ...(activeExecutions.get(scopeKey(scopeSnapshot(owner)))?.keys() ?? []),
  ]);
}

function startExecution(reference: RunJournalReference): () => void {
  const ref = referenceSnapshot(reference);
  const key = scopeKey(ref);
  const active = activeExecutions.get(key) ?? new Map<string, symbol>();
  if (active.has(ref.operationId))
    throw new RunJournalError('execution_active');
  const token = Symbol();
  active.set(ref.operationId, token);
  activeExecutions.set(key, active);
  return () => {
    if (active.get(ref.operationId) !== token) return;
    active.delete(ref.operationId);
    if (active.size === 0) activeExecutions.delete(key);
  };
}

function protectAnalysisAdmission(
  scope: RunJournalScope,
  analysisId: string,
): () => void {
  const key = scopeKey(scopeSnapshot(scope));
  const id = uuid(analysisId);
  const active = protectedAdmissions.get(key) ?? new Map<string, symbol>();
  if (active.has(id)) throw new RunJournalError('execution_active');
  const token = Symbol();
  active.set(id, token);
  protectedAdmissions.set(key, active);
  return () => {
    if (active.get(id) !== token) return;
    active.delete(id);
    if (active.size === 0) protectedAdmissions.delete(key);
  };
}

function requireRaw(db: LocalDb): void {
  if (db.ownerContext !== undefined)
    throw new RunJournalError('raw_db_required');
}

function assertIdentity(entry: RunJournalEntry, run: RunJournalIdentity): void {
  if (IDENTITY_KEYS.some(key => entry[key] !== run[key])) {
    throw new RunJournalError('identity_conflict');
  }
}

function decode(row: Record<string, unknown>): RunJournalEntry {
  try {
    const run = identitySnapshot({
      ownerKey: row.owner_key as string,
      apiOrigin: row.api_origin as string,
      operationId: row.operation_id as string,
      ownerGeneration: row.owner_generation as number,
      captureId: row.capture_id as string,
      analysisId: row.analysis_id as string,
      reservationKey: row.reservation_key as string,
      requestHash: row.request_hash as string,
    });
    const state = row.state;
    const releaseOutcome = row.release_outcome;
    const terminalReason = row.terminal_reason;
    if (
      !member(state, RUN_JOURNAL_STATES) ||
      !(
        releaseOutcome === null ||
        member(releaseOutcome, RUN_JOURNAL_RELEASE_OUTCOMES)
      ) ||
      !(
        terminalReason === null ||
        member(terminalReason, RUN_JOURNAL_TERMINAL_REASONS)
      )
    ) {
      throw new RunJournalError('invalid_row');
    }
    const permitId = row.permit_id === null ? null : uuid(row.permit_id);
    const resultId = row.result_id === null ? null : uuid(row.result_id);
    const lastHttpStatus =
      row.last_http_status === null ? null : integer(row.last_http_status);
    if (
      lastHttpStatus !== null &&
      (lastHttpStatus < 100 || lastHttpStatus > 599)
    ) {
      throw new RunJournalError('invalid_row');
    }
    const releasing =
      state === 'release_pending' ||
      state === 'released' ||
      state === 'terminal';
    if (
      (state === 'reserve_pending' && permitId !== null) ||
      ((state === 'reserved' ||
        state === 'committed' ||
        state === 'released') &&
        permitId === null) ||
      (state === 'committed'
        ? resultId !== run.analysisId
        : resultId !== null) ||
      (releasing ? releaseOutcome === null : releaseOutcome !== null) ||
      (state === 'terminal' ? terminalReason === null : terminalReason !== null)
    ) {
      throw new RunJournalError('invalid_row');
    }
    return Object.freeze({
      ...run,
      state,
      permitId,
      resultId,
      releaseOutcome,
      terminalReason,
      lastHttpStatus,
      attemptCount: integer(row.attempt_count),
      createdAtMs: integer(row.created_at_ms),
      updatedAtMs: integer(row.updated_at_ms),
    });
  } catch {
    throw new RunJournalError('invalid_row');
  }
}

function createJournal(
  table: 'analysis_run_journal' | 'analysis_execution_attempts',
) {
  async function read(
    db: LocalDb,
    reference: RunJournalReference,
  ): Promise<RunJournalEntry | null> {
    requireRaw(db);
    const ref = referenceSnapshot(reference);
    const { rows } = await db.execute(
      `SELECT * FROM ${table} WHERE owner_key = ? AND operation_id = ?`,
      [ref.ownerKey, ref.operationId],
    );
    if (!rows[0]) return null;
    const entry = decode(rows[0]);
    if (entry.ownerKey !== ref.ownerKey || entry.apiOrigin !== ref.apiOrigin) {
      throw new RunJournalError('scope_mismatch');
    }
    return entry;
  }

  async function readMatching(
    db: LocalDb,
    run: RunJournalIdentity,
  ): Promise<RunJournalEntry | null> {
    const entry = await read(db, run);
    if (entry) assertIdentity(entry, run);
    return entry;
  }

  function runParams(run: RunJournalReference): unknown[] {
    return [run.ownerKey, run.operationId, run.apiOrigin];
  }

  async function update(
    db: LocalDb,
    run: RunJournalIdentity,
    sql: string,
    params: unknown[],
  ): Promise<RunJournalEntry | null> {
    const { rows } = await db.execute(sql, params);
    if (!rows[0]) return readMatching(db, run);
    const entry = decode(rows[0]);
    assertIdentity(entry, run);
    return entry;
  }

  async function begin(
    db: LocalDb,
    identity: RunJournalIdentity,
    nowMs = Date.now(),
    attempt?: RunJournalAttemptMetadata,
  ): Promise<{ created: boolean; run: RunJournalEntry }> {
    requireRaw(db);
    const run = identitySnapshot(identity);
    const now = integer(nowMs);
    const metadata = attempt
      ? {
          ordinal: integer(attempt.ordinal),
          predecessorOperationId:
            attempt.predecessorOperationId === null
              ? null
              : uuid(attempt.predecessorOperationId),
        }
      : null;
    if (
      metadata &&
      (table !== 'analysis_execution_attempts' ||
        metadata.ordinal < 1 ||
        (metadata.ordinal === 1) !== (metadata.predecessorOperationId === null))
    )
      throw new RunJournalError('invalid_identity');
    const { rows } = await db.execute(
      `INSERT INTO ${table}
      (owner_key, operation_id, owner_generation, capture_id, analysis_id, request_hash,
       api_origin, reservation_key, state, created_at_ms, updated_at_ms${metadata ? ', attempt_ordinal, predecessor_operation_id' : ''})
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'reserve_pending', ?, ?${metadata ? ', ?, ?' : ''}
     WHERE EXISTS (SELECT 1 FROM local_capture WHERE owner_key = ? AND id = ?)
     ON CONFLICT (owner_key, operation_id) DO NOTHING
     RETURNING *`,
      [
        run.ownerKey,
        run.operationId,
        run.ownerGeneration,
        run.captureId,
        run.analysisId,
        run.requestHash,
        run.apiOrigin,
        run.reservationKey,
        now,
        now,
        ...(metadata
          ? [metadata.ordinal, metadata.predecessorOperationId]
          : []),
        run.ownerKey,
        run.captureId,
      ],
    );
    const entry = rows[0] ? decode(rows[0]) : await readMatching(db, run);
    if (!entry) throw new RunJournalError('missing_capture');
    assertIdentity(entry, run);
    if (metadata) {
      const row =
        rows[0] ??
        (
          await db.execute(
            `SELECT attempt_ordinal, predecessor_operation_id FROM ${table} ${WHERE_RUN}`,
            runParams(run),
          )
        ).rows[0];
      if (
        row?.attempt_ordinal !== metadata.ordinal ||
        row.predecessor_operation_id !== metadata.predecessorOperationId
      )
        throw new RunJournalError('identity_conflict');
    }
    return { created: rows.length > 0, run: entry };
  }

  async function reserved(
    db: LocalDb,
    identity: RunJournalIdentity,
    reservedPermitId: string,
    nowMs = Date.now(),
  ): Promise<RunJournalEntry | null> {
    const run = identitySnapshot(identity);
    const permitId = uuid(reservedPermitId);
    const now = integer(nowMs);
    const entry = await readMatching(db, run);
    if (!entry) return null;
    if (entry.permitId !== null && entry.permitId !== permitId) {
      throw new RunJournalError('identity_conflict');
    }
    if (entry.state !== 'reserve_pending' && entry.state !== 'release_pending')
      return entry;
    return update(
      db,
      run,
      `UPDATE ${table}
     SET permit_id = ?, state = CASE WHEN state = 'reserve_pending' THEN 'reserved' ELSE state END,
         updated_at_ms = ?
     ${WHERE_RUN} AND state IN ('reserve_pending','release_pending')
       AND (permit_id IS NULL OR permit_id = ?)
     RETURNING *`,
      [permitId, now, ...runParams(run), permitId],
    );
  }

  async function commit(
    transaction: LocalDb,
    identity: RunJournalIdentity,
    committedResultId: string,
    nowMs = Date.now(),
  ): Promise<RunJournalEntry> {
    const run = identitySnapshot(identity);
    const resultId = uuid(committedResultId);
    const now = integer(nowMs);
    if (resultId !== run.analysisId)
      throw new RunJournalError('identity_conflict');
    const entry = await readMatching(transaction, run);
    if (!entry) throw new RunJournalError('missing_run');
    if (entry.state === 'committed') return entry;
    if (entry.state !== 'reserved')
      throw new RunJournalError('invalid_transition');
    const committed = await update(
      transaction,
      run,
      `UPDATE ${table} SET state = 'committed', result_id = ?, updated_at_ms = ?
     ${WHERE_RUN} AND state = 'reserved' AND permit_id IS NOT NULL RETURNING *`,
      [resultId, now, ...runParams(run)],
    );
    if (!committed) throw new RunJournalError('missing_run');
    if (committed.state !== 'committed')
      throw new RunJournalError('invalid_transition');
    return committed;
  }

  async function requestRelease(
    db: LocalDb,
    identity: RunJournalIdentity,
    outcome: RunJournalReleaseOutcome,
    nowMs = Date.now(),
  ): Promise<RunJournalEntry | null> {
    const run = identitySnapshot(identity);
    const now = integer(nowMs);
    if (!member(outcome, RUN_JOURNAL_RELEASE_OUTCOMES)) {
      throw new RunJournalError('invalid_identity');
    }
    const entry = await readMatching(db, run);
    if (
      !entry ||
      (entry.state !== 'reserve_pending' && entry.state !== 'reserved')
    )
      return entry;
    return update(
      db,
      run,
      `UPDATE ${table} SET state = 'release_pending', release_outcome = ?, updated_at_ms = ?
     ${WHERE_RUN} AND state IN ('reserve_pending','reserved') RETURNING *`,
      [outcome, now, ...runParams(run)],
    );
  }

  async function readCommitStatus(
    db: LocalDb,
    identity: RunJournalIdentity,
  ): Promise<RunJournalCommitStatus> {
    try {
      const entry = await readMatching(db, identitySnapshot(identity));
      if (!entry) return { kind: 'missing' };
      if (entry.state === 'committed' && entry.resultId !== null) {
        return { kind: 'committed', resultId: entry.resultId, run: entry };
      }
      return { kind: 'not_committed', run: entry };
    } catch {
      return { kind: 'unknown' };
    }
  }

  function assertPort(
    scope: RunJournalScope,
    port: RunJournalPermitPort,
  ): void {
    const binding = scopeSnapshot(port);
    if (
      binding.ownerKey !== scope.ownerKey ||
      binding.apiOrigin !== scope.apiOrigin
    ) {
      throw new RunJournalError('scope_mismatch');
    }
  }

  function recoveryItem(
    run: RunJournalIdentity,
    entry: RunJournalEntry | null,
  ): RunJournalRecoveryItem {
    return {
      operationId: run.operationId,
      kind:
        entry === null
          ? 'missing'
          : entry.state === 'reserve_pending' ||
              entry.state === 'reserved' ||
              entry.state === 'release_pending'
            ? 'pending'
            : entry.state,
    };
  }

  function failure(
    error: unknown,
    phase: 'reserve' | 'release',
  ): {
    status: number | null;
    terminalReason: RunJournalTerminalReason | null;
  } {
    const value =
      typeof error === 'object' && error !== null
        ? (error as { status?: unknown; code?: unknown })
        : {};
    const status =
      typeof value.status === 'number' &&
      Number.isInteger(value.status) &&
      value.status >= 100 &&
      value.status <= 599
        ? value.status
        : null;
    if (
      status === null ||
      status === 401 ||
      status === 408 ||
      status === 429 ||
      status >= 500 ||
      status < 400
    ) {
      return { status, terminalReason: null };
    }
    let terminalReason: RunJournalTerminalReason =
      phase === 'reserve' ? 'reservation_rejected' : 'release_rejected';
    if (
      phase === 'reserve' &&
      status === 409 &&
      value.code === 'access.permit_not_reserved'
    ) {
      terminalReason = 'permit_not_reserved';
    } else if (
      phase === 'release' &&
      status === 404 &&
      value.code === 'access.permit_not_found'
    ) {
      terminalReason = 'permit_not_found';
    } else if (
      phase === 'release' &&
      status === 409 &&
      value.code === 'access.permit_already_finalized'
    ) {
      terminalReason = 'permit_already_finalized';
    }
    return { status, terminalReason };
  }

  async function recordFailure(
    db: LocalDb,
    run: RunJournalIdentity,
    error: unknown,
    phase: 'reserve' | 'release',
    now: number,
  ): Promise<RunJournalEntry | null> {
    const { status, terminalReason } = failure(error, phase);
    return update(
      db,
      run,
      `UPDATE ${table} SET state = ?, terminal_reason = ?, last_http_status = ?, updated_at_ms = ?
     ${WHERE_RUN} AND state = 'release_pending' RETURNING *`,
      [
        terminalReason ? 'terminal' : 'release_pending',
        terminalReason,
        status,
        now,
        ...runParams(run),
      ],
    );
  }

  /**
   * A reserve failure during recovery. The authority's typed, settled refusal
   * is durable in the same transaction that makes the run terminal, so the
   * same run can later deliver its mechanics as the non-chargeable partial
   * instead of holding forever; every other failure is recorded as before.
   */
  async function recordReservationRefusal(
    db: LocalDb,
    run: RunJournalIdentity,
    error: unknown,
    now: number,
  ): Promise<RunJournalEntry | null> {
    if (!isReleaseNotAuthorized(error))
      return recordFailure(db, run, error, 'reserve', now);
    return withTransaction(db, async tx => {
      const entry = await recordFailure(tx, run, error, 'reserve', now);
      if (entry !== null && isSettledRefusalRun(entry))
        await saveReservationRefusal(tx, run, partialOutcomeMarker(), now);
      return entry;
    });
  }

  async function reservationFailed(
    db: LocalDb,
    identity: RunJournalIdentity,
    error: unknown,
    nowMs = Date.now(),
  ): Promise<RunJournalEntry | null> {
    const run = identitySnapshot(identity);
    const now = integer(nowMs);
    const entry = await requestRelease(db, run, 'failed', now);
    if (entry?.state !== 'release_pending' || entry.permitId !== null)
      return entry;
    return recordFailure(db, run, error, 'reserve', now);
  }

  function reservationResponse(value: unknown): { id: string; status: string } {
    const response = value as {
      permit?: { id?: unknown; status?: unknown };
    } | null;
    if (
      !response?.permit ||
      !member(response.permit.status, ['reserved', 'finalized', 'released'])
    ) {
      throw new RunJournalError('invalid_response');
    }
    return { id: uuid(response.permit.id), status: response.permit.status };
  }

  async function recoverOne(
    db: LocalDb,
    run: RunJournalEntry,
    port: RunJournalPermitPort,
    now: () => number,
  ): Promise<RunJournalRecoveryItem> {
    let finishRecovery: (() => void) | undefined;
    try {
      assertPort(run, port);
      if (
        activeOperationIds(run).includes(run.operationId) ||
        (table === 'analysis_execution_attempts' &&
          protectedAdmissions.get(scopeKey(run))?.has(run.analysisId))
      ) {
        return { operationId: run.operationId, kind: 'active' };
      }
      // New attempts and their recovery cannot both own an execution. Retain
      // the legacy recovery/single-flight behavior for existing installations.
      if (table === 'analysis_execution_attempts')
        finishRecovery = startExecution(run);
      let entry = await requestRelease(db, run, 'cancelled', now());
      if (entry?.state !== 'release_pending') return recoveryItem(run, entry);
      entry = await update(
        db,
        run,
        `UPDATE ${table} SET attempt_count = MIN(attempt_count + 1, 2147483647), updated_at_ms = ?
       ${WHERE_RUN} AND state = 'release_pending' RETURNING *`,
        [integer(now()), ...runParams(run)],
      );
      if (entry?.state !== 'release_pending') return recoveryItem(run, entry);
      assertPort(run, port);
      if (entry.permitId === null) {
        let permit: { id: string; status: string };
        let response: unknown;
        try {
          response = await port.reserve(entry.reservationKey);
        } catch (error) {
          assertPort(run, port);
          return recoveryItem(
            run,
            await recordReservationRefusal(db, run, error, integer(now())),
          );
        }
        assertPort(run, port);
        try {
          permit = reservationResponse(response);
        } catch (error) {
          return recoveryItem(
            run,
            await recordFailure(db, run, error, 'reserve', integer(now())),
          );
        }
        if (permit.status !== 'reserved') {
          return recoveryItem(
            run,
            await update(
              db,
              run,
              `UPDATE ${table} SET state = 'terminal', permit_id = ?, terminal_reason = 'permit_not_reserved',
               last_http_status = NULL, updated_at_ms = ?
           ${WHERE_RUN} AND state = 'release_pending' AND permit_id IS NULL RETURNING *`,
              [permit.id, integer(now()), ...runParams(run)],
            ),
          );
        }
        entry = await reserved(db, run, permit.id, now());
      }
      if (entry?.state !== 'release_pending') return recoveryItem(run, entry);
      if (entry.permitId === null || entry.releaseOutcome === null) {
        throw new RunJournalError('invalid_row');
      }
      assertPort(run, port);
      try {
        await port.release(entry.permitId, entry.releaseOutcome);
      } catch (error) {
        assertPort(run, port);
        return recoveryItem(
          run,
          await recordFailure(db, run, error, 'release', integer(now())),
        );
      }
      assertPort(run, port);
      return recoveryItem(
        run,
        await update(
          db,
          run,
          `UPDATE ${table} SET state = 'released', last_http_status = NULL, updated_at_ms = ?
       ${WHERE_RUN} AND state = 'release_pending' AND permit_id = ? AND release_outcome = ? RETURNING *`,
          [
            integer(now()),
            ...runParams(run),
            entry.permitId,
            entry.releaseOutcome,
          ],
        ),
      );
    } catch {
      return { operationId: run.operationId, kind: 'held' };
    } finally {
      finishRecovery?.();
    }
  }

  const recoveryFlights = new WeakMap<
    LocalDb,
    Map<string, Promise<readonly RunJournalRecoveryItem[]>>
  >();

  function recover(
    db: LocalDb,
    owner: RunJournalScope,
    port: RunJournalPermitPort,
    options: RunJournalRecoveryOptions = {},
  ): Promise<readonly RunJournalRecoveryItem[]> {
    let scope: RunJournalScope;
    let excluded: string[];
    let operationId: string | null;
    const limit = options.limit ?? 20;
    const now = options.now ?? Date.now;
    try {
      requireRaw(db);
      scope = scopeSnapshot(owner);
      assertPort(scope, port);
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (options.excludeOperationIds?.length ?? 0) > 100
      ) {
        throw new RunJournalError('invalid_options');
      }
      operationId =
        options.operationId === undefined ? null : uuid(options.operationId);
      excluded = [
        ...new Set([
          ...(options.excludeOperationIds ?? []).map(uuid),
          ...activeOperationIds(scope),
        ]),
      ];
    } catch (error) {
      return Promise.reject(error);
    }
    let flights = recoveryFlights.get(db);
    if (!flights) {
      flights = new Map();
      recoveryFlights.set(db, flights);
    }
    const key = JSON.stringify([scope.ownerKey, scope.apiOrigin, operationId]);
    const previous = flights.get(key);
    if (previous) return previous;
    const operation = async (): Promise<readonly RunJournalRecoveryItem[]> => {
      const { rows } = await db.execute(
        `SELECT * FROM ${table}
       WHERE owner_key = ? AND api_origin = ? AND state IN ('reserve_pending','reserved','release_pending')
       ${operationId === null ? '' : 'AND operation_id = ?'}
       ${excluded.length ? `AND operation_id NOT IN (${excluded.map(() => '?').join(',')})` : ''}
       ORDER BY attempt_count ASC, created_at_ms ASC, operation_id ASC LIMIT ?`,
        [
          scope.ownerKey,
          scope.apiOrigin,
          ...(operationId === null ? [] : [operationId]),
          ...excluded,
          limit,
        ],
      );
      const items: RunJournalRecoveryItem[] = [];
      for (const row of rows) {
        const entry = decode(row);
        if (
          entry.ownerKey !== scope.ownerKey ||
          entry.apiOrigin !== scope.apiOrigin
        ) {
          throw new RunJournalError('scope_mismatch');
        }
        items.push(await recoverOne(db, entry, port, now));
      }
      return items;
    };
    const pending = operation();
    flights.set(key, pending);
    const clear = () => {
      flights.delete(key);
    };
    void pending.then(clear, clear);
    return pending;
  }

  return Object.freeze({
    scope: scopeSnapshot,
    startExecution,
    activeOperationIds,
    protectAnalysisAdmission,
    begin,
    reserved,
    reservationFailed,
    commit,
    requestRelease,
    recover,
    read,
    readCommitStatus,
  });
}

export const runJournal = createJournal('analysis_run_journal');
export const analysisAttemptJournal = createJournal(
  'analysis_execution_attempts',
);

/** Read-only compatibility for saved results/technique confirmations. An
 * ambiguous cross-version identity is held, never resolved by taking a row. */
export async function readAnalysisJournal(
  db: LocalDb,
  reference: RunJournalReference,
): Promise<RunJournalEntry | null> {
  const legacy = await runJournal.read(db, reference);
  const attempt = await analysisAttemptJournal.read(db, reference);
  if (legacy && attempt) throw new RunJournalError('identity_conflict');
  return legacy ?? attempt;
}

/** Storage versions reconcile independently. Failure reading one is UNKNOWN,
 * not an empty/successful recovery and not permission to replace its runs. */
export async function recoverAnalysisJournals(
  db: LocalDb,
  scope: RunJournalScope,
  port: RunJournalPermitPort,
  options: RunJournalRecoveryOptions = {},
): Promise<{
  items: readonly RunJournalRecoveryItem[];
  unknownStorage: boolean;
}> {
  const items: RunJournalRecoveryItem[] = [];
  let unknownStorage = false;
  for (const journal of [runJournal, analysisAttemptJournal]) {
    try {
      items.push(...(await journal.recover(db, scope, port, options)));
    } catch {
      unknownStorage = true;
    }
  }
  return { items, unknownStorage };
}
