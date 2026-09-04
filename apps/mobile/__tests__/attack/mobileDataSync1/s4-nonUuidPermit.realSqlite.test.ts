/**
 * ATTACK S4 — a queued shot whose analysisPermitId is 'not-a-uuid'.
 *
 * Client pre-validation (sync.ts toSyncPayload / repository.ts saveAnalysis)
 * only checks `analysisPermitId.trim() !== ''`; the server's parseSyncShot
 * (supabase/functions/api/index.ts:973) requires a UUID and answers
 * `shot.invalid_payload`, which the client classifies as PERMANENT. The row
 * therefore costs one network round trip per drain for 8 drains before it is
 * parked as `exhausted`.
 *
 * Real production schema on node:sqlite; server emulated in-process with the
 * same UUID regex as the edge function.
 */
import type { LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import {
  getShotOutboxStatus,
  saveAnalysis,
} from '../../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS, drainOutbox } from '../../../src/data/sync';
import { deriveUploadQueueStatus } from '../../../src/data/offlineCapabilities';
import {
  OWNER_A,
  SHOT_ID,
  createServerEmulator,
  realAnalysis,
} from '../../../testing/attack/mobileDataSyncFixtures';
import { createOpSqliteModuleMock } from '../../../testing/attack/nodeSqliteOpAdapter';

const mockOpSqlite = createOpSqliteModuleMock();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options),
}));

function loadRealGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb = jest.requireActual<typeof import('../../../src/data/db')>(
      '../../../src/data/db',
    ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

async function outboxRows(db: LocalDb) {
  const { rows } = await db.execute(
    `SELECT id, kind, attempts, last_error,
            json_extract(payload, '$.analysisPermitId') AS permit_id
       FROM outbox ORDER BY id ASC`,
  );
  return rows;
}

describe('ATTACK S4 — non-UUID analysisPermitId reaches the wire and burns the permanent budget [real sqlite]', () => {
  let db: LocalDb;

  beforeEach(() => {
    db = loadRealGetDb()();
    setActiveDataOwner(OWNER_A);
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
  });

  it('saveAnalysis accepts a non-UUID permit id (only emptiness is checked) and queues it verbatim', async () => {
    await expect(
      saveAnalysis(db, realAnalysis, 'not-a-uuid'),
    ).resolves.toBeUndefined();
    const rows = await outboxRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['permit_id']).toBe('not-a-uuid');
  });

  it('drain #1: the client SENDS the malformed permit; the server rejects shot.invalid_payload; attempts becomes 1 (permanent)', async () => {
    await saveAnalysis(db, realAnalysis, 'not-a-uuid');
    const server = createServerEmulator();

    const result = await drainOutbox(db, server);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.shots[0]).toMatchObject({
      id: SHOT_ID,
      analysisPermitId: 'not-a-uuid',
    });
    expect(server.inserted).toEqual([]);
    expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });

    const rows = await outboxRows(db);
    expect(rows[0]!['attempts']).toBe(1);
    expect(rows[0]!['last_error']).toBe(
      'shot.invalid_payload: analysisPermitId must be a UUID.',
    );
    expect(await getShotOutboxStatus(db, SHOT_ID)).toEqual({
      state: 'rejected',
      attempts: 1,
      lastError: 'shot.invalid_payload: analysisPermitId must be a UUID.',
    });
  });

  it(`drains 1..${OUTBOX_MAX_ATTEMPTS} each spend one network round trip on a payload that can never be accepted; drain ${OUTBOX_MAX_ATTEMPTS + 1} skips it (exhausted)`, async () => {
    await saveAnalysis(db, realAnalysis, 'not-a-uuid');
    const server = createServerEmulator();

    for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i++) {
      const result = await drainOutbox(db, server);
      expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
      expect(server.requests).toHaveLength(i);
      const rows = await outboxRows(db);
      expect(rows[0]!['attempts']).toBe(i);
    }

    const after = await drainOutbox(db, server);
    // Excluded from the drain (attempts >= cap) but still counted in
    // `remaining`, and no further request is issued.
    expect(after).toEqual({ synced: 0, failed: 0, remaining: 1 });
    expect(server.requests).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(await getShotOutboxStatus(db, SHOT_ID)).toEqual({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: 'shot.invalid_payload: analysisPermitId must be a UUID.',
    });
    const rows = await outboxRows(db);
    expect(
      deriveUploadQueueStatus(
        rows.map(r => ({
          kind: String(r['kind']),
          attempts: Number(r['attempts']),
          lastError: (r['last_error'] as string | null) ?? null,
        })),
      ),
    ).toEqual({ state: 'needs_attention', pending: 0, exhausted: 1 });
  });

  it('other near-miss permit ids the client lets through: whitespace-padded UUID is sent UNTRIMMED and rejected; upper-case UUID is accepted', async () => {
    const padded = ` cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee `;
    const upper = 'CCCCCCCC-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
    await saveAnalysis(db, realAnalysis, padded);
    await saveAnalysis(
      db,
      { ...realAnalysis, id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      upper,
    );
    const server = createServerEmulator();
    const result = await drainOutbox(db, server);

    expect(server.requests[0]!.shots.map(s => s.analysisPermitId)).toEqual([
      padded,
      upper,
    ]);
    expect(result).toEqual({ synced: 1, failed: 1, remaining: 1 });
    const rows = await outboxRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['permit_id']).toBe(padded);
    expect(rows[0]!['attempts']).toBe(1);
  });

  it('a malformed permit never poisons a valid sibling in the same batch', async () => {
    await saveAnalysis(db, realAnalysis, 'not-a-uuid');
    await saveAnalysis(
      db,
      { ...realAnalysis, id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    const server = createServerEmulator();
    const result = await drainOutbox(db, server);
    expect(result).toEqual({ synced: 1, failed: 1, remaining: 1 });
    expect(server.inserted).toEqual(['bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
  });

  it('an EMPTY permit id is refused locally by saveAnalysis (never queued) — the only client-side gate that exists', async () => {
    await expect(saveAnalysis(db, realAnalysis, '   ')).rejects.toThrow(
      /server-reserved analysis permit is required/,
    );
    expect(await outboxRows(db)).toEqual([]);
  });
});
