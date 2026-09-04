/**
 * XC journey-history-library-delete — SQLite ⇄ outbox ⇄ receipt consistency
 * on a REAL SQLite engine behind the REAL `getDb()` (real local migrations).
 *
 * Journey under test: Library/History load, reopen a result, delete a shot
 * (local + synced), stale entry after a server mismatch, missing media.
 *
 * Every scenario drives the production repository/sync functions; nothing
 * here writes rows by hand except to seed a corruption the code must then
 * cope with. Structural invariants ("no ghost rows") are checked by
 * `auditGhosts()` over the whole database after every step, and the seeded
 * fuzzers record the exact seed + operation log of every mismatch to the
 * artifact JSON so a failure replays with `XC_REPLAY_SEED=<seed>`.
 *
 * Run: npx jest __tests__/xc   (Node >= 22.5; 22.5–22.12 without
 *      --experimental-sqlite transparently use the worker-thread engine)
 * Scale knobs: XC_FUZZ_SEEDS (default 400), XC_FUZZ_OPS (default 40),
 *              XC_RACE_SEEDS (default 300).
 */
jest.mock('@op-engineering/op-sqlite', () => {
  const support = jest.requireActual(
    '../../test/xcHistoryLibraryDelete/realSqlite',
  ) as typeof import('../../test/xcHistoryLibraryDelete/realSqlite');
  return {
    open: (options: { name: string }) => support.openRealSqlite(options),
  };
});

import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { ApiError } from '../../src/data/api';
import { getDb } from '../../src/data/db';
import * as repository from '../../src/data/repository';
import {
  getAnalysis,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listCaptureHistory,
  listPendingCaptures,
  listShots,
  markCaptureAnalyzed,
  purgeOwnerData,
  saveAnalysis,
  saveAnalysisRecord,
  saveLocalOnlyAnalysis,
  savePendingCapture,
  saveSession,
  setKv,
} from '../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../src/data/sync';
import { loadStrokeResultEvidence } from '../../src/components/strokeResultData';
import {
  OWNER_TABLES,
  auditGhosts,
  currentDriver,
  heapUsedMb,
  mulberry32,
  pick,
  seededUuid,
  snapshotOwner,
  sqliteEngine,
  writeArtifact,
  type GhostAudit,
  type OwnerSnapshot,
} from '../../test/xcHistoryLibraryDelete/realSqlite';
import {
  OWNER_A,
  OWNER_B,
  analysisRecord,
  capturedClip,
  randomShotAnalysis,
  shotAnalysis,
} from '../../test/xcHistoryLibraryDelete/fixtures';

const PERMIT = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

declare const process: {
  version: string;
  env: Record<string, string | undefined>;
};
declare const __filename: string;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const FUZZ_SEEDS = envInt('XC_FUZZ_SEEDS', 400);
const FUZZ_OPS = envInt('XC_FUZZ_OPS', 40);
const RACE_SEEDS = envInt('XC_RACE_SEEDS', 300);
const REPLAY_SEED = process.env['XC_REPLAY_SEED'];

/** Artifact accumulator; flushed once per file in afterAll. */
const report: Record<string, unknown> = {
  file: __filename,
  node: process.version,
  startedAt: new Date().toISOString(),
  heapStartMb: heapUsedMb(),
  scale: { FUZZ_SEEDS, FUZZ_OPS, RACE_SEEDS },
  scenarios: {} as Record<string, unknown>,
};
const scenarios = report['scenarios'] as Record<string, unknown>;

function freshDb() {
  return getDb();
}

afterEach(() => {
  try {
    getDb().close();
  } catch {
    // Already closed by the scenario.
  }
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterAll(() => {
  report['finishedAt'] = new Date().toISOString();
  report['heapEndMb'] = heapUsedMb();
  report['sqliteEngine'] = sqliteEngine();
  report['artifact'] = writeArtifact('sqlite-consistency.json', report);
});

function transport(
  mode:
    | 'accept'
    | 'reject_permanent'
    | 'reject_transient'
    | 'throw_network'
    | 'throw_400'
    | 'unacknowledged'
    | 'accept_odd_reject_even',
): SyncTransport & { batches: unknown[][] } {
  const batches: unknown[][] = [];
  return {
    batches,
    async syncShots(shots) {
      batches.push(shots);
      const ids = shots.map(s => String((s as { id: string }).id));
      switch (mode) {
        case 'accept':
          return { acceptedIds: ids, rejected: [] };
        case 'reject_permanent':
          return {
            acceptedIds: [],
            rejected: ids.map(id => ({
              id,
              code: 'shot.id_conflict',
              message: 'conflict',
            })),
          };
        case 'reject_transient':
          return {
            acceptedIds: [],
            rejected: ids.map(id => ({
              id,
              code: SESSION_NOT_FOUND_REJECTION,
              message: 'session not on server yet',
            })),
          };
        case 'throw_network':
          throw new Error('network unreachable');
        case 'throw_400':
          throw new ApiError(400, 'validation.failed', 'bad payload');
        case 'unacknowledged':
          return { acceptedIds: [], rejected: [] };
        case 'accept_odd_reject_even':
          return {
            acceptedIds: ids.filter((_, i) => i % 2 === 1),
            rejected: ids
              .filter((_, i) => i % 2 === 0)
              .map(id => ({ id, code: 'shot.id_conflict', message: 'c' })),
          };
      }
    },
    async createSession() {
      throw new ApiError(400, 'session.invalid', 'session refused');
    },
    async finalizeSession() {},
  };
}

function expectNoGhosts(audit: GhostAudit, context: string) {
  if (audit.total !== 0) {
    throw new Error(`${context}: ghost rows ${JSON.stringify(audit)}`);
  }
}

describe('XC history/library/delete — real SQLite behind getDb()', () => {
  it('S1 the production migrations build the account-scoped schema on a real engine', async () => {
    freshDb();
    const driver = currentDriver();
    const pk = (table: string) =>
      driver
        .executeSync(`PRAGMA table_info(${table})`)
        .rows.filter(r => Number(r['pk']) > 0)
        .sort((a, b) => Number(a['pk']) - Number(b['pk']))
        .map(r => String(r['name']));
    const schema = Object.fromEntries(
      OWNER_TABLES.map(table => [table, pk(table)]),
    );
    scenarios['S1_schema'] = schema;
    expect(schema['local_shot']).toEqual(['owner_key', 'id']);
    expect(schema['local_capture']).toEqual(['owner_key', 'id']);
    expect(schema['local_analysis_record']).toEqual(['owner_key', 'id']);
    expect(schema['sync_receipt']).toEqual(['owner_key', 'kind', 'entity_id']);
    expect(schema['outbox']).toEqual(['id']);
    expect(schema['local_session']).toEqual(['owner_key', 'id']);
  });

  it('S2 local shot → queued → synced: the row survives sync, the outbox row does not, the receipt appears (Library keeps the read)', async () => {
    const db = freshDb();
    setActiveDataOwner(OWNER_A);
    const analysis = shotAnalysis({ id: seededUuid(mulberry32(2)) });
    await saveAnalysis(db, analysis, PERMIT);

    const before = snapshotOwner(currentDriver(), OWNER_A);
    expect(before.shotIds).toEqual([analysis.id]);
    expect(before.queuedShotIds).toEqual([analysis.id]);
    expect(before.receiptShotIds).toEqual([]);
    expect(await getShotOutboxStatus(db, analysis.id)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    expect(await hasShotSyncReceipt(db, analysis.id)).toBe(false);

    const result = await drainOutbox(db, transport('accept'));
    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });

    const after = snapshotOwner(currentDriver(), OWNER_A);
    expect(after.shotIds).toEqual([analysis.id]);
    expect(after.queuedShotIds).toEqual([]);
    expect(after.receiptShotIds).toEqual([analysis.id]);
    expect(await hasShotSyncReceipt(db, analysis.id)).toBe(true);
    expect(await getShotOutboxStatus(db, analysis.id)).toEqual({
      state: 'absent',
    });
    expect((await listShots(db, 100)).map(s => s.id)).toEqual([analysis.id]);
    expect((await getAnalysis(db, analysis.id))?.id).toBe(analysis.id);
    expectNoGhosts(auditGhosts(currentDriver()), 'S2');
    scenarios['S2_lifecycle'] = { before, after, drain: result };
  });

  it('S3 the ONLY deletion primitive is account-wide: purgeOwnerData removes every row of one owner and nothing of another (no ghost rows)', async () => {
    const db = freshDb();
    const driver = currentDriver();
    const rand = mulberry32(3);

    // Owner A: local-only, queued, synced, rejected, capture+record chain.
    setActiveDataOwner(OWNER_A);
    const local = shotAnalysis({
      id: seededUuid(rand),
      resultKind: 'low_confidence',
      overallScore: null,
    });
    await saveLocalOnlyAnalysis(db, local);
    const queued = shotAnalysis({ id: seededUuid(rand) });
    await saveAnalysis(db, queued, PERMIT);
    const synced = shotAnalysis({ id: seededUuid(rand) });
    await saveAnalysis(db, synced, PERMIT);
    // Drain accepts BOTH queued rows; re-queue `queued` afterwards so one
    // shot is receipted and another is still pending.
    await drainOutbox(db, transport('accept'));
    const pending = shotAnalysis({ id: seededUuid(rand) });
    await saveAnalysis(db, pending, PERMIT);
    const rejected = shotAnalysis({ id: seededUuid(rand) });
    await saveAnalysis(db, rejected, PERMIT);
    await drainOutbox(db, transport('reject_permanent'));
    const captureId = seededUuid(rand);
    await savePendingCapture(db, captureId, 'forehand_drive', capturedClip());
    const recorded = shotAnalysis({ id: seededUuid(rand) });
    await saveAnalysisRecord(
      db,
      analysisRecord(recorded.id, captureId, recorded),
    );
    await markCaptureAnalyzed(db, captureId);
    await saveAnalysis(db, recorded, PERMIT);
    await saveSession(db, {
      id: seededUuid(rand),
      mode: 'practice_set',
      shotType: 'dink',
      focusCheckpoint: null,
      startedAt: '2026-08-27T18:00:00.000Z',
    });
    await setKv(db, `profile:${OWNER_A}`, JSON.stringify({ level: 'club' }));

    // Owner B: an independent bucket that must be untouched.
    setActiveDataOwner(OWNER_B);
    const bShot = shotAnalysis({ id: seededUuid(rand) });
    await saveAnalysis(db, bShot, PERMIT);
    const bCapture = seededUuid(rand);
    await savePendingCapture(
      db,
      bCapture,
      'dink',
      capturedClip({ uri: 'file:///b.mov' }),
    );
    await setKv(db, `profile:${OWNER_B}`, JSON.stringify({ level: 'pro' }));

    const aBefore = snapshotOwner(driver, OWNER_A);
    const bBefore = snapshotOwner(driver, OWNER_B);
    const bRowsBefore = Object.fromEntries(
      OWNER_TABLES.map(t => [
        t,
        driver.dump(t).filter(r => r['owner_key'] === OWNER_B),
      ]),
    );
    expect(aBefore.counts.local_shot).toBe(6);
    // pending + rejected (both refused once), recorded, session.create
    expect(aBefore.counts.outbox).toBe(4);
    expect(aBefore.counts.sync_receipt).toBe(2);
    expect(aBefore.counts.local_capture).toBe(1);
    expect(aBefore.counts.local_analysis_record).toBe(1);
    expect(aBefore.counts.local_session).toBe(1);
    expect(aBefore.kvKeys).toEqual([`profile:${OWNER_A}`]);

    await purgeOwnerData(db, OWNER_A);

    const aAfter = snapshotOwner(driver, OWNER_A);
    const bAfter = snapshotOwner(driver, OWNER_B);
    const bRowsAfter = Object.fromEntries(
      OWNER_TABLES.map(t => [
        t,
        driver.dump(t).filter(r => r['owner_key'] === OWNER_B),
      ]),
    );
    for (const table of OWNER_TABLES) {
      expect(aAfter.counts[table]).toBe(0);
    }
    expect(aAfter.kvKeys).toEqual([]);
    expect(bAfter).toEqual(bBefore);
    expect(bRowsAfter).toEqual(bRowsBefore);
    const audit = auditGhosts(driver);
    expectNoGhosts(audit, 'S3 after purge');
    // Nothing of A is readable through the product API either.
    setActiveDataOwner(OWNER_A);
    expect(await listShots(db, 100)).toEqual([]);
    expect(await listPendingCaptures(db, 100)).toEqual([]);
    expect(await listCaptureHistory(db)).toEqual([]);
    expect(await getAnalysis(db, synced.id)).toBeNull();
    expect(await hasShotSyncReceipt(db, synced.id)).toBe(false);
    expect(await getShotOutboxStatus(db, pending.id)).toEqual({
      state: 'absent',
    });
    scenarios['S3_purge'] = { aBefore, aAfter, bBefore, bAfter, audit };
  });

  it('S4 purgeOwnerData is atomic: a failing DELETE rolls back so no table is half-purged', async () => {
    const db = freshDb();
    const driver = currentDriver();
    setActiveDataOwner(OWNER_A);
    const rand = mulberry32(4);
    for (let i = 0; i < 6; i++) {
      await saveAnalysis(db, randomShotAnalysis(rand, i), PERMIT);
    }
    await drainOutbox(db, transport('accept_odd_reject_even'));
    const before = snapshotOwner(driver, OWNER_A);
    expect(before.counts.local_shot).toBe(6);
    expect(before.counts.sync_receipt).toBe(3);
    expect(before.counts.outbox).toBe(3);

    // The 4th owner-scoped DELETE (outbox) fails at the driver.
    driver.failNext({
      match: 'DELETE FROM outbox WHERE owner_key',
      message: 'SQLITE_FULL: disk full',
    });
    await expect(purgeOwnerData(db, OWNER_A)).rejects.toThrow('SQLITE_FULL');
    const after = snapshotOwner(driver, OWNER_A);
    expect(after).toEqual(before);
    expect(driver.inTransaction()).toBe(false);
    expectNoGhosts(auditGhosts(driver), 'S4');
    scenarios['S4_purge_atomicity'] = {
      before,
      after,
      statements: driver.calls.slice(-12),
    };
  });

  it('S5 no per-shot deletion API exists in the repository surface (journey step "delete shot" cannot be executed by the product)', async () => {
    const exported = Object.keys(repository).sort();
    const deletionLike = exported.filter(name =>
      /delete|remove|discard|forget|trash|erase|unsave|clear/i.test(name),
    );
    const perShotDeletion = deletionLike.filter(name =>
      /shot|analysis|capture|clip|result|read/i.test(name),
    );
    scenarios['S5_repository_surface'] = {
      exported,
      deletionLike,
      perShotDeletion,
    };
    // `purgeOwnerData` (account-wide) is the only removal primitive; nothing
    // targets one shot / analysis / capture. This assertion documents the
    // gap that blocks the "delete shot (local + synced)" journey step; if a
    // per-shot delete is added, this test must be replaced by one that
    // exercises it against the outbox / receipt / record / capture tables.
    expect(deletionLike).toEqual([]);
    expect(perShotDeletion).toEqual([]);
    expect(exported).toContain('purgeOwnerData');
  });

  it('S6 saveAnalysis is atomic with its outbox row, but the scored-run write sequence (record → capture analyzed → saveAnalysis) is not: a failure inside saveAnalysis leaves a scored record with no Library row', async () => {
    const db = freshDb();
    const driver = currentDriver();
    setActiveDataOwner(OWNER_A);
    const rand = mulberry32(6);
    const captureId = seededUuid(rand);
    const scored = shotAnalysis({ id: seededUuid(rand) });
    await savePendingCapture(db, captureId, 'forehand_drive', capturedClip());

    // Same order as src/analysis/runCaptureAnalysis.ts lines 360-365.
    await saveAnalysisRecord(db, analysisRecord(scored.id, captureId, scored));
    await markCaptureAnalyzed(db, captureId);
    driver.failNext({
      match: 'INSERT INTO outbox',
      message: 'SQLITE_FULL: outbox insert failed',
    });
    await expect(saveAnalysis(db, scored, PERMIT)).rejects.toThrow(
      'SQLITE_FULL',
    );

    const snap = snapshotOwner(driver, OWNER_A);
    const audit = auditGhosts(driver);
    const evidence = await loadStrokeResultEvidence(db, scored.id);
    scenarios['S6_non_atomic_scored_write'] = {
      snapshot: snap,
      audit,
      libraryRows: (await listShots(db, 100)).map(s => s.id),
      pendingCaptures: (await listPendingCaptures(db, 100)).map(c => c.id),
      captureHistory: (await listCaptureHistory(db)).map(c => ({
        id: c.id,
        status: c.status,
      })),
      resultRouteAnalysisId: evidence.analysis?.id ?? null,
      resultRouteRecordResultId: evidence.record?.result?.id ?? null,
      statements: driver.calls.slice(-8),
    };
    // saveAnalysis itself rolled back cleanly: no shot, no outbox row.
    expect(snap.shotIds).toEqual([]);
    expect(snap.queuedShotIds).toEqual([]);
    expect(driver.inTransaction()).toBe(false);
    // ...but the earlier autocommitted writes stand: a scored record for a
    // capture already marked analyzed, invisible to Library (listShots) while
    // still openable through the Result route via record.result.
    expect(snap.recordIds).toEqual([scored.id]);
    expect(await listShots(db, 100)).toEqual([]);
    expect(await listPendingCaptures(db, 100)).toEqual([]);
    expect(audit.scoredRecordWithoutShot).toEqual([
      { owner: OWNER_A, recordId: scored.id },
    ]);
    expect(evidence.analysis).toBeNull();
    expect(evidence.record?.result?.id).toBe(scored.id);
  });

  it('S7 sync receipt transaction failure after server acceptance leaves the row queued (never a receipt without an outbox delete) and the next drain converges', async () => {
    const db = freshDb();
    const driver = currentDriver();
    setActiveDataOwner(OWNER_A);
    const rand = mulberry32(7);
    const shots = [0, 1, 2].map(i => randomShotAnalysis(rand, i));
    for (const shot of shots) {
      await saveAnalysis(
        db,
        { ...shot, resultKind: 'scored', overallScore: 6 },
        PERMIT,
      );
    }
    driver.failNext({
      match: 'DELETE FROM outbox WHERE owner_key = ? AND id = ?',
      message: 'SQLITE_BUSY: outbox delete',
    });
    const first = transport('accept');
    // The receipt transaction's failure is swallowed by the outer
    // `catch` around the whole accepted loop (sync.ts:259-265): the LOCAL
    // SQLite error is recorded as a transient sync failure against every
    // entry the server had just accepted, and the drain resolves.
    const firstResult = await drainOutbox(db, first);
    expect(firstResult).toEqual({ synced: 0, failed: 3, remaining: 3 });
    const mid = snapshotOwner(driver, OWNER_A);
    const midAudit = auditGhosts(driver);
    const midRows = driver.executeSync(
      `SELECT attempts, last_error FROM outbox WHERE owner_key = ? ORDER BY id`,
      [OWNER_A],
    ).rows;
    // The first accepted entry's transaction rolled back: no receipt, all
    // three rows still queued with attempts intact (transient), last_error
    // carrying the local error text.
    expect(mid.receiptShotIds).toEqual([]);
    expect(mid.queuedShotIds).toHaveLength(3);
    expect(midRows.map(r => Number(r['attempts']))).toEqual([0, 0, 0]);
    expect(
      midRows.every(r => String(r['last_error']).includes('SQLITE_BUSY')),
    ).toBe(true);
    for (const shot of shots) {
      expect(await getShotOutboxStatus(db, shot.id)).toEqual({
        state: 'queued',
        attempts: 0,
        lastError: 'Error: SQLITE_BUSY: outbox delete',
      });
    }
    expect(driver.inTransaction()).toBe(false);
    expectNoGhosts(midAudit, 'S7 mid');

    const second = transport('accept');
    const result = await drainOutbox(db, second);
    const after = snapshotOwner(driver, OWNER_A);
    expect(result).toEqual({ synced: 3, failed: 0, remaining: 0 });
    expect(after.receiptShotIds).toEqual([...shots.map(s => s.id)].sort());
    expect(after.queuedShotIds).toEqual([]);
    // Every shot was re-sent (server-side replay is idempotent per
    // apply_synced_shot: "this user already owns the row" → accepted).
    expect(second.batches[0]).toHaveLength(3);
    expectNoGhosts(auditGhosts(driver), 'S7 after');
    scenarios['S7_receipt_txn_failure'] = {
      firstResult,
      midRows,
      mid,
      after,
      result,
    };
  });

  it('S8 stale entry after server mismatch: an exhausted shot stays in Library and in the outbox forever; a synced shot the server later loses is never reconciled', async () => {
    const db = freshDb();
    const driver = currentDriver();
    setActiveDataOwner(OWNER_A);
    const rand = mulberry32(8);
    const refused = randomShotAnalysis(rand, 0);
    await saveAnalysis(
      db,
      { ...refused, resultKind: 'scored', overallScore: 5 },
      PERMIT,
    );
    const drains: Array<{ synced: number; failed: number; remaining: number }> =
      [];
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 3; i++) {
      drains.push(await drainOutbox(db, transport('reject_permanent')));
    }
    const status = await getShotOutboxStatus(db, refused.id);
    expect(status).toEqual({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: 'shot.id_conflict: conflict',
    });
    // Drains 9..11 no longer send it (attempts < 8 filter) yet report it as
    // remaining, so the Library keeps a row the server has refused for good.
    expect(
      drains
        .slice(OUTBOX_MAX_ATTEMPTS)
        .every(d => d.synced === 0 && d.failed === 0 && d.remaining === 1),
    ).toBe(true);
    expect((await listShots(db, 100)).map(s => s.id)).toEqual([refused.id]);

    // Synced shot: receipt held locally; the server "loses" it (account
    // purge on another device, restore, etc.). There is no pull / reconcile
    // path: the local receipt is the last word.
    const synced = randomShotAnalysis(rand, 1);
    await saveAnalysis(
      db,
      { ...synced, resultKind: 'scored', overallScore: 7 },
      PERMIT,
    );
    await drainOutbox(db, transport('accept'));
    expect(await hasShotSyncReceipt(db, synced.id)).toBe(true);
    const verifyTransport = transport('reject_permanent');
    await drainOutbox(db, verifyTransport);
    expect(verifyTransport.batches).toEqual([]);
    expect(await hasShotSyncReceipt(db, synced.id)).toBe(true);
    expectNoGhosts(auditGhosts(driver), 'S8');
    scenarios['S8_stale_after_mismatch'] = {
      drains,
      exhaustedStatus: status,
      libraryStillLists: [refused.id, synced.id],
      syncedReceiptSurvivesServerLoss: true,
    };
  });

  it('S9 head-of-line starvation: 50 transient-failing rows fill the drain window and newer shots are never sent', async () => {
    const db = freshDb();
    const driver = currentDriver();
    setActiveDataOwner(OWNER_A);
    const rand = mulberry32(9);
    const blocked: string[] = [];
    for (let i = 0; i < 50; i++) {
      const shot = randomShotAnalysis(rand, i);
      blocked.push(shot.id);
      await saveAnalysis(
        db,
        { ...shot, resultKind: 'scored', overallScore: 6 },
        PERMIT,
      );
    }
    const fresh = randomShotAnalysis(rand, 99);
    await saveAnalysis(
      db,
      { ...fresh, resultKind: 'scored', overallScore: 8 },
      PERMIT,
    );

    const seen = new Set<string>();
    const drains: Array<{ synced: number; failed: number; remaining: number }> =
      [];
    for (let round = 0; round < 12; round++) {
      const t = transport('reject_transient');
      drains.push(await drainOutbox(db, t));
      for (const batch of t.batches) {
        for (const item of batch) seen.add(String((item as { id: string }).id));
      }
    }
    const freshStatus = await getShotOutboxStatus(db, fresh.id);
    scenarios['S9_head_of_line_starvation'] = {
      drains,
      freshShotEverSent: seen.has(fresh.id),
      freshStatus,
      blockedAttemptsAfter12Rounds: driver.executeSync(
        `SELECT MIN(attempts) AS lo, MAX(attempts) AS hi FROM outbox WHERE owner_key = ?`,
        [OWNER_A],
      ).rows[0],
    };
    expect(seen.size).toBe(50);
    expect(seen.has(fresh.id)).toBe(false);
    expect(freshStatus).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    expect(drains.every(d => d.remaining === 51 && d.failed === 50)).toBe(true);
  });

  it('S10 signed-out owner cannot write and reads nothing; guest and account buckets never leak into each other', async () => {
    const db = freshDb();
    const driver = currentDriver();
    const rand = mulberry32(10);
    setActiveDataOwner(GUEST_DATA_OWNER);
    const guestShot = randomShotAnalysis(rand, 0);
    await saveLocalOnlyAnalysis(db, {
      ...guestShot,
      resultKind: 'low_confidence',
      overallScore: null,
    });
    setActiveDataOwner(OWNER_A);
    const aShot = randomShotAnalysis(rand, 1);
    await saveAnalysis(
      db,
      { ...aShot, resultKind: 'scored', overallScore: 6 },
      PERMIT,
    );
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await expect(
      saveAnalysis(db, randomShotAnalysis(rand, 2), PERMIT),
    ).rejects.toThrow();
    await expect(
      savePendingCapture(db, seededUuid(rand), 'dink', capturedClip()),
    ).rejects.toThrow();
    expect(await listShots(db, 100)).toEqual([]);
    expect(await getAnalysis(db, aShot.id)).toBeNull();
    expect(await getAnalysis(db, guestShot.id)).toBeNull();
    setActiveDataOwner(OWNER_A);
    expect((await listShots(db, 100)).map(s => s.id)).toEqual([aShot.id]);
    setActiveDataOwner(GUEST_DATA_OWNER);
    expect((await listShots(db, 100)).map(s => s.id)).toEqual([guestShot.id]);
    expect(driver.count('local_shot')).toBe(2);
    expectNoGhosts(auditGhosts(driver), 'S10');
    scenarios['S10_owner_isolation'] = {
      guest: snapshotOwner(driver, GUEST_DATA_OWNER),
      a: snapshotOwner(driver, OWNER_A),
      signedOut: snapshotOwner(driver, SIGNED_OUT_DATA_OWNER),
    };
  });

  it('S11 missing media: the Result route reports a clip only while the capture row is present and sized; a purged/absent capture yields clip=null with the analysis intact', async () => {
    const db = freshDb();
    const driver = currentDriver();
    setActiveDataOwner(OWNER_A);
    const rand = mulberry32(11);
    const captureId = seededUuid(rand);
    const scored = shotAnalysis({ id: seededUuid(rand) });
    await savePendingCapture(
      db,
      captureId,
      'forehand_drive',
      capturedClip({ uri: 'file:///private/captures/gone.mov' }),
    );
    await saveAnalysisRecord(db, analysisRecord(scored.id, captureId, scored));
    await markCaptureAnalyzed(db, captureId);
    await saveAnalysis(db, scored, PERMIT);

    const withMedia = await loadStrokeResultEvidence(db, scored.id);
    expect(withMedia.clip?.uri).toBe('file:///private/captures/gone.mov');
    expect(withMedia.review?.poseSequence).toBeNull();

    // A zero-duration capture row (import that never probed) is not a clip.
    driver.executeSync(
      `UPDATE local_capture SET duration_ms = 0 WHERE owner_key = ? AND id = ?`,
      [OWNER_A, captureId],
    );
    const zeroDuration = await loadStrokeResultEvidence(db, scored.id);
    expect(zeroDuration.clip).toBeNull();
    expect(zeroDuration.review).not.toBeNull();
    expect(zeroDuration.analysis?.id).toBe(scored.id);

    // The capture row disappears (there is no product path for this; it
    // models a manual/native cleanup that only removed the row).
    driver.executeSync(
      `DELETE FROM local_capture WHERE owner_key = ? AND id = ?`,
      [OWNER_A, captureId],
    );
    const noCapture = await loadStrokeResultEvidence(db, scored.id);
    expect(noCapture.clip).toBeNull();
    expect(noCapture.review).toBeNull();
    expect(noCapture.analysis?.id).toBe(scored.id);
    expect(noCapture.record?.captureId).toBe(captureId);
    const audit = auditGhosts(driver);
    expect(audit.recordWithoutCapture).toEqual([
      { owner: OWNER_A, recordId: scored.id },
    ]);
    scenarios['S11_missing_media'] = {
      withMedia: { clip: withMedia.clip, review: withMedia.review },
      zeroDuration: { clip: zeroDuration.clip, review: zeroDuration.review },
      noCapture: { clip: noCapture.clip, review: noCapture.review },
      audit,
    };
  });

  it('S12 missing result: an id with no shot and no record loads as an honest empty evidence set', async () => {
    const db = freshDb();
    setActiveDataOwner(OWNER_A);
    const evidence = await loadStrokeResultEvidence(
      db,
      seededUuid(mulberry32(12)),
    );
    expect(evidence).toEqual({
      analysis: null,
      record: null,
      clip: null,
      review: null,
      attempts: [],
    });
    scenarios['S12_missing_result'] = evidence;
  });

  it(`S13 seeded model-based fuzz (${FUZZ_SEEDS} seeds × ${FUZZ_OPS} ops): SQLite state equals the reference model after every operation, zero ghost rows`, async () => {
    type ShotModel = {
      localOnly: boolean;
      queued: number[]; // attempts per queued outbox row, in id order
      receipt: boolean;
    };
    type OwnerModel = Map<string, ShotModel>;
    const OWNERS = [OWNER_A, OWNER_B, GUEST_DATA_OWNER] as const;
    const OPS = [
      'save_scored',
      'save_scored',
      'save_local_only',
      'save_chain',
      'drain_accept',
      'drain_accept',
      'drain_reject_permanent',
      'drain_reject_transient',
      'drain_throw_network',
      'drain_throw_400',
      'drain_unacknowledged',
      'drain_partial',
      'switch_owner',
      'switch_owner',
      'purge_owner',
      'purge_other_owner',
    ] as const;
    type Op = (typeof OPS)[number];

    const failures: unknown[] = [];
    const opCounts: Record<string, number> = {};
    const seeds = REPLAY_SEED
      ? [Number(REPLAY_SEED)]
      : Array.from({ length: FUZZ_SEEDS }, (_, i) => 1000 + i);
    const heapBefore = heapUsedMb();
    const started = Date.now();
    let opsExecuted = 0;
    let maxShotsPerOwner = 0;

    for (const seed of seeds) {
      const rand = mulberry32(seed);
      const db = getDb();
      const driver = currentDriver();
      const model = new Map<string, OwnerModel>(
        OWNERS.map(o => [o, new Map()]),
      );
      const opLog: Array<{
        i: number;
        op: Op;
        owner: string;
        detail?: unknown;
      }> = [];
      let active: (typeof OWNERS)[number] = OWNER_A;
      setActiveDataOwner(active);
      let counter = 0;

      const expectedFor = (
        owner: string,
      ): Pick<OwnerSnapshot, 'shotIds' | 'queuedShotIds' | 'receiptShotIds'> & {
        attempts: number[];
      } => {
        const shots = model.get(owner)!;
        const shotIds = [...shots.keys()].sort();
        const queuedShotIds = [...shots.entries()]
          .flatMap(([id, s]) => s.queued.map(() => id))
          .sort();
        const receiptShotIds = [...shots.entries()]
          .filter(([, s]) => s.receipt)
          .map(([id]) => id)
          .sort();
        const attempts = [...shots.values()]
          .flatMap(s => s.queued)
          .sort((a, b) => a - b);
        return { shotIds, queuedShotIds, receiptShotIds, attempts };
      };
      const actualFor = (owner: string) => {
        const snap = snapshotOwner(driver, owner);
        const attempts = driver
          .executeSync(
            `SELECT attempts FROM outbox WHERE owner_key = ? AND kind = 'shot.sync'`,
            [owner],
          )
          .rows.map(r => Number(r['attempts']))
          .sort((a, b) => a - b);
        return {
          shotIds: snap.shotIds,
          queuedShotIds: snap.queuedShotIds,
          receiptShotIds: snap.receiptShotIds,
          attempts,
        };
      };

      /** Reference drain: mirrors sync.ts (attempts < 8, id order, LIMIT 50). */
      const modelDrain = (owner: string, mode: Op) => {
        const shots = model.get(owner)!;
        // Rows in id order: reconstruct from the DB's actual ids to keep the
        // model's ordering honest (ids are autoincrement; the model tracks
        // attempts per row, not ids).
        const rows = driver
          .executeSync(
            `SELECT id, json_extract(payload, '$.id') AS shotId, attempts FROM outbox
             WHERE owner_key = ? AND kind = 'shot.sync' AND attempts < ? ORDER BY id ASC LIMIT 50`,
            [owner, OUTBOX_MAX_ATTEMPTS],
          )
          .rows.map(r => ({
            shotId: String(r['shotId']),
            attempts: Number(r['attempts']),
          }));
        rows.forEach((row, index) => {
          const shot = shots.get(row.shotId)!;
          const queuedIndex = shot.queued.indexOf(row.attempts);
          const accept =
            mode === 'drain_accept' ||
            (mode === 'drain_partial' && index % 2 === 1);
          const permanent =
            mode === 'drain_reject_permanent' ||
            mode === 'drain_throw_400' ||
            mode === 'drain_unacknowledged' ||
            (mode === 'drain_partial' && index % 2 === 0);
          if (accept) {
            shot.queued.splice(queuedIndex, 1);
            shot.receipt = true;
          } else if (permanent) {
            shot.queued[queuedIndex] = row.attempts + 1;
          }
          // transient: attempts unchanged
        });
      };

      for (let i = 0; i < FUZZ_OPS; i++) {
        const op = pick(rand, OPS);
        opCounts[op] = (opCounts[op] ?? 0) + 1;
        const entry: { i: number; op: Op; owner: string; detail?: unknown } = {
          i,
          op,
          owner: active,
        };
        opLog.push(entry);
        opsExecuted++;
        try {
          switch (op) {
            case 'save_scored': {
              const shot = {
                ...randomShotAnalysis(rand, counter++),
                resultKind: 'scored' as const,
                overallScore: 6.5,
              };
              entry.detail = shot.id;
              await saveAnalysis(db, shot, PERMIT);
              const shots = model.get(active)!;
              const prior = shots.get(shot.id) ?? {
                localOnly: false,
                queued: [],
                receipt: false,
              };
              prior.localOnly = false;
              prior.queued.push(0);
              shots.set(shot.id, prior);
              break;
            }
            case 'save_local_only': {
              const shot = {
                ...randomShotAnalysis(rand, counter++),
                resultKind: 'low_confidence' as const,
                overallScore: null,
              };
              entry.detail = shot.id;
              await saveLocalOnlyAnalysis(db, shot);
              model
                .get(active)!
                .set(shot.id, { localOnly: true, queued: [], receipt: false });
              break;
            }
            case 'save_chain': {
              const captureId = seededUuid(rand);
              const shot = {
                ...randomShotAnalysis(rand, counter++),
                resultKind: 'scored' as const,
                overallScore: 7.1,
              };
              entry.detail = { captureId, shotId: shot.id };
              await savePendingCapture(
                db,
                captureId,
                shot.shotType,
                capturedClip({ uri: `file:///c/${captureId}.mov` }),
              );
              await saveAnalysisRecord(
                db,
                analysisRecord(shot.id, captureId, shot),
              );
              await markCaptureAnalyzed(db, captureId);
              await saveAnalysis(db, shot, PERMIT);
              model.get(active)!.set(shot.id, {
                localOnly: false,
                queued: [0],
                receipt: false,
              });
              break;
            }
            case 'drain_accept':
            case 'drain_reject_permanent':
            case 'drain_reject_transient':
            case 'drain_throw_network':
            case 'drain_throw_400':
            case 'drain_unacknowledged':
            case 'drain_partial': {
              const mode = {
                drain_accept: 'accept',
                drain_reject_permanent: 'reject_permanent',
                drain_reject_transient: 'reject_transient',
                drain_throw_network: 'throw_network',
                drain_throw_400: 'throw_400',
                drain_unacknowledged: 'unacknowledged',
                drain_partial: 'accept_odd_reject_even',
              } as const;
              modelDrain(active, op);
              entry.detail = await drainOutbox(db, transport(mode[op]));
              break;
            }
            case 'switch_owner': {
              active = pick(rand, OWNERS);
              setActiveDataOwner(active);
              entry.owner = active;
              break;
            }
            case 'purge_owner': {
              await purgeOwnerData(db, active);
              model.set(active, new Map());
              break;
            }
            case 'purge_other_owner': {
              const other = pick(
                rand,
                OWNERS.filter(o => o !== active),
              );
              entry.detail = other;
              await purgeOwnerData(db, other);
              model.set(other, new Map());
              break;
            }
          }
          for (const owner of OWNERS) {
            const expected = expectedFor(owner);
            const actual = actualFor(owner);
            if (JSON.stringify(expected) !== JSON.stringify(actual)) {
              failures.push({
                seed,
                opIndex: i,
                owner,
                expected,
                actual,
                opLog,
              });
              break;
            }
            maxShotsPerOwner = Math.max(
              maxShotsPerOwner,
              expected.shotIds.length,
            );
          }
          const audit = auditGhosts(driver);
          // scoredRecordWithoutShot is legal here only if the shot was purged
          // together with its record (purge removes both) — so any hit is a ghost.
          if (audit.total !== 0) {
            failures.push({ seed, opIndex: i, ghost: audit, opLog });
          }
        } catch (error) {
          failures.push({ seed, opIndex: i, error: String(error), opLog });
          break;
        }
        expect(getActiveDataOwner()).toBe(active);
      }
      db.close();
      if (failures.length > 25) break;
    }

    const summary = {
      seeds: seeds.length,
      opsPerSeed: FUZZ_OPS,
      opsExecuted,
      opCounts,
      maxShotsPerOwner,
      elapsedMs: Date.now() - started,
      heapBeforeMb: heapBefore,
      heapAfterMb: heapUsedMb(),
      failures,
      replay:
        'XC_REPLAY_SEED=<seed> npx jest __tests__/xc/historyLibraryDelete.sqliteConsistency.test.ts -t S13',
    };
    scenarios['S13_model_fuzz'] = summary;
    writeArtifact('sqlite-consistency.fuzz.json', summary);
    expect(failures).toEqual([]);
  }, 600_000);

  it(`S14 seeded interleaving fuzz (${RACE_SEEDS} seeds): saveAnalysis racing drainOutbox on ONE connection — outcome matrix`, async () => {
    // Both transactions issue BEGIN IMMEDIATE on the same connection, which
    // is how getDb() hands the database to the analysis pipeline and to the
    // 30-second sync timer (syncRuntime.ts). op-sqlite executes statements
    // asynchronously, so their statements CAN interleave. The matrix below
    // records what each interleaving does to durability.
    type Outcome = {
      saveThrew: string | null;
      drainThrew: string | null;
      newShotPersisted: boolean;
      newShotQueued: boolean;
      newShotReceipt: boolean;
      oldShotReceipt: boolean;
      oldShotStillQueued: boolean;
      ghosts: number;
      leftTransactionOpen: boolean;
      serverAcceptedIds: string[];
      outboxErrors: string[];
      drainResult: unknown;
      delays: { save: number; drain: number };
    };
    const matrix = new Map<
      string,
      { count: number; seeds: number[]; sample: Outcome }
    >();
    const seeds = REPLAY_SEED
      ? [Number(REPLAY_SEED)]
      : Array.from({ length: RACE_SEEDS }, (_, i) => 5000 + i);
    const started = Date.now();
    for (const seed of seeds) {
      const rand = mulberry32(seed);
      const db = getDb();
      const driver = currentDriver();
      setActiveDataOwner(OWNER_A);
      const old = {
        ...randomShotAnalysis(rand, 0),
        resultKind: 'scored' as const,
        overallScore: 5,
      };
      await saveAnalysis(db, old, PERMIT);
      const fresh = {
        ...randomShotAnalysis(rand, 1),
        resultKind: 'scored' as const,
        overallScore: 6,
      };
      driver.jitter = () => Math.floor(rand() * 8);
      const saveDelay = Math.floor(rand() * 12);
      const drainDelay = Math.floor(rand() * 12);
      const delayed = async <T>(hops: number, run: () => Promise<T>) => {
        for (let i = 0; i < hops; i++) await Promise.resolve();
        return run();
      };
      const drainTransport = transport('accept');
      const [saveResult, drainResult] = await Promise.allSettled([
        delayed(saveDelay, () => saveAnalysis(db, fresh, PERMIT)),
        delayed(drainDelay, () => drainOutbox(db, drainTransport)),
      ]);
      driver.jitter = null;
      const leftTransactionOpen = driver.inTransaction();
      if (leftTransactionOpen) {
        driver.executeSync('ROLLBACK');
      }
      const snap = snapshotOwner(driver, OWNER_A);
      const outcome: Outcome = {
        saveThrew:
          saveResult.status === 'rejected' ? String(saveResult.reason) : null,
        drainThrew:
          drainResult.status === 'rejected' ? String(drainResult.reason) : null,
        newShotPersisted: snap.shotIds.includes(fresh.id),
        newShotQueued: snap.queuedShotIds.includes(fresh.id),
        newShotReceipt: snap.receiptShotIds.includes(fresh.id),
        oldShotReceipt: snap.receiptShotIds.includes(old.id),
        oldShotStillQueued: snap.queuedShotIds.includes(old.id),
        ghosts: auditGhosts(driver).total,
        leftTransactionOpen,
        serverAcceptedIds: drainTransport.batches.flatMap(batch =>
          batch.map(item => String((item as { id: string }).id)),
        ),
        outboxErrors: driver
          .executeSync(
            `SELECT last_error FROM outbox WHERE owner_key = ? ORDER BY id`,
            [OWNER_A],
          )
          .rows.map(r => String(r['last_error'])),
        drainResult:
          drainResult.status === 'fulfilled' ? drainResult.value : null,
        delays: { save: saveDelay, drain: drainDelay },
      };
      const key = JSON.stringify({
        leftTransactionOpen,
        saveThrew: outcome.saveThrew !== null,
        drainThrew: outcome.drainThrew !== null,
        newShotPersisted: outcome.newShotPersisted,
        newShotQueued: outcome.newShotQueued,
        newShotReceipt: outcome.newShotReceipt,
        oldShotReceipt: outcome.oldShotReceipt,
        oldShotStillQueued: outcome.oldShotStillQueued,
        ghosts: outcome.ghosts,
      });
      const cell = matrix.get(key) ?? { count: 0, seeds: [], sample: outcome };
      cell.count++;
      if (cell.seeds.length < 5) cell.seeds.push(seed);
      matrix.set(key, cell);
      db.close();
    }
    const rows = [...matrix.entries()].map(([key, cell]) => ({
      ...JSON.parse(key),
      count: cell.count,
      seeds: cell.seeds,
      sample: cell.sample,
    }));
    const scoredSaveRejectedByConcurrentSync = rows
      .filter(r => r.saveThrew && !r.newShotPersisted)
      .reduce((n, r) => n + r.count, 0);
    const serverAcceptedButLocallyUnreceipted = rows
      .filter(r => r.oldShotStillQueued && !r.oldShotReceipt)
      .reduce((n, r) => n + r.count, 0);
    const summary = {
      seeds: seeds.length,
      elapsedMs: Date.now() - started,
      heapMb: heapUsedMb(),
      scoredSaveRejectedByConcurrentSync,
      serverAcceptedButLocallyUnreceipted,
      matrix: rows,
      replay:
        'XC_REPLAY_SEED=<seed> npx jest __tests__/xc/historyLibraryDelete.sqliteConsistency.test.ts -t S14',
    };
    scenarios['S14_race_matrix'] = summary;
    writeArtifact('sqlite-consistency.race.json', summary);

    // Durability contract regardless of interleaving: the NEW scored shot
    // must either be fully persisted (row + outbox row or receipt) or the
    // caller must have been told it failed; the OLD shot must never end up
    // with neither a receipt nor an outbox row; nothing may leave the
    // connection mid-transaction. (The cases where the caller IS told it
    // failed — `scoredSaveRejectedByConcurrentSync` — are pinned by S15.)
    const lostSilently = rows.filter(
      r =>
        !r.saveThrew &&
        !(r.newShotPersisted && (r.newShotQueued || r.newShotReceipt)),
    );
    const oldShotDropped = rows.filter(
      r => !r.oldShotReceipt && !r.oldShotStillQueued,
    );
    const ghosts = rows.filter(r => r.ghosts > 0);
    const openTxn = rows.filter(r => r.leftTransactionOpen);
    expect(openTxn).toEqual([]);
    expect(ghosts).toEqual([]);
    expect(oldShotDropped).toEqual([]);
    expect(lostSilently).toEqual([]);
  }, 600_000);

  it('S15 characterization: a scored saveAnalysis that starts inside the sync receipt transaction fails with "cannot start a transaction within a transaction" and leaves an orphan scored record (no Library row, no outbox row)', async () => {
    const db = freshDb();
    const driver = currentDriver();
    setActiveDataOwner(OWNER_A);
    const rand = mulberry32(15);
    const old = {
      ...randomShotAnalysis(rand, 0),
      resultKind: 'scored' as const,
      overallScore: 5,
    };
    await saveAnalysis(db, old, PERMIT);

    // The same write order as runCaptureAnalysis.ts:360-365 for a new
    // scored run whose saveAnalysis lands while the 30 s sync timer
    // (syncRuntime.ts) is inside its receipt transaction for `old`.
    const captureId = seededUuid(rand);
    const fresh = {
      ...randomShotAnalysis(rand, 1),
      resultKind: 'scored' as const,
      overallScore: 6,
    };
    await savePendingCapture(
      db,
      captureId,
      fresh.shotType,
      capturedClip({ uri: `file:///c/${captureId}.mov` }),
    );
    await saveAnalysisRecord(db, analysisRecord(fresh.id, captureId, fresh));
    await markCaptureAnalyzed(db, captureId);

    const seqBefore = driver.statementCount;
    const drain = drainOutbox(db, transport('accept'));
    // Wait (microtask by microtask) until the drain has opened its receipt
    // transaction, then start the scored save on the same connection.
    for (let hops = 0; hops < 200; hops++) {
      await Promise.resolve();
      if (
        driver.calls.some(
          c =>
            c.seq > seqBefore &&
            c.sql === 'BEGIN IMMEDIATE' &&
            c.outcome === 'ok',
        )
      ) {
        break;
      }
    }
    expect(driver.inTransaction()).toBe(true);
    const save = saveAnalysis(db, fresh, PERMIT);
    const [saveResult, drainResult] = await Promise.allSettled([save, drain]);

    const snap = snapshotOwner(driver, OWNER_A);
    const audit = auditGhosts(driver);
    const evidence = await loadStrokeResultEvidence(db, fresh.id);
    scenarios['S15_scored_save_inside_sync_txn'] = {
      saveResult:
        saveResult.status === 'rejected'
          ? { status: 'rejected', reason: String(saveResult.reason) }
          : saveResult,
      drainResult,
      snapshot: snap,
      audit,
      libraryRows: (await listShots(db, 100)).map(s => s.id),
      resultRouteAnalysisId: evidence.analysis?.id ?? null,
      resultRouteRecordResultId: evidence.record?.result?.id ?? null,
      statements: driver.calls.filter(c => c.seq > seqBefore),
    };
    expect(saveResult.status).toBe('rejected');
    expect(String((saveResult as PromiseRejectedResult).reason)).toContain(
      'cannot start a transaction within a transaction',
    );
    expect(drainResult).toEqual({
      status: 'fulfilled',
      value: { synced: 1, failed: 0, remaining: 0 },
    });
    expect(driver.inTransaction()).toBe(false);
    // Old shot fully synced; new scored shot absent from Library and the
    // outbox while its scored record and analyzed capture remain.
    expect(snap.receiptShotIds).toEqual([old.id]);
    expect(snap.shotIds).toEqual([old.id]);
    expect(snap.queuedShotIds).toEqual([]);
    expect(snap.recordIds).toEqual([fresh.id]);
    expect(audit.scoredRecordWithoutShot).toEqual([
      { owner: OWNER_A, recordId: fresh.id },
    ]);
    expect((await listShots(db, 100)).map(s => s.id)).toEqual([old.id]);
    expect(evidence.analysis).toBeNull();
    expect(evidence.record?.result?.id).toBe(fresh.id);
  });
});
