/**
 * ATTACK S6 — request() aborts at API_REQUEST_TIMEOUT_MS (20s) AFTER the
 * server has already committed the batch (response lost in flight).
 *
 * Expected: the abort surfaces as ApiError(408, 'network.timeout'), which is
 * TRANSIENT — the row stays queued with attempts = 0 — and the next drain
 * re-sends the identical UUID + permit so the server's replay path
 * (parseSyncShot → batched existing-id lookup → accepted) acknowledges it.
 *
 * Uses the REAL api.ts transport (createTransport / request) over a mocked
 * global fetch that honours AbortSignal, jest modern fake timers for the
 * 20s clock, and the real production schema on node:sqlite.
 */
import type { LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { API_REQUEST_TIMEOUT_MS, createTransport } from '../../../src/data/api';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
} from '../../../src/data/repository';
import { drainOutbox } from '../../../src/data/sync';
import {
  OWNER_A,
  PERMIT_ID,
  SHOT_ID,
  createServerEmulator,
  flushMicrotasks,
  realAnalysis,
} from '../../../testing/attack/mobileDataSyncFixtures';
import { createOpSqliteModuleMock } from '../../../testing/attack/nodeSqliteOpAdapter';

const mockOpSqlite = createOpSqliteModuleMock();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options),
}));

function loadRealGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb = jest.requireActual<typeof import('../../../src/data/db')>(
      '../../../src/data/db',
    ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

interface FetchCall {
  url: string;
  body: { shots: Array<Record<string, unknown>> };
  aborted: boolean;
}

/**
 * fetch double in front of the server emulator. `mode` decides whether the
 * response is delivered or lost after the server has committed:
 *  - 'lose_response': server processes the batch, the promise never
 *    settles until the caller's AbortSignal fires (then rejects AbortError).
 *  - 'deliver': normal 200 response with the emulator's verdict.
 */
function installFetch(
  server: ReturnType<typeof createServerEmulator>,
  mode: { current: 'lose_response' | 'deliver' },
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  (globalThis as { fetch?: unknown }).fetch = jest.fn(
    (url: string, init: { body?: string; signal?: AbortSignal }) => {
      const body = JSON.parse(String(init.body)) as FetchCall['body'];
      const call: FetchCall = { url, body, aborted: false };
      calls.push(call);
      // Server side commits regardless of whether the response arrives.
      const verdict = server.syncShots(body.shots);
      if (mode.current === 'deliver') {
        return verdict.then(json => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => json,
        }));
      }
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          call.aborted = true;
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  );
  return { calls };
}

describe('ATTACK S6 — 20s client abort after the server accepted the batch [real api.ts transport + real sqlite]', () => {
  let db: LocalDb;

  beforeEach(() => {
    jest.useFakeTimers();
    db = loadRealGetDb()();
    setActiveDataOwner(OWNER_A);
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
    delete (globalThis as { fetch?: unknown }).fetch;
    jest.useRealTimers();
  });

  it('abort exactly at 20s → typed 408, row stays queued with attempts=0, receipt NOT written; next drain resends the same UUID and the replay path completes it', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const mode = { current: 'lose_response' as 'lose_response' | 'deliver' };
    const { calls } = installFetch(server, mode);
    const transport = createTransport({
      baseUrl: 'https://api.test',
      token: 'bearer',
    });

    // Drain #1: request goes out, server commits, response never arrives.
    const drain1 = drainOutbox(db, transport);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.test/v1/shots:sync');
    expect(server.inserted).toEqual([SHOT_ID]);
    expect(jest.getTimerCount()).toBe(1);

    // 19.999s: still pending.
    jest.advanceTimersByTime(API_REQUEST_TIMEOUT_MS - 1);
    await flushMicrotasks();
    expect(calls[0]!.aborted).toBe(false);

    // 20.000s: abort fires.
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(calls[0]!.aborted).toBe(true);
    const result1 = await drain1;
    expect(result1).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(jest.getTimerCount()).toBe(0);

    const { rows: after1 } = await db.execute(
      'SELECT attempts, last_error FROM outbox',
    );
    expect(after1).toHaveLength(1);
    expect(after1[0]!['attempts']).toBe(0);
    expect(String(after1[0]!['last_error'])).toContain(
      'The server took too long to respond',
    );
    expect(await hasShotSyncReceipt(db, SHOT_ID)).toBe(false);
    expect(await getShotOutboxStatus(db, SHOT_ID)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });

    // Drain #2: connectivity recovers; the SAME payload is resent.
    mode.current = 'deliver';
    const result2 = await drainOutbox(db, transport);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(calls[1]!.body.shots[0]).toMatchObject({
      id: SHOT_ID,
      analysisPermitId: PERMIT_ID,
    });
    // Server: replay lookup found the row → accepted without a second write.
    expect(server.inserted).toEqual([SHOT_ID]);
    expect(server.rpcCalls).toEqual([SHOT_ID]);
    expect(result2).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(await hasShotSyncReceipt(db, SHOT_ID)).toBe(true);
    expect(await getShotOutboxStatus(db, SHOT_ID)).toEqual({ state: 'absent' });
  });

  it('repeated timeouts never consume the attempt budget (100 lost responses → attempts still 0, row still queued)', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const mode = { current: 'lose_response' as const };
    const { calls } = installFetch(server, mode);
    const transport = createTransport({
      baseUrl: 'https://api.test',
      token: 'bearer',
    });

    for (let i = 0; i < 100; i++) {
      const drain = drainOutbox(db, transport);
      await flushMicrotasks();
      jest.advanceTimersByTime(API_REQUEST_TIMEOUT_MS);
      await flushMicrotasks();
      expect(await drain).toEqual({ synced: 0, failed: 1, remaining: 1 });
    }
    expect(calls).toHaveLength(100);
    expect(calls.every(c => c.aborted)).toBe(true);
    expect(await getShotOutboxStatus(db, SHOT_ID)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
  });

  it('the abort timer is cleared even when fetch rejects for another reason before 20s (no leaked timers)', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    (globalThis as { fetch?: unknown }).fetch = jest.fn(() =>
      Promise.reject(new TypeError('Network request failed')),
    );
    const transport = createTransport({
      baseUrl: 'https://api.test',
      token: 'bearer',
    });
    const result = await drainOutbox(db, transport);
    expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(jest.getTimerCount()).toBe(0);
    expect(await getShotOutboxStatus(db, SHOT_ID)).toMatchObject({
      state: 'queued',
      attempts: 0,
      lastError: 'TypeError: Network request failed',
    });
  });
});
