/// <reference types="node" />
/**
 * ADJUDICATION of the mobile-data-sync audit reports (commit 4d812e1a).
 *
 * Every test below asserts the CONTRACT the fixer must satisfy, so each one
 * fails on 4d812e1a — the failure output is the adjudicator's independent
 * reproduction of a reported defect — and must exit 0 once the defect is
 * fixed. Nothing here touches production code or an existing test.
 *
 * The real-SQLite harness (adjudication-support/realSqlite.ts) is the file the
 * structural auditor wrote: production `db.ts` migrations, `repository.ts`
 * writes and the `sync.ts` drain run against Node's `node:sqlite`, so DDL,
 * `json_extract`, `BEGIN IMMEDIATE` and the 50-row window execute for real.
 * Run: cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *      __tests__/adjudication
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import { ApiError } from '../../src/data/api';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
} from '../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../src/data/sync';
import {
  asLocalDb,
  openRealSqlite,
  type RealSqliteHandle,
} from '../../adjudication-support/realSqlite';

const mockState: { handle: RealSqliteHandle | null } = { handle: null };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockState.handle) throw new Error('adjudication harness: no handle');
    return mockState.handle;
  },
}));

/** Runs the production launch migrations over `handle` and returns the
 * app-facing LocalDb from a fresh `db.ts` module instance (one "launch"). */
function launch(handle: RealSqliteHandle): LocalDb {
  mockState.handle = handle;
  let db: LocalDb | null = null;
  jest.isolateModules(() => {
    db = jest
      .requireActual<typeof import('../../src/data/db')>('../../src/data/db')
      .getDb();
  });
  if (!db) throw new Error('db module did not load');
  return db;
}

function fileBackedPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'pickle-adj-')), 'pickle-sensei.db');
}

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const owner = canonicalDataOwner(OWNER_ID);
const PERMIT = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function uuid(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function sessionUuid(n: number): string {
  return `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function analysis(id: string, sessionId: string | null): ShotAnalysis {
  return {
    id,
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

/** Accepts every shot and every session (the healthy server). */
function acceptingTransport(): {
  transport: SyncTransport;
  calls: { syncShots: number; createSession: number; shotsOffered: string[][] };
} {
  const calls = {
    syncShots: 0,
    createSession: 0,
    shotsOffered: [] as string[][],
  };
  return {
    calls,
    transport: {
      async syncShots(shots) {
        calls.syncShots += 1;
        const ids = shots.map(shot =>
          String((shot as Record<string, unknown>)['id']),
        );
        calls.shotsOffered.push(ids);
        return { acceptedIds: ids, rejected: [] };
      },
      async createSession() {
        calls.createSession += 1;
      },
      async finalizeSession() {},
    },
  };
}

/** A server that only accepts shots whose session it has seen, and that
 * permanently refuses `brokenSession` (mirrors `apply_synced_shot`). */
function serverLikeTransport(brokenSession: string): {
  transport: SyncTransport;
  calls: { createSession: number; syncShots: number };
} {
  const knownSessions = new Set<string>();
  const calls = { createSession: 0, syncShots: 0 };
  return {
    calls,
    transport: {
      async createSession(session) {
        calls.createSession += 1;
        const id = String((session as Record<string, unknown>)['id']);
        if (id === brokenSession) {
          throw new ApiError(400, 'validation.session', 'Invalid session.');
        }
        knownSessions.add(id);
      },
      async finalizeSession() {},
      async syncShots(shots) {
        calls.syncShots += 1;
        const acceptedIds: string[] = [];
        const rejected: Array<{ id: string; code: string; message: string }> =
          [];
        for (const raw of shots) {
          const shot = raw as Record<string, unknown>;
          const sessionId = shot['sessionId'];
          if (sessionId === null || knownSessions.has(String(sessionId))) {
            acceptedIds.push(String(shot['id']));
          } else {
            rejected.push({
              id: String(shot['id']),
              code: SESSION_NOT_FOUND_REJECTION,
              message: 'Session not found or not yours.',
            });
          }
        }
        return { acceptedIds, rejected };
      },
    },
  };
}

describe('ADJUDICATION mobile-data-sync (fails on 4d812e1a by design)', () => {
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    try {
      mockState.handle?.close();
    } catch {
      // already closed by the code under test
    }
    mockState.handle = null;
  });

  it('A1: one non-JSON shot.sync payload must not stop the database from opening on the next launch', async () => {
    const path = fileBackedPath();
    const first = openRealSqlite(path);
    const db = launch(first);
    setActiveDataOwner(owner);
    await saveAnalysis(db, analysis(uuid(1), null), PERMIT);
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [owner, 'not json'],
    );
    first.close();

    const second = openRealSqlite(path);
    expect(() => launch(second)).not.toThrow();
    const healthy = second.executeSync(
      `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND id = ?`,
      [owner, uuid(1)],
    ).rows[0];
    expect(Number(healthy?.['n'])).toBe(1);
  });

  it('A2: a corrupt sibling outbox row must not break the status read of a healthy shot', async () => {
    const handle = openRealSqlite();
    const db = launch(handle);
    setActiveDataOwner(owner);
    await saveAnalysis(db, analysis(uuid(1), null), PERMIT);
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [owner, 'not json'],
    );
    await expect(getShotOutboxStatus(db, uuid(1))).resolves.toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
  });

  it('B1: a scored rating saved while the drain holds its receipt transaction must still persist', async () => {
    const handle = openRealSqlite();
    const bootstrap = launch(handle);
    setActiveDataOwner(owner);
    await saveAnalysis(bootstrap, analysis(uuid(1), null), PERMIT);

    let competing: Promise<unknown> | null = null;
    let scheduled = false;
    const db = asLocalDb(handle, sql => {
      // The drain's receipt transaction has just opened: a scoring run that
      // finishes now persists concurrently on the one shared connection.
      if (sql === 'BEGIN IMMEDIATE' && !scheduled) {
        scheduled = true;
        competing = saveAnalysis(db, analysis(uuid(2), null), PERMIT).then(
          () => 'saved',
          (error: unknown) => `threw: ${String(error)}`,
        );
      }
    });
    const { transport } = acceptingTransport();
    await drainOutbox(db, transport).catch(() => undefined);
    expect(scheduled).toBe(true);
    await expect(competing).resolves.toBe('saved');

    const saved = handle.executeSync(
      `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND id = ?`,
      [owner, uuid(2)],
    ).rows[0];
    expect(Number(saved?.['n'])).toBe(1);
    expect(await getShotOutboxStatus(db, uuid(2))).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
  });

  it('B2: a shot the server accepted must get its receipt even when a save transaction is open', async () => {
    const handle = openRealSqlite();
    const bootstrap = launch(handle);
    setActiveDataOwner(owner);
    await saveAnalysis(bootstrap, analysis(uuid(1), null), PERMIT);

    const { transport } = acceptingTransport();
    let drain: Promise<unknown> | null = null;
    let scheduled = false;
    const db = asLocalDb(handle, sql => {
      // A timer/foreground drain lands while saveAnalysis holds its
      // transaction (the mirror ordering of B1).
      if (sql === 'BEGIN IMMEDIATE' && !scheduled) {
        scheduled = true;
        drain = drainOutbox(db, transport).then(
          result => result,
          (error: unknown) => `threw: ${String(error)}`,
        );
      }
    });
    await saveAnalysis(db, analysis(uuid(2), null), PERMIT).catch(
      () => undefined,
    );
    expect(scheduled).toBe(true);
    const result = await drain!;

    expect(result).toEqual({ synced: 1, failed: 0, remaining: 1 });
    expect(await hasShotSyncReceipt(db, uuid(1))).toBe(true);
    expect(await getShotOutboxStatus(db, uuid(1))).toEqual({ state: 'absent' });
  });

  it('B3: a scored rating must persist when the drain transaction is already open (the save loses the race)', async () => {
    const handle = openRealSqlite();
    const bootstrap = launch(handle);
    setActiveDataOwner(owner);
    await saveAnalysis(bootstrap, analysis(uuid(1), null), PERMIT);

    let competing: Promise<unknown> | null = null;
    let scheduled = false;
    const db = asLocalDb(handle, sql => {
      // The drain's receipt transaction is already OPEN (BEGIN committed to
      // the connection) when the scoring run tries to persist its rating.
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt') && !scheduled) {
        scheduled = true;
        competing = saveAnalysis(db, analysis(uuid(2), null), PERMIT).then(
          () => 'saved',
          (error: unknown) => `threw: ${String(error)}`,
        );
      }
    });
    const { transport } = acceptingTransport();
    await drainOutbox(db, transport).catch(() => undefined);
    expect(scheduled).toBe(true);
    await expect(competing).resolves.toBe('saved');
    const saved = handle.executeSync(
      `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND id = ?`,
      [owner, uuid(2)],
    ).rows[0];
    expect(Number(saved?.['n'])).toBe(1);
  });

  it('C1: 50 transiently-rejected rows must not starve a newer valid session and shot forever', async () => {
    const handle = openRealSqlite();
    const db = launch(handle);
    setActiveDataOwner(owner);
    const broken = sessionUuid(1);
    const { transport, calls } = serverLikeTransport(broken);

    await saveSession(db, {
      id: broken,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    for (let i = 0; i < 50; i += 1) {
      await saveAnalysis(db, analysis(uuid(100 + i), broken), PERMIT);
    }
    // Burn the broken session.create row's whole budget.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(db, transport);
    }

    const healthy = sessionUuid(2);
    await saveSession(db, {
      id: healthy,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T19:00:00.000Z',
    });
    await saveAnalysis(db, analysis(uuid(900), healthy), PERMIT);
    const createdBefore = calls.createSession;
    for (let i = 0; i < 20; i += 1) {
      await drainOutbox(db, transport);
    }

    expect(calls.createSession).toBeGreaterThan(createdBefore);
    expect(await hasShotSyncReceipt(db, uuid(900))).toBe(true);
  });

  it('C2: a shot whose session.create is permanently exhausted must reach a terminal state, not stay "queued" forever', async () => {
    const handle = openRealSqlite();
    const db = launch(handle);
    setActiveDataOwner(owner);
    const broken = sessionUuid(3);
    const { transport } = serverLikeTransport(broken);

    await saveSession(db, {
      id: broken,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    await saveAnalysis(db, analysis(uuid(200), broken), PERMIT);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 12; i += 1) {
      await drainOutbox(db, transport);
    }

    const status = await getShotOutboxStatus(db, uuid(200));
    expect(status.state).not.toBe('queued');
  });

  it('D1: a whole-request 404 outage must not strand every queued rating permanently', async () => {
    const handle = openRealSqlite();
    const db = launch(handle);
    setActiveDataOwner(owner);
    await saveAnalysis(db, analysis(uuid(1), null), PERMIT);
    await saveAnalysis(db, analysis(uuid(2), null), PERMIT);

    let broken = true;
    const healthy = acceptingTransport();
    const transport: SyncTransport = {
      async syncShots(shots) {
        if (broken) {
          throw new ApiError(404, 'unknown', 'Not Found');
        }
        return healthy.transport.syncShots(shots);
      },
      async createSession(session) {
        if (broken) throw new ApiError(404, 'unknown', 'Not Found');
        return healthy.transport.createSession(session);
      },
      async finalizeSession(id) {
        if (broken) throw new ApiError(404, 'unknown', 'Not Found');
        return healthy.transport.finalizeSession(id);
      },
    };

    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i += 1) {
      await drainOutbox(db, transport);
    }
    broken = false;
    for (let i = 0; i < 3; i += 1) {
      await drainOutbox(db, transport);
    }

    expect(await hasShotSyncReceipt(db, uuid(1))).toBe(true);
    expect(await hasShotSyncReceipt(db, uuid(2))).toBe(true);
  });
});
