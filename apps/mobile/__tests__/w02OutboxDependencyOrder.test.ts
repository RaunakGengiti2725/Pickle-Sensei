/**
 * W02-01 — real SQLite (node:sqlite) proof that the production outbox never
 * sends a dependent row (shot.sync / session.finalize) before its parent
 * session.create is durably acknowledged: the server has the session AND the
 * parent row is no longer queued locally in COMMITTED state (read through an
 * independent connection to the same database file, so an uncommitted delete
 * on the drain's own connection cannot pass as durable).
 *
 * Fault injection: a reference drain records every durable step (each SQL
 * statement, BEGIN/COMMIT included, and each transport round trip). The
 * scenario is then replayed once per step under two fault models:
 *   - crash: the process dies right after that step — the SQLite file keeps
 *     only what was committed, the fake server keeps what it already
 *     processed — and the queue is drained from fresh connections until empty;
 *   - lost acknowledgement: at a transport step the server applies the
 *     request but the client observes the exact timeout the shipping
 *     transport raises when no response arrives (ApiError 408
 *     network.timeout), so the outcome is ambiguous to the client.
 * The ordering invariant is checked on every send in every process; crashes
 * and lost acknowledgements must never consume a row's attempt budget, a
 * sync receipt must never exist for a shot the server has not accepted, and
 * every queued row must eventually reach the server.
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
const CRASH_WINDOW = 100;

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
 * batch boundary and interleaved practice sets. `crashWindows` is the
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
      crashWindows: 5,
    },
    {
      name: 'two parents beyond a full batch shared by two practice sets',
      rows: [
        ...Array.from({ length: 25 }, (_, i) => shot(100 + i, SESSION_A)),
        ...Array.from({ length: 25 }, (_, i) => shot(200 + i, SESSION_B)),
        create(SESSION_A),
        create(SESSION_B),
        finalize(SESSION_B),
        finalize(SESSION_A),
      ],
      crashWindows: 5,
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

/** The exact failure the shipping transport raises when the server processed
 * a request but its response never reached the device (api.ts request). */
const lostAcknowledgement = () =>
  new ApiError(
    408,
    'network.timeout',
    'The server took too long to respond. Your work is saved on this device — try again when the connection recovers.',
  );

/** Remote state survives client crashes. */
interface Server {
  sessions: Set<string>;
  shots: Set<string>;
  finalized: Set<string>;
}

type Fault =
  { kind: 'crash'; step: number } | { kind: 'lost-ack'; step: number } | null;

/** Durable steps are numbered across every process of one run, so a fault
 * can land in a restart drain (e.g. the finalizer that only drains after the
 * fifty-row batch ahead of it) exactly as in the first process. */
interface Clock {
  steps: number;
  labels: string[];
}

interface Process {
  store: ReturnType<typeof createSqliteTestDb>;
  transport: SyncTransport;
  dead: boolean;
}

interface CommittedState {
  queuedParents(sessionId: string): number;
  outboxCount(): number;
  consumedAttempts(): string[];
  receipts(): string[];
  close(): void;
}

/** An independent connection to the same file: it sees only COMMITTED state,
 * never the drain connection's open transaction. */
function committedState(path: string): CommittedState {
  const { DatabaseSync } = jest.requireActual<{
    DatabaseSync: new (file: string) => {
      prepare(sql: string): {
        get(...params: unknown[]): Record<string, unknown> | undefined;
        all(...params: unknown[]): Record<string, unknown>[];
      };
      close(): void;
    };
  }>('node:sqlite');
  const db = new DatabaseSync(path);
  return {
    queuedParents: sessionId =>
      Number(
        db
          .prepare(
            `SELECT count(*) AS n FROM outbox
             WHERE owner_key = ? AND kind = 'session.create'
               AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ?`,
          )
          .get(OWNER, sessionId)?.['n'],
      ),
    outboxCount: () =>
      Number(
        db
          .prepare('SELECT count(*) AS n FROM outbox WHERE owner_key = ?')
          .get(OWNER)?.['n'],
      ),
    consumedAttempts: () =>
      db
        .prepare(
          `SELECT kind, attempts, last_error FROM outbox
           WHERE owner_key = ? AND attempts > 0 ORDER BY id`,
        )
        .all(OWNER)
        .map(
          row =>
            `${String(row['kind'])} attempts=${String(row['attempts'])} (${String(row['last_error'])})`,
        ),
    receipts: () =>
      db
        .prepare(
          `SELECT entity_id FROM sync_receipt
           WHERE owner_key = ? AND kind = 'shot.sync' ORDER BY entity_id`,
        )
        .all(OWNER)
        .map(row => String(row['entity_id'])),
    close: () => db.close(),
  };
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
  clock: Clock,
  fault: Fault,
  violations: string[],
  seed?: Queued[],
): Process {
  const store = createSqliteTestDb(path);
  // Process death, not power loss, is modelled: skip fsync on every commit.
  store.native.exec('PRAGMA synchronous = OFF');
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
    dead: false,
    transport: {
      syncShots: async shots => {
        throw new Error(`unbound transport ${String(shots.length)}`);
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    },
  };
  const step = (label: string) => {
    if (process.dead) throw new ProcessCrash(clock.steps);
    clock.steps += 1;
    clock.labels.push(label);
    if (fault?.kind === 'crash' && clock.steps === fault.step) {
      process.dead = true;
      // A dead process writes nothing further: every later statement fails.
      store.native.close();
      throw new ProcessCrash(clock.steps);
    }
  };
  /** A transport step: the server has applied the request; the client either
   * receives the response or (lost-ack fault) only the shipping timeout. */
  const transportStep = (label: string) => {
    const lost = fault?.kind === 'lost-ack' && clock.steps + 1 === fault.step;
    step(label);
    if (lost) throw lostAcknowledgement();
  };
  store.observeStatements(call => step(call.sql.replace(/\s+/g, ' ').trim()));
  const requireAcknowledgedParent = (what: string, sessionId: string) => {
    const where = `${what} (after step ${clock.steps})`;
    if (!server.sessions.has(sessionId))
      violations.push(`${where}: server never received session ${sessionId}`);
    let queued: number;
    try {
      const committed = committedState(path);
      try {
        queued = committed.queuedParents(sessionId);
      } finally {
        committed.close();
      }
    } catch (error) {
      violations.push(
        `${where}: committed state unreadable while sending (${String(error)})`,
      );
      return;
    }
    if (queued > 0)
      violations.push(
        `${where}: ${queued} committed session.create row(s) for ${sessionId} still queued`,
      );
  };
  process.transport = {
    async createSession(payload) {
      if (process.dead) throw new ProcessCrash(clock.steps);
      const id = (payload as { id?: unknown }).id;
      if (typeof id !== 'string')
        throw new ApiError(400, 'validation.session', 'Invalid session');
      server.sessions.add(id);
      transportStep(`createSession ${id}`);
    },
    async finalizeSession(id) {
      if (process.dead) throw new ProcessCrash(clock.steps);
      requireAcknowledgedParent(`finalizeSession ${id}`, id);
      if (!server.sessions.has(id))
        throw new ApiError(404, 'session.not_found', 'Session not found');
      server.finalized.add(id);
      transportStep(`finalizeSession ${id}`);
    },
    async syncShots(shots) {
      if (process.dead) throw new ProcessCrash(clock.steps);
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
      transportStep(`syncShots ${acceptedIds.length}/${shots.length}`);
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

/** Between processes only committed state exists. Faults are transient by
 * definition, so no row may have spent an attempt, and a receipt may exist
 * only for a shot the server actually accepted. */
function auditCommittedState(
  path: string,
  server: Server,
  violations: string[],
  when: string,
): number {
  const committed = committedState(path);
  try {
    for (const consumed of committed.consumedAttempts())
      violations.push(`${when}: attempt budget consumed by ${consumed}`);
    for (const shotId of committed.receipts())
      if (!server.shots.has(shotId))
        violations.push(
          `${when}: receipt for shot ${shotId} the server never accepted`,
        );
    return committed.outboxCount();
  } finally {
    committed.close();
  }
}

async function run(rows: Queued[], fault: Fault): Promise<RunResult> {
  const directory = mkdtempSync(join(tmpdir(), 'pickle-w02-outbox-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'product.sqlite');
  const server: Server = {
    sessions: new Set(),
    shots: new Set(),
    finalized: new Set(),
  };
  const violations: string[] = [];
  const clock: Clock = { steps: 0, labels: [] };
  let drains = 0;
  let remaining: number;
  let seed: Queued[] | undefined = rows;
  do {
    const process = boot(path, server, clock, fault, violations, seed);
    seed = undefined;
    try {
      await drainOutbox(process.store.db, process.transport);
    } catch (error) {
      if (!process.dead) throw error;
    }
    shutdown(process);
    drains += 1;
    remaining = auditCommittedState(
      path,
      server,
      violations,
      `after process ${drains}`,
    );
  } while (remaining > 0 && drains < MAX_RESTARTS);
  return {
    steps: clock.steps,
    labels: clock.labels,
    violations,
    remaining,
    drains,
    undelivered: undeliveredWork(rows, server),
  };
}

function collectFailures(at: string, result: RunResult): string[] {
  const failures: string[] = [];
  for (const violation of result.violations)
    failures.push(`${at}: ${violation}`);
  if (result.remaining !== 0)
    failures.push(
      `${at}: ${result.remaining} row(s) still queued after ${result.drains} drains`,
    );
  for (const missing of result.undelivered)
    failures.push(`${at}: ${missing} never reached the server`);
  return failures;
}

const isTransportStep = (label: string) =>
  /^(createSession|finalizeSession|syncShots) /.test(label);

describe.each(scenarios)(
  'dependency-ordered outbox: $name',
  ({ rows, crashWindows }) => {
    it('delivers everything in order without a fault', async () => {
      const reference = await run(rows, null);
      expect(reference.violations).toEqual([]);
      expect(reference.remaining).toBe(0);
      expect(reference.undelivered).toEqual([]);
      // Every step must fall inside exactly `crashWindows` crash test cases.
      expect(reference.steps).toBeGreaterThan(
        (crashWindows - 1) * CRASH_WINDOW,
      );
      expect(reference.steps).toBeLessThanOrEqual(crashWindows * CRASH_WINDOW);
      // Every kind of round trip the scenario needs is a lost-ack point.
      expect(reference.labels.filter(isTransportStep)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^createSession /),
          expect.stringMatching(/^finalizeSession /),
          expect.stringMatching(/^syncShots /),
        ]),
      );
    });

    it.each(Array.from({ length: crashWindows }, (_, i) => i + 1))(
      'never sends a dependent before its parent is durably acknowledged, crashing after every step (window %i)',
      async window => {
        const reference = await run(rows, null);
        const first = (window - 1) * CRASH_WINDOW + 1;
        const last = Math.min(window * CRASH_WINDOW, reference.steps);
        expect(first).toBeLessThanOrEqual(last);
        const failures: string[] = [];
        for (let step = first; step <= last; step++) {
          const result = await run(rows, { kind: 'crash', step });
          failures.push(
            ...collectFailures(
              `crash after step ${step} [${reference.labels[step - 1]}]`,
              result,
            ),
          );
        }
        expect(failures).toEqual([]);
      },
    );

    it('never sends a dependent before its parent is durably acknowledged when any acknowledgement is lost', async () => {
      const reference = await run(rows, null);
      const transportSteps = reference.labels
        .map((label, index) => (isTransportStep(label) ? index + 1 : 0))
        .filter(step => step > 0);
      expect(transportSteps.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const step of transportSteps) {
        const result = await run(rows, { kind: 'lost-ack', step });
        failures.push(
          ...collectFailures(
            `lost acknowledgement at step ${step} [${reference.labels[step - 1]}]`,
            result,
          ),
        );
      }
      expect(failures).toEqual([]);
    });
  },
);
