import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from './db';
import { runInTransaction } from './transaction';
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

/** Bounded attempt budget for permanent failures; transient failures never
 * consume it (see isPermanentSyncFailure). */
export const OUTBOX_MAX_ATTEMPTS = 8;

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

export async function drainOutbox(
  db: LocalDb,
  transport: SyncTransport,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const owner = getActiveDataOwner();
  const { rows } = await db.execute(
    `SELECT id, kind, payload, attempts FROM outbox
     WHERE owner_key = ? AND attempts < ? ORDER BY id ASC LIMIT 50`,
    [owner, OUTBOX_MAX_ATTEMPTS],
  );
  let synced = 0;
  let failed = 0;

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
      if (r['kind'] === 'session.create')
        await transport.createSession(payload);
      else await transport.finalizeSession(String(payload['id']));
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

  const shotRows = rows.filter(r => r['kind'] === 'shot.sync');
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
          await runInTransaction(db, async () => {
            await db.execute(
              `INSERT OR REPLACE INTO sync_receipt
               (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
              [owner, entry.shotId],
            );
            await db.execute(
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
