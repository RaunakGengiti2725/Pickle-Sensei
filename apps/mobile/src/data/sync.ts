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

/**
 * Client-side verdict for a shot the server rejected with
 * `shot.session_not_found` while its practice set's own `session.create` row
 * had already spent its attempt budget: the server will never learn that
 * session, so the shot can never be accepted. It is recorded in `last_error`
 * (the row keeps its untouched attempt count — the shot itself was never at
 * fault), excludes the row from every later drain, and is reported as
 * `orphaned` by getShotOutboxStatus so the Result surface can say so.
 */
export const SESSION_ORPHANED_VERDICT = 'shot.session_orphaned';

export function isSessionOrphanedVerdict(lastError: string | null): boolean {
  return (
    lastError !== null && lastError.startsWith(`${SESSION_ORPHANED_VERDICT}:`)
  );
}

/** Rows read per SELECT while a drain walks the owner's backlog. */
const OUTBOX_PAGE_SIZE = 50;

type OutboxRow = Record<string, unknown>;

interface OutboxPass {
  /** SQL predicate on `kind`, mirrored by `accepts` for the JS partition. */
  kindSql: string;
  accepts(kind: string): boolean;
  /**
   * Rows at or beyond the attempt budget are normally invisible to a drain;
   * the session pass opts exhausted `session.create` rows back in so the shot
   * pass can recognise the sets that will never exist server-side.
   */
  includeExhaustedKind: string | null;
}

const SESSION_PASS: OutboxPass = {
  kindSql: `kind NOT IN ('shot.sync', 'evaluation.trial')`,
  accepts: kind => kind !== 'shot.sync' && kind !== 'evaluation.trial',
  includeExhaustedKind: 'session.create',
};
const SHOT_PASS: OutboxPass = {
  kindSql: `kind = 'shot.sync'`,
  accepts: kind => kind === 'shot.sync',
  includeExhaustedKind: null,
};
const TRIAL_PASS: OutboxPass = {
  kindSql: `kind = 'evaluation.trial'`,
  accepts: kind => kind === 'evaluation.trial',
  includeExhaustedKind: null,
};

/** One page of a pass's live rows, in id order, strictly after `cursor`. */
async function selectOutboxPage(
  db: LocalDb,
  owner: string,
  pass: OutboxPass,
  cursor: number,
): Promise<OutboxRow[]> {
  const budgetSql = pass.includeExhaustedKind
    ? `(attempts < ? OR kind = '${pass.includeExhaustedKind}')`
    : `attempts < ?`;
  const { rows } = await db.execute(
    `SELECT id, kind, payload, attempts, last_error FROM outbox
     WHERE owner_key = ? AND ${budgetSql} AND id > ?
       AND ${pass.kindSql}
       AND (last_error IS NULL OR last_error NOT LIKE ?)
     ORDER BY id ASC LIMIT ${OUTBOX_PAGE_SIZE}`,
    [owner, OUTBOX_MAX_ATTEMPTS, cursor, `${SESSION_ORPHANED_VERDICT}:%`],
  );
  return rows;
}

/**
 * Visits every live row of one pass in id order, a page per SELECT, until
 * the backlog is exhausted or `handlePage` asks to stop (a transport-level
 * failure: the network is down for the next page too). A drain therefore
 * reaches every row: a run of older rows that keep failing transiently
 * delays newer ones by at most a page and never hides them (the former
 * single `LIMIT 50` window let fifty stuck rows at the head of the queue
 * strand every later rating for good).
 */
async function forEachOutboxPage(
  db: LocalDb,
  owner: string,
  pass: OutboxPass,
  handlePage: (rows: OutboxRow[]) => Promise<boolean>,
  firstPage?: OutboxRow[],
): Promise<void> {
  let cursor = 0;
  let rows = firstPage ?? (await selectOutboxPage(db, owner, pass, cursor));
  for (;;) {
    const page = rows.filter(row => pass.accepts(String(row['kind'])));
    if (page.length > 0 && !(await handlePage(page))) return;
    const last = rows[rows.length - 1];
    const next = last ? Number(last['id']) : NaN;
    // The store hands back strictly increasing ids; a short page or one that
    // did not advance the cursor means there is nothing further to read.
    if (rows.length < OUTBOX_PAGE_SIZE || !(next > cursor)) return;
    cursor = next;
    rows = await selectOutboxPage(db, owner, pass, cursor);
  }
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
  let synced = 0;
  let failed = 0;

  // The drain's unit of work is fixed the moment it starts: the first page of
  // shots is read before anything else, so a rating saved while this drain is
  // already running is left for the next one instead of being pulled in
  // half-way through.
  const firstShotPage = await selectOutboxPage(db, owner, SHOT_PASS, 0);

  // Sessions FIRST, across the whole backlog: `apply_synced_shot` rejects a
  // shot whose sessionId the server has never seen ("shot.session_not_found"),
  // and a practice set's session.create row is queued right behind its first
  // shot. Session creation is idempotent server-side, so draining it ahead of
  // the shots costs nothing when it was already accepted.
  //
  // A session.create row that spent its budget names a set the server will
  // never know; its id is kept so the shot pass can settle that set's shots
  // instead of retrying them forever.
  const deadSessions = new Map<string, string>();
  await forEachOutboxPage(db, owner, SESSION_PASS, async rows => {
    let reachable = true;
    for (const r of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(r['payload'])) as Record<string, unknown>;
        if (
          r['kind'] !== 'session.create' &&
          r['kind'] !== 'session.finalize'
        ) {
          throw new Error(`unknown outbox kind ${String(r['kind'])}`);
        }
      } catch (error) {
        await recordRowFailure(db, owner, r['id'], error, true);
        failed++;
        continue;
      }
      if (Number(r['attempts']) >= OUTBOX_MAX_ATTEMPTS) {
        deadSessions.set(String(payload['id']), String(r['last_error'] ?? ''));
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
        const permanent = isPermanentSyncFailure(error);
        await recordRowFailure(db, owner, r['id'], error, permanent);
        failed++;
        if (!permanent) reachable = false;
        if (
          permanent &&
          r['kind'] === 'session.create' &&
          Number(r['attempts']) + 1 >= OUTBOX_MAX_ATTEMPTS
        ) {
          deadSessions.set(String(payload['id']), String(error));
        }
      }
    }
    return reachable;
  });

  const drainShotPage = async (shotRows: OutboxRow[]): Promise<boolean> => {
    // A row whose payload cannot become a sync request (corrupt JSON, missing
    // permit) fails alone and permanently; it never poisons the whole batch.
    const entries: Array<{
      row: OutboxRow;
      shotId: string;
      sessionId: string | null;
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
          sessionId:
            typeof analysis.sessionId === 'string' ? analysis.sessionId : null,
          payload: toSyncPayload(analysis, analysis.analysisPermitId),
        });
      } catch (error) {
        await recordRowFailure(db, owner, r['id'], error, true);
        failed++;
      }
    }
    if (entries.length === 0) return true;
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
        const deadSession =
          rejection?.code === SESSION_NOT_FOUND_REJECTION &&
          entry.sessionId !== null
            ? deadSessions.get(entry.sessionId)
            : undefined;
        if (rejection && deadSession !== undefined) {
          // Settled, not failed: nothing a later drain could do would make
          // the server accept this shot.
          await recordRowFailure(
            db,
            owner,
            entry.row['id'],
            `${SESSION_ORPHANED_VERDICT}: ${rejection.message} ` +
              `Its practice set was refused for good (${deadSession}).`,
            false,
          );
          continue;
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
      return permanent;
    }
    return true;
  };
  await forEachOutboxPage(db, owner, SHOT_PASS, drainShotPage, firstShotPage);

  if (transport.uploadEvaluationTrials) {
    const upload = transport.uploadEvaluationTrials.bind(transport);
    await forEachOutboxPage(db, owner, TRIAL_PASS, async trialRows => {
      const entries: Array<{
        row: OutboxRow;
        trial: { trialId: string };
      }> = [];
      for (const r of trialRows) {
        try {
          const trial = JSON.parse(String(r['payload'])) as {
            trialId: unknown;
          };
          if (typeof trial.trialId !== 'string') {
            throw new Error('evaluation.trial_missing_id');
          }
          entries.push({ row: r, trial: { ...trial, trialId: trial.trialId } });
        } catch (error) {
          await recordRowFailure(db, owner, r['id'], error, true);
          failed++;
        }
      }
      if (entries.length === 0) return true;
      try {
        const response = await upload(entries.map(entry => entry.trial));
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
        return permanent;
      }
      return true;
    });
  }

  const { rows: left } = await db.execute(
    `SELECT count(*) AS n FROM outbox WHERE owner_key = ?`,
    [owner],
  );
  return { synced, failed, remaining: Number(left[0]?.['n'] ?? 0) };
}
