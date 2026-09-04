/**
 * ADVERSARIAL VARIANTS of the outbox head-of-line fix (0853e8c8) over REAL
 * SQLite (same node:sqlite seam as xc/adjudicate/outboxSqlite.test.ts).
 *
 * Attacks: boundary sizes around the 50-row batch, rows queued after the
 * rotation cursor moved, a permit.release row behind a stuck backlog,
 * per-owner cursor isolation, and the ordering interaction between the new
 * "never-attempted rows first" rule and the "sessions first" invariant
 * (a fresh session.finalize is now offered BEFORE the retried session.create
 * it depends on — the one failing case in this file).
 */
/// <reference types="node" />
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import type { LocalDb } from '../../../src/data/db';
import { getDb } from '../../../src/data/db';
import { ApiError } from '../../../src/data/api';
import {
  finishSession,
  queuePermitRelease,
  saveAnalysis,
  saveSession,
} from '../../../src/data/repository';
import {
  drainOutbox,
  OUTBOX_DRAIN_BATCH,
  SESSION_NOT_FOUND_REJECTION,
  type SyncTransport,
} from '../../../src/data/sync';

type SqlRow = Record<string, unknown>;
interface SqliteEngine {
  all(sql: string, params: unknown[]): SqlRow[];
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  };
}

const mockWorkerSource = `
  const { workerData } = require('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  const { port, flag } = workerData;
  const db = new DatabaseSync(':memory:');
  const reply = message => {
    port.postMessage(message);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  };
  port.on('message', ({ sql, params }) => {
    if (sql === null) { db.close(); port.close(); return; }
    try { reply({ rows: db.prepare(sql).all(...params) }); }
    catch (error) { reply({ error: String(error && error.message || error) }); }
  });
  reply({ ready: true });
`;

jest.mock('@op-engineering/op-sqlite', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { createRequire } =
    require('node:module') as typeof import('node:module');
  const { MessageChannel, Worker, receiveMessageOnPort } =
    require('node:worker_threads') as typeof import('node:worker_threads');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const bindable = (params: unknown[]) =>
    params.map(value => (value === undefined ? null : value));

  function inProcess(): SqliteEngine | null {
    try {
      const { DatabaseSync } = createRequire(__filename)(
        'node:sqlite',
      ) as NodeSqliteModule;
      const db = new DatabaseSync(':memory:');
      return {
        all: (sql, params) =>
          db.prepare(sql).all(...bindable(params)) as SqlRow[],
        close: () => db.close(),
      };
    } catch {
      return null;
    }
  }

  function workerBridge(): SqliteEngine {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(mockWorkerSource, {
      eval: true,
      execArgv: ['--experimental-sqlite', '--no-warnings'],
      workerData: { port: port2, flag },
      transferList: [port2],
    });
    const await_ = (): Record<string, unknown> => {
      const outcome = Atomics.wait(flag, 0, 0, 30_000);
      Atomics.store(flag, 0, 0);
      const received = receiveMessageOnPort(port1);
      if (!received) {
        throw new Error(
          `node:sqlite unavailable in-process and the --experimental-sqlite worker gave no reply (${outcome})`,
        );
      }
      return received.message as Record<string, unknown>;
    };
    await_();
    return {
      all: (sql, params) => {
        port1.postMessage({ sql, params: bindable(params) });
        const reply = await_();
        if (typeof reply['error'] === 'string') throw new Error(reply['error']);
        return reply['rows'] as SqlRow[];
      },
      close: () => {
        port1.postMessage({ sql: null, params: [] });
        port1.close();
        void worker.terminate();
      },
    };
  }

  return {
    open: () => {
      const engine = inProcess() ?? workerBridge();
      const run = (sql: string, params: unknown[] = []) => ({
        rows: engine.all(sql, params),
      });
      return {
        executeSync: run,
        execute: async (sql: string, params: unknown[] = []) =>
          run(sql, params),
        close: () => engine.close(),
      };
    },
  };
});

const BATCH = OUTBOX_DRAIN_BATCH;
const STUCK_SESSION = '99999999-9999-4999-8999-999999999999';

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
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

interface ServerModel {
  /** Sessions the server knows about (created). */
  sessions: Set<string>;
  /** Whether createSession reaches the server. */
  createReachable: boolean;
  calls: string[];
  released: Array<[string, string]>;
  batches: string[][];
}

/** A server that accepts standalone shots, rejects shots of unknown sessions
 * with the TRANSIENT code, 404s finalize of unknown sessions (mirrors
 * supabase/functions/api finalizeSession) and records every call. */
function server(): { model: ServerModel; transport: SyncTransport } {
  const model: ServerModel = {
    sessions: new Set(),
    createReachable: true,
    calls: [],
    released: [],
    batches: [],
  };
  const transport: SyncTransport = {
    async syncShots(shots) {
      const payloads = shots as Array<{ id: string; sessionId: string | null }>;
      model.batches.push(payloads.map(shot => shot.id));
      model.calls.push(`syncShots:${payloads.length}`);
      return {
        acceptedIds: payloads
          .filter(
            shot =>
              shot.sessionId === null || model.sessions.has(shot.sessionId),
          )
          .map(shot => shot.id),
        rejected: payloads
          .filter(
            shot =>
              shot.sessionId !== null && !model.sessions.has(shot.sessionId),
          )
          .map(shot => ({
            id: shot.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          })),
      };
    },
    async createSession(payload) {
      const id = String((payload as { id: unknown }).id);
      model.calls.push(`createSession:${id}`);
      if (!model.createReachable) {
        throw new TypeError('Network request failed');
      }
      model.sessions.add(id);
    },
    async finalizeSession(id) {
      model.calls.push(`finalizeSession:${id}`);
      if (!model.sessions.has(id)) {
        throw new ApiError(404, 'session.not_found', 'Session not found.');
      }
    },
    async releasePermit(permitId, outcome) {
      model.calls.push(`releasePermit:${permitId}`);
      model.released.push([permitId, outcome]);
    },
  };
  return { model, transport };
}

async function queueStuckShots(
  db: LocalDb,
  count: number,
  from = 1,
): Promise<void> {
  for (let n = from; n < from + count; n += 1) {
    await saveAnalysis(db, analysisFor(n, STUCK_SESSION), `permit-${n}`);
  }
}

async function outboxRows(db: LocalDb, owner = GUEST_DATA_OWNER) {
  const { rows } = await db.execute(
    `SELECT id, kind, attempts, last_error, json_extract(payload, '$.id') AS entity_id
     FROM outbox WHERE owner_key = ? ORDER BY id ASC`,
    [owner],
  );
  return rows as Array<{
    id: number;
    kind: string;
    attempts: number;
    last_error: string | null;
    entity_id: string | null;
  }>;
}

async function hasReceipt(
  db: LocalDb,
  id: string,
  owner = GUEST_DATA_OWNER,
): Promise<boolean> {
  const { rows } = await db.execute(
    `SELECT 1 AS present FROM sync_receipt
     WHERE owner_key = ? AND kind = 'shot.sync' AND entity_id = ?`,
    [owner, id],
  );
  return rows.length === 1;
}

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

describe('outbox fairness fix — adversarial variants over real SQLite', () => {
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    db = getDb();
  });

  afterEach(() => {
    db.close();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  describe.each([
    BATCH - 1,
    BATCH,
    BATCH + 1,
    2 * BATCH,
    2 * BATCH + 1,
    3 * BATCH + 7,
  ])(
    'boundary: %i transiently-stuck rows ahead of a newer standalone shot',
    stuck => {
      it('sends the newer shot within ceil(N/50)+1 drains and burns no attempt on the stuck rows', async () => {
        await queueStuckShots(db, stuck);
        await saveAnalysis(db, analysisFor(999, null), 'permit-999');
        const { transport } = server();

        const bound = Math.ceil(stuck / BATCH) + 1;
        const drains = await drainsUntilSent(db, transport, shotId(999), bound);

        expect(drains).toBeLessThanOrEqual(bound);
        const rows = await outboxRows(db);
        expect(rows).toHaveLength(stuck);
        expect(rows.every(row => row.attempts === 0)).toBe(true);
      });
    },
  );

  it('a row queued AFTER the cursor has rotated past the backlog is still taken on the very next drain', async () => {
    await queueStuckShots(db, 2 * BATCH + 5);
    const { transport } = server();
    // Rotate the cursor a few times so it sits somewhere inside the backlog.
    for (let i = 0; i < 4; i += 1) await drainOutbox(db, transport);

    await saveAnalysis(db, analysisFor(999, null), 'permit-999');
    await drainOutbox(db, transport);

    expect(await hasReceipt(db, shotId(999))).toBe(true);
  });

  it('several newer rows queued between drains each go out on the first drain after they were queued', async () => {
    await queueStuckShots(db, 3 * BATCH);
    const { transport } = server();
    // Every stuck row has been offered once (last_error set, budget intact).
    for (let i = 0; i < 3; i += 1) await drainOutbox(db, transport);
    expect((await outboxRows(db)).every(row => row.last_error !== null)).toBe(
      true,
    );
    for (let n = 900; n < 910; n += 1) {
      await saveAnalysis(db, analysisFor(n, null), `permit-${n}`);
      await drainOutbox(db, transport);
      expect(await hasReceipt(db, shotId(n))).toBe(true);
    }
    expect(await outboxRows(db)).toHaveLength(3 * BATCH);
  });

  it('a durable permit.release row behind a full stuck backlog reaches the server on the first drain', async () => {
    await queueStuckShots(db, 2 * BATCH);
    const { transport, model } = server();
    await drainOutbox(db, transport);
    await drainOutbox(db, transport);

    const permitId = '11111111-1111-4111-8111-111111111111';
    await queuePermitRelease(db, { permitId, outcome: 'failed' });
    await drainOutbox(db, transport);

    expect(model.released).toEqual([[permitId, 'failed']]);
    expect(
      (await outboxRows(db)).filter(row => row.kind === 'permit.release'),
    ).toHaveLength(0);
  });

  it('rotation cursors are isolated per owner (owner B’s backlog does not move owner A’s window)', async () => {
    const ownerA = canonicalDataOwner('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const ownerB = canonicalDataOwner('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const { transport } = server();

    setActiveDataOwner(ownerA);
    await queueStuckShots(db, BATCH + 10);
    await drainOutbox(db, transport);

    setActiveDataOwner(ownerB);
    await queueStuckShots(db, BATCH + 10, 500);
    for (let i = 0; i < 5; i += 1) await drainOutbox(db, transport);

    setActiveDataOwner(ownerA);
    await saveAnalysis(db, analysisFor(999, null), 'permit-999');
    await drainOutbox(db, transport);
    expect(await hasReceipt(db, shotId(999), ownerA)).toBe(true);
    expect(await outboxRows(db, ownerA)).toHaveLength(BATCH + 10);
    expect(await outboxRows(db, ownerB)).toHaveLength(BATCH + 10);
  });

  it('once the stuck session appears server-side every stuck row drains within ceil(N/50) drains', async () => {
    const stuck = 2 * BATCH + 3;
    await queueStuckShots(db, stuck);
    const { transport, model } = server();
    for (let i = 0; i < 3; i += 1) await drainOutbox(db, transport);
    expect(await outboxRows(db)).toHaveLength(stuck);

    model.sessions.add(STUCK_SESSION);
    for (let i = 0; i < Math.ceil(stuck / BATCH); i += 1) {
      await drainOutbox(db, transport);
    }
    expect(await outboxRows(db)).toHaveLength(0);
  });

  /**
   * ORDERING REGRESSION (fails on 0853e8c8, passes on 4d812e1a). Practice
   * set: session.create S was queued
   * and attempted while offline (last_error set, budget intact). The set ends
   * → session.finalize S is queued (never attempted). Network returns. The
   * candidate's batch order puts the never-attempted finalize row BEFORE the
   * retried create row, and the "sessions first" loop walks the batch in that
   * order, so finalize hits the server before the session exists → 404
   * session.not_found → PERMANENT failure → one attempt burned.
   *
   * Baseline 4d812e1a orders by id, so create ran first and both rows drained
   * clean in ONE drain with attempts = 0.
   */
  it('a fresh session.finalize does not burn a permanent attempt because it was offered before its retried session.create', async () => {
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const { transport, model } = server();

    await saveSession(db, {
      id: sessionId,
      mode: 'practice',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    // Offline drain: create is attempted, fails transiently, keeps its budget.
    model.createReachable = false;
    await drainOutbox(db, transport);
    let rows = await outboxRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('session.create');
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.last_error).not.toBeNull();

    // Set ends while still offline: finalize queued, never attempted.
    await finishSession(db, sessionId, { shots: 0 });

    // Network back: a single healthy drain.
    model.createReachable = true;
    model.calls.length = 0;
    const result = await drainOutbox(db, transport);

    rows = await outboxRows(db);
    // Expected (baseline behaviour): create before finalize, both synced in
    // one drain, no attempt burned.
    expect({
      calls: model.calls,
      result,
      leftover: rows.map(row => ({
        kind: row.kind,
        attempts: row.attempts,
        last_error: row.last_error,
      })),
    }).toEqual({
      calls: [`createSession:${sessionId}`, `finalizeSession:${sessionId}`],
      result: { synced: 2, failed: 0, remaining: 0 },
      leftover: [],
    });
  });
});
