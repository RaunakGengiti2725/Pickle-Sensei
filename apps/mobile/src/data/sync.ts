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
   * pass can recognise the sets the server has refused; the shot pass opts
   * parked shots back in so the drain that finally lands their session can
   * offer them at once.
   */
  budgetSql: string;
}

const SESSION_PASS: OutboxPass = {
  kindSql: `kind NOT IN ('shot.sync', 'evaluation.trial')`,
  accepts: kind => kind !== 'shot.sync' && kind !== 'evaluation.trial',
  budgetSql: `(attempts < ? OR kind = 'session.create')`,
};
const SHOT_PASS: OutboxPass = {
  kindSql: `kind = 'shot.sync'`,
  accepts: kind => kind === 'shot.sync',
  budgetSql: `(attempts < ? OR last_error LIKE '${SESSION_ORPHANED_VERDICT}:%')`,
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
 * OUTBOX_MAX_ATTEMPTS offers, never an open-ended loop, and a set nobody
 * adds to stays exhausted. Runs inside the caller's transaction.
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
 * of the set parked under SESSION_ORPHANED_VERDICT becomes deliverable again
 * with a fresh budget — its failures were all about the missing session.
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
 * What a drain does with a shot the server rejected `shot.session_not_found`
 * for session `sessionId`, in order:
 *
 *  1. The set's `session.create` row is exhausted (`deadSession`): the shot
 *     is parked (SESSION_ORPHANED_VERDICT), attempts untouched — it was never
 *     at fault, and a later accepted session.create releases it.
 *  2. A `session.create` row for the set still has budget — decided by SQL
 *     over the whole outbox, not by what this drain's session pass got to
 *     visit: an ordering artifact (the set is created by a session pass),
 *     transient, attempts untouched.
 *  3. No queue entry names the set but the local session row exists — the
 *     capture flow was interrupted between the shot and its set: re-queue
 *     the set from that row (the server upsert is idempotent) and count the
 *     attempt on the shot, so a server that keeps refusing the shot after
 *     the set landed is bounded by the shot's own budget. The one attempt
 *     that would spend that budget is not counted: the shot is parked
 *     instead, so the set's acceptance revives it rather than leaving it
 *     exhausted with its set on the server.
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
  deadSession: string | undefined,
): Promise<'parked' | 'failed'> {
  const reason = `${SESSION_NOT_FOUND_REJECTION}: ${message}`;
  const refused =
    deadSession ?? (await exhaustedSessionCreateVerdict(db, owner, sessionId));
  if (refused !== null) {
    await recordRowFailure(
      db,
      owner,
      row['id'],
      `${SESSION_ORPHANED_VERDICT}: ${message} ` +
        `Its practice set was refused (${refused}); ` +
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
  const localSession = await readLocalSession(db, owner, sessionId);
  if (localSession !== null) {
    await turn.transaction(db, async () => {
      await enqueueSessionCreate(db, owner, localSession);
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

  // Every statement this drain issues runs in an exclusive turn on the
  // connection (see transaction.ts): its reads see only committed rows and
  // its writes never land inside a repository transaction that may still
  // roll back. Nothing is held while the drain awaits the network.
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
  // A session.create row that spent its budget names a set the server has
  // refused; its id is kept so the shot pass can park that set's shots
  // instead of retrying them forever. A later session.create for the same id
  // that IS accepted moves the id to `createdSessions`: its parked shots were
  // released in the same transaction and are offered in this drain.
  //
  // A set whose row is still live but did not reach the server this drain
  // (`liveSessions`: a transient failure, or a page the pass never got to)
  // keeps its shots off the wire — the server could only refuse them for a
  // purely local ordering artifact. A set the server DID refuse this drain
  // with budget left (`refusedSessions`) does not hold its shots back: the
  // server's own verdict on the shot is authoritative and, while the set's
  // row is live, `shot.session_not_found` costs the shot nothing.
  const deadSessions = new Map<string, string>();
  const createdSessions = new Set<string>();
  const liveSessions = new Set<string>();
  const refusedSessions = new Set<string>();
  await forEachOutboxPage(
    readPage(SESSION_PASS),
    SESSION_PASS,
    async rows => {
      let reachable = true;
      for (const r of rows) {
        if (purged) return false;
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
          await store(async () => {
            await recordRowFailure(db, owner, r['id'], error, true);
            failed++;
          });
          continue;
        }
        const sessionId = String(payload['id']);
        if (Number(r['attempts']) >= OUTBOX_MAX_ATTEMPTS) {
          deadSessions.set(sessionId, String(r['last_error'] ?? ''));
          continue;
        }
        try {
          if (r['kind'] === 'session.create') {
            await transport.createSession(payload);
            await store(async turn => {
              await turn.transaction(db, () =>
                retireAcceptedSessionCreate(db, owner, r['id'], sessionId),
              );
              deadSessions.delete(sessionId);
              createdSessions.add(sessionId);
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
          if (r['kind'] === 'session.create') {
            if (!permanent) {
              liveSessions.add(sessionId);
            } else if (Number(r['attempts']) + 1 >= OUTBOX_MAX_ATTEMPTS) {
              deadSessions.set(sessionId, String(error));
            } else {
              refusedSessions.add(sessionId);
            }
          }
        }
      }
      return reachable && !purged;
    },
    firstSessionPage,
  );

  // Sets this drain re-queued from their local_session row for a parked shot
  // whose session.create row is missing altogether (a queue entry lost by an
  // older build); one statement per set per drain.
  const requeuedSessions = new Set<string>();

  const drainShotPage = async (shotRows: OutboxRow[]): Promise<boolean> => {
    // A row whose payload cannot become a sync request (corrupt JSON, missing
    // permit) fails alone and permanently; it never poisons the whole batch.
    let entries: Array<{
      row: OutboxRow;
      shotId: string;
      sessionId: string | null;
      payload: Record<string, unknown>;
    }> = [];
    const malformed: Array<{ row: OutboxRow; error: unknown }> = [];
    const parkedSessions = new Set<string>();
    // Sets this page's shots belong to whose liveness the session pass did
    // not settle (it stopped early, or the set was queued after it ran).
    const unsettledSessions = new Set<string>();
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
        // is accepted. This page was read before the session pass, so a row
        // released by this very drain still carries the marker here; the set
        // it names is in `createdSessions` and the shot is offered now.
        if (
          isSessionOrphanedVerdict(
            typeof r['last_error'] === 'string' ? r['last_error'] : null,
          ) &&
          (sessionId === null || !createdSessions.has(sessionId))
        ) {
          if (
            sessionId !== null &&
            !deadSessions.has(sessionId) &&
            !liveSessions.has(sessionId) &&
            !refusedSessions.has(sessionId) &&
            !requeuedSessions.has(sessionId)
          ) {
            parkedSessions.add(sessionId);
          }
          continue;
        }
        if (
          sessionId !== null &&
          !createdSessions.has(sessionId) &&
          !deadSessions.has(sessionId) &&
          !liveSessions.has(sessionId) &&
          !refusedSessions.has(sessionId)
        ) {
          unsettledSessions.add(sessionId);
        }
        entries.push({
          row: r,
          shotId: analysis.id,
          sessionId,
          payload: toSyncPayload(analysis, analysis.analysisPermitId),
        });
      } catch (error) {
        malformed.push({ row: r, error });
      }
    }
    if (
      malformed.length > 0 ||
      parkedSessions.size > 0 ||
      unsettledSessions.size > 0
    ) {
      await store(async () => {
        for (const { row, error } of malformed) {
          await recordRowFailure(db, owner, row['id'], error, true);
          failed++;
        }
        // A shot whose set still has a live session.create row is not
        // offered: the server would refuse it for a purely local ordering
        // artifact. Decided by SQL over the whole outbox, not by what this
        // drain's session pass got to visit.
        for (const sessionId of unsettledSessions) {
          if (await hasLiveSessionCreate(db, owner, sessionId)) {
            liveSessions.add(sessionId);
          }
        }
        // A parked set with a local_session row but no live session.create
        // row can only be revived by re-queueing the set from that row; the
        // insert is a no-op while a live row exists.
        for (const sessionId of parkedSessions) {
          requeuedSessions.add(sessionId);
          const localSession = await readLocalSession(db, owner, sessionId);
          if (localSession !== null) {
            await enqueueSessionCreate(db, owner, localSession);
          }
        }
      });
    }
    entries = entries.filter(
      entry => entry.sessionId === null || !liveSessions.has(entry.sessionId),
    );
    if (purged || entries.length === 0) return !purged;
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
            // never be re-populated by a stale accept.
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
            const trial = JSON.parse(String(r['payload'])) as {
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
              await recordRowFailure(db, owner, row['id'], error, true);
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
