import type { ShotAnalysis } from '@pickle/shared-types';
import { sha256Hex } from '@pickle/swing-domain';
import { originalCanonicalJson } from '../analysis/originalAnalysisSnapshot';
import type { LocalDb } from './db';
import {
  ApiError,
  parseShotSyncAcknowledgement,
  parseTrialSyncAcknowledgement,
} from './api';
import {
  assertDataOwnerContext,
  captureDataOwnerContext,
} from './accountScope';
import { forDataOwner, withTransaction } from './transactions';

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

/**
 * Millisecond offsets on the wire are WHOLE milliseconds: the server's
 * `isMs` check (`Number.isInteger`, `shot_phases`/`shots` are Postgres `int`
 * columns) refuses a fractional value with `shot.invalid_payload`, and the
 * phase segmenter cuts boundaries at fractions of a frame interval. A stored
 * analysis keeps its measured values; only the wire form is rounded. Anything
 * that is not a finite number (a legacy row's missing field) passes through
 * untouched for the server to judge — this shaper never invents a value.
 */
function wireMs<T>(value: T): T | number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : value;
}

function wireUnit<T>(value: T): T | number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
    timestamps: isRecord(analysis.timestamps)
      ? {
          ...analysis.timestamps,
          startMs: wireMs(analysis.timestamps.startMs),
          contactMs: wireMs(analysis.timestamps.contactMs),
          endMs: wireMs(analysis.timestamps.endMs),
        }
      : analysis.timestamps,
    overallScore: analysis.overallScore,
    confidence: wireUnit(analysis.analysisConfidence),
    resultKind: analysis.resultKind,
    source: analysis.source,
    phases: Array.isArray(analysis.phases)
      ? analysis.phases.map(p =>
          isRecord(p)
            ? {
                key: p.key,
                startMs: wireMs(p.startMs),
                representativeMs: wireMs(p.representativeMs),
                endMs: wireMs(p.endMs),
                confidence: wireUnit(p.confidence),
              }
            : p,
        )
      : analysis.phases,
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

const OFFLINE_OUTPUT_PERMIT_STAND_IN = 'offline-receipt';

/**
 * The output an offline consumption receipt pays for and later presents to
 * the server: this rating in the frozen `shot.sync` payload shape, without
 * any live-permit binding — exactly the object the server's sync ingress
 * parses and records. JSON-normalized so the digest taken when the grant is
 * spent equals the digest of the same rating re-read from the device later.
 */
export function toOfflineOutput(
  analysis: ShotAnalysis,
): Record<string, unknown> {
  const { analysisPermitId: _analysisPermitId, ...output } = toSyncPayload(
    analysis,
    OFFLINE_OUTPUT_PERMIT_STAND_IN,
  );
  return JSON.parse(JSON.stringify(output)) as Record<string, unknown>;
}

/** The digest an offline receipt commits to: `toOfflineOutput` canonicalized
 * the way every other original-analysis digest is. The same function serves
 * the spend, the replay identity check and the persistence guard, so the
 * three can never disagree about which output a receipt paid for. */
export function offlineOutputSha256(analysis: ShotAnalysis): string {
  return sha256Hex(originalCanonicalJson(toOfflineOutput(analysis)));
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

type OutboxRow = Record<string, unknown>;

function rowPayload(row: OutboxRow): Record<string, unknown> {
  const value: unknown = JSON.parse(String(row['payload']));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('sync.invalid_saved_payload');
  }
  return value as Record<string, unknown>;
}

async function requireRowRepair(
  db: LocalDb,
  owner: string,
  rowId: unknown,
  reason: string,
): Promise<void> {
  await db.execute(
    'UPDATE outbox SET repair_reason = ?, last_error = ? WHERE owner_key = ? AND id = ?',
    [reason, reason, owner, rowId],
  );
}

async function nextBatch(db: LocalDb, owner: string): Promise<OutboxRow[]> {
  return withTransaction(db, async transaction => {
    const { rows } = await transaction.execute(
      `SELECT id, kind, payload, attempts, repair_reason FROM outbox
       WHERE owner_key = ? AND attempts < ? AND repair_reason IS NULL
       ORDER BY last_attempt_order ASC, id ASC LIMIT 50`,
      [owner, OUTBOX_MAX_ATTEMPTS],
    );
    if (rows.length === 0) return rows;
    const { rows: clock } = await transaction.execute(
      'SELECT COALESCE(MAX(last_attempt_order), 0) + 1 AS ordinal FROM outbox WHERE owner_key = ?',
      [owner],
    );
    const ordinal = Number(clock[0]?.['ordinal']);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1)
      throw new Error('sync.invalid_schedule');
    for (const row of rows) {
      await transaction.execute(
        'UPDATE outbox SET last_attempt_order = ? WHERE owner_key = ? AND id = ?',
        [ordinal, owner, row['id']],
      );
    }
    return rows;
  });
}

async function queuedSession(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<OutboxRow | undefined> {
  const { rows } = await db.execute(
    `SELECT id, kind, payload, attempts, repair_reason FROM outbox
     WHERE owner_key = ? AND kind = 'session.create'
       AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ?
     ORDER BY id ASC LIMIT 1`,
    [owner, sessionId],
  );
  return rows[0];
}

/** Reconstruct only the two fields the server accepts, from the original owner. */
async function recoverSession(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<boolean> {
  return withTransaction(db, async transaction => {
    if (await queuedSession(transaction, owner, sessionId)) return true;
    const { rows } = await transaction.execute(
      'SELECT id, started_at FROM local_session WHERE owner_key = ? AND id = ? LIMIT 1',
      [owner, sessionId],
    );
    const row = rows[0];
    const startedAt = row?.['started_at'];
    if (
      row?.['id'] !== sessionId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        sessionId,
      ) ||
      typeof startedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(startedAt)
    )
      return false;
    const time = Date.parse(startedAt);
    if (
      !Number.isFinite(time) ||
      time < Date.UTC(2000, 0, 1) ||
      time >= Date.UTC(2100, 0, 1) ||
      new Date(time).toISOString().slice(0, 19) !== startedAt.slice(0, 19)
    )
      return false;
    await transaction.execute(
      "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', ?)",
      [owner, JSON.stringify({ id: sessionId, startedAt })],
    );
    return true;
  });
}

function savedShotPayload(row: OutboxRow): Record<string, unknown> {
  const saved = rowPayload(row);
  if (typeof saved.analysisPermitId !== 'string')
    throw new Error('shot.sync_missing_analysis_permit');
  return toSyncPayload(
    saved as unknown as ShotAnalysis,
    saved.analysisPermitId,
  );
}

function payloadJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (_key: string, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return value;
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

/** Conflicting duplicate identities must never be resolved by queue order.
 * Look outside the selected batch too, with a bounded read per identity. */
async function hasConflictingSavedPayload(
  db: LocalDb,
  owner: string,
  kind: 'shot.sync' | 'evaluation.trial',
  entityId: string,
  expected: Record<string, unknown>,
): Promise<boolean> {
  const idKey = kind === 'shot.sync' ? 'id' : 'trialId';
  const { rows } = await db.execute(
    `SELECT payload FROM outbox WHERE owner_key = ? AND kind = ?
     AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.${idKey}') END = ? LIMIT 51`,
    [owner, kind, entityId],
  );
  if (rows.length > 50) return true;
  const serialized = payloadJson(expected);
  return rows.some(row => {
    try {
      const payload =
        kind === 'shot.sync' ? savedShotPayload(row) : rowPayload(row);
      return payloadJson(payload) !== serialized;
    } catch {
      return true;
    }
  });
}

export async function drainOutbox(
  rawDb: LocalDb,
  transport: SyncTransport,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const context = captureDataOwnerContext();
  const db = forDataOwner(rawDb, context);
  const owner = context.ownerKey;
  const rows = await nextBatch(db, owner);
  let synced = 0;
  let failed = 0;

  const sessionRows = new Map(
    rows
      .filter(row => row['kind'] === 'session.create')
      .map(row => [row['id'], row]),
  );
  const checkedSessions = new Set<string>();
  for (const row of rows) {
    if (row['kind'] !== 'shot.sync' && row['kind'] !== 'session.finalize')
      continue;
    let payload: Record<string, unknown>;
    try {
      payload = rowPayload(row);
    } catch {
      // Invalid local payloads are classified once in the row processing pass.
      continue;
    }
    const sessionId =
      row['kind'] === 'shot.sync' ? payload.sessionId : payload.id;
    if (typeof sessionId !== 'string') continue;
    if (checkedSessions.has(sessionId)) continue;
    checkedSessions.add(sessionId);
    const parent = await queuedSession(db, owner, sessionId);
    if (parent) sessionRows.set(parent['id'], parent);
  }
  const blockedSessions = new Map<string, 'pending' | 'repair'>();

  // Sessions FIRST: `apply_synced_shot` rejects a shot whose sessionId the
  // server has never seen ("shot.session_not_found"), and a practice set's
  // session.create row is queued in the same batch as its first shot. Session
  // creation is idempotent server-side. Parents are looked up across the
  // entire owned queue, including beyond this batch's fifty-row boundary.
  for (const r of [
    ...sessionRows.values(),
    ...rows.filter(
      row =>
        row['kind'] !== 'session.create' &&
        row['kind'] !== 'shot.sync' &&
        row['kind'] !== 'evaluation.trial',
    ),
  ]) {
    let payload: Record<string, unknown>;
    try {
      assertDataOwnerContext(context);
      payload = rowPayload(r);
      if (r['kind'] !== 'session.create' && r['kind'] !== 'session.finalize') {
        throw new Error(`unknown outbox kind ${String(r['kind'])}`);
      }
    } catch (error) {
      await recordRowFailure(db, owner, r['id'], error, true);
      failed++;
      continue;
    }
    const sessionId = typeof payload.id === 'string' ? payload.id : null;
    if (
      r['kind'] === 'session.create' &&
      sessionId &&
      (r['repair_reason'] != null ||
        Number(r['attempts']) >= OUTBOX_MAX_ATTEMPTS)
    ) {
      blockedSessions.set(sessionId, 'repair');
      continue;
    }
    if (
      r['kind'] === 'session.finalize' &&
      sessionId &&
      blockedSessions.has(sessionId)
    ) {
      if (blockedSessions.get(sessionId) === 'repair')
        await requireRowRepair(db, owner, r['id'], 'session.parent_rejected');
      continue;
    }
    try {
      assertDataOwnerContext(context);
      if (r['kind'] === 'session.create')
        await transport.createSession(payload);
      else await transport.finalizeSession(String(payload['id']));
      await db.execute(`DELETE FROM outbox WHERE owner_key = ? AND id = ?`, [
        owner,
        r['id'],
      ]);
      synced++;
    } catch (error) {
      if (
        r['kind'] === 'session.finalize' &&
        sessionId &&
        error instanceof ApiError &&
        error.status === 404 &&
        error.code === 'session.not_found'
      ) {
        if (!(await recoverSession(db, owner, sessionId)))
          await requireRowRepair(db, owner, r['id'], 'session.missing');
        else
          await recordRowFailure(db, owner, r['id'], 'session.pending', false);
        failed++;
        continue;
      }
      if (r['kind'] === 'session.create' && sessionId) {
        const permanent = isPermanentSyncFailure(error);
        blockedSessions.set(sessionId, permanent ? 'repair' : 'pending');
        if (permanent)
          await requireRowRepair(db, owner, r['id'], 'session.rejected');
      }
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
  const shotPayloads = new Map<string, Record<string, unknown>>();
  const conflictingShots = new Set<string>();
  for (const r of shotRows) {
    try {
      const analysis = JSON.parse(String(r['payload'])) as ShotAnalysis & {
        analysisPermitId?: unknown;
      };
      if (typeof analysis.analysisPermitId !== 'string') {
        throw new Error('shot.sync_missing_analysis_permit');
      }
      if (analysis.sessionId && blockedSessions.has(analysis.sessionId)) {
        if (blockedSessions.get(analysis.sessionId) === 'repair') {
          await requireRowRepair(db, owner, r['id'], 'session.parent_rejected');
        } else {
          await recordRowFailure(db, owner, r['id'], 'session.pending', false);
        }
        failed++;
        continue;
      }
      const payload = savedShotPayload(r);
      if (
        typeof analysis.id !== 'string' ||
        !analysis.id.trim() ||
        analysis.id.length > 128
      )
        throw new Error('shot.sync_invalid_id');
      if (
        !shotPayloads.has(analysis.id) &&
        !conflictingShots.has(analysis.id)
      ) {
        if (
          await hasConflictingSavedPayload(
            db,
            owner,
            'shot.sync',
            analysis.id,
            payload,
          )
        )
          conflictingShots.add(analysis.id);
        else shotPayloads.set(analysis.id, payload);
      }
      if (conflictingShots.has(analysis.id)) {
        await requireRowRepair(db, owner, r['id'], 'shot.conflicting_saved_id');
        failed++;
        continue;
      }
      entries.push({
        row: r,
        shotId: analysis.id,
        payload,
      });
    } catch (error) {
      await recordRowFailure(db, owner, r['id'], error, true);
      failed++;
    }
  }
  if (entries.length > 0) {
    try {
      assertDataOwnerContext(context);
      const response = parseShotSyncAcknowledgement(
        await transport.syncShots([...shotPayloads.values()]),
        [...shotPayloads.keys()],
      );
      const accepted = new Set(response.acceptedIds);
      const rejected = new Map(
        response.rejected.map(item => [item.id, item] as const),
      );
      for (const entry of entries) {
        if (accepted.has(entry.shotId)) {
          // Preserve the receipt/delete failure.
          await withTransaction(db, async db => {
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
        if (
          rejection?.code === SESSION_NOT_FOUND_REJECTION &&
          typeof entry.payload.sessionId === 'string'
        ) {
          if (!(await recoverSession(db, owner, entry.payload.sessionId))) {
            await requireRowRepair(
              db,
              owner,
              entry.row['id'],
              'session.missing',
            );
            failed++;
            continue;
          }
        }
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
    const trialPayloads = new Map<string, Record<string, unknown>>();
    const conflictingTrials = new Set<string>();
    const entries: Array<{
      row: (typeof trialRows)[number];
      trial: { trialId: string };
    }> = [];
    for (const r of trialRows) {
      try {
        const trial = JSON.parse(String(r['payload'])) as { trialId: unknown };
        if (
          typeof trial.trialId !== 'string' ||
          !trial.trialId.trim() ||
          trial.trialId.length > 128
        ) {
          throw new Error('evaluation.trial_missing_id');
        }
        const payload = { ...trial, trialId: trial.trialId };
        if (
          !trialPayloads.has(trial.trialId) &&
          !conflictingTrials.has(trial.trialId)
        ) {
          if (
            await hasConflictingSavedPayload(
              db,
              owner,
              'evaluation.trial',
              trial.trialId,
              payload,
            )
          )
            conflictingTrials.add(trial.trialId);
          else trialPayloads.set(trial.trialId, payload);
        }
        if (conflictingTrials.has(trial.trialId)) {
          await requireRowRepair(
            db,
            owner,
            r['id'],
            'evaluation.conflicting_saved_id',
          );
          failed++;
          continue;
        }
        entries.push({ row: r, trial: { ...trial, trialId: trial.trialId } });
      } catch (error) {
        await recordRowFailure(db, owner, r['id'], error, true);
        failed++;
      }
    }
    try {
      assertDataOwnerContext(context);
      const response = parseTrialSyncAcknowledgement(
        entries.length > 0
          ? await transport.uploadEvaluationTrials([...trialPayloads.values()])
          : { acceptedTrialIds: [], rejected: [] },
        [...trialPayloads.keys()],
      );
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
