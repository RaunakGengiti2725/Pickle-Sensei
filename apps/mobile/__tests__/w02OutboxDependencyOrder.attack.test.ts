/**
 * W02-01 adversarial suite — attacks the dependency-ordered outbox proof at
 * boundaries the candidate's crash-at-every-step matrix does not exercise:
 * two drains in flight at once, an account switch while the parent is on the
 * wire, a parent that belongs to another account, every HTTP failure class on
 * the parent request, a parked parent hidden behind a full batch, the local
 * acknowledgement write (DELETE / COMMIT / receipt) failing after the server
 * accepted, server-side lag between parent and dependent, corrupt parent
 * payloads, duplicate parent identities, a corrupt drain schedule and
 * out-of-range session clocks during parent reconstruction.
 *
 * Every send passes the same guard the candidate proves: a dependent may
 * leave the device only when the server holds its parent AND no committed
 * session.create row for that session remains queued (read through an
 * independent node:sqlite connection to the same file).
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { ApiError } from '../src/data/api';
import { drainOutbox, type SyncTransport } from '../src/data/sync';
import { retryShotSync } from '../src/data/repository';
import {
  captureDataOwnerContext,
  DataOwnerChangedError,
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

const OWNER = '44444444-4444-4444-8444-444444444444';
const OTHER_OWNER = '55555555-5555-4555-8555-555555555555';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SESSION_A = uuid(1);
const SESSION_B = uuid(2);
const STARTED_AT = '2026-09-08T10:00:00.000Z';

const temporaryDirectories: string[] = [];

beforeEach(() => setActiveDataOwner(OWNER));
afterEach(() => {
  closeSqliteTestDatabases();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'w02-attack-'));
  temporaryDirectories.push(directory);
  return join(directory, 'outbox.sqlite');
}

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

interface SeedRow {
  kind: string;
  /** Serialized as JSON unless `raw` is given. */
  payload?: unknown;
  raw?: string;
  attempts?: number;
  repairReason?: string;
  lastAttemptOrder?: number;
  owner?: string;
}

const shot = (n: number, sessionId: string | null): SeedRow => ({
  kind: 'shot.sync',
  payload: analysis(n, sessionId),
});
const create = (id: string): SeedRow => ({
  kind: 'session.create',
  payload: sessionPayload(id),
});
const finalize = (id: string): SeedRow => ({
  kind: 'session.finalize',
  payload: { id },
});

type Store = ReturnType<typeof createSqliteTestDb>;

function seed(store: Store, rows: SeedRow[], localSessions: string[] = []) {
  for (const row of rows) {
    const owner = row.owner ?? OWNER;
    store.native
      .prepare(
        `INSERT INTO outbox (owner_key, kind, payload, attempts, repair_reason, last_attempt_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        owner,
        row.kind,
        row.raw ?? JSON.stringify(row.payload),
        row.attempts ?? 0,
        row.repairReason ?? null,
        row.lastAttemptOrder ?? 0,
      );
    if (row.kind === 'shot.sync' && row.payload) {
      const saved = row.payload as ShotAnalysis;
      store.native
        .prepare(
          `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at,
             overall_score, confidence, result_kind, source, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          owner,
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
  for (const id of localSessions) seedLocalSession(store, id, STARTED_AT);
}

function seedLocalSession(store: Store, id: string, startedAt: string) {
  store.native
    .prepare(
      `INSERT INTO local_session (owner_key, id, mode, shot_type, started_at)
       VALUES (?, ?, 'practice_set', 'forehand_drive', ?)`,
    )
    .run(OWNER, id, startedAt);
}

interface CommittedRow {
  id: number;
  kind: string;
  entity: string | null;
  attempts: number;
  lastError: string | null;
  repairReason: string | null;
  order: number;
}

interface Committed {
  rows(owner?: string): CommittedRow[];
  queuedParents(owner: string, sessionId: string): number;
  receipts(owner?: string): string[];
  close(): void;
}

/** An independent connection: sees COMMITTED state only. */
function committed(path: string): Committed {
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
    rows: (owner = OWNER) =>
      db
        .prepare(
          `SELECT id, kind, attempts, last_error, repair_reason, last_attempt_order,
             CASE WHEN json_valid(payload) THEN
               CASE WHEN kind = 'shot.sync' THEN json_extract(payload, '$.sessionId')
                    ELSE json_extract(payload, '$.id') END
             END AS entity
           FROM outbox WHERE owner_key = ? ORDER BY id`,
        )
        .all(owner)
        .map(row => ({
          id: Number(row['id']),
          kind: String(row['kind']),
          entity: row['entity'] == null ? null : String(row['entity']),
          attempts: Number(row['attempts']),
          lastError:
            row['last_error'] == null ? null : String(row['last_error']),
          repairReason:
            row['repair_reason'] == null ? null : String(row['repair_reason']),
          order: Number(row['last_attempt_order']),
        })),
    queuedParents: (owner, sessionId) =>
      Number(
        db
          .prepare(
            `SELECT count(*) AS n FROM outbox
             WHERE owner_key = ? AND kind = 'session.create'
               AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ?`,
          )
          .get(owner, sessionId)?.['n'],
      ),
    receipts: (owner = OWNER) =>
      db
        .prepare(
          `SELECT entity_id FROM sync_receipt
           WHERE owner_key = ? AND kind = 'shot.sync' ORDER BY entity_id`,
        )
        .all(owner)
        .map(row => String(row['entity_id'])),
    close: () => db.close(),
  };
}

function snapshot(path: string): { rows: CommittedRow[]; receipts: string[] } {
  const state = committed(path);
  try {
    return { rows: state.rows(), receipts: state.receipts() };
  } finally {
    state.close();
  }
}

interface SentShot {
  id: string;
  sessionId: string | null;
}

function sentShot(value: unknown): SentShot {
  if (!value || typeof value !== 'object' || !('id' in value))
    throw new Error('Production sync emitted an invalid shot payload');
  const id = value.id;
  if (typeof id !== 'string')
    throw new Error('Production sync emitted an invalid shot identifier');
  const sessionId = 'sessionId' in value ? value.sessionId : null;
  return { id, sessionId: typeof sessionId === 'string' ? sessionId : null };
}

interface Acknowledgement {
  acceptedIds: string[];
  rejected: { id: string; code: string; message: string }[];
}

class Server {
  readonly sessions = new Set<string>();
  readonly shots = new Set<string>();
  readonly finalized = new Set<string>();
  /** Every request in wire order, e.g. "createSession A", "syncShots 1,2". */
  readonly calls: string[] = [];

  acknowledgeShots(shots: SentShot[]): Acknowledgement {
    const ack: Acknowledgement = { acceptedIds: [], rejected: [] };
    for (const item of shots) {
      if (item.sessionId && !this.sessions.has(item.sessionId)) {
        ack.rejected.push({
          id: item.id,
          code: 'shot.session_not_found',
          message: 'session not found',
        });
        continue;
      }
      this.shots.add(item.id);
      ack.acceptedIds.push(item.id);
    }
    return ack;
  }
}

interface Hooks {
  /** `apply` records the session on the server; throw before it to refuse,
   * after it to lose the acknowledgement. */
  createSession?: (id: string, apply: () => void) => Promise<void> | void;
  finalizeSession?: (id: string, apply: () => void) => Promise<void> | void;
  syncShots?: (
    shots: SentShot[],
    apply: () => Acknowledgement,
  ) => Promise<Acknowledgement> | Acknowledgement;
}

interface Harness {
  server: Server;
  transport: SyncTransport;
  violations: string[];
}

/** A transport that checks the ordering invariant on every dependent send:
 * the server must hold the parent (when a parent row was ever queued for this
 * owner) and no committed session.create row for it may remain queued. */
function harness(
  path: string,
  parents: Set<string>,
  hooks: Hooks = {},
  owner = OWNER,
): Harness {
  const server = new Server();
  const violations: string[] = [];
  const requireAcknowledgedParent = (sending: string, sessionId: string) => {
    if (parents.has(sessionId) && !server.sessions.has(sessionId))
      violations.push(`${sending}: server never received ${sessionId}`);
    const state = committed(path);
    try {
      const queued = state.queuedParents(owner, sessionId);
      if (queued > 0)
        violations.push(
          `${sending}: ${queued} committed session.create row(s) for ${sessionId} still queued`,
        );
    } finally {
      state.close();
    }
  };
  const transport: SyncTransport = {
    async createSession(payload) {
      const id = (payload as { id?: unknown }).id;
      if (typeof id !== 'string')
        throw new ApiError(400, 'validation.session', 'Invalid session');
      server.calls.push(`createSession ${id}`);
      const apply = () => server.sessions.add(id);
      if (hooks.createSession) await hooks.createSession(id, apply);
      else apply();
    },
    async finalizeSession(id) {
      server.calls.push(`finalizeSession ${id}`);
      requireAcknowledgedParent(`finalizeSession ${id}`, id);
      const apply = () => {
        if (!server.sessions.has(id))
          throw new ApiError(404, 'session.not_found', 'Session not found');
        server.finalized.add(id);
      };
      if (hooks.finalizeSession) await hooks.finalizeSession(id, apply);
      else apply();
    },
    async syncShots(shots) {
      const sent = shots.map(sentShot);
      server.calls.push(`syncShots ${sent.map(s => s.id).join(',')}`);
      for (const item of sent)
        if (item.sessionId)
          requireAcknowledgedParent(`shot ${item.id}`, item.sessionId);
      const apply = () => server.acknowledgeShots(sent);
      if (hooks.syncShots) return hooks.syncShots(sent, apply);
      return apply();
    },
  };
  return { server, transport, violations };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const settled = () => new Promise<void>(r => setImmediate(r));

const ids = (n: number[]) => n.map(uuid);
const parents = (...sessionIds: string[]) => new Set(sessionIds);

describe('W02-01 attack: dependency-ordered outbox at its failure boundaries', () => {
  it('A1 concurrency: two drains in flight on one queue never send a dependent ahead of its parent and settle to exactly-once state', async () => {
    const path = databasePath();
    const store = createSqliteTestDb(path);
    seed(store, [shot(1, SESSION_A), create(SESSION_A), finalize(SESSION_A)]);
    const gate = deferred();
    let inFlight = 0;
    const h = harness(path, parents(SESSION_A), {
      async createSession(_id, apply) {
        inFlight += 1;
        await gate.promise;
        apply();
      },
    });
    const first = drainOutbox(store.db, h.transport);
    const second = drainOutbox(store.db, h.transport);
    for (let i = 0; i < 50 && inFlight < 2; i++) await settled();
    // Both drains hold the same parent row and are waiting on the same wire.
    expect(inFlight).toBe(2);
    gate.resolve();
    const results = await Promise.all([first, second]);

    expect(h.violations).toEqual([]);
    expect(h.server.sessions).toEqual(new Set([SESSION_A]));
    expect(h.server.finalized).toEqual(new Set([SESSION_A]));
    expect(h.server.shots).toEqual(new Set(ids([1])));
    const parentCalls = h.server.calls.filter(c =>
      c.startsWith('createSession'),
    );
    const firstShotCall = h.server.calls.findIndex(c =>
      c.startsWith('syncShots'),
    );
    expect(parentCalls.length).toBe(2);
    expect(firstShotCall).toBeGreaterThan(
      h.server.calls.lastIndexOf(parentCalls[1]!),
    );
    const state = snapshot(path);
    expect(state.rows).toEqual([]);
    expect(state.receipts).toEqual(ids([1]));
    expect(results.every(r => r.remaining === 0)).toBe(true);
  });

  it('A2 account switch while the parent is on the wire: the drain refuses to acknowledge under the new owner and the queue survives untouched', async () => {
    const path = databasePath();
    const store = createSqliteTestDb(path);
    seed(store, [shot(1, SESSION_A), create(SESSION_A), finalize(SESSION_A)]);
    const before = snapshot(path);
    const h = harness(path, parents(SESSION_A), {
      createSession(_id, apply) {
        apply();
        setActiveDataOwner(OTHER_OWNER);
      },
    });
    await expect(drainOutbox(store.db, h.transport)).rejects.toBeInstanceOf(
      DataOwnerChangedError,
    );
    expect(h.violations).toEqual([]);
    expect(h.server.calls).toEqual([`createSession ${SESSION_A}`]);
    const after = snapshot(path);
    // The parent row is still queued (not deleted under the wrong owner), no
    // attempt was consumed, no receipt exists, nothing was written for OTHER.
    expect(after.rows.map(r => [r.kind, r.attempts, r.repairReason])).toEqual(
      before.rows.map(r => [r.kind, r.attempts, r.repairReason]),
    );
    expect(after.receipts).toEqual([]);
    const other = committed(path);
    try {
      expect(other.rows(OTHER_OWNER)).toEqual([]);
      expect(other.receipts(OTHER_OWNER)).toEqual([]);
    } finally {
      other.close();
    }

    // The original owner returns: the parent is re-sent (idempotent) and only
    // then do the dependents leave.
    setActiveDataOwner(OWNER);
    const resumed = harness(path, parents(SESSION_A));
    resumed.server.sessions.add(SESSION_A);
    const result = await drainOutbox(store.db, resumed.transport);
    expect(resumed.violations).toEqual([]);
    expect(resumed.server.calls).toEqual([
      `createSession ${SESSION_A}`,
      `finalizeSession ${SESSION_A}`,
      `syncShots ${uuid(1)}`,
    ]);
    expect(result).toEqual({ synced: 3, failed: 0, remaining: 0 });
    expect(snapshot(path)).toEqual({ rows: [], receipts: ids([1]) });
  });

  it('A3 cross-account parent: another account\u2019s session.create row is never sent, deleted or budgeted on behalf of the active owner', async () => {
    const path = databasePath();
    const store = createSqliteTestDb(path);
    seed(store, [
      shot(1, SESSION_A),
      { ...create(SESSION_A), owner: OTHER_OWNER },
      { ...finalize(SESSION_A), owner: OTHER_OWNER },
    ]);
    const h = harness(path, new Set());
    const result = await drainOutbox(store.db, h.transport);
    expect(h.violations).toEqual([]);
    // The active owner has no parent of its own: the shot is sent, refused by
    // the server, and parked — the other account's rows were never touched.
    expect(h.server.calls).toEqual([`syncShots ${uuid(1)}`]);
    expect(h.server.sessions.size).toBe(0);
    expect(h.server.shots.size).toBe(0);
    expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
    const state = committed(path);
    try {
      expect(state.receipts(OWNER)).toEqual([]);
      expect(
        state.rows(OWNER).map(r => [r.kind, r.attempts, r.repairReason]),
      ).toEqual([['shot.sync', 0, 'session.missing']]);
      expect(
        state
          .rows(OTHER_OWNER)
          .map(r => [r.kind, r.attempts, r.lastError, r.repairReason, r.order]),
      ).toEqual([
        ['session.create', 0, null, null, 0],
        ['session.finalize', 0, null, null, 0],
      ]);
    } finally {
      state.close();
    }

    // The other account drains its own parent untouched by the first drain.
    setActiveDataOwner(OTHER_OWNER);
    const other = harness(path, parents(SESSION_A), {}, OTHER_OWNER);
    const otherResult = await drainOutbox(store.db, other.transport);
    expect(other.violations).toEqual([]);
    expect(other.server.calls).toEqual([
      `createSession ${SESSION_A}`,
      `finalizeSession ${SESSION_A}`,
    ]);
    expect(otherResult).toEqual({ synced: 2, failed: 0, remaining: 0 });
  });

  describe('A4 network failure on the parent request, one class at a time', () => {
    const permanent = [400, 403, 404, 409, 422] as const;
    const transient = [401, 408, 429, 500, 502, 503, 302] as const;
    const failure = (status: number) =>
      new ApiError(
        status,
        `http.${String(status)}`,
        `status ${String(status)}`,
      );

    it.each(permanent)(
      'parent refused with %i: dependents are parked for repair, never sent, and the sibling set still drains',
      async status => {
        const path = databasePath();
        const store = createSqliteTestDb(path);
        seed(store, [
          shot(1, SESSION_A),
          create(SESSION_A),
          finalize(SESSION_A),
          shot(2, SESSION_B),
          create(SESSION_B),
        ]);
        const h = harness(path, parents(SESSION_A, SESSION_B), {
          createSession(id, apply) {
            if (id === SESSION_A) throw failure(status);
            apply();
          },
        });
        const result = await drainOutbox(store.db, h.transport);
        expect(h.violations).toEqual([]);
        expect(h.server.calls).toEqual([
          `createSession ${SESSION_A}`,
          `createSession ${SESSION_B}`,
          `syncShots ${uuid(2)}`,
        ]);
        expect(result).toEqual({ synced: 2, failed: 2, remaining: 3 });
        const state = snapshot(path);
        expect(state.receipts).toEqual(ids([2]));
        expect(
          state.rows.map(r => [r.kind, r.entity, r.attempts, r.repairReason]),
        ).toEqual([
          ['shot.sync', SESSION_A, 0, 'session.parent_rejected'],
          ['session.create', SESSION_A, 1, 'session.rejected'],
          ['session.finalize', SESSION_A, 0, 'session.parent_rejected'],
        ]);
      },
    );

    it.each(transient)(
      'parent failed with %i: dependents wait with their budget intact and drain in order once the parent is acknowledged',
      async status => {
        const path = databasePath();
        const store = createSqliteTestDb(path);
        seed(store, [
          shot(1, SESSION_A),
          create(SESSION_A),
          finalize(SESSION_A),
          shot(2, SESSION_B),
          create(SESSION_B),
        ]);
        let failNext = true;
        const h = harness(path, parents(SESSION_A, SESSION_B), {
          createSession(id, apply) {
            if (id === SESSION_A && failNext) {
              failNext = false;
              throw failure(status);
            }
            apply();
          },
        });
        const first = await drainOutbox(store.db, h.transport);
        expect(h.violations).toEqual([]);
        expect(h.server.calls).toEqual([
          `createSession ${SESSION_A}`,
          `createSession ${SESSION_B}`,
          `syncShots ${uuid(2)}`,
        ]);
        expect(first).toEqual({ synced: 2, failed: 2, remaining: 3 });
        const held = snapshot(path);
        expect(held.receipts).toEqual(ids([2]));
        expect(
          held.rows.map(r => [r.kind, r.entity, r.attempts, r.repairReason]),
        ).toEqual([
          ['shot.sync', SESSION_A, 0, null],
          ['session.create', SESSION_A, 0, null],
          ['session.finalize', SESSION_A, 0, null],
        ]);
        expect(held.rows[0]!.lastError).toBe('session.pending');

        const second = await drainOutbox(store.db, h.transport);
        expect(h.violations).toEqual([]);
        expect(h.server.calls.slice(3)).toEqual([
          `createSession ${SESSION_A}`,
          `finalizeSession ${SESSION_A}`,
          `syncShots ${uuid(1)}`,
        ]);
        expect(second).toEqual({ synced: 3, failed: 0, remaining: 0 });
        expect(snapshot(path)).toEqual({ rows: [], receipts: ids([1, 2]) });
      },
    );

    it('parent request fails with a non-HTTP error (connection reset): treated as transient, dependents held', async () => {
      const path = databasePath();
      const store = createSqliteTestDb(path);
      seed(store, [shot(1, SESSION_A), create(SESSION_A)]);
      const h = harness(path, parents(SESSION_A), {
        createSession() {
          throw new TypeError('Network request failed');
        },
      });
      const result = await drainOutbox(store.db, h.transport);
      expect(h.violations).toEqual([]);
      expect(h.server.calls).toEqual([`createSession ${SESSION_A}`]);
      expect(result).toEqual({ synced: 0, failed: 2, remaining: 2 });
      expect(
        snapshot(path).rows.map(r => [r.kind, r.attempts, r.repairReason]),
      ).toEqual([
        ['shot.sync', 0, null],
        ['session.create', 0, null],
      ]);
    });
  });

  describe('A5 parked parent hidden behind a full fifty-row batch', () => {
    it.each([
      ['repair_reason set', { repairReason: 'session.rejected' }],
      ['attempt budget exhausted', { attempts: 8 }],
    ])(
      'parent %s beyond the batch: none of its fifty shots nor its finalizer reach the wire',
      async (_label, parked) => {
        const path = databasePath();
        const store = createSqliteTestDb(path);
        const shots = Array.from({ length: 50 }, (_, i) =>
          shot(100 + i, SESSION_A),
        );
        seed(store, [
          ...shots,
          { ...create(SESSION_A), ...parked },
          finalize(SESSION_A),
        ]);
        const h = harness(path, parents(SESSION_A));
        const first = await drainOutbox(store.db, h.transport);
        expect(h.violations).toEqual([]);
        expect(h.server.calls).toEqual([]);
        expect(first).toEqual({ synced: 0, failed: 50, remaining: 52 });
        let state = snapshot(path);
        expect(state.receipts).toEqual([]);
        expect(
          state.rows
            .filter(r => r.kind === 'shot.sync')
            .map(r => r.repairReason),
        ).toEqual(Array.from({ length: 50 }, () => 'session.parent_rejected'));
        expect(
          state.rows.every(r => r.kind !== 'shot.sync' || r.attempts === 0),
        ).toBe(true);

        // The finalizer is now first in line; the parked parent still blocks it.
        const second = await drainOutbox(store.db, h.transport);
        expect(h.violations).toEqual([]);
        expect(h.server.calls).toEqual([]);
        expect(second.remaining).toBe(52);
        state = snapshot(path);
        expect(
          state.rows.find(r => r.kind === 'session.finalize')?.repairReason,
        ).toBe('session.parent_rejected');
        expect(state.receipts).toEqual([]);
      },
    );
  });

  describe('A6 the parent is acknowledged by the server but its local acknowledgement write fails', () => {
    it.each([
      ['DELETE statement fails', 'DELETE FROM outbox'],
      ['COMMIT of the DELETE fails', 'COMMIT'],
    ])(
      '%s: dependents stay held, the parent stays queued with its budget intact, the next drain completes in order',
      async (_label, statement) => {
        const path = databasePath();
        const store = createSqliteTestDb(path);
        seed(store, [
          shot(1, SESSION_A),
          create(SESSION_A),
          finalize(SESSION_A),
        ]);
        let armed = true;
        const h = harness(path, parents(SESSION_A), {
          createSession(_id, apply) {
            apply();
            if (armed) {
              armed = false;
              store.failStatementOnce(statement);
            }
          },
        });
        const first = await drainOutbox(store.db, h.transport);
        expect(h.violations).toEqual([]);
        expect(h.server.calls).toEqual([`createSession ${SESSION_A}`]);
        expect(first).toEqual({ synced: 0, failed: 2, remaining: 3 });
        const held = snapshot(path);
        expect(held.receipts).toEqual([]);
        expect(
          held.rows.map(r => [r.kind, r.attempts, r.repairReason]),
        ).toEqual([
          ['shot.sync', 0, null],
          ['session.create', 0, null],
          ['session.finalize', 0, null],
        ]);

        const second = await drainOutbox(store.db, h.transport);
        expect(h.violations).toEqual([]);
        expect(h.server.calls.slice(1)).toEqual([
          `createSession ${SESSION_A}`,
          `finalizeSession ${SESSION_A}`,
          `syncShots ${uuid(1)}`,
        ]);
        expect(second).toEqual({ synced: 3, failed: 0, remaining: 0 });
        expect(snapshot(path)).toEqual({ rows: [], receipts: ids([1]) });
      },
    );
  });

  it('A7 the shot is accepted but the receipt transaction fails: no receipt without a delete, no delete without a receipt, budget intact, replay converges', async () => {
    const path = databasePath();
    const store = createSqliteTestDb(path);
    seed(store, [shot(1, SESSION_A), shot(2, SESSION_A), create(SESSION_A)]);
    let armed = true;
    const h = harness(path, parents(SESSION_A), {
      syncShots(_shots, apply) {
        const ack = apply();
        if (armed) {
          armed = false;
          store.failStatementOnce('INSERT OR REPLACE INTO sync_receipt');
        }
        return ack;
      },
    });
    const first = await drainOutbox(store.db, h.transport);
    expect(h.violations).toEqual([]);
    expect(h.server.shots).toEqual(new Set(ids([1, 2])));
    expect(first).toEqual({ synced: 1, failed: 2, remaining: 2 });
    const held = snapshot(path);
    expect(held.receipts).toEqual([]);
    expect(held.rows.map(r => [r.kind, r.attempts])).toEqual([
      ['shot.sync', 0],
      ['shot.sync', 0],
    ]);

    const second = await drainOutbox(store.db, h.transport);
    expect(h.violations).toEqual([]);
    expect(second).toEqual({ synced: 2, failed: 0, remaining: 0 });
    expect(snapshot(path)).toEqual({ rows: [], receipts: ids([1, 2]) });
  });

  it('A8 server lag: the parent was acknowledged this drain but the shot is still refused — the parent is reconstructed, no receipt is fabricated, no budget spent', async () => {
    const path = databasePath();
    const store = createSqliteTestDb(path);
    seed(store, [shot(1, SESSION_A), create(SESSION_A)], [SESSION_A]);
    let lagging = true;
    const h = harness(path, parents(SESSION_A), {
      syncShots(shots, apply) {
        if (lagging) {
          lagging = false;
          return {
            acceptedIds: [],
            rejected: shots.map(s => ({
              id: s.id,
              code: 'shot.session_not_found',
              message: 'replica lag',
            })),
          };
        }
        return apply();
      },
    });
    const first = await drainOutbox(store.db, h.transport);
    expect(h.violations).toEqual([]);
    expect(first).toEqual({ synced: 1, failed: 1, remaining: 2 });
    const held = snapshot(path);
    expect(held.receipts).toEqual([]);
    expect(
      held.rows.map(r => [r.kind, r.entity, r.attempts, r.repairReason]),
    ).toEqual([
      ['shot.sync', SESSION_A, 0, null],
      ['session.create', SESSION_A, 0, null],
    ]);

    const second = await drainOutbox(store.db, h.transport);
    expect(h.violations).toEqual([]);
    expect(h.server.calls.slice(2)).toEqual([
      `createSession ${SESSION_A}`,
      `syncShots ${uuid(1)}`,
    ]);
    expect(second).toEqual({ synced: 2, failed: 0, remaining: 0 });
    expect(snapshot(path)).toEqual({ rows: [], receipts: ids([1]) });
  });

  describe('A9 corrupt parent payload', () => {
    it.each([
      ['invalid JSON', '{"id": "' + SESSION_A],
      ['JSON array', JSON.stringify([SESSION_A])],
      ['numeric id', JSON.stringify({ id: 1, startedAt: STARTED_AT })],
      ['missing id', JSON.stringify({ startedAt: STARTED_AT })],
    ])(
      'parent row with %s: never sent, budgeted permanently, the shot is not acknowledged and the parent is rebuilt from the local session',
      async (_label, raw) => {
        const path = databasePath();
        const store = createSqliteTestDb(path);
        seed(
          store,
          [shot(1, SESSION_A), { kind: 'session.create', raw }],
          [SESSION_A],
        );
        const h = harness(path, new Set());
        const first = await drainOutbox(store.db, h.transport);
        expect(h.violations).toEqual([]);
        expect(h.server.sessions.size).toBe(0);
        expect(h.server.shots.size).toBe(0);
        const held = snapshot(path);
        expect(held.receipts).toEqual([]);
        const parentRows = held.rows.filter(r => r.kind === 'session.create');
        expect(parentRows.length).toBe(2);
        expect(parentRows[0]!.attempts).toBe(1);
        expect(parentRows[1]!).toMatchObject({
          entity: SESSION_A,
          attempts: 0,
          repairReason: null,
        });
        expect(held.rows.find(r => r.kind === 'shot.sync')).toMatchObject({
          attempts: 0,
          repairReason: null,
        });
        expect(first).toEqual({ synced: 0, failed: 2, remaining: 3 });

        const sentBefore = h.server.calls.length;
        const second = await drainOutbox(store.db, h.transport);
        expect(h.violations).toEqual([]);
        expect(h.server.calls.slice(sentBefore)).toEqual([
          `createSession ${SESSION_A}`,
          `syncShots ${uuid(1)}`,
        ]);
        expect(second.remaining).toBe(1);
        const final = snapshot(path);
        expect(final.receipts).toEqual(ids([1]));
        expect(final.rows.map(r => [r.kind, r.attempts])).toEqual([
          ['session.create', 2],
        ]);
      },
    );
  });

  describe('A10 corrupt drain schedule', () => {
    it('a single row with last_attempt_order at Number.MAX_SAFE_INTEGER makes the whole owner queue undrainable (fails closed: nothing sent, nothing changed)', async () => {
      const path = databasePath();
      const store = createSqliteTestDb(path);
      seed(store, [
        shot(1, SESSION_A),
        create(SESSION_A),
        { ...shot(2, null), lastAttemptOrder: Number.MAX_SAFE_INTEGER },
      ]);
      const before = snapshot(path);
      const h = harness(path, parents(SESSION_A));
      // The next ordinal is 2^53: sync.ts refuses it as an unsafe schedule
      // (the node:sqlite driver refuses to even read it); either way the
      // drain rejects before any row is touched, on every attempt.
      await expect(drainOutbox(store.db, h.transport)).rejects.toThrow();
      await expect(drainOutbox(store.db, h.transport)).rejects.toThrow();
      expect(h.server.calls).toEqual([]);
      expect(snapshot(path)).toEqual(before);
    });

    it('a negative last_attempt_order is tolerated: that row simply drains first and ordering still holds', async () => {
      const path = databasePath();
      const store = createSqliteTestDb(path);
      seed(store, [
        create(SESSION_A),
        { ...shot(1, SESSION_A), lastAttemptOrder: -5 },
        finalize(SESSION_A),
      ]);
      const h = harness(path, parents(SESSION_A));
      const result = await drainOutbox(store.db, h.transport);
      expect(h.violations).toEqual([]);
      expect(h.server.calls).toEqual([
        `createSession ${SESSION_A}`,
        `finalizeSession ${SESSION_A}`,
        `syncShots ${uuid(1)}`,
      ]);
      expect(result).toEqual({ synced: 3, failed: 0, remaining: 0 });
    });
  });

  describe('A11 duplicate parent identities', () => {
    it('two healthy session.create rows for one session: both acknowledged before any dependent, exactly one shot receipt', async () => {
      const path = databasePath();
      const store = createSqliteTestDb(path);
      seed(store, [create(SESSION_A), shot(1, SESSION_A), create(SESSION_A)]);
      const h = harness(path, parents(SESSION_A));
      const result = await drainOutbox(store.db, h.transport);
      expect(h.violations).toEqual([]);
      expect(h.server.calls).toEqual([
        `createSession ${SESSION_A}`,
        `createSession ${SESSION_A}`,
        `syncShots ${uuid(1)}`,
      ]);
      expect(result).toEqual({ synced: 3, failed: 0, remaining: 0 });
      expect(snapshot(path)).toEqual({ rows: [], receipts: ids([1]) });
    });

    it('a parked duplicate parent (lowest id) beside a healthy one: the healthy parent is acknowledged, yet the shot is parked as parent_rejected', async () => {
      const path = databasePath();
      const store = createSqliteTestDb(path);
      seed(store, [
        { ...create(SESSION_A), repairReason: 'session.rejected' },
        create(SESSION_A),
        shot(1, SESSION_A),
      ]);
      const h = harness(path, parents(SESSION_A));
      const result = await drainOutbox(store.db, h.transport);
      expect(h.violations).toEqual([]);
      expect(h.server.sessions).toEqual(new Set([SESSION_A]));
      // Documented observation, not an ordering violation: the drain is
      // conservative and holds the shot for repair although the server now
      // holds its session. Ordering is preserved (the shot never left).
      expect(h.server.calls).toEqual([`createSession ${SESSION_A}`]);
      expect(result).toEqual({ synced: 1, failed: 1, remaining: 2 });
      expect(
        snapshot(path).rows.map(r => [r.kind, r.attempts, r.repairReason]),
      ).toEqual([
        ['session.create', 0, 'session.rejected'],
        ['shot.sync', 0, 'session.parent_rejected'],
      ]);
    });
  });

  describe('A13 explicit repair retry after a permanently refused parent', () => {
    async function parkedSet(path: string) {
      const store = createSqliteTestDb(path);
      seed(store, [shot(1, SESSION_A), create(SESSION_A), finalize(SESSION_A)]);
      const refusing = harness(path, parents(SESSION_A), {
        createSession() {
          throw new ApiError(
            409,
            'session.id_conflict',
            'owned by another user',
          );
        },
      });
      await drainOutbox(store.db, refusing.transport);
      expect(refusing.violations).toEqual([]);
      expect(
        snapshot(path).rows.map(r => [r.kind, r.attempts, r.repairReason]),
      ).toEqual([
        ['shot.sync', 0, 'session.parent_rejected'],
        ['session.create', 1, 'session.rejected'],
        ['session.finalize', 0, 'session.parent_rejected'],
      ]);
      return store;
    }

    it('retry with a server that now accepts the parent: parent, finalizer, then shot, exactly once', async () => {
      const path = databasePath();
      const store = await parkedSet(path);
      expect(
        await retryShotSync(store.db, uuid(1), captureDataOwnerContext()),
      ).toBe(true);
      const h = harness(path, parents(SESSION_A));
      const result = await drainOutbox(store.db, h.transport);
      expect(h.violations).toEqual([]);
      expect(h.server.calls).toEqual([
        `createSession ${SESSION_A}`,
        `finalizeSession ${SESSION_A}`,
        `syncShots ${uuid(1)}`,
      ]);
      expect(result).toEqual({ synced: 3, failed: 0, remaining: 0 });
      expect(snapshot(path)).toEqual({ rows: [], receipts: ids([1]) });
    });

    it('retry while the server still refuses the parent: nothing dependent leaves, the set is parked again with one more attempt on the parent only', async () => {
      const path = databasePath();
      const store = await parkedSet(path);
      await retryShotSync(store.db, uuid(1), captureDataOwnerContext());
      const h = harness(path, parents(SESSION_A), {
        createSession() {
          throw new ApiError(
            409,
            'session.id_conflict',
            'owned by another user',
          );
        },
      });
      const result = await drainOutbox(store.db, h.transport);
      expect(h.violations).toEqual([]);
      expect(h.server.calls).toEqual([`createSession ${SESSION_A}`]);
      expect(result).toEqual({ synced: 0, failed: 2, remaining: 3 });
      const state = snapshot(path);
      expect(state.receipts).toEqual([]);
      expect(state.rows.map(r => [r.kind, r.attempts, r.repairReason])).toEqual(
        [
          ['shot.sync', 0, 'session.parent_rejected'],
          ['session.create', 1, 'session.rejected'],
          ['session.finalize', 0, 'session.parent_rejected'],
        ],
      );
    });
  });

  describe('A12 parent reconstruction from a local session with an out-of-range clock', () => {
    it.each([
      ['far past (1999)', '1999-12-31T23:59:59.000Z'],
      ['far future (2100)', '2100-01-01T00:00:00.000Z'],
      ['not ISO (space separator)', '2026-09-08 10:00:00Z'],
      ['no timezone', '2026-09-08T10:00:00.000'],
      ['impossible date', '2026-02-30T10:00:00.000Z'],
    ])(
      'startedAt %s: no parent is fabricated, the shot is parked for repair, nothing is acknowledged',
      async (_label, startedAt) => {
        const path = databasePath();
        const store = createSqliteTestDb(path);
        seed(store, [shot(1, SESSION_A)]);
        seedLocalSession(store, SESSION_A, startedAt);
        const h = harness(path, new Set());
        const result = await drainOutbox(store.db, h.transport);
        expect(h.violations).toEqual([]);
        expect(h.server.calls).toEqual([`syncShots ${uuid(1)}`]);
        expect(h.server.shots.size).toBe(0);
        expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
        const state = snapshot(path);
        expect(state.receipts).toEqual([]);
        expect(
          state.rows.map(r => [r.kind, r.attempts, r.repairReason]),
        ).toEqual([['shot.sync', 0, 'session.missing']]);
      },
    );

    it('startedAt at the last valid instant of 2099 is reconstructed and acknowledged before the shot', async () => {
      const path = databasePath();
      const store = createSqliteTestDb(path);
      seed(store, [shot(1, SESSION_A)]);
      seedLocalSession(store, SESSION_A, '2099-12-31T23:59:59.999Z');
      const h = harness(path, new Set());
      const first = await drainOutbox(store.db, h.transport);
      expect(first).toEqual({ synced: 0, failed: 1, remaining: 2 });
      const second = await drainOutbox(store.db, h.transport);
      expect(h.violations).toEqual([]);
      expect(h.server.calls.slice(1)).toEqual([
        `createSession ${SESSION_A}`,
        `syncShots ${uuid(1)}`,
      ]);
      expect(second).toEqual({ synced: 2, failed: 0, remaining: 0 });
      expect(snapshot(path)).toEqual({ rows: [], receipts: ids([1]) });
    });
  });
});
