import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from './db';
import { ApiError } from './api';
import { getActiveDataOwner } from './accountScope';

/**
 * Outbox sync engine (directive §32): durable queue drained on reconnect.
 * Client-generated UUIDs + server-side idempotent upserts guarantee that
 * reconnection never duplicates records. Pure over LocalDb + fetch for tests.
 */

export interface SyncTransport {
  syncShots(shots: unknown[]): Promise<{
    acceptedIds: string[];
    rejected: Array<{ id: string; code: string; message: string }>;
  }>;
  createSession(session: unknown): Promise<void>;
  finalizeSession(id: string): Promise<void>;
  /**
   * Consent-gated evaluation-trial upload (POST /v1/me/evaluation/trials).
   * Optional: a transport without it leaves 'evaluation.trial' rows queued
   * (no attempts burned) rather than dropping evidence.
   */
  uploadEvaluationTrials?(trials: unknown[]): Promise<{
    acceptedTrialIds: string[];
    rejected: Array<{ trialId: string; code: string; message: string }>;
  }>;
}

/** Convert a persisted ShotAnalysis into the canonical sync payload (spec p. 21). */
export function toSyncPayload(
  analysis: ShotAnalysis,
  analysisPermitId: string,
): Record<string, unknown> {
  if (!analysisPermitId.trim()) {
    throw new Error('shot.sync_missing_analysis_permit');
  }
  return {
    id: analysis.id,
    analysisPermitId,
    sessionId: analysis.sessionId,
    shotType: analysis.shotType,
    cameraView: analysis.cameraView,
    capturedAt: analysis.capturedAtIso,
    timestamps: analysis.timestamps,
    overallScore: analysis.overallScore,
    confidence: analysis.analysisConfidence,
    resultKind: analysis.resultKind,
    source: analysis.source,
    phases: analysis.phases,
    checkpoints: analysis.checkpoints.map(c => ({
      key: c.key,
      score: c.score,
      confidence: c.confidence,
      band: c.band,
      direction: c.direction,
      severity: c.severity,
      applicable: c.applicable,
    })),
    versionVector: analysis.versionVector,
  };
}

/**
 * A SQLite transaction belongs to the CONNECTION, not to the caller that
 * opened it: while one `BEGIN IMMEDIATE` is open on the app's single
 * connection (db.ts `getDb()`), a second one fails with "cannot start a
 * transaction within a transaction" and the loser's ROLLBACK tears down the
 * winner's work. The connection therefore has exactly ONE transaction slot,
 * modelled below as a lease: a caller holds it from its BEGIN to its
 * COMMIT/ROLLBACK, and on release ownership is handed directly to the
 * longest-waiting caller (no idle gap another BEGIN could slip into).
 * Non-transactional statements are never held up. Inside a transaction the
 * caller receives a scoped handle; `withLocalTransaction` on that handle
 * joins the open transaction instead of nesting a second BEGIN.
 */
let transactionSlotHeld = false;
const transactionSlotWaiters: Array<() => void> = [];
const transactionScopes = new WeakSet<LocalDb>();

async function acquireTransactionSlot(): Promise<void> {
  if (!transactionSlotHeld) {
    transactionSlotHeld = true;
    return;
  }
  await new Promise<void>(handOver => transactionSlotWaiters.push(handOver));
}

function releaseTransactionSlot(): void {
  const next = transactionSlotWaiters.shift();
  if (next) {
    next();
  } else {
    transactionSlotHeld = false;
  }
}

async function runTransaction<T>(
  db: LocalDb,
  operation: (tx: LocalDb) => Promise<T>,
): Promise<T> {
  const tx: LocalDb = {
    execute: (sql, params) => db.execute(sql, params),
    close: () => db.close(),
  };
  transactionScopes.add(tx);
  await db.execute('BEGIN IMMEDIATE');
  try {
    const result = await operation(tx);
    await db.execute('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.execute('ROLLBACK');
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}

/**
 * Runs `operation` inside `BEGIN IMMEDIATE … COMMIT` (ROLLBACK on failure)
 * while holding the connection's transaction slot, so two transactions can
 * never overlap on the shared connection. Every transaction in the data layer
 * goes through here; statements inside `operation` must use the scoped `tx`.
 */
export async function withLocalTransaction<T>(
  db: LocalDb,
  operation: (tx: LocalDb) => Promise<T>,
): Promise<T> {
  if (transactionScopes.has(db)) return operation(db);
  await acquireTransactionSlot();
  try {
    return await runTransaction(db, operation);
  } finally {
    releaseTransactionSlot();
  }
}

/** Bounded attempt budget for permanent failures; transient failures never
 * consume it (see isPermanentSyncFailure). */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Rows offered per kind per drain. Each kind gets its own window so a
 * backlog of one kind can never hide the others. */
const OUTBOX_WINDOW = 50;

/** Server rejection code for a shot whose sessionId is not (yet) known —
 * mirrors `apply_synced_shot` / supabase/functions/api "shot.session_not_found". */
export const SESSION_NOT_FOUND_REJECTION = 'shot.session_not_found';

/**
 * Only failures that can never succeed on retry consume the bounded attempt
 * budget. Everything else — device offline, timeouts, server 5xx, an expired
 * bearer that a fresh sign-in will replace — is transient: the row records
 * the error and stays fully retryable, because a durable local rating must
 * never be silently dropped from sync by a stretch of bad connectivity.
 */
export function isPermanentSyncFailure(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 401 &&
      error.status !== 408 &&
      error.status !== 429
    );
  }
  return false;
}

/**
 * Per-item rejections the server itself labels as retryable (its own write
 * failed, or the bearer must be refreshed), plus the ordering artifact of a
 * shot whose practice-set session has not reached the server yet (the
 * session.create row drains ahead of it on the next pass — it was queued
 * moments after the shot). They record the reason but keep the row's attempt
 * budget intact, matching how a whole-request 5xx is treated; every other
 * rejection code is a contract verdict that will not change on replay.
 */
export const TRANSIENT_SYNC_REJECTION_CODES: ReadonlySet<string> = new Set([
  'shot.write_failed',
  'evaluation.trial_write_failed',
  'auth.required',
  SESSION_NOT_FOUND_REJECTION,
]);

export function isTransientSyncRejection(code: string): boolean {
  return TRANSIENT_SYNC_REJECTION_CODES.has(code);
}

async function recordRowFailure(
  db: LocalDb,
  owner: string,
  rowId: unknown,
  error: unknown,
  permanent: boolean,
): Promise<void> {
  if (permanent) {
    await db.execute(
      `UPDATE outbox SET attempts = attempts + 1, last_error = ?
       WHERE owner_key = ? AND id = ?`,
      [String(error), owner, rowId],
    );
  } else {
    await db.execute(
      `UPDATE outbox SET last_error = ?
       WHERE owner_key = ? AND id = ?`,
      [String(error), owner, rowId],
    );
  }
}

/**
 * The rows one drain works from, read in ONE statement so the whole drain sees
 * a single consistent view of the outbox (a row queued while the drain runs
 * belongs to the next one). Every kind gets its own window of the
 * `OUTBOX_WINDOW` oldest eligible rows — `row_number()` per kind group
 * instead of one `ORDER BY id LIMIT 50`, which let 50 stuck shots starve
 * every newer session, shot and evaluation trial for good.
 *
 * A shot is sendable only once its practice set exists server-side: while its
 * `session.create` row is queued the server can only answer
 * session_not_found, and once that row is exhausted the shot can never be
 * accepted at all. Shots whose parent has already been refused
 * (`attempts > 0`) are therefore excluded — they are reported through the
 * parent's state (repository.getShotOutboxStatus) instead of holding a window
 * slot forever — and the rest carry `pending_session_id` so the drain can
 * offer them as soon as it creates that session itself. `json_extract` runs
 * only behind `json_valid`, so one malformed row cannot fail the read.
 */
const OUTBOX_WINDOW_SQL = `SELECT id, kind, payload, attempts, pending_session_id
  FROM (
    SELECT id, kind, payload, attempts,
      (SELECT CASE WHEN json_valid(parent.payload)
                   THEN json_extract(parent.payload, '$.id') END
         FROM outbox parent
        WHERE parent.owner_key = outbox.owner_key
          AND parent.kind = 'session.create'
          AND CASE WHEN json_valid(parent.payload)
                   THEN json_extract(parent.payload, '$.id') END
            = CASE WHEN json_valid(outbox.payload)
                   THEN json_extract(outbox.payload, '$.sessionId') END
        ORDER BY parent.id DESC LIMIT 1) AS pending_session_id,
      row_number() OVER (
        PARTITION BY CASE WHEN kind IN ('shot.sync', 'evaluation.trial')
                          THEN kind ELSE 'session' END
        ORDER BY id ASC) AS kind_rank
      FROM outbox
     WHERE owner_key = ? AND attempts < ?
       AND (kind <> 'shot.sync' OR NOT EXISTS (
         SELECT 1 FROM outbox parent
          WHERE parent.owner_key = outbox.owner_key
            AND parent.kind = 'session.create'
            AND parent.attempts > 0
            AND CASE WHEN json_valid(parent.payload)
                     THEN json_extract(parent.payload, '$.id') END
              = CASE WHEN json_valid(outbox.payload)
                     THEN json_extract(outbox.payload, '$.sessionId') END))
  )
 WHERE kind_rank <= ${OUTBOX_WINDOW}
 ORDER BY id ASC`;

export async function drainOutbox(
  db: LocalDb,
  transport: SyncTransport,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(OUTBOX_WINDOW_SQL, [
    owner,
    OUTBOX_MAX_ATTEMPTS,
  ]);
  let synced = 0;
  let failed = 0;
  const createdSessionIds = new Set<string>();

  // Sessions FIRST: `apply_synced_shot` rejects a shot whose sessionId the
  // server has never seen ("shot.session_not_found"), and a practice set's
  // session.create row is queued in the same batch as its first shot. Session
  // creation is idempotent server-side, so draining it ahead of the shots
  // costs nothing when it was already accepted.
  for (const r of rows.filter(
    row => row['kind'] !== 'shot.sync' && row['kind'] !== 'evaluation.trial',
  )) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(String(r['payload'])) as Record<string, unknown>;
      if (r['kind'] !== 'session.create' && r['kind'] !== 'session.finalize') {
        throw new Error(`unknown outbox kind ${String(r['kind'])}`);
      }
    } catch (error) {
      await recordRowFailure(db, owner, r['id'], error, true);
      failed++;
      continue;
    }
    try {
      if (r['kind'] === 'session.create') {
        await transport.createSession(payload);
        createdSessionIds.add(String(payload['id']));
      } else await transport.finalizeSession(String(payload['id']));
      await db.execute(`DELETE FROM outbox WHERE owner_key = ? AND id = ?`, [
        owner,
        r['id'],
      ]);
      synced++;
    } catch (error) {
      await recordRowFailure(
        db,
        owner,
        r['id'],
        error,
        isPermanentSyncFailure(error),
      );
      failed++;
    }
  }

  // A shot whose session.create row was still queued when the window was read
  // is offered only if this drain just created that session.
  const shotRows = rows.filter(
    r =>
      r['kind'] === 'shot.sync' &&
      (r['pending_session_id'] == null ||
        createdSessionIds.has(String(r['pending_session_id']))),
  );
  // A row whose payload cannot become a sync request (corrupt JSON, missing
  // permit) fails alone and permanently; it never poisons the whole batch.
  const entries: Array<{
    row: (typeof shotRows)[number];
    shotId: string;
    payload: Record<string, unknown>;
  }> = [];
  for (const r of shotRows) {
    try {
      const analysis = JSON.parse(String(r['payload'])) as ShotAnalysis & {
        analysisPermitId?: unknown;
      };
      if (typeof analysis.analysisPermitId !== 'string') {
        throw new Error('shot.sync_missing_analysis_permit');
      }
      entries.push({
        row: r,
        shotId: analysis.id,
        payload: toSyncPayload(analysis, analysis.analysisPermitId),
      });
    } catch (error) {
      await recordRowFailure(db, owner, r['id'], error, true);
      failed++;
    }
  }
  if (entries.length > 0) {
    try {
      const response = await transport.syncShots(
        entries.map(entry => entry.payload),
      );
      const accepted = new Set(response.acceptedIds);
      const rejected = new Map(
        response.rejected.map(item => [item.id, item] as const),
      );
      for (const entry of entries) {
        if (accepted.has(entry.shotId)) {
          await withLocalTransaction(db, async tx => {
            await tx.execute(
              `INSERT OR REPLACE INTO sync_receipt
               (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
              [owner, entry.shotId],
            );
            await tx.execute(
              `DELETE FROM outbox WHERE owner_key = ? AND id = ?`,
              [owner, entry.row['id']],
            );
          });
          synced++;
          continue;
        }
        const rejection = rejected.get(entry.shotId);
        await recordRowFailure(
          db,
          owner,
          entry.row['id'],
          rejection
            ? `${rejection.code}: ${rejection.message}`
            : 'shot.sync_unacknowledged',
          !rejection || !isTransientSyncRejection(rejection.code),
        );
        failed++;
      }
    } catch (error) {
      const permanent = isPermanentSyncFailure(error);
      for (const entry of entries) {
        await recordRowFailure(db, owner, entry.row['id'], error, permanent);
        failed++;
      }
    }
  }

  const trialRows = rows.filter(r => r['kind'] === 'evaluation.trial');
  if (trialRows.length > 0 && transport.uploadEvaluationTrials) {
    const entries: Array<{
      row: (typeof trialRows)[number];
      trial: { trialId: string };
    }> = [];
    for (const r of trialRows) {
      try {
        const trial = JSON.parse(String(r['payload'])) as { trialId: unknown };
        if (typeof trial.trialId !== 'string') {
          throw new Error('evaluation.trial_missing_id');
        }
        entries.push({ row: r, trial: { ...trial, trialId: trial.trialId } });
      } catch (error) {
        await recordRowFailure(db, owner, r['id'], error, true);
        failed++;
      }
    }
    try {
      const response =
        entries.length > 0
          ? await transport.uploadEvaluationTrials(
              entries.map(entry => entry.trial),
            )
          : { acceptedTrialIds: [], rejected: [] };
      const accepted = new Set(response.acceptedTrialIds);
      const rejected = new Map(
        response.rejected.map(item => [item.trialId, item] as const),
      );
      for (const entry of entries) {
        if (accepted.has(entry.trial.trialId)) {
          await db.execute(
            `DELETE FROM outbox WHERE owner_key = ? AND id = ?`,
            [owner, entry.row['id']],
          );
          synced++;
          continue;
        }
        const rejection = rejected.get(entry.trial.trialId);
        await recordRowFailure(
          db,
          owner,
          entry.row['id'],
          rejection
            ? `${rejection.code}: ${rejection.message}`
            : 'evaluation.trial_unacknowledged',
          !rejection || !isTransientSyncRejection(rejection.code),
        );
        failed++;
      }
    } catch (error) {
      const permanent = isPermanentSyncFailure(error);
      for (const entry of entries) {
        await recordRowFailure(db, owner, entry.row['id'], error, permanent);
        failed++;
      }
    }
  }

  const { rows: left } = await db.execute(
    `SELECT count(*) AS n FROM outbox WHERE owner_key = ?`,
    [owner],
  );
  return { synced, failed, remaining: Number(left[0]?.['n'] ?? 0) };
}
