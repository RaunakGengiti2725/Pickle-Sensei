/**
 * ATTACK S6 / S7 / S9 — repository + db.ts against a persistent real SQLite.
 *
 * The op-sqlite mock here models the DEVICE FILE: one node:sqlite engine
 * survives `close()`, so `getDb().close(); getDb()` re-runs the production
 * LOCAL_MIGRATIONS + ensureAccountScopedSchema over the existing data exactly
 * like an app relaunch does (db.ts:251-267 runs every migration on every
 * open).
 *
 *  S6  activeOwner = A, purgeOwnerData(B): only B's rows/kv go; A survives.
 *  S7  one corrupt shot.sync payload for the active owner:
 *      getShotOutboxStatus throws (json_extract on malformed text) instead
 *      of returning `absent` — and the same expression in migration
 *      db.ts:95 makes every relaunch's getDb() throw.
 *  S9  saveSession, relaunch before finishSession: the incomplete session
 *      row is deleted by db.ts:97-99 while its session.create outbox row
 *      remains (and finishSession later queues a finalize for a row that no
 *      longer exists locally).
 */
import type { LocalDb } from '../../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { practiceSetKeyForOwner } from '../../../src/analysis/practiceSet';
import { consistencyKeyForOwner } from '../../../src/consistency/store';
import { notificationPrefsKeyForOwner } from '../../../src/notifications/types';
import { rankCelebrationKeyForOwner } from '../../../src/progress/rankCelebration';
import {
  OWNER_SCOPED_KV_NAMESPACES,
  finishSession,
  getKv,
  getShotOutboxStatus,
  purgeOwnerData,
  saveAnalysis,
  saveAnalysisRecord,
  savePendingCapture,
  saveSession,
  setKv,
} from '../../../src/data/repository';
import { drainOutbox } from '../../../src/data/sync';
import {
  OWNER_A,
  OWNER_B,
  PERMIT_ID,
  SHOT_ID,
  capturedClip,
  realAnalysis,
} from '../../../testing/attack/mobileDataSyncFixtures';
import {
  SESSION_S,
  countRows,
  loadRealGetDb,
  outboxRows,
  uuidAt,
} from '../../../testing/attack/mobileDataSync4Harness';
import { openNodeSqlite } from '../../../testing/attack/nodeSqliteOpAdapter';

// Device-file semantics: the engine outlives close(); `destroy` ends the test.
const mockPersistentFile = (() => {
  let handle: ReturnType<typeof openNodeSqlite> | null = null;
  return {
    open() {
      if (!handle) handle = openNodeSqlite();
      const h = handle;
      return {
        executeSync: (sql: string, params?: unknown[]) =>
          h.executeSync(sql, params),
        execute: (sql: string, params?: unknown[]) => h.execute(sql, params),
        close() {},
      };
    },
    destroy() {
      handle?.close();
      handle = null;
    },
  };
})();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => mockPersistentFile.open(),
}));

const KEY_BUILDERS: Record<
  (typeof OWNER_SCOPED_KV_NAMESPACES)[number],
  (owner: string) => string
> = {
  profile: profileKeyForOwner,
  'rank.celebrated': rankCelebrationKeyForOwner,
  notifications: notificationPrefsKeyForOwner,
  consistency: consistencyKeyForOwner,
  'practice.set': practiceSetKeyForOwner,
};

async function seedOwner(db: LocalDb, owner: string, tag: number) {
  setActiveDataOwner(owner);
  await saveAnalysis(
    db,
    { ...realAnalysis, id: uuidAt(tag, 1), sessionId: uuidAt(tag, 0x5e) },
    uuidAt(tag, 0x9e),
  );
  await saveSession(db, {
    id: uuidAt(tag, 0x5e),
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-27T18:00:00.000Z',
  });
  await savePendingCapture(db, uuidAt(tag, 0xca), 'forehand_drive', {
    ...capturedClip,
    uri: `file:///private/captures/${owner}.mov`,
  });
  await saveAnalysisRecord(db, {
    id: uuidAt(tag, 0xa1),
    captureId: uuidAt(tag, 0xca),
    createdAtIso: '2026-08-27T18:00:02.000Z',
    engineVersion: 'engine-1',
    result: null,
    captureEnvelope: null,
  } as never);
  await db.execute(
    `INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
    [owner, uuidAt(tag, 0x77)],
  );
  for (const ns of OWNER_SCOPED_KV_NAMESPACES) {
    await setKv(db, KEY_BUILDERS[ns](owner), `${ns}-of-${owner}`);
  }
}

const TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'outbox',
  'sync_receipt',
] as const;

async function ownerFootprint(db: LocalDb, owner: string) {
  const counts: Record<string, number> = {};
  for (const t of TABLES) counts[t] = await countRows(db, t, owner);
  const kv: Record<string, string | null> = {};
  for (const ns of OWNER_SCOPED_KV_NAMESPACES) {
    kv[ns] = await getKv(db, KEY_BUILDERS[ns](owner));
  }
  return { counts, kv };
}

describe('ATTACK S6/S7/S9 — repository/db against a persistent real sqlite', () => {
  let getDb: () => LocalDb;
  let db: LocalDb;

  beforeEach(() => {
    getDb = loadRealGetDb();
    db = getDb();
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    try {
      db.close();
    } catch {
      // a test may already have closed it
    }
    mockPersistentFile.destroy();
  });

  describe('S6 — purgeOwnerData(B) while A is active', () => {
    it("removes exactly B: A's six tables, five kv keys and device-level kv are untouched; outbox rows for A survive", async () => {
      await seedOwner(db, OWNER_A, 0xa);
      await seedOwner(db, OWNER_B, 0xb);
      await seedOwner(db, GUEST_DATA_OWNER, 0xc);
      await setKv(db, 'onboarding.pending-profile', 'device-level');

      const aBefore = await ownerFootprint(db, OWNER_A);
      const guestBefore = await ownerFootprint(db, GUEST_DATA_OWNER);
      expect(aBefore.counts).toEqual({
        local_shot: 1,
        local_session: 1,
        local_capture: 1,
        local_analysis_record: 1,
        outbox: 2,
        sync_receipt: 1,
      });
      expect(Object.values(aBefore.kv).every(v => v !== null)).toBe(true);

      setActiveDataOwner(OWNER_A);
      await purgeOwnerData(db, OWNER_B);

      expect(await ownerFootprint(db, OWNER_A)).toEqual(aBefore);
      expect(await ownerFootprint(db, GUEST_DATA_OWNER)).toEqual(guestBefore);
      const bAfter = await ownerFootprint(db, OWNER_B);
      expect(Object.values(bAfter.counts).every(n => n === 0)).toBe(true);
      expect(Object.values(bAfter.kv).every(v => v === null)).toBe(true);
      expect(await getKv(db, 'onboarding.pending-profile')).toBe(
        'device-level',
      );
      // The active owner did not change as a side effect.
      const rows = await outboxRows(db);
      expect(rows.map(r => r.owner_key).sort()).toEqual(
        [OWNER_A, OWNER_A, GUEST_DATA_OWNER, GUEST_DATA_OWNER].sort(),
      );
    });

    it('purging B twice and purging an unknown owner are harmless no-ops for A', async () => {
      await seedOwner(db, OWNER_A, 0xa);
      await seedOwner(db, OWNER_B, 0xb);
      setActiveDataOwner(OWNER_A);
      const aBefore = await ownerFootprint(db, OWNER_A);
      await purgeOwnerData(db, OWNER_B);
      await purgeOwnerData(db, OWNER_B);
      await purgeOwnerData(db, uuidAt(0xdead, 1));
      await purgeOwnerData(db, "'; DELETE FROM outbox; --");
      expect(await ownerFootprint(db, OWNER_A)).toEqual(aBefore);
    });

    it('an owner key whose case differs from the stored one is NOT purged (owner_key comparison is byte-exact)', async () => {
      const hexOwner = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
      await seedOwner(db, hexOwner, 0xd);
      setActiveDataOwner(OWNER_A);
      await purgeOwnerData(db, hexOwner.toUpperCase());
      const after = await ownerFootprint(db, hexOwner);
      // setActiveDataOwner lower-cases; a caller passing the raw canonical id
      // in upper case removes nothing. Pinned so a future caller cannot rely
      // on case-insensitivity.
      expect(after.counts['outbox']).toBe(2);
      await purgeOwnerData(db, hexOwner);
      expect((await ownerFootprint(db, hexOwner)).counts['outbox']).toBe(0);
    });
  });

  describe('S7 — one corrupt shot.sync payload for the active owner', () => {
    it('getShotOutboxStatus throws (SQLite malformed JSON) for EVERY shot id instead of returning absent/queued', async () => {
      setActiveDataOwner(OWNER_A);
      await saveAnalysis(db, realAnalysis, PERMIT_ID);
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
        [OWNER_A, '{"id":"not-closed'],
      );

      await expect(getShotOutboxStatus(db, uuidAt(0x77, 1))).rejects.toThrow(
        /malformed JSON/i,
      );
      // Even the perfectly valid shot's status is now unreadable.
      await expect(getShotOutboxStatus(db, SHOT_ID)).rejects.toThrow(
        /malformed JSON/i,
      );
    });

    it('drainOutbox tolerates the row (burns its budget, keeps it) but it still poisons status reads and the relaunch migration forever', async () => {
      setActiveDataOwner(OWNER_A);
      await saveAnalysis(db, realAnalysis, PERMIT_ID);
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
        [OWNER_A, '\u0000garbage'],
      );
      const acceptAll = {
        async syncShots(shots: unknown[]) {
          return {
            acceptedIds: (shots as Array<{ id: string }>).map(s => s.id),
            rejected: [],
          };
        },
        async createSession() {},
        async finalizeSession() {},
      };
      for (let i = 0; i < 9; i++) await drainOutbox(db, acceptAll);
      // (outboxRows() itself uses json_extract and would throw here.)
      const { rows } = await db.execute(
        'SELECT kind, attempts, last_error FROM outbox ORDER BY id',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'shot.sync', attempts: 8 }); // exhausted, never removed
      await expect(getShotOutboxStatus(db, SHOT_ID)).rejects.toThrow(
        /malformed JSON/i,
      );

      // Relaunch: db.ts:95 runs json_extract over the same row.
      db.close();
      expect(() => getDb()).toThrow(/malformed JSON/i);
      expect(() => getDb()).toThrow(/malformed JSON/i); // every launch
    });

    it('control: a corrupt payload on a NON-shot kind does not affect status reads or relaunch', async () => {
      setActiveDataOwner(OWNER_A);
      await saveAnalysis(db, realAnalysis, PERMIT_ID);
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', ?)`,
        [OWNER_A, '{"id":'],
      );
      expect(await getShotOutboxStatus(db, SHOT_ID)).toMatchObject({
        state: 'queued',
      });
      db.close();
      expect(() => getDb()).not.toThrow();
      db = getDb();
    });
  });

  describe('S9 — saveSession, relaunch (LOCAL_MIGRATIONS re-run) before finishSession', () => {
    it('the incomplete zero-shot session row is deleted by the fixture sweep while its session.create outbox row remains', async () => {
      setActiveDataOwner(OWNER_A);
      await saveSession(db, {
        id: SESSION_S,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-08-27T18:00:00.000Z',
      });
      expect(await countRows(db, 'local_session', OWNER_A)).toBe(1);
      expect((await outboxRows(db)).map(r => r.kind)).toEqual([
        'session.create',
      ]);

      db.close();
      db = getDb(); // relaunch → LOCAL_MIGRATIONS run again

      expect(await countRows(db, 'local_session', OWNER_A)).toBe(0);
      const rows = await outboxRows(db);
      expect(rows.map(r => r.kind)).toEqual(['session.create']);
      expect(rows[0]!.entity).toBe(SESSION_S);

      // finishSession now updates 0 rows yet still queues a finalize.
      await finishSession(db, SESSION_S, { shots: 0 });
      expect(await countRows(db, 'local_session', OWNER_A)).toBe(0);
      expect((await outboxRows(db)).map(r => r.kind)).toEqual([
        'session.create',
        'session.finalize',
      ]);
    });

    it('control: the same session survives the relaunch once one local_shot references it (production commit order)', async () => {
      setActiveDataOwner(OWNER_A);
      await saveAnalysis(
        db,
        { ...realAnalysis, sessionId: SESSION_S },
        PERMIT_ID,
      );
      await saveSession(db, {
        id: SESSION_S,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-08-27T18:00:00.000Z',
      });
      db.close();
      db = getDb();
      expect(await countRows(db, 'local_session', OWNER_A)).toBe(1);
    });

    it("the sweep is not owner-scoped: another owner's shot with the same session id keeps A's zero-shot session alive", async () => {
      setActiveDataOwner(OWNER_B);
      await saveAnalysis(
        db,
        { ...realAnalysis, sessionId: SESSION_S },
        PERMIT_ID,
      );
      setActiveDataOwner(OWNER_A);
      await saveSession(db, {
        id: SESSION_S,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-08-27T18:00:00.000Z',
      });
      db.close();
      db = getDb();
      // B's shot keeps the id in the NOT IN subquery, so A's row survives —
      // cross-owner coupling, documented rather than asserted as a defect.
      expect(await countRows(db, 'local_session', OWNER_A)).toBe(1);
    });
  });
});
