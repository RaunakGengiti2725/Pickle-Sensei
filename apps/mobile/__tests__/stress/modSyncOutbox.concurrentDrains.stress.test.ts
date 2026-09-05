/**
 * STRESS — unit mod-sync-outbox, lens failure-injection (campaign B:
 * concurrent drains).
 *
 * `drainOutbox()` has no internal mutual exclusion; `syncRuntime` serialises
 * timer/foreground/trigger drains per configured generation
 * (`runningGenerations`). This campaign runs 2–3 REAL drains at once against
 * one REAL in-memory SQLite connection (`node:sqlite`) with the seeded
 * transport / SQLite faults of campaign A, interleaving statement completion
 * at random (micro/macro-task yields), and checks the persisted state:
 *
 *   - nothing durable disappears without a server acknowledgement
 *   - a deleted shot row always has its receipt (BEGIN/INSERT/DELETE/COMMIT
 *     is atomic even when another drain collides with the transaction)
 *   - attempts never exceed before + drains; untouchable rows stay untouched
 *   - no receipt for an id the server never accepted, none for other owners
 *   - no transaction left open, PRAGMA integrity_check = ok, no drain hangs
 *
 * Part 2 reproduces the ONE product path that yields two concurrent drains
 * on the same connection without the harness: `configureSyncRuntime()` called
 * again (sign-out → sign-in as the same account) while the previous
 * generation's drain is still awaiting the network. The old generation is
 * not cancelled and `runningGenerations` is keyed per generation, so the new
 * generation's initial `trigger()` starts a second drain immediately.
 *
 * Scale: STRESS_ITER (default 60). Replay: STRESS_SEED=<n>. Row table:
 * artifacts/stress/mod-sync-outbox-failure-injection/<STRESS_RUN_ID|latest>/campaignB.rows.json
 */
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../src/data/syncRuntime';
import {
  CONCURRENT_ITER_DEFAULT,
  envInt,
  replaySeed,
  runConcurrentIteration,
  writeArtifact,
  type ConcurrentIterationRow,
} from '../../__harness__/stress/campaign';
import { buildRow, makeRng } from '../../__harness__/stress/faultInjection';
import { SqliteStressDb } from '../../__harness__/stress/sqliteLocalDb';
import type { LocalDb } from '../../src/data/db';
import { drainOutbox, type SyncTransport } from '../../src/data/sync';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

import { getDb } from '../../src/data/db';

const ITER = envInt('STRESS_ITER', CONCURRENT_ITER_DEFAULT);
const SEED_BASE = envInt('STRESS_SEED_BASE', 0xc0dec0de);
const REPLAY = replaySeed();
const SEEDS =
  REPLAY !== null
    ? [REPLAY]
    : Array.from({ length: ITER }, (_, i) => SEED_BASE + i);

const rows: ConcurrentIterationRow[] = [];

afterAll(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  const byOutcome = new Map<string, number>();
  const byViolation = new Map<string, number>();
  for (const row of rows) {
    byOutcome.set(row.outcome, (byOutcome.get(row.outcome) ?? 0) + 1);
    for (const violation of row.violations) {
      const key = `${violation.finding ?? 'unknown'}:${violation.code}`;
      byViolation.set(key, (byViolation.get(key) ?? 0) + 1);
    }
  }
  writeArtifact('campaignB.rows.json', rows);
  writeArtifact('campaignB.summary.json', {
    suite: 'mod-sync-outbox/failure-injection/campaignB',
    iterations: rows.length,
    drains: rows.reduce((sum, row) => sum + row.drains, 0),
    injectedFaults: rows.reduce((sum, row) => sum + row.injectedFaults, 0),
    collisions: rows.filter(row => row.nestedBeginRefusals > 0).length,
    overReportedSynced: rows.filter(row => row.syncedReported > row.rowsDeleted)
      .length,
    outcomes: Object.fromEntries(byOutcome),
    violations: Object.fromEntries(byViolation),
    seedsWithUnknownViolations: rows
      .filter(row => row.violations.some(violation => !violation.finding))
      .map(row => row.seed),
    seedBase: SEED_BASE,
  });
});

describe(`campaign B — ${SEEDS.length} seeded concurrent-drain iterations`, () => {
  test(
    'every iteration ran, and no invariant failed outside the pinned findings',
    async () => {
      for (const seed of SEEDS) {
        rows.push(await runConcurrentIteration(seed));
      }
      expect(rows).toHaveLength(SEEDS.length);
      const unknown = rows.filter(row =>
        row.violations.some(violation => !violation.finding),
      );
      expect(
        unknown.map(row => ({
          seed: row.seed,
          replay: row.replay,
          violations: row.violations.filter(violation => !violation.finding),
        })),
      ).toEqual([]);
    },
    Math.max(30_000, SEEDS.length * 250),
  );

  test('the campaign actually collided transactions (nested BEGIN refused at least once)', () => {
    if (REPLAY !== null) return;
    expect(
      rows.filter(row => row.nestedBeginRefusals > 0).length,
    ).toBeGreaterThan(0);
  });

  test('no concurrent drain hung', () => {
    expect(
      rows
        .filter(row =>
          row.settlements.some(settlement => settlement.settlement === 'hung'),
        )
        .map(row => row.seed),
    ).toEqual([]);
  });
});

// ─── part 2: the real runtime, re-configured mid-drain ───────────────────────

describe('syncRuntime re-configured while a drain is in flight (real drainOutbox, real SQLite)', () => {
  const session: ApiSession = {
    canonicalAppUserId: '33333333-3333-4333-8333-333333333333',
    apiBaseUrl: 'https://api.test',
    bearerToken: 'access-token-v1',
    provider: 'apple',
  };
  const owner = canonicalDataOwner(session.canonicalAppUserId);

  interface PendingFetch {
    url: string;
    resolve: (body: unknown) => void;
  }
  let pending: PendingFetch[];
  let db: SqliteStressDb;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    pending = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(
      (url: string) =>
        new Promise(resolve => {
          pending.push({
            url,
            resolve: body =>
              resolve({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => null },
                json: async () => body,
              }),
          });
        }),
    );
    // Macro-task yields only: `setTimeout` is on the fake clock here.
    db = new SqliteStressDb({ rng: makeRng(0xabcdef), yieldMode: 'macro' });
    (getDb as jest.Mock).mockReturnValue(db);
    setActiveDataOwner(owner);
    establishApiSession(session);
  });

  afterEach(() => {
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    delete (globalThis as { fetch?: unknown }).fetch;
    db.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  test('two generations drain the same owner at once; every deleted shot row keeps its receipt and no transaction is left open', async () => {
    const rng = makeRng(0x5151);
    const shots = Array.from({ length: 4 }, (_, index) =>
      buildRow(rng, `s${index}`, 'shot_ok', null),
    );
    for (const shot of shots) {
      db.insertOutboxRow({
        owner,
        kind: shot.outboxKind,
        payload: shot.payload,
        attempts: shot.attempts,
      });
    }
    const ids = shots.map(shot => shot.entityId as string);

    configureSyncRuntime(session);
    await settle();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.url).toContain('/v1/shots:sync');

    // Sign-out → sign-in as the same account while the first request is in
    // flight: a NEW generation, whose initial trigger is not blocked by the
    // old generation's `runningGenerations` entry.
    configureSyncRuntime(session);
    await settle();
    expect(pending).toHaveLength(2);
    expect(pending[1]!.url).toContain('/v1/shots:sync');

    // Both requests accept everything; the two drains now race through
    // BEGIN IMMEDIATE / INSERT receipt / DELETE / COMMIT on one connection.
    pending[1]!.resolve({ acceptedIds: ids, rejected: [] });
    pending[0]!.resolve({ acceptedIds: ids, rejected: [] });
    for (let index = 0; index < 40; index += 1) await settle();

    const outbox = db.outboxRows().filter(row => row.owner_key === owner);
    const receipts = new Set(db.receipts().map(receipt => receipt.entity_id));
    const deletedWithoutReceipt = ids.filter(
      id =>
        !outbox.some(row => JSON.parse(row.payload).id === id) &&
        !receipts.has(id),
    );
    const statements = db.classes();
    expect({
      deletedWithoutReceipt,
      inTransaction: db.isInTransaction(),
      integrity: db.integrityCheck(),
      // Both drains selected the batch and both reached the receipt path.
      selects: statements.filter(statement => statement === 'select_batch')
        .length,
      begins:
        statements.filter(statement => statement === 'begin').length >=
        ids.length,
      // A shot the collision left queued spent at most one attempt of its
      // budget (two drains, one server acceptance each — never more).
      maxAttemptsOnQueuedRows: Math.max(0, ...outbox.map(row => row.attempts)),
    }).toEqual({
      deletedWithoutReceipt: [],
      inTransaction: false,
      integrity: 'ok',
      selects: 2,
      begins: true,
      maxAttemptsOnQueuedRows: expect.any(Number),
    });
    expect(Math.max(0, ...outbox.map(row => row.attempts))).toBeLessThanOrEqual(
      2,
    );
  });
});

// ─── part 3: deterministic interleave — ROLLBACK is connection-wide ──────────

/**
 * Two callers on ONE connection, each with its own statement gates so the
 * exact completion order is scripted (the inner db yields nothing).
 */
class ScriptedCaller implements LocalDb {
  constructor(
    private readonly inner: SqliteStressDb,
    private readonly hook: (sql: string, nth: number) => Promise<void> | void,
  ) {}

  private readonly counts = new Map<string, number>();

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const key = sql.trim().split(/\s+/).slice(0, 3).join(' ');
    const nth = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, nth);
    await this.hook(sql, nth);
    return this.inner.execute(sql, params);
  }

  close(): void {
    this.inner.close();
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>(resolve => {
    open = resolve;
  });
  return { wait, open };
}

const isDelete = (sql: string) => /^\s*DELETE FROM outbox/.test(sql);
const isInsertReceipt = (sql: string) =>
  /^\s*INSERT OR REPLACE INTO sync_receipt/.test(sql);
const isBegin = (sql: string) => /^\s*BEGIN/.test(sql);
const isRollback = (sql: string) => /^\s*ROLLBACK/.test(sql);

/**
 * Drain A's DELETE fails with a storage error that SQLite auto-rolls back
 * (SQLITE_IOERR / SQLITE_FULL semantics), so drain B's BEGIN succeeds before
 * drain A issues its own `ROLLBACK`. Returns the durable state after both
 * drains settle.
 */
async function runRollbackRace(
  order: 'rollback_between_insert_and_delete' | 'fifo',
) {
  const inner = new SqliteStressDb({ yieldMode: 'none' });
  const owner = GUEST_DATA_OWNER;
  setActiveDataOwner(owner);
  const shot = buildRow(makeRng(0x0f3), 'x', 'shot_ok', null);
  inner.insertOutboxRow({
    owner,
    kind: shot.outboxKind,
    payload: shot.payload,
  });
  const shotId = String(shot.entityId);
  const transport: SyncTransport = {
    syncShots: async batch => ({
      acceptedIds: batch.map(item => String((item as { id: unknown }).id)),
      rejected: [],
    }),
    createSession: async () => {},
    finalizeSession: async () => {},
  };

  const aFailed = gate();
  const aRollbackMayRun = gate();
  const bBegan = gate();
  const bInserted = gate();
  const bDeleteMayRun = gate();
  const aRolledBack = gate();

  const callerA = new ScriptedCaller(inner, async (sql, nth) => {
    if (isDelete(sql) && nth === 1) {
      // Storage error inside the transaction; SQLite abandons the transaction.
      inner.abortOpenTransaction();
      aFailed.open();
      throw new Error('disk I/O error (SQLITE_IOERR)');
    }
    if (isRollback(sql)) {
      await aRollbackMayRun.wait;
    }
  });
  const callerB = new ScriptedCaller(inner, async (sql, nth) => {
    if (isBegin(sql)) await aFailed.wait;
    if (isInsertReceipt(sql)) {
      bBegan.open();
      if (order === 'fifo') await aRolledBack.wait;
    }
    if (isDelete(sql) && nth === 1) {
      bInserted.open();
      await bDeleteMayRun.wait;
    }
  });

  const drainA = drainOutbox(callerA, transport).then(
    result => ({ settled: 'resolved' as const, result, error: null }),
    (error: unknown) => ({
      settled: 'rejected' as const,
      result: null,
      error: String(error),
    }),
  );
  drainA.finally(() => aRolledBack.open());
  const drainB = drainOutbox(callerB, transport).then(
    result => ({ settled: 'resolved' as const, result, error: null }),
    (error: unknown) => ({
      settled: 'rejected' as const,
      result: null,
      error: String(error),
    }),
  );

  if (order === 'rollback_between_insert_and_delete') {
    await bInserted.wait; // B: BEGIN + INSERT receipt done, DELETE parked
    aRollbackMayRun.open(); // A: ROLLBACK lands on B's open transaction
    await aRolledBack.wait;
    bDeleteMayRun.open(); // B: DELETE now runs in autocommit
  } else {
    await bBegan.wait; // B: BEGIN done, INSERT parked
    aRollbackMayRun.open(); // A: ROLLBACK lands on B's still-empty transaction
    await aRolledBack.wait;
    await bInserted.wait; // B: INSERT ran in autocommit
    bDeleteMayRun.open();
  }
  const [a, b] = await Promise.all([drainA, drainB]);
  const outbox = inner.outboxRows().filter(row => row.owner_key === owner);
  const receipts = inner.receipts().map(receipt => receipt.entity_id);
  const state = {
    rowStillQueued: outbox.some(
      row => String(JSON.parse(row.payload).id) === shotId,
    ),
    receiptPresent: receipts.includes(shotId),
    inTransaction: inner.isInTransaction(),
    integrity: inner.integrityCheck(),
    engineErrors: [...inner.engineErrors],
    a,
    b,
  };
  inner.close();
  setActiveDataOwner(GUEST_DATA_OWNER);
  return state;
}

describe('F3 — a drain\u2019s error-path ROLLBACK is connection-wide, not transaction-scoped (sync.ts:224-243)', () => {
  test('FIFO completion order (rollback before the other drain\u2019s INSERT): durable state HELD, only the reported counts are wrong', async () => {
    const state = await runRollbackRace('fifo');
    expect(state).toMatchObject({
      rowStillQueued: false,
      receiptPresent: true,
      inTransaction: false,
      integrity: 'ok',
    });
    // Both drains report the accepted shot as failed even though it is
    // durably synced with its receipt — a false FAILURE, never a false success.
    expect(state.a.result).toMatchObject({ synced: 0, failed: 1 });
    expect(state.b.result).toMatchObject({ synced: 0, failed: 1 });
  });

  // Pinned known deviation: with the other drain's INSERT already applied
  // inside its own transaction, the first drain's ROLLBACK discards that
  // receipt; the other drain's DELETE then runs in autocommit and the outbox
  // row disappears WITHOUT its receipt. Flip to `test` when fixed.
  test.failing(
    'ROLLBACK between the other drain\u2019s INSERT and DELETE: the accepted shot row is deleted with NO receipt',
    async () => {
      const state = await runRollbackRace('rollback_between_insert_and_delete');
      expect({
        rowStillQueued: state.rowStillQueued,
        receiptPresent: state.receiptPresent,
        integrity: state.integrity,
      }).toEqual({
        rowStillQueued: false,
        receiptPresent: true,
        integrity: 'ok',
      });
    },
  );

  test('the F3 interleave is concrete: row gone, receipt gone, both drains report failure, no transaction left open', async () => {
    const state = await runRollbackRace('rollback_between_insert_and_delete');
    expect(state).toMatchObject({
      rowStillQueued: false,
      receiptPresent: false,
      inTransaction: false,
      integrity: 'ok',
    });
    expect(state.engineErrors).toEqual([
      'commit: Error: cannot commit - no transaction is active',
      'rollback: Error: cannot rollback - no transaction is active',
    ]);
    expect(state.a.result).toMatchObject({ synced: 0, failed: 1 });
    expect(state.b.result).toMatchObject({ synced: 0, failed: 1 });
  });
});

// Keep the guest owner as the default for any later suite in the same worker.
afterAll(() => setActiveDataOwner(GUEST_DATA_OWNER));
