/**
 * XC journey-offline-first — EXECUTION harness (Linux jest plane).
 *
 * Journey: online scoring session → connectivity lost before flush → local
 * work continues → reconnect through a flaky edge → flush → server accepts
 * some rows, rejects others → durable reconciliation the UI can read.
 *
 * Runs the production repository + sync engine + transport over a REAL
 * SQLite database (`node:sqlite`, Node >= 22.13) against a fetch-level model
 * of the shipping endpoints. Every scenario is seeded and replayable; raw
 * results, the outcome matrix and heap numbers are written to
 * `$XC_OFFLINE_ARTIFACT_DIR` (default `<repo>/artifacts/xc-offline-first/jest`).
 *
 *   cd apps/mobile && XC_OFFLINE_SEEDS=300 npx jest __tests__/xcOfflineFirstJourney.test.ts
 */
import { setActiveDataOwner } from '../src/data/accountScope';
import { API_REQUEST_TIMEOUT_MS, createTransport } from '../src/data/api';
import { deriveUploadQueueStatus } from '../src/data/offlineCapabilities';
import {
  finishSession,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
} from '../src/data/repository';
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../src/data/sync';
import { FakeSyncServer } from '../harness/xcOfflineFirst/fakeSyncServer';
import {
  API_BASE_URL,
  makeAnalysis,
  makeRng,
  planScenario,
  runScenario,
  type PlannedShot,
  type ScenarioPlan,
  type ScenarioResult,
} from '../harness/xcOfflineFirst/journeyScenario';
import {
  heapSnapshot as heap,
  nodeFs,
  nodePath,
  nodeProcess,
} from '../harness/xcOfflineFirst/nodeRuntime';
import {
  nodeSqliteAvailable,
  openSqliteLocalDb,
  productionLocalMigrations,
  snapshotLocalState,
} from '../harness/xcOfflineFirst/sqliteLocalDb';

declare const __dirname: string;

const ARTIFACT_DIR = nodePath.resolve(
  nodeProcess.env.XC_OFFLINE_ARTIFACT_DIR ??
    nodePath.join(
      __dirname,
      '..',
      '..',
      '..',
      'artifacts',
      'xc-offline-first',
      'jest',
    ),
);
const SEED_COUNT = Number(nodeProcess.env.XC_OFFLINE_SEEDS ?? 300);
const SEED_BASE = Number(nodeProcess.env.XC_OFFLINE_SEED_BASE ?? 1);
const SCALE_SHOTS = Number(nodeProcess.env.XC_OFFLINE_SCALE_SHOTS ?? 1000);

nodeFs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function writeArtifact(name: string, value: unknown): string {
  const path = nodePath.join(ARTIFACT_DIR, name);
  nodeFs.writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

function queueRows(outbox: Record<string, unknown>[]) {
  return outbox.map(row => ({
    kind: String(row['kind']),
    attempts: Number(row['attempts']),
    lastError: typeof row['last_error'] === 'string' ? row['last_error'] : null,
  }));
}

const sqliteReady = nodeSqliteAvailable();
if (!sqliteReady) {
  // The plane is unavailable, not passing: the first spec below is a hard
  // failure so a skipped stage can never read as green.
  console.warn(
    `[xc-offline-first] node:sqlite unavailable on ${nodeProcess.version}; the ` +
      'journey harness requires Node >= 22.13 (nvm use 22.23.2).',
  );
}

describe('XC journey-offline-first — execution harness', () => {
  beforeAll(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('runs on a Node with node:sqlite (harness plane availability)', () => {
    expect(sqliteReady).toBe(true);
  });

  it('applies the production LOCAL_MIGRATIONS verbatim to a real SQLite db', () => {
    const statements = productionLocalMigrations();
    expect(statements.length).toBeGreaterThanOrEqual(8);
    const db = openSqliteLocalDb();
    const tables = db.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    db.close();
    const names = tables.map(t => t.name);
    for (const required of [
      'kv',
      'local_shot',
      'local_session',
      'local_capture',
      'outbox',
      'sync_receipt',
      'local_analysis_record',
    ]) {
      expect(names).toContain(required);
    }
  });

  it(`seeded journey matrix: ${SEED_COUNT} scenarios hold I1–I8 (no local data loss, honest durable status)`, async () => {
    const started = Date.now();
    const heapBefore = heap();
    const results: ScenarioResult[] = [];
    const failures: Array<{
      seed: number;
      plan: ScenarioPlan;
      result: ScenarioResult;
    }> = [];
    for (let i = 0; i < SEED_COUNT; i++) {
      const plan = planScenario(SEED_BASE + i);
      const result = await runScenario(plan);
      results.push(result);
      if (!result.allOk) failures.push({ seed: plan.seed, plan, result });
    }
    const heapAfter = heap();

    // Outcome matrix: planned server verdict × final durable state.
    const matrix: Record<string, Record<string, number>> = {};
    let totalScored = 0;
    let totalLocalOnly = 0;
    let totalRequests = 0;
    for (const result of results) {
      totalScored += result.scoredShots;
      totalLocalOnly += result.localOnlyShots;
      totalRequests += result.totalRequests;
      for (const shot of result.shots) {
        const planned = JSON.parse(shot.planned) as {
          kind: string;
          code?: string;
        };
        const key = planned.code
          ? `${planned.kind}:${planned.code}`
          : planned.kind;
        const state = `${shot.outbox}/receipt=${shot.receipt}/server=${shot.serverHolds}`;
        matrix[key] ??= {};
        matrix[key][state] = (matrix[key][state] ?? 0) + 1;
      }
    }
    const reconnectModeCounts: Record<string, number> = {};
    for (const result of results) {
      for (const mode of result.plan.reconnectModes) {
        reconnectModeCounts[mode] = (reconnectModeCounts[mode] ?? 0) + 1;
      }
    }
    const summary = {
      seedBase: SEED_BASE,
      seedCount: SEED_COUNT,
      elapsedMs: Date.now() - started,
      node: nodeProcess.version,
      totals: {
        scenarios: results.length,
        scoredShots: totalScored,
        localOnlyShots: totalLocalOnly,
        sessions: results.reduce((n, r) => n + r.sessions, 0),
        requests: totalRequests,
        statementsExecuted: results.reduce(
          (n, r) => n + r.statementsExecuted,
          0,
        ),
        invariantChecks: results.reduce((n, r) => n + r.invariants.length, 0),
        invariantFailures: results.reduce(
          (n, r) => n + r.invariants.filter(i => !i.ok).length,
          0,
        ),
      },
      drainsToQuiescence: {
        min: Math.min(...results.map(r => r.drainsToQuiescence)),
        max: Math.max(...results.map(r => r.drainsToQuiescence)),
        mean:
          results.reduce((n, r) => n + r.drainsToQuiescence, 0) /
          results.length,
      },
      reconnectModeCounts,
      heapBefore,
      heapAfter,
      failingSeeds: failures.map(f => f.seed),
    };
    writeArtifact('matrix-summary.json', summary);
    writeArtifact('matrix-outcomes.json', matrix);
    writeArtifact(
      'matrix-results.json',
      results.map(r => ({
        seed: r.seed,
        allOk: r.allOk,
        scoredShots: r.scoredShots,
        localOnlyShots: r.localOnlyShots,
        sessions: r.sessions,
        offlineDrains: r.offlineDrains,
        reconnectModes: r.plan.reconnectModes,
        drainsToQuiescence: r.drainsToQuiescence,
        totalRequests: r.totalRequests,
        queueStatusBeforeReconnect: r.queueStatusBeforeReconnect,
        queueStatusFinal: r.queueStatusFinal,
        failedInvariants: r.invariants.filter(i => !i.ok),
      })),
    );
    writeArtifact(
      'matrix-shot-table.json',
      results.flatMap(r => r.shots.map(shot => ({ seed: r.seed, ...shot }))),
    );
    writeArtifact('matrix-failures.json', failures);

    expect(results).toHaveLength(SEED_COUNT);
    expect(totalScored).toBeGreaterThan(0);
    // Every planned verdict class must have been exercised by the matrix.
    for (const key of [
      'accept',
      'write_failed',
      'permit_expired',
      'permanent:access.permit_not_found',
      'permanent:access.permit_not_reserved',
      'permanent:access.paywall_required',
      'permanent:shot.id_conflict',
    ]) {
      expect(Object.keys(matrix)).toContain(key);
    }
    for (const mode of [
      'http500',
      'http429',
      'http401',
      'offline',
      'commit_then_drop',
    ]) {
      expect(reconnectModeCounts[mode] ?? 0).toBeGreaterThan(0);
    }
    expect(
      failures.map(f => ({
        seed: f.seed,
        failed: f.result.invariants.filter(i => !i.ok),
      })),
    ).toEqual([]);
  });

  it(`scale: ${SCALE_SHOTS} scored shots in one account flush through the 50-row window without loss`, async () => {
    const rng = makeRng(0x5ca1e);
    const owner = '0000a11e-5ca1-4e00-8000-000000000001';
    const sets = Array.from({ length: Math.ceil(SCALE_SHOTS / 10) }, () => {
      const sessionId = rng.uuid();
      const shots: PlannedShot[] = Array.from({ length: 10 }, () => ({
        id: rng.uuid(),
        permitId: rng.uuid(),
        sessionId,
        resultKind: 'scored' as const,
        outcome: rng.chance(0.1)
          ? { kind: 'write_failed' as const, times: 1 }
          : { kind: 'accept' as const },
      }));
      return { sessionId, shots, finalize: true };
    });
    const plan: ScenarioPlan = {
      seed: 0x5ca1e,
      owner,
      premium: true,
      sets,
      loose: [],
      reconnectModes: ['offline', 'http500'],
      offlineDrains: 2,
    };
    const heapBefore = heap();
    const started = Date.now();
    const result = await runScenario(plan);
    const heapAfter = heap();
    const rowsQueued = SCALE_SHOTS + sets.length * 2;
    const artifact = {
      shots: SCALE_SHOTS,
      sessions: sets.length,
      rowsQueued,
      minimumDrainsByWindow: Math.ceil(rowsQueued / 50),
      drainsToQuiescence: result.drainsToQuiescence,
      totalRequests: result.totalRequests,
      statementsExecuted: result.statementsExecuted,
      elapsedMs: Date.now() - started,
      heapBefore,
      heapAfter,
      queueStatusBeforeReconnect: result.queueStatusBeforeReconnect,
      queueStatusFinal: result.queueStatusFinal,
      failedInvariants: result.invariants.filter(i => !i.ok),
    };
    writeArtifact('scale-run.json', artifact);
    expect(result.scoredShots).toBe(SCALE_SHOTS);
    expect(result.queueStatusBeforeReconnect).toEqual({
      state: 'queued',
      pending: rowsQueued,
    });
    expect(result.queueStatusFinal).toEqual({ state: 'idle' });
    expect(result.invariants.filter(i => !i.ok)).toEqual([]);
  });

  it('owner isolation: draining account A never transmits or mutates account B rows', async () => {
    const db = openSqliteLocalDb();
    const server = new FakeSyncServer({
      userId: '0000a11e-0000-4a00-8000-00000000000a',
    });
    const restore = server.install();
    try {
      const rng = makeRng(77);
      const transport = createTransport({ baseUrl: API_BASE_URL, token: 't' });
      const persist = async (owner: string) => {
        setActiveDataOwner(owner);
        const id = rng.uuid();
        const permit = server.reservePermit(rng.uuid());
        await saveAnalysis(
          db,
          makeAnalysis(rng, {
            id,
            sessionId: null,
            capturedAtIso: '2026-09-04T12:00:00.000Z',
            resultKind: 'scored',
          }),
          permit,
        );
        return id;
      };
      const aShot = await persist('0000a11e-0000-4a00-8000-00000000000a');
      const bShot = await persist('0000a11e-0000-4b00-8000-00000000000b');
      const beforeB = snapshotLocalState(db).outbox.filter(
        r => r['owner_key'] === '0000a11e-0000-4b00-8000-00000000000b',
      );

      setActiveDataOwner('0000a11e-0000-4a00-8000-00000000000a');
      const result = await drainOutbox(db, transport);
      const afterB = snapshotLocalState(db).outbox.filter(
        r => r['owner_key'] === '0000a11e-0000-4b00-8000-00000000000b',
      );

      expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
      expect(server.requestsFor(bShot)).toHaveLength(0);
      expect(server.shots.has(aShot)).toBe(true);
      expect(afterB).toEqual(beforeB);
      expect(await hasShotSyncReceipt(db, aShot)).toBe(true);
      setActiveDataOwner('0000a11e-0000-4b00-8000-00000000000b');
      expect(await hasShotSyncReceipt(db, bShot)).toBe(false);
      expect(await getShotOutboxStatus(db, bShot)).toEqual({
        state: 'queued',
        attempts: 0,
        lastError: null,
      });
      writeArtifact('owner-isolation.json', {
        drainResult: result,
        requests: server.requests,
        outboxAfter: snapshotLocalState(db).outbox,
      });
    } finally {
      restore();
      db.close();
    }
  });

  it('server hang: the bounded request timeout leaves every row queued with budget intact', async () => {
    jest.useFakeTimers();
    const db = openSqliteLocalDb();
    const server = new FakeSyncServer({
      userId: '0000a11e-0000-4c00-8000-00000000000c',
      modeFor: () => 'hang',
    });
    const restore = server.install();
    try {
      setActiveDataOwner('0000a11e-0000-4c00-8000-00000000000c');
      const rng = makeRng(4242);
      const transport = createTransport({ baseUrl: API_BASE_URL, token: 't' });
      const sessionId = rng.uuid();
      const shotId = rng.uuid();
      await saveAnalysis(
        db,
        makeAnalysis(rng, {
          id: shotId,
          sessionId,
          capturedAtIso: '2026-09-04T12:00:00.000Z',
          resultKind: 'scored',
        }),
        server.reservePermit(rng.uuid()),
      );
      await saveSession(db, {
        id: sessionId,
        mode: 'practice_set',
        shotType: 'dink',
        focusCheckpoint: null,
        startedAt: '2026-09-04T12:00:00.000Z',
      });
      const pending = drainOutbox(db, transport);
      // Two sequential requests (session.create, then shots:sync) each hang
      // for the full bounded timeout.
      await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1);
      await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1);
      const result = await pending;
      const outbox = snapshotLocalState(db).outbox;
      writeArtifact('server-hang.json', {
        result,
        outbox,
        requests: server.requests,
      });
      expect(result).toEqual({ synced: 0, failed: 2, remaining: 2 });
      expect(outbox.map(r => r['attempts'])).toEqual([0, 0]);
      for (const row of outbox) {
        expect(String(row['last_error'])).toContain('took too long to respond');
      }
      expect(server.requests.map(r => r.status)).toEqual([
        'timeout',
        'timeout',
      ]);
      expect(await getShotOutboxStatus(db, shotId)).toMatchObject({
        state: 'queued',
        attempts: 0,
      });
    } finally {
      restore();
      db.close();
      jest.useRealTimers();
    }
  });

  it('permanent verdicts are re-sent on every flush until the 8-attempt budget is spent', async () => {
    const db = openSqliteLocalDb();
    const server = new FakeSyncServer({
      userId: '0000a11e-0000-4d00-8000-00000000000d',
    });
    const restore = server.install();
    try {
      setActiveDataOwner('0000a11e-0000-4d00-8000-00000000000d');
      const rng = makeRng(99);
      const transport = createTransport({ baseUrl: API_BASE_URL, token: 't' });
      const shotId = rng.uuid();
      server.faults.set(shotId, {
        kind: 'permanent',
        code: 'access.paywall_required',
      });
      await saveAnalysis(
        db,
        makeAnalysis(rng, {
          id: shotId,
          sessionId: null,
          capturedAtIso: '2026-09-04T12:00:00.000Z',
          resultKind: 'scored',
        }),
        server.reservePermit(rng.uuid()),
      );
      const trace: Array<{ drain: number; status: unknown; requests: number }> =
        [];
      for (let drain = 1; drain <= OUTBOX_MAX_ATTEMPTS + 3; drain++) {
        await drainOutbox(db, transport);
        trace.push({
          drain,
          status: await getShotOutboxStatus(db, shotId),
          requests: server.requestsFor(shotId).length,
        });
      }
      writeArtifact('permanent-verdict-trace.json', trace);
      // The verdict is identical on every replay, yet the row is transmitted
      // OUTBOX_MAX_ATTEMPTS times before it stops being sent.
      expect(server.requestsFor(shotId)).toHaveLength(OUTBOX_MAX_ATTEMPTS);
      expect(trace[OUTBOX_MAX_ATTEMPTS - 2]?.status).toMatchObject({
        state: 'rejected',
        attempts: OUTBOX_MAX_ATTEMPTS - 1,
      });
      expect(trace[trace.length - 1]?.status).toMatchObject({
        state: 'exhausted',
        attempts: OUTBOX_MAX_ATTEMPTS,
        lastError:
          'access.paywall_required: Both lifetime free ratings have been used. Membership is required for another rating.',
      });
      // Local data is intact throughout.
      expect(snapshotLocalState(db).localShots.map(r => r['id'])).toEqual([
        shotId,
      ]);
      expect(await hasShotSyncReceipt(db, shotId)).toBe(false);
    } finally {
      restore();
      db.close();
    }
  });

  it('drain window starvation probe: 49 permanently-transient rows ahead of a practice set block its session.create forever', async () => {
    const db = openSqliteLocalDb();
    const server = new FakeSyncServer({
      userId: '0000a11e-0000-4e00-8000-00000000000e',
    });
    const restore = server.install();
    try {
      setActiveDataOwner('0000a11e-0000-4e00-8000-00000000000e');
      const rng = makeRng(5050);
      const transport = createTransport({ baseUrl: API_BASE_URL, token: 't' });
      const persistShot = async (sessionId: string) => {
        const id = rng.uuid();
        await saveAnalysis(
          db,
          makeAnalysis(rng, {
            id,
            sessionId,
            capturedAtIso: '2026-09-04T12:00:00.000Z',
            resultKind: 'scored',
          }),
          server.reservePermit(rng.uuid()),
        );
        return id;
      };
      const saveSet = async (sessionId: string) =>
        saveSession(db, {
          id: sessionId,
          mode: 'practice_set',
          shotType: 'dink',
          focusCheckpoint: null,
          startedAt: '2026-09-04T11:00:00.000Z',
        });

      // Set A: its session id is bound to another account server-side, so
      // session.create is a permanent 409 (exhausts after 8 attempts) and
      // every shot in the set is `shot.session_not_found` — a TRANSIENT
      // rejection that never spends budget. 49 such shots.
      const setA = rng.uuid();
      server.seedForeignSession(setA);
      const aShots: string[] = [];
      aShots.push(await persistShot(setA));
      await saveSet(setA);
      for (let i = 1; i < 49; i++) aShots.push(await persistShot(setA));

      // Set B: a perfectly valid later practice set (shot, create, finalize).
      const setB = rng.uuid();
      const bShot = await persistShot(setB);
      await saveSet(setB);
      await finishSession(db, setB, { shots: 1 });

      const drains = 40;
      const trace: Array<{
        drain: number;
        result: { synced: number; failed: number; remaining: number };
        bCreateRequests: number;
        bShotStatus: unknown;
        queue: unknown;
      }> = [];
      for (let drain = 1; drain <= drains; drain++) {
        const result = await drainOutbox(db, transport);
        const outbox = snapshotLocalState(db).outbox;
        trace.push({
          drain,
          result,
          bCreateRequests: server.requests.filter(
            r => r.path === '/v1/sessions' && r.entityIds.includes(setB),
          ).length,
          bShotStatus: await getShotOutboxStatus(db, bShot),
          queue: deriveUploadQueueStatus(queueRows(outbox)),
        });
      }
      const finalOutbox = snapshotLocalState(db).outbox;
      const artifact = {
        setA,
        setB,
        bShot,
        drains,
        bSessionCreateRequests: server.requests.filter(
          r => r.path === '/v1/sessions' && r.entityIds.includes(setB),
        ).length,
        bShotRequests: server.requestsFor(bShot).length,
        bShotRejections: server
          .requestsFor(bShot)
          .flatMap(r => r.rejected ?? [])
          .filter(r => r.id === bShot)
          .map(r => r.code),
        serverHoldsB: server.shots.has(bShot),
        finalBShotStatus: await getShotOutboxStatus(db, bShot),
        finalQueue: deriveUploadQueueStatus(queueRows(finalOutbox)),
        outboxRows: finalOutbox.map(r => ({
          id: r['id'],
          kind: r['kind'],
          attempts: r['attempts'],
          lastError: r['last_error'],
        })),
        trace,
      };
      writeArtifact('drain-window-starvation.json', artifact);

      // No local data loss regardless of outcome.
      expect(snapshotLocalState(db).localShots).toHaveLength(50);
      expect(snapshotLocalState(db).localSessions).toHaveLength(2);

      // The engine's contract, as documented in sync.ts: "the session.create
      // row drains ahead of it on the next pass". This records whether that
      // holds for set B after 40 flushes; the artifact carries the trace.
      const bReconciled =
        server.shots.has(bShot) && (await hasShotSyncReceipt(db, bShot));
      // Deterministic verdict; documented as a finding if false.
      expect({
        bSessionCreateEverSent: artifact.bSessionCreateRequests > 0,
        bShotReconciled: bReconciled,
        bShotState: artifact.finalBShotStatus,
      }).toEqual({
        bSessionCreateEverSent: false,
        bShotReconciled: false,
        bShotState: {
          state: 'queued',
          attempts: 0,
          lastError: 'shot.session_not_found: Session not found or not yours.',
        },
      });
    } finally {
      restore();
      db.close();
    }
  });
});
