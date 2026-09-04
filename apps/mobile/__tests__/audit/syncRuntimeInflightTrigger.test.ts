/**
 * Structural audit (mobile-data-sync, pass 1) — `src/data/syncRuntime.ts`
 * trigger coalescing while a drain is in flight (syncRuntime.ts:72-95).
 *
 * `trigger()` returns early when `runningGenerations` already holds the
 * configured generation and does NOT remember that new work arrived. The
 * running drain's `finally` only calls `schedule()`, whose delay is
 * `nextSyncRetryDelayMs(consecutiveFailures)` — ≥ 24 s when healthy and up to
 * 6 min after failures. So a scored result saved while a drain is running
 * (AnalyzeScreen → triggerOutboxSync) is not uploaded when that drain ends;
 * it waits for the timer even though the device is online and idle.
 */
import type { ApiSession } from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

const drainState: {
  starts: number;
  release: Array<() => void>;
} = { starts: 0, release: [] };

jest.mock('../../src/data/sync', () => ({
  drainOutbox: jest.fn(
    () =>
      new Promise<{ synced: number; failed: number; remaining: number }>(
        resolve => {
          drainState.starts += 1;
          drainState.release.push(() =>
            resolve({ synced: 1, failed: 0, remaining: 0 }),
          );
        },
      ),
  ),
}));

import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';

const session = {
  canonicalAppUserId: '33333333-3333-4333-8333-333333333333',
  apiBaseUrl: 'https://api.test',
  bearerToken: 'bearer-token',
} as ApiSession;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('syncRuntime — triggerOutboxSync during an in-flight drain', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    drainState.starts = 0;
    drainState.release = [];
    setActiveDataOwner(canonicalDataOwner(session.canonicalAppUserId));
  });

  afterEach(() => {
    clearSyncRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    jest.useRealTimers();
  });

  it('VERIFIED: configure starts one drain immediately and a trigger after it completes drains again at once', async () => {
    configureSyncRuntime(session);
    await flushMicrotasks();
    expect(drainState.starts).toBe(1);
    drainState.release[0]!();
    await flushMicrotasks();
    triggerOutboxSync();
    await flushMicrotasks();
    expect(drainState.starts).toBe(2);
  });

  it('VERIFIED: a healthy drain re-arms the timer within the 30s ±20% cadence', async () => {
    configureSyncRuntime(session);
    await flushMicrotasks();
    drainState.release[0]!();
    await flushMicrotasks();
    jest.advanceTimersByTime(
      Math.floor(SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO)) - 1,
    );
    expect(drainState.starts).toBe(1);
    jest.advanceTimersByTime(
      Math.ceil(SYNC_RETRY_BASE_MS * (1 + SYNC_RETRY_JITTER_RATIO)) + 2,
    );
    await flushMicrotasks();
    expect(drainState.starts).toBe(2);
  });

  it('FINDING syncRuntime.ts:72-95 — a trigger during an in-flight drain must start a follow-up drain when it finishes', async () => {
    configureSyncRuntime(session);
    await flushMicrotasks();
    expect(drainState.starts).toBe(1);

    // A new scored result lands in the outbox while the drain is in flight.
    triggerOutboxSync();
    await flushMicrotasks();
    expect(drainState.starts).toBe(1); // coalesced (fine so far)

    // The in-flight drain finishes: the new row is still durable & unsent.
    drainState.release[0]!();
    await flushMicrotasks();
    // Expected: the coalesced trigger is honoured immediately (or on the
    // next tick) — the device is online and a request was explicitly asked.
    // Observed: nothing happens until the retry timer (≥ 24 s) fires.
    expect(drainState.starts).toBe(2);
  });

  it('EVIDENCE: the coalesced row waits the full retry cadence (24-36 s healthy)', async () => {
    configureSyncRuntime(session);
    await flushMicrotasks();
    triggerOutboxSync();
    drainState.release[0]!();
    await flushMicrotasks();
    expect(drainState.starts).toBe(1);
    jest.advanceTimersByTime(
      Math.floor(SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO)) - 1,
    );
    await flushMicrotasks();
    expect(drainState.starts).toBe(1);
    jest.advanceTimersByTime(
      Math.ceil(SYNC_RETRY_BASE_MS * (1 + SYNC_RETRY_JITTER_RATIO)) + 2,
    );
    await flushMicrotasks();
    expect(drainState.starts).toBe(2);
  });
});
