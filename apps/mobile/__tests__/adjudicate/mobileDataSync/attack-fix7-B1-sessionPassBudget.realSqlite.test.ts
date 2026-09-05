/**
 * Adversary round 7 — candidate B (`devin/fix6-mds-sqlite-b` @ 7bd9d7af),
 * ported to candidate A in fix round 8 (imports/helpers only; the
 * description below is of the candidate it was written against, and the
 * assertions pin the corrected semantics candidate A now implements).
 *
 * Claim attacked: (6)/(upgrade-compat) "a row whose payload cannot become a
 * request fails alone and permanently; it never poisons the whole batch", and
 * the syncRuntime backoff contract that a drain over a healthy queue reports
 * `failed: 0`.
 *
 * The session pass reads EVERY `session.create` row regardless of budget
 * (`budgetSql: attempts < ? OR kind = 'session.create'`) so that exhausted
 * sets can be marked dead. A `session.create` row whose payload is not JSON
 * is charged (`recordRowFailure(..., permanent=true)`) BEFORE the attempts
 * check runs, on every drain, forever: it is never quarantined, `failed` is
 * ≥ 1 on every drain of an otherwise healthy queue, and `attempts` grows
 * without bound. A `session.create` row whose payload is the JSON literal
 * `null` is worse: `String(payload['id'])` throws outside the guarded parse,
 * the whole drain rejects, nothing is charged, and no shot of that owner
 * ever syncs again.
 *
 * Every test in this file FAILS on the unmodified candidate. Real
 * node:sqlite, real transaction/sync/repository/accountScope modules; the
 * only fault injection is the seeded outbox row (database boundary).
 */
import type { LocalDb } from '../../../src/data/db';
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { getDb } from '../../../src/data/db';
import { hasShotSyncReceipt, saveAnalysis } from '../../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS, drainOutbox } from '../../../src/data/sync';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_MAX_MS,
  nextSyncRetryDelayMs,
} from '../../../src/data/syncRuntime';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);

async function clearAll(db: LocalDb): Promise<void> {
  await db.execute(`DELETE FROM outbox`);
  await db.execute(`DELETE FROM local_shot`);
  await db.execute(`DELETE FROM local_session`);
  await db.execute(`DELETE FROM sync_receipt`);
}

describe('B7-1 / B7-2: the session pass has no budget for unparseable session.create rows (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await clearAll(db);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('B7-1: an exhausted session.create row with a non-JSON payload is charged again on every drain and keeps every drain of a healthy queue failing', async () => {
    // Written by an older build: budget already spent, payload not JSON.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'session.create', ?, ?, ?)`,
      [OWNER, '{not json', OUTBOX_MAX_ATTEMPTS, 'SyntaxError: old build'],
    );
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);

    const transport = acceptAllTransport();
    const results = [];
    for (let i = 0; i < 5; i += 1)
      results.push(await drainOutbox(db, transport));
    const rows = await outboxRows(db, OWNER);

    // The healthy read lands on the first drain …
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    // … and from then on the queue holds one row the drain has already given
    // up on. A quarantined row costs nothing: failed = 0, attempts frozen.
    expect(results.map(r => r.failed)).toEqual([0, 0, 0, 0, 0]);
    expect(rows).toEqual([
      {
        id: rows[0]!.id,
        kind: 'session.create',
        attempts: OUTBOX_MAX_ATTEMPTS,
        last_error: 'SyntaxError: old build',
      },
    ]);
  });

  it('B7-1b: syncRuntime backoff never recovers while that row exists — delay pinned at the ceiling for a queue with nothing left to send', async () => {
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'session.create', ?, ?, ?)`,
      [OWNER, '{not json', OUTBOX_MAX_ATTEMPTS, 'SyntaxError: old build'],
    );
    const transport = acceptAllTransport();
    // Mirrors configureSyncRuntime's `trigger`: a drain with failed > 0 is a
    // consecutive failure; failed = 0 resets the streak.
    let consecutiveFailures = 0;
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await drainOutbox(db, transport);
      consecutiveFailures = r.failed > 0 ? consecutiveFailures + 1 : 0;
      delays.push(nextSyncRetryDelayMs(consecutiveFailures, () => 0.5));
    }
    const attempts = (await outboxRows(db, OWNER))[0]!.attempts;
    expect({ delays, attempts }).toEqual({
      delays: Array<number>(6).fill(SYNC_RETRY_BASE_MS),
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    expect(Math.max(...delays)).toBeLessThan(SYNC_RETRY_MAX_MS);
  });

  it('B7-2: a session.create row whose payload is the JSON literal null rejects the whole drain, is never charged, and blocks every shot of the owner forever', async () => {
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', 'null')`,
      [OWNER],
    );
    await saveAnalysis(db, realAnalysis({ id: shotId(2) }), PERMIT_ID);
    const transport = acceptAllTransport();
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      outcomes.push(
        await drainOutbox(db, transport).then(
          r => `resolved failed=${r.failed}`,
          e => `rejected ${String(e).slice(0, 60)}`,
        ),
      );
    }
    const rows = await outboxRows(db, OWNER);
    expect({
      outcomes,
      receipt: await hasShotSyncReceipt(db, shotId(2)),
      poisonedRowAttempts: rows.find(r => r.kind === 'session.create')!
        .attempts,
    }).toEqual({
      // A row that cannot become a request fails alone and permanently.
      outcomes: ['resolved failed=1', 'resolved failed=0', 'resolved failed=0'],
      receipt: true,
      poisonedRowAttempts: expect.any(Number),
    });
  });
});
