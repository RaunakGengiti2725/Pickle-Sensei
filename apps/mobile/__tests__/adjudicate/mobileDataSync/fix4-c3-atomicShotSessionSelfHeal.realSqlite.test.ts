/**
 * Fix round 4 (candidate B) — MDS-C3 at the root, on real SQLite:
 *
 *  1. A scored shot and its NEW practice set land in ONE serialized
 *     transaction (`saveAnalysis(..., { session })`): local_session,
 *     session.create, local_shot, shot.sync — or none of them. The capture
 *     flow can therefore no longer create a shot whose session no queue
 *     entry names.
 *  2. Already-stranded rows self-heal: `shot.session_not_found` for a shot
 *     whose local_session row exists but whose session.create row does not
 *     re-queues the set from that row (server upsert is idempotent) and
 *     counts the attempt; the next drain delivers the shot.
 *  3. When nothing local knows the set, the shot spends OUTBOX_MAX_ATTEMPTS
 *     drains and is then PARKED (user-visible `orphaned`, not offered on its
 *     own) — and the first drain after a session row appears delivers it.
 *  4. The session.create lookups are json_valid-guarded: a malformed
 *     session.create payload in the same owner's outbox is ignored, never
 *     fatal (C1 stays true for the new statements).
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
  saveSession,
  type SessionInput,
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
const SET_A = 'a4a4a4a4-0000-4000-8000-000000000001';
const SET_B = 'b4b4b4b4-0000-4000-8000-000000000002';
const SET_C = 'c4c4c4c4-0000-4000-8000-000000000003';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

interface Emulator extends SyncTransport {
  knownSessions: Set<string>;
  created: string[];
  offered: string[][];
}

/** Mirrors supabase/functions/api: createSession is an idempotent upsert;
 * apply_synced_shot answers `shot.session_not_found` until the owner's
 * session row exists, then accepts. */
function serverEmulator(): Emulator {
  const knownSessions = new Set<string>();
  const created: string[] = [];
  const offered: string[][] = [];
  return {
    knownSessions,
    created,
    offered,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      created.push(id);
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

async function sessionRows(db: LocalDb): Promise<string[]> {
  const { rows } = await db.execute(
    `SELECT id FROM local_session WHERE owner_key = ? ORDER BY id`,
    [OWNER],
  );
  return rows.map(r => String(r['id']));
}

async function shotRows(db: LocalDb): Promise<string[]> {
  const { rows } = await db.execute(
    `SELECT id FROM local_shot WHERE owner_key = ? ORDER BY id`,
    [OWNER],
  );
  return rows.map(r => String(r['id']));
}

async function sessionCreateIds(db: LocalDb): Promise<string[]> {
  const { rows } = await db.execute(
    `SELECT json_extract(payload, '$.id') AS sid FROM outbox
     WHERE owner_key = ? AND kind = 'session.create' AND json_valid(payload)
     ORDER BY id`,
    [OWNER],
  );
  return rows.map(r => String(r['sid']));
}

describe('fix4 / MDS-C3: atomic shot+session persistence and self-healing stranded rows (real SQLite)', () => {
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

  it('saveAnalysis with a new set writes local_session + session.create + local_shot + shot.sync inside ONE BEGIN IMMEDIATE…COMMIT', async () => {
    const live = mockSqlite.opened[mockSqlite.opened.length - 1]!;
    const before = live.log.length;
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x700), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    const log = live.log.slice(before);
    const begins = log.filter(s => s === 'BEGIN IMMEDIATE').length;
    const commits = log.filter(s => s === 'COMMIT').length;
    expect({ begins, commits }).toEqual({ begins: 1, commits: 1 });
    const inside = log.slice(
      log.indexOf('BEGIN IMMEDIATE') + 1,
      log.indexOf('COMMIT'),
    );
    const order = inside
      .map(s =>
        /INSERT OR REPLACE INTO local_session/.test(s)
          ? 'local_session'
          : /INSERT INTO outbox[\s\S]*'session\.create'/.test(s)
            ? 'session.create'
            : /INSERT OR REPLACE INTO local_shot/.test(s)
              ? 'local_shot'
              : /INSERT INTO outbox[\s\S]*'shot\.sync'/.test(s)
                ? 'shot.sync'
                : null,
      )
      .filter((s): s is string => s !== null);
    expect(order).toEqual([
      'local_session',
      'session.create',
      'local_shot',
      'shot.sync',
    ]);
    expect(await sessionRows(db)).toEqual([SET_A]);
    expect(await sessionCreateIds(db)).toEqual([SET_A]);
    expect(await shotRows(db)).toEqual([shotId(0x700)]);
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual([
      'session.create',
      'shot.sync',
    ]);

    // Idempotent follow-up (AnalyzeScreen's commitPracticeSet → saveSession):
    // the set is already queued, so no second session.create appears.
    await saveSession(db, setInput(SET_A));
    expect(await sessionCreateIds(db)).toEqual([SET_A]);

    // A later shot of the SAME set does not re-create the set.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x701), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    expect(await sessionRows(db)).toEqual([SET_A]);
    expect(await sessionCreateIds(db)).toEqual([SET_A]);
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual([
      'session.create',
      'shot.sync',
      'shot.sync',
    ]);
  });

  it('a failure on the shot.sync write rolls the set back too — no half-persisted practice set', async () => {
    const failing: LocalDb = {
      async execute(sql, params) {
        if (/'shot\.sync'/.test(sql)) {
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        return db.execute(sql, params);
      },
      close() {},
    };
    await expect(
      saveAnalysis(
        failing,
        realAnalysis({ id: shotId(0x710), sessionId: SET_B }),
        PERMIT_ID,
        { session: setInput(SET_B) },
      ),
    ).rejects.toThrow('SQLITE_FULL');
    expect(await sessionRows(db)).toEqual([]);
    expect(await shotRows(db)).toEqual([]);
    expect(await outboxRows(db, OWNER)).toEqual([]);
    // The connection is usable again (no orphaned BEGIN).
    await saveSession(db, setInput(SET_B));
    expect(await sessionRows(db)).toEqual([SET_B]);
  });

  it('refuses a session that is not the one the rating names', async () => {
    await expect(
      saveAnalysis(
        db,
        realAnalysis({ id: shotId(0x720), sessionId: SET_A }),
        PERMIT_ID,
        { session: setInput(SET_B) },
      ),
    ).rejects.toThrow(/must be the one the rating names/);
    expect(await outboxRows(db, OWNER)).toEqual([]);
  });

  it('self-heals a stranded shot whose local_session exists but whose session.create row is gone: re-queues the set, counts the attempt, delivers next drain', async () => {
    const server = serverEmulator();
    // A previous build's partial write: shot + local_session persisted, the
    // session.create outbox row never made it (or was lost).
    await saveSession(db, setInput(SET_C));
    await db.execute(
      `DELETE FROM outbox WHERE owner_key = ? AND kind = 'session.create'`,
      [OWNER],
    );
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x730), sessionId: SET_C }),
      PERMIT_ID,
    );
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual([
      'shot.sync',
    ]);

    const first = await drainOutbox(db, server);
    expect(first).toMatchObject({ synced: 0, failed: 1, remaining: 2 });
    expect(server.created).toEqual([]);
    const afterFirst = await outboxRows(db, OWNER);
    expect(afterFirst.map(r => r.kind)).toEqual([
      'shot.sync',
      'session.create',
    ]);
    expect(afterFirst[0]).toMatchObject({ attempts: 1 });
    expect(afterFirst[0]!.last_error).toContain(SESSION_NOT_FOUND_REJECTION);
    expect(afterFirst[0]!.last_error).toContain('queued again');
    expect(await sessionCreateIds(db)).toEqual([SET_C]);
    // Inside its budget and NOT parked: the Result screen shows it retrying.
    expect(await getShotOutboxStatus(db, shotId(0x730))).toMatchObject({
      state: 'rejected',
      attempts: 1,
    });

    const second = await drainOutbox(db, server);
    expect(second).toMatchObject({ synced: 2, failed: 0, remaining: 0 });
    expect(server.created).toEqual([SET_C]);
    expect(await hasShotSyncReceipt(db, shotId(0x730))).toBe(true);
    expect(await outboxRows(db, OWNER)).toEqual([]);
  });

  it('a shot nothing local can explain is offered OUTBOX_MAX_ATTEMPTS times, then parked (orphaned, retryable) and no longer offered on its own', async () => {
    const server = serverEmulator();
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x740), sessionId: SET_A }),
      PERMIT_ID,
    );
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS * 2; i++) {
      await drainOutbox(db, server);
    }
    const offered = server.offered.filter(ids => ids.includes(shotId(0x740)));
    expect(offered).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    const [row] = await outboxRows(db, OWNER);
    expect(row).toMatchObject({
      kind: 'shot.sync',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    expect(row!.last_error).toMatch(
      new RegExp(`^${SESSION_ORPHANED_VERDICT}:`),
    );
    expect(row!.last_error).toContain('paused');
    // User-visible as parked — never `exhausted`, never `queued`.
    expect(await getShotOutboxStatus(db, shotId(0x740))).toMatchObject({
      state: 'orphaned',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    expect(await sessionCreateIds(db)).toEqual([]);

    // The set appears later (a relaunch commits it): the FIRST drain after
    // that creates the session, releases the parked shot and delivers it.
    await saveSession(db, setInput(SET_A));
    const result = await drainOutbox(db, server);
    expect(result).toMatchObject({ synced: 2, failed: 0, remaining: 0 });
    expect(server.created).toEqual([SET_A]);
    expect(await hasShotSyncReceipt(db, shotId(0x740))).toBe(true);
    expect(await outboxRows(db, OWNER)).toEqual([]);
    expect(await getShotOutboxStatus(db, shotId(0x740))).toEqual({
      state: 'absent',
    });
  });

  it('a malformed session.create payload in the same outbox is ignored by the guarded lookups and cannot break the self-heal', async () => {
    const server = serverEmulator();
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', ?)`,
      [OWNER, '{"id": "not json'],
    );
    await saveSession(db, setInput(SET_B));
    await db.execute(
      `DELETE FROM outbox WHERE owner_key = ? AND kind = 'session.create'
         AND json_valid(payload)`,
      [OWNER],
    );
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x750), sessionId: SET_B }),
      PERMIT_ID,
    );

    await drainOutbox(db, server);
    // The corrupt row failed alone (permanently); the set was re-queued from
    // the local row despite the corrupt sibling.
    const rows = await outboxRows(db, OWNER);
    expect(rows.map(r => r.kind).sort()).toEqual([
      'session.create',
      'session.create',
      'shot.sync',
    ]);
    expect(await sessionCreateIds(db)).toEqual([SET_B]);
    const corrupt = rows.find(
      r => r.kind === 'session.create' && r.attempts > 0,
    );
    expect(corrupt).toBeDefined();

    await drainOutbox(db, server);
    expect(server.created).toEqual([SET_B]);
    expect(await hasShotSyncReceipt(db, shotId(0x750))).toBe(true);
    const left = await outboxRows(db, OWNER);
    expect(left.map(r => r.kind)).toEqual(['session.create']);
    expect(left[0]!.attempts).toBeGreaterThanOrEqual(2);
  });
});
