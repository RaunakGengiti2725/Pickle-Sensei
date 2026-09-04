/**
 * MDS-1 regression: ONE non-JSON `shot.sync` outbox payload must fail alone.
 *
 * The launch migration in `src/data/db.ts` deletes fixture reads with
 * `json_extract(payload, '$.source')`, and `getShotOutboxStatus()` matches
 * rows with `json_extract(payload, '$.id')`. SQLite raises "malformed JSON"
 * for the whole statement when ANY visited row is not JSON, so a single
 * corrupt row used to abort `openMigrated()` — the handle was closed and the
 * error rethrown on EVERY launch, making history, progress and the outbox
 * permanently unreachable — and to break the status read of unrelated healthy
 * shots.
 *
 * Contract asserted here, against real SQLite: the store opens, healthy rows
 * survive, a healthy shot's status resolves, and the corrupt row is still
 * reported by the drain (recorded as failed, budget spent) rather than
 * silently dropped.
 *
 * Run: cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *      __tests__/localStoreCorruptPayload.test.ts
 */
import { createRealSqliteModule } from '../test-support/realSqlite';

const mockSqlite = createRealSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import type { LocalDb } from '../src/data/db';
import { getDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  getAnalysis,
  getShotOutboxStatus,
  saveAnalysis,
} from '../src/data/repository';
import { drainOutbox, type SyncTransport } from '../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  shotId,
} from '../test-support/localDataFixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const CORRUPT_PAYLOAD = '{"id":"broken';

const acceptAll: SyncTransport = {
  async syncShots(shots) {
    return {
      acceptedIds: shots.map(shot =>
        String((shot as Record<string, unknown>)['id']),
      ),
      rejected: [],
    };
  },
  async createSession() {},
  async finalizeSession() {},
};

describe('a corrupt shot.sync payload fails alone (real SQLite)', () => {
  beforeAll(async () => {
    setActiveDataOwner(OWNER);
    const first = getDb();
    await saveAnalysis(first, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    // Row corruption (a truncated write, a restored backup): nothing in the
    // app can produce it — `repository` always JSON.stringify()s — and
    // nothing in the app could repair it either.
    await first.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [OWNER, CORRUPT_PAYLOAD],
    );
    // The app is killed and relaunched: migrations run again over the row.
    first.close();
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('does not stop the local store from opening on the next launch', () => {
    expect(() => getDb()).not.toThrow();
  });

  it('keeps the healthy rows the launch migration visited', async () => {
    const db = getDb();
    expect(await getAnalysis(db, shotId(1))).not.toBeNull();
  });

  it('leaves a healthy shot able to report its outbox status', async () => {
    await expect(getShotOutboxStatus(getDb(), shotId(1))).resolves.toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
  });

  it('reports the corrupt row as a failed row instead of dropping it', async () => {
    const db: LocalDb = getDb();
    const result = await drainOutbox(db, acceptAll);
    expect(result.failed).toBe(1);

    const rows = await outboxRows(db, OWNER);
    const corrupt = rows.filter(row => row.payload === CORRUPT_PAYLOAD);
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]?.attempts).toBe(1);
    expect(corrupt[0]?.lastError).toContain('JSON');
    // The healthy shot next to it drained normally.
    expect(rows.filter(row => row.payload !== CORRUPT_PAYLOAD)).toEqual([]);
  });
});
