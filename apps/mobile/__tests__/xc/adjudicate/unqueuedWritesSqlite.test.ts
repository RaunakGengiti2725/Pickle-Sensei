/**
 * Adversarial follow-up to outboxSqlite.test.ts (fix candidate 15a7b9e5,
 * cluster xc-journeys::XC-P2-SCORED-WRITE-NESTED-TXN).
 *
 * The fix serializes every BEGIN IMMEDIATE on a LocalDb through writeQueue.ts
 * and puts the drain's own autocommit writes (recordRowFailure /
 * deleteOutboxRow) behind the same lock — its comment on deleteOutboxRow
 * names the hazard: an autocommit statement issued while another caller
 * holds a transaction on the ONE connection "would otherwise join that unit
 * and vanish with its ROLLBACK".
 *
 * repository.ts still has writers that bypass the queue (saveLocalOnlyAnalysis,
 * setKv, savePendingCapture, saveAnalysisRecord, markCaptureAnalyzed,
 * setDeclaredStroke, setCaptureTargetSeed, updateCaptureClipPayload). Each
 * one that lands while a queued transaction is open is absorbed into that
 * transaction: its promise resolves (the caller believes the row is durable)
 * and the row disappears if that transaction rolls back.
 *
 * These tests reproduce that against a real SQLite engine. They are written
 * to FAIL on the candidate (they pin the product expectation: a write whose
 * promise resolved without error is durable regardless of what another
 * caller's transaction does afterwards).
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import {
  getKv,
  saveAnalysis,
  saveLocalOnlyAnalysis,
  setKv,
} from '../../../src/data/repository';
import { drainOutbox, type SyncTransport } from '../../../src/data/sync';
import { openNodeSqliteLocalDb } from '../../../test-support/adjudicate/nodeSqliteDb';

const owner = '11111111-1111-4111-8111-111111111111';
const permitId = '22222222-2222-4222-8222-222222222222';

function shot(
  id: string,
  resultKind: ShotAnalysis['resultKind'] = 'scored',
): ShotAnalysis {
  return {
    id,
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: resultKind === 'scored' ? 7.8 : null,
    analysisConfidence: resultKind === 'scored' ? 0.91 : 0.31,
    resultKind,
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'validated-bundle-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'score-1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

const uuid = (n: number) =>
  `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;

const acceptAllTransport: SyncTransport = {
  syncShots: async shots => ({
    acceptedIds: (shots as Array<{ id: string }>).map(s => s.id),
    rejected: [],
  }),
  createSession: async () => {},
  finalizeSession: async () => {},
};

const macrotask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const RECEIPT_SQL = 'INSERT OR REPLACE INTO sync_receipt';
const DELETE_OUTBOX_SQL = 'DELETE FROM outbox WHERE owner_key = ? AND id = ?';
const OUTBOX_INSERT_SQL = 'INSERT INTO outbox';

describe('adjudication: unqueued repository writes on a real SQLite connection', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it("an abstention (saveLocalOnlyAnalysis) that resolves while the drain's receipt transaction is open survives that transaction's ROLLBACK", async () => {
    const sqlite = openNodeSqliteLocalDb();
    const { db } = sqlite;
    await saveAnalysis(db, shot(uuid(1)), permitId);

    let abstention: Promise<void> | null = null;
    let abstentionError: unknown = null;
    let abstentionSettledBeforeDrainEnd = false;
    sqlite.beforeStatement = async sql => {
      if (sql.includes(RECEIPT_SQL) && !abstention) {
        // A low-confidence run finishes on the Analyze screen while the sync
        // timer's drain is inside its receipt transaction.
        abstention = saveLocalOnlyAnalysis(db, shot(uuid(2), 'low_confidence'))
          .then(() => {
            abstentionSettledBeforeDrainEnd = true;
          })
          .catch(error => {
            abstentionError = error;
          });
        await macrotask();
        await macrotask();
        return;
      }
      if (abstention && sql.includes(DELETE_OUTBOX_SQL)) {
        sqlite.beforeStatement = null;
        throw new Error('injected: outbox delete failed');
      }
    };

    const drain = await drainOutbox(db, acceptAllTransport);
    await abstention;

    const shots = sqlite
      .all(`SELECT id FROM local_shot WHERE owner_key = ? ORDER BY id`, [owner])
      .map(r => r['id']);
    const errors = sqlite.trace
      .filter(t => t.outcome === 'error')
      .map(t => t.error);
    const writes = sqlite.trace
      .filter(t => !t.sql.trim().toUpperCase().startsWith('SELECT'))
      .map(t => `${t.outcome === 'ok' ? '' : 'ERR '}${t.sql.slice(0, 40)}`);
    console.log(
      `[adjudicate] abstentionError=${String(abstentionError)} settledBeforeDrainEnd=${abstentionSettledBeforeDrainEnd} drain=${JSON.stringify(drain)} local_shot=${JSON.stringify(shots)} sqliteErrors=${JSON.stringify(errors)}\n  writes=${JSON.stringify(writes, null, 1)}`,
    );

    // Preconditions: the abstention's promise resolved cleanly BEFORE the
    // drain finished (the caller has already told the user the result is
    // saved), and the drain rolled its own unit back as designed.
    expect(abstentionError).toBeNull();
    expect(abstentionSettledBeforeDrainEnd).toBe(true);
    expect(drain).toMatchObject({ synced: 0, failed: 1 });
    // Product expectation: a write that resolved without error is durable.
    // Candidate: the autocommit INSERT joined the drain's open transaction
    // and vanished with its ROLLBACK — local_shot holds only shot A.
    expect(shots).toEqual([uuid(1), uuid(2)]);
  });

  it("a setKv that resolves while a scored write's transaction is open survives that transaction's ROLLBACK", async () => {
    const sqlite = openNodeSqliteLocalDb();
    const { db } = sqlite;
    await setKv(db, 'walkthrough.seen', '');

    let kvWrite: Promise<void> | null = null;
    let kvError: unknown = null;
    sqlite.beforeStatement = async sql => {
      if (sql.includes('INSERT OR REPLACE INTO local_shot') && !kvWrite) {
        // Any kv writer (walkthrough seen, review prompt, notification
        // choice, practice set) lands while saveAnalysis holds its unit.
        kvWrite = setKv(db, 'walkthrough.seen', 'seen').catch(error => {
          kvError = error;
        });
        await macrotask();
        await macrotask();
        return;
      }
      if (kvWrite && sql.includes(OUTBOX_INSERT_SQL)) {
        sqlite.beforeStatement = null;
        throw new Error('injected: outbox insert failed');
      }
    };

    let saveError: unknown = null;
    await saveAnalysis(db, shot(uuid(3)), permitId).catch(error => {
      saveError = error;
    });
    await kvWrite;

    const seen = await getKv(db, 'walkthrough.seen');
    const shots = sqlite
      .all(`SELECT id FROM local_shot WHERE owner_key = ?`, [owner])
      .map(r => r['id']);
    console.log(
      `[adjudicate] kvError=${String(kvError)} saveError=${String(saveError)} kv.walkthrough.seen=${JSON.stringify(seen)} local_shot=${JSON.stringify(shots)}`,
    );

    // Preconditions: the kv write resolved cleanly; the scored write failed
    // and rolled back its own rows (no half-written rating).
    expect(kvError).toBeNull();
    expect(String(saveError)).toContain('injected: outbox insert failed');
    expect(shots).toEqual([]);
    // Product expectation: the kv value the caller was told was saved is
    // still there. Candidate: it rolled back with the scored write.
    expect(seen).toBe('seen');
  });
});
