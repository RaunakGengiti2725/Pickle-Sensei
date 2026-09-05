/**
 * STRESS — mod-sync-outbox / lens `boundary-malformed` — minimized repros.
 *
 * Each test is the smallest hand-written scenario that reproduces one BROKEN
 * class found by the seeded campaign (modSyncOutbox.boundaryMalformed.test.ts)
 * and asserts the graceful-rejection contract the campaign expects. They are
 * RED against src/data/sync.ts as of 1fb0efd7 on purpose: fixing the module
 * turns them green without touching the harness. Replay keys of the seeded
 * originals are in each test name.
 */
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { SyncTransport } from '../../src/data/sync';
import { createSqliteOutboxDb } from '../../__harness__/stress/modSyncOutbox/sqliteOutboxDb';
import {
  makeRng,
  seededUuid,
} from '../../__harness__/stress/modSyncOutbox/rng';
import { validShotPayload } from '../../__harness__/stress/modSyncOutbox/payloads';

const rng = makeRng(0x5eed);

function okTransport(
  accept: (ids: string[]) => unknown = ids => ids,
): SyncTransport {
  return {
    syncShots: async shots => ({
      acceptedIds: accept(
        shots.map(s => String((s as Record<string, unknown>)['id'])),
      ) as string[],
      rejected: [],
    }),
    createSession: async () => undefined,
    finalizeSession: async () => undefined,
  };
}

beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('mod-sync-outbox boundary-malformed — minimized repros', () => {
  it('[db-fault-rollback:711077086] a receipt-txn fault after one accepted shot must not over-count failed', async () => {
    const store = createSqliteOutboxDb();
    const a = seededUuid(rng);
    const b = seededUuid(rng);
    store.insert({
      owner: GUEST_DATA_OWNER,
      kind: 'shot.sync',
      payload: JSON.stringify(validShotPayload(rng, a)),
    });
    store.insert({
      owner: GUEST_DATA_OWNER,
      kind: 'shot.sync',
      payload: JSON.stringify(validShotPayload(rng, b)),
    });
    // Second COMMIT (entry 2/2) fails; the first shot is already committed.
    store.failOn({ pattern: /^COMMIT/, nth: 2, message: 'SQLITE_BUSY' });

    const result = await drainOutbox(store.db, okTransport());
    const rows = store.rows();
    const receipts = store.receipts();
    store.close();

    // Atomicity holds: shot a committed (receipt + delete), shot b rolled back.
    expect(receipts.map(r => r.entity_id)).toEqual([a]);
    expect(rows.map(r => r.payload).some(p => p.includes(b))).toBe(true);
    expect(result.remaining).toBe(1);
    // Contract: synced + failed == rows in the batch (2). Observed: 1 + 2.
    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('[transport-throw:42171501] a thrown value whose String() throws must not escape drainOutbox', async () => {
    const store = createSqliteOutboxDb();
    store.insert({
      owner: GUEST_DATA_OWNER,
      kind: 'shot.sync',
      payload: JSON.stringify(validShotPayload(rng)),
    });
    const hostile: SyncTransport = {
      ...okTransport(),
      syncShots: async () => {
        throw {
          toString: () => {
            throw new Error('nope');
          },
        };
      },
    };
    // Contract: transient failure recorded on the row, no throw out of the drain.
    await expect(drainOutbox(store.db, hostile)).resolves.toEqual({
      synced: 0,
      failed: 1,
      remaining: 1,
    });
    expect(store.inTransaction()).toBe(false);
    store.close();
  });

  it('[transport-throw:1035134657] a null-prototype thrown object must not escape drainOutbox', async () => {
    const store = createSqliteOutboxDb();
    store.insert({
      owner: GUEST_DATA_OWNER,
      kind: 'shot.sync',
      payload: JSON.stringify(validShotPayload(rng)),
    });
    const hostile: SyncTransport = {
      ...okTransport(),
      syncShots: async () => {
        throw Object.create(null) as unknown;
      },
    };
    await expect(drainOutbox(store.db, hostile)).resolves.toEqual({
      synced: 0,
      failed: 1,
      remaining: 1,
    });
    store.close();
  });

  it('[session-trial-rows:637455386] a session.finalize row whose payload is JSON null must leave the retry window', async () => {
    const store = createSqliteOutboxDb();
    const id = store.insert({
      owner: GUEST_DATA_OWNER,
      kind: 'session.finalize',
      payload: 'null',
    });
    const transport = okTransport();
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(store.db, transport);
    }
    const row = store.rows().find(r => r.id === id);
    store.close();
    expect(row).toBeDefined();
    expect(typeof row?.last_error).toBe('string');
    // Contract: an undrainable payload is a permanent failure — attempts
    // reach OUTBOX_MAX_ATTEMPTS and the row stops being selected. Observed:
    // TypeError from `payload['id']` is classified transient; attempts stay 0.
    expect(row?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
  });

  it('[response-shape:2092808065] a string-typed acceptedIds must not acknowledge single-character shot ids', async () => {
    const store = createSqliteOutboxDb();
    store.insert({
      owner: GUEST_DATA_OWNER,
      kind: 'shot.sync',
      payload: JSON.stringify(validShotPayload(rng, ' ')),
    });
    // Malformed server body: acceptedIds is a string, not an array.
    const result = await drainOutbox(
      store.db,
      okTransport(() => 'no shot was accepted'),
    );
    const rows = store.rows();
    const receipts = store.receipts();
    store.close();
    // Contract: no exact-string ack → row retained, no receipt, synced 0.
    expect(receipts).toHaveLength(0);
    expect(rows.some(r => r.owner_key === GUEST_DATA_OWNER)).toBe(true);
    expect(result.synced).toBe(0);
  });
});
