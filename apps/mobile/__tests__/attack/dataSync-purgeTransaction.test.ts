/**
 * ADVERSARIAL TESTER #2 (pass 3) — repository transactions against a REAL
 * SQLite (scripts/attack/realSqliteBridge; real BEGIN/COMMIT/ROLLBACK).
 *
 *  S5  the 3rd DELETE inside purgeOwnerData (local_capture) fails: is
 *      ROLLBACK issued and are the two earlier deletes (local_shot,
 *      local_session) NOT observable afterwards? Extends the pinned
 *      first-failure case (wf/flow-data-layer-typed-failures) to
 *      mid-sequence, with the failure raised by SQLite itself (a trigger),
 *      not by a fake.
 *  S9  (own) two inTransaction() callers interleaved on the ONE shared
 *      connection the app uses (drainOutbox receipt txn vs saveAnalysis):
 *      what does the nested BEGIN IMMEDIATE do to the other caller's rows?
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  attackArtifactExists,
  RealSqlite,
  writeAttackArtifact,
} from '../../scripts/attack/realSqliteBridge';

let mockOpenImpl: () => unknown = () => {
  throw new Error('bridge not ready');
};
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => mockOpenImpl(),
}));

import { getDb } from '../../src/data/db';
import {
  OWNER_SCOPED_KV_NAMESPACES,
  purgeOwnerData,
  saveAnalysis,
  hasShotSyncReceipt,
  getShotOutboxStatus,
} from '../../src/data/repository';
import { drainOutbox, type SyncTransport } from '../../src/data/sync';
import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const OWNER_A = canonicalDataOwner('aaaaaaaa-0000-4000-8000-00000000000a');
const OWNER_B = canonicalDataOwner('bbbbbbbb-0000-4000-8000-00000000000b');

let bridge: RealSqlite;
let db: ReturnType<typeof getDb>;

beforeAll(() => {
  bridge = new RealSqlite('purge');
  mockOpenImpl = () => bridge;
  db = getDb();
});
afterAll(() => {
  db.close();
  bridge.dispose();
});

function seedOwner(owner: string): void {
  const now = '2026-09-01T10:00:00.000Z';
  bridge.executeSync(
    `INSERT INTO local_shot (owner_key,id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,payload)
     VALUES (?, ?, 's1', 'dink', ?, 7, 0.9, 'scored', 'real', '{}')`,
    [owner, `${owner}-shot`, now],
  );
  bridge.executeSync(
    `INSERT INTO local_session (owner_key,id,mode,started_at) VALUES (?, 's1', 'practice', ?)`,
    [owner, now],
  );
  bridge.executeSync(
    `INSERT INTO local_capture (owner_key,id,uri,shot_type,captured_at,duration_ms,fps,width,height,status)
     VALUES (?, ?, ?, 'dink', ?, 2000, 30, 1080, 1920, 'analyzed')`,
    [owner, `${owner}-cap`, `file:///${owner}.mov`, now],
  );
  bridge.executeSync(
    `INSERT INTO local_analysis_record (owner_key,id,capture_id,created_at,engine_version,scoring_model_version,record)
     VALUES (?, ?, ?, ?, 'e1', 'sm1', '{}')`,
    [owner, `${owner}-rec`, `${owner}-cap`, now],
  );
  bridge.executeSync(
    `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', '{}')`,
    [owner],
  );
  bridge.executeSync(
    `INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
    [owner, `${owner}-shot`],
  );
  for (const ns of OWNER_SCOPED_KV_NAMESPACES) {
    bridge.executeSync(`INSERT INTO kv (key, value) VALUES (?, 'x')`, [
      `${ns}:${owner}`,
    ]);
  }
}

function ownerFootprint(owner: string): Record<string, number> {
  const count = (sql: string, params: unknown[]) =>
    Number(bridge.executeSync(sql, params).rows[0]?.['n']);
  return {
    local_shot: count(`SELECT count(*) n FROM local_shot WHERE owner_key = ?`, [
      owner,
    ]),
    local_session: count(
      `SELECT count(*) n FROM local_session WHERE owner_key = ?`,
      [owner],
    ),
    local_capture: count(
      `SELECT count(*) n FROM local_capture WHERE owner_key = ?`,
      [owner],
    ),
    local_analysis_record: count(
      `SELECT count(*) n FROM local_analysis_record WHERE owner_key = ?`,
      [owner],
    ),
    outbox: count(`SELECT count(*) n FROM outbox WHERE owner_key = ?`, [owner]),
    sync_receipt: count(
      `SELECT count(*) n FROM sync_receipt WHERE owner_key = ?`,
      [owner],
    ),
    kv: count(`SELECT count(*) n FROM kv WHERE key LIKE ?`, [`%:${owner}`]),
  };
}

const FULL = {
  local_shot: 1,
  local_session: 1,
  local_capture: 1,
  local_analysis_record: 1,
  outbox: 1,
  sync_receipt: 1,
  kv: 5,
};

describe('S5 — purgeOwnerData: the 3rd DELETE (local_capture) fails inside SQLite', () => {
  beforeEach(() => {
    bridge.hooks.beforeExecute = undefined;
    bridge.executeSync('DROP TRIGGER IF EXISTS attack_fail_capture_delete');
    for (const t of [
      'local_shot',
      'local_session',
      'local_capture',
      'local_analysis_record',
      'outbox',
      'sync_receipt',
      'kv',
    ]) {
      bridge.executeSync(`DELETE FROM ${t}`);
    }
    seedOwner(OWNER_A);
    seedOwner(OWNER_B);
  });

  test('ROLLBACK is issued and the first two deletes are not observable; the other owner is untouched', async () => {
    // A genuine SQLite failure on the 3rd statement of the sequence.
    bridge.executeSync(`CREATE TRIGGER attack_fail_capture_delete
      BEFORE DELETE ON local_capture
      BEGIN SELECT RAISE(ABORT, 'disk I/O'); END`);
    const before = bridge.log.length;

    await expect(purgeOwnerData(db, OWNER_A)).rejects.toThrow('disk I/O');

    const txnLog = bridge.log.slice(before);
    const deletes = txnLog.filter(sql => sql.startsWith('DELETE FROM'));
    const artifact = writeAttackArtifact('s5-purge-third-delete-fails.json', {
      sqliteVersion: bridge.sqliteVersion,
      statementsIssued: txnLog,
      ownerA: ownerFootprint(OWNER_A),
      ownerB: ownerFootprint(OWNER_B),
      inTransactionAfter: bridge.executeSync('SELECT 1').rows.length === 1,
    });
    expect(attackArtifactExists(artifact)).toBe(true);

    // Exactly BEGIN, 3 DELETEs (the third failed), ROLLBACK — no COMMIT.
    expect(txnLog[0]).toBe('BEGIN IMMEDIATE');
    expect(deletes).toHaveLength(3);
    expect(deletes[2]).toContain('DELETE FROM local_capture');
    expect(txnLog[txnLog.length - 1]).toBe('ROLLBACK');
    expect(txnLog).not.toContain('COMMIT');

    // HELD: the earlier local_shot / local_session deletes were rolled back
    // in the real database — nothing about owner A (or B) changed.
    expect(ownerFootprint(OWNER_A)).toEqual(FULL);
    expect(ownerFootprint(OWNER_B)).toEqual(FULL);

    // The connection is usable again (no dangling transaction): a fresh
    // BEGIN IMMEDIATE must not fail with "within a transaction".
    bridge.executeSync('BEGIN IMMEDIATE');
    bridge.executeSync('ROLLBACK');
  });

  test('control: without the trigger the whole bucket goes and the other owner stays', async () => {
    await purgeOwnerData(db, OWNER_A);
    expect(ownerFootprint(OWNER_A)).toEqual({
      local_shot: 0,
      local_session: 0,
      local_capture: 0,
      local_analysis_record: 0,
      outbox: 0,
      sync_receipt: 0,
      kv: 0,
    });
    expect(ownerFootprint(OWNER_B)).toEqual(FULL);
  });

  test('double fault: ROLLBACK itself failing preserves the original error and leaves no open transaction', async () => {
    bridge.executeSync(`CREATE TRIGGER attack_fail_capture_delete
      BEFORE DELETE ON local_capture
      BEGIN SELECT RAISE(ABORT, 'disk I/O'); END`);
    bridge.hooks.beforeExecute = sql => {
      if (sql === 'ROLLBACK') {
        // Simulate the driver losing the connection mid-rollback.
        bridge.hooks.beforeExecute = undefined;
        throw new Error('database is locked');
      }
    };
    await expect(purgeOwnerData(db, OWNER_A)).rejects.toThrow('disk I/O');
    // ATTACK RESULT (documented): the swallowed ROLLBACK failure means the
    // real transaction is STILL OPEN on the shared connection; the next
    // inTransaction() caller's BEGIN IMMEDIATE fails.
    let nextBeginError: string | null = null;
    try {
      bridge.executeSync('BEGIN IMMEDIATE');
    } catch (e) {
      nextBeginError = (e as Error).message;
    }
    bridge.executeSync('ROLLBACK');
    writeAttackArtifact('s5b-purge-rollback-double-fault.json', {
      nextBeginError,
      ownerA: ownerFootprint(OWNER_A),
    });
    expect(nextBeginError).toBe(
      'cannot start a transaction within a transaction',
    );
    expect(ownerFootprint(OWNER_A)).toEqual(FULL);
  });
});

describe('S9 (own) — interleaved inTransaction callers on the single shared connection', () => {
  const OWNER = canonicalDataOwner('cccccccc-0000-4000-8000-00000000000c');
  const analysis: ShotAnalysis = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T18:00:00.000Z',
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
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
  const QUEUED_ID = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const PERMIT = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  beforeEach(() => {
    for (const t of ['local_shot', 'outbox', 'sync_receipt']) {
      bridge.executeSync(`DELETE FROM ${t}`);
    }
    setActiveDataOwner(OWNER);
    bridge.executeSync(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [
        OWNER,
        JSON.stringify({
          ...analysis,
          id: QUEUED_ID,
          analysisPermitId: PERMIT,
        }),
      ],
    );
  });

  const accepting: SyncTransport = {
    async syncShots(shots) {
      return {
        acceptedIds: (shots as Array<{ id: string }>).map(s => s.id),
        rejected: [],
      };
    },
    async createSession() {},
    async finalizeSession() {},
  };

  async function snapshot() {
    return {
      newRatingPersisted:
        Number(
          bridge.executeSync(`SELECT count(*) n FROM local_shot WHERE id = ?`, [
            analysis.id,
          ]).rows[0]?.['n'],
        ) === 1,
      newRatingQueued: await getShotOutboxStatus(db, analysis.id),
      queuedRowReceipt: await hasShotSyncReceipt(db, QUEUED_ID),
      queuedRowStatus: await getShotOutboxStatus(db, QUEUED_ID),
      outboxRows: bridge.executeSync(`SELECT id, attempts FROM outbox`).rows,
    };
  }
  function settled(outcomes: PromiseSettledResult<unknown>[]) {
    return outcomes.map(o =>
      o.status === 'fulfilled'
        ? { status: 'fulfilled', value: o.value }
        : { status: 'rejected', reason: String(o.reason) },
    );
  }

  test('ordering A — saveAnalysis opens its txn first; the server-ACCEPTED shot cannot be receipted', async () => {
    const before = bridge.log.length;
    const outcomes = await Promise.allSettled([
      drainOutbox(db, accepting),
      saveAnalysis(db, analysis, PERMIT),
    ]);
    const log = bridge.log.slice(before);
    const state = await snapshot();
    writeAttackArtifact('s9a-interleaved-save-first.json', {
      outcomes: settled(outcomes),
      statements: log,
      state,
    });
    // saveAnalysis wins; the drain's BEGIN IMMEDIATE fails with a nested
    // transaction error AFTER the server accepted the shot, so the accepted
    // row is left in the outbox as a transient failure and will be re-sent.
    expect(outcomes[1]?.status).toBe('fulfilled');
    expect(outcomes[0]).toEqual({
      status: 'fulfilled',
      value: { synced: 0, failed: 1, remaining: 2 },
    });
    expect(state.queuedRowReceipt).toBe(false);
    expect(state.queuedRowStatus).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: 'Error: cannot start a transaction within a transaction',
    });
    // The drain's recordRowFailure UPDATE ran INSIDE saveAnalysis's txn.
    expect(log.indexOf('COMMIT')).toBeGreaterThan(
      log.findIndex(sql => sql.startsWith('UPDATE outbox SET last_error')),
    );
  });

  test("ordering B — drain opens its receipt txn first; the new rating's saveAnalysis is REJECTED (rating lost)", async () => {
    let save: Promise<void> | null = null;
    bridge.hooks.beforeExecute = sql => {
      if (sql === 'BEGIN IMMEDIATE' && save === null) {
        // Fire once the drain's BEGIN has executed (next microtask), i.e. a
        // scoring run finishing while the timer/foreground drain commits.
        save = Promise.resolve().then(() => saveAnalysis(db, analysis, PERMIT));
      }
    };
    const before = bridge.log.length;
    const drain = await Promise.allSettled([drainOutbox(db, accepting)]);
    bridge.hooks.beforeExecute = undefined;
    const saveOutcome = await Promise.allSettled([
      save as Promise<void> | null,
    ]);
    const log = bridge.log.slice(before);
    const state = await snapshot();
    writeAttackArtifact('s9b-interleaved-drain-first.json', {
      outcomes: settled([...drain, ...saveOutcome]),
      statements: log,
      state,
    });
    // saveAnalysis's inTransaction fails at BEGIN IMMEDIATE (outside its
    // try/catch, so NO ROLLBACK is issued — the drain's txn survives) and
    // rethrows: the scored rating, whose permit is already reserved
    // server-side, is never written to local_shot or the outbox and
    // runCaptureAnalysis rejects with a SQLite error on the Analyze screen.
    expect(saveOutcome[0]?.status).toBe('rejected');
    expect(String((saveOutcome[0] as PromiseRejectedResult).reason)).toContain(
      'cannot start a transaction within a transaction',
    );
    expect(state.newRatingPersisted).toBe(false);
    expect(state.newRatingQueued.state).toBe('absent');
    expect(log).not.toContain('ROLLBACK');
    expect(log.filter(sql => sql === 'BEGIN IMMEDIATE')).toHaveLength(2);
    // The drain itself completes normally.
    expect(drain[0]).toEqual({
      status: 'fulfilled',
      value: { synced: 1, failed: 0, remaining: 0 },
    });
    expect(state.queuedRowReceipt).toBe(true);
    expect(state.queuedRowStatus.state).toBe('absent');
  });
});
