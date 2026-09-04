/**
 * Adjudication reproductions (xc-journeys / journey-offline-first) against a
 * REAL SQLite engine behind LocalDb.
 *
 * saveAnalysis (BEGIN IMMEDIATE via the repository transaction helper) racing
 * drainOutbox's receipt transaction (BEGIN IMMEDIATE) on the ONE shared
 * connection: without serialization the loser's BEGIN throws "cannot start a
 * transaction within a transaction", its catch-ROLLBACK tears down the
 * winner's transaction, and the scored rating is lost (no local_shot row, no
 * outbox row) after the permit was already spent.
 *
 * Contract pinned here: every transaction on a LocalDb connection is
 * serialized through one write queue, so a concurrent scored write is queued
 * behind the drain's receipt transaction (never nested inside it), the drain's
 * receipt+delete still commits (or rolls back) atomically, and the queued
 * write commits on its own afterwards.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { saveAnalysis } from '../../../src/data/repository';
import { drainOutbox, type SyncTransport } from '../../../src/data/sync';
import { openNodeSqliteLocalDb, type SqlTrace } from './nodeSqliteDb';

const owner = '11111111-1111-4111-8111-111111111111';
const permitId = '22222222-2222-4222-8222-222222222222';

function shot(id: string, sessionId: string | null = null): ShotAnalysis {
  return {
    id,
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.8,
    analysisConfidence: 0.91,
    resultKind: 'scored',
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
const LOCAL_SHOT_SQL = 'INSERT OR REPLACE INTO local_shot';

const indexOf = (trace: SqlTrace[], needle: string, from = 0) =>
  trace.findIndex((t, i) => i >= from && t.sql.includes(needle));

/** Everything that can change the database or its transaction state. */
const writeStatements = (trace: SqlTrace[]) =>
  trace.filter(t => !t.sql.trim().toUpperCase().startsWith('SELECT'));

/** Indices (into the trace) of every statement the drain's receipt
 * transaction issued, in order, plus the first statement of the scored write
 * that raced it. */
function transactionLayout(trace: SqlTrace[]) {
  const receipt = indexOf(trace, RECEIPT_SQL);
  const drainBegin = trace
    .map((t, i) => (t.sql === 'BEGIN IMMEDIATE' && i < receipt ? i : -1))
    .filter(i => i >= 0)
    .pop();
  const drainDelete = indexOf(trace, DELETE_OUTBOX_SQL, receipt);
  const drainEnd = trace.findIndex(
    (t, i) => i > receipt && (t.sql === 'COMMIT' || t.sql === 'ROLLBACK'),
  );
  const saveBShot = indexOf(trace, LOCAL_SHOT_SQL, drainBegin ?? 0);
  const saveBBegin = trace
    .map((t, i) => (t.sql === 'BEGIN IMMEDIATE' && i < saveBShot ? i : -1))
    .filter(i => i >= 0)
    .pop();
  return { drainBegin, receipt, drainDelete, drainEnd, saveBBegin, saveBShot };
}

/** Starts a scored write for shot B the moment the drain is INSIDE its
 * receipt transaction (about to insert the receipt), exactly as a scored run
 * on the Analyze screen would while the sync timer fires. With `failDelete`
 * the drain's outbox delete then fails (a corrupt page, a disk-full error —
 * any statement failure inside the drain's unit). */
function raceSaveBAgainstReceipt(
  sqlite: ReturnType<typeof openNodeSqliteLocalDb>,
  options: { failDelete?: boolean } = {},
): { saveB: () => Promise<void> | null; error: () => unknown } {
  let saveB: Promise<void> | null = null;
  let saveBError: unknown = null;
  sqlite.beforeStatement = async sql => {
    if (sql.includes(RECEIPT_SQL) && !saveB) {
      saveB = saveAnalysis(sqlite.db, shot(uuid(2)), permitId).catch(error => {
        saveBError = error;
      });
      // Let the scored write reach (and, unserialized, issue) its BEGIN while
      // the drain's transaction is still open.
      await macrotask();
      await macrotask();
      if (!options.failDelete) sqlite.beforeStatement = null;
      return;
    }
    if (options.failDelete && saveB && sql.includes(DELETE_OUTBOX_SQL)) {
      sqlite.beforeStatement = null;
      throw new Error('injected: outbox delete failed');
    }
  };
  return { saveB: () => saveB, error: () => saveBError };
}

describe('adjudication: outbox on a real SQLite connection', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('saveAnalysis started inside the drain receipt transaction keeps the scored rating (both local_shot rows, shot B queued, no SQLite errors)', async () => {
    const sqlite = openNodeSqliteLocalDb();
    const { db } = sqlite;
    // Shot A is already queued; the drain will get it accepted.
    await saveAnalysis(db, shot(uuid(1)), permitId);
    const race = raceSaveBAgainstReceipt(sqlite);

    let drainError: unknown = null;
    const drain = await drainOutbox(db, acceptAllTransport).catch(error => {
      drainError = error;
      return null;
    });
    await race.saveB();

    const shots = sqlite
      .all(`SELECT id FROM local_shot WHERE owner_key = ? ORDER BY id`, [owner])
      .map(r => r['id']);
    const outbox = sqlite.all(
      `SELECT kind, payload FROM outbox WHERE owner_key = ?`,
      [owner],
    );
    const queuedB = outbox.some(r => String(r['payload']).includes(uuid(2)));
    const errors = sqlite.trace
      .filter(t => t.outcome === 'error')
      .map(t => t.error);

    console.log(
      `[adjudicate] saveB error=${String(race.error())} drainError=${String(drainError)} local_shot=${JSON.stringify(shots)} queuedB=${queuedB} sqliteErrors=${JSON.stringify(errors)}`,
    );
    // Expected product behaviour: shot B (a scored, permit-backed rating) is
    // durably stored and queued for sync regardless of a concurrent drain.
    expect(race.error()).toBeNull();
    expect(drainError).toBeNull();
    expect(drain).toMatchObject({ synced: 1, failed: 0 });
    expect(shots).toEqual([uuid(1), uuid(2)]);
    expect(queuedB).toBe(true);
    expect(errors).toEqual([]);
  });

  it("characterization: the drain's receipt+delete transaction commits atomically while the scored write waits its turn behind it", async () => {
    const sqlite = openNodeSqliteLocalDb();
    const { db } = sqlite;
    await saveAnalysis(db, shot(uuid(1)), permitId);
    const race = raceSaveBAgainstReceipt(sqlite);

    const drain = await drainOutbox(db, acceptAllTransport);
    await race.saveB();

    expect(race.error()).toBeNull();
    expect(drain).toMatchObject({ synced: 1, failed: 0 });

    // Shot A: receipt recorded AND outbox row gone — one atomic unit.
    const receipts = sqlite
      .all(
        `SELECT entity_id FROM sync_receipt WHERE owner_key = ? AND kind = 'shot.sync'`,
        [owner],
      )
      .map(r => r['entity_id']);
    expect(receipts).toEqual([uuid(1)]);
    const outbox = sqlite.all(
      `SELECT payload, attempts FROM outbox WHERE owner_key = ? ORDER BY id`,
      [owner],
    );
    expect(outbox).toHaveLength(1);
    expect(String(outbox[0]?.['payload'])).toContain(uuid(2));
    expect(outbox[0]?.['attempts']).toBe(0);

    // Write order on the connection (reads may interleave freely — the
    // drain's remaining-count SELECT is one): the drain's BEGIN … receipt …
    // delete … COMMIT is contiguous, and the scored write's BEGIN comes
    // strictly after that COMMIT (queued, never nested), then commits as its
    // own contiguous unit.
    const writes = writeStatements(sqlite.trace);
    const layout = transactionLayout(writes);
    expect(layout.drainBegin).toBeDefined();
    expect(layout.receipt).toBe((layout.drainBegin ?? -2) + 1);
    expect(layout.drainDelete).toBe(layout.receipt + 1);
    expect(layout.drainEnd).toBe(layout.drainDelete + 1);
    expect(writes[layout.drainEnd]?.sql).toBe('COMMIT');
    expect(layout.saveBBegin).toBeGreaterThan(layout.drainEnd);
    expect(layout.saveBShot).toBe((layout.saveBBegin ?? -2) + 1);
    expect(writes[layout.saveBShot + 1]?.sql).toContain('INSERT INTO outbox');
    expect(writes[layout.saveBShot + 2]?.sql).toBe('COMMIT');
    expect(sqlite.trace.filter(t => t.outcome === 'error')).toEqual([]);
  });

  it('characterization: a failing receipt transaction rolls back atomically and the queued scored write still commits on its own', async () => {
    const sqlite = openNodeSqliteLocalDb();
    const { db } = sqlite;
    await saveAnalysis(db, shot(uuid(1)), permitId);
    const race = raceSaveBAgainstReceipt(sqlite, { failDelete: true });

    // The drain reports the row as failed (retryable: the server accepted
    // the shot idempotently, the next drain re-sends it) instead of throwing.
    const drain = await drainOutbox(db, acceptAllTransport);
    await race.saveB();
    expect(race.error()).toBeNull();
    expect(drain).toMatchObject({ synced: 0, failed: 1 });

    // The receipt written inside the failed unit is gone with it, and shot
    // A's outbox row survives for the next drain with the failure recorded.
    const receipts = sqlite.all(
      `SELECT entity_id FROM sync_receipt WHERE owner_key = ?`,
      [owner],
    );
    expect(receipts).toEqual([]);
    const queued = sqlite.all(
      `SELECT payload, attempts, last_error FROM outbox WHERE owner_key = ? ORDER BY id`,
      [owner],
    );
    expect(queued).toHaveLength(2);
    expect(String(queued[0]?.['payload'])).toContain(uuid(1));
    expect(queued[0]?.['attempts']).toBe(0);
    expect(String(queued[0]?.['last_error'])).toContain(
      'injected: outbox delete failed',
    );
    expect(String(queued[1]?.['payload'])).toContain(uuid(2));
    expect(queued[1]?.['last_error']).toBeNull();
    // Shot B's rating is durable despite the drain's failure.
    const shots = sqlite
      .all(`SELECT id FROM local_shot WHERE owner_key = ? ORDER BY id`, [owner])
      .map(r => r['id']);
    expect(shots).toEqual([uuid(1), uuid(2)]);

    const writes = writeStatements(sqlite.trace);
    const layout = transactionLayout(writes);
    expect(layout.receipt).toBe((layout.drainBegin ?? -2) + 1);
    expect(layout.drainEnd).toBe(layout.receipt + 1);
    expect(writes[layout.drainEnd]?.sql).toBe('ROLLBACK');
    expect(writes[layout.drainEnd]?.outcome).toBe('ok');
    expect(layout.saveBBegin).toBeGreaterThan(layout.drainEnd);
    expect(layout.saveBShot).toBe((layout.saveBBegin ?? -2) + 1);
    expect(writes[layout.saveBShot + 2]?.sql).toBe('COMMIT');
    // No statement from the scored write leaked into the drain's unit and
    // the engine never saw a nested BEGIN.
    expect(sqlite.trace.filter(t => t.outcome === 'error')).toEqual([]);
  });
});
