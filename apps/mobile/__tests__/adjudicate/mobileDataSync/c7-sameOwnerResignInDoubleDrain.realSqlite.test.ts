/**
 * C7 — sign out and immediately sign back in as the SAME canonical account
 * while the previous runtime generation's drain is awaiting the network.
 * `clearSyncRuntime()` only bumps `generation`; `runningGenerations` is keyed
 * per generation, so `configureSyncRuntime()`'s immediate trigger starts a
 * second `drainOutbox()` over the very same rows on the same connection.
 *
 * Driven through the real `syncRuntime` + `api.ts` + real SQLite with a fetch
 * double whose responses are released by the test. Records how many times
 * each shot is POSTed and whether the two receipt transactions collide.
 */
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { getDb } from '../../../src/data/db';
import { hasShotSyncReceipt, saveAnalysis } from '../../../src/data/repository';
import {
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../../src/data/syncRuntime';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const IDS = [shotId(0x71), shotId(0x72)];

function session(bearerToken: string): ApiSession {
  return {
    apiBaseUrl: 'https://example.invalid/functions/v1/api',
    bearerToken,
    canonicalAppUserId: CANONICAL_USER,
    provider: 'apple',
  };
}

interface PendingPost {
  bearer: string;
  shotIds: string[];
  release: () => void;
}

function installFetch(pending: PendingPost[]): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(
    (_url: string, init: { body?: string; headers: Record<string, string> }) =>
      new Promise<Response>(resolve => {
        const body = JSON.parse(String(init.body)) as {
          shots: Array<{ id: string }>;
        };
        pending.push({
          bearer: init.headers['authorization'] ?? '',
          shotIds: body.shots.map(s => s.id),
          release: () =>
            resolve(
              new Response(
                JSON.stringify({
                  acceptedIds: body.shots.map(s => s.id),
                  rejected: [],
                }),
                {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            ),
        });
      }),
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('C7: same-owner re-sign-in drains stale and fresh generations concurrently', () => {
  const pending: PendingPost[] = [];

  beforeAll(async () => {
    jest.useFakeTimers();
    installFetch(pending);
    setActiveDataOwner(OWNER);
    establishApiSession(session('bearer-one'));
    const db = getDb();
    for (const id of IDS) {
      await saveAnalysis(db, realAnalysis({ id }), PERMIT_ID);
    }
  });

  afterAll(() => {
    clearSyncRuntime();
    clearApiSession();
    getDb().close();
    mockSqlite.reset();
    jest.useRealTimers();
  });

  it('POSTs every shot once and records every receipt exactly once', async () => {
    const db = getDb();
    configureSyncRuntime(session('bearer-one'));
    await flush();
    expect(pending).toHaveLength(1);

    // Sign out, then sign back in as the same account before the first
    // drain's network round trip has completed.
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(OWNER);
    establishApiSession(session('bearer-two'));
    configureSyncRuntime(session('bearer-two'));
    await flush();

    const postsBeforeRelease = pending.map(p => ({
      bearer: p.bearer,
      shotIds: p.shotIds,
    }));
    for (const p of pending) p.release();
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    await flush();

    const rows = await outboxRows(db, OWNER);
    const receipts = await Promise.all(
      IDS.map(id => hasShotSyncReceipt(db, id)),
    );
    const observed = { postsBeforeRelease, rows, receipts };
    console.log(JSON.stringify(observed, null, 2));

    expect(postsBeforeRelease).toEqual([
      { bearer: 'Bearer bearer-one', shotIds: IDS },
    ]);
    expect(rows).toEqual([]);
    expect(receipts).toEqual([true, true]);
  });
});
