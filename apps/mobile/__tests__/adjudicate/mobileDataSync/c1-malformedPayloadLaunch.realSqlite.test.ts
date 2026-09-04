/**
 * C1 — a single outbox row whose payload is not valid JSON makes every
 * `getDb()` call throw on launch, because the always-run migration
 * `DELETE FROM outbox WHERE kind = 'shot.sync' AND json_extract(payload, '$.source') <> 'real'`
 * evaluates `json_extract` over the stored text. The row also poisons
 * `getShotOutboxStatus()` for unrelated healthy shots (same `json_extract`).
 *
 * Expected (these assertions describe the CORRECT behaviour, so they fail on
 * the baseline and pass once fixed): opening the store tolerates a
 * non-JSON payload (skips or quarantines the row) and a healthy shot's
 * status lookup is unaffected by a sibling row.
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
import {
  getShotOutboxStatus,
  saveAnalysis,
} from '../../../src/data/repository';
import {
  CANONICAL_USER,
  PERMIT_ID,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);

describe('C1: malformed outbox payload vs launch migrations (real SQLite)', () => {
  let db: LocalDb;

  beforeAll(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    // A row a previous build / partial write left behind: kind is right,
    // payload is not JSON. Nothing in the app can ever repair or drop it.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts) VALUES (?, 'shot.sync', ?, 8)`,
      [OWNER, '{"id":"broken'],
    );
    db.close();
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      // already closed
    }
    mockSqlite.reset();
  });

  it('getDb() still opens the store on the next launch', () => {
    expect(() => getDb()).not.toThrow();
  });

  it('a healthy shot still reports its outbox status', async () => {
    const status = await getShotOutboxStatus(getDb(), shotId(1));
    expect(status.state).toBe('queued');
  });
});
