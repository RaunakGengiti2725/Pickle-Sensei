/**
 * Outbox drain fairness over REAL SQLite. The op-sqlite seam is backed by
 * `node:sqlite` so the engine — not a fake — decides what
 * `ORDER BY … LIMIT 50` returns, and the real `getDb()` migrations build the
 * schema the drain runs against.
 *
 * The head-of-line hazard: rows rejected with a TRANSIENT code keep their
 * attempt budget (correct — they must retry), so 50 of them are eligible
 * forever. A drain that always takes the 50 lowest ids therefore never
 * reaches a newer row. A newer row must be attempted within a bounded number
 * of drains no matter how many older rows are stuck.
 *
 * Requires `node:sqlite`: built in from Node 22.13; on 22.11/22.12 run with
 * `NODE_OPTIONS=--experimental-sqlite`. A missing module FAILS these tests
 * rather than skipping them.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import type { LocalDb } from '../../../src/data/db';
import { getDb } from '../../../src/data/db';
import { saveAnalysis } from '../../../src/data/repository';
import {
  drainOutbox,
  SESSION_NOT_FOUND_REJECTION,
  type SyncTransport,
} from '../../../src/data/sync';

interface NodeSqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    let sqlite: { DatabaseSync: new (path: string) => NodeSqliteDatabase };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sqlite = require('node:sqlite');
    } catch (error) {
      throw new Error(
        `node:sqlite is required for this suite (Node >= 22.13, or NODE_OPTIONS=--experimental-sqlite): ${String(error)}`,
      );
    }
    const native = new sqlite.DatabaseSync(':memory:');
    const run = (sql: string, params: unknown[] = []) => ({
      rows: native
        .prepare(sql)
        .all(...params.map(value => (value === undefined ? null : value))),
    });
    return {
      executeSync: run,
      execute: async (sql: string, params: unknown[] = []) => run(sql, params),
      close: () => native.close(),
    };
  },
}));

const BATCH = 50;

function shotId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function analysisFor(n: number, sessionId: string | null): ShotAnalysis {
  return {
    id: shotId(n),
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-26T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'test-native-1',
      analysisEngineVersion: 'engine-1',
      scoringModelVersion: 'scoring-1',
    },
    source: 'real',
  };
}

/** Accepts every standalone shot; rejects every session-bound shot with the
 * TRANSIENT "session not found" code (the session.create row never arrives,
 * so those rows stay eligible forever). */
function stuckSessionTransport(): {
  transport: SyncTransport;
  batches: string[][];
} {
  const batches: string[][] = [];
  const transport: SyncTransport = {
    async syncShots(shots) {
      const payloads = shots as Array<{ id: string; sessionId: string | null }>;
      batches.push(payloads.map(shot => shot.id));
      return {
        acceptedIds: payloads
          .filter(shot => shot.sessionId === null)
          .map(shot => shot.id),
        rejected: payloads
          .filter(shot => shot.sessionId !== null)
          .map(shot => ({
            id: shot.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          })),
      };
    },
    async createSession() {},
    async finalizeSession() {},
  };
  return { transport, batches };
}

async function queueStuckShots(db: LocalDb, count: number): Promise<void> {
  for (let n = 1; n <= count; n += 1) {
    await saveAnalysis(
      db,
      analysisFor(n, '99999999-9999-4999-8999-999999999999'),
      `permit-${n}`,
    );
  }
}

async function outboxRows(db: LocalDb) {
  const { rows } = await db.execute(
    `SELECT id, kind, attempts, last_error, json_extract(payload, '$.id') AS shot_id
     FROM outbox WHERE owner_key = ? ORDER BY id ASC`,
    [GUEST_DATA_OWNER],
  );
  return rows as Array<{
    id: number;
    kind: string;
    attempts: number;
    last_error: string | null;
    shot_id: string;
  }>;
}

async function hasReceipt(db: LocalDb, id: string): Promise<boolean> {
  const { rows } = await db.execute(
    `SELECT 1 AS present FROM sync_receipt
     WHERE owner_key = ? AND kind = 'shot.sync' AND entity_id = ?`,
    [GUEST_DATA_OWNER, id],
  );
  return rows.length === 1;
}

/** Drains until `id` has a receipt or `maxDrains` is exhausted; returns the
 * number of drains it took (or `maxDrains + 1` when it never went through). */
async function drainsUntilSent(
  db: LocalDb,
  transport: SyncTransport,
  id: string,
  maxDrains: number,
): Promise<number> {
  for (let drain = 1; drain <= maxDrains; drain += 1) {
    await drainOutbox(db, transport);
    if (await hasReceipt(db, id)) return drain;
  }
  return maxDrains + 1;
}

describe('outbox drain over real SQLite', () => {
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    db = getDb();
  });

  afterEach(() => {
    db.close();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('1: the migrated schema drains a standalone shot and records its receipt', async () => {
    await saveAnalysis(db, analysisFor(1, null), 'permit-1');
    const { transport } = stuckSessionTransport();

    const result = await drainOutbox(db, transport);

    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(await hasReceipt(db, shotId(1))).toBe(true);
    expect(await outboxRows(db)).toHaveLength(0);
  });

  it('2: a newer shot behind 50 transiently-rejected rows is sent within 3 drains', async () => {
    await queueStuckShots(db, BATCH);
    await saveAnalysis(db, analysisFor(999, null), 'permit-999');
    const { transport } = stuckSessionTransport();

    const drains = await drainsUntilSent(db, transport, shotId(999), 3);

    expect(drains).toBeLessThanOrEqual(3);
    const rows = await outboxRows(db);
    expect(rows).toHaveLength(BATCH);
    expect(rows.map(row => row.shot_id)).not.toContain(shotId(999));
  });

  it('transient rows stay queued and retryable after the newer row went through', async () => {
    await queueStuckShots(db, BATCH);
    await saveAnalysis(db, analysisFor(999, null), 'permit-999');
    const { transport, batches } = stuckSessionTransport();

    await drainsUntilSent(db, transport, shotId(999), 3);
    expect(await hasReceipt(db, shotId(999))).toBe(true);

    const afterNewRow = await outboxRows(db);
    expect(afterNewRow).toHaveLength(BATCH);
    // Never marked permanent: the attempt budget is untouched, only the
    // reason is recorded.
    expect(afterNewRow.every(row => row.attempts === 0)).toBe(true);
    expect(
      afterNewRow.every(row =>
        String(row.last_error).startsWith(SESSION_NOT_FOUND_REJECTION),
      ),
    ).toBe(true);

    // Still retried: the next drain offers every one of them to the server.
    batches.length = 0;
    const result = await drainOutbox(db, transport);
    expect(result).toEqual({ synced: 0, failed: BATCH, remaining: BATCH });
    expect(new Set(batches.flat())).toEqual(
      new Set(afterNewRow.map(row => row.shot_id)),
    );
    expect((await outboxRows(db)).every(row => row.attempts === 0)).toBe(true);
  });

  it('every row is attempted within ceil(N / 50) + 1 drains, however deep the stuck backlog', async () => {
    const stuck = 120;
    await queueStuckShots(db, stuck);
    await saveAnalysis(db, analysisFor(999, null), 'permit-999');
    const { transport, batches } = stuckSessionTransport();

    const bound = Math.ceil(stuck / BATCH) + 1;
    const drains = await drainsUntilSent(db, transport, shotId(999), bound);
    expect(drains).toBeLessThanOrEqual(bound);

    // The stuck rows keep rotating: across the next ceil(N/50) drains each
    // one is offered at least once, so no row is ever left behind.
    batches.length = 0;
    for (let drain = 0; drain < Math.ceil(stuck / BATCH); drain += 1) {
      await drainOutbox(db, transport);
    }
    const offered = new Set(batches.flat());
    for (let n = 1; n <= stuck; n += 1) {
      expect(offered.has(shotId(n))).toBe(true);
    }
    expect(await outboxRows(db)).toHaveLength(stuck);
  });
});
