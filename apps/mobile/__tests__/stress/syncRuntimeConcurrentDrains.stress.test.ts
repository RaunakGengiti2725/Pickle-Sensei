/**
 * stress / mod-sync-runtime — minimized deterministic repro of the one
 * defect the seeded concurrency campaign (syncRuntimeConcurrency) surfaces.
 *
 * `clearSyncRuntime()` bumps the generation and clears timers/listeners,
 * but a drain whose HTTP request is already in flight keeps running to
 * completion (there is no abort and `runningGenerations` is per
 * generation). `configureSyncRuntime()` right after it — the same user
 * signing back in, or another user signing in — immediately starts a new
 * drain on the SAME SQLite connection. When both responses land, the two
 * drains interleave `BEGIN IMMEDIATE … COMMIT`; the second BEGIN fails with
 * "cannot start a transaction within a transaction", the loser records
 * that message as `last_error` on every row it carried and counts a failed
 * drain (doubling the live runtime's back-off when it is the loser).
 * Durable data stays correct: the winner commits receipt + delete, the
 * loser spends no attempts, the server saw an idempotent replay.
 *
 * `test.failing` pins the defect: these tests PASS while it exists and
 * start failing once `clearSyncRuntime` waits for / aborts the in-flight
 * drain (or drains are serialized across generations) — flip them to plain
 * `it` then. The companion `it` blocks pin the invariants that hold today.
 *
 * Replay: npx jest __tests__/stress/syncRuntimeConcurrentDrains
 */
import { getDb } from '../../src/data/db';
import { createTransport } from '../../src/data/api';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  OWNER_A,
  OWNER_B,
  USER_A,
  USER_B,
  createStressWorld,
  enqueueShot,
  flush,
  inspectEnd,
  recordStress,
  release,
  requestSummary,
  signIn,
  signOut,
  statementTrace,
  teardownWorld,
  trigger,
  type StressWorld,
} from '../../testing/stress/syncRuntimeStressHarness';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../../src/data/api')>(
      '../../src/data/api',
    );
  return { ...actual, createTransport: jest.fn() };
});

const actualApi =
  jest.requireActual<typeof import('../../src/data/api')>('../../src/data/api');

const SUITE = 'syncRuntimeConcurrentDrains';

describe('stress: concurrent drains after re-configure', () => {
  const originalFetch = globalThis.fetch;
  let world: StressWorld;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'hrtime'] });
    world = createStressWorld({
      getDb: getDb as jest.Mock,
      createTransport: createTransport as jest.Mock,
      actualCreateTransport: actualApi.createTransport,
    });
  });

  afterEach(() => {
    teardownWorld(world, originalFetch);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** USER_A's drain has a request out; USER_A signs out and back in. */
  async function sameOwnerRace(): Promise<{ id: string }> {
    signIn(world, USER_A);
    await flush(4);
    const id = enqueueShot(world, USER_A, null);
    trigger();
    await flush(4);
    expect(world.pending.map(p => p.record.shotIds)).toEqual([[id]]);

    signOut(world);
    signIn(world, USER_A);
    await flush(4);
    // The new runtime re-sends the row the stale drain is still waiting on.
    expect(world.pending.map(p => p.record.shotIds)).toEqual([[id], [id]]);
    expect(world.stats.duplicateSends).toBe(1);

    // Stale response first, live response in the same tick.
    release(world, 0, 'accept');
    release(world, 0, 'accept');
    await flush(8);
    return { id };
  }

  /** USER_A's drain has a request out; USER_B signs in with a row queued. */
  async function twoOwnerRace(): Promise<{ a: string; b: string }> {
    signIn(world, USER_A);
    await flush(4);
    const a = enqueueShot(world, USER_A, null);
    const b = enqueueShot(world, USER_B, null);
    trigger();
    await flush(4);
    expect(world.pending.map(p => p.record.shotIds)).toEqual([[a]]);

    signOut(world);
    signIn(world, USER_B);
    await flush(4);
    expect(world.pending.map(p => p.record.shotIds)).toEqual([[a], [b]]);

    release(world, 0, 'accept');
    release(world, 0, 'accept');
    await flush(8);
    return { a, b };
  }

  it.failing(
    'same user re-signs in mid-request: no second drain on the one connection',
    async () => {
      await recordStress(SUITE, 'sameOwner.defect', 0, {}, async observed => {
        await sameOwnerRace();
        Object.assign(observed, {
          stats: world.stats,
          requestLog: requestSummary(world),
          statementTail: statementTrace(world, 40),
        });
        // Fails today: 1 nested BEGIN, 2 requests in flight for one owner.
        expect(world.stats.nestedBeginAttempts).toBe(0);
        expect(world.stats.maxInFlightSameOwner).toBe(1);
      });
    },
  );

  it.failing(
    'another user signs in mid-request: no second drain on the one connection',
    async () => {
      await recordStress(SUITE, 'twoOwner.defect', 0, {}, async observed => {
        await twoOwnerRace();
        Object.assign(observed, {
          stats: world.stats,
          requestLog: requestSummary(world),
          statementTail: statementTrace(world, 40),
        });
        expect(world.stats.nestedBeginAttempts).toBe(0);
        expect(world.stats.maxInFlight).toBe(1);
      });
    },
  );

  it('same-owner race keeps durable data consistent (HELD)', async () => {
    await recordStress(SUITE, 'sameOwner.held', 0, {}, async observed => {
      const { id } = await sameOwnerRace();
      const end = inspectEnd(world);
      const receiptsFor = world.fake.receipts.filter(r => r.entityId === id);
      Object.assign(observed, {
        stats: world.stats,
        end,
        receiptsFor,
        lastErrors: world.fake.outbox.map(r => r.last_error),
        statementTail: statementTrace(world, 40),
      });
      // The loser's BEGIN failed, nothing else went wrong on the connection.
      expect(world.stats.txErrors).toBe(world.stats.nestedBeginAttempts);
      expect(end.openTransactions).toBe(0);
      // Exactly one receipt under the right owner, row gone, server saw the
      // id once as accepted (second send was an idempotent replay).
      expect(receiptsFor).toEqual([
        { owner: OWNER_A, kind: 'shot.sync', entityId: id },
      ]);
      expect(world.fake.outbox).toEqual([]);
      expect(end.lostIds).toEqual([]);
      expect(end.receiptWithoutAccept).toEqual([]);
      expect(end.duplicateReceiptWrites).toBe(0);
      expect(world.acceptedIds.has(id)).toBe(true);
      // Only the live runtime's timer and listener remain.
      expect(jest.getTimerCount()).toBe(1);
      expect(end.listenersLive).toBe(1);
    });
  });

  it('two-owner race keeps both owners isolated and consistent (HELD)', async () => {
    await recordStress(SUITE, 'twoOwner.held', 0, {}, async observed => {
      const { a, b } = await twoOwnerRace();
      const end = inspectEnd(world);
      Object.assign(observed, {
        stats: world.stats,
        end,
        receipts: world.fake.receipts,
        requestLog: requestSummary(world),
        statementTail: statementTrace(world, 40),
      });
      expect(world.violations).toEqual([]);
      expect(world.stats.txErrors).toBe(world.stats.nestedBeginAttempts);
      expect(end.openTransactions).toBe(0);
      expect(end.lostIds).toEqual([]);
      expect(end.receiptOwnerMismatch).toEqual([]);
      expect(end.receiptWithoutAccept).toEqual([]);
      // The winner committed; the loser's row is still queued (its attempt
      // budget untouched) and drains on the next tick/timer.
      const receipted = new Set(world.fake.receipts.map(r => r.entityId));
      const queued = world.fake.outbox.map(r => r.owner_key);
      expect(receipted.size + queued.length).toBe(2);
      for (const row of world.fake.outbox) {
        expect(row.attempts).toBe(0);
        expect(row.attempts).toBeLessThan(OUTBOX_MAX_ATTEMPTS);
        expect(row.last_error).toContain(
          'cannot start a transaction within a transaction',
        );
      }
      const owners = { [a]: OWNER_A, [b]: OWNER_B };
      for (const r of world.fake.receipts) {
        expect(r.owner).toBe(owners[r.entityId]);
      }
    });
  });
});
