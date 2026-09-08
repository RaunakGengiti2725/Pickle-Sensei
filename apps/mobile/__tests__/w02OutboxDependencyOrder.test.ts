/**
 * W02-01 — real SQLite (node:sqlite) proof that the production outbox never
 * sends a dependent row (shot.sync / session.finalize) before its parent
 * session.create is durably acknowledged: the server has the session AND the
 * parent row is no longer queued locally (its delete committed).
 *
 * Crash injection: a reference drain records every durable step (each SQL
 * statement, BEGIN/COMMIT included, and each transport round trip). The
 * scenario is then replayed once per step with the process dying right after
 * that step — the SQLite file keeps only what was committed, the fake server
 * keeps what it already processed — and the queue is drained from a fresh
 * connection until empty. The ordering invariant is checked on every send in
 * every process, and every queued row must eventually reach the server.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { ApiError } from '../src/data/api';
import { drainOutbox, type SyncTransport } from '../src/data/sync';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  createSqliteTestDb,
  closeSqliteTestDatabases,
} from '../testSupport/sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWNER = '33333333-3333-4333-8333-333333333333';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SESSION_A = uuid(1);
const SESSION_B = uuid(2);
const MAX_RESTARTS = 8;
/** Crash points per test case, so every case stays far inside Jest's default
 * timeout on a slow runner while every step of every scenario is covered. */
const CRASH_WINDOW = 150;

const temporaryDirectories: string[] = [];

beforeEach(() => setActiveDataOwner(OWNER));
afterEach(() => {
  closeSqliteTestDatabases();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

function sessionPayload(id: string) {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-09-08T10:00:00.000Z',
  };
}

function analysis(
  n: number,
  sessionId: string | null,
): ShotAnalysis & { analysisPermitId: string } {
  return {
    id: uuid(n),
    analysisPermitId: uuid(n + 10000),
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-08T10:00:01.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    source: 'real',
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
  };
}

type Queued = { kind: string; payload: unknown };
const shot = (n: number, sessionId: string | null): Queued => ({
  kind: 'shot.sync',
  payload: analysis(n, sessionId),
});
const create = (id: string): Queued => ({
  kind: 'session.create',
  payload: sessionPayload(id),
});
const finalize = (id: string): Queued => ({
  kind: 'session.finalize',
  payload: { id },
});

/** Queue shapes the shipping app produces (repository.ts saveAnalysis →
 * practiceSet.ts commitPracticeSet → finishSession), plus the fifty-row
 * batch boundary and two interleaved practice sets. `crashWindows` is the
 * number of CRASH_WINDOW-sized test cases needed to cover every step; the
 * reference drain asserts the count is exact, so a production change that
 * adds or removes statements cannot leave a step uncovered silently. */
const scenarios: Array<{ name: string; rows: Queued[]; crashWindows: number }> =
  [
    {
      name: 'a practice set queued shot-first in one batch',
      rows: [shot(100, SESSION_A), create(SESSION_A), finalize(SESSION_A)],
      crashWindows: 1,
    },
    {
      name: 'a parent and finalizer beyond a full fifty-shot batch',
      rows: [
        ...Array.from({ length: 50 }, (_, i) => shot(100 + i, SESSION_A)),
        create(SESSION_A),
        finalize(SESSION_A),
      ],
      crashWindows: 3,
    },
    {
      name: 'two interleaved practice sets with an independent shot',
      crashWindows: 1,
      rows: [
        shot(100, SESSION_A),
        create(SESSION_A),
        shot(200, SESSION_B),
        create(SESSION_B),
        shot(300, null),
        shot(101, SESSION_A),
        finalize(SESSION_A),
        shot(201, SESSION_B),
        finalize(SESSION_B),
      ],
    },
  ];

class ProcessCrash extends Error {
  constructor(step: number) {
    super(`process crashed after step ${step}`);
  }
}

/** Remote state survives client crashes. */
interface Server {
  sessions: Set<string>;
  shots: Set<string>;
  finalized: Set<string>;
}

interface Process {
  store: ReturnType<typeof createSqliteTestDb>;
  transport: SyncTransport;
  steps: number;
  dead: boolean;
  labels: string[];
}

function shotIdentity(value: unknown): { id: string; sessionId: unknown } {
  if (!value || typeof value !== 'object' || !('id' in value))
    throw new Error('Production sync emitted an invalid shot payload');
  const id = value.id;
  if (typeof id !== 'string')
    throw new Error('Production sync emitted an invalid shot identifier');
  return { id, sessionId: 'sessionId' in value ? value.sessionId : null };
}

function boot(
  path: string,
  server: Server,
  crashAt: number | null,
  violations: string[],
  seed?: Queued[],
): Process {
  const store = createSqliteTestDb(path);
  // Process death, not power loss, is modelled: skip fsync on every commit.
  store.native.exec('PRAGMA synchronous = OFF');
  store.native.exec('PRAGMA journal_mode = MEMORY');
  if (seed) {
    for (const row of seed)
      store.native
        .prepare(
          'INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)',
        )
        .run(OWNER, row.kind, JSON.stringify(row.payload));
  }
  const process: Process = {
    store,
    steps: 0,
    dead: false,
    labels: [],
    transport: {
      syncShots: async shots => {
        throw new Error(`unbound transport ${String(shots.length)}`);
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    },
  };
  const step = (label: string) => {
    if (process.dead) throw new ProcessCrash(process.steps);
    process.steps += 1;
    process.labels.push(label);
    if (crashAt !== null && process.steps === crashAt) {
      process.dead = true;
      // A dead process writes nothing further: every later statement fails.
      store.native.close();
      throw new ProcessCrash(process.steps);
    }
  };
  store.observeStatements(call => step(call.sql.replace(/\s+/g, ' ').trim()));
  const queuedParents = (sessionId: string): number =>
    Number(
      store.native
        .prepare(
          `SELECT count(*) AS n FROM outbox
           WHERE owner_key = ? AND kind = 'session.create'
             AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ?`,
        )
        .get(OWNER, sessionId)?.n,
    );
  const requireAcknowledgedParent = (what: string, sessionId: string) => {
    const where = `${what} (after step ${process.steps})`;
    if (!server.sessions.has(sessionId))
      violations.push(`${where}: server never received session ${sessionId}`);
    const queued = queuedParents(sessionId);
    if (queued > 0)
      violations.push(
        `${where}: ${queued} session.create row(s) for ${sessionId} still queued`,
      );
  };
  process.transport = {
    async createSession(payload) {
      if (process.dead) throw new ProcessCrash(process.steps);
      const id = (payload as { id?: unknown }).id;
      if (typeof id !== 'string')
        throw new ApiError(400, 'validation.session', 'Invalid session');
      server.sessions.add(id);
      step(`createSession ${id}`);
    },
    async finalizeSession(id) {
      if (process.dead) throw new ProcessCrash(process.steps);
      requireAcknowledgedParent(`finalizeSession ${id}`, id);
      if (!server.sessions.has(id))
        throw new ApiError(404, 'session.not_found', 'Session not found');
      server.finalized.add(id);
      step(`finalizeSession ${id}`);
    },
    async syncShots(shots) {
      if (process.dead) throw new ProcessCrash(process.steps);
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const value of shots) {
        const { id, sessionId } = shotIdentity(value);
        if (typeof sessionId === 'string') {
          requireAcknowledgedParent(`syncShots ${id}`, sessionId);
          if (!server.sessions.has(sessionId)) {
            rejected.push({
              id,
              code: 'shot.session_not_found',
              message: 'Session not found or not yours.',
            });
            continue;
          }
        }
        server.shots.add(id);
        acceptedIds.push(id);
      }
      step(`syncShots ${acceptedIds.length}/${shots.length}`);
      return { acceptedIds, rejected };
    },
  };
  return process;
}

function shutdown(process: Process): void {
  try {
    process.store.close();
  } catch {
    // The crashed process already lost its connection.
  }
}

function outboxCount(path: string): number {
  const { DatabaseSync } = jest.requireActual<{
    DatabaseSync: new (file: string) => {
      prepare(sql: string): { get(...params: unknown[]): { n?: unknown } };
      close(): void;
    };
  }>('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    return Number(
      db
        .prepare('SELECT count(*) AS n FROM outbox WHERE owner_key = ?')
        .get(OWNER)?.n,
    );
  } finally {
    db.close();
  }
}

interface RunResult {
  steps: number;
  labels: string[];
  violations: string[];
  remaining: number;
  drains: number;
  /** Queued work the server never received once the queue was empty. */
  undelivered: string[];
}

function undeliveredWork(rows: Queued[], server: Server): string[] {
  const missing: string[] = [];
  for (const row of rows) {
    const id = (row.payload as { id: string }).id;
    if (row.kind === 'shot.sync' && !server.shots.has(id))
      missing.push(`shot ${id}`);
    if (row.kind === 'session.create' && !server.sessions.has(id))
      missing.push(`session ${id}`);
    if (row.kind === 'session.finalize' && !server.finalized.has(id))
      missing.push(`finalize ${id}`);
  }
  return missing;
}

async function run(rows: Queued[], crashAt: number | null): Promise<RunResult> {
  const directory = mkdtempSync(join(tmpdir(), 'pickle-w02-outbox-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'product.sqlite');
  const server: Server = {
    sessions: new Set(),
    shots: new Set(),
    finalized: new Set(),
  };
  const violations: string[] = [];
  const first = boot(path, server, crashAt, violations, rows);
  let steps = 0;
  let labels: string[] = [];
  try {
    await drainOutbox(first.store.db, first.transport);
  } catch (error) {
    if (!first.dead) throw error;
  }
  steps = first.steps;
  labels = first.labels;
  shutdown(first);
  let drains = 1;
  let remaining = outboxCount(path);
  while (remaining > 0 && drains < MAX_RESTARTS) {
    const next = boot(path, server, null, violations);
    await drainOutbox(next.store.db, next.transport);
    shutdown(next);
    drains += 1;
    remaining = outboxCount(path);
  }
  return {
    steps,
    labels,
    violations,
    remaining,
    drains,
    undelivered: undeliveredWork(rows, server),
  };
}

describe.each(scenarios)(
  'dependency-ordered outbox: $name',
  ({ rows, crashWindows }) => {
    it('delivers everything in order without a crash', async () => {
      const reference = await run(rows, null);
      expect(reference.violations).toEqual([]);
      expect(reference.remaining).toBe(0);
      expect(reference.undelivered).toEqual([]);
      // Every step must fall inside exactly `crashWindows` crash test cases.
      expect(reference.steps).toBeGreaterThan(
        (crashWindows - 1) * CRASH_WINDOW,
      );
      expect(reference.steps).toBeLessThanOrEqual(crashWindows * CRASH_WINDOW);
    });

    it.each(Array.from({ length: crashWindows }, (_, i) => i + 1))(
      'never sends a dependent before its parent is durably acknowledged, crashing after every step (window %i)',
      async window => {
        const reference = await run(rows, null);
        const first = (window - 1) * CRASH_WINDOW + 1;
        const last = Math.min(window * CRASH_WINDOW, reference.steps);
        expect(first).toBeLessThanOrEqual(last);
        const failures: string[] = [];
        for (let crashAt = first; crashAt <= last; crashAt++) {
          const result = await run(rows, crashAt);
          const at = `crash after step ${crashAt} [${reference.labels[crashAt - 1]}]`;
          for (const violation of result.violations)
            failures.push(`${at}: ${violation}`);
          if (result.remaining !== 0)
            failures.push(
              `${at}: ${result.remaining} row(s) still queued after ${result.drains} drains`,
            );
          for (const missing of result.undelivered)
            failures.push(`${at}: ${missing} never reached the server`);
        }
        expect(failures).toEqual([]);
      },
    );
  },
);
