/**
 * ADVERSARIAL TEST (expected to FAIL on ca8a3407) — MDS-2 neighbourhood.
 *
 * Not a regression: the same mechanism exists on 4d812e1a (INFERRED from
 * code; there the sibling BEGIN would more often have failed outright). It
 * is a hole next to the fix: `withLocalTransaction` serializes TRANSACTION
 * SCOPES on the one shared connection, but a plain statement issued while a
 * queued transaction is open is, in SQLite, part of that transaction. If the
 * transaction then rolls back (disk full, I/O error, a failed outbox insert),
 * the plain statement's write is rolled back too, although its own caller
 * already resolved successfully.
 *
 * Shown here with `saveLocalOnlyAnalysis` (a single non-transactional
 * INSERT) landing inside a `saveAnalysis` transaction that fails on its
 * outbox INSERT: the local-only read is silently lost.
 *
 * Run: cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *      __tests__/attack/mdsPlainWriteAbsorbedByTransaction.attack.test.ts --ci
 */
import { createRealSqliteModule } from '../../test-support/realSqlite';

const mockSqlite = createRealSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import type { LocalDb } from '../../src/data/db';
import { getDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  getAnalysis,
  saveAnalysis,
  saveLocalOnlyAnalysis,
} from '../../src/data/repository';
import {
  CANONICAL_USER,
  PERMIT_ID,
  realAnalysis,
  shotId,
} from '../../test-support/localDataFixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);

afterEach(() => {
  try {
    getDb().close();
  } catch {
    // already closed
  }
  mockSqlite.reset();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('plain write issued while a queued transaction is open', () => {
  it('a saved local-only read survives a sibling transaction rolling back', async () => {
    setActiveDataOwner(OWNER);
    const real = getDb();
    // The shared connection, with the outbox INSERT of the scored save failing
    // the way a full disk would — after the transaction is already open.
    const db: LocalDb = {
      async execute(sql, params) {
        if (sql.includes('INSERT INTO outbox')) {
          await new Promise(resolve => setTimeout(resolve, 5));
          throw new Error('database or disk is full');
        }
        return real.execute(sql, params);
      },
      close: () => real.close(),
    };

    const scoredSave = saveAnalysis(
      db,
      realAnalysis({ id: shotId(1) }),
      PERMIT_ID,
    ).then(
      () => 'resolved',
      error => String(error),
    );
    // Give the queued transaction time to BEGIN, then write a low-confidence read
    // the ordinary non-transactional way.
    await new Promise(resolve => setTimeout(resolve, 1));
    const lowConfidence = {
      ...realAnalysis({ id: shotId(2) }),
      resultKind: 'low_confidence' as const,
    };
    await saveLocalOnlyAnalysis(db, lowConfidence);

    expect(await scoredSave).toContain('disk is full');
    // saveLocalOnlyAnalysis resolved without error: its row must exist.
    expect(await getAnalysis(db, shotId(2))).not.toBeNull();
  });
});
