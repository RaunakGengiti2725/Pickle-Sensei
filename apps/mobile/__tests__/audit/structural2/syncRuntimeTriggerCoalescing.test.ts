/**
 * Structural audit (mobile-data-sync, pass 1) — `syncRuntime.ts:72-95`.
 *
 * Run: `cd apps/mobile && npx jest
 *       __tests__/audit/structural2/syncRuntimeTriggerCoalescing.test.ts`
 *
 * `triggerOutboxSync()` is called by AnalyzeScreen right after a new scored
 * rating enters the outbox. When a drain is already running the trigger
 * returns without remembering that new work arrived; the row waits for the
 * running drain's `finally → schedule()` timer (30s, or up to 5 min under
 * back-off).
 */
import {
  clearSyncRuntime,
  configureSyncRuntime,
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  SYNC_RETRY_MAX_MS,
  triggerOutboxSync,
} from '../../../src/data/syncRuntime';
import {
  canonicalDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../../src/data/accountScope';
import { drainOutbox } from '../../../src/data/sync';

jest.mock('../../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../../../src/data/sync', () => ({
  drainOutbox: jest.fn(),
}));

const drainOutboxMock = drainOutbox as jest.MockedFunction<typeof drainOutbox>;

const session = {
  canonicalAppUserId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  apiBaseUrl: 'https://api.test',
  bearerToken: 'bearer-token',
  provider: 'apple' as const,
};

type Deferred = {
  promise: Promise<{ synced: number; failed: number; remaining: number }>;
  resolve: (value: {
    synced: number;
    failed: number;
    remaining: number;
  }) => void;
};

function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<{
    synced: number;
    failed: number;
    remaining: number;
  }>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  drainOutboxMock.mockReset();
  setActiveDataOwner(canonicalDataOwner(session.canonicalAppUserId));
});

afterEach(() => {
  clearSyncRuntime();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.useRealTimers();
});

describe('triggerOutboxSync while a drain is in flight', () => {
  it('a row queued during an in-flight drain must be drained as soon as that drain finishes, not after the retry cadence', async () => {
    const first = deferred();
    const second = deferred();
    drainOutboxMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue({ synced: 0, failed: 0, remaining: 0 });

    configureSyncRuntime(session);
    await flushMicrotasks();
    expect(drainOutboxMock).toHaveBeenCalledTimes(1);

    // AnalyzeScreen saved a new scored rating while the first drain is still
    // waiting on the network and asks for a sync.
    triggerOutboxSync();
    await flushMicrotasks();

    // The first drain finishes; the outbox still holds the new row.
    first.resolve({ synced: 1, failed: 0, remaining: 1 });
    await flushMicrotasks();
    const drainsRightAfterFirstFinished = drainOutboxMock.mock.calls.length;

    jest.advanceTimersByTime(
      SYNC_RETRY_BASE_MS * (1 + SYNC_RETRY_JITTER_RATIO) + 1,
    );
    await flushMicrotasks();
    const drainsAfterRetryCadence = drainOutboxMock.mock.calls.length;
    second.resolve({ synced: 1, failed: 0, remaining: 0 });

    expect({ drainsRightAfterFirstFinished, drainsAfterRetryCadence }).toEqual({
      drainsRightAfterFirstFinished: 2,
      drainsAfterRetryCadence: 2,
    });
  });

  it('under back-off (one stuck row) a trigger during an in-flight drain waits up to SYNC_RETRY_MAX_MS', async () => {
    // Every drain reports one failed row (e.g. a shot whose session.create
    // was exhausted), so consecutiveFailures climbs and the timer backs off.
    const inFlight = deferred();
    drainOutboxMock.mockResolvedValue({ synced: 0, failed: 1, remaining: 1 });
    configureSyncRuntime(session);
    for (let i = 0; i < 6; i++) {
      await flushMicrotasks();
      jest.advanceTimersByTime(
        SYNC_RETRY_MAX_MS * (1 + SYNC_RETRY_JITTER_RATIO),
      );
    }
    await flushMicrotasks();
    drainOutboxMock.mockReturnValueOnce(inFlight.promise);
    jest.advanceTimersByTime(SYNC_RETRY_MAX_MS * (1 + SYNC_RETRY_JITTER_RATIO));
    await flushMicrotasks();
    const drainsWithOneInFlight = drainOutboxMock.mock.calls.length;

    triggerOutboxSync();
    await flushMicrotasks();
    inFlight.resolve({ synced: 0, failed: 1, remaining: 2 });
    await flushMicrotasks();
    const drainsRightAfterFinish = drainOutboxMock.mock.calls.length;
    // Just under the minimum back-off delay: the new row is still waiting.
    jest.advanceTimersByTime(
      SYNC_RETRY_MAX_MS * (1 - SYNC_RETRY_JITTER_RATIO) - 1,
    );
    await flushMicrotasks();
    const drainsBeforeBackoffElapsed = drainOutboxMock.mock.calls.length;

    expect({
      followUpDrainsRightAfterFinish:
        drainsRightAfterFinish - drainsWithOneInFlight,
      followUpDrainsBeforeBackoffElapsed:
        drainsBeforeBackoffElapsed - drainsWithOneInFlight,
    }).toEqual({
      followUpDrainsRightAfterFinish: 1,
      followUpDrainsBeforeBackoffElapsed: 1,
    });
  });
});
