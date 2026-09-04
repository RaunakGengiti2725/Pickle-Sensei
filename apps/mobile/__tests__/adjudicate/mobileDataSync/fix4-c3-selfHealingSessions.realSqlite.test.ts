/**
 * Fix round 4 — MDS-C3 root fix + self-healing, pinned on the real SQLite
 * adapter:
 *
 *  1. `saveAnalysis(..., { session })` lands the scored shot, its shot.sync
 *     row, the practice set's `local_session` row and its `session.create`
 *     row in ONE transaction: a failure inside it leaves nothing behind, so
 *     a shot whose set no row will ever name can no longer be created.
 *  2. An already-stranded shot (local_session row exists, no session.create
 *     row — an older build died between the two commits) is repaired when
 *     the server answers `shot.session_not_found`: a session.create row is
 *     re-queued from the local row, the offer counts against the shot's
 *     budget, and the next drain delivers both.
 *  3. With no local_session row either, the shot is offered at most
 *     OUTBOX_MAX_ATTEMPTS times, then PARKED (`orphaned`, kept). A
 *     local_session row appearing later is picked up at the start of the
 *     next drain (session.create re-queued, shot un-parked and delivered).
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
import { getDb } from '../../../src/data/db';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  type LocalSessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  SESSION_ORPHANED_VERDICT,
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
const OTHER_SESSION = '34343434-0000-4000-8000-000000000001';

function sessionRow(id: string): LocalSessionInput {
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
  createdSessions: unknown[];
  offered: string[][];
}

/** Mirrors supabase/functions/api: createSession is an idempotent upsert;
 * apply_synced_shot answers `shot.session_not_found` until the owner's
 * session row exists, then accepts. */
function serverEmulator(): Emulator {
  const knownSessions = new Set<string>();
  const createdSessions: unknown[] = [];
  const offered: string[][] = [];
  return {
    knownSessions,
    createdSessions,
    offered,
    async createSession(session) {
      createdSessions.push(session);
      knownSessions.add(String((session as { id: unknown }).id));
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

async function localSessionIds(db: LocalDb): Promise<string[]> {
  const { rows } = await db.execute(
    `SELECT id FROM local_session WHERE owner_key = ? ORDER BY id`,
    [OWNER],
  );
  return rows.map(r => String(r['id']));
}

async function localShotIds(db: LocalDb): Promise<string[]> {
  const { rows } = await db.execute(
    `SELECT id FROM local_shot WHERE owner_key = ? ORDER BY id`,
    [OWNER],
  );
  return rows.map(r => String(r['id']));
}

async function sessionCreatePayloads(db: LocalDb): Promise<unknown[]> {
  const { rows } = await db.execute(
    `SELECT payload FROM outbox
     WHERE owner_key = ? AND kind = 'session.create' ORDER BY id`,
    [OWNER],
  );
  return rows.map(r => JSON.parse(String(r['payload'])) as unknown);
}

function offersOf(server: Emulator, n: number): number {
  return server.offered.flat().filter(id => id === shotId(n)).length;
}

describe('fix4 / MDS-C3: one transaction for shot + set, and self-healing for stranded shots (real SQLite)', () => {
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

  it('saveAnalysis with a new session writes shot, shot.sync, local_session and session.create atomically, and the very next drain delivers both', async () => {
    const server = serverEmulator();
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x700), sessionId: SESSION }),
      PERMIT_ID,
      { session: sessionRow(SESSION) },
    );
    const rows = await outboxRows(db, OWNER);
    expect(rows.map(r => r.kind)).toEqual(['session.create', 'shot.sync']);
    expect(await localSessionIds(db)).toEqual([SESSION]);
    expect(await localShotIds(db)).toEqual([shotId(0x700)]);

    expect(await drainOutbox(db, server)).toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    expect(server.knownSessions.has(SESSION)).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(0x700))).toBe(true);
  });

  it('a failure inside the combined save leaves no shot, no session row and no outbox row (nothing to strand)', async () => {
    // The session must be the one the rating names: a mismatch is refused
    // before any write.
    await expect(
      saveAnalysis(
        db,
        realAnalysis({ id: shotId(0x701), sessionId: SESSION }),
        PERMIT_ID,
        { session: sessionRow(OTHER_SESSION) },
      ),
    ).rejects.toThrow(/session persisted with a rating/);
    // The LAST write of the combined save (the shot.sync outbox row) fails
    // after local_session, session.create and local_shot were written:
    // everything rolls back together.
    const failingDb: LocalDb = {
      execute: (sql, params) =>
        sql.includes(`'shot.sync'`)
          ? Promise.reject(new Error('SQLITE_FULL'))
          : db.execute(sql, params),
      close() {},
    };
    await expect(
      saveAnalysis(
        failingDb,
        realAnalysis({ id: shotId(0x701), sessionId: SESSION }),
        PERMIT_ID,
        { session: sessionRow(SESSION) },
      ),
    ).rejects.toThrow('SQLITE_FULL');
    expect(await outboxRows(db, OWNER)).toEqual([]);
    expect(await localSessionIds(db)).toEqual([]);
    expect(await localShotIds(db)).toEqual([]);
  });

  it('a second scored shot of a set whose row exists leaves the row alone (no duplicate session.create); a set whose row is missing gets it with the shot', async () => {
    const server = serverEmulator();
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x710), sessionId: SESSION }),
      PERMIT_ID,
      { session: sessionRow(SESSION) },
    );
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x711), sessionId: SESSION }),
      PERMIT_ID,
      { session: sessionRow(SESSION) },
    );
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual([
      'session.create',
      'shot.sync',
      'shot.sync',
    ]);
    expect(await localSessionIds(db)).toEqual([SESSION]);

    // A continued set with no row on this device (its first analysis
    // abstained, so nothing was committed for it): the first scored shot
    // brings the row and its session.create entry along.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x712), sessionId: OTHER_SESSION }),
      PERMIT_ID,
      { session: sessionRow(OTHER_SESSION) },
    );
    expect(await localSessionIds(db)).toEqual([SESSION, OTHER_SESSION]);
    expect(await sessionCreatePayloads(db)).toEqual([
      sessionRow(SESSION),
      sessionRow(OTHER_SESSION),
    ]);
    expect(await drainOutbox(db, server)).toEqual({
      synced: 5,
      failed: 0,
      remaining: 0,
    });
    expect(server.createdSessions).toHaveLength(2);
  });

  it('a stranded shot whose set exists locally but has no session.create row re-queues the set on the first `shot.session_not_found`, counts the attempt, and is delivered next drain', async () => {
    const server = serverEmulator();
    // An older build committed the shot, then died before saveSession: the
    // local_session row exists (written here directly), the outbox has no
    // session.create row for it.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x702), sessionId: SESSION }),
      PERMIT_ID,
    );
    await db.execute(
      `INSERT INTO local_session
       (owner_key, id, mode, shot_type, focus_checkpoint, started_at)
       VALUES (?, ?, 'practice_set', 'forehand_drive', NULL, ?)`,
      [OWNER, SESSION, '2026-09-04T12:00:00.000Z'],
    );
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual([
      'shot.sync',
    ]);

    const first = await drainOutbox(db, server);
    expect(first).toMatchObject({ synced: 0, failed: 1, remaining: 2 });
    const afterFirst = await outboxRows(db, OWNER);
    const shot = afterFirst.find(r => r.kind === 'shot.sync');
    const create = afterFirst.find(r => r.kind === 'session.create');
    expect(shot?.attempts).toBe(1);
    expect(shot?.last_error).toContain(SESSION_NOT_FOUND_REJECTION);
    expect(shot?.last_error).toContain('queued again from this device');
    expect(create?.attempts).toBe(0);
    expect(await sessionCreatePayloads(db)).toEqual([sessionRow(SESSION)]);
    expect(await getShotOutboxStatus(db, shotId(0x702))).toMatchObject({
      state: 'rejected',
      attempts: 1,
    });

    const second = await drainOutbox(db, server);
    expect(second).toEqual({ synced: 2, failed: 0, remaining: 0 });
    expect(server.createdSessions).toHaveLength(1);
    expect(await hasShotSyncReceipt(db, shotId(0x702))).toBe(true);
    expect(offersOf(server, 0x702)).toBe(2);
  });

  it('with no local session row either, the shot is offered OUTBOX_MAX_ATTEMPTS times then parked as `orphaned` (kept, not offered), and a local session row appearing later is picked up by the next drain', async () => {
    const server = serverEmulator();
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x703), sessionId: SESSION }),
      PERMIT_ID,
    );

    for (let i = 1; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await drainOutbox(db, server);
      expect(await getShotOutboxStatus(db, shotId(0x703))).toMatchObject({
        state: 'rejected',
        attempts: i,
      });
    }
    const parking = await drainOutbox(db, server);
    expect(parking).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    expect(offersOf(server, 0x703)).toBe(OUTBOX_MAX_ATTEMPTS);
    const parked = await getShotOutboxStatus(db, shotId(0x703));
    expect(parked).toMatchObject({
      state: 'orphaned',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    expect(parked.state === 'orphaned' && parked.lastError).toMatch(
      new RegExp(`^${SESSION_ORPHANED_VERDICT}:`),
    );
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual([
      'shot.sync',
    ]);

    // Parked: later drains neither offer it nor count it as a failure.
    expect(await drainOutbox(db, server)).toEqual({
      synced: 0,
      failed: 0,
      remaining: 1,
    });
    expect(offersOf(server, 0x703)).toBe(OUTBOX_MAX_ATTEMPTS);

    // The set's local row appears (no session.create row for it): the next
    // drain re-queues the set, creates it, un-parks the shot and delivers it.
    await db.execute(
      `INSERT INTO local_session
       (owner_key, id, mode, shot_type, focus_checkpoint, started_at)
       VALUES (?, ?, 'practice_set', 'forehand_drive', NULL, ?)`,
      [OWNER, SESSION, '2026-09-04T12:00:00.000Z'],
    );
    expect(await drainOutbox(db, server)).toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    expect(server.knownSessions.has(SESSION)).toBe(true);
    expect(offersOf(server, 0x703)).toBe(OUTBOX_MAX_ATTEMPTS + 1);
    expect(await hasShotSyncReceipt(db, shotId(0x703))).toBe(true);
    expect(await getShotOutboxStatus(db, shotId(0x703))).toEqual({
      state: 'absent',
    });
  });

  it('a set with a live session.create row still counts as an ordering artifact: the shot keeps its budget and no duplicate session.create row is queued', async () => {
    const server = serverEmulator();
    // The set's create is refused transiently once, so the shot is offered
    // in the same drain while its session.create row is still live.
    let refuseOnce = true;
    const transport: SyncTransport = {
      ...server,
      async createSession(session) {
        if (refuseOnce) {
          refuseOnce = false;
          throw new Error('network down');
        }
        return server.createSession(session);
      },
    };
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x704), sessionId: SESSION }),
      PERMIT_ID,
      { session: sessionRow(SESSION) },
    );
    const first = await drainOutbox(db, transport);
    expect(first).toMatchObject({ synced: 0, failed: 2, remaining: 2 });
    const rows = await outboxRows(db, OWNER);
    expect(rows.filter(r => r.kind === 'session.create')).toHaveLength(1);
    const shot = rows.find(r => r.kind === 'shot.sync');
    expect(shot?.attempts).toBe(0);
    expect(shot?.last_error).toContain(SESSION_NOT_FOUND_REJECTION);
    expect(await getShotOutboxStatus(db, shotId(0x704))).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    expect(await drainOutbox(db, transport)).toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    expect(await hasShotSyncReceipt(db, shotId(0x704))).toBe(true);
  });
});
