/**
 * ATTACK S7 — syncShots fails with ApiError(404, 'unknown', 'Not Found')
 * (misconfigured base URL / gateway: e.g. the Supabase gateway's
 * `{"code":404,"message":"Requested function was not found"}` body has no
 * `error.code`, so api.ts maps it to code 'unknown' + statusText).
 *
 * isPermanentSyncFailure() treats every 4xx except 401/408/429 as permanent,
 * so a whole-request 404 burns one attempt per drain for EVERY queued row.
 * After OUTBOX_MAX_ATTEMPTS (8) drains the rows are excluded from all future
 * drains — including after the gateway is repaired.
 *
 * Part A: drainOutbox + real api.ts transport + real schema on node:sqlite.
 * Part B: the shipping syncRuntime — 8 foreground events during the outage
 * are enough to exhaust the budget (no back-off applies to AppState
 * triggers), and a later healthy gateway never receives the rows.
 */
import { AppState } from 'react-native';
import type { LocalDb } from '../../../src/data/db';
import { getDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { ApiError, createTransport } from '../../../src/data/api';
import {
  getShotOutboxStatus,
  saveAnalysis,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  drainOutbox,
  isPermanentSyncFailure,
} from '../../../src/data/sync';
import {
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../../src/data/syncRuntime';
import { deriveUploadQueueStatus } from '../../../src/data/offlineCapabilities';
import {
  PERMIT_ID,
  SHOT_ID,
  createServerEmulator,
  realAnalysis,
} from '../../../testing/attack/mobileDataSyncFixtures';
import { createOpSqliteModuleMock } from '../../../testing/attack/nodeSqliteOpAdapter';

const mockOpSqlite = createOpSqliteModuleMock();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options),
}));

const CANONICAL_USER = '33333333-3333-4333-8333-333333333333';
const OWNER = canonicalDataOwner(CANONICAL_USER);
const SECOND_SHOT_ID = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type Gateway = { current: 'not_found' | 'healthy' };

/** fetch double: a 404 gateway (Supabase "function not found" body) or a
 * healthy server emulator. */
function installFetch(
  gateway: Gateway,
  server: ReturnType<typeof createServerEmulator>,
): { calls: Array<{ body: { shots: Array<Record<string, unknown>> } }> } {
  const calls: Array<{ body: { shots: Array<Record<string, unknown>> } }> = [];
  (globalThis as { fetch?: unknown }).fetch = jest.fn(
    async (_url: string, init: { body?: string }) => {
      const body = JSON.parse(String(init.body)) as {
        shots: Array<Record<string, unknown>>;
      };
      calls.push({ body });
      if (gateway.current === 'not_found') {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({
            code: 404,
            message: 'Requested function was not found',
          }),
        };
      }
      const json = await server.syncShots(body.shots);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => json,
      };
    },
  );
  return { calls };
}

async function outboxRows(db: LocalDb) {
  const { rows } = await db.execute(
    `SELECT id, kind, attempts, last_error,
            json_extract(payload, '$.id') AS shot_id
       FROM outbox ORDER BY id ASC`,
  );
  return rows;
}

const settle = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
};

describe('ATTACK S7 — whole-request 404 burns the permanent budget [real api.ts transport + real sqlite]', () => {
  let db: LocalDb;

  beforeEach(() => {
    db = getDb();
    setActiveDataOwner(OWNER);
  });

  afterEach(() => {
    clearSyncRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
    delete (globalThis as { fetch?: unknown }).fetch;
    jest.restoreAllMocks();
  });

  it('classification: ApiError(404, unknown, Not Found) is PERMANENT', () => {
    expect(
      isPermanentSyncFailure(new ApiError(404, 'unknown', 'Not Found')),
    ).toBe(true);
  });

  it('Part A: 8 drains against a 404 gateway exhaust EVERY queued row; drain 9 issues no request; a repaired gateway never receives them', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    await saveAnalysis(
      db,
      { ...realAnalysis, id: SECOND_SHOT_ID },
      'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    const gateway: Gateway = { current: 'not_found' };
    const server = createServerEmulator();
    const { calls } = installFetch(gateway, server);
    const transport = createTransport({
      baseUrl: 'https://wrong-host.test',
      token: 'bearer',
    });

    for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i++) {
      const result = await drainOutbox(db, transport);
      expect(result).toEqual({ synced: 0, failed: 2, remaining: 2 });
      const rows = await outboxRows(db);
      expect(rows.map(r => r['attempts'])).toEqual([i, i]);
      expect(rows.map(r => r['last_error'])).toEqual([
        'Error: Not Found',
        'Error: Not Found',
      ]);
    }
    expect(calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);

    // Drain 9 while still 404: nothing is sent, rows still remain.
    expect(await drainOutbox(db, transport)).toEqual({
      synced: 0,
      failed: 0,
      remaining: 2,
    });
    expect(calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);

    // Gateway repaired: the rows are STILL never retried.
    gateway.current = 'healthy';
    for (let i = 0; i < 5; i++) {
      expect(await drainOutbox(db, transport)).toEqual({
        synced: 0,
        failed: 0,
        remaining: 2,
      });
    }
    expect(calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(server.inserted).toEqual([]);
    expect(await getShotOutboxStatus(db, SHOT_ID)).toEqual({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: 'Error: Not Found',
    });
    expect(await getShotOutboxStatus(db, SECOND_SHOT_ID)).toMatchObject({
      state: 'exhausted',
    });
    const rows = await outboxRows(db);
    expect(
      deriveUploadQueueStatus(
        rows.map(r => ({
          kind: String(r['kind']),
          attempts: Number(r['attempts']),
          lastError: (r['last_error'] as string | null) ?? null,
        })),
      ),
    ).toEqual({ state: 'needs_attention', pending: 0, exhausted: 2 });

    // A NEW rating queued after the repair syncs fine — the strand is
    // permanent only for rows that lived through the outage.
    await saveAnalysis(
      db,
      { ...realAnalysis, id: 'eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    expect(await drainOutbox(db, transport)).toEqual({
      synced: 1,
      failed: 0,
      remaining: 2,
    });
    expect(server.inserted).toEqual(['eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
  });

  it('Part A (contrast): the same outage as 5xx / 401 / 429 / 408 never touches the budget', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    for (const status of [500, 502, 503, 401, 429, 408]) {
      (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status,
        statusText: `status-${status}`,
        json: async () => null,
      }));
      const transport = createTransport({
        baseUrl: 'https://api.test',
        token: 'bearer',
      });
      for (let i = 0; i < 20; i++) {
        await drainOutbox(db, transport);
      }
      expect(await getShotOutboxStatus(db, SHOT_ID)).toMatchObject({
        state: 'queued',
        attempts: 0,
      });
    }
  });

  it('Part B: with the shipping syncRuntime, 8 foreground events during a 404 outage strand the rating permanently (no back-off gates AppState triggers)', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const gateway: Gateway = { current: 'not_found' };
    const server = createServerEmulator();
    const { calls } = installFetch(gateway, server);

    let appStateHandler: ((state: string) => void) | null = null;
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, handler) => {
        appStateHandler = handler as (state: string) => void;
        return { remove: () => {} } as ReturnType<
          typeof AppState.addEventListener
        >;
      });

    configureSyncRuntime({
      canonicalAppUserId: CANONICAL_USER,
      apiBaseUrl: 'https://wrong-host.test',
      bearerToken: 'bearer',
      provider: 'apple',
    });
    await settle();
    expect(calls).toHaveLength(1); // configure() drains once
    expect(await getShotOutboxStatus(db, SHOT_ID)).toMatchObject({
      attempts: 1,
    });

    // The user foregrounds the app seven more times while the gateway 404s.
    for (let i = 2; i <= OUTBOX_MAX_ATTEMPTS; i++) {
      appStateHandler!('active');
      await settle();
      expect(calls).toHaveLength(i);
    }
    expect(await getShotOutboxStatus(db, SHOT_ID)).toEqual({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: 'Error: Not Found',
    });

    // Gateway repaired, user foregrounds again: the rating is never sent.
    gateway.current = 'healthy';
    appStateHandler!('active');
    await settle();
    appStateHandler!('active');
    await settle();
    expect(calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(server.inserted).toEqual([]);
    expect(await getShotOutboxStatus(db, SHOT_ID)).toMatchObject({
      state: 'exhausted',
    });
  });
});
