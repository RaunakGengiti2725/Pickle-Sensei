/**
 * Fix round 9 (Q1.4) — the sync runtime's back-off follows `failed`, never
 * `quarantined`: a drain that only quarantines rows (the server saw nothing)
 * keeps the base cadence, while a drain that leaves failed rows doubles it.
 * `drainOutbox` is stubbed with the result shapes the real drain returns.
 */
import { AppState } from 'react-native';
import * as syncModule from '../../../src/data/sync';
import type { DrainResult } from '../../../src/data/sync';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../../src/account/apiSession';

jest.mock('../../../src/data/db', () => ({
  getDb: jest.fn(() => ({ execute: jest.fn(), close: jest.fn() })),
}));
jest.mock('../../../src/data/api', () => {
  const actual = jest.requireActual<typeof import('../../../src/data/api')>(
    '../../../src/data/api',
  );
  return { ...actual, createTransport: jest.fn(() => ({})) };
});

const USER = '11111111-1111-4111-8111-111111111111';
const session: ApiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'bearer-1111',
  canonicalAppUserId: USER,
  provider: 'apple',
};

async function flushMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function advance(ms: number) {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

/** Drain count observed after waiting the jitter window around `baseMs`:
 * none before the earliest possible fire, exactly one after the latest. */
async function expectNextDrainAt(
  drains: jest.SpyInstance,
  baseMs: number,
): Promise<void> {
  const before = drains.mock.calls.length;
  const earliest = Math.floor(baseMs * (1 - SYNC_RETRY_JITTER_RATIO));
  const latest = Math.ceil(baseMs * (1 + SYNC_RETRY_JITTER_RATIO));
  await advance(earliest - 1);
  expect(drains.mock.calls.length).toBe(before);
  await advance(latest - earliest + 2);
  expect(drains.mock.calls.length).toBe(before + 1);
}

describe('fix round 9 — quarantined rows never move the owner’s back-off', () => {
  let drains: jest.SpyInstance;
  const results: DrainResult[] = [];

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    results.length = 0;
    drains = jest
      .spyOn(syncModule, 'drainOutbox')
      .mockImplementation(async () => {
        const next = results.shift();
        if (next === undefined) throw new Error('unexpected drain');
        return next;
      });
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(
        () =>
          ({ remove: () => {} }) as ReturnType<
            typeof AppState.addEventListener
          >,
      );
    establishApiSession(session);
    setActiveDataOwner(canonicalDataOwner(USER));
  });

  afterEach(() => {
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a 10,000-row quarantine with failed 0 keeps the base cadence across three drains', async () => {
    results.push(
      { synced: 1, failed: 0, remaining: 10_000, quarantined: 10_000 },
      { synced: 0, failed: 0, remaining: 10_000 },
      { synced: 0, failed: 0, remaining: 10_000 },
      { synced: 0, failed: 0, remaining: 10_000 },
    );
    configureSyncRuntime(session);
    await flushMicrotasks();
    expect(drains.mock.calls.length).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      await expectNextDrainAt(drains, SYNC_RETRY_BASE_MS);
    }
    expect(jest.getTimerCount()).toBe(1);
  });

  it('control — a drain that leaves failed rows doubles the cadence, and a clean drain resets it', async () => {
    results.push(
      { synced: 0, failed: 1, remaining: 1 },
      { synced: 0, failed: 1, remaining: 1 },
      { synced: 1, failed: 0, remaining: 0 },
      { synced: 0, failed: 0, remaining: 0 },
    );
    configureSyncRuntime(session);
    await flushMicrotasks();
    expect(drains.mock.calls.length).toBe(1);
    await expectNextDrainAt(drains, SYNC_RETRY_BASE_MS * 2);
    await expectNextDrainAt(drains, SYNC_RETRY_BASE_MS * 4);
    await expectNextDrainAt(drains, SYNC_RETRY_BASE_MS);
  });
});
