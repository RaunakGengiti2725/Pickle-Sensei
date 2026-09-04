/**
 * ATTACK S1 — a CONFIGURED sync runtime whose active data owner is switched
 * to SIGNED_OUT_DATA_OWNER without clearing the runtime.
 *
 * syncRuntime.ts:79-82 — on owner mismatch trigger() calls schedule() and
 * returns. So (a) no transport call and no drainOutbox call may happen, and
 * (b) the 30s timer re-arms itself on every tick, indefinitely, doing no work.
 *
 * Seeded randomness: Math.random is pinned to 0.5 → jitter 0 → every retry
 * delay is exactly SYNC_RETRY_BASE_MS (30_000 ms). Simulated horizon: 24h.
 *
 * Real production schema on node:sqlite (the runtime calls getDb()); fetch is
 * a healthy server emulator so any leaked drain would be visible as a call.
 */
import { AppState } from 'react-native';
import { getDb, type LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  GUEST_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import {
  getShotOutboxStatus,
  saveAnalysis,
} from '../../../src/data/repository';
import { drainOutbox } from '../../../src/data/sync';
import {
  SYNC_RETRY_BASE_MS,
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../../../src/data/syncRuntime';
import {
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
jest.mock('../../../src/data/sync', () => {
  const actual = jest.requireActual<typeof import('../../../src/data/sync')>(
    '../../../src/data/sync',
  );
  return { ...actual, drainOutbox: jest.fn(actual.drainOutbox) };
});

const drainSpy = drainOutbox as jest.MockedFunction<typeof drainOutbox>;

const CANONICAL_USER = '44444444-4444-4444-8444-444444444444';
const OWNER = canonicalDataOwner(CANONICAL_USER);
const SECOND_SHOT_ID = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECOND_PERMIT_ID = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DAY_MS = 24 * 60 * 60 * 1000;

function installHealthyFetch(server: ReturnType<typeof createServerEmulator>) {
  const fetchMock = jest.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init.body)) as {
      shots: Array<Record<string, unknown>>;
    };
    const json = await server.syncShots(body.shots);
    return { ok: true, status: 200, statusText: 'OK', json: async () => json };
  });
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  return fetchMock;
}

describe('ATTACK S1 — configured runtime, owner switched to SIGNED_OUT [fake timers, seeded jitter]', () => {
  let db: LocalDb;
  let appStateHandler: ((state: string) => void) | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, handler) => {
        appStateHandler = handler as (state: string) => void;
        return { remove: () => {} } as ReturnType<
          typeof AppState.addEventListener
        >;
      });
    drainSpy.mockClear();
    db = getDb();
    setActiveDataOwner(OWNER);
  });

  afterEach(() => {
    clearSyncRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
    delete (globalThis as { fetch?: unknown }).fetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function configureAndDrainOnce(fetchMock: jest.Mock): Promise<void> {
    configureSyncRuntime({
      canonicalAppUserId: CANONICAL_USER,
      apiBaseUrl: 'https://api.test',
      bearerToken: 'bearer',
      provider: 'apple',
    });
    await flushMicrotasks(64);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
  }

  it('no transport call, no drainOutbox call, exactly ONE pending timer that re-arms every 30s for 24 simulated hours (2880 idle wake-ups)', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const fetchMock = installHealthyFetch(server);
    await configureAndDrainOnce(fetchMock);
    expect(server.inserted).toEqual([SHOT_ID]);

    // Queue a second row while still writable, then flip to signed-out
    // WITHOUT clearing the runtime.
    await saveAnalysis(
      db,
      { ...realAnalysis, id: SECOND_SHOT_ID },
      SECOND_PERMIT_ID,
    );
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);

    triggerOutboxSync();
    await flushMicrotasks(64);
    appStateHandler!('active');
    await flushMicrotasks(64);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    let wakeUps = 0;
    const elapsedStart = jest.now();
    while (jest.now() - elapsedStart < DAY_MS) {
      jest.advanceTimersToNextTimer();
      await flushMicrotasks(16);
      wakeUps += 1;
      expect(jest.getTimerCount()).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(drainSpy).toHaveBeenCalledTimes(1);
    }
    expect(wakeUps).toBe(DAY_MS / SYNC_RETRY_BASE_MS); // 2880
    expect(jest.now() - elapsedStart).toBe(DAY_MS);

    // The queued row was never touched (attempts 0, still queued for the
    // owner it belongs to).
    setActiveDataOwner(OWNER);
    expect(await getShotOutboxStatus(db, SECOND_SHOT_ID)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    expect(server.inserted).toEqual([SHOT_ID]);
  });

  it('the idle timer never leaks work across owners: a later GUEST owner is also refused, and only the ORIGINAL owner coming back lets the next tick drain', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const fetchMock = installHealthyFetch(server);
    await configureAndDrainOnce(fetchMock);
    await saveAnalysis(
      db,
      { ...realAnalysis, id: SECOND_SHOT_ID },
      SECOND_PERMIT_ID,
    );

    setActiveDataOwner(GUEST_DATA_OWNER);
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersToNextTimer();
      await flushMicrotasks(16);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    setActiveDataOwner(OWNER);
    jest.advanceTimersToNextTimer();
    await flushMicrotasks(64);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(drainSpy).toHaveBeenCalledTimes(2);
    expect(server.inserted).toEqual([SHOT_ID, SECOND_SHOT_ID]);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('the shipping sign-out order (clearSyncRuntime THEN setActiveDataOwner(SIGNED_OUT), authStore.signOut) leaves ZERO timers for 24h', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const fetchMock = installHealthyFetch(server);
    await configureAndDrainOnce(fetchMock);

    clearSyncRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    expect(jest.getTimerCount()).toBe(0);

    triggerOutboxSync();
    appStateHandler!('active');
    jest.advanceTimersByTime(DAY_MS);
    await flushMicrotasks(64);
    expect(jest.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledTimes(1);
  });

  it('the reverse order (owner flipped first, runtime cleared a tick later) closes the leak as soon as clearSyncRuntime runs', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const fetchMock = installHealthyFetch(server);
    await configureAndDrainOnce(fetchMock);

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    jest.advanceTimersToNextTimer();
    await flushMicrotasks(16);
    expect(jest.getTimerCount()).toBe(1);

    clearSyncRuntime();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(DAY_MS);
    await flushMicrotasks(16);
    expect(jest.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
