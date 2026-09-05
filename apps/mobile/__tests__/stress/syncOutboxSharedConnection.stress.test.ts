/**
 * STRESS — `mod-sync-outbox`, lens `concurrency`: minimized deterministic
 * reproductions of the shared-connection transaction collision surfaced by
 * the seeded campaign (syncOutboxConcurrency.stress.test.ts; e.g. seeds 176,
 * 28, 187 for drain→writer, seed 21 for writer→writer).
 *
 * Both `drainOutbox` (src/data/sync.ts) and `saveAnalysis`
 * (src/data/repository.ts `inTransaction`) open `BEGIN IMMEDIATE` on the ONE
 * op-sqlite connection returned by `getDb()`. SQLite transactions are
 * per-connection, so when one actor's transaction is open the other's BEGIN
 * fails with "cannot start a transaction within a transaction".
 *
 *   - drain holds / writer collides → `saveAnalysis` REJECTS: the scored
 *     rating is not persisted and `runCaptureAnalysis` fails the run
 *     (pinned below with `test.failing`, i.e. the EXPECTED behaviour is
 *     asserted and the block flips red once the defect is fixed — remove
 *     `.failing` here and `writerNeverFails` from KNOWN_DEFECT_INVARIANTS
 *     together).
 *   - writer holds / drain collides → the drain recovers: the request's
 *     shots are marked transient, stay queued and are re-sent (server replay
 *     acknowledges them). Pinned as a regular passing test so the recovery
 *     path cannot regress silently.
 *
 * Real SQLite (node:sqlite) behind the op-sqlite seam; no scheduler
 * randomness — the interleaving is forced synchronously at the drain's
 * BEGIN, exactly the way the shared connection interleaves two callers.
 */
import {
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb, type LocalDb } from '../../src/data/db';
import { saveAnalysis } from '../../src/data/repository';
import { drainOutbox, type SyncTransport } from '../../src/data/sync';
import { makePrng, uuid } from '../../stress-harness/syncOutbox/prng';
import { buildAnalysis } from '../../stress-harness/syncOutbox/scenario';
import { Scheduler } from '../../stress-harness/syncOutbox/scheduler';
import { seam } from '../../stress-harness/syncOutbox/sqliteSeam';

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () =>
    jest
      .requireActual<
        typeof import('../../stress-harness/syncOutbox/sqliteSeam')
      >('../../stress-harness/syncOutbox/sqliteSeam')
      .seam.open(),
}));

const OWNER = '11111111-2222-4333-8444-555555555555';
const rng = makePrng(176);

function freshDb(): LocalDb {
  seam.attach(
    new Scheduler(makePrng(1), {
      dbMaxHops: 1,
      netMinHops: 1,
      netMaxHops: 1,
      actorStartMaxHops: 0,
      macroChance: 0,
    }),
  );
  seam.resetLog();
  setActiveDataOwner(OWNER);
  getDb().close();
  return getDb();
}

function tagged(db: LocalDb, actor: string): LocalDb {
  return {
    execute: (sql, params) => {
      seam.currentActor = actor;
      return db.execute(sql, params);
    },
    close: () => db.close(),
  };
}

function queuedShot(db: LocalDb, id: string): Promise<unknown> {
  return db.execute(
    `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
    [
      OWNER,
      JSON.stringify({
        ...buildAnalysis(rng, id, null),
        analysisPermitId: uuid(rng),
      }),
    ],
  );
}

function acceptingTransport(sent: string[][]): SyncTransport {
  return {
    syncShots: async shots => {
      const ids = shots.map(s => (s as { id: string }).id);
      sent.push(ids);
      return { acceptedIds: ids, rejected: [] };
    },
    createSession: async () => undefined,
    finalizeSession: async () => undefined,
  };
}

function countRows(sql: string, params: unknown[]): number {
  return (
    seam
      .raw()
      .prepare(sql)
      .get(...(params as string[])) as { n: number }
  ).n;
}

afterEach(() => {
  setActiveDataOwner('signed-out');
});

describe('outbox drain and rating persistence share one SQLite connection', () => {
  test.failing(
    'a rating saved while the drain commits a receipt is persisted (drain→writer)',
    async () => {
      const db = freshDb();
      const queuedId = uuid(rng);
      await queuedShot(db, queuedId);
      const ratedId = uuid(rng);
      const drainDb = tagged(db, 'drain');
      let writer: Promise<void> | null = null;
      const collidingDb: LocalDb = {
        execute: (sql, params) => {
          const result = drainDb.execute(sql, params);
          if (sql === 'BEGIN IMMEDIATE' && writer === null) {
            // The scoring run finishes while the drain's receipt transaction
            // is open: saveAnalysis issues its own BEGIN on the same
            // connection, queued right behind the drain's.
            writer = saveAnalysis(
              tagged(db, 'writer'),
              buildAnalysis(rng, ratedId, null),
              uuid(rng),
            );
          }
          return result;
        },
        close: () => {},
      };

      const sent: string[][] = [];
      const drained = await drainOutbox(collidingDb, acceptingTransport(sent));
      expect(drained).toEqual({ synced: 1, failed: 0, remaining: 0 });
      expect(sent).toEqual([[queuedId]]);
      expect(writer).not.toBeNull();

      // EXPECTED: the rating write is serialized after the drain's commit
      // and lands. OBSERVED on 1fb0efd7: rejects with
      // "cannot start a transaction within a transaction", the local_shot
      // row is missing and nothing is queued for sync.
      await expect(writer).resolves.toBeUndefined();
      expect(
        countRows(
          'SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND id = ?',
          [OWNER, ratedId],
        ),
      ).toBe(1);
      expect(
        countRows(
          `SELECT count(*) AS n FROM outbox WHERE owner_key = ? AND kind = 'shot.sync' AND json_extract(payload, '$.id') = ?`,
          [OWNER, ratedId],
        ),
      ).toBe(1);
    },
  );

  test('the drain that collides with an open rating transaction recovers: shots stay queued and re-sync (writer→drain)', async () => {
    const db = freshDb();
    const queuedId = uuid(rng);
    await queuedShot(db, queuedId);
    const ratedId = uuid(rng);
    const writerDb = tagged(db, 'writer');
    const drainDb = tagged(db, 'drain');
    const sent: string[][] = [];
    const transport = acceptingTransport(sent);

    let drain: Promise<{
      synced: number;
      failed: number;
      remaining: number;
    }> | null = null;
    const collidingWriterDb: LocalDb = {
      execute: (sql, params) => {
        const result = writerDb.execute(sql, params);
        if (sql === 'BEGIN IMMEDIATE' && drain === null) {
          // Sync kicks in (foreground / timer) while the rating transaction
          // is open; the drain's SELECT runs inside it and its receipt BEGIN
          // collides.
          drain = drainOutbox(drainDb, transport);
        }
        return result;
      },
      close: () => {},
    };

    await saveAnalysis(
      collidingWriterDb,
      buildAnalysis(rng, ratedId, null),
      uuid(rng),
    );
    expect(drain).not.toBeNull();
    const first = await drain!;

    // Rating write landed and is queued; the drain sent the accepted shot
    // but could not record its receipt, so it reports the row as failed
    // (transient) and leaves it queued — no receipt, no deletion.
    expect(
      countRows(
        'SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND id = ?',
        [OWNER, ratedId],
      ),
    ).toBe(1);
    expect(sent).toEqual([[queuedId]]);
    expect(first.synced).toBe(0);
    expect(first.failed).toBe(1);
    expect(
      countRows('SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ?', [
        OWNER,
      ]),
    ).toBe(0);
    const [queued] = (
      await db.execute(
        `SELECT attempts, last_error FROM outbox WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
        [OWNER, queuedId],
      )
    ).rows;
    expect(queued).toMatchObject({ attempts: 0 });
    expect(String(queued?.['last_error'])).toMatch(/within a transaction/);
    expect(seam.log.filter(e => !e.ok).map(e => e.actor)).toEqual(['drain']);

    // Next pass (no collision): both shots sync, the server sees the first
    // one twice (replay-acknowledged), and every deleted row has a receipt.
    const second = await drainOutbox(drainDb, transport);
    expect(second).toEqual({ synced: 2, failed: 0, remaining: 0 });
    expect(sent[1]).toEqual(expect.arrayContaining([queuedId, ratedId]));
    expect(
      countRows('SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ?', [
        OWNER,
      ]),
    ).toBe(2);
    expect(getActiveDataOwner()).toBe(OWNER);
  });
});
