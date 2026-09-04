/**
 * ATTACK S1 — head-of-line starvation of `session.create` behind 50 shots.
 *
 * drainOutbox (src/data/sync.ts:139-143) selects `ORDER BY id ASC LIMIT 50`
 * BEFORE it reorders sessions ahead of shots, so the "sessions first" pass
 * (sync.ts:147-185) only ever sees the first 50 rows. A shot rejected with
 * `shot.session_not_found` is transient (sync.ts:101-106): attempts stay 0,
 * the row never leaves the window, and the `session.create` row at position
 * 51 is never reached — forever.
 *
 * Real production schema on node:sqlite; rows are written through the real
 * repository (saveAnalysis / saveSession), never by hand.
 */
import type { LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { ApiError } from '../../../src/data/api';
import {
  getShotOutboxStatus,
  saveAnalysis,
  saveSession,
} from '../../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS, drainOutbox } from '../../../src/data/sync';
import {
  OWNER_A,
  realAnalysis,
} from '../../../testing/attack/mobileDataSyncFixtures';
import {
  SESSION_S,
  SESSION_T,
  createSessionAwareTransport,
  loadRealGetDb,
  outboxRows,
  uuidAt,
} from '../../../testing/attack/mobileDataSync4Harness';
import { createOpSqliteModuleMock } from '../../../testing/attack/nodeSqliteOpAdapter';

const mockOpSqlite = createOpSqliteModuleMock();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options),
}));

const DRAINS = 10;

async function seedShot(
  db: LocalDb,
  n: number,
  sessionId: string,
): Promise<string> {
  const id = uuidAt(0x5a0, n);
  await saveAnalysis(db, { ...realAnalysis, id, sessionId }, uuidAt(0x9e0, n));
  return id;
}

function sessionRow(id: string) {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-27T18:00:00.000Z',
  };
}

describe('ATTACK S1 — session.create queued behind 50 shot.sync rows [real sqlite]', () => {
  let db: LocalDb;

  beforeEach(() => {
    db = loadRealGetDb()();
    setActiveDataOwner(OWNER_A);
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
  });

  it('50 shots of S ahead of S.session.create: the session is never created and remaining never shrinks over 10 drains', async () => {
    const shotIds: string[] = [];
    for (let n = 0; n < 50; n++) shotIds.push(await seedShot(db, n, SESSION_S));
    await saveSession(db, sessionRow(SESSION_S));

    const before = await outboxRows(db);
    expect(before).toHaveLength(51);
    expect(before[50]!.kind).toBe('session.create');
    expect(before.slice(0, 50).every(r => r.kind === 'shot.sync')).toBe(true);

    const transport = createSessionAwareTransport();
    const remainingHistory: number[] = [];
    const failedHistory: number[] = [];
    for (let i = 0; i < DRAINS; i++) {
      const result = await drainOutbox(db, transport);
      remainingHistory.push(result.remaining);
      failedHistory.push(result.failed);
      expect(result.synced).toBe(0);
    }

    // The session row at position 51 is never even attempted.
    expect(transport.createSessionCalls).toHaveLength(0);
    expect(transport.sessions.has(SESSION_S)).toBe(false);
    expect(remainingHistory).toEqual(Array(DRAINS).fill(51));
    expect(failedHistory).toEqual(Array(DRAINS).fill(50));
    // Every drain sent exactly the same 50 shots to the server.
    expect(transport.syncShotsCalls).toHaveLength(DRAINS);
    for (const call of transport.syncShotsCalls) expect(call).toHaveLength(50);

    // Transient classification: attempts stay 0, so the rows never fall out
    // of the window and never reach the `exhausted` state either.
    const after = await outboxRows(db);
    expect(after).toHaveLength(51);
    expect(after.slice(0, 50).every(r => r.attempts === 0)).toBe(true);
    expect(
      after
        .slice(0, 50)
        .every(
          r => r.last_error?.startsWith('shot.session_not_found') ?? false,
        ),
    ).toBe(true);
    expect(after[50]).toMatchObject({
      kind: 'session.create',
      attempts: 0,
      last_error: null,
    });
    // The UI-facing status of every stuck shot still reads "queued".
    expect(await getShotOutboxStatus(db, shotIds[0]!)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });

    // Control: the moment ONE stuck row leaves the window the session row is
    // reached and the whole set drains — proving the stall is purely the
    // LIMIT-before-prioritise ordering, not the transport.
    await db.execute(`DELETE FROM outbox WHERE id = ?`, [before[0]!.id]);
    const unblocked = await drainOutbox(db, transport);
    expect(transport.createSessionCalls).toHaveLength(1);
    expect(transport.sessions.has(SESSION_S)).toBe(true);
    // sessions-first pass creates S, then the 49 shots in the same window
    // are accepted: 1 + 49.
    expect(unblocked).toEqual({ synced: 50, failed: 0, remaining: 0 });
  });

  it('realistic route: a permanently rejected session.create orphans its shots forever (attempts stay 0) and, at 50 orphans, starves every later row for the account', async () => {
    // Production ordering (practiceSet.commitPracticeSet runs AFTER the first
    // saveAnalysis): shot#1(S), session.create(S), shot#2..50(S).
    const first = await seedShot(db, 0, SESSION_S);
    await saveSession(db, sessionRow(SESSION_S));
    for (let n = 1; n < 50; n++) await seedShot(db, n, SESSION_S);

    // The server answers session.create with a contract verdict (409
    // session.id_conflict / 400 validation.session are the two permanent codes
    // supabase/functions/api/index.ts:1296-1324 can return).
    const transport = createSessionAwareTransport({
      createSessionError: () =>
        new ApiError(
          409,
          'session.id_conflict',
          'Session id belongs to another user.',
        ),
    });

    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++)
      await drainOutbox(db, transport);
    const sessionRowAfterBudget = (await outboxRows(db)).find(
      r => r.kind === 'session.create',
    );
    expect(sessionRowAfterBudget?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);

    // A brand-new practice set T started later: shot then session.create,
    // exactly as the app queues them.
    const tShot = await seedShot(db, 99, SESSION_T);
    await saveSession(db, sessionRow(SESSION_T));

    const createCallsBefore = transport.createSessionCalls.length;
    const remaining: number[] = [];
    for (let i = 0; i < DRAINS; i++) {
      const result = await drainOutbox(db, transport);
      remaining.push(result.remaining);
      expect(result.synced).toBe(0);
      expect(result.failed).toBe(50);
    }
    // T's session.create sits at position 53 — behind 50 permanently
    // "transient" orphans (+ the exhausted S row, excluded by attempts < 8).
    expect(transport.createSessionCalls).toHaveLength(createCallsBefore);
    expect(transport.sessions.has(SESSION_T)).toBe(false);
    expect(remaining).toEqual(Array(DRAINS).fill(53));

    const rows = await outboxRows(db);
    const orphans = rows.filter(
      r => r.kind === 'shot.sync' && r.entity !== tShot,
    );
    expect(orphans).toHaveLength(50);
    expect(orphans.every(r => r.attempts === 0)).toBe(true);
    expect(await getShotOutboxStatus(db, first)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    // T's own shot was never sent either.
    expect(
      transport.syncShotsCalls.some(call =>
        (call as Array<{ id: string }>).some(s => s.id === tShot),
      ),
    ).toBe(false);
  });
});
