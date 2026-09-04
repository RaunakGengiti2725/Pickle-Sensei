import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from './db';
import { withConnection, type ConnectionLease } from './transaction';
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

/** Rows read per SELECT while a drain walks the owner's backlog. */
const OUTBOX_PAGE_SIZE = 50;

type OutboxRow = Record<string, unknown>;

interface OutboxPass {
  /** SQL predicate on `kind`, mirrored by `accepts` for the JS partition. */
  kindSql: string;
  accepts(kind: string): boolean;
  /**
   * Rows at or beyond the attempt budget are normally invisible to a drain.
   * The session pass opts exhausted `session.create` rows back in so the shot
   * pass can recognise the sets the server has refused.
   */
  budgetSql: string;
  /** Further SQL predicate (starting with AND) on the rows a drain may offer;
   * its one `?`, when present, binds the owner key. */
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

const SESSION_PASS: OutboxPass = {
  kindSql: `kind NOT IN ('shot.sync', 'evaluation.trial')`,
  accepts: kind => kind !== 'shot.sync' && kind !== 'evaluation.trial',
  budgetSql: `(attempts < ? OR kind = 'session.create')`,
  offerSql: '',
};
const SHOT_PASS: OutboxPass = {
  kindSql: `kind = 'shot.sync'`,
  accepts: kind => kind === 'shot.sync',
  budgetSql: `attempts < ?`,
  offerSql: `AND NOT ${SHOT_SET_STILL_QUEUED_SQL}`,
};
const TRIAL_PASS: OutboxPass = {
  kindSql: `kind = 'evaluation.trial'`,
  accepts: kind => kind === 'evaluation.trial',
  budgetSql: `attempts < ?`,
  offerSql: '',
};

/** One page of a pass's live rows, in id order, strictly after `cursor`. */
async function selectOutboxPage(
  db: LocalDb,
  owner: string,
  pass: OutboxPass,
  cursor: number,
): Promise<OutboxRow[]> {
  const { rows } = await db.execute(
    `SELECT id, kind, payload, attempts, last_error FROM outbox
     WHERE owner_key = ? AND ${pass.budgetSql} AND id > ?
       AND ${pass.kindSql} ${pass.offerSql}
     ORDER BY id ASC LIMIT ${OUTBOX_PAGE_SIZE}`,
    [
      owner,
      OUTBOX_MAX_ATTEMPTS,
      cursor,
      ...(pass.offerSql.includes('?') ? [owner] : []),
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

/**
 * Gives the most recent EXHAUSTED `session.create` row for `sessionId` a
 * fresh attempt budget — unless a live row for the set already exists. A
 * refused set is asked for again only on a bounded occasion (a new scored
 * shot joining it, see saveAnalysis), never on a timer, so the server is
 * never re-asked in a loop: each occasion buys at most OUTBOX_MAX_ATTEMPTS
 * further offers. Runs inside the caller's transaction.
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
}

/**
 * Practice sets of this owner that a parked shot still waits for, that the
 * device knows (`local_session`) and that NO `session.create` row names any
 * more — live or exhausted. A drain queues each such set once, from the
 * local row, before its session pass, so the drain that creates the set is
 * also the one that releases and delivers its parked shots.
 */
async function selectParkedSetsWithoutQueueEntry(
  db: LocalDb,
  owner: string,
): Promise<string[]> {
  const { rows } = await db.execute(
    `SELECT ls.id AS id FROM local_session ls
     WHERE ls.owner_key = ?
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
 * The transaction that retires an accepted `session.create` row (`rowId`):
 * the row goes, together with any exhausted `session.create` rows for the
 * same set (the server has the session now, so they no longer describe a
 * refused set), and every shot of that set parked under
 * SESSION_ORPHANED_VERDICT becomes deliverable again with a fresh budget —
 * its failures were all about the missing session.
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

async function hasLocalSession(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<boolean> {
  const { rows } = await db.execute(
    `SELECT mode, shot_type, focus_checkpoint, started_at FROM local_session
     WHERE owner_key = ? AND id = ?`,
    [owner, sessionId],
  );
  return rows.length > 0;
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
): Promise<void> {
  let cursor = 0;
  let rows = await selectOutboxPage(db, owner, pass, cursor);
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

/**
 * What a drain does with a shot the server rejected `shot.session_not_found`
 * for session `sessionId`, in order:
 *
 *  1. The set's `session.create` row is exhausted (`deadSession`): the shot
 *     is parked (SESSION_ORPHANED_VERDICT), attempts untouched — it was never
 *     at fault, and a later accepted session.create releases it.
 *  2. A `session.create` row for the set still has budget: an ordering
 *     artifact (the set is created by a session pass), transient, attempts
 *     untouched.
 *  3. No queue entry names the set but the local session row exists — the
 *     capture flow was interrupted between the shot and its set: re-queue
 *     the set from that row (the server upsert is idempotent). While the
 *     shot has budget to spare the attempt is counted, so a server that
 *     keeps refusing the shot after the set landed is bounded by the shot's
 *     own budget; the attempt that would exhaust it parks the shot instead,
 *     so the set's acceptance can still release it.
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
  deadSession: string | undefined,
): Promise<'parked' | 'failed'> {
  const reason = `${SESSION_NOT_FOUND_REJECTION}: ${message}`;
  if (deadSession !== undefined) {
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
  if (await hasLiveSessionCreate(db, owner, sessionId)) {
    await recordRowFailure(db, owner, row['id'], reason, false);
    return 'failed';
  }
  const attemptsAfter = Number(row['attempts']) + 1;
  if (await hasLocalSession(db, owner, sessionId)) {
    await enqueueLiveSessionCreateFromLocal(db, owner, sessionId);
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

/**
 * The drain runs with the connection held (`withConnection`): every SELECT
 * sees only committed rows and every verdict it writes is its own statement
 * or its own transaction — never a statement inside someone else's open
 * BEGIN. The connection is let go only for the network round trips
 * (`lease.suspendWhile`), the one window in which a purge of this owner may
 * run; after each round trip the drain re-checks that the owner was not
 * purged and settles nothing otherwise (an outbox row that no longer exists
 * has no verdict to receive; the receipt INSERT is guarded the same way).
 */
export async function drainOutbox(
  db: LocalDb,
  transport: SyncTransport,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const owner = getActiveDataOwner();
  return withConnection(db, lease =>
    drainOwnerOutbox(db, lease, owner, transport),
  );
}

type RoundTrip<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'fenced' };

async function drainOwnerOutbox(
  db: LocalDb,
  lease: ConnectionLease,
  owner: string,
  transport: SyncTransport,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const purgeGeneration = ownerPurgeGeneration(owner);
  let synced = 0;
  let failed = 0;
  /** Set once a round trip came back to an owner this drain may no longer
   * settle rows for; every later pass is skipped. */
  let fenced = false;

  /** One network call, made with the connection let go. Its outcome is
   * `fenced` when the owner's bucket was purged meanwhile, whatever the
   * server answered: none of the rows this drain read may be touched. (An
   * account SWITCH is not a fence: the drain stays bound to the owner it
   * started for and settles that owner's rows — its bearer is that owner's.) */
  const roundTrip = async <T>(
    call: () => Promise<T>,
  ): Promise<RoundTrip<T>> => {
    let outcome: RoundTrip<T>;
    try {
      outcome = { kind: 'ok', value: await lease.suspendWhile(call) };
    } catch (error) {
      outcome = { kind: 'error', error };
    }
    if (ownerPurgeGeneration(owner) !== purgeGeneration) {
      fenced = true;
      return { kind: 'fenced' };
    }
    return outcome;
  };

  /** Runs a page's settlement statements; a statement that fails (the disk
   * is full, an I/O error) is a row-level failure of that page — the drain
   * goes on, the rows keep their place and are replayed by the next drain —
   * never a thrown drain. Returns whether the pass may continue. */
  const settlePage = async (
    rows: OutboxRow[],
    settle: () => Promise<void>,
  ): Promise<boolean> => {
    try {
      await settle();
      return true;
    } catch (error) {
      const permanent = isPermanentSyncFailure(error);
      for (const r of rows) {
        await recordRowFailure(db, owner, r['id'], error, permanent);
        failed++;
      }
      return permanent;
    }
  };

  // A parked shot whose set this device knows but whose set no queue entry
  // names any more (a lost row, or a refused set whose exhausted rows were
  // dropped) gets its set queued from the local row — once, atomically —
  // ahead of the session pass, so this very drain can create the set and
  // deliver the shot.
  for (const sessionId of await selectParkedSetsWithoutQueueEntry(db, owner)) {
    await enqueueLiveSessionCreateFromLocal(db, owner, sessionId);
  }

  // Sessions FIRST, across the whole backlog: `apply_synced_shot` rejects a
  // shot whose sessionId the server has never seen ("shot.session_not_found"),
  // and a practice set's session.create row is queued right behind its first
  // shot. Session creation is idempotent server-side, so draining it ahead of
  // the shots costs nothing when it was already accepted.
  //
  // A session.create row that spent its budget names a set the server has
  // refused; its id is kept so the shot pass can park that set's shots
  // instead of retrying them forever. A later session.create for the same id
  // that IS accepted removes it again: its parked shots were released in the
  // same transaction and are offered by the shot pass of this drain.
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
      const outcome: RoundTrip<void> =
        r['kind'] === 'session.create'
          ? await roundTrip(() => transport.createSession(payload))
          : await roundTrip(() =>
              transport.finalizeSession(String(payload['id'])),
            );
      if (outcome.kind === 'fenced') return false;
      if (outcome.kind === 'error') {
        const { error } = outcome;
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
        continue;
      }
      const settled = await settlePage([r], async () => {
        if (r['kind'] === 'session.create') {
          const sessionId = String(payload['id']);
          await lease.transaction(() =>
            retireAcceptedSessionCreate(db, owner, r['id'], sessionId),
          );
          deadSessions.delete(sessionId);
        } else {
          await db.execute(
            `DELETE FROM outbox WHERE owner_key = ? AND id = ?`,
            [owner, r['id']],
          );
        }
        synced++;
      });
      if (!settled) reachable = false;
    }
    return reachable;
  });

  // The shot page is read AFTER the session pass, against the committed
  // queue: a shot whose set was created (or whose parked marker was cleared)
  // moments ago is offered now, and a shot whose set is still queued —
  // unsent because the pass stopped on a transient failure, or failing
  // transiently itself — is left alone (SHOT_SET_STILL_QUEUED_SQL).
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
        const sessionId =
          typeof analysis.sessionId === 'string' ? analysis.sessionId : null;
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
        entries.push({
          row: r,
          shotId: analysis.id,
          sessionId,
          payload: toSyncPayload(analysis, analysis.analysisPermitId),
        });
      } catch (error) {
        await recordRowFailure(db, owner, r['id'], error, true);
        failed++;
      }
    }
    if (entries.length === 0) return true;
    const outcome = await roundTrip(() =>
      transport.syncShots(entries.map(entry => entry.payload)),
    );
    if (outcome.kind === 'fenced') return false;
    if (outcome.kind === 'error') {
      const { error } = outcome;
      const permanent = isPermanentSyncFailure(error);
      for (const entry of entries) {
        await recordRowFailure(db, owner, entry.row['id'], error, permanent);
        failed++;
      }
      return permanent;
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
        for (const entry of entries) {
          if (accepted.has(entry.shotId)) {
            await lease.transaction(async () => {
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
            });
            synced++;
            continue;
          }
          const rejection = rejected.get(entry.shotId);
          if (
            rejection?.code === SESSION_NOT_FOUND_REJECTION &&
            entry.sessionId !== null
          ) {
            const settled = await settleSessionNotFound(
              db,
              owner,
              entry.row,
              entry.sessionId,
              rejection.message,
              deadSessions.get(entry.sessionId),
            );
            if (settled === 'parked') continue;
            failed++;
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
      },
    );
  };
  if (!fenced) await forEachOutboxPage(db, owner, SHOT_PASS, drainShotPage);

  if (transport.uploadEvaluationTrials && !fenced) {
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
      const outcome = await roundTrip(() =>
        upload(entries.map(entry => entry.trial)),
      );
      if (outcome.kind === 'fenced') return false;
      if (outcome.kind === 'error') {
        const { error } = outcome;
        const permanent = isPermanentSyncFailure(error);
        for (const entry of entries) {
          await recordRowFailure(db, owner, entry.row['id'], error, permanent);
          failed++;
        }
        return permanent;
      }
      const response = outcome.value;
      return settlePage(
        entries.map(entry => entry.row),
        async () => {
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
        },
      );
    });
  }

  const { rows: left } = await db.execute(
    `SELECT count(*) AS n FROM outbox WHERE owner_key = ?`,
    [owner],
  );
  return { synced, failed, remaining: Number(left[0]?.['n'] ?? 0) };
}
