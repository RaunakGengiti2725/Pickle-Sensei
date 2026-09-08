/**
 * Adversarial probes for durable sync / outbox / receipt persistence
 * (INT-sync-outbox-persistence). Every test runs against real SQLite through
 * the production drain, repository and transport code. Each `it` is one
 * attack on a distinct failure boundary; a passing attack is evidence too.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { ApiError, createTransport } from '../../src/data/api';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  type SyncTransport,
} from '../../src/data/sync';
import {
  finishSession,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listShots,
  saveAnalysis,
  saveSession,
} from '../../src/data/repository';
import {
  DataOwnerChangedError,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  createSqliteTestDb,
  closeSqliteTestDatabases,
} from '../../testSupport/sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = {
  id: id(1),
  mode: 'practice_set',
  shotType: 'forehand_drive',
  focusCheckpoint: 'contact_position',
  startedAt: '2026-09-07T12:00:00.000Z',
};
const savedFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

function analysis(n: number, sessionId: string | null = null): ShotAnalysis {
  return {
    id: id(n),
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-07T12:00:01.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    source: 'real',
    versionVector: {
      appVersion: '1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
  };
}
const permit = (n: number) => id(n + 10000);

function ids(shots: unknown[]): string[] {
  return shots.map(shot => {
    if (
      !shot ||
      typeof shot !== 'object' ||
      !('id' in shot) ||
      typeof shot.id !== 'string'
    )
      throw new Error('Production sync emitted an invalid shot identifier');
    return shot.id;
  });
}

function accepting(): jest.Mock<
  ReturnType<SyncTransport['syncShots']>,
  Parameters<SyncTransport['syncShots']>
> {
  return jest.fn(async shots => ({ acceptedIds: ids(shots), rejected: [] }));
}

function fixture(path?: string) {
  const store = createSqliteTestDb(path);
  const push = (kind: string, payload: string, owner = OWNER) => {
    store.native
      .prepare('INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)')
      .run(owner, kind, payload);
  };
  const rows = (owner = OWNER) =>
    store.native
      .prepare('SELECT * FROM outbox WHERE owner_key = ? ORDER BY id')
      .all(owner);
  const receipts = (owner = OWNER) =>
    store.native
      .prepare(
        'SELECT entity_id FROM sync_receipt WHERE owner_key = ? ORDER BY entity_id',
      )
      .all(owner)
      .map(row => String(row['entity_id']));
  const transport: SyncTransport = {
    syncShots: accepting(),
    createSession: jest.fn(async () => {}),
    finalizeSession: jest.fn(async () => {}),
  };
  return { store, push, rows, receipts, transport };
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pickle-adv-sync-'));
  temporaryDirectories.push(directory);
  return join(directory, 'product.sqlite');
}

beforeEach(() => setActiveDataOwner(OWNER));
afterEach(() => {
  globalThis.fetch = savedFetch;
  jest.useRealTimers();
  closeSqliteTestDatabases();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('ATTACK 1 — process death between server acceptance and the receipt write', () => {
  it('replays the byte-identical payload after relaunch and ends with exactly one receipt', async () => {
    const path = temporaryDatabasePath();
    const before = fixture(path);
    await saveAnalysis(before.store.db, analysis(100), permit(100));
    await saveAnalysis(before.store.db, analysis(101), permit(101));
    const queuedBefore = before.rows().map(row => row['payload']);
    const seenByServer: string[][] = [];
    before.transport.syncShots = jest.fn(async shots => {
      seenByServer.push(ids(shots));
      return { acceptedIds: ids(shots), rejected: [] };
    });
    // The process dies while writing the receipt for the accepted batch.
    before.store.failStatementOnce(
      'INSERT OR REPLACE INTO sync_receipt',
      new Error('process killed during receipt write'),
    );
    const first = await drainOutbox(before.store.db, before.transport);
    expect(first.synced).toBe(0);
    expect(before.receipts()).toEqual([]);
    expect(before.rows().map(row => row['payload'])).toEqual(queuedBefore);
    expect(before.rows().map(row => row['attempts'])).toEqual([0, 0]);
    before.store.close();

    // Relaunch on the same file: the same rows are resent unchanged.
    const after = fixture(path);
    after.transport.syncShots = jest.fn(async shots => {
      seenByServer.push(ids(shots));
      return { acceptedIds: ids(shots), rejected: [] };
    });
    expect(after.rows().map(row => row['payload'])).toEqual(queuedBefore);
    expect(await hasShotSyncReceipt(after.store.db, id(100))).toBe(false);
    const second = await drainOutbox(after.store.db, after.transport);
    expect(second).toEqual({ synced: 2, failed: 0, remaining: 0 });
    expect(seenByServer).toEqual([
      [id(100), id(101)],
      [id(100), id(101)],
    ]);
    expect(after.receipts()).toEqual([id(100), id(101)]);
    expect(after.rows()).toEqual([]);
    expect(await hasShotSyncReceipt(after.store.db, id(100))).toBe(true);
    expect((await listShots(after.store.db)).map(row => row.id).sort()).toEqual(
      [id(100), id(101)],
    );
  });
});

describe('ATTACK 2 — account switch A→B→A between two accepted receipts of one batch', () => {
  it('commits only receipts written before the switch, keeps the rest for replay and never touches B', async () => {
    const { store, rows, receipts, transport } = fixture();
    await saveAnalysis(store.db, analysis(200), permit(200));
    await saveAnalysis(store.db, analysis(201), permit(201));
    await saveAnalysis(store.db, analysis(202), permit(202));
    setActiveDataOwner(OTHER_OWNER);
    await saveAnalysis(store.db, analysis(290), permit(290));
    setActiveDataOwner(OWNER);
    let receiptWrites = 0;
    store.observeStatements(call => {
      if (call.sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
        receiptWrites += 1;
        if (receiptWrites === 1) {
          // The user signs out into B and back into A while the first receipt
          // transaction is being written.
          setActiveDataOwner(OTHER_OWNER);
          setActiveDataOwner(OWNER);
        }
      }
    });
    await expect(drainOutbox(store.db, transport)).rejects.toBeInstanceOf(
      DataOwnerChangedError,
    );
    store.observeStatements(null);
    // At most the first receipt may have landed; nothing else moved.
    const landed = receipts();
    expect(landed.length).toBeLessThanOrEqual(1);
    const remaining = rows().map(row => String(row['payload']));
    expect(remaining.length).toBe(3 - landed.length);
    for (const entry of landed) {
      expect(remaining.some(payload => payload.includes(entry))).toBe(false);
    }
    expect(rows().every(row => row['attempts'] === 0)).toBe(true);
    expect(rows(OTHER_OWNER)).toHaveLength(1);
    expect(receipts(OTHER_OWNER)).toEqual([]);
    // A's later drain (new generation) converges without dropping anything.
    transport.syncShots = accepting();
    const again = await drainOutbox(store.db, transport);
    expect(again.remaining).toBe(0);
    expect(receipts()).toEqual([id(200), id(201), id(202)]);
    expect(rows()).toEqual([]);
    expect(rows(OTHER_OWNER)).toHaveLength(1);
    expect(receipts(OTHER_OWNER)).toEqual([]);
  });
});

describe('ATTACK 3 — corrupt shot.sync row for a real local shot', () => {
  it('never produces a receipt or empty history, exhausts alone, and survives relaunch', async () => {
    const path = temporaryDatabasePath();
    const before = fixture(path);
    await saveAnalysis(before.store.db, analysis(300), permit(300));
    await saveAnalysis(before.store.db, analysis(301), permit(301));
    // Bit-rot the first queued payload after it was durably written.
    const intact = String(
      before.store.native
        .prepare(
          `SELECT payload FROM outbox WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
        )
        .get(OWNER, id(300))?.['payload'],
    );
    before.store.native
      .prepare(
        `UPDATE outbox SET payload = ?
         WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
      )
      .run(`${intact.slice(0, 40)}\u0000###`, OWNER, id(300));
    const first = await drainOutbox(before.store.db, before.transport);
    expect(first).toEqual({ synced: 1, failed: 1, remaining: 1 });
    expect(before.transport.syncShots).toHaveBeenCalledTimes(1);
    expect(
      ids((before.transport.syncShots as jest.Mock).mock.calls[0][0]),
    ).toEqual([id(301)]);
    expect(before.receipts()).toEqual([id(301)]);
    for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await drainOutbox(before.store.db, before.transport);
    }
    expect(before.transport.syncShots).toHaveBeenCalledTimes(1);
    expect(before.rows()).toHaveLength(1);
    expect(before.rows()[0]?.['attempts']).toBe(OUTBOX_MAX_ATTEMPTS);
    const exhausted = await drainOutbox(before.store.db, before.transport);
    expect(exhausted).toEqual({ synced: 0, failed: 0, remaining: 1 });
    // The rating stays visible locally and is never reported as synced.
    expect(
      (await listShots(before.store.db)).map(row => row.id).sort(),
    ).toEqual([id(300), id(301)]);
    expect(await hasShotSyncReceipt(before.store.db, id(300))).toBe(false);
    expect(await hasShotSyncReceipt(before.store.db, id(301))).toBe(true);
    expect(await getShotOutboxStatus(before.store.db, id(300))).toEqual({
      state: 'absent',
    });
    before.store.close();
    // Relaunch: the schema/migration pass must not delete the evidence.
    const after = fixture(path);
    expect(after.rows()).toHaveLength(1);
    expect(after.rows()[0]?.['attempts']).toBe(OUTBOX_MAX_ATTEMPTS);
    expect((await listShots(after.store.db)).map(row => row.id).sort()).toEqual(
      [id(300), id(301)],
    );
    expect(after.receipts()).toEqual([id(301)]);
    expect(await drainOutbox(after.store.db, after.transport)).toEqual({
      synced: 0,
      failed: 0,
      remaining: 1,
    });
    expect(after.transport.syncShots).not.toHaveBeenCalled();
  });
});

describe('ATTACK 4 — corrupt session.create parent with dependent shots', () => {
  it('converges through session reconstruction while the corrupt parent fails alone', async () => {
    const { store, push, rows, receipts, transport } = fixture();
    await saveSession(store.db, session);
    await saveAnalysis(store.db, analysis(400, session.id), permit(400));
    await saveAnalysis(store.db, analysis(401, session.id), permit(401));
    store.native
      .prepare(
        `UPDATE outbox SET payload = '{"id":"' || ? || '","startedAt":' WHERE owner_key = ? AND kind = 'session.create'`,
      )
      .run(session.id, OWNER);
    push('session.finalize', JSON.stringify({ id: session.id }));
    // The server has never seen the session because its create row is corrupt.
    const created = new Set<string>();
    transport.createSession = jest.fn(async raw => {
      const value = raw as { id: string; startedAt: string };
      expect(value).toEqual({ id: session.id, startedAt: session.startedAt });
      created.add(value.id);
    });
    transport.finalizeSession = jest.fn(async sessionId => {
      if (!created.has(sessionId))
        throw new ApiError(404, 'session.not_found', 'Session not found');
    });
    transport.syncShots = jest.fn(async shots =>
      created.has(session.id)
        ? { acceptedIds: ids(shots), rejected: [] }
        : {
            acceptedIds: [],
            rejected: ids(shots).map(shotId => ({
              id: shotId,
              code: 'shot.session_not_found',
              message: 'Session not found',
            })),
          },
    );
    const first = await drainOutbox(store.db, transport);
    expect(first.synced).toBe(0);
    expect(receipts()).toEqual([]);
    expect(transport.createSession).not.toHaveBeenCalled();
    const corrupt = rows().find(
      row =>
        row['kind'] === 'session.create' &&
        !row['payload']?.toString().includes('startedAt":"'),
    );
    expect(corrupt?.['attempts']).toBe(1);
    // Reconstruction queued exactly one valid parent from local_session.
    const reconstructed = rows().filter(
      row =>
        row['kind'] === 'session.create' &&
        String(row['payload']).includes(`"startedAt":"${session.startedAt}"`),
    );
    expect(reconstructed).toHaveLength(1);
    expect(rows().filter(row => row['kind'] === 'shot.sync')).toHaveLength(2);
    expect(
      rows().filter(row => row['kind'] === 'session.finalize'),
    ).toHaveLength(1);
    const second = await drainOutbox(store.db, transport);
    expect(second.synced).toBeGreaterThanOrEqual(3);
    expect(transport.createSession).toHaveBeenCalledTimes(1);
    expect(receipts()).toEqual([id(400), id(401)]);
    // Only the corrupt row remains, still failing alone, never a receipt.
    expect(rows().map(row => [row['kind'], row['attempts']])).toEqual([
      ['session.create', 2],
    ]);
    expect(transport.finalizeSession).toHaveBeenCalledWith(session.id);
    expect(store.count('local_session', OWNER)).toBe(1);
  });
});

describe('ATTACK 5 — late acceptance after the client timeout', () => {
  it('keeps the row durable, never writes a receipt from the late response, and replays the same id', async () => {
    jest.useFakeTimers();
    const { store, rows, receipts } = fixture();
    await saveAnalysis(store.db, analysis(500), permit(500));
    const bodies: string[] = [];
    let release: (() => void) | undefined;
    const aborted: boolean[] = [];
    globalThis.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      const signal = init?.signal ?? null;
      if (bodies.length === 1) {
        await new Promise<void>(resolve => {
          release = resolve;
        });
        aborted.push(signal?.aborted ?? false);
      }
      const submitted = JSON.parse(bodies[bodies.length - 1] ?? '{}') as {
        shots: Array<{ id: string }>;
      };
      return new Response(
        JSON.stringify({
          acceptedIds: submitted.shots.map(shot => shot.id),
          rejected: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const transport = createTransport({
      baseUrl: 'https://api.test',
      token: 'tok',
    });
    const pending = drainOutbox(store.db, transport);
    await jest.advanceTimersByTimeAsync(20_000);
    const first = await pending;
    expect(first).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.['attempts']).toBe(0);
    expect(String(rows()[0]?.['last_error'])).toContain(
      'The server took too long to respond',
    );
    expect(receipts()).toEqual([]);
    // The server finishes the accepted write after the client gave up.
    release?.();
    await jest.advanceTimersByTimeAsync(0);
    expect(aborted).toEqual([true]);
    expect(receipts()).toEqual([]);
    expect(rows()).toHaveLength(1);
    // The retry resends the same id (server-side replay returns accepted).
    const second = await drainOutbox(store.db, transport);
    expect(second).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(receipts()).toEqual([id(500)]);
    expect(rows()).toEqual([]);
  });
});

describe('ATTACK 6 — 429 mid-flush after the parent session was created and finalized', () => {
  it('drops delivered parents, keeps shots with zero attempts, and never re-creates the session', async () => {
    const { store, rows, receipts, transport } = fixture();
    await saveSession(store.db, session);
    await saveAnalysis(store.db, analysis(600, session.id), permit(600));
    await saveAnalysis(store.db, analysis(601, session.id), permit(601));
    await finishSession(store.db, session.id, { shots: 2 });
    transport.syncShots = jest.fn(async () => {
      throw new ApiError(429, 'rate_limited', 'Slow down');
    });
    const first = await drainOutbox(store.db, transport);
    expect(transport.createSession).toHaveBeenCalledTimes(1);
    expect(transport.finalizeSession).toHaveBeenCalledTimes(1);
    expect(first.synced).toBe(2);
    expect(first.failed).toBe(2);
    expect(first.remaining).toBe(2);
    expect(rows().map(row => [row['kind'], row['attempts']])).toEqual([
      ['shot.sync', 0],
      ['shot.sync', 0],
    ]);
    expect(
      rows().every(row => String(row['last_error']).includes('Slow down')),
    ).toBe(true);
    expect(receipts()).toEqual([]);
    transport.syncShots = accepting();
    const second = await drainOutbox(store.db, transport);
    expect(second).toEqual({ synced: 2, failed: 0, remaining: 0 });
    expect(transport.createSession).toHaveBeenCalledTimes(1);
    expect(transport.finalizeSession).toHaveBeenCalledTimes(1);
    expect(ids((transport.syncShots as jest.Mock).mock.calls[0][0])).toEqual([
      id(600),
      id(601),
    ]);
    expect(receipts()).toEqual([id(600), id(601)]);
    expect(rows()).toEqual([]);
  });
});

describe('ATTACK 7 — repeated user actions (double save, double finish)', () => {
  it('delivers duplicates idempotently in dependency order and leaves one receipt per shot', async () => {
    const { store, rows, receipts, transport } = fixture();
    await saveSession(store.db, session);
    await saveSession(store.db, session);
    await saveAnalysis(store.db, analysis(700, session.id), permit(700));
    await saveAnalysis(store.db, analysis(700, session.id), permit(700));
    await finishSession(store.db, session.id, { shots: 1 });
    await finishSession(store.db, session.id, { shots: 1 });
    expect(rows()).toHaveLength(6);
    const order: string[] = [];
    transport.createSession = jest.fn(async () => {
      order.push('create');
    });
    transport.finalizeSession = jest.fn(async () => {
      order.push('finalize');
    });
    transport.syncShots = jest.fn(async shots => {
      order.push(`shots:${ids(shots).join(',')}`);
      return { acceptedIds: ids(shots), rejected: [] };
    });
    const result = await drainOutbox(store.db, transport);
    expect(result.remaining).toBe(0);
    expect(result.failed).toBe(0);
    expect(order.indexOf('create')).toBeLessThan(order.indexOf('finalize'));
    expect(order.filter(step => step.startsWith('shots:'))).toEqual([
      `shots:${id(700)}`,
    ]);
    expect(receipts()).toEqual([id(700)]);
    expect(rows()).toEqual([]);
    expect(store.count('local_session', OWNER)).toBe(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
  });
});

describe('ATTACK 8 — exhaustion boundary inside a mixed acknowledgement', () => {
  it('finalises the sibling receipt, exhausts the rejected row at the cap and never resends it', async () => {
    const { store, rows, receipts, transport } = fixture();
    await saveAnalysis(store.db, analysis(800), permit(800));
    await saveAnalysis(store.db, analysis(801), permit(801));
    store.native
      .prepare(
        `UPDATE outbox SET attempts = ? WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
      )
      .run(OUTBOX_MAX_ATTEMPTS - 1, OWNER, id(800));
    transport.syncShots = jest.fn(async shots => ({
      acceptedIds: ids(shots).filter(shotId => shotId === id(801)),
      rejected: ids(shots)
        .filter(shotId => shotId === id(800))
        .map(shotId => ({
          id: shotId,
          code: 'validation.shot',
          message: 'Rejected by validator',
        })),
    }));
    const first = await drainOutbox(store.db, transport);
    // `remaining` counts every queued row including the exhausted one.
    expect(first).toEqual({ synced: 1, failed: 1, remaining: 1 });
    expect(receipts()).toEqual([id(801)]);
    expect(rows().map(row => [row['kind'], row['attempts']])).toEqual([
      ['shot.sync', OUTBOX_MAX_ATTEMPTS],
    ]);
    expect(await getShotOutboxStatus(store.db, id(800))).toMatchObject({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    expect(await hasShotSyncReceipt(store.db, id(800))).toBe(false);
    transport.syncShots = accepting();
    const second = await drainOutbox(store.db, transport);
    expect(second).toEqual({ synced: 0, failed: 0, remaining: 1 });
    expect(transport.syncShots).not.toHaveBeenCalled();
    expect((await listShots(store.db)).map(row => row.id).sort()).toEqual([
      id(800),
      id(801),
    ]);
  });
});

describe('ATTACK 9 — receipt COMMIT acknowledgement lost for the first of two accepted entries', () => {
  it('keeps the committed receipt, resends only the unreceipted sibling, and never duplicates', async () => {
    const { store, rows, receipts, transport } = fixture();
    await saveAnalysis(store.db, analysis(900), permit(900));
    await saveAnalysis(store.db, analysis(901), permit(901));
    store.failCommitOnce('after', 'INSERT OR REPLACE INTO sync_receipt');
    const first = await drainOutbox(store.db, transport);
    expect(transport.syncShots).toHaveBeenCalledTimes(1);
    expect(first.synced).toBe(0);
    // The physical commit happened: receipt 900 exists and its row is gone.
    expect(receipts()).toEqual([id(900)]);
    expect(
      rows().map(row => [
        row['attempts'],
        String(row['payload']).includes(id(901)),
      ]),
    ).toEqual([[0, true]]);
    expect(first.remaining).toBe(1);
    expect(await hasShotSyncReceipt(store.db, id(900))).toBe(true);
    expect(await hasShotSyncReceipt(store.db, id(901))).toBe(false);
    const second = await drainOutbox(store.db, transport);
    expect(second).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(transport.syncShots).toHaveBeenCalledTimes(2);
    expect(ids((transport.syncShots as jest.Mock).mock.calls[1][0])).toEqual([
      id(901),
    ]);
    expect(receipts()).toEqual([id(900), id(901)]);
    expect(rows()).toEqual([]);
  });
});

describe('ATTACK 10 — server acknowledgement that renames a submitted id', () => {
  it('holds every row (no receipt, no attempt burned) when the ack contains an id in a different case', async () => {
    const { store, rows, receipts, transport } = fixture();
    const hexA = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const hexB = 'fedcbafe-dcba-4fed-8cba-fedcbafedcba';
    await saveAnalysis(store.db, { ...analysis(1000), id: hexA }, permit(1000));
    await saveAnalysis(store.db, { ...analysis(1001), id: hexB }, permit(1001));
    globalThis.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const submitted = JSON.parse(String(init?.body)) as {
        shots: Array<{ id: string }>;
      };
      return new Response(
        JSON.stringify({
          acceptedIds: submitted.shots.map((shot, index) =>
            index === 0 ? shot.id.toUpperCase() : shot.id,
          ),
          rejected: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const real = createTransport({ baseUrl: 'https://api.test', token: 'tok' });
    const first = await drainOutbox(store.db, real);
    expect(first).toEqual({ synced: 0, failed: 2, remaining: 2 });
    expect(receipts()).toEqual([]);
    expect(rows().map(row => row['attempts'])).toEqual([0, 0]);
    expect(
      rows().every(row =>
        String(row['last_error']).includes(
          'could not confirm which items were saved',
        ),
      ),
    ).toBe(true);
    expect(await getShotOutboxStatus(store.db, hexA)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    const second = await drainOutbox(store.db, transport);
    expect(second).toEqual({ synced: 2, failed: 0, remaining: 0 });
    expect(receipts()).toEqual([hexA, hexB]);
  });
});
