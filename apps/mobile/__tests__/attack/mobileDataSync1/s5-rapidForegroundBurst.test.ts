/**
 * ATTACK S5 — AppState 'active' emitted 5× within the same millisecond.
 *
 * syncRuntime.ts:72-95 — `runningGenerations` must collapse the burst into
 * exactly ONE drainOutbox call / ONE transport request, and the `finally`
 * schedule() must leave exactly ONE pending timer (clearing the previous
 * one). Also probes: the retry timer firing while a drain is in flight, and
 * a row written mid-drain (trailing-edge behaviour: it waits for the timer).
 *
 * Seeded randomness: Math.random pinned to 0.5 → every delay is exactly
 * SYNC_RETRY_BASE_MS. Real production schema on node:sqlite.
 */
import { AppState } from 'react-native';
import { getDb, type LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
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

const CANONICAL_USER = '55555555-5555-4555-8555-555555555555';
const OWNER = canonicalDataOwner(CANONICAL_USER);
const SECOND_SHOT_ID = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const THIRD_SHOT_ID = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECOND_PERMIT_ID = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const THIRD_PERMIT_ID = 'eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee';

interface GatedFetch {
  mock: jest.Mock;
  /** When true, responses are held until release() is called. */
  hold: boolean;
  release(): Promise<void>;
  inFlight(): number;
}

function installGatedFetch(
  server: ReturnType<typeof createServerEmulator>,
): GatedFetch {
  const waiters: Array<() => void> = [];
  const gate: GatedFetch = {
    hold: false,
    mock: jest.fn(),
    async release() {
      const pending = waiters.splice(0);
      for (const w of pending) w();
      await flushMicrotasks(64);
    },
    inFlight: () => waiters.length,
  };
  gate.mock = jest.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init.body)) as {
      shots: Array<Record<string, unknown>>;
    };
    if (gate.hold) {
      await new Promise<void>(resolve => waiters.push(resolve));
    }
    const json = await server.syncShots(body.shots);
    return { ok: true, status: 200, statusText: 'OK', json: async () => json };
  });
  (globalThis as { fetch?: unknown }).fetch = gate.mock;
  return gate;
}

describe('ATTACK S5 — 5 foreground events in one tick [fake timers, seeded jitter]', () => {
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

  async function configureAndSettle(gate: GatedFetch): Promise<void> {
    configureSyncRuntime({
      canonicalAppUserId: CANONICAL_USER,
      apiBaseUrl: 'https://api.test',
      bearerToken: 'bearer',
      provider: 'apple',
    });
    await flushMicrotasks(64);
    expect(gate.mock).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
  }

  it('5× active within 1ms → exactly ONE drain, ONE request, ONE pending timer', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const gate = installGatedFetch(server);
    await configureAndSettle(gate);
    await saveAnalysis(
      db,
      { ...realAnalysis, id: SECOND_SHOT_ID },
      SECOND_PERMIT_ID,
    );

    gate.hold = true;
    const t0 = jest.now();
    for (let i = 0; i < 5; i++) appStateHandler!('active');
    expect(jest.now() - t0).toBe(0);
    await flushMicrotasks(64);

    expect(drainSpy).toHaveBeenCalledTimes(2); // configure + burst
    expect(gate.mock).toHaveBeenCalledTimes(2);
    expect(gate.inFlight()).toBe(1);
    // Armed while on the wire: the pre-burst retry timer + the single 20s
    // abort timer of the ONE in-flight request (api.ts request()).
    expect(jest.getTimerCount()).toBe(2);

    await gate.release();
    expect(drainSpy).toHaveBeenCalledTimes(2);
    expect(gate.mock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
    expect(server.inserted).toEqual([SHOT_ID, SECOND_SHOT_ID]);
    expect(await getShotOutboxStatus(db, SECOND_SHOT_ID)).toEqual({
      state: 'absent',
    });
  });

  it('a burst of 5 AppState events interleaved with 5 triggerOutboxSync() calls is still ONE drain', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const gate = installGatedFetch(server);
    await configureAndSettle(gate);
    await saveAnalysis(
      db,
      { ...realAnalysis, id: SECOND_SHOT_ID },
      SECOND_PERMIT_ID,
    );

    gate.hold = true;
    for (let i = 0; i < 5; i++) {
      appStateHandler!('active');
      triggerOutboxSync();
    }
    await flushMicrotasks(64);
    expect(drainSpy).toHaveBeenCalledTimes(2);
    expect(gate.mock).toHaveBeenCalledTimes(2);
    await gate.release();
    expect(jest.getTimerCount()).toBe(1);
  });

  it('the retry timer firing WHILE a drain is in flight is swallowed and re-armed once the drain ends (never 0, never 2 timers)', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const gate = installGatedFetch(server);
    await configureAndSettle(gate);
    await saveAnalysis(
      db,
      { ...realAnalysis, id: SECOND_SHOT_ID },
      SECOND_PERMIT_ID,
    );

    gate.hold = true;
    appStateHandler!('active');
    await flushMicrotasks(64);
    expect(gate.inFlight()).toBe(1);
    expect(jest.getTimerCount()).toBe(2); // retry timer + request abort timer

    // Advance 30s: the 20s abort timer fires first (the gated fetch double
    // does not wire AbortSignal, so the request simply stays pending — the
    // S6 suite covers the abort path), then the retry timer fires while the
    // drain is still in flight.
    jest.advanceTimersByTime(SYNC_RETRY_BASE_MS);
    await flushMicrotasks(64);
    expect(drainSpy).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0); // fired, not yet re-armed

    await gate.release();
    expect(jest.getTimerCount()).toBe(1); // re-armed by finally/schedule
    expect(drainSpy).toHaveBeenCalledTimes(2);

    // And that re-armed timer actually drains when it fires.
    gate.hold = false;
    await saveAnalysis(
      db,
      { ...realAnalysis, id: THIRD_SHOT_ID },
      THIRD_PERMIT_ID,
    );
    jest.advanceTimersByTime(SYNC_RETRY_BASE_MS);
    await flushMicrotasks(64);
    expect(drainSpy).toHaveBeenCalledTimes(3);
    expect(server.inserted).toEqual([SHOT_ID, SECOND_SHOT_ID, THIRD_SHOT_ID]);
  });

  it('trailing edge: a row saved while a drain is in flight is NOT picked up by the burst (events are dropped, not coalesced) and waits for the 30s timer', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const gate = installGatedFetch(server);
    await configureAndSettle(gate);
    await saveAnalysis(
      db,
      { ...realAnalysis, id: SECOND_SHOT_ID },
      SECOND_PERMIT_ID,
    );

    gate.hold = true;
    appStateHandler!('active');
    await flushMicrotasks(64);
    expect(gate.inFlight()).toBe(1);

    // New local result lands while the request is on the wire.
    await saveAnalysis(
      db,
      { ...realAnalysis, id: THIRD_SHOT_ID },
      THIRD_PERMIT_ID,
    );
    triggerOutboxSync();
    appStateHandler!('active');
    await flushMicrotasks(64);

    gate.hold = false;
    await gate.release();
    expect(drainSpy).toHaveBeenCalledTimes(2);
    expect(await getShotOutboxStatus(db, THIRD_SHOT_ID)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    expect(server.inserted).toEqual([SHOT_ID, SECOND_SHOT_ID]);

    // Bounded: the next tick (exactly 30s with seeded jitter) drains it.
    jest.advanceTimersByTime(SYNC_RETRY_BASE_MS - 1);
    await flushMicrotasks(64);
    expect(drainSpy).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    await flushMicrotasks(64);
    expect(drainSpy).toHaveBeenCalledTimes(3);
    expect(server.inserted).toEqual([SHOT_ID, SECOND_SHOT_ID, THIRD_SHOT_ID]);
    expect(await getShotOutboxStatus(db, THIRD_SHOT_ID)).toEqual({
      state: 'absent',
    });
  });

  it('500 foreground events in one tick, repeated for 20 ticks, never exceed one drain per tick and one timer', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();
    const gate = installGatedFetch(server);
    await configureAndSettle(gate);

    for (let tick = 0; tick < 20; tick++) {
      await saveAnalysis(
        db,
        {
          ...realAnalysis,
          id: `${tick.toString(16).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
        },
        SECOND_PERMIT_ID,
      );
      gate.hold = true;
      for (let i = 0; i < 500; i++) appStateHandler!('active');
      await flushMicrotasks(64);
      expect(drainSpy).toHaveBeenCalledTimes(tick + 2);
      expect(gate.inFlight()).toBe(1);
      await gate.release();
      expect(jest.getTimerCount()).toBe(1);
    }
    expect(gate.mock).toHaveBeenCalledTimes(21);
  });
});
