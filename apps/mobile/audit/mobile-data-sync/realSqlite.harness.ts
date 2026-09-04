/**
 * mobile-data-sync execution harness — the app's REAL SQL against a REAL
 * SQLite engine. The shipped suites drive db.ts/repository.ts/sync.ts through
 * string-matching fakes, so nothing in CI ever parses the migrations or the
 * product queries. This harness does.
 *
 * Run:  NODE_OPTIONS=--experimental-sqlite npx jest --testMatch '**\/audit/**\/*.harness.ts'
 * (Node 22.5–22.12; Node >= 22.13 needs no flag. Node 20 has no node:sqlite.)
 *
 * Every `it` asserts the behaviour the module contract promises. A failing
 * case is a finding, not a broken harness.
 */
import type { LocalDb } from '../../src/data/db';
import type * as Repository from '../../src/data/repository';
import type * as Sync from '../../src/data/sync';
import type * as AccountScope from '../../src/data/accountScope';
import type * as Offline from '../../src/data/offlineCapabilities';
import {
  createRealSqliteFixture,
  type RealSqliteFixture,
} from './realSqliteDb';
import {
  ANALYSIS_PERMIT_ID,
  OWNER_A,
  OWNER_B,
  scoredAnalysis,
  shotId,
} from './fixtures';

const mockFixtureRef: { current: RealSqliteFixture | null } = {
  current: null,
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => {
    if (!mockFixtureRef.current) throw new Error('fixture not initialised');
    return mockFixtureRef.current.open(options);
  },
}));

interface Modules {
  getDb: () => LocalDb;
  repo: typeof Repository;
  sync: typeof Sync;
  scope: typeof AccountScope;
  offline: typeof Offline;
}

function loadModules(): Modules {
  let loaded: Modules | null = null;
  jest.isolateModules(() => {
    loaded = {
      getDb:
        jest.requireActual<typeof import('../../src/data/db')>(
          '../../src/data/db',
        ).getDb,
      repo: jest.requireActual('../../src/data/repository'),
      sync: jest.requireActual('../../src/data/sync'),
      scope: jest.requireActual('../../src/data/accountScope'),
      offline: jest.requireActual('../../src/data/offlineCapabilities'),
    };
  });
  if (!loaded) throw new Error('modules did not load');
  return loaded;
}

function acceptingTransport(calls: string[] = []): Sync.SyncTransport {
  return {
    async syncShots(shots) {
      calls.push(`syncShots:${shots.length}`);
      return {
        acceptedIds: shots.map(shot => (shot as { id: string }).id),
        rejected: [],
      };
    },
    async createSession(session) {
      calls.push(`createSession:${(session as { id: string }).id}`);
    },
    async finalizeSession(id) {
      calls.push(`finalizeSession:${id}`);
    },
  };
}

let fixture: RealSqliteFixture;
let m: Modules;

beforeEach(() => {
  fixture = createRealSqliteFixture();
  mockFixtureRef.current = fixture;
  m = loadModules();
});

afterEach(() => {
  try {
    fixture.current?.close();
  } catch {
    // already closed by the test
  }
  mockFixtureRef.current = null;
});

describe('db.ts migrations on a real SQLite engine', () => {
  it('opens a fresh database, applies every migration once per process, and reuses the handle', () => {
    const db = m.getDb();
    expect(fixture.opens).toBe(1);
    m.getDb();
    expect(fixture.opens).toBe(1);
    const tables = fixture
      .raw<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .map(row => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'kv',
        'local_shot',
        'local_session',
        'local_capture',
        'outbox',
        'sync_receipt',
        'local_analysis_record',
      ]),
    );
    for (const table of ['local_shot', 'local_session', 'local_capture']) {
      const pk = fixture
        .raw<{ name: string; pk: number }>(`PRAGMA table_info(${table})`)
        .filter(row => row.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map(row => row.name);
      expect(pk).toEqual(['owner_key', 'id']);
    }
    const captureColumns = fixture
      .raw<{ name: string }>('PRAGMA table_info(local_capture)')
      .map(row => row.name);
    expect(captureColumns).toEqual(
      expect.arrayContaining([
        'payload',
        'declared_stroke',
        'target_seed',
        'training_consent',
      ]),
    );
    // BEGIN/COMMIT of the account-schema pass must be balanced.
    const log = fixture.current!.log;
    expect(log.filter(sql => sql === 'BEGIN IMMEDIATE')).toHaveLength(1);
    expect(log.filter(sql => sql === 'COMMIT')).toHaveLength(1);
    expect(log.filter(sql => sql === 'ROLLBACK')).toHaveLength(0);
    db.close();
  });

  it('relaunch: reopening the same file re-runs the idempotent migrations and preserves data', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    await m.repo.saveAnalysis(db, scoredAnalysis(), ANALYSIS_PERMIT_ID);
    await m.repo.setKv(db, 'profile:' + OWNER_A, '{"x":1}');
    db.close();
    expect(fixture.current).toBeNull();

    const relaunched = m.getDb();
    expect(fixture.opens).toBe(2);
    const shots = await m.repo.listShots(relaunched);
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({
      id: scoredAnalysis().id,
      source: 'real',
      favorite: false,
    });
    expect(await m.repo.getKv(relaunched, 'profile:' + OWNER_A)).toBe(
      '{"x":1}',
    );
    expect(await m.repo.getShotOutboxStatus(relaunched, shots[0]!.id)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
  });

  it('legacy (pre-account-scope) schema: rows migrate into the guest bucket and never surface to a signed-in owner', async () => {
    // Seed the pre-owner_key layout a v0 device would have on disk.
    const seed = fixture.open({ name: 'pickle-sensei.db' });
    seed.executeSync(
      `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    seed.executeSync(`CREATE TABLE local_shot (
      id TEXT PRIMARY KEY, session_id TEXT, shot_type TEXT NOT NULL,
      captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
      result_kind TEXT NOT NULL, source TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`);
    seed.executeSync(`CREATE TABLE local_session (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, shot_type TEXT, focus_checkpoint TEXT,
      started_at TEXT NOT NULL, ended_at TEXT, completed INTEGER NOT NULL DEFAULT 0, summary TEXT)`);
    seed.executeSync(`CREATE TABLE local_capture (
      id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE, shot_type TEXT NOT NULL,
      captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, fps REAL NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')))`);
    seed.executeSync(`CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`);
    const legacy = scoredAnalysis();
    seed.executeSync(
      `INSERT INTO local_shot (id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
       VALUES (?, NULL, ?, ?, ?, ?, ?, 'real', 1, ?)`,
      [
        legacy.id,
        legacy.shotType,
        legacy.capturedAtIso,
        legacy.overallScore,
        legacy.analysisConfidence,
        legacy.resultKind,
        JSON.stringify(legacy),
      ],
    );
    seed.executeSync(
      `INSERT INTO local_shot (id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
       VALUES (?, NULL, 'forehand_drive', '2026-08-01T00:00:00.000Z', 5, 0.5, 'scored', 'fixture', 0, '{}')`,
      [shotId(99)],
    );
    seed.executeSync(
      `INSERT INTO local_capture (id, uri, shot_type, captured_at, duration_ms, fps, width, height, status)
       VALUES (?, 'file:///legacy.mov', 'forehand_drive', '2026-08-01T00:00:00.000Z', 2000, 30, 1080, 1920, 'analyzed')`,
      [shotId(7)],
    );
    seed.executeSync(
      `INSERT INTO outbox (kind, payload) VALUES ('shot.sync', ?)`,
      [JSON.stringify({ ...legacy, analysisPermitId: ANALYSIS_PERMIT_ID })],
    );
    seed.close();
    fixture.opens = 0;

    const db = m.getDb();
    expect(fixture.opens).toBe(1);

    m.scope.setActiveDataOwner(m.scope.GUEST_DATA_OWNER);
    const guestShots = await m.repo.listShots(db);
    expect(guestShots.map(row => row.id)).toEqual([legacy.id]);
    expect(guestShots[0]!.favorite).toBe(true);
    const history = await m.repo.listCaptureHistory(db);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: shotId(7),
      evidenceStatus: 'legacy',
      status: 'analyzed',
    });
    expect(await m.repo.getShotOutboxStatus(db, legacy.id)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });

    m.scope.setActiveDataOwner(OWNER_A);
    expect(await m.repo.listShots(db)).toEqual([]);
    expect(await m.repo.listCaptureHistory(db)).toEqual([]);
    expect(await m.repo.getShotOutboxStatus(db, legacy.id)).toEqual({
      state: 'absent',
    });
    const drained = await m.sync.drainOutbox(db, acceptingTransport());
    expect(drained).toEqual({ synced: 0, failed: 0, remaining: 0 });

    // Fixture rows were purged by the one-time cleanup.
    expect(
      fixture.raw(`SELECT id FROM local_shot WHERE source <> 'real'`),
    ).toEqual([]);
  });

  it('a corrupt shot.sync outbox payload must not prevent the database from opening on the next launch', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    await m.repo.saveAnalysis(db, scoredAnalysis(), ANALYSIS_PERMIT_ID);
    db.close();
    // Disk-level corruption of ONE row: sync.ts explicitly handles this at
    // drain time ("fails alone and permanently; never poisons the batch").
    const seed = fixture.open({ name: 'pickle-sensei.db' });
    seed.executeSync(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', 'not-json{')`,
      [OWNER_A],
    );
    seed.close();

    let opened: LocalDb | null = null;
    let openError: unknown = null;
    try {
      opened = m.getDb();
    } catch (error) {
      openError = error;
    }
    expect(openError).toBeNull();
    expect(opened).not.toBeNull();
    const result = await m.sync.drainOutbox(opened!, acceptingTransport());
    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('getShotOutboxStatus for a healthy shot is unaffected by an unrelated corrupt outbox row of the same owner', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    await m.repo.saveAnalysis(db, scoredAnalysis(), ANALYSIS_PERMIT_ID);
    // Inject the corrupt row while the connection is open (the launch-time
    // cleanup has already run, so this isolates the product query).
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', 'not-json{')`,
      [OWNER_A],
    );
    await expect(
      m.repo.getShotOutboxStatus(db, scoredAnalysis().id),
    ).resolves.toEqual({ state: 'queued', attempts: 0, lastError: null });
  });

  it('an in-progress session saved before a relaunch is still there after it (finishSession has a row to update)', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    const sessionId = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await m.repo.saveSession(db, {
      id: sessionId,
      mode: 'live_court',
      shotType: null,
      focusCheckpoint: null,
      startedAt: '2026-08-26T17:59:00.000Z',
    });
    expect(
      fixture.raw(`SELECT id FROM local_session WHERE id = ?`, [sessionId]),
    ).toHaveLength(1);
    db.close();

    const relaunched = m.getDb();
    expect(
      fixture.raw(`SELECT id FROM local_session WHERE id = ?`, [sessionId]),
    ).toHaveLength(1);
    await m.repo.finishSession(relaunched, sessionId, { shots: 0 });
    const history = await m.repo.listLiveSessionHistory(relaunched);
    expect(history.map(row => row.id)).toContain(sessionId);
  });
});

describe('repository.ts + sync.ts product queries on a real SQLite engine', () => {
  it('saveAnalysis → outbox → drain: receipt written, outbox row deleted, status transitions absent→queued→absent', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    const analysis = scoredAnalysis();
    expect(await m.repo.getShotOutboxStatus(db, analysis.id)).toEqual({
      state: 'absent',
    });
    await m.repo.saveAnalysis(db, analysis, ANALYSIS_PERMIT_ID);
    expect(await m.repo.getShotOutboxStatus(db, analysis.id)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    expect(await m.repo.hasShotSyncReceipt(db, analysis.id)).toBe(false);
    const calls: string[] = [];
    const result = await m.sync.drainOutbox(db, acceptingTransport(calls));
    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(calls).toEqual(['syncShots:1']);
    expect(await m.repo.hasShotSyncReceipt(db, analysis.id)).toBe(true);
    expect(await m.repo.getShotOutboxStatus(db, analysis.id)).toEqual({
      state: 'absent',
    });
    expect(await m.repo.getAnalysis(db, analysis.id)).toMatchObject({
      id: analysis.id,
      overallScore: 7.4,
    });
  });

  it('transient failures keep the row and its budget; permanent rejections spend it; exhausted rows leave the drain window and read as exhausted/needs_attention', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    const analysis = scoredAnalysis();
    await m.repo.saveAnalysis(db, analysis, ANALYSIS_PERMIT_ID);

    const offline: Sync.SyncTransport = {
      async syncShots() {
        throw new TypeError('Network request failed');
      },
      async createSession() {},
      async finalizeSession() {},
    };
    for (let i = 0; i < 3; i++) {
      expect(await m.sync.drainOutbox(db, offline)).toEqual({
        synced: 0,
        failed: 1,
        remaining: 1,
      });
    }
    expect(await m.repo.getShotOutboxStatus(db, analysis.id)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: 'TypeError: Network request failed',
    });

    const rejecting: Sync.SyncTransport = {
      async syncShots(shots) {
        return {
          acceptedIds: [],
          rejected: shots.map(shot => ({
            id: (shot as { id: string }).id,
            code: 'access.permit_not_reserved',
            message: 'no longer reserved',
          })),
        };
      },
      async createSession() {},
      async finalizeSession() {},
    };
    for (let attempt = 1; attempt <= m.sync.OUTBOX_MAX_ATTEMPTS; attempt++) {
      const result = await m.sync.drainOutbox(db, rejecting);
      expect(result.failed).toBe(1);
      const status = await m.repo.getShotOutboxStatus(db, analysis.id);
      expect(status).toMatchObject({
        attempts: attempt,
        state: attempt >= m.sync.OUTBOX_MAX_ATTEMPTS ? 'exhausted' : 'rejected',
      });
    }
    // The exhausted row is excluded from the SELECT but still counted as remaining.
    const idle = await m.sync.drainOutbox(db, rejecting);
    expect(idle).toEqual({ synced: 0, failed: 0, remaining: 1 });
    const rows = fixture.raw<{
      kind: string;
      attempts: number;
      lastError: string | null;
    }>(
      `SELECT kind, attempts, last_error AS lastError FROM outbox WHERE owner_key = ?`,
      [OWNER_A],
    );
    expect(m.offline.deriveUploadQueueStatus(rows)).toEqual({
      state: 'needs_attention',
      pending: 0,
      exhausted: 1,
    });
  });

  it('sessions drain before the shots that reference them, including when queued after the shot', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    const sessionId = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await m.repo.saveAnalysis(
      db,
      scoredAnalysis({ sessionId }),
      ANALYSIS_PERMIT_ID,
    );
    await m.repo.saveSession(db, {
      id: sessionId,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T17:59:00.000Z',
    });
    await m.repo.finishSession(db, sessionId, { shots: 1 });
    const calls: string[] = [];
    const result = await m.sync.drainOutbox(db, acceptingTransport(calls));
    expect(result).toEqual({ synced: 3, failed: 0, remaining: 0 });
    expect(calls).toEqual([
      `createSession:${sessionId}`,
      `finalizeSession:${sessionId}`,
      'syncShots:1',
    ]);
    expect(
      fixture.raw(`SELECT completed FROM local_session WHERE id = ?`, [
        sessionId,
      ]),
    ).toEqual([{ completed: 1 }]);
  });

  it('purgeOwnerData removes exactly one owner bucket (tables + kv namespaces) and leaves the other owner intact', async () => {
    const db = m.getDb();
    for (const owner of [OWNER_A, OWNER_B]) {
      m.scope.setActiveDataOwner(owner);
      await m.repo.saveAnalysis(
        db,
        scoredAnalysis({ id: shotId(owner === OWNER_A ? 1 : 2) }),
        ANALYSIS_PERMIT_ID,
      );
      for (const ns of m.repo.OWNER_SCOPED_KV_NAMESPACES) {
        await m.repo.setKv(db, `${ns}:${owner}`, owner);
      }
    }
    await m.repo.setKv(db, 'onboarding.pending-profile', 'device-level');
    await m.repo.purgeOwnerData(db, OWNER_A);

    m.scope.setActiveDataOwner(OWNER_A);
    expect(await m.repo.listShots(db)).toEqual([]);
    expect(await m.repo.getShotOutboxStatus(db, shotId(1))).toEqual({
      state: 'absent',
    });
    for (const ns of m.repo.OWNER_SCOPED_KV_NAMESPACES) {
      expect(await m.repo.getKv(db, `${ns}:${OWNER_A}`)).toBeNull();
    }
    m.scope.setActiveDataOwner(OWNER_B);
    expect((await m.repo.listShots(db)).map(row => row.id)).toEqual([
      shotId(2),
    ]);
    for (const ns of m.repo.OWNER_SCOPED_KV_NAMESPACES) {
      expect(await m.repo.getKv(db, `${ns}:${OWNER_B}`)).toBe(OWNER_B);
    }
    expect(await m.repo.getKv(db, 'onboarding.pending-profile')).toBe(
      'device-level',
    );
    expect(
      fixture.raw(`SELECT owner_key FROM outbox`).map(r => r['owner_key']),
    ).toEqual([OWNER_B]);
  });

  it('a signed-out process cannot write product data and reads nothing', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    await m.repo.saveAnalysis(db, scoredAnalysis(), ANALYSIS_PERMIT_ID);
    m.scope.setActiveDataOwner(m.scope.SIGNED_OUT_DATA_OWNER);
    await expect(
      m.repo.saveAnalysis(
        db,
        scoredAnalysis({ id: shotId(3) }),
        ANALYSIS_PERMIT_ID,
      ),
    ).rejects.toThrow('Sign in or continue locally');
    expect(await m.repo.listShots(db)).toEqual([]);
    expect(await m.sync.drainOutbox(db, acceptingTransport())).toEqual({
      synced: 0,
      failed: 0,
      remaining: 0,
    });
    expect(fixture.raw(`SELECT count(*) AS n FROM outbox`)[0]).toEqual({
      n: 1,
    });
  });

  it('saveAnalysis rejects non-real and permit-less input without touching the database', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    await expect(
      m.repo.saveAnalysis(
        db,
        scoredAnalysis({ source: 'fixture' }),
        ANALYSIS_PERMIT_ID,
      ),
    ).rejects.toThrow('Only real analyses');
    await expect(
      m.repo.saveAnalysis(db, scoredAnalysis(), '   '),
    ).rejects.toThrow('analysis permit is required');
    expect(fixture.raw(`SELECT count(*) AS n FROM local_shot`)[0]).toEqual({
      n: 0,
    });
    expect(fixture.raw(`SELECT count(*) AS n FROM outbox`)[0]).toEqual({
      n: 0,
    });
  });

  it('a failing statement inside saveAnalysis rolls the transaction back (no local_shot without its outbox row)', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    // A payload that cannot be serialised makes the second statement's
    // parameter construction throw AFTER the local_shot insert.
    const cyclic = scoredAnalysis() as ShotAnalysisWithCycle;
    cyclic.self = cyclic;
    await expect(
      m.repo.saveAnalysis(db, cyclic, ANALYSIS_PERMIT_ID),
    ).rejects.toThrow();
    expect(fixture.raw(`SELECT count(*) AS n FROM local_shot`)[0]).toEqual({
      n: 0,
    });
    expect(fixture.raw(`SELECT count(*) AS n FROM outbox`)[0]).toEqual({
      n: 0,
    });
    // Connection is usable afterwards.
    await m.repo.saveAnalysis(db, scoredAnalysis(), ANALYSIS_PERMIT_ID);
    expect(await m.repo.listShots(db)).toHaveLength(1);
  });

  it('a concurrent saveAnalysis while the drain commits an accepted shot: both writes land (single shared connection)', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    const first = scoredAnalysis({ id: shotId(1) });
    const second = scoredAnalysis({ id: shotId(2) });
    await m.repo.saveAnalysis(db, first, ANALYSIS_PERMIT_ID);

    // The capture flow persists a new score while the timer-driven drain is
    // inside its receipt/delete transaction for the previous one.
    const [drain, save] = await Promise.allSettled([
      m.sync.drainOutbox(db, acceptingTransport()),
      (async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));
        await m.repo.saveAnalysis(db, second, ANALYSIS_PERMIT_ID);
      })(),
    ]);
    const observed = {
      drain:
        drain.status === 'fulfilled'
          ? drain.value
          : `rejected: ${String(drain.reason)}`,
      save:
        save.status === 'fulfilled' ? 'ok' : `rejected: ${String(save.reason)}`,
      firstReceipt: await m.repo.hasShotSyncReceipt(db, first.id),
      shots: (await m.repo.listShots(db)).map(row => row.id).sort(),
      secondOutbox: await m.repo.getShotOutboxStatus(db, second.id),
      firstOutbox: await m.repo.getShotOutboxStatus(db, first.id),
    };
    expect(observed).toEqual({
      drain: { synced: 1, failed: 0, remaining: 1 },
      save: 'ok',
      firstReceipt: true,
      shots: [first.id, second.id].sort(),
      secondOutbox: { state: 'queued', attempts: 0, lastError: null },
      firstOutbox: { state: 'absent' },
    });
  });

  it('a drain that starts while saveAnalysis is mid-transaction: the saved score is reported as saved and stays queued', async () => {
    m.scope.setActiveDataOwner(OWNER_A);
    const db = m.getDb();
    const first = scoredAnalysis({ id: shotId(1) });
    const second = scoredAnalysis({ id: shotId(2) });
    await m.repo.saveAnalysis(db, first, ANALYSIS_PERMIT_ID);

    const [save, drain] = await Promise.allSettled([
      m.repo.saveAnalysis(db, second, ANALYSIS_PERMIT_ID),
      (async () => {
        // Let saveAnalysis issue BEGIN IMMEDIATE, then start the drain whose
        // SELECT/receipt statements run inside the open transaction.
        await new Promise<void>(resolve => setImmediate(resolve));
        return m.sync.drainOutbox(db, acceptingTransport());
      })(),
    ]);
    const observed = {
      save:
        save.status === 'fulfilled' ? 'ok' : `rejected: ${String(save.reason)}`,
      drain:
        drain.status === 'fulfilled'
          ? drain.value
          : `rejected: ${String(drain.reason)}`,
      shots: (await m.repo.listShots(db)).map(row => row.id).sort(),
      secondOutbox: await m.repo.getShotOutboxStatus(db, second.id),
    };
    // Either serialisation is acceptable; what is NOT acceptable is a
    // rejected save whose rows landed, or a fulfilled save whose rows did not.
    const secondPersisted =
      observed.shots.includes(second.id) &&
      observed.secondOutbox.state === 'queued';
    expect({
      saveOutcome: observed.save,
      secondPersisted,
      drain: observed.drain,
    }).toEqual({
      saveOutcome: 'ok',
      secondPersisted: true,
      drain: expect.objectContaining({ failed: 0 }),
    });
  });
});

type ShotAnalysisWithCycle = ReturnType<typeof scoredAnalysis> & {
  self?: unknown;
};
