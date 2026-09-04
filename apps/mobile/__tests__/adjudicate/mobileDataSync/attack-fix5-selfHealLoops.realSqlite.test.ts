/**
 * Adversary round 5 — MDS-C1/C2/C3 candidate `devin/fix4-mds-sqlite-a`
 * (7f1405eb). Real `node:sqlite` through the op-sqlite adapter; every
 * statement below is the one the app issues. Each test states the candidate's
 * own claim and drives the module wiring (repository.ts, sync.ts,
 * transaction.ts) to the edge where the claim stops holding.
 *
 *  A. Budget boundary: a shot without a session.create row spends one attempt
 *     per `shot.session_not_found`; the candidate says that once the budget
 *     is spent the shot is PARKED and revived when a session row for its set
 *     appears. When the local_session row appears while the shot still has
 *     exactly ONE attempt left, the re-queue path counts that attempt, the
 *     row lands at OUTBOX_MAX_ATTEMPTS with a `shot.session_not_found:` verdict
 *     (state `exhausted`, not `orphaned`), and the very session.create it
 *     just re-queued is accepted on the next drain WITHOUT un-parking it: the
 *     rating is never offered again although the server now knows its set.
 *
 *  B. `queuedSessions` is only what the session pass VISITED. A transient
 *     failure (429/5xx) on page 1 stops the session pass, but the shot pass
 *     still runs: a shot whose live session.create row sits on page 2 is
 *     answered `shot.session_not_found`, mis-read as "no row anywhere", a
 *     DUPLICATE session.create row is inserted from the local row and the
 *     shot's budget is charged for an ordering artifact.
 *
 *  C. Two drains for the same owner (an old generation still in flight when
 *     `configureSyncRuntime` installs a new one) both run the parked-set
 *     pre-loop's check-then-insert outside any transaction: both see "no
 *     session.create row" and both insert one.
 */
import type { LocalDb } from '../../../src/data/db';
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { ApiError } from '../../../src/data/api';
import { getDb } from '../../../src/data/db';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const SESSION = '12121212-0000-4000-8000-000000000001';

function sessionUuid(n: number): string {
  return `5e551011-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function sessionRow(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-09-04T12:00:00.000Z',
  };
}

interface Emulator extends SyncTransport {
  knownSessions: Set<string>;
  createCalls: string[];
  offered: string[][];
  /** Throw this from createSession(id) once, then behave normally. */
  failCreateOnce: Map<string, Error>;
}

/** Mirrors supabase/functions/api: createSession is an idempotent upsert;
 * apply_synced_shot answers `shot.session_not_found` until the owner's
 * session row exists, then accepts. */
function serverEmulator(): Emulator {
  const knownSessions = new Set<string>();
  const createCalls: string[] = [];
  const offered: string[][] = [];
  const failCreateOnce = new Map<string, Error>();
  return {
    knownSessions,
    createCalls,
    offered,
    failCreateOnce,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      createCalls.push(id);
      const fault = failCreateOnce.get(id);
      if (fault) {
        failCreateOnce.delete(id);
        throw fault;
      }
      knownSessions.add(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      const ids: string[] = [];
      for (const raw of shots) {
        const shot = raw as { id: string; sessionId: string | null };
        ids.push(shot.id);
        if (shot.sessionId && !knownSessions.has(shot.sessionId)) {
          rejected.push({
            id: shot.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          });
        } else {
          acceptedIds.push(shot.id);
        }
      }
      offered.push(ids);
      return { acceptedIds, rejected };
    },
  };
}

async function insertLocalSession(db: LocalDb, id: string): Promise<void> {
  await db.execute(
    `INSERT INTO local_session (owner_key, id, mode, shot_type, focus_checkpoint, started_at)
     VALUES (?, ?, 'practice_set', 'forehand_drive', NULL, '2026-09-04T12:00:00.000Z')`,
    [OWNER, id],
  );
}

async function pushOutbox(
  db: LocalDb,
  kind: string,
  payload: unknown,
): Promise<void> {
  await db.execute(
    `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)`,
    [OWNER, kind, JSON.stringify(payload)],
  );
}

async function sessionCreateIds(db: LocalDb): Promise<string[]> {
  const { rows } = await db.execute(
    `SELECT payload FROM outbox
     WHERE owner_key = ? AND kind = 'session.create' ORDER BY id`,
    [OWNER],
  );
  return rows.map(r => (JSON.parse(String(r['payload'])) as { id: string }).id);
}

function offersOf(server: Emulator, n: number): number {
  return server.offered.flat().filter(id => id === shotId(n)).length;
}

describe('attack fix5 / MDS-C3 self-heal loops (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await db.execute(`DELETE FROM outbox`);
    await db.execute(`DELETE FROM local_shot`);
    await db.execute(`DELETE FROM local_session`);
    await db.execute(`DELETE FROM sync_receipt`);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('A. a local_session row that appears with ONE attempt left must not turn the shot terminal: the set is created on the next drain and the rating is delivered', async () => {
    // Stranded shot from an older build: no local_session row and no
    // session.create row anywhere (the candidate's own scenario 3).
    await pushOutbox(db, 'shot.sync', {
      ...realAnalysis({ id: shotId(1), sessionId: SESSION }),
      analysisPermitId: PERMIT_ID,
    });
    const server = serverEmulator();

    for (let i = 1; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(db, server);
    }
    expect(offersOf(server, 1)).toBe(OUTBOX_MAX_ATTEMPTS - 1);
    expect(await getShotOutboxStatus(db, shotId(1))).toMatchObject({
      state: 'rejected',
      attempts: OUTBOX_MAX_ATTEMPTS - 1,
    });

    // The set's row appears on this device (the same event the candidate
    // pins one drain later, after parking).
    await insertLocalSession(db, SESSION);

    // Offer #OUTBOX_MAX_ATTEMPTS: session_not_found, no session.create row →
    // the candidate re-queues the set from the local row AND charges the
    // attempt.
    const last = await drainOutbox(db, server);
    expect(last).toMatchObject({ synced: 0, failed: 1 });
    expect(await sessionCreateIds(db)).toEqual([SESSION]);

    // The next drain creates the set on the server …
    const recovery = await drainOutbox(db, server);
    expect(server.knownSessions.has(SESSION)).toBe(true);
    expect(recovery.synced).toBeGreaterThanOrEqual(1);
    // … and one more drain is allowed for the shot itself.
    await drainOutbox(db, server);

    // EXPECTED (candidate claim: parked-then-revived, "the next drain
    // delivers both"): the shot is offered once more and receipted.
    // OBSERVED: attempts == OUTBOX_MAX_ATTEMPTS with a `shot.session_not_found:
    // … queued again` verdict → state `exhausted`, excluded from every shot
    // pass, never un-parked (only `shot.session_orphaned:` rows are), so the
    // rating is lost although its set is now on the server.
    const status = await getShotOutboxStatus(db, shotId(1));
    expect(status).not.toMatchObject({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    expect(offersOf(server, 1)).toBe(OUTBOX_MAX_ATTEMPTS + 1);
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(await outboxRows(db, OWNER)).toHaveLength(0);
  });

  it('B. a transient createSession failure on page 1 must not make page-2 sets look queue-less: no duplicate session.create, no budget charged for the ordering artifact', async () => {
    // A whole-backlog drain: 51 practice sets queued (page size is 50), each
    // with its local_session row and its session.create row, exactly as
    // saveAnalysis(...,{session}) writes them. The shot belongs to the 51st.
    const sessionCount = 51;
    for (let n = 1; n <= sessionCount; n += 1) {
      await insertLocalSession(db, sessionUuid(n));
      await pushOutbox(db, 'session.create', sessionRow(sessionUuid(n)));
    }
    const lastSession = sessionUuid(sessionCount);
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: lastSession }),
      PERMIT_ID,
      { session: sessionRow(lastSession) },
    );
    expect(await sessionCreateIds(db)).toHaveLength(sessionCount);

    const server = serverEmulator();
    // The per-user route budget answers ONE createSession with 429 (the
    // outbox treats 429 as transient, by design).
    server.failCreateOnce.set(
      sessionUuid(1),
      new ApiError(429, 'rate_limited', 'Too many requests.'),
    );

    const result = await drainOutbox(db, server);
    expect(result.synced).toBeGreaterThan(0);

    // EXPECTED: the set of the rejected shot has a LIVE session.create row
    // (never visited only because the pass stopped early) → ordering
    // artifact: budget untouched, exactly one session.create row for it.
    // OBSERVED: a second session.create row for the same set is inserted and
    // the shot is charged one attempt.
    const creates = await sessionCreateIds(db);
    expect(creates.filter(id => id === lastSession)).toHaveLength(1);
    expect(await getShotOutboxStatus(db, shotId(1))).toMatchObject({
      attempts: 0,
    });
    // Added on this base (d29b95f5 already decided liveness by SQL, so the
    // two assertions above held there): the stricter invariant is that a
    // shot whose set is still queued is not offered at all — no doomed round
    // trip, no `session_not_found` verdict written for an ordering artifact.
    expect(offersOf(server, 1)).toBe(0);
    expect(await getShotOutboxStatus(db, shotId(1))).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
  });

  it('C. two drains of one owner running together must not both re-queue the same parked set', async () => {
    // A parked shot whose set has a local_session row but no session.create
    // row (the candidate's un-park path).
    await insertLocalSession(db, SESSION);
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'shot.sync', ?, ?, ?)`,
      [
        OWNER,
        JSON.stringify({
          ...realAnalysis({ id: shotId(1), sessionId: SESSION }),
          analysisPermitId: PERMIT_ID,
        }),
        OUTBOX_MAX_ATTEMPTS,
        'shot.session_orphaned: Session not found for this shot. No practice set for it is queued on this device.',
      ],
    );
    const server = serverEmulator();
    const live = mockSqlite.opened[mockSqlite.opened.length - 1];
    if (!live) throw new Error('no connection opened');
    const logStart = live.log.length;

    // configureSyncRuntime() after a sign-out/sign-in of the same account
    // starts a new generation while the previous generation's drain is still
    // awaiting the store; both are bound to the same owner.
    await Promise.all([drainOutbox(db, server), drainOutbox(db, server)]);

    // EXPECTED: one session.create row for the set was ever queued (the
    // server upsert is idempotent, but the outbox must not hold two rows for
    // the same set — the candidate's "no duplicate session.create" claim).
    // OBSERVED: both drains pass hasQueuedSessionCreate → both insert.
    const inserted = live.log
      .slice(logStart)
      .filter(sql => /INSERT INTO outbox[\s\S]*'session\.create'/.test(sql));
    expect(inserted).toHaveLength(1);
    expect(server.createCalls.filter(id => id === SESSION)).toHaveLength(1);
    expect(await sessionCreateIds(db)).toHaveLength(0);
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
  });
});
