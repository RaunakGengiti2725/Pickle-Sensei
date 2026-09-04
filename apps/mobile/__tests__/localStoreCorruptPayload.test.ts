/// <reference types="node" />
/**
 * A single corrupt (non-JSON) `shot.sync` outbox row must fail ALONE. The
 * launch migrations in `db.ts` and the status read in `repository.ts` both
 * evaluate `json_extract()` over outbox payloads; without a `json_valid()`
 * guard SQLite raises "malformed JSON" for the whole statement, which makes
 * the local store unopenable on every launch and breaks the status read of
 * every healthy shot. Runs the production SQL against Node's real
 * `node:sqlite` over a file-backed database so the second launch sees
 * exactly what the first one left behind.
 *
 * Run: cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *      __tests__/localStoreCorruptPayload.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  getAnalysis,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
} from '../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  drainOutbox,
  type SyncTransport,
} from '../src/data/sync';

interface Handle {
  executeSync(
    sql: string,
    params?: unknown[],
  ): { rows: Record<string, unknown>[] };
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
}

const mockState: { file: string | null; opened: Handle[] } = {
  file: null,
  opened: [],
};

function mockOpenHandle(file: string): Handle {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: typeof DatabaseSyncType;
  };
  const raw = new DatabaseSync(file);
  const run = (sql: string, params: unknown[] = []) => ({
    rows: raw
      .prepare(sql)
      .all(...(params as never[]))
      .map(row => ({ ...(row as Record<string, unknown>) })),
  });
  return {
    executeSync: run,
    async execute(sql, params) {
      await Promise.resolve();
      return run(sql, params);
    },
    close() {
      raw.close();
    },
  };
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockState.file) throw new Error('harness: no database file');
    const handle = mockOpenHandle(mockState.file);
    mockState.opened.push(handle);
    return handle;
  },
}));

/** One app launch: a fresh `db.ts` module instance runs the production
 * migrations over the on-disk database and returns the app-facing LocalDb. */
function launch(): LocalDb {
  let db: LocalDb | null = null;
  jest.isolateModules(() => {
    db = jest
      .requireActual<typeof import('../src/data/db')>('../src/data/db')
      .getDb();
  });
  if (!db) throw new Error('db module did not load');
  return db;
}

const OWNER = canonicalDataOwner('11111111-1111-4111-8111-111111111111');
const PERMIT = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HEALTHY_SHOT = 'aaaaaaaa-0000-4000-8000-000000000001';
const CORRUPT_PAYLOADS = ['{"id":"broken', 'not json'];

function analysis(id: string): ShotAnalysis {
  return {
    id,
    sessionId: null,
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
      appVersion: '1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

function acceptingTransport(): SyncTransport & { offered: string[][] } {
  const offered: string[][] = [];
  return {
    offered,
    async syncShots(shots) {
      const ids = shots.map(shot =>
        String((shot as Record<string, unknown>)['id']),
      );
      offered.push(ids);
      return { acceptedIds: ids, rejected: [] };
    },
    async createSession() {},
    async finalizeSession() {},
  };
}

interface OutboxRow {
  id: number;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

async function outboxRows(db: LocalDb): Promise<OutboxRow[]> {
  const { rows } = await db.execute(
    `SELECT id, kind, payload, attempts, last_error FROM outbox
     WHERE owner_key = ? ORDER BY id ASC`,
    [OWNER],
  );
  return rows.map(row => ({
    id: Number(row['id']),
    kind: String(row['kind']),
    payload: String(row['payload']),
    attempts: Number(row['attempts']),
    last_error:
      typeof row['last_error'] === 'string' ? row['last_error'] : null,
  }));
}

describe('local store with a corrupt shot.sync outbox payload (real SQLite)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pickle-corrupt-outbox-'));
    mockState.file = join(dir, 'pickle-sensei.db');
    setActiveDataOwner(OWNER);

    // Launch 1: a healthy rating is queued, then row corruption leaves two
    // non-JSON shot.sync payloads next to it (no in-app writer produces
    // these; they model on-disk damage from an earlier build or a torn write).
    const first = launch();
    await saveAnalysis(first, analysis(HEALTHY_SHOT), PERMIT);
    for (const payload of CORRUPT_PAYLOADS) {
      await first.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
        [OWNER, payload],
      );
    }
    first.close();
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    for (const handle of mockState.opened.splice(0)) {
      try {
        handle.close();
      } catch {
        // already closed by the code under test
      }
    }
    mockState.file = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('the next launch opens the store and keeps every row, corrupt ones included', async () => {
    let db: LocalDb | null = null;
    expect(() => {
      db = launch();
    }).not.toThrow();

    expect(await getAnalysis(db!, HEALTHY_SHOT)).not.toBeNull();
    const rows = await outboxRows(db!);
    expect(rows).toHaveLength(1 + CORRUPT_PAYLOADS.length);
    expect(rows.filter(r => CORRUPT_PAYLOADS.includes(r.payload))).toHaveLength(
      CORRUPT_PAYLOADS.length,
    );
    // Launching again is idempotent: the corrupt rows are not swept by the
    // fixture-removal migration either (that DELETE targets real JSON whose
    // source is not 'real').
    db!.close();
    expect(() => launch()).not.toThrow();
  });

  it('a healthy shot still reports its outbox status next to corrupt siblings', async () => {
    const db = launch();
    await expect(getShotOutboxStatus(db, HEALTHY_SHOT)).resolves.toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    // A lookup that matches nothing must not surface the corrupt rows either.
    await expect(
      getShotOutboxStatus(db, 'aaaaaaaa-0000-4000-8000-000000000999'),
    ).resolves.toEqual({ state: 'absent' });
  });

  it('the drain syncs the healthy shot and records each corrupt row as its own permanent failure', async () => {
    const db = launch();
    const transport = acceptingTransport();

    const first = await drainOutbox(db, transport);
    expect(first).toEqual({
      synced: 1,
      failed: CORRUPT_PAYLOADS.length,
      remaining: CORRUPT_PAYLOADS.length,
    });
    expect(transport.offered).toEqual([[HEALTHY_SHOT]]);
    expect(await hasShotSyncReceipt(db, HEALTHY_SHOT)).toBe(true);

    let rows = await outboxRows(db);
    expect(rows.map(r => r.payload)).toEqual(CORRUPT_PAYLOADS);
    for (const row of rows) {
      expect(row.attempts).toBe(1);
      expect(row.last_error).toMatch(/SyntaxError/);
    }

    // The corrupt rows burn their bounded budget, then leave the window for
    // good — still on disk (never silently dropped) with the parse error
    // recorded, and never sent to the server.
    for (let i = 1; i < OUTBOX_MAX_ATTEMPTS + 2; i += 1) {
      await drainOutbox(db, transport);
    }
    rows = await outboxRows(db);
    expect(rows).toHaveLength(CORRUPT_PAYLOADS.length);
    expect(rows.every(r => r.attempts === OUTBOX_MAX_ATTEMPTS)).toBe(true);
    expect(transport.offered).toEqual([[HEALTHY_SHOT]]);
    expect(await drainOutbox(db, transport)).toEqual({
      synced: 0,
      failed: 0,
      remaining: CORRUPT_PAYLOADS.length,
    });
  });
});
