/**
 * C3 follow-through — the contract behind the starvation fix, pinned on the
 * real SQLite adapter:
 *
 *  - a drain walks the WHOLE backlog page by page, so any number of older
 *    rows stuck in a transient rejection (here: 60 shots the server keeps
 *    answering `shot.write_failed`) only delay a newer practice set, never
 *    strand it;
 *  - a shot rejected `shot.session_not_found` while its own `session.create`
 *    row is merely queued behind it is an ordering artifact: the session is
 *    created in the same drain and the shot keeps its full budget;
 *  - a shot rejected `shot.session_not_found` whose `session.create` row has
 *    spent its budget is settled with the `shot.session_orphaned` verdict:
 *    its attempt count is untouched, it is never sent again, and
 *    getShotOutboxStatus reports `orphaned` instead of `queued`.
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
  saveSession,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_CREATE_REARM_BOUND,
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
const DEAD_SESSION = 'dddddddd-0000-4000-8000-000000000001';
const LATE_SESSION = 'eeeeeeee-0000-4000-8000-000000000001';
const NEW_SESSION = 'ffffffff-0000-4000-8000-000000000001';

interface Emulator extends SyncTransport {
  knownSessions: Set<string>;
  /** Every shot id the server was asked to write, per drain call. */
  offered: string[][];
  /** Every session id the server was asked to create, in order. */
  created: string[];
  /** Shot ids the server keeps refusing with the transient write_failed. */
  flaky: Set<string>;
}

function serverEmulator(): Emulator {
  const knownSessions = new Set<string>();
  const offered: string[][] = [];
  const created: string[] = [];
  const flaky = new Set<string>();
  return {
    knownSessions,
    offered,
    created,
    flaky,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      created.push(id);
      if (id === DEAD_SESSION) {
        throw new ApiError(
          409,
          'session.id_conflict',
          'Session id belongs to another user.',
        );
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
        if (flaky.has(shot.id)) {
          rejected.push({
            id: shot.id,
            code: 'shot.write_failed',
            message: 'Shot could not be written.',
          });
        } else if (shot.sessionId && !knownSessions.has(shot.sessionId)) {
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

async function saveShot(
  db: LocalDb,
  n: number,
  sessionId: string | null,
): Promise<void> {
  await saveAnalysis(db, realAnalysis({ id: shotId(n), sessionId }), PERMIT_ID);
}

async function queueSession(db: LocalDb, id: string): Promise<void> {
  await saveSession(db, {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  });
}

describe('C3: orphan settlement and full-backlog paging (real SQLite)', () => {
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

  it('60 shots stuck in a transient rejection do not hide a newer practice set', async () => {
    const server = serverEmulator();
    for (let n = 0; n < 60; n++) {
      await saveShot(db, 0x100 + n, null);
      server.flaky.add(shotId(0x100 + n));
    }
    await saveShot(db, 0x900, NEW_SESSION);
    await queueSession(db, NEW_SESSION);

    const result = await drainOutbox(db, server);

    expect(server.knownSessions.has(NEW_SESSION)).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(0x900))).toBe(true);
    expect(result).toMatchObject({ synced: 2, failed: 60, remaining: 60 });
    // The session was created before ANY shot was offered, and every shot
    // was offered exactly once, in id order, across two pages.
    expect(server.offered.flat()).toEqual([
      ...Array.from({ length: 60 }, (_, n) => shotId(0x100 + n)),
      shotId(0x900),
    ]);
    const rows = await outboxRows(db, OWNER);
    expect(rows).toHaveLength(60);
    expect(rows.every(r => r.attempts === 0)).toBe(true);
    expect(rows.every(r => r.last_error?.startsWith('shot.write_failed'))).toBe(
      true,
    );
  });

  it('a shot whose session.create row is still queued keeps its budget and syncs in the same drain', async () => {
    const server = serverEmulator();
    await saveShot(db, 0x300, LATE_SESSION);
    await queueSession(db, LATE_SESSION);

    const result = await drainOutbox(db, server);

    expect(result).toMatchObject({ synced: 2, failed: 0, remaining: 0 });
    expect(server.knownSessions.has(LATE_SESSION)).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(0x300))).toBe(true);
  });

  it('a shot of a permanently refused practice set is settled, never re-sent, and surfaced as orphaned', async () => {
    const server = serverEmulator();
    await saveShot(db, 0x400, DEAD_SESSION);
    await queueSession(db, DEAD_SESSION);
    await saveShot(db, 0x401, DEAD_SESSION);

    // While the session row still has budget the shots would be an ordering
    // artifact (the server has not seen the set yet): they are not offered
    // at all — attempts untouched, no verdict, still simply queued.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS - 1; i++) {
      await drainOutbox(db, server);
      const shots = (await outboxRows(db, OWNER)).filter(
        r => r.kind === 'shot.sync',
      );
      expect(shots).toHaveLength(2);
      expect(shots.every(r => r.attempts === 0)).toBe(true);
      expect(shots.every(r => r.last_error === null)).toBe(true);
      expect(server.offered.some(ids => ids.includes(shotId(0x400)))).toBe(
        false,
      );
    }
    expect(await getShotOutboxStatus(db, shotId(0x400))).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    const offeredBefore = server.offered.length;

    // The drain that exhausts the session row settles its shots in one go.
    const settling = await drainOutbox(db, server);
    expect(settling).toMatchObject({ synced: 0, failed: 1, remaining: 3 });
    const rows = await outboxRows(db, OWNER);
    const create = rows.find(r => r.kind === 'session.create');
    expect(create?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    const orphans = rows.filter(r => r.kind === 'shot.sync');
    expect(orphans).toHaveLength(2);
    expect(orphans.every(r => r.attempts === 0)).toBe(true);
    expect(
      orphans.every(r =>
        r.last_error?.startsWith(`${SESSION_ORPHANED_VERDICT}:`),
      ),
    ).toBe(true);
    // The verdict carries the session row's own last_error so the Result
    // surface can name why the practice set was refused.
    expect(create?.last_error).toBe(
      'Error: Session id belongs to another user.',
    );
    expect(orphans[0]?.last_error).toContain(
      '(Error: Session id belongs to another user.)',
    );

    for (const n of [0x400, 0x401]) {
      const status = await getShotOutboxStatus(db, shotId(n));
      expect(status.state).toBe('orphaned');
      if (status.state === 'orphaned') {
        expect(status.attempts).toBe(0);
        expect(status.lastError).toContain(SESSION_ORPHANED_VERDICT);
      }
    }

    // Later drains never offer the orphans and never count them as failures.
    // Re-pinned (O1): the set they wait for IS asked for again — once per
    // drain, SESSION_CREATE_REARM_BOUND times in all without a new read
    // (durable `local_session.rearms`) — so the one failure each of those
    // drains reports is the set's refusal, not an orphan; after the bound the
    // set parks for good and later drains report nothing.
    expect(server.offered).toHaveLength(offeredBefore + 1);
    const createsBefore = server.created.length;
    const revivals: Array<{
      synced: number;
      failed: number;
      remaining: number;
    }> = [];
    for (let i = 0; i < SESSION_CREATE_REARM_BOUND + 1; i += 1) {
      revivals.push(await drainOutbox(db, server));
    }
    expect(revivals).toEqual([
      ...Array.from({ length: SESSION_CREATE_REARM_BOUND }, () => ({
        synced: 0,
        failed: 1,
        remaining: 3,
      })),
      { synced: 0, failed: 0, remaining: 3 },
    ]);
    expect(server.created).toHaveLength(
      createsBefore + SESSION_CREATE_REARM_BOUND,
    );
    expect(server.offered).toHaveLength(offeredBefore + 1);
    for (const n of [0x400, 0x401]) {
      expect(await getShotOutboxStatus(db, shotId(n))).toMatchObject({
        state: 'orphaned',
        attempts: 0,
      });
    }

    // A new practice set behind the settled rows syncs immediately.
    await saveShot(db, 0x900, NEW_SESSION);
    await queueSession(db, NEW_SESSION);
    expect(await drainOutbox(db, server)).toEqual({
      synced: 2,
      failed: 0,
      remaining: 3,
    });
    expect(await hasShotSyncReceipt(db, shotId(0x900))).toBe(true);
  });
});
