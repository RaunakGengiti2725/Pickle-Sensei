/// <reference types="node" />
/**
 * Outbox liveness: rows that can never reach the server must not hold the
 * drain's selection window forever, and a shot whose parent `session.create`
 * has spent its whole attempt budget must reach a terminal, explainable
 * state instead of reporting `queued` indefinitely.
 *
 * Scenario (mirrors AnalyzeScreen + commitPracticeSet): a practice set's
 * shots are saved, then its `session.create` row. The server permanently
 * refuses that session (a 4xx contract verdict), so the set's shots are
 * orphaned. Runs the production SQL against Node's real `node:sqlite`.
 *
 * Run: cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *      __tests__/outboxDrainLiveness.test.ts
 */
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { ApiError } from '../src/data/api';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
} from '../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
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

const mockState: { handle: Handle | null } = { handle: null };

function mockOpenHandle(): Handle {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: typeof DatabaseSyncType;
  };
  const raw = new DatabaseSync(':memory:');
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
    if (!mockState.handle) throw new Error('harness: no handle');
    return mockState.handle;
  },
}));

function launch(): LocalDb {
  mockState.handle = mockOpenHandle();
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
const ORPHAN_COUNT = 60; // more than one selection window
const DEAD_SESSION = 'dddddddd-0000-4000-8000-000000000001';
const NEW_SESSION = 'eeeeeeee-0000-4000-8000-000000000001';
const TRIAL_ID = 'ffffffff-0000-4000-8000-000000000001';

function shotId(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function analysis(id: string, sessionId: string): ShotAnalysis {
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

/** A server that permanently refuses `deadSession`, accepts every other
 * session, and only accepts shots whose session it has seen
 * (mirrors `apply_synced_shot`'s shot.session_not_found). */
function serverEmulator(deadSession: string): SyncTransport & {
  knownSessions: Set<string>;
  calls: { createSession: string[]; shotsOffered: string[][] };
  acceptedTrials: string[];
} {
  const knownSessions = new Set<string>();
  const calls = {
    createSession: [] as string[],
    shotsOffered: [] as string[][],
  };
  const acceptedTrials: string[] = [];
  return {
    knownSessions,
    calls,
    acceptedTrials,
    async createSession(session) {
      const id = String((session as Record<string, unknown>)['id']);
      calls.createSession.push(id);
      if (id === deadSession) {
        throw new ApiError(400, 'validation.session', 'Invalid session.');
      }
      knownSessions.add(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      calls.shotsOffered.push(
        shots.map(shot => String((shot as Record<string, unknown>)['id'])),
      );
      for (const raw of shots) {
        const shot = raw as { id: string; sessionId: string | null };
        if (shot.sessionId && !knownSessions.has(shot.sessionId)) {
          rejected.push({
            id: shot.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found or not yours.',
          });
        } else {
          acceptedIds.push(shot.id);
        }
      }
      return { acceptedIds, rejected };
    },
    async uploadEvaluationTrials(trials) {
      const ids = trials.map(trial =>
        String((trial as Record<string, unknown>)['trialId']),
      );
      acceptedTrials.push(...ids);
      return { acceptedTrialIds: ids, rejected: [] };
    },
  };
}

/** Mirrors AnalyzeScreen: the first scored shot is saved, then
 * commitPracticeSet() queues the session.create row behind it, then the
 * rest of the set's shots follow. */
async function practiceSet(
  db: LocalDb,
  sessionId: string,
  shots: number[],
): Promise<void> {
  for (const [index, n] of shots.entries()) {
    await saveAnalysis(db, analysis(shotId(n), sessionId), PERMIT);
    if (index === 0) {
      await saveSession(db, {
        id: sessionId,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-08-26T18:00:00.000Z',
      });
    }
  }
}

async function outboxSummary(
  db: LocalDb,
): Promise<Array<{ kind: string; attempts: number }>> {
  const { rows } = await db.execute(
    `SELECT kind, attempts FROM outbox WHERE owner_key = ? ORDER BY id ASC`,
    [OWNER],
  );
  return rows.map(row => ({
    kind: String(row['kind']),
    attempts: Number(row['attempts']),
  }));
}

describe('outbox drain liveness with permanently orphaned shots (real SQLite)', () => {
  let db: LocalDb;
  let server: ReturnType<typeof serverEmulator>;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = launch();
    server = serverEmulator(DEAD_SESSION);
    await practiceSet(
      db,
      DEAD_SESSION,
      Array.from({ length: ORPHAN_COUNT }, (_, i) => 0x100 + i),
    );
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    mockState.handle?.close();
    mockState.handle = null;
  });

  it('a shot waiting on a session.create that is still inside its budget stays queued', async () => {
    await drainOutbox(db, server);
    expect(server.calls.createSession).toEqual([DEAD_SESSION]);
    expect(await getShotOutboxStatus(db, shotId(0x100))).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
  });

  it('a newer practice set and an evaluation trial still sync within a bounded number of drains', async () => {
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(db, server);
    }
    const summary = await outboxSummary(db);
    expect(summary.filter(r => r.kind === 'session.create')).toEqual([
      { kind: 'session.create', attempts: OUTBOX_MAX_ATTEMPTS },
    ]);
    expect(summary.filter(r => r.kind === 'shot.sync')).toHaveLength(
      ORPHAN_COUNT,
    );

    await practiceSet(db, NEW_SESSION, [0x900, 0x901]);
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload)
       VALUES (?, 'evaluation.trial', ?)`,
      [OWNER, JSON.stringify({ trialId: TRIAL_ID })],
    );
    const createsBefore = server.calls.createSession.length;

    // Bounded: everything newer is reachable within two passes (the first
    // creates the session, the shots and trial follow at the latest on the
    // next) no matter how many orphans are queued ahead of it.
    for (let i = 0; i < 2; i += 1) {
      await drainOutbox(db, server);
    }

    expect(server.calls.createSession.slice(createsBefore)).toContain(
      NEW_SESSION,
    );
    expect(server.knownSessions.has(NEW_SESSION)).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(0x900))).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(0x901))).toBe(true);
    expect(server.acceptedTrials).toEqual([TRIAL_ID]);

    // The orphans never masquerade as sendable work: they are not offered to
    // the server once their session is known to be refused.
    const orphanIds = new Set(
      Array.from({ length: ORPHAN_COUNT }, (_, i) => shotId(0x100 + i)),
    );
    const offeredAfter = server.calls.shotsOffered
      .flat()
      .filter(id => orphanIds.has(id));
    expect(offeredAfter).toEqual([]);
  });

  it('a shot whose session.create is exhausted reaches a terminal state instead of staying queued', async () => {
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 4; i += 1) {
      await drainOutbox(db, server);
    }
    const status = await getShotOutboxStatus(db, shotId(0x100));
    expect(status.state).toBe('exhausted');
    if (status.state === 'exhausted') {
      expect(status.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
      expect(status.lastError).toContain('Invalid session.');
    }
    // The terminal verdict is durable across drains and applies to the whole set.
    await drainOutbox(db, server);
    expect(
      (await getShotOutboxStatus(db, shotId(0x100 + ORPHAN_COUNT - 1))).state,
    ).toBe('exhausted');
  });
});
