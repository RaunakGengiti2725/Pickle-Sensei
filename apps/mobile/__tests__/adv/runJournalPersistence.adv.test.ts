/**
 * Adversarial probes for analysis run-journal persistence
 * (INT-sync-outbox-persistence): corrupt journal rows across recovery, and
 * process death inside the result/journal/outbox commit transaction. Real
 * SQLite, production DDL, production journal code.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { CapturedClip } from '../../src/camera/capture';
import {
  recoverAnalysisJournals,
  runJournal,
  type RunJournalIdentity,
  type RunJournalPermitPort,
  type RunJournalReleaseOutcome,
  type RunJournalScope,
} from '../../src/analysis/runJournal';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { forDataOwner, withTransaction } from '../../src/data/transactions';
import { saveAnalysis } from '../../src/data/repository';
import {
  createSqliteTestDb,
  closeSqliteTestDatabases,
  seedSqliteCapture,
} from '../../testSupport/sqlite';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://api.example.test/functions/v1/api';
const NOW = 1_783_382_400_000;
const scope: RunJournalScope = { ownerKey: OWNER, apiOrigin: ORIGIN };
const id = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

const clip: CapturedClip = {
  uri: 'file:///private/captures/adv.mov',
  capturedAtIso: '2026-09-07T12:00:00.000Z',
  durationMs: 2000,
  width: 1080,
  height: 1080,
  fps: 60,
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
};

function identity(operation: number): RunJournalIdentity {
  return {
    ...scope,
    ownerGeneration: 1,
    operationId: id(operation),
    captureId: id(operation + 100),
    analysisId: id(operation + 200),
    reservationKey: id(operation + 300),
    requestHash: 'a'.repeat(64),
  };
}

function analysisFor(run: RunJournalIdentity): ShotAnalysis {
  return {
    id: run.analysisId,
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: clip.capturedAtIso,
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

function permitPort() {
  const releases: Array<{
    permitId: string;
    outcome: RunJournalReleaseOutcome;
  }> = [];
  const reserves: string[] = [];
  const port: RunJournalPermitPort = {
    ...scope,
    async reserve(key) {
      reserves.push(key);
      return { permit: { id: id(9000 + reserves.length), status: 'reserved' } };
    },
    async release(permitId, outcome) {
      releases.push({ permitId, outcome });
    },
  };
  return { port, releases, reserves };
}

function journalRows(store: ReturnType<typeof createSqliteTestDb>) {
  return store.native
    .prepare(
      `SELECT operation_id, state, permit_id, result_id, release_outcome, attempt_count
       FROM analysis_run_journal WHERE owner_key = ? ORDER BY created_at_ms, operation_id`,
    )
    .all(OWNER);
}

beforeEach(() => setActiveDataOwner(OWNER));
afterEach(() => {
  closeSqliteTestDatabases();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

async function reservedRun(
  store: ReturnType<typeof createSqliteTestDb>,
  operation: number,
  permitId: string,
  nowMs: number,
) {
  const run = identity(operation);
  seedSqliteCapture(store.db, OWNER, run.captureId, {
    ...clip,
    uri: `${clip.uri}?capture=${run.captureId}`,
  });
  await runJournal.begin(store.db, run, nowMs);
  await runJournal.reserved(store.db, run, permitId, nowMs);
  return run;
}

describe('ATTACK 11 — one corrupt journal row (passes every CHECK, fails decode) among valid recoverable runs', () => {
  async function corruptAmongSiblings() {
    const store = createSqliteTestDb();
    const permits = permitPort();
    // Valid sibling that a crash left release_pending (release never sent).
    const sibling = await reservedRun(store, 1, id(5001), NOW + 1000);
    await runJournal.requestRelease(store.db, sibling, 'cancelled', NOW + 1000);
    // Valid sibling that a crash left reserved with no result.
    const orphan = await reservedRun(store, 2, id(5002), NOW + 2000);
    // Bit-rot: a reserved row whose updated_at_ms is text. SQLite's INTEGER
    // affinity keeps the text, `>= 0` holds for TEXT, the monotonic trigger
    // does not guard the column — only the typed decoder can refuse it.
    const corrupt = await reservedRun(store, 3, id(5003), NOW);
    store.native
      .prepare(
        `UPDATE analysis_run_journal SET updated_at_ms = 'bit-rot'
         WHERE owner_key = ? AND operation_id = ?`,
      )
      .run(OWNER, corrupt.operationId);
    const before = journalRows(store);
    expect(before).toHaveLength(3);
    return { store, ...permits, sibling, orphan, corrupt, before };
  }

  it('reports unknown storage and never releases, reserves or deletes the corrupt row', async () => {
    const { store, port, releases, corrupt, before } =
      await corruptAmongSiblings();
    const result = await recoverAnalysisJournals(store.db, scope, port);
    expect(result.unknownStorage).toBe(true);
    expect(
      journalRows(store).find(
        row => row['operation_id'] === corrupt.operationId,
      ),
    ).toEqual(before.find(row => row['operation_id'] === corrupt.operationId));
    expect(releases.some(call => call.permitId === id(5003))).toBe(false);
    expect(
      result.items.some(item => item.operationId === corrupt.operationId),
    ).toBe(false);
  });

  it('still recovers the valid siblings (their orphaned permits are released) on repeated passes', async () => {
    const { store, port, releases, sibling, orphan, corrupt } =
      await corruptAmongSiblings();
    const first = await recoverAnalysisJournals(store.db, scope, port);
    const second = await recoverAnalysisJournals(store.db, scope, port);
    const siblings = journalRows(store).filter(
      row => row['operation_id'] !== corrupt.operationId,
    );
    expect({
      releasedPermits: releases.map(call => call.permitId).sort(),
      siblingStates: siblings.map(row => [
        row['operation_id'],
        row['state'],
        row['attempt_count'],
      ]),
      recoveredKinds: [...first.items, ...second.items].map(item => item.kind),
    }).toEqual({
      releasedPermits: [id(5001), id(5002)],
      siblingStates: [
        [sibling.operationId, 'released', 1],
        [orphan.operationId, 'released', 1],
      ],
      recoveredKinds: ['released', 'released'],
    });
  });
});

describe('ATTACK 12 — process death inside the result/journal/outbox commit transaction', () => {
  it('leaves no partial rating when the outbox insert dies, and commits atomically when the COMMIT ack is lost', async () => {
    const store = createSqliteTestDb();
    const { port, releases } = permitPort();
    const run = await reservedRun(store, 10, id(5010), NOW);
    const analysis = analysisFor(run);
    const ownerContext = captureDataOwnerContext();

    // Death on the outbox insert: local_shot must not survive alone.
    store.failStatementOnce(
      'INSERT INTO outbox',
      new Error('process killed before outbox insert'),
    );
    await expect(
      withTransaction(store.db, async rawTransaction => {
        const db = forDataOwner(rawTransaction, ownerContext);
        await saveAnalysis(db, analysis, id(5010));
        await runJournal.commit(rawTransaction, run, analysis.id, NOW + 1);
      }),
    ).rejects.toThrow('process killed before outbox insert');
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(store.count('outbox', OWNER)).toBe(0);
    expect(store.count('sync_receipt', OWNER)).toBe(0);
    expect(await runJournal.readCommitStatus(store.db, run)).toMatchObject({
      kind: 'not_committed',
      run: { state: 'reserved', permitId: id(5010) },
    });

    // Lost COMMIT acknowledgement: the physical commit either fully landed
    // or nothing did — here it landed, so every artefact exists together.
    store.failCommitOnce('after', "SET state = 'committed'");
    await expect(
      withTransaction(store.db, async rawTransaction => {
        const db = forDataOwner(rawTransaction, ownerContext);
        await saveAnalysis(db, analysis, id(5010));
        await runJournal.commit(rawTransaction, run, analysis.id, NOW + 2);
      }),
    ).rejects.toThrow('SQLite commit acknowledgement lost');
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(store.count('outbox', OWNER)).toBe(1);
    expect(await runJournal.readCommitStatus(store.db, run)).toMatchObject({
      kind: 'committed',
      resultId: analysis.id,
    });
    // A later recovery pass must never release the committed permit.
    const recovered = await recoverAnalysisJournals(store.db, scope, port);
    expect(recovered.unknownStorage).toBe(false);
    expect(recovered.items).toEqual([]);
    expect(releases).toEqual([]);
    // Re-running the same commit is idempotent, never a second rating.
    const again = await withTransaction(store.db, async rawTransaction =>
      runJournal.commit(rawTransaction, run, analysis.id, NOW + 3),
    );
    expect(again.state).toBe('committed');
    expect(store.count('outbox', OWNER)).toBe(1);
  });
});
