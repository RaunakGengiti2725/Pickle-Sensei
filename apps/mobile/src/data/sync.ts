import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from './db';
import { connectionLease, type ConnectionLease } from './transaction';
import { ApiError } from './api';
import { getActiveDataOwner, ownerPurgeGeneration } from './accountScope';

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
 * Client-side PARKED verdict for a shot the server rejected with
 * `shot.session_not_found` when nothing queued locally can still make its
 * practice set known: the set's own `session.create` row spent its attempt
 * budget, or no session row exists on this device and the shot's own bounded
 * retry ran out. The verdict lives in `last_error`; a parked row is skipped
 * by every drain (not offered, not counted as failed) and is reported as
 * `orphaned` by getShotOutboxStatus so the Result surface can say the read
 * is paused.
 *
 * It is NOT terminal. The server (`apply_synced_shot`) accepts the shot the
 * moment the owner's session row exists and `POST /v1/sessions` is an
 * idempotent upsert, so the marker is cleared — in the same transaction that
 * retires the `session.create` row — whenever a session.create for that id
 * is accepted, and the shot is offered again in that very drain.
 */
export const SESSION_ORPHANED_VERDICT = 'shot.session_orphaned';

export function isSessionOrphanedVerdict(lastError: string | null): boolean {
  return (
    lastError !== null && lastError.startsWith(`${SESSION_ORPHANED_VERDICT}:`)
  );
}

/**
 * Hard bound on the AUTOMATIC re-arms of one practice set (per owner) between
 * two scored shots joining it, kept in `local_session.rearms` (never in
 * memory) and reset to 0 by the next saved shot of the set. An automatic
 * re-arm is any occasion on which a drain asks the server for a set again
 * without a new read having joined it:
 *
 *  - a shot's `shot.session_not_found` verdict re-queues the set from the
 *    device's `local_session` row (settleSessionNotFound, path 3);
 *  - a parked shot whose set no queue entry names any more re-queues the set
 *    from that row at the start of a drain;
 *  - an exhausted `session.create` whose refusals THIS build witnessed
 *    (`refusals >= OUTBOX_MAX_ATTEMPTS`) and that still has a parked shot is
 *    revived for ONE more offer at the start of a drain.
 *
 * Worst case per set without a new shot: the initial row's
 * OUTBOX_MAX_ATTEMPTS offers plus SESSION_CREATE_REARM_BOUND re-arms of at
 * most OUTBOX_MAX_ATTEMPTS offers each (a re-queue) or one offer each (a
 * revival) — createSession is called at most
 * `OUTBOX_MAX_ATTEMPTS * (1 + SESSION_CREATE_REARM_BOUND)` = 24 times. The
 * accept + `shot.session_not_found` pathology (the server upserts the set but
 * never applies its shot) costs exactly `1 + SESSION_CREATE_REARM_BOUND` = 3
 * createSession and 3 syncShots calls, after which the set is PAUSED
 * (`rearms` = SESSION_CREATE_REARM_BOUND + 1, written by settleSessionNotFound
 * when the server disowns a shot after the last re-arm): its shots are not
 * offered (SHOT_SET_PAUSED_SQL) until a new read joins the set, which resets
 * the budget and costs at most SESSION_CREATE_REARM_BOUND more createSession
 * and `1 + SESSION_CREATE_REARM_BOUND` more syncShots calls. A shot's
 * lifetime `refusals` grows by one per server refusal whether or not the
 * refusal spends its retry budget (getShotOutboxStatus reports it), so the
 * Result copy never understates; a `shot.session_not_found` that merely parks
 * the read behind its refused set is the set's verdict and is not counted.
 */
export const SESSION_CREATE_REARM_BOUND = 2;

/** Rows read per SELECT while a drain walks the owner's backlog. */
const OUTBOX_PAGE_SIZE = 50;

type OutboxRow = Record<string, unknown>;

interface OutboxPass {
  /** SQL predicate on `kind`, mirrored by `accepts` for the JS partition. */
  kindSql: string;
  accepts(kind: string): boolean;
  /** Further SQL predicate (starting with AND) on the rows a drain may offer;
   * each of its `?` binds the owner key. */
  offerSql: string;
}

/** `$.id` of a `session.create` payload in `alias`; NULL when the payload is
 * corrupt, so one bad row can never fail a lookup (C1). */
function sessionCreateIdSql(alias: string): string {
  return `CASE WHEN json_valid(${alias}.payload)
               THEN json_extract(${alias}.payload, '$.id') END`;
}

/** `$.sessionId` of a `shot.sync` payload in `alias`, guarded the same way. */
function shotSessionIdSql(alias: string): string {
  return `CASE WHEN json_valid(${alias}.payload)
               THEN json_extract(${alias}.payload, '$.sessionId') END`;
}

/**
 * True for a `shot.sync` row of the outer `outbox` whose practice set still
 * has a LIVE `session.create` row (attempt budget left) in the same owner's
 * queue. Such a shot is not offered: the server would answer
 * `shot.session_not_found` for a purely local ordering artifact — the set is
 * created by a session pass first — and neither that offer nor the charge it
 * would carry is warranted. Decided in SQL against the committed queue, so
 * it holds for every page of a backlog, not only the sets a pass visited.
 * The set of live session ids is an uncorrelated subquery (materialized once
 * per page SELECT, not once per candidate row) that drops NULL ids: a corrupt
 * `session.create` payload names no set and must not hide every shot behind
 * `NOT IN (…, NULL)`.
 */
const SHOT_SET_STILL_QUEUED_SQL = `(
         ${shotSessionIdSql('outbox')} IS NOT NULL
         AND ${shotSessionIdSql('outbox')} IN (
           SELECT ${sessionCreateIdSql('s')} FROM outbox s
           WHERE s.owner_key = ? AND s.kind = 'session.create'
             AND s.attempts < ${OUTBOX_MAX_ATTEMPTS}
             AND ${sessionCreateIdSql('s')} IS NOT NULL))`;

/**
 * True for a `shot.sync` row whose practice set is PAUSED (`rearms` past
 * SESSION_CREATE_REARM_BOUND, set by settleSessionNotFound when the server
 * disowned a shot after the set's last automatic re-arm): the server keeps
 * answering `shot.session_not_found` for a set it accepts. Its shots wait,
 * unoffered and uncharged, for the next read that joins the set (saveAnalysis
 * resets the budget) — never a retry loop.
 */
const SHOT_SET_PAUSED_SQL = `(
         ${shotSessionIdSql('outbox')} IS NOT NULL
         AND ${shotSessionIdSql('outbox')} IN (
           SELECT ls.id FROM local_session ls
           WHERE ls.owner_key = ? AND ls.rearms > ${SESSION_CREATE_REARM_BOUND}))`;

const SESSION_PASS: OutboxPass = {
  kindSql: `kind NOT IN ('shot.sync', 'evaluation.trial')`,
  accepts: kind => kind !== 'shot.sync' && kind !== 'evaluation.trial',
  offerSql: '',
};
const SHOT_PASS: OutboxPass = {
  kindSql: `kind = 'shot.sync'`,
  accepts: kind => kind === 'shot.sync',
  offerSql: `AND NOT ${SHOT_SET_STILL_QUEUED_SQL} AND NOT ${SHOT_SET_PAUSED_SQL}`,
};
const TRIAL_PASS: OutboxPass = {
  kindSql: `kind = 'evaluation.trial'`,
  accepts: kind => kind === 'evaluation.trial',
  offerSql: '',
};

/** One page of a pass's rows with attempt budget left, in id order, strictly
 * after `cursor`. Every pass — the session pass included — reads only rows
 * under budget: an exhausted row is never re-read, so it can never be charged
 * again or make a drain report a failure. */
async function selectOutboxPage(
  db: LocalDb,
  owner: string,
  pass: OutboxPass,
  cursor: number,
): Promise<OutboxRow[]> {
  const ownerBindings = pass.offerSql.split('?').length - 1;
  const { rows } = await db.execute(
    `SELECT id, kind, payload, attempts, last_error FROM outbox
     WHERE owner_key = ? AND attempts < ? AND id > ?
       AND ${pass.kindSql} ${pass.offerSql}
     ORDER BY id ASC LIMIT ${OUTBOX_PAGE_SIZE}`,
    [
      owner,
      OUTBOX_MAX_ATTEMPTS,
      cursor,
      ...Array.from({ length: ownerBindings }, () => owner),
    ],
  );
  return rows;
}

/** The predicate that picks the `session.create` rows naming `sessionId`;
 * guarded per row so one corrupt payload cannot fail the lookup (C1). */
const SESSION_CREATE_FOR_ID_SQL = `kind = 'session.create'
       AND CASE WHEN json_valid(payload)
                THEN json_extract(payload, '$.id') END = ?`;

/**
 * True while a `session.create` row for `sessionId` still has attempt budget
 * — the set will be (re)offered to the server by a later session pass, so
 * neither a second queue entry nor a shot-side attempt is warranted.
 */
export async function hasLiveSessionCreate(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<boolean> {
  const { rows } = await db.execute(
    `SELECT 1 FROM outbox
     WHERE owner_key = ? AND attempts < ? AND ${SESSION_CREATE_FOR_ID_SQL}
     LIMIT 1`,
    [owner, OUTBOX_MAX_ATTEMPTS, sessionId],
  );
  return rows.length > 0;
}

/**
 * The `last_error` of the newest EXHAUSTED `session.create` row naming
 * `sessionId` — the verdict the server gave the set — or null when no such
 * row exists. Read per shot at offer time, so a set's death is decided by
 * the committed queue, never by which rows this drain's session pass
 * happened to visit.
 */
async function exhaustedSessionCreateVerdict(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<string | null> {
  const { rows } = await db.execute(
    `SELECT last_error FROM outbox
     WHERE owner_key = ? AND attempts >= ? AND ${SESSION_CREATE_FOR_ID_SQL}
     ORDER BY id DESC LIMIT 1`,
    [owner, OUTBOX_MAX_ATTEMPTS, sessionId],
  );
  if (rows.length === 0) return null;
  const verdict = rows[0]?.['last_error'];
  return typeof verdict === 'string' ? verdict : '';
}

export interface LocalSessionRow {
  id: string;
  mode: string;
  shotType: string | null;
  focusCheckpoint: string | null;
  startedAt: string;
}

/**
 * Queues `session.create` for `session` unless a row for that id is already
 * waiting with attempt budget: the server upsert is idempotent, so one
 * pending entry per set is all a drain needs. Check and insert are ONE
 * statement, so two writers racing for the same set (a save and a drain, two
 * drains) can never leave two live rows behind. Runs inside the caller's
 * transaction or connection lease.
 */
export async function enqueueLiveSessionCreate(
  db: LocalDb,
  owner: string,
  session: LocalSessionRow,
): Promise<void> {
  await db.execute(
    `INSERT INTO outbox (owner_key, kind, payload)
     SELECT ?, 'session.create', ?
     WHERE NOT EXISTS (
       SELECT 1 FROM outbox
       WHERE owner_key = ? AND attempts < ? AND ${SESSION_CREATE_FOR_ID_SQL})`,
    [owner, JSON.stringify(session), owner, OUTBOX_MAX_ATTEMPTS, session.id],
  );
}

/**
 * Queues `session.create` for `sessionId` from the device's own
 * `local_session` row (the capture flow was interrupted between a shot and
 * its set, or a purge of exhausted rows left the set without a queue entry).
 * Same single-statement guard as `enqueueLiveSessionCreate`; a no-op when no
 * local row exists or a live queue entry already names the set.
 */
async function enqueueLiveSessionCreateFromLocal(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO outbox (owner_key, kind, payload)
     SELECT ls.owner_key, 'session.create',
            json_object('id', ls.id, 'mode', ls.mode, 'shotType', ls.shot_type,
                        'focusCheckpoint', ls.focus_checkpoint,
                        'startedAt', ls.started_at)
     FROM local_session ls
     WHERE ls.owner_key = ? AND ls.id = ?
       AND NOT EXISTS (
         SELECT 1 FROM outbox s
         WHERE s.owner_key = ls.owner_key AND s.kind = 'session.create'
           AND s.attempts < ? AND ${sessionCreateIdSql('s')} = ls.id)`,
    [owner, sessionId, OUTBOX_MAX_ATTEMPTS],
  );
}

/** The set's automatic re-arm budget, or null when the device has no
 * `local_session` row for it (then nothing can track a bound and no
 * automatic re-arm happens). Runs inside the caller's transaction. */
async function sessionRearms(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<number | null> {
  const { rows } = await db.execute(
    `SELECT rearms FROM local_session WHERE owner_key = ? AND id = ?`,
    [owner, sessionId],
  );
  if (rows.length === 0) return null;
  return Number(rows[0]?.['rearms'] ?? 0);
}

/** Spends one automatic re-arm of the set. Runs inside the caller's
 * transaction, after the re-arm itself. */
async function chargeSessionRearm(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<void> {
  await db.execute(
    `UPDATE local_session SET rearms = rearms + 1
     WHERE owner_key = ? AND id = ?`,
    [owner, sessionId],
  );
}

/** Pauses the set (SHOT_SET_PAUSED_SQL): its shots are not offered again
 * until a new read joins it. Runs inside the caller's transaction. */
async function pauseSession(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<void> {
  await db.execute(
    `UPDATE local_session SET rearms = ?
     WHERE owner_key = ? AND id = ? AND rearms <= ?`,
    [
      SESSION_CREATE_REARM_BOUND + 1,
      owner,
      sessionId,
      SESSION_CREATE_REARM_BOUND,
    ],
  );
}

/**
 * Re-queues the set from its `local_session` row if its automatic re-arm
 * budget allows (and spends one), inside the caller's transaction. Returns
 * whether the set was re-queued.
 */
async function requeueSessionWithinBound(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<boolean> {
  const rearms = await sessionRearms(db, owner, sessionId);
  if (rearms === null || rearms >= SESSION_CREATE_REARM_BOUND) return false;
  await enqueueLiveSessionCreateFromLocal(db, owner, sessionId);
  await chargeSessionRearm(db, owner, sessionId);
  return true;
}

/**
 * A new scored shot joining a refused set: the most recent EXHAUSTED
 * `session.create` row for `sessionId` gets a fresh attempt budget — unless a
 * live row for the set already exists — and the set's automatic re-arm
 * budget starts over. A new read is the one occasion on which a refused set
 * is asked for again in full; without one the server is re-asked at most
 * SESSION_CREATE_REARM_BOUND times (see that constant). Runs inside the
 * caller's transaction.
 */
export async function rearmExhaustedSessionCreate(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<void> {
  await db.execute(
    `UPDATE outbox SET attempts = 0, last_error = NULL
     WHERE owner_key = ? AND id = (
         SELECT max(id) FROM outbox
         WHERE owner_key = ? AND attempts >= ? AND ${SESSION_CREATE_FOR_ID_SQL})
       AND NOT EXISTS (
         SELECT 1 FROM outbox
         WHERE owner_key = ? AND attempts < ? AND ${SESSION_CREATE_FOR_ID_SQL})`,
    [
      owner,
      owner,
      OUTBOX_MAX_ATTEMPTS,
      sessionId,
      owner,
      OUTBOX_MAX_ATTEMPTS,
      sessionId,
    ],
  );
  await db.execute(
    `UPDATE local_session SET rearms = 0 WHERE owner_key = ? AND id = ?`,
    [owner, sessionId],
  );
}

/**
 * Parks, from SQL alone, every unparked `shot.sync` row of this owner whose
 * practice set the server has refused: an exhausted `session.create` names
 * the set and no live one does. The shot is never offered (the answer would
 * be `shot.session_not_found`) and never charged; its verdict names the
 * set's, and an accepted `session.create` for the set releases it again
 * (retireAcceptedSessionCreate). Runs inside the caller's transaction.
 */
async function parkShotsOfRefusedSets(
  db: LocalDb,
  owner: string,
): Promise<void> {
  const unparkedShotOfRefusedSet = `
       owner_key = ? AND kind = 'shot.sync' AND attempts < ${OUTBOX_MAX_ATTEMPTS}
       AND (last_error IS NULL OR last_error NOT LIKE '${SESSION_ORPHANED_VERDICT}:%')
       AND ${shotSessionIdSql('outbox')} IS NOT NULL
       AND ${shotSessionIdSql('outbox')} IN (
         SELECT ${sessionCreateIdSql('x')} FROM outbox x
         WHERE x.owner_key = ? AND x.kind = 'session.create'
           AND x.attempts >= ${OUTBOX_MAX_ATTEMPTS}
           AND ${sessionCreateIdSql('x')} IS NOT NULL)
       AND ${shotSessionIdSql('outbox')} NOT IN (
         SELECT ${sessionCreateIdSql('s')} FROM outbox s
         WHERE s.owner_key = ? AND s.kind = 'session.create'
           AND s.attempts < ${OUTBOX_MAX_ATTEMPTS}
           AND ${sessionCreateIdSql('s')} IS NOT NULL)`;
  const { rows } = await db.execute(
    `SELECT 1 AS present FROM outbox WHERE ${unparkedShotOfRefusedSet} LIMIT 1`,
    [owner, owner, owner],
  );
  if (rows.length === 0) return;
  await db.execute(
    `UPDATE outbox
     SET last_error = '${SESSION_ORPHANED_VERDICT}: Its practice set was refused ('
         || coalesce((
           SELECT x.last_error FROM outbox x
           WHERE x.owner_key = outbox.owner_key AND x.kind = 'session.create'
             AND x.attempts >= ${OUTBOX_MAX_ATTEMPTS}
             AND ${sessionCreateIdSql('x')} = ${shotSessionIdSql('outbox')}
           ORDER BY x.id DESC LIMIT 1), '')
         || ') before this read could be sent; this read is paused until the set is accepted.'
     WHERE ${unparkedShotOfRefusedSet}`,
    [owner, owner, owner],
  );
}

/**
 * Practice sets of this owner that a parked shot still waits for, that the
 * device knows (`local_session`) with automatic re-arm budget left, and that
 * NO `session.create` row names any more — live or exhausted. A drain queues
 * each such set once, from the local row, before its session pass, so the
 * drain that creates the set is also the one that releases and delivers its
 * parked shots.
 */
async function selectParkedSetsWithoutQueueEntry(
  db: LocalDb,
  owner: string,
): Promise<string[]> {
  const { rows } = await db.execute(
    `SELECT ls.id AS id FROM local_session ls
     WHERE ls.owner_key = ? AND ls.rearms < ${SESSION_CREATE_REARM_BOUND}
       AND EXISTS (
         SELECT 1 FROM outbox o
         WHERE o.owner_key = ls.owner_key AND o.kind = 'shot.sync'
           AND o.last_error LIKE '${SESSION_ORPHANED_VERDICT}:%'
           AND ${shotSessionIdSql('o')} = ls.id)
       AND NOT EXISTS (
         SELECT 1 FROM outbox s
         WHERE s.owner_key = ls.owner_key AND s.kind = 'session.create'
           AND ${sessionCreateIdSql('s')} = ls.id)
     ORDER BY ls.started_at ASC, ls.id ASC`,
    [owner],
  );
  return rows.map(row => String(row['id']));
}

/**
 * Practice sets of this owner whose `session.create` is EXHAUSTED by
 * refusals this build witnessed (`refusals >= OUTBOX_MAX_ATTEMPTS`; a row
 * exhausted by an earlier build carries no such record and keeps the one
 * legacy trigger, a new read joining the set), that a parked shot still
 * waits for, that the device knows with automatic re-arm budget left, and
 * that no live `session.create` names. A drain revives each such set for ONE
 * more offer, so the read the orphaned copy promises to send again is asked
 * for again — a bounded number of times, not forever.
 */
async function selectRevivableExhaustedSets(
  db: LocalDb,
  owner: string,
): Promise<string[]> {
  const { rows } = await db.execute(
    `SELECT ls.id AS id FROM local_session ls
     WHERE ls.owner_key = ? AND ls.rearms < ${SESSION_CREATE_REARM_BOUND}
       AND EXISTS (
         SELECT 1 FROM outbox o
         WHERE o.owner_key = ls.owner_key AND o.kind = 'shot.sync'
           AND o.last_error LIKE '${SESSION_ORPHANED_VERDICT}:%'
           AND ${shotSessionIdSql('o')} = ls.id)
       AND EXISTS (
         SELECT 1 FROM outbox x
         WHERE x.owner_key = ls.owner_key AND x.kind = 'session.create'
           AND x.attempts >= ${OUTBOX_MAX_ATTEMPTS}
           AND x.refusals >= ${OUTBOX_MAX_ATTEMPTS}
           AND ${sessionCreateIdSql('x')} = ls.id)
       AND NOT EXISTS (
         SELECT 1 FROM outbox s
         WHERE s.owner_key = ls.owner_key AND s.kind = 'session.create'
           AND s.attempts < ${OUTBOX_MAX_ATTEMPTS}
           AND ${sessionCreateIdSql('s')} = ls.id)
     ORDER BY ls.started_at ASC, ls.id ASC`,
    [owner],
  );
  return rows.map(row => String(row['id']));
}

/** Gives the newest exhausted `session.create` row of `sessionId` exactly
 * one more offer (attempts = OUTBOX_MAX_ATTEMPTS - 1) and spends one of the
 * set's automatic re-arms. Runs inside the caller's transaction. */
async function reviveExhaustedSessionCreate(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<void> {
  await db.execute(
    `UPDATE outbox SET attempts = ?
     WHERE owner_key = ? AND id = (
         SELECT max(id) FROM outbox
         WHERE owner_key = ? AND attempts >= ? AND ${SESSION_CREATE_FOR_ID_SQL})`,
    [OUTBOX_MAX_ATTEMPTS - 1, owner, owner, OUTBOX_MAX_ATTEMPTS, sessionId],
  );
  await chargeSessionRearm(db, owner, sessionId);
}

/**
 * The transaction that retires an accepted `session.create` row (`rowId`):
 * the row goes, together with any exhausted `session.create` rows for the
 * same set (the server has the session now, so they no longer describe a
 * refused set), and every shot of that set parked under
 * SESSION_ORPHANED_VERDICT becomes deliverable again with a fresh attempt
 * budget — its refusals were all about the missing set. Its lifetime
 * `refusals` count is untouched (monotone; getShotOutboxStatus reports it),
 * so the Result surface never reads fewer refusals than the server issued,
 * and a set the server accepts but keeps disowning cannot cycle the budget
 * forever: each cycle spends one of the set's SESSION_CREATE_REARM_BOUND
 * automatic re-arms.
 */
async function retireAcceptedSessionCreate(
  db: LocalDb,
  owner: string,
  rowId: unknown,
  sessionId: string,
): Promise<void> {
  await db.execute(
    `DELETE FROM outbox
     WHERE owner_key = ?
       AND (id = ? OR (attempts >= ? AND ${SESSION_CREATE_FOR_ID_SQL}))`,
    [owner, rowId, OUTBOX_MAX_ATTEMPTS, sessionId],
  );
  await db.execute(
    `UPDATE outbox SET attempts = 0, last_error = NULL
     WHERE owner_key = ? AND kind = 'shot.sync'
       AND last_error LIKE '${SESSION_ORPHANED_VERDICT}:%'
       AND CASE WHEN json_valid(payload)
                THEN json_extract(payload, '$.sessionId') END = ?`,
    [owner, sessionId],
  );
}

/**
 * Visits every row under budget of one pass in id order, a page per SELECT,
 * until the backlog is exhausted or `handlePage` asks to stop (a
 * transport-level failure: the network is down for the next page too). A
 * drain therefore reaches every row: a run of older rows that keep failing
 * transiently delays newer ones by at most a page and never hides them (the
 * former single `LIMIT 50` window let fifty stuck rows at the head of the
 * queue strand every later rating for good). `readPage` runs the SELECT
 * under the caller's lease and returns null once the drain is fenced.
 */
async function forEachOutboxPage(
  readPage: (cursor: number) => Promise<OutboxRow[] | null>,
  pass: OutboxPass,
  handlePage: (rows: OutboxRow[]) => Promise<boolean>,
): Promise<void> {
  let cursor = 0;
  let rows = await readPage(cursor);
  for (;;) {
    if (rows === null) return;
    const page = rows.filter(row => pass.accepts(String(row['kind'])));
    if (page.length > 0 && !(await handlePage(page))) return;
    const last = rows[rows.length - 1];
    const next = last ? Number(last['id']) : NaN;
    // The store hands back strictly increasing ids; a short page or one that
    // did not advance the cursor means there is nothing further to read.
    if (rows.length < OUTBOX_PAGE_SIZE || !(next > cursor)) return;
    cursor = next;
    rows = await readPage(cursor);
  }
}

/** A permanent failure spends one attempt of the row's budget and counts one
 * lifetime refusal; a transient one only records the reason. */
async function recordRowFailure(
  db: LocalDb,
  owner: string,
  rowId: unknown,
  error: unknown,
  permanent: boolean,
): Promise<void> {
  if (permanent) {
    await db.execute(
      `UPDATE outbox SET attempts = attempts + 1, refusals = refusals + 1, last_error = ?
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

/** A server refusal that does not spend the row's retry budget (the set it
 * needs is still queued) but still counts toward the lifetime `refusals`
 * the Result surface reports. */
async function recordUnchargedRefusal(
  db: LocalDb,
  owner: string,
  rowId: unknown,
  error: unknown,
): Promise<void> {
  await db.execute(
    `UPDATE outbox SET refusals = refusals + 1, last_error = ?
     WHERE owner_key = ? AND id = ?`,
    [String(error), owner, rowId],
  );
}

/**
 * A row that can never become a request (corrupt JSON, a payload that is not
 * an object, a missing or mistyped id, an unknown kind) is quarantined at
 * once: its whole attempt budget is spent in one statement with a truthful
 * `last_error`, so no later drain re-reads, re-charges or reports it again.
 */
async function quarantineRow(
  db: LocalDb,
  owner: string,
  rowId: unknown,
  error: unknown,
): Promise<void> {
  await db.execute(
    `UPDATE outbox SET attempts = ${OUTBOX_MAX_ATTEMPTS}, refusals = ${OUTBOX_MAX_ATTEMPTS}, last_error = ?
     WHERE owner_key = ? AND id = ?`,
    [String(error), owner, rowId],
  );
}

/** JSON.parse guarded to a plain object: `null`, arrays and scalars are
 * malformed payloads, not requests. */
function parsePayloadObject(raw: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(raw));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `outbox.payload_not_object: ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
    );
  }
  return parsed as Record<string, unknown>;
}

function requireStringField(
  payload: Record<string, unknown>,
  field: string,
  code: string,
): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${code}: ${field} is ${describeValue(value)}`);
  }
  return value;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'missing';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** The request a session-pass row describes, or a thrown malformed-row error. */
function parseSessionRow(row: OutboxRow): {
  kind: 'session.create' | 'session.finalize';
  id: string;
  payload: unknown;
} {
  const kind = row['kind'];
  if (kind !== 'session.create' && kind !== 'session.finalize') {
    throw new Error(`outbox.unknown_kind: ${String(kind)}`);
  }
  const payload = parsePayloadObject(row['payload']);
  const id = requireStringField(payload, 'id', `${kind}_missing_id`);
  return { kind, id, payload };
}

/** The sync request a `shot.sync` row describes, or a thrown malformed-row
 * error. Every field the payload mapping touches is checked here, so a
 * corrupt row is a verdict on that row alone. */
function parseShotRow(row: OutboxRow): {
  shotId: string;
  sessionId: string | null;
  payload: Record<string, unknown>;
} {
  const raw = parsePayloadObject(row['payload']);
  const shotId = requireStringField(raw, 'id', 'shot.sync_missing_id');
  const analysisPermitId = requireStringField(
    raw,
    'analysisPermitId',
    'shot.sync_missing_analysis_permit',
  );
  if (raw['sessionId'] !== null && typeof raw['sessionId'] !== 'string') {
    throw new Error(
      `shot.sync_malformed_session: sessionId is ${describeValue(raw['sessionId'])}`,
    );
  }
  if (!Array.isArray(raw['checkpoints'])) {
    throw new Error(
      `shot.sync_malformed_checkpoints: checkpoints is ${describeValue(raw['checkpoints'])}`,
    );
  }
  for (const checkpoint of raw['checkpoints']) {
    if (checkpoint === null || typeof checkpoint !== 'object') {
      throw new Error(
        `shot.sync_malformed_checkpoints: entry is ${describeValue(checkpoint)}`,
      );
    }
  }
  const analysis = raw as unknown as ShotAnalysis;
  return {
    shotId,
    sessionId: typeof raw['sessionId'] === 'string' ? raw['sessionId'] : null,
    payload: toSyncPayload(analysis, analysisPermitId),
  };
}

/** The upload an `evaluation.trial` row describes, or a thrown malformed-row
 * error. */
function parseTrialRow(row: OutboxRow): Record<string, unknown> & {
  trialId: string;
} {
  const raw = parsePayloadObject(row['payload']);
  const trialId = requireStringField(
    raw,
    'trialId',
    'evaluation.trial_missing_id',
  );
  return { ...raw, trialId };
}

/**
 * What a drain does with a shot the server rejected `shot.session_not_found`
 * for session `sessionId`, in order — each question answered by the
 * committed queue at settlement time, inside the settlement transaction:
 *
 *  1. A `session.create` row for the set still has budget: an ordering
 *     artifact (the set is created by a session pass), transient, attempts
 *     untouched (the lifetime `refusals` count still grows by one).
 *  2. The set's `session.create` row is exhausted: the shot is parked
 *     (SESSION_ORPHANED_VERDICT), attempts untouched — it was never at
 *     fault, and a later accepted session.create releases it.
 *  3. No queue entry names the set but the local session row exists — the
 *     capture flow was interrupted between the shot and its set, or the
 *     server accepted the set without applying its shot: re-queue the set
 *     from that row (the server upsert is idempotent) while the set's
 *     automatic re-arm budget lasts (SESSION_CREATE_REARM_BOUND). The attempt
 *     is counted, so a server that keeps refusing the shot after the set
 *     landed is bounded by the shot's own budget; the attempt that would
 *     exhaust it parks the shot instead, so the set's acceptance can still
 *     release it. Once the re-arm budget is spent the set is PAUSED: the
 *     attempt is counted, the verdict says so, and the shot is not offered
 *     again (SHOT_SET_PAUSED_SQL) until a new read joins the set.
 *  4. Nothing local knows the set: the shot spends its budget one drain at a
 *     time and, when it runs out, is parked instead of exhausted — a session
 *     row that appears later (saveSession) still brings it along.
 *
 * Returns 'parked' when the row was settled without counting as a failure.
 */
async function settleSessionNotFound(
  db: LocalDb,
  owner: string,
  row: OutboxRow,
  sessionId: string,
  message: string,
): Promise<'parked' | 'failed'> {
  const reason = `${SESSION_NOT_FOUND_REJECTION}: ${message}`;
  if (await hasLiveSessionCreate(db, owner, sessionId)) {
    await recordUnchargedRefusal(db, owner, row['id'], reason);
    return 'failed';
  }
  const deadSession = await exhaustedSessionCreateVerdict(db, owner, sessionId);
  if (deadSession !== null) {
    await recordRowFailure(
      db,
      owner,
      row['id'],
      `${SESSION_ORPHANED_VERDICT}: ${message} ` +
        `Its practice set was refused (${deadSession}); ` +
        `this read is paused until the set is accepted.`,
      false,
    );
    return 'parked';
  }
  const attemptsAfter = Number(row['attempts']) + 1;
  const rearms = await sessionRearms(db, owner, sessionId);
  if (rearms !== null) {
    if (rearms >= SESSION_CREATE_REARM_BOUND) {
      await recordRowFailure(
        db,
        owner,
        row['id'],
        `${reason} Its practice set was queued again from this device ` +
          `${Math.min(rearms, SESSION_CREATE_REARM_BOUND)} times without ` +
          `being applied; it is paused until a new read joins the set.`,
        true,
      );
      await pauseSession(db, owner, sessionId);
      return 'failed';
    }
    await enqueueLiveSessionCreateFromLocal(db, owner, sessionId);
    await chargeSessionRearm(db, owner, sessionId);
    if (attemptsAfter >= OUTBOX_MAX_ATTEMPTS) {
      await recordRowFailure(
        db,
        owner,
        row['id'],
        `${SESSION_ORPHANED_VERDICT}: ${message} ` +
          `Its practice set was queued again from this device; ` +
          `this read is paused until the set is accepted.`,
        true,
      );
      return 'failed';
    }
    await recordRowFailure(
      db,
      owner,
      row['id'],
      `${reason} Its practice set was queued again from this device.`,
      true,
    );
    return 'failed';
  }
  if (attemptsAfter >= OUTBOX_MAX_ATTEMPTS) {
    await recordRowFailure(
      db,
      owner,
      row['id'],
      `${SESSION_ORPHANED_VERDICT}: ${message} ` +
        `No practice set is known for this read on this device; ` +
        `it is paused until one is accepted.`,
      true,
    );
    return 'parked';
  }
  await recordRowFailure(db, owner, row['id'], reason, true);
  return 'failed';
}

/** Drains in flight per owner: a second drain for an owner whose drain is
 * running waits for it and then walks what is left (nothing is offered
 * twice). Concurrency control only — no liveness decision reads it. */
const drainsInFlight = new Map<string, Promise<unknown>>();

/**
 * Drains the active owner's outbox. The connection is taken per statement
 * group (`connectionLease`) and let go before every network round trip, so a
 * repository transaction started while the server is slow commits before the
 * drain's next statement group, and a purge of this owner can run in the
 * same window. Every statement group re-checks the owner's purge generation
 * under the lease and settles nothing once the owner was purged (an outbox
 * row that no longer exists has no verdict to receive; the receipt INSERT is
 * guarded the same way). A statement group that fails (disk full, a closed
 * database) is a row-level failure, never a thrown drain and never a leaked
 * connection.
 */
export async function drainOutbox(
  db: LocalDb,
  transport: SyncTransport,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const owner = getActiveDataOwner();
  const run = () => drainOwnerOutbox(db, connectionLease(db), owner, transport);
  const prior = drainsInFlight.get(owner);
  const drain = prior === undefined ? run() : prior.then(run, run);
  drainsInFlight.set(owner, drain);
  try {
    return await drain;
  } finally {
    if (drainsInFlight.get(owner) === drain) drainsInFlight.delete(owner);
  }
}

type RoundTrip<T> =
  { kind: 'ok'; value: T } | { kind: 'error'; error: unknown };

async function drainOwnerOutbox(
  db: LocalDb,
  lease: ConnectionLease,
  owner: string,
  transport: SyncTransport,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const purgeGeneration = ownerPurgeGeneration(owner);
  let synced = 0;
  let failed = 0;
  /** Set once a statement group found the owner purged since this drain
   * began; every later group and pass is skipped. */
  let fenced = false;

  /**
   * One statement group under the lease, entered only while the owner this
   * drain settles for has not been purged since it began. Returns `undefined`
   * — and fences the drain — otherwise. (An account SWITCH is not a fence:
   * the drain stays bound to the owner it started for and settles that
   * owner's rows — its bearer is that owner's.)
   */
  const guarded = <T>(statements: () => Promise<T>): Promise<T | undefined> =>
    lease.hold(async () => {
      if (fenced || ownerPurgeGeneration(owner) !== purgeGeneration) {
        fenced = true;
        return undefined;
      }
      return statements();
    });

  /** One network call, made with the connection let go. */
  const roundTrip = async <T>(
    call: () => Promise<T>,
  ): Promise<RoundTrip<T>> => {
    try {
      return { kind: 'ok', value: await call() };
    } catch (error) {
      return { kind: 'error', error };
    }
  };

  /** Records a failure for each of `rows` in one statement group; a failure
   * of that group itself is swallowed (the rows keep their place and are
   * replayed by the next drain). */
  const recordFailures = async (
    rows: OutboxRow[],
    error: unknown,
    permanent: boolean,
  ): Promise<void> => {
    try {
      await guarded(async () => {
        for (const r of rows) {
          await recordRowFailure(db, owner, r['id'], error, permanent);
        }
      });
    } catch {
      // The verdicts are lost, not the rows: the next drain offers them again.
    }
    failed += rows.length;
  };

  /** Quarantines a malformed row (one statement group, one reported
   * failure); a failure of that group itself is swallowed the same way. */
  const quarantine = async (row: OutboxRow, error: unknown): Promise<void> => {
    try {
      await guarded(() => quarantineRow(db, owner, row['id'], error));
    } catch {
      // The row keeps its budget and is quarantined by the next drain.
    }
    failed += 1;
  };

  /** One row's settlement statements as ONE transaction under the lease (a
   * receipt and its row's deletion land together or not at all; a kill
   * between two rows loses neither). Resolves `undefined` when the drain is
   * fenced; a statement failure propagates. A settlement that is a single
   * statement is atomic on its own and goes through `guarded` directly. */
  const settleRow = <T>(statements: () => Promise<T>): Promise<T | undefined> =>
    guarded(() => lease.transaction(statements));

  /** Runs a page's settlement, row by row (settleRow); a statement that
   * fails (the disk is full, an I/O error) rolls that row back and is a
   * row-level failure of the page's unsettled rows — the drain goes on, the
   * rows keep their place and are replayed by the next drain (the server's
   * upsert is idempotent, so an accepted upload whose receipt could not be
   * stored is simply offered again) — never a thrown drain. Returns whether
   * the pass may continue. */
  const settlePage = async (
    rows: OutboxRow[],
    settle: () => Promise<{ synced: number; failed: number }>,
  ): Promise<boolean> => {
    let outcome: { synced: number; failed: number };
    try {
      outcome = await settle();
    } catch (error) {
      const permanent = isPermanentSyncFailure(error);
      await recordFailures(rows, error, permanent);
      return permanent && !fenced;
    }
    synced += outcome.synced;
    failed += outcome.failed;
    return !fenced;
  };

  const readPage = (pass: OutboxPass) => async (cursor: number) => {
    const rows = await guarded(() => selectOutboxPage(db, owner, pass, cursor));
    return rows ?? null;
  };

  // Before the session pass, ONE statement group settles what the committed
  // queue already decides. Shots of a set the server has refused (an
  // exhausted session.create, no live one) are parked from SQL — one
  // statement, atomic on its own — uncharged and unoffered, whether or not
  // any pass of any drain ever visited that row. Then the sets whose parked
  // shots the drain can still do something for are re-armed, in one
  // transaction, within each set's automatic re-arm budget: a set no queue
  // entry names any more is queued from the local row; an exhausted set whose
  // refusals this build witnessed is revived for one more offer. This very
  // drain then creates the set and delivers the shots it releases.
  try {
    await guarded(async () => {
      await parkShotsOfRefusedSets(db, owner);
      const requeue = await selectParkedSetsWithoutQueueEntry(db, owner);
      const revive = await selectRevivableExhaustedSets(db, owner);
      if (requeue.length === 0 && revive.length === 0) return;
      await lease.transaction(async () => {
        for (const sessionId of requeue) {
          await requeueSessionWithinBound(db, owner, sessionId);
        }
        for (const sessionId of revive) {
          await reviveExhaustedSessionCreate(db, owner, sessionId);
        }
      });
    });
  } catch {
    // Nothing re-armed this time; the parked rows keep waiting for the next drain.
  }

  // Sessions FIRST, across the whole backlog: `apply_synced_shot` rejects a
  // shot whose sessionId the server has never seen ("shot.session_not_found"),
  // and a practice set's session.create row is queued right behind its first
  // shot. Session creation is idempotent server-side, so draining it ahead of
  // the shots costs nothing when it was already accepted. Which sets the
  // server has refused is not remembered here: the shot pass asks the queue
  // per shot (settleSessionNotFound), so a pass cut short leaves the shots
  // of every set it did not reach untouched.
  await forEachOutboxPage(readPage(SESSION_PASS), SESSION_PASS, async rows => {
    let reachable = true;
    for (const r of rows) {
      if (fenced) return false;
      let request: ReturnType<typeof parseSessionRow>;
      try {
        request = parseSessionRow(r);
      } catch (error) {
        await quarantine(r, error);
        continue;
      }
      const outcome: RoundTrip<void> =
        request.kind === 'session.create'
          ? await roundTrip(() => transport.createSession(request.payload))
          : await roundTrip(() => transport.finalizeSession(request.id));
      if (outcome.kind === 'error') {
        const permanent = isPermanentSyncFailure(outcome.error);
        await recordFailures([r], outcome.error, permanent);
        if (!permanent) reachable = false;
        continue;
      }
      const settled = await settlePage([r], async () => {
        const done =
          request.kind === 'session.create'
            ? await settleRow(async () => {
                await retireAcceptedSessionCreate(
                  db,
                  owner,
                  r['id'],
                  request.id,
                );
                return true;
              })
            : await guarded(async () => {
                await db.execute(
                  `DELETE FROM outbox WHERE owner_key = ? AND id = ?`,
                  [owner, r['id']],
                );
                return true;
              });
        return { synced: done === true ? 1 : 0, failed: 0 };
      });
      if (!settled) return false;
    }
    return reachable && !fenced;
  });

  // The shot page is read AFTER the session pass, against the committed
  // queue: a shot whose set was created (or whose parked marker was cleared)
  // moments ago is offered now, and a shot whose set is still queued —
  // unsent because the pass stopped on a transient failure, or failing
  // transiently itself — is left alone (SHOT_SET_STILL_QUEUED_SQL), as is a
  // shot of a paused set (SHOT_SET_PAUSED_SQL).
  const drainShotPage = async (shotRows: OutboxRow[]): Promise<boolean> => {
    // A row whose payload cannot become a sync request (corrupt JSON, missing
    // permit) fails alone and permanently; it never poisons the whole batch.
    const entries: Array<{
      row: OutboxRow;
      shotId: string;
      sessionId: string | null;
      payload: Record<string, unknown>;
    }> = [];
    const malformed: Array<{ row: OutboxRow; error: unknown }> = [];
    for (const r of shotRows) {
      let parsed: ReturnType<typeof parseShotRow>;
      try {
        parsed = parseShotRow(r);
      } catch (error) {
        // Quarantined whether parked or not: a row that can never become a
        // request has nothing to wait for.
        malformed.push({ row: r, error });
        continue;
      }
      // A parked shot waits, silently, until a session.create for its set
      // is accepted; the session pass of that drain clears the marker
      // before this page is read.
      if (
        isSessionOrphanedVerdict(
          typeof r['last_error'] === 'string' ? r['last_error'] : null,
        )
      ) {
        continue;
      }
      entries.push({ row: r, ...parsed });
    }
    for (const { row, error } of malformed) {
      await quarantine(row, error);
    }
    if (fenced) return false;
    if (entries.length === 0) return true;
    const outcome = await roundTrip(() =>
      transport.syncShots(entries.map(entry => entry.payload)),
    );
    if (outcome.kind === 'error') {
      const permanent = isPermanentSyncFailure(outcome.error);
      await recordFailures(
        entries.map(entry => entry.row),
        outcome.error,
        permanent,
      );
      return permanent && !fenced;
    }
    const response = outcome.value;
    return settlePage(
      entries.map(entry => entry.row),
      async () => {
        // A 2xx whose body is not the contract (null, wrong shape) fails the
        // page's rows like any other settlement error — never a thrown drain.
        const accepted = new Set(response.acceptedIds);
        const rejected = new Map(
          response.rejected.map(item => [item.id, item] as const),
        );
        const tally = { synced: 0, failed: 0 };
        for (const entry of entries) {
          if (fenced) break;
          if (accepted.has(entry.shotId)) {
            const done = await settleRow(async () => {
              // The receipt is written only for a row that still exists: an
              // owner purged meanwhile has no rows and so gets no receipt.
              await db.execute(
                `INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id)
                 SELECT ?, 'shot.sync', ?
                 WHERE EXISTS (SELECT 1 FROM outbox WHERE owner_key = ? AND id = ?)`,
                [owner, entry.shotId, owner, entry.row['id']],
              );
              await db.execute(
                `DELETE FROM outbox WHERE owner_key = ? AND id = ?`,
                [owner, entry.row['id']],
              );
              return true;
            });
            if (done === true) tally.synced++;
            continue;
          }
          const rejection = rejected.get(entry.shotId);
          if (
            rejection?.code === SESSION_NOT_FOUND_REJECTION &&
            entry.sessionId !== null
          ) {
            const sessionId = entry.sessionId;
            const settled = await settleRow(() =>
              settleSessionNotFound(
                db,
                owner,
                entry.row,
                sessionId,
                rejection.message,
              ),
            );
            if (settled === 'failed') tally.failed++;
            continue;
          }
          const done = await guarded(async () => {
            await recordRowFailure(
              db,
              owner,
              entry.row['id'],
              rejection
                ? `${rejection.code}: ${rejection.message}`
                : 'shot.sync_unacknowledged',
              !rejection || !isTransientSyncRejection(rejection.code),
            );
            return true;
          });
          if (done === true) tally.failed++;
        }
        return tally;
      },
    );
  };
  if (!fenced) {
    await forEachOutboxPage(readPage(SHOT_PASS), SHOT_PASS, drainShotPage);
  }

  if (transport.uploadEvaluationTrials && !fenced) {
    const upload = transport.uploadEvaluationTrials.bind(transport);
    await forEachOutboxPage(
      readPage(TRIAL_PASS),
      TRIAL_PASS,
      async trialRows => {
        const entries: Array<{
          row: OutboxRow;
          trial: ReturnType<typeof parseTrialRow>;
        }> = [];
        const malformed: Array<{ row: OutboxRow; error: unknown }> = [];
        for (const r of trialRows) {
          try {
            entries.push({ row: r, trial: parseTrialRow(r) });
          } catch (error) {
            malformed.push({ row: r, error });
          }
        }
        for (const { row, error } of malformed) {
          await quarantine(row, error);
        }
        if (fenced) return false;
        if (entries.length === 0) return true;
        const outcome = await roundTrip(() =>
          upload(entries.map(entry => entry.trial)),
        );
        if (outcome.kind === 'error') {
          const permanent = isPermanentSyncFailure(outcome.error);
          await recordFailures(
            entries.map(entry => entry.row),
            outcome.error,
            permanent,
          );
          return permanent && !fenced;
        }
        const response = outcome.value;
        return settlePage(
          entries.map(entry => entry.row),
          async () => {
            const accepted = new Set(response.acceptedTrialIds);
            const rejected = new Map(
              response.rejected.map(item => [item.trialId, item] as const),
            );
            const tally = { synced: 0, failed: 0 };
            for (const entry of entries) {
              if (fenced) break;
              if (accepted.has(entry.trial.trialId)) {
                const done = await guarded(async () => {
                  await db.execute(
                    `DELETE FROM outbox WHERE owner_key = ? AND id = ?`,
                    [owner, entry.row['id']],
                  );
                  return true;
                });
                if (done === true) tally.synced++;
                continue;
              }
              const rejection = rejected.get(entry.trial.trialId);
              const done = await guarded(async () => {
                await recordRowFailure(
                  db,
                  owner,
                  entry.row['id'],
                  rejection
                    ? `${rejection.code}: ${rejection.message}`
                    : 'evaluation.trial_unacknowledged',
                  !rejection || !isTransientSyncRejection(rejection.code),
                );
                return true;
              });
              if (done === true) tally.failed++;
            }
            return tally;
          },
        );
      },
    );
  }

  const left = await guarded(() =>
    db.execute(`SELECT count(*) AS n FROM outbox WHERE owner_key = ?`, [owner]),
  );
  return {
    synced,
    failed,
    remaining: Number(left?.rows[0]?.['n'] ?? 0),
  };
}
