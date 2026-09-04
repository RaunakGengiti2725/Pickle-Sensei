/**
 * Sync runtime generations share ONE SQLite connection and ONE outbox, so at
 * most one drain may be in flight at any time — whichever generation started
 * it. Signing out and straight back in (same account or another) while the
 * previous drain awaits the network must not start a second drain over the
 * same rows: that POSTs every queued shot twice under two bearers and races
 * two receipt transactions on the same connection.
 *
 * Driven through the real `syncRuntime` + `api.ts` transport with a fetch
 * double whose responses the test releases, over a fake LocalDb that records
 * every receipt write.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
import { saveAnalysis } from '../src/data/repository';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  type ApiSession,
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { getDb } from '../src/data/db';

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

interface Receipt {
  owner: string;
  entityId: string;
}

function fakeDb() {
  const outbox: OutboxRow[] = [];
  const receipts: Receipt[] = [];
  let nextId = 1;
  let inTransaction = false;
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      if (sql === 'BEGIN IMMEDIATE') {
        if (inTransaction) {
          throw new Error(
            'cannot start a transaction within a transaction (SQLITE_ERROR)',
          );
        }
        inTransaction = true;
        return { rows: [] };
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        inTransaction = false;
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
        receipts.push({
          owner: String(params[0]),
          entityId: String(params[1]),
        });
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO local_shot')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO outbox')) {
        outbox.push({
          id: nextId++,
          owner_key: String(params[0]),
          kind: 'shot.sync',
          payload: String(params[params.length - 1]),
          attempts: 0,
          last_error: null,
        });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id, kind, payload')) {
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .sort((a, b) => a.id - b.id)
            .slice(0, 50)
            .map(r => ({ ...r })),
        };
      }
      if (sql.startsWith('DELETE FROM outbox')) {
        const idx = outbox.findIndex(
          r => r.owner_key === params[0] && r.id === params[1],
        );
        if (idx >= 0) outbox.splice(idx, 1);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox')) {
        const row = outbox.find(
          r => r.owner_key === params[1] && r.id === params[2],
        );
        if (row) {
          if (sql.includes('attempts = attempts + 1')) row.attempts += 1;
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (sql.startsWith('SELECT count(*)')) {
        return {
          rows: [
            { n: outbox.filter(row => row.owner_key === params[0]).length },
          ],
        };
      }
      throw new Error(`fakeDb: unhandled sql ${sql}`);
    },
    close() {},
  };
  return { db, outbox, receipts };
}

const CANONICAL_USER = '11111111-2222-4333-8444-555555555555';
const OTHER_USER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PERMIT_ID = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OWNER = canonicalDataOwner(CANONICAL_USER);

function shotId(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function analysis(id: string): ShotAnalysis {
  return {
    id,
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-26T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

function session(
  bearerToken: string,
  canonicalAppUserId = CANONICAL_USER,
): ApiSession {
  return {
    apiBaseUrl: 'https://api.test',
    bearerToken,
    canonicalAppUserId,
    provider: 'apple',
  };
}

interface PendingPost {
  bearer: string;
  shotIds: string[];
  release: () => void;
}

/** Every POST parks until the test releases it, like a slow network. */
function installFetch(pending: PendingPost[]): void {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(
    (_url: string, init: { body?: string; headers: Record<string, string> }) =>
      new Promise<Response>(resolve => {
        const body = JSON.parse(String(init.body)) as {
          shots: Array<{ id: string }>;
        };
        pending.push({
          bearer: init.headers['authorization'] ?? '',
          shotIds: body.shots.map(s => s.id),
          release: () =>
            resolve({
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: { get: () => null },
              json: async () => ({
                acceptedIds: body.shots.map(s => s.id),
                rejected: [],
              }),
            } as unknown as Response),
        });
      }),
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function postsOf(pending: PendingPost[]) {
  return pending.map(p => ({ bearer: p.bearer, shotIds: p.shotIds }));
}

describe('syncRuntime — one drain in flight across generations', () => {
  const IDS = [shotId(0x71), shotId(0x72)];
  let pending: PendingPost[];
  let fake: ReturnType<typeof fakeDb>;

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    pending = [];
    installFetch(pending);
    fake = fakeDb();
    (getDb as jest.Mock).mockReturnValue(fake.db);
    setActiveDataOwner(OWNER);
    establishApiSession(session('bearer-one'));
    for (const id of IDS) {
      await saveAnalysis(fake.db, analysis(id), PERMIT_ID);
    }
    expect(fake.outbox).toHaveLength(2);
  });

  afterEach(() => {
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    delete (globalThis as { fetch?: unknown }).fetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a same-account re-sign-in while the previous drain awaits the network offers every shot to the transport once and writes every receipt once', async () => {
    configureSyncRuntime(session('bearer-one'));
    await settle();
    expect(postsOf(pending)).toEqual([
      { bearer: 'Bearer bearer-one', shotIds: IDS },
    ]);

    // Sign out, then straight back in as the same account before the first
    // drain's round trip has completed.
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(OWNER);
    establishApiSession(session('bearer-two'));
    configureSyncRuntime(session('bearer-two'));
    await settle();

    // The fresh generation must NOT have started a second drain over the same
    // rows while the stale one is still in flight.
    expect(postsOf(pending)).toEqual([
      { bearer: 'Bearer bearer-one', shotIds: IDS },
    ]);

    for (const p of pending) p.release();
    await settle();

    expect(postsOf(pending)).toEqual([
      { bearer: 'Bearer bearer-one', shotIds: IDS },
    ]);
    expect(fake.outbox).toEqual([]);
    expect(fake.receipts).toEqual([
      { owner: OWNER, entityId: IDS[0] },
      { owner: OWNER, entityId: IDS[1] },
    ]);
  });

  it('the fresh generation still drains once the stale drain settles: a shot saved after re-sign-in goes out exactly once under the new bearer', async () => {
    configureSyncRuntime(session('bearer-one'));
    await settle();
    expect(pending).toHaveLength(1);

    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(OWNER);
    establishApiSession(session('bearer-two'));
    configureSyncRuntime(session('bearer-two'));
    const third = shotId(0x73);
    await saveAnalysis(fake.db, analysis(third), PERMIT_ID);
    triggerOutboxSync();
    await settle();
    expect(pending).toHaveLength(1);

    pending[0]!.release();
    await settle();

    expect(postsOf(pending)).toEqual([
      { bearer: 'Bearer bearer-one', shotIds: IDS },
      { bearer: 'Bearer bearer-two', shotIds: [third] },
    ]);
    pending[1]!.release();
    await settle();
    expect(fake.outbox).toEqual([]);
    expect(fake.receipts.map(r => r.entityId)).toEqual([...IDS, third]);
  });

  it('switching to a different account while a drain is in flight waits for it instead of interleaving a second drain on the same connection', async () => {
    configureSyncRuntime(session('bearer-one'));
    await settle();
    expect(pending).toHaveLength(1);

    const otherOwner = canonicalDataOwner(OTHER_USER);
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(otherOwner);
    establishApiSession(session('bearer-other', OTHER_USER));
    configureSyncRuntime(session('bearer-other', OTHER_USER));
    const otherShot = shotId(0x81);
    await saveAnalysis(fake.db, analysis(otherShot), PERMIT_ID);
    triggerOutboxSync();
    await settle();
    // Nothing for the new account has been sent while the first drain is
    // still awaiting the network.
    expect(pending).toHaveLength(1);

    pending[0]!.release();
    await settle();
    expect(postsOf(pending)).toEqual([
      { bearer: 'Bearer bearer-one', shotIds: IDS },
      { bearer: 'Bearer bearer-other', shotIds: [otherShot] },
    ]);
    pending[1]!.release();
    await settle();
    expect(fake.receipts).toEqual([
      { owner: OWNER, entityId: IDS[0] },
      { owner: OWNER, entityId: IDS[1] },
      { owner: otherOwner, entityId: otherShot },
    ]);
  });

  it('a trigger during an in-flight drain of the same generation runs one follow-up drain after it settles instead of a concurrent one', async () => {
    configureSyncRuntime(session('bearer-one'));
    await settle();
    expect(pending).toHaveLength(1);

    const third = shotId(0x73);
    await saveAnalysis(fake.db, analysis(third), PERMIT_ID);
    triggerOutboxSync();
    triggerOutboxSync();
    await settle();
    expect(pending).toHaveLength(1);

    pending[0]!.release();
    await settle();
    expect(postsOf(pending)).toEqual([
      { bearer: 'Bearer bearer-one', shotIds: IDS },
      { bearer: 'Bearer bearer-one', shotIds: [third] },
    ]);
    pending[1]!.release();
    await settle();
    expect(pending).toHaveLength(2);
    expect(fake.outbox).toEqual([]);
  });
});
