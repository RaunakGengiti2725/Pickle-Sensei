import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from './db';
import { runExclusive, type ConnectionTurn } from './transaction';
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
 * Marker for a shot released from the parked verdict at the attempt cap:
 * its set was accepted, so it is offered once more under a set the server
 * now has, without its lifetime attempt count being touched (getShotOutboxStatus
 * reports it `queued`; a further refusal exhausts it for good with a count
 * that is the true number of refusals). Shots released below the cap simply
 * have their `last_error` cleared.
 */
export const SESSION_RELEASED_MARKER = 'shot.session_released';

export function isSessionReleasedMarker(lastError: string | null): boolean {
  return (
    lastError !== null && lastError.startsWith(`${SESSION_RELEASED_MARKER}:`)
  );
}

/**
 * How many times the sync engine itself may re-arm one practice set's
 * `session.create` — without a NEW read joining the set — before the set
 * waits for one. Tracked per (owner, set) in `sync_set_state`, never in
 * memory, and deleted by saveAnalysis when a new read is saved into the set
 * (that read grants the set one more full round of OUTBOX_MAX_ATTEMPTS).
 * The one event that counts as a re-arm: a shot refused
 * `shot.session_not_found` while no `session.create` row names its set
 * re-queues the set from the local_session row (settleSessionNotFound).
 * Hence for a server that accepts `session.create` yet keeps refusing the
 * set's shot `shot.session_not_found`, one read costs at most
 * SESSION_REARM_LIMIT + 1 createSession calls (the save's own row plus the
 * re-queues) and SESSION_REARM_LIMIT + 1 syncShots calls, after which the
 * shot is held — attempts monotone and equal to the refusals the server
 * issued — until a new read joins the set. An exhausted `session.create`
 * (refused OUTBOX_MAX_ATTEMPTS times) is never re-asked by a drain on its
 * own: the set is asked for again only when a new read is saved into it
 * (rearmExhaustedSessionCreate), which is what the ResultScreen copy for a
 * parked read states.
 */
export const SESSION_REARM_LIMIT = 2;

/** Rows read per SELECT while a drain walks the owner's backlog. */
const OUTBOX_PAGE_SIZE = 50;

type OutboxRow = Record<string, unknown>;

interface OutboxPass {
  /** SQL predicate on `kind`, mirrored by `accepts` for the JS partition. */
  kindSql: string;
  accepts(kind: string): boolean;
  /**
   * Rows at or beyond the attempt budget are invisible to a drain; the shot
   * pass opts parked and released shots back in so the drain that lands
   * their session can offer them at once.
   */
  budgetSql: string;
}

/** `json_extract(payload, '$.id')` of a row whose payload is a JSON object,
 * NULL otherwise; CASE guards the extraction against corrupt payloads. */
const PAYLOAD_ID_SQL = `CASE WHEN json_valid(payload)
                THEN json_extract(payload, '$.id') END`;

const SESSION_PASS: OutboxPass = {
  kindSql: `kind NOT IN ('shot.sync', 'evaluation.trial')`,
  accepts: kind => kind !== 'shot.sync' && kind !== 'evaluation.trial',
  budgetSql: `attempts < ?`,
};
const SHOT_PASS: OutboxPass = {
  kindSql: `kind = 'shot.sync'`,
  accepts: kind => kind === 'shot.sync',
  budgetSql: `(attempts < ?
       OR last_error LIKE '${SESSION_ORPHANED_VERDICT}:%'
       OR last_error LIKE '${SESSION_RELEASED_MARKER}:%')`,
};
const TRIAL_PASS: OutboxPass = {
  kindSql: `kind = 'evaluation.trial'`,
  accepts: kind => kind === 'evaluation.trial',
  budgetSql: `attempts < ?`,
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
       AND ${pass.kindSql}
     ORDER BY id ASC LIMIT ${OUTBOX_PAGE_SIZE}`,
    [owner, OUTBOX_MAX_ATTEMPTS, cursor],
  );
  return rows;
}

/** The predicate that picks the `session.create` rows naming `sessionId`;
 * guarded per row so one corrupt payload cannot fail the lookup (C1). */
const SESSION_CREATE_FOR_ID_SQL = `kind = 'session.create'
       AND ${PAYLOAD_ID_SQL} = ?`;

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
 * The verdict of an exhausted `session.create` row for `sessionId`, or null
 * when none exists: the set was refused for good and its shots are parked,
 * whether or not this drain's session pass got to visit that row.
 */
async function exhaustedSessionCreateVerdict(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<string | null> {
  const { rows } = await db.execute(
    `SELECT last_error FROM outbox
     WHERE owner_key = ? AND attempts >= ? AND ${SESSION_CREATE_FOR_ID_SQL}
     LIMIT 1`,
    [owner, OUTBOX_MAX_ATTEMPTS, sessionId],
  );
  const row = rows[0];
  return row ? String(row['last_error'] ?? '') : null;
}

/** How often the engine re-armed `sessionId` since a read last joined it. */
async function readSessionRearms(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<number> {
  const { rows } = await db.execute(
    `SELECT rearms FROM sync_set_state WHERE owner_key = ? AND session_id = ?`,
    [owner, sessionId],
  );
  return Number(rows[0]?.['rearms'] ?? 0);
}

async function countSessionRearm(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO sync_set_state (owner_key, session_id, rearms)
     VALUES (?, ?, 1)
     ON CONFLICT(owner_key, session_id) DO UPDATE SET rearms = rearms + 1`,
    [owner, sessionId],
  );
}

/**
 * Forgets the set's re-arm count: a new read saved into the set is the one
 * event that grants it another SESSION_REARM_LIMIT engine re-arms. Runs
 * inside the caller's transaction (saveAnalysis).
 */
export async function resetSessionSyncState(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<void> {
  await db.execute(
    `DELETE FROM sync_set_state WHERE owner_key = ? AND session_id = ?`,
    [owner, sessionId],
  );
}

/** The `session.create` payload: what `POST /v1/sessions` upserts by id. */
export interface SessionCreatePayload {
  id: string;
  mode: string;
  shotType: string | null;
  focusCheckpoint: string | null;
  startedAt: string;
}

/**
 * Queues `session.create` for `session` unless the outbox already holds a
 * LIVE row for that id. The existence check and the insert are ONE
 * statement, so two writers that both find no row (a save and a drain, two
 * drains) can never both insert: the second one's SELECT sees the first
 * one's row. The server upsert is idempotent, so one live row per set is all
 * a drain needs. An exhausted row does not block: the set is being asked for
 * again (saveSession, a parked shot's re-queue) and that row is dropped once
 * the set is accepted. Runs inside the caller's exclusive turn / transaction.
 */
export async function enqueueSessionCreate(
  db: LocalDb,
  owner: string,
  session: SessionCreatePayload,
): Promise<void> {
  await db.execute(
    `INSERT INTO outbox (owner_key, kind, payload)
     SELECT ?, 'session.create', ?
     WHERE NOT EXISTS (
       SELECT 1 FROM outbox
       WHERE owner_key = ? AND attempts < ? AND ${SESSION_CREATE_FOR_ID_SQL}
     )`,
    [owner, JSON.stringify(session), owner, OUTBOX_MAX_ATTEMPTS, session.id],
  );
}

/**
 * Re-arms a set whose `session.create` row spent its attempt budget: the
 * budget is reset (last_error cleared) so the next session pass asks the
 * server for the set again — unless a live row for the id already exists,
 * so a set never holds two live rows. Called when a new scored shot joins
 * the set (saveAnalysis): each such shot is one bounded round of
 * OUTBOX_MAX_ATTEMPTS offers, never an open-ended loop. Runs inside the
 * caller's transaction.
 */
export async function rearmExhaustedSessionCreate(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<void> {
  await db.execute(
    `UPDATE outbox SET attempts = 0, last_error = NULL
     WHERE owner_key = ? AND attempts >= ? AND ${SESSION_CREATE_FOR_ID_SQL}
       AND NOT EXISTS (
         SELECT 1 FROM outbox
         WHERE owner_key = ? AND attempts < ? AND ${SESSION_CREATE_FOR_ID_SQL}
       )`,
    [
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
 * Retires an accepted `session.create` row, in one transaction: the row goes,
 * and with it any exhausted `session.create` row for the same id (the server
 * has the set now, so they no longer describe a refused set), and every shot
 * of the set parked under SESSION_ORPHANED_VERDICT becomes deliverable again.
 * A shot's lifetime attempt count is never reset: a parked shot below the
 * cap gets its `last_error` cleared, one at the cap is released under
 * SESSION_RELEASED_MARKER for exactly one more offer.
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
    `UPDATE outbox SET last_error = CASE WHEN attempts < ? THEN NULL ELSE ? END
     WHERE owner_key = ? AND kind = 'shot.sync'
       AND last_error LIKE '${SESSION_ORPHANED_VERDICT}:%'
       AND CASE WHEN json_valid(payload)
                THEN json_extract(payload, '$.sessionId') END = ?`,
    [
      OUTBOX_MAX_ATTEMPTS,
      `${SESSION_RELEASED_MARKER}: Its practice set was accepted; ` +
        `this read is offered once more.`,
      owner,
      sessionId,
    ],
  );
}

async function readLocalSession(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<SessionCreatePayload | null> {
  const { rows } = await db.execute(
    `SELECT mode, shot_type, focus_checkpoint, started_at FROM local_session
     WHERE owner_key = ? AND id = ?`,
    [owner, sessionId],
  );
  const row = rows[0];
  if (!row || typeof row['mode'] !== 'string') return null;
  if (typeof row['started_at'] !== 'string') return null;
  return {
    id: sessionId,
    mode: row['mode'],
    shotType: typeof row['shot_type'] === 'string' ? row['shot_type'] : null,
    focusCheckpoint:
      typeof row['focus_checkpoint'] === 'string'
        ? row['focus_checkpoint']
        : null,
    startedAt: row['started_at'],
  };
}

/**
 * What the outbox says about a shot's practice set at the moment the shot is
 * about to be offered — decided by SQL over the whole outbox, never by what
 * this drain's session pass happened to visit.
 */
interface SessionSetState {
  /** A `session.create` row under budget exists: the set is on its way. */
  live: boolean;
  /** `last_error` of an exhausted `session.create` row: the set was refused
   * for good (until something re-arms it). */
  refused: string | null;
  /** The local_session row, read only when no `session.create` row exists. */
  local: SessionCreatePayload | null;
  /** Engine re-arms since a read last joined the set (see SESSION_REARM_LIMIT). */
  rearms: number;
}

async function readSessionSetState(
  db: LocalDb,
  owner: string,
  sessionId: string,
): Promise<SessionSetState> {
  if (await hasLiveSessionCreate(db, owner, sessionId)) {
    return { live: true, refused: null, local: null, rearms: 0 };
  }
  const refused = await exhaustedSessionCreateVerdict(db, owner, sessionId);
  if (refused !== null) {
    return { live: false, refused, local: null, rearms: 0 };
  }
  const local = await readLocalSession(db, owner, sessionId);
  const rearms =
    local === null ? 0 : await readSessionRearms(db, owner, sessionId);
  return { live: false, refused: null, local, rearms };
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
  readPage: (cursor: number) => Promise<OutboxRow[]>,
  pass: OutboxPass,
  handlePage: (rows: OutboxRow[]) => Promise<boolean>,
  firstPage?: OutboxRow[],
): Promise<void> {
  let cursor = 0;
  let rows = firstPage ?? (await readPage(cursor));
  for (;;) {
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
 * Isolates a row that can never become a request (corrupt JSON, a payload
 * that is not an object, a missing or non-string id, an unknown kind) in
 * ONE step: it is charged straight to the attempt cap with a truthful
 * `last_error`, so no later pass reads it again, it never counts as a
 * failure twice, and the owner's retry cadence is not held at its ceiling
 * by a row nothing can fix.
 */
async function quarantineRow(
  db: LocalDb,
  owner: string,
  rowId: unknown,
  error: unknown,
): Promise<void> {
  await db.execute(
    `UPDATE outbox SET attempts = max(attempts + 1, ${OUTBOX_MAX_ATTEMPTS}),
                       last_error = ?
     WHERE owner_key = ? AND id = ?`,
    [String(error), owner, rowId],
  );
}

/** The payload as a `last_error` can quote it: a bounded prefix. */
function quotePayload(payload: unknown): string {
  return String(payload).slice(0, 120);
}

/**
 * Parses an outbox payload that must be a JSON object; anything else
 * (corrupt text, the literal `null`, a number, an array) is one truthful
 * error, never a TypeError escaping from a later property read.
 */
function parsePayloadObject(payload: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(payload));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`outbox.payload_not_object: ${quotePayload(payload)}`);
  }
  return parsed as Record<string, unknown>;
}

/** A well formed session row: its kind and the set id its payload names. */
function parseSessionRow(row: OutboxRow): {
  kind: 'session.create' | 'session.finalize';
  sessionId: string;
  payload: Record<string, unknown>;
} {
  const kind = row['kind'];
  if (kind !== 'session.create' && kind !== 'session.finalize') {
    throw new Error(`outbox.unknown_kind: ${String(kind)}`);
  }
  const payload = parsePayloadObject(row['payload']);
  const id = payload['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(
      `outbox.payload_missing_id: ${quotePayload(JSON.stringify(id))}`,
    );
  }
  return { kind, sessionId: id, payload };
}

/**
 * What a drain does with a shot the server rejected `shot.session_not_found`
 * for session `sessionId`, decided by SQL over the whole outbox at that
 * moment, in order:
 *
 *  1. The set's `session.create` row is exhausted: the shot is parked
 *     (SESSION_ORPHANED_VERDICT), attempts untouched — it was never at
 *     fault, and a later accepted session.create releases it.
 *  2. A `session.create` row for the set still has budget: an ordering
 *     artifact (the set is created by a session pass), transient, attempts
 *     untouched.
 *  3. No queue entry names the set but the local session row exists — the
 *     capture flow was interrupted between the shot and its set, or the
 *     server accepted the set and still refuses the shot. While the set's
 *     re-arm budget lasts (SESSION_REARM_LIMIT, persisted), re-queue the set
 *     from that row (the server upsert is idempotent) and count the attempt
 *     on the shot; the attempt that would spend the shot's own budget parks
 *     it instead, uncharged, so the set's acceptance revives it. Once the
 *     re-arm budget is spent the attempt is counted and the shot is held —
 *     offered again only when a new read joins the set (which renews the
 *     budget).
 *  4. Nothing local knows the set: the shot spends its budget one drain at a
 *     time and, when it runs out, is parked instead of exhausted — a session
 *     row that appears later (saveSession) still brings it along.
 *
 * Returns 'parked' when the row was settled without counting as a failure.
 * Runs inside the drain's exclusive turn on the connection.
 */
async function settleSessionNotFound(
  db: LocalDb,
  turn: ConnectionTurn,
  owner: string,
  row: OutboxRow,
  sessionId: string,
  message: string,
): Promise<'parked' | 'failed'> {
  const reason = `${SESSION_NOT_FOUND_REJECTION}: ${message}`;
  const state = await readSessionSetState(db, owner, sessionId);
  if (state.refused !== null) {
    await recordRowFailure(
      db,
      owner,
      row['id'],
      `${SESSION_ORPHANED_VERDICT}: ${message} ` +
        `Its practice set was refused (${state.refused}); ` +
        `this read is paused until the set is accepted.`,
      false,
    );
    return 'parked';
  }
  if (state.live) {
    await recordRowFailure(db, owner, row['id'], reason, false);
    return 'failed';
  }
  const attemptsAfter = Number(row['attempts']) + 1;
  if (state.local !== null) {
    const localSession = state.local;
    if (state.rearms >= SESSION_REARM_LIMIT) {
      await recordRowFailure(
        db,
        owner,
        row['id'],
        `${reason} Its practice set was queued again from this device ` +
          `${SESSION_REARM_LIMIT} times and accepted, yet the server still ` +
          `refuses this read; it is sent again when a new read is saved ` +
          `into the set.`,
        true,
      );
      return 'failed';
    }
    await turn.transaction(db, async () => {
      await enqueueSessionCreate(db, owner, localSession);
      await countSessionRearm(db, owner, sessionId);
      if (attemptsAfter >= OUTBOX_MAX_ATTEMPTS) {
        await recordRowFailure(
          db,
          owner,
          row['id'],
          `${SESSION_ORPHANED_VERDICT}: ${message} ` +
            `Its practice set was queued again from this device; ` +
            `this read is paused until the set is accepted.`,
          false,
        );
      } else {
        await recordRowFailure(
          db,
          owner,
          row['id'],
          `${reason} Its practice set was queued again from this device.`,
          true,
        );
      }
    });
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
 * The drain that is running for each owner of the store. A second
 * `drainOutbox` for the same owner (a new sync-runtime generation installed
 * while the previous generation's drain still awaits the server) waits for
 * the running one to finish instead of interleaving with it: both would read
 * the same rows, offer the same shots and settle the same verdicts twice.
 * Keyed by owner alone for the same reason the connection queue in
 * transaction.ts is process-wide: the `LocalDb` handle is a facade over the
 * one connection, not an identity for it.
 */
const runningDrains = new Map<string, Promise<void>>();

export function drainOutbox(
  db: LocalDb,
  transport: SyncTransport,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const owner = getActiveDataOwner();
  const running = runningDrains.get(owner);
  // Started synchronously when nothing runs for the owner, so the drain's
  // first reads are queued on the connection before anything the caller
  // does next (its unit of work is fixed the moment it starts).
  const drain = running
    ? running.then(() => drainOwnerOutbox(db, transport, owner))
    : drainOwnerOutbox(db, transport, owner);
  const settled = drain.then(
    () => undefined,
    () => undefined,
  );
  runningDrains.set(owner, settled);
  void settled.then(() => {
    if (runningDrains.get(owner) === settled) runningDrains.delete(owner);
  });
  return drain;
}

async function drainOwnerOutbox(
  db: LocalDb,
  transport: SyncTransport,
  owner: string,
): Promise<{ synced: number; failed: number; remaining: number }> {
  let synced = 0;
  let failed = 0;

  // Every statement group this drain issues runs in an exclusive turn on the
  // connection (see transaction.ts): its reads see only committed rows and
  // its writes never land inside a repository transaction that may still
  // roll back. The turn is held around one statement group at a time and
  // NEVER across a network await: a save that arrives while the drain is
  // out on the network takes the connection, commits, and the drain's next
  // statement group runs after it.
  //
  // The turn is also owner-fenced: the owner's bucket may be purged (account
  // deletion) while a request is in flight. Once the purge generation moved,
  // no statement of this drain runs again — not even the receipt for a shot
  // the server just accepted — so nothing is written back into a bucket that
  // no longer exists. The rows are gone with the bucket; there is nothing
  // left to retry.
  const generation = ownerPurgeGeneration(owner);
  let purged = false;
  const store = <T>(
    work: (turn: ConnectionTurn) => Promise<T>,
  ): Promise<T | undefined> =>
    runExclusive(turn => {
      if (ownerPurgeGeneration(owner) !== generation) purged = true;
      return purged ? Promise.resolve(undefined) : work(turn);
    });
  const readPage =
    (pass: OutboxPass) =>
    async (cursor: number): Promise<OutboxRow[]> =>
      (await store(() => selectOutboxPage(db, owner, pass, cursor))) ?? [];
  // The final count is a plain read of what the owner key holds now — after
  // a purge that is whatever a new incarnation of the owner has saved since.
  const remaining = async () => {
    const left = await runExclusive(() =>
      db.execute(`SELECT count(*) AS n FROM outbox WHERE owner_key = ?`, [
        owner,
      ]),
    );
    return { synced, failed, remaining: Number(left.rows[0]?.['n'] ?? 0) };
  };

  // The drain's unit of work is fixed the moment it starts: the first page of
  // each pass is read before anything else, in one turn, so a rating or set
  // saved while this drain is already running is left for the next one
  // instead of being pulled in half-way through.
  const [firstSessionPage, firstShotPage] = (await store(async () => [
    await selectOutboxPage(db, owner, SESSION_PASS, 0),
    await selectOutboxPage(db, owner, SHOT_PASS, 0),
  ])) ?? [[], []];

  // Sessions FIRST, across the whole backlog: `apply_synced_shot` rejects a
  // shot whose sessionId the server has never seen ("shot.session_not_found"),
  // and a practice set's session.create row is queued right behind its first
  // shot. Session creation is idempotent server-side, so draining it ahead of
  // the shots costs nothing when it was already accepted.
  //
  // Whether a set is live, refused or unknown is decided per shot by SQL at
  // offer time (readSessionSetState). The session pass only remembers what
  // IT did this drain, which no query can tell apart from older history:
  //  - `refusedThisDrain`: sets the server refused with budget left, so the
  //    shots held behind them can say why (the hold itself is SQL-decided);
  //  - `diedThisDrain`: sets whose row this pass exhausted — their shots are
  //    offered once so the server's own verdict on the read is what parks
  //    them; a set found already exhausted parks its shots without a call.
  const refusedThisDrain = new Map<string, string>();
  const diedThisDrain = new Set<string>();
  await forEachOutboxPage(
    readPage(SESSION_PASS),
    SESSION_PASS,
    async rows => {
      let reachable = true;
      for (const r of rows) {
        if (purged) return false;
        let parsed: ReturnType<typeof parseSessionRow>;
        try {
          parsed = parseSessionRow(r);
        } catch (error) {
          await store(async () => {
            await quarantineRow(db, owner, r['id'], error);
            failed++;
          });
          continue;
        }
        const { kind, sessionId, payload } = parsed;
        const attempts = Number(r['attempts']);
        try {
          if (kind === 'session.create') {
            await transport.createSession(payload);
            await store(async turn => {
              await turn.transaction(db, () =>
                retireAcceptedSessionCreate(db, owner, r['id'], sessionId),
              );
              diedThisDrain.delete(sessionId);
              refusedThisDrain.delete(sessionId);
              synced++;
            });
          } else {
            await transport.finalizeSession(sessionId);
            await store(async () => {
              await db.execute(
                `DELETE FROM outbox WHERE owner_key = ? AND id = ?`,
                [owner, r['id']],
              );
              synced++;
            });
          }
        } catch (error) {
          const permanent = isPermanentSyncFailure(error);
          await store(async () => {
            await recordRowFailure(db, owner, r['id'], error, permanent);
            failed++;
          });
          if (!permanent) reachable = false;
          if (kind === 'session.create' && permanent) {
            if (attempts + 1 >= OUTBOX_MAX_ATTEMPTS) {
              diedThisDrain.add(sessionId);
            } else {
              refusedThisDrain.set(sessionId, String(error));
            }
          }
        }
      }
      return reachable && !purged;
    },
    firstSessionPage,
  );

  const drainShotPage = async (shotRows: OutboxRow[]): Promise<boolean> => {
    // A row whose payload cannot become a sync request (corrupt JSON, missing
    // permit) is quarantined alone, in one step; it never poisons the batch.
    const candidates: Array<{
      row: OutboxRow;
      shotId: string;
      sessionId: string | null;
      parked: boolean;
      payload: Record<string, unknown>;
    }> = [];
    const malformed: Array<{ row: OutboxRow; error: unknown }> = [];
    for (const r of shotRows) {
      try {
        const analysis = parsePayloadObject(
          r['payload'],
        ) as unknown as ShotAnalysis & { analysisPermitId?: unknown };
        if (typeof analysis.id !== 'string' || analysis.id.length === 0) {
          throw new Error('shot.sync_missing_id');
        }
        if (typeof analysis.analysisPermitId !== 'string') {
          throw new Error('shot.sync_missing_analysis_permit');
        }
        if (!Array.isArray(analysis.checkpoints)) {
          throw new Error('shot.sync_missing_checkpoints');
        }
        candidates.push({
          row: r,
          shotId: analysis.id,
          sessionId:
            typeof analysis.sessionId === 'string' ? analysis.sessionId : null,
          parked: isSessionOrphanedVerdict(
            typeof r['last_error'] === 'string' ? r['last_error'] : null,
          ),
          payload: toSyncPayload(analysis, analysis.analysisPermitId),
        });
      } catch (error) {
        malformed.push({ row: r, error });
      }
    }
    // One statement group: charge the malformed rows, then decide every
    // shot's fate from the outbox as it is NOW — parked shots wait (the
    // session pass revives their set; a parked shot whose set has no queue
    // row at all re-queues it from local_session, within the re-arm budget),
    // shots of a live set are held, shots of a set already refused are
    // parked without a call, shots of a set that spent its re-arm budget are
    // held until a new read joins it.
    const entries: typeof candidates = [];
    // Shots that belong to no set, on a page with nothing to charge, need no
    // decision: they are offered as read (the fenced accept below still
    // checks that each row exists before a receipt is written).
    if (
      malformed.length === 0 &&
      candidates.every(entry => entry.sessionId === null && !entry.parked)
    ) {
      entries.push(...candidates);
    }
    const settledWithoutCall =
      entries.length > 0
        ? !purged
        : await store(async turn => {
            for (const { row, error } of malformed) {
              await quarantineRow(db, owner, row['id'], error);
              failed++;
            }
            // The page was read when the drain started; the session pass since
            // then may have released parked shots (their set was accepted) or a
            // purge/retire may have removed rows. Each shot is judged on the row
            // as it is NOW, in the same turn that offers it.
            const current = new Map<number, OutboxRow>();
            if (candidates.length > 0) {
              const { rows } = await db.execute(
                `SELECT id, attempts, last_error FROM outbox
           WHERE owner_key = ? AND id IN (${candidates
             .map(() => '?')
             .join(', ')})`,
                [owner, ...candidates.map(entry => Number(entry.row['id']))],
              );
              for (const row of rows) current.set(Number(row['id']), row);
            }
            const states = new Map<string, SessionSetState>();
            for (const entry of candidates) {
              const fresh = current.get(Number(entry.row['id']));
              if (!fresh) continue;
              entry.row = { ...entry.row, ...fresh };
              entry.parked = isSessionOrphanedVerdict(
                typeof fresh['last_error'] === 'string'
                  ? fresh['last_error']
                  : null,
              );
              if (entry.sessionId === null) {
                if (!entry.parked) entries.push(entry);
                continue;
              }
              const sessionId = entry.sessionId;
              let state = states.get(sessionId);
              if (!state) {
                state = await readSessionSetState(db, owner, sessionId);
                states.set(sessionId, state);
              }
              if (entry.parked) {
                const local = state.local;
                if (
                  !state.live &&
                  state.refused === null &&
                  local !== null &&
                  state.rearms < SESSION_REARM_LIMIT
                ) {
                  await turn.transaction(db, async () => {
                    await enqueueSessionCreate(db, owner, local);
                    await countSessionRearm(db, owner, sessionId);
                  });
                  states.set(sessionId, {
                    live: true,
                    refused: null,
                    local: null,
                    rearms: 0,
                  });
                }
                continue;
              }
              if (state.live) {
                const refusal = refusedThisDrain.get(sessionId);
                if (refusal !== undefined) {
                  await recordRowFailure(
                    db,
                    owner,
                    entry.row['id'],
                    `${SESSION_NOT_FOUND_REJECTION}: The server refused this ` +
                      `read's practice set (${refusal}); the set is asked for ` +
                      `again before this read is sent.`,
                    false,
                  );
                }
                continue;
              }
              if (state.refused !== null) {
                if (diedThisDrain.has(sessionId)) {
                  entries.push(entry);
                  continue;
                }
                await recordRowFailure(
                  db,
                  owner,
                  entry.row['id'],
                  `${SESSION_ORPHANED_VERDICT}: Its practice set was refused ` +
                    `(${state.refused}); this read is paused until the set is ` +
                    `accepted.`,
                  false,
                );
                continue;
              }
              // The set was queued again from this device SESSION_REARM_LIMIT
              // times and accepted, yet the server refused this read each
              // time: it is held, uncharged and with the reason on the row,
              // until a new read saved into the set resets the budget. A shot
              // the accepted create released this drain is still offered once
              // — the server's verdict on it is what settles it.
              if (
                state.local !== null &&
                state.rearms >= SESSION_REARM_LIMIT &&
                !isSessionReleasedMarker(
                  typeof entry.row['last_error'] === 'string'
                    ? entry.row['last_error']
                    : null,
                )
              ) {
                const held =
                  `${SESSION_NOT_FOUND_REJECTION}: Its practice set was ` +
                  `queued again from this device ${SESSION_REARM_LIMIT} ` +
                  `times and accepted, yet the server still refuses this ` +
                  `read; it is sent again when a new read is saved into ` +
                  `the set.`;
                if (entry.row['last_error'] !== held) {
                  await recordRowFailure(
                    db,
                    owner,
                    entry.row['id'],
                    held,
                    false,
                  );
                }
                continue;
              }
              entries.push(entry);
            }
            return true;
          });
    if (settledWithoutCall === undefined || purged) return false;
    if (entries.length === 0) return true;
    try {
      const response = await transport.syncShots(
        entries.map(entry => entry.payload),
      );
      const accepted = new Set(response.acceptedIds);
      const rejected = new Map(
        response.rejected.map(item => [item.id, item] as const),
      );
      await store(async turn => {
        for (const entry of entries) {
          if (accepted.has(entry.shotId)) {
            // The receipt is written only if the row is still there to be
            // retired: an owner bucket purged after this turn was fenced can
            // never be re-populated by a stale accept. If the receipt cannot
            // be persisted the row keeps its attempt count (the server did
            // not refuse it) and the page stops here: this row and the ones
            // after it are offered again by the next drain, and
            // `apply_synced_shot` accepts a replayed id.
            try {
              await turn.transaction(db, async () => {
                await db.execute(
                  `INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id)
                   SELECT ?, 'shot.sync', ?
                   WHERE EXISTS (
                     SELECT 1 FROM outbox WHERE owner_key = ? AND id = ?
                   )`,
                  [owner, entry.shotId, owner, entry.row['id']],
                );
                await db.execute(
                  `DELETE FROM outbox WHERE owner_key = ? AND id = ?`,
                  [owner, entry.row['id']],
                );
              });
              synced++;
            } catch (error) {
              await recordRowFailure(
                db,
                owner,
                entry.row['id'],
                `shot.receipt_not_saved: The server accepted this read but ` +
                  `the receipt could not be saved on this device (${String(
                    error,
                  )}); it is sent again.`,
                false,
              );
              failed++;
              break;
            }
            continue;
          }
          const rejection = rejected.get(entry.shotId);
          if (
            rejection?.code === SESSION_NOT_FOUND_REJECTION &&
            entry.sessionId !== null
          ) {
            const settled = await settleSessionNotFound(
              db,
              turn,
              owner,
              entry.row,
              entry.sessionId,
              rejection.message,
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
      });
    } catch (error) {
      const permanent = isPermanentSyncFailure(error);
      await store(async () => {
        for (const entry of entries) {
          await recordRowFailure(db, owner, entry.row['id'], error, permanent);
          failed++;
        }
      });
      return permanent && !purged;
    }
    return !purged;
  };
  await forEachOutboxPage(
    readPage(SHOT_PASS),
    SHOT_PASS,
    drainShotPage,
    firstShotPage,
  );

  if (transport.uploadEvaluationTrials) {
    const upload = transport.uploadEvaluationTrials.bind(transport);
    await forEachOutboxPage(
      readPage(TRIAL_PASS),
      TRIAL_PASS,
      async trialRows => {
        const entries: Array<{
          row: OutboxRow;
          trial: { trialId: string };
        }> = [];
        const malformed: Array<{ row: OutboxRow; error: unknown }> = [];
        for (const r of trialRows) {
          try {
            const trial = parsePayloadObject(r['payload']) as {
              trialId: unknown;
            };
            if (typeof trial.trialId !== 'string') {
              throw new Error('evaluation.trial_missing_id');
            }
            entries.push({
              row: r,
              trial: { ...trial, trialId: trial.trialId },
            });
          } catch (error) {
            malformed.push({ row: r, error });
          }
        }
        if (malformed.length > 0) {
          await store(async () => {
            for (const { row, error } of malformed) {
              await quarantineRow(db, owner, row['id'], error);
              failed++;
            }
          });
        }
        if (purged || entries.length === 0) return !purged;
        try {
          const response = await upload(entries.map(entry => entry.trial));
          const accepted = new Set(response.acceptedTrialIds);
          const rejected = new Map(
            response.rejected.map(item => [item.trialId, item] as const),
          );
          await store(async () => {
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
          });
        } catch (error) {
          const permanent = isPermanentSyncFailure(error);
          await store(async () => {
            for (const entry of entries) {
              await recordRowFailure(
                db,
                owner,
                entry.row['id'],
                error,
                permanent,
              );
              failed++;
            }
          });
          return permanent && !purged;
        }
        return !purged;
      },
    );
  }

  return remaining();
}
