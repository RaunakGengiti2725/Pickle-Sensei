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
 * scenario is then replayed once per step under three fault models:
 *   - crash: the process dies right after that step — the SQLite file keeps
 *     only what was committed, the fake server keeps what it already
 *     processed — and the queue is drained from fresh connections until empty;
 *   - lost acknowledgement: at a transport step the server applies the
 *     request but the client observes the exact timeout the shipping
 *     transport raises when no response arrives (ApiError 408
 *     network.timeout), so the outcome is ambiguous to the client;
 *   - refused: at a transport step the server applies nothing and answers
 *     with a transient 503, so the parent is definitely NOT on the server.
 * The ordering invariant is checked on every send in every process; these
 * faults must never consume a row's attempt budget, a sync receipt must
 * never exist for a shot the server has not accepted, and every queued row
 * must eventually reach the server. One scenario has no parent row at all
 * (only the local session survives): the server's rejection must lead to
 * the parent being reconstructed and acknowledged before the shot is
 * accepted, never to a fabricated receipt.
 *
 * The kinds of durable step the matrix crashes after are enumerated in
 * DURABLE_STEP_KINDS and asserted exactly, so a change to the drain's
 * statements cannot silently leave a step uncovered.
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
const SESSION_C = uuid(3);
const STARTED_AT = '2026-09-08T10:00:00.000Z';
const MAX_RESTARTS = 8;
/** Crash points per test case, so every case stays far inside Jest's default
 * timeout on a slow runner while every step of every scenario is covered. */
const CRASH_WINDOW = 50;

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
    startedAt: STARTED_AT,
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

interface Scenario {
  name: string;
  rows: Queued[];
  /** local_session rows present on the device (repository.ts saveSession)
   * when the queue holds no session.create row for them. */
  localSessions?: string[];
  crashWindows: number;
}

const orphanShot: Scenario = {
  name: 'a shot whose parent row is missing while its local session survives',
  rows: [shot(100, SESSION_C)],
  localSessions: [SESSION_C],
  crashWindows: 1,
};

/** Queue shapes the shipping app produces (repository.ts saveAnalysis →
 * practiceSet.ts commitPracticeSet → finishSession), plus the fifty-row
 * batch boundary, interleaved practice sets and a shot whose parent row is
 * missing. `crashWindows` is the number of CRASH_WINDOW-sized test cases
 * needed to cover every step; the reference drain asserts the count is
 * exact, so a production change that adds or removes statements cannot
 * leave a step uncovered silently. */
const scenarios: Scenario[] = [
  {
    name: 'a practice set queued shot-first in one batch',
    rows: [shot(100, SESSION_A), create(SESSION_A), finalize(SESSION_A)],
    crashWindows: 1,
  },
  orphanShot,
  {
    name: 'a parent and finalizer beyond a full fifty-shot batch',
    rows: [
      ...Array.from({ length: 50 }, (_, i) => shot(100 + i, SESSION_A)),
      create(SESSION_A),
      finalize(SESSION_A),
    ],
    crashWindows: 9,
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
    crashWindows: 9,
  },
  {
    name: 'two interleaved practice sets with an independent shot',
    crashWindows: 2,
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

/** Sessions the queue carries a session.create row for at the start. A
 * dependent of any other session can only be sent unparented (the server
 * rejects it); once a reconstructed parent row is committed the session
 * joins this set and its dependents must wait like every other row. */
function queuedParents(rows: Queued[]): Set<string> {
  return new Set(
    rows
      .filter(row => row.kind === 'session.create')
      .map(row => (row.payload as { id: string }).id),
  );
}

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

/** The failure the shipping transport raises for a server that could not
 * take the request at all (nothing applied): transient, never budgeted. */
const refusedRequest = () =>
  new ApiError(503, 'server.unavailable', 'Service unavailable');

/** Remote state survives client crashes. */
interface Server {
  sessions: Set<string>;
  shots: Set<string>;
  finalized: Set<string>;
}

type Fault =
  | { kind: 'crash'; step: number }
  | { kind: 'lost-ack'; step: number }
  | { kind: 'refused'; step: number }
  | null;

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
  queuedParentIds(): string[];
  outboxCount(): number;
  consumedAttempts(): string[];
  receipts(): string[];
  repairs(): string[];
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
    queuedParentIds: () =>
      db
        .prepare(
          `SELECT json_extract(payload, '$.id') AS id FROM outbox
           WHERE owner_key = ? AND kind = 'session.create' AND json_valid(payload)`,
        )
        .all(OWNER)
        .map(row => String(row['id'])),
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
    repairs: () =>
      db
        .prepare(
          `SELECT kind, repair_reason FROM outbox
           WHERE owner_key = ? AND repair_reason IS NOT NULL ORDER BY id`,
        )
        .all(OWNER)
        .map(row => `${String(row['kind'])}: ${String(row['repair_reason'])}`),
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
  parents: Set<string>,
  seed?: Scenario,
): Process {
  const store = createSqliteTestDb(path);
  // Process death, not power loss, is modelled: skip fsync on every commit.
  store.native.exec('PRAGMA synchronous = OFF');
  if (seed) {
    for (const row of seed.rows) {
      store.native
        .prepare(
          'INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)',
        )
        .run(OWNER, row.kind, JSON.stringify(row.payload));
      // repository.ts saveAnalysis commits the local shot with its outbox row;
      // db.ts prunes a local session that has no shot on the next open.
      if (row.kind === 'shot.sync') {
        const saved = row.payload as ShotAnalysis;
        store.native
          .prepare(
            `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at,
               overall_score, confidence, result_kind, source, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            OWNER,
            saved.id,
            saved.sessionId,
            saved.shotType,
            saved.capturedAtIso,
            saved.overallScore,
            saved.analysisConfidence,
            saved.resultKind,
            saved.source,
            JSON.stringify(saved),
          );
      }
    }
    for (const id of seed.localSessions ?? [])
      store.native
        .prepare(
          `INSERT INTO local_session (owner_key, id, mode, shot_type, started_at)
           VALUES (?, ?, 'practice_set', 'forehand_drive', ?)`,
        )
        .run(OWNER, id, STARTED_AT);
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
  /** A transport round trip. Acknowledged: the server applies the request
   * and the client sees the response. Lost acknowledgement: applied, but the
   * client sees only the shipping timeout. Refused: nothing applied, 503. */
  const roundTrip = (label: string, apply: () => void) => {
    const outcome =
      fault && fault.kind !== 'crash' && clock.steps + 1 === fault.step
        ? fault.kind
        : 'acknowledged';
    if (outcome !== 'refused') apply();
    step(label);
    if (outcome === 'lost-ack') throw lostAcknowledgement();
    if (outcome === 'refused') throw refusedRequest();
  };
  store.observeStatements(call => step(call.sql.replace(/\s+/g, ' ').trim()));
  /** One request is one moment on the wire: the committed state every
   * dependent in it is judged against is read once, as the request leaves. */
  const withCommittedState = (
    what: string,
    check: (
      requireAcknowledgedParent: (what: string, sessionId: string) => void,
    ) => void,
  ) => {
    let committed: CommittedState;
    try {
      committed = committedState(path);
    } catch (error) {
      violations.push(
        `${what} (after step ${clock.steps}): committed state unreadable while sending (${String(error)})`,
      );
      return;
    }
    try {
      check((sending, sessionId) => {
        const where = `${sending} (after step ${clock.steps})`;
        if (parents.has(sessionId) && !server.sessions.has(sessionId))
          violations.push(
            `${where}: server never received session ${sessionId}`,
          );
        const queued = committed.queuedParents(sessionId);
        if (queued > 0)
          violations.push(
            `${where}: ${queued} committed session.create row(s) for ${sessionId} still queued`,
          );
      });
    } finally {
      committed.close();
    }
  };
  process.transport = {
    async createSession(payload) {
      if (process.dead) throw new ProcessCrash(clock.steps);
      const id = (payload as { id?: unknown }).id;
      if (typeof id !== 'string')
        throw new ApiError(400, 'validation.session', 'Invalid session');
      roundTrip(`createSession ${id}`, () => server.sessions.add(id));
    },
    async finalizeSession(id) {
      if (process.dead) throw new ProcessCrash(clock.steps);
      withCommittedState(`finalizeSession ${id}`, requireAcknowledgedParent =>
        requireAcknowledgedParent(`finalizeSession ${id}`, id),
      );
      if (!server.sessions.has(id))
        throw new ApiError(404, 'session.not_found', 'Session not found');
      roundTrip(`finalizeSession ${id}`, () => server.finalized.add(id));
    },
    async syncShots(shots) {
      if (process.dead) throw new ProcessCrash(clock.steps);
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      withCommittedState('syncShots', requireAcknowledgedParent => {
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
          acceptedIds.push(id);
        }
      });
      roundTrip(`syncShots ${acceptedIds.length}/${shots.length}`, () => {
        for (const id of acceptedIds) server.shots.add(id);
      });
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
  path: string;
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
  parents: Set<string>,
  when: string,
): number {
  const committed = committedState(path);
  try {
    for (const id of committed.queuedParentIds()) parents.add(id);
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

async function run(scenario: Scenario, fault: Fault): Promise<RunResult> {
  const { rows } = scenario;
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
  const parents = queuedParents(rows);
  let drains = 0;
  let remaining: number;
  let seed: Scenario | undefined = scenario;
  do {
    const process = boot(path, server, clock, fault, violations, parents, seed);
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
      parents,
      `after process ${drains}`,
    );
  } while (remaining > 0 && drains < MAX_RESTARTS);
  return {
    path,
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

/** A step label without its per-run identifiers: the kind of durable step. */
const stepKind = (label: string) =>
  isTransportStep(label) ? label.replace(/ .*$/, '') : label;

/** Every kind of durable step the shipping drain performs across the
 * scenarios, i.e. every point the crash matrix kills the process right
 * after. Asserted exactly: a statement added to or removed from sync.ts
 * must be reflected here deliberately. */
const DURABLE_STEP_KINDS = [
  'BEGIN IMMEDIATE',
  'COMMIT',
  'DELETE FROM outbox WHERE owner_key = ? AND id = ?',
  "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', ?)",
  "INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)",
  'SELECT COALESCE(MAX(last_attempt_order), 0) + 1 AS ordinal FROM outbox WHERE owner_key = ?',
  'SELECT count(*) AS n FROM outbox WHERE owner_key = ?',
  'SELECT id, kind, payload, attempts, repair_reason FROM outbox WHERE owner_key = ? AND attempts < ? AND repair_reason IS NULL ORDER BY last_attempt_order ASC, id ASC LIMIT 50',
  "SELECT id, kind, payload, attempts, repair_reason FROM outbox WHERE owner_key = ? AND kind = 'session.create' AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ? ORDER BY id ASC LIMIT 1",
  'SELECT id, started_at FROM local_session WHERE owner_key = ? AND id = ? LIMIT 1',
  "SELECT payload FROM outbox WHERE owner_key = ? AND kind = ? AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ? LIMIT 51",
  'UPDATE outbox SET last_attempt_order = ? WHERE owner_key = ? AND id = ?',
  'UPDATE outbox SET last_error = ? WHERE owner_key = ? AND id = ?',
  'createSession',
  'finalizeSession',
  'syncShots',
];

function expectedRoundTrips(rows: Queued[]): RegExp[] {
  const kinds = new Set(rows.map(row => row.kind));
  const expected = [/^createSession /];
  if (kinds.has('shot.sync')) expected.push(/^syncShots /);
  if (kinds.has('session.finalize')) expected.push(/^finalizeSession /);
  return expected;
}

it('holds a shot whose session exists nowhere on the device for repair, without a receipt or endless retries', async () => {
  const result = await run({ ...orphanShot, localSessions: [] }, null);
  expect(result.violations).toEqual([]);
  expect(result.remaining).toBe(1);
  expect(result.undelivered).toEqual([`shot ${uuid(100)}`]);
  // Sent once, rejected, then parked: no later process sends it again.
  expect(result.labels.filter(isTransportStep)).toEqual(['syncShots 0/1']);
  const committed = committedState(result.path);
  try {
    expect(committed.repairs()).toEqual(['shot.sync: session.missing']);
    expect(committed.receipts()).toEqual([]);
    expect(committed.consumedAttempts()).toEqual([]);
  } finally {
    committed.close();
  }
});

it('crashes after every kind of durable step the drain performs (enumerated)', async () => {
  const kinds = new Set<string>();
  for (const scenario of scenarios) {
    const reference = await run(scenario, null);
    expect(reference.violations).toEqual([]);
    for (const label of reference.labels) kinds.add(stepKind(label));
  }
  expect([...kinds].sort()).toEqual([...DURABLE_STEP_KINDS].sort());
  expect(DURABLE_STEP_KINDS.length).toBeGreaterThanOrEqual(8);
});

describe.each(scenarios)('dependency-ordered outbox: $name', scenario => {
  const { rows, crashWindows } = scenario;

  it('delivers everything in order without a fault', async () => {
    const reference = await run(scenario, null);
    expect(reference.violations).toEqual([]);
    expect(reference.remaining).toBe(0);
    expect(reference.undelivered).toEqual([]);
    // Every step must fall inside exactly `crashWindows` crash test cases.
    expect(reference.steps).toBeGreaterThan((crashWindows - 1) * CRASH_WINDOW);
    expect(reference.steps).toBeLessThanOrEqual(crashWindows * CRASH_WINDOW);
    // Every kind of round trip the scenario needs is a transport fault point.
    expect(reference.labels.filter(isTransportStep)).toEqual(
      expect.arrayContaining(
        expectedRoundTrips(rows).map(pattern => expect.stringMatching(pattern)),
      ),
    );
  });

  it.each(Array.from({ length: crashWindows }, (_, i) => i + 1))(
    'never sends a dependent before its parent is durably acknowledged, crashing after every step (window %i)',
    async window => {
      const reference = await run(scenario, null);
      const first = (window - 1) * CRASH_WINDOW + 1;
      const last = Math.min(window * CRASH_WINDOW, reference.steps);
      expect(first).toBeLessThanOrEqual(last);
      const failures: string[] = [];
      for (let step = first; step <= last; step++) {
        const result = await run(scenario, { kind: 'crash', step });
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

  it.each(['lost-ack', 'refused'] as const)(
    'never sends a dependent before its parent is durably acknowledged when any round trip is %s',
    async kind => {
      const reference = await run(scenario, null);
      const transportSteps = reference.labels
        .map((label, index) => (isTransportStep(label) ? index + 1 : 0))
        .filter(step => step > 0);
      expect(transportSteps.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const step of transportSteps) {
        const result = await run(scenario, { kind, step });
        failures.push(
          ...collectFailures(
            `${kind} at step ${step} [${reference.labels[step - 1]}]`,
            result,
          ),
        );
      }
      expect(failures).toEqual([]);
    },
  );
});
