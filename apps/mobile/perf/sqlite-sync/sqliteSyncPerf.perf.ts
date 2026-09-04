/**
 * perf-sqlite-sync harness — runs the REAL mobile data layer (db.ts
 * migrations, repository.ts queries, sync.ts drainOutbox) against a real
 * SQLite file through node:sqlite at 10k synthetic shots, then records
 * EXPLAIN QUERY PLAN + timings + heap numbers for every query shape.
 *
 * Run (from apps/mobile):
 *   NODE_OPTIONS="--experimental-sqlite --expose-gc" \
 *     npx jest -c perf/sqlite-sync/jest.config.js --runInBand
 *
 * Knobs (all recorded in report.json so a run is replayable):
 *   PERF_SHOTS=10000  PERF_SEED=20260904  PERF_REPEATS=5
 *   PERF_JOURNAL_MODE=delete|wal   PERF_RUN_ID=<dir name under artifacts/perf-sqlite-sync>
 *
 * Linux numbers are an engine-shape proxy, not iPhone truth: op-sqlite ships
 * SQLite 3.51.3 on device; node:sqlite's version is written to report.json.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  finishSession,
  getAnalysis,
  getKv,
  getPendingCapture,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listActivityShots,
  listAnalysisRecords,
  listCaptureHistory,
  listLiveSessionHistory,
  listPendingCaptures,
  listRealAnalysisFacts,
  listScoredCheckpointFacts,
  listShots,
  markCaptureAnalyzed,
  purgeOwnerData,
  recentScores,
  saveAnalysis,
  saveAnalysisRecord,
  savePendingCapture,
  saveSession,
  setKv,
} from '../../src/data/repository';
import {
  drainOutbox,
  SESSION_NOT_FOUND_REJECTION,
  type SyncTransport,
} from '../../src/data/sync';
import { nextSyncRetryDelayMs } from '../../src/data/syncRuntime';
import {
  artifactPath,
  configureHarnessDriver,
  databaseFileBytes,
  getHarnessDriver,
  nowMs,
  pragmaValue,
  requireDb,
  resetRecords,
  sqliteVersion,
  type StatementRecord,
} from './nodeSqliteDriver';
import {
  buildAnalysisRecord,
  buildCapturedClip,
  buildShotAnalysis,
  createRng,
  syntheticUuid,
} from './fixtures';
import {
  heapSnapshot,
  isPlannable,
  normalizeSql,
  planFor,
  plansForRecords,
  planTable,
  round,
  sqlBreakdown,
  stats,
  writeJson,
  type PlanReport,
  type Stats,
} from './report';

jest.mock(
  '@op-engineering/op-sqlite',
  () =>
    jest.requireActual<typeof import('./nodeSqliteDriver')>(
      './nodeSqliteDriver',
    ).opSqliteShim,
);

const SHOTS = Number(process.env['PERF_SHOTS'] ?? 10_000);
const OTHER_OWNER_SHOTS = Math.max(100, Math.floor(SHOTS / 5));
const SEED = Number(process.env['PERF_SEED'] ?? 20_260_904);
const REPEATS = Number(process.env['PERF_REPEATS'] ?? 5);
const JOURNAL_MODE = (
  process.env['PERF_JOURNAL_MODE'] ?? 'delete'
).toLowerCase();
const RUN_ID =
  process.env['PERF_RUN_ID'] ??
  `${new Date().toISOString().replace(/[:.]/g, '-')}-${SHOTS}-${JOURNAL_MODE}`;
const RUN_DIR = join(process.cwd(), 'artifacts', 'perf-sqlite-sync', RUN_ID);
const SESSIONS = Math.max(4, Math.floor(SHOTS / 25));
const FINISHED_SESSIONS = Math.floor(SESSIONS * 0.75);
const NEWEST_ISO = '2026-09-01T18:00:00.000Z';
const SPAN_DAYS = 730;

const rng = createRng(SEED);
const OWNER_A = syntheticUuid(rng);
const OWNER_B = syntheticUuid(rng);
const PERMIT_PREFIX = 'permit-';
/** Owner-B shots (oldest first) whose session the server "never" knows. */
const BLOCKED_HEAD = 60;

interface ScenarioResult {
  name: string;
  repeats: number;
  wallMs: Stats;
  sqlMs: Stats;
  statementsPerRun: number;
  rowsPerRun: number;
  resultCount: number | null;
  sql: string[];
  heapBefore: ReturnType<typeof heapSnapshot>;
  /** Heap held by the LAST run's result while it is still referenced. */
  heapAfter: ReturnType<typeof heapSnapshot>;
  heapUsedDeltaMb: number;
}

interface DrainSample {
  drain: number;
  synced: number;
  failed: number;
  remaining: number;
  wallMs: number;
  sqlMs: number;
  statements: number;
  syncShotsCalls: number;
  shotsInBatch: number;
  createSessionCalls: number;
  finalizeSessionCalls: number;
  transactions: number;
}

const report: {
  runId: string;
  startedAt: string;
  inputs: Record<string, unknown>;
  engine: Record<string, unknown>;
  owners: { a: string; b: string };
  tables: Record<string, number>;
  indexes: Array<{ table: string; name: string; sql: string | null }>;
  databaseBytes: number;
  seeding: Record<string, unknown>;
  startup: Record<string, unknown>;
  scenarios: ScenarioResult[];
  plans: PlanReport[];
  outbox: Record<string, unknown>;
  ownerIsolation: Record<string, unknown>;
  purge: Record<string, unknown>;
  heap: Record<string, ReturnType<typeof heapSnapshot>>;
  assertionsFailed: string[];
} = {
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  inputs: {
    shots: SHOTS,
    otherOwnerShots: OTHER_OWNER_SHOTS,
    seed: SEED,
    repeats: REPEATS,
    journalMode: JOURNAL_MODE,
    sessions: SESSIONS,
    finishedSessions: FINISHED_SESSIONS,
    newestIso: NEWEST_ISO,
    spanDays: SPAN_DAYS,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  },
  engine: {},
  owners: { a: '', b: '' },
  tables: {},
  indexes: [],
  databaseBytes: 0,
  seeding: {},
  startup: {},
  scenarios: [],
  plans: [],
  outbox: {},
  ownerIsolation: {},
  purge: {},
  heap: {},
  assertionsFailed: [],
};

const plansBySql = new Map<string, PlanReport>();

function collectPlans(records: readonly StatementRecord[]): void {
  for (const plan of plansForRecords(records)) {
    if (!plansBySql.has(plan.sql)) plansBySql.set(plan.sql, plan);
  }
}

async function measure<T>(
  name: string,
  fn: () => Promise<T>,
  repeats = REPEATS,
): Promise<T> {
  const driver = getHarnessDriver();
  const wall: number[] = [];
  const sql: number[] = [];
  let statements = 0;
  let rows = 0;
  let last: T | undefined;
  let lastRecords: StatementRecord[] = [];
  const heapBefore = heapSnapshot();
  for (let i = 0; i < repeats; i += 1) {
    resetRecords();
    driver.recording = true;
    const started = nowMs();
    last = await fn();
    wall.push(nowMs() - started);
    driver.recording = false;
    lastRecords = resetRecords();
    sql.push(lastRecords.reduce((sum, r) => sum + r.durationMs, 0));
    statements = lastRecords.length;
    rows = lastRecords.reduce((sum, r) => sum + r.rowCount, 0);
  }
  const heapAfter = heapSnapshot();
  collectPlans(lastRecords);
  report.scenarios.push({
    name,
    repeats,
    wallMs: stats(wall),
    sqlMs: stats(sql),
    statementsPerRun: statements,
    rowsPerRun: rows,
    resultCount: Array.isArray(last) ? last.length : null,
    sql: [...new Set(lastRecords.map(r => normalizeSql(r.sql)))],
    heapBefore,
    heapAfter,
    heapUsedDeltaMb: round(heapAfter.heapUsedMb - heapBefore.heapUsedMb, 2),
  });
  return last as T;
}

function count(table: string, where = '', params: unknown[] = []): number {
  const row = requireDb()
    .prepare(`SELECT count(*) AS n FROM ${table} ${where}`)
    .get(...(params as Array<string | number>)) as { n: number };
  return Number(row.n);
}

function tableCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of [
    'local_shot',
    'local_session',
    'local_capture',
    'local_analysis_record',
    'outbox',
    'sync_receipt',
    'kv',
  ]) {
    out[table] = count(table);
  }
  return out;
}

function check(condition: boolean, label: string): void {
  if (!condition) report.assertionsFailed.push(label);
  expect({ label, ok: condition }).toEqual({ label, ok: true });
}

const shotIds: string[] = [];
const captureIds: string[] = [];
const sessionIds: string[] = [];
let sessionIdsOwnerB: string[] = [];

beforeAll(() => {
  if (existsSync(RUN_DIR)) rmSync(RUN_DIR, { recursive: true, force: true });
  configureHarnessDriver({
    dir: RUN_DIR,
    hop: true,
    openPragmas: JOURNAL_MODE === 'wal' ? ['PRAGMA journal_mode = WAL'] : [],
  });
  report.owners = { a: OWNER_A, b: OWNER_B };
});

afterAll(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  report.plans = [...plansBySql.values()];
  report.heap['final'] = heapSnapshot();
  writeJson(artifactPath('report.json'), report);
  writeJson(artifactPath('plans.json'), report.plans);
  writeJson(artifactPath('scenarios.json'), report.scenarios);
  const md = [
    `# perf-sqlite-sync run ${RUN_ID}`,
    '',
    `inputs: \`${JSON.stringify(report.inputs)}\``,
    '',
    `engine: \`${JSON.stringify(report.engine)}\``,
    '',
    '## Scenarios (ms)',
    '',
    '| scenario | wall p50 | wall p95 | sql p50 | statements | rows | results |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.scenarios.map(
      s =>
        `| ${s.name} | ${s.wallMs.p50} | ${s.wallMs.p95} | ${s.sqlMs.p50} | ${s.statementsPerRun} | ${s.rowsPerRun} | ${s.resultCount ?? '—'} |`,
    ),
    '',
    '## Query plans',
    '',
    planTable(report.plans),
    '',
  ].join('\n');
  writeJson(artifactPath('report.summary.json'), {
    runId: RUN_ID,
    dir: RUN_DIR,
    assertionsFailed: report.assertionsFailed,
    scenarios: report.scenarios.map(s => ({
      name: s.name,
      wallP50: s.wallMs.p50,
      wallP95: s.wallMs.p95,
      sqlP50: s.sqlMs.p50,
    })),
    fullScans: report.plans
      .filter(p => p.fullScan.length > 0)
      .map(p => ({ sql: p.sql, scan: p.fullScan })),
    tempBtrees: report.plans.filter(p => p.tempBtree).map(p => p.sql),
  });
  writeFileSync(artifactPath('report.md'), md);
  const db = getHarnessDriver().db;
  if (db) getDb().close();
  process.stdout.write(`\nperf-sqlite-sync artifacts: ${RUN_DIR}\n`);
});

describe(`perf-sqlite-sync @ ${SHOTS} shots (seed ${SEED}, journal ${JOURNAL_MODE})`, () => {
  it('opens the real schema through db.ts migrations on an empty file', async () => {
    const driver = getHarnessDriver();
    driver.recording = true;
    const started = nowMs();
    const db = getDb();
    const openMs = nowMs() - started;
    driver.recording = false;
    const records = resetRecords();
    report.engine = {
      sqliteVersion: sqliteVersion(),
      journalMode: pragmaValue('journal_mode'),
      synchronous: pragmaValue('synchronous'),
      pageSize: pragmaValue('page_size'),
      cacheSize: pragmaValue('cache_size'),
      opSqliteBundledSqlite:
        '3.51.3 (INFERRED from op-sqlite 18.1.4 cpp/sqlite3.h)',
    };
    report.startup['emptyDatabase'] = {
      openMs: round(openMs),
      statements: records.length,
      sqlMs: round(records.reduce((sum, r) => sum + r.durationMs, 0)),
    };
    report.heap['afterOpen'] = heapSnapshot();
    check(driver.opens === 1, 'getDb() opened exactly one connection');
    await db.execute('SELECT 1');
  });

  it(`seeds ${SHOTS} owner-A shots + captures + records + sessions and ${OTHER_OWNER_SHOTS} owner-B shots through the repository`, async () => {
    const db = getDb();
    const seedRng = createRng(SEED + 1);
    const started = nowMs();

    setActiveDataOwner(OWNER_A);
    for (let i = 0; i < SESSIONS; i += 1) {
      const id = syntheticUuid(seedRng);
      sessionIds.push(id);
      await saveSession(db, {
        id,
        mode: i % 3 === 0 ? 'live_court' : 'guided',
        shotType: i % 2 === 0 ? 'dink' : null,
        focusCheckpoint: i % 4 === 0 ? 'contact_position' : null,
        startedAt: new Date(
          Date.parse(NEWEST_ISO) - (SESSIONS - i) * 86_400_000,
        ).toISOString(),
      });
    }
    const sessionsMs = nowMs() - started;

    const shotLatency: number[] = [];
    const perThousand: Array<{ upToRow: number; p50: number; p95: number }> =
      [];
    let bucket: number[] = [];
    const shotsStarted = nowMs();
    for (let i = 0; i < SHOTS; i += 1) {
      const analysis = buildShotAnalysis(seedRng, {
        index: i,
        total: SHOTS,
        newestIso: NEWEST_ISO,
        spanDays: SPAN_DAYS,
        sessionIds,
        lowConfidenceRatio: 0.12,
      });
      shotIds.push(analysis.id);
      const t0 = nowMs();
      await saveAnalysis(db, analysis, `${PERMIT_PREFIX}${analysis.id}`);
      const dt = nowMs() - t0;
      shotLatency.push(dt);
      bucket.push(dt);
      if (bucket.length === 1000 || i === SHOTS - 1) {
        const s = stats(bucket);
        perThousand.push({ upToRow: i + 1, p50: s.p50, p95: s.p95 });
        bucket = [];
      }
    }
    const shotsMs = nowMs() - shotsStarted;

    const capturesStarted = nowMs();
    const captureRng = createRng(SEED + 2);
    for (let i = 0; i < SHOTS; i += 1) {
      const shotId = shotIds[i];
      if (!shotId) throw new Error('missing shot id');
      const captureId = syntheticUuid(captureRng);
      captureIds.push(captureId);
      const analysis = await getAnalysis(db, shotId);
      if (!analysis) throw new Error(`seeded analysis ${shotId} not readable`);
      const clip = buildCapturedClip(captureRng, i, analysis.capturedAtIso);
      await savePendingCapture(db, captureId, analysis.shotType, clip);
      if (i % 10 !== 0) {
        await saveAnalysisRecord(
          db,
          buildAnalysisRecord(captureRng, captureId, analysis),
        );
        await markCaptureAnalyzed(db, captureId);
      }
    }
    const capturesMs = nowMs() - capturesStarted;

    for (let i = 0; i < FINISHED_SESSIONS; i += 1) {
      const id = sessionIds[i];
      if (!id) throw new Error('missing session id');
      await finishSession(db, id, { shots: 25, averageScore: 71 });
    }
    await setKv(db, `home.week-chart:${OWNER_A}`, 'scores');

    setActiveDataOwner(OWNER_B);
    const bRng = createRng(SEED + 3);
    sessionIdsOwnerB = [syntheticUuid(bRng), syntheticUuid(bRng)];
    for (const id of sessionIdsOwnerB) {
      await saveSession(db, {
        id,
        mode: 'live_court',
        shotType: null,
        focusCheckpoint: null,
        startedAt: NEWEST_ISO,
      });
    }
    // Owner B's oldest BLOCKED_HEAD shots (lowest outbox ids) all belong to
    // session B0, the rest to session B1 — the head-of-line probe below
    // rejects B0 shots with a transient code and watches whether B1 shots
    // queued behind them ever reach the transport.
    const [sessionB0, sessionB1] = sessionIdsOwnerB;
    if (!sessionB0 || !sessionB1) throw new Error('owner B sessions missing');
    for (let i = 0; i < OTHER_OWNER_SHOTS; i += 1) {
      const analysis = buildShotAnalysis(bRng, {
        index: i,
        total: OTHER_OWNER_SHOTS,
        newestIso: NEWEST_ISO,
        spanDays: 30,
        sessionIds: [i < BLOCKED_HEAD ? sessionB0 : sessionB1],
        sessionRatio: 1,
        lowConfidenceRatio: 0.1,
      });
      await saveAnalysis(db, analysis, `${PERMIT_PREFIX}${analysis.id}`);
    }
    setActiveDataOwner(OWNER_A);

    report.tables = tableCounts();
    report.databaseBytes = databaseFileBytes();
    report.indexes = (
      requireDb()
        .prepare(
          `SELECT tbl_name AS tbl, name, sql FROM sqlite_master WHERE type = 'index' ORDER BY tbl_name, name`,
        )
        .all() as Array<{ tbl: string; name: string; sql: string | null }>
    ).map(row => ({ table: row.tbl, name: row.name, sql: row.sql }));
    const payloadBytes = requireDb()
      .prepare(
        `SELECT avg(length(payload)) AS avg_shot, sum(length(payload)) AS total_shot,
                (SELECT sum(length(payload)) FROM outbox) AS total_outbox,
                (SELECT avg(length(payload)) FROM local_capture) AS avg_capture,
                (SELECT avg(length(record)) FROM local_analysis_record) AS avg_record
         FROM local_shot`,
      )
      .get() as Record<string, number>;
    report.seeding = {
      totalMs: round(nowMs() - started),
      sessionsMs: round(sessionsMs),
      shotsMs: round(shotsMs),
      capturesAndRecordsMs: round(capturesMs),
      saveAnalysisLatencyMs: stats(shotLatency),
      saveAnalysisLatencyByThousand: perThousand,
      payloadBytes: {
        avgShotPayload: round(payloadBytes['avg_shot'] ?? 0, 0),
        totalShotPayload: payloadBytes['total_shot'],
        totalOutboxPayload: payloadBytes['total_outbox'],
        avgCapturePayload: round(payloadBytes['avg_capture'] ?? 0, 0),
        avgAnalysisRecord: round(payloadBytes['avg_record'] ?? 0, 0),
      },
      databaseBytes: report.databaseBytes,
    };
    report.heap['afterSeed'] = heapSnapshot();

    check(
      report.tables['local_shot'] === SHOTS + OTHER_OWNER_SHOTS,
      'local_shot row count',
    );
    check(report.tables['local_capture'] === SHOTS, 'local_capture row count');
    check(
      report.tables['outbox'] ===
        SHOTS + SESSIONS + FINISHED_SESSIONS + OTHER_OWNER_SHOTS + 2,
      'outbox backlog = every shot + session create/finalize row',
    );
  });

  it('measures repository read paths at scale (owner A active)', async () => {
    const db = getDb();
    setActiveDataOwner(OWNER_A);
    const newestId = shotIds[shotIds.length - 1];
    const oldestId = shotIds[0];
    const midCapture = captureIds[Math.floor(captureIds.length / 2)];
    if (!newestId || !oldestId || !midCapture) throw new Error('seed missing');

    const shots250 = await measure('listShots(250) [Home]', () =>
      listShots(db, 250),
    );
    check(shots250.length === 250, 'listShots(250) returns 250 rows');
    check(
      shots250.every(
        (row, i, all) =>
          i === 0 || (all[i - 1]?.capturedAt ?? '') >= row.capturedAt,
      ),
      'listShots(250) newest-first',
    );
    await measure('listShots(100) [Library]', () => listShots(db, 100));
    await measure('listShots(200) [strokeResultData]', () =>
      listShots(db, 200),
    );
    const activity = await measure(
      'listActivityShots() unbounded [consistency store]',
      () => listActivityShots(db),
    );
    check(
      activity.length === SHOTS,
      'listActivityShots returns every owner-A shot and no owner-B shot',
    );
    await measure('recentScores(null, 30)', () => recentScores(db, null, 30));
    await measure("recentScores('dink', 30)", () =>
      recentScores(db, 'dink', 30),
    );
    const facts1000 = await measure(
      'listRealAnalysisFacts(1000) [Home default]',
      () => listRealAnalysisFacts(db),
    );
    check(
      facts1000.length === Math.min(1000, SHOTS),
      'listRealAnalysisFacts default limit 1000',
    );
    await measure('listRealAnalysisFacts(200) [Result]', () =>
      listRealAnalysisFacts(db, 200),
    );
    const factsAll = await measure(
      'listRealAnalysisFacts(null) unbounded [Progress]',
      () => listRealAnalysisFacts(db, null),
    );
    check(
      factsAll.length === SHOTS,
      'listRealAnalysisFacts(null) returns every owner-A shot',
    );
    await measure('listScoredCheckpointFacts() [DrillLibrary]', () =>
      listScoredCheckpointFacts(db),
    );
    await measure('getAnalysis(newest)', () => getAnalysis(db, newestId));
    await measure('getAnalysis(oldest)', () => getAnalysis(db, oldestId));
    const pending = await measure('listPendingCaptures(100) [Library]', () =>
      listPendingCaptures(db, 100),
    );
    check(
      pending.every(p => p.evidenceStatus === 'valid'),
      'seeded capture payloads parse as valid',
    );
    const history = await measure(
      'listCaptureHistory(null) unbounded [Progress]',
      () => listCaptureHistory(db, null),
    );
    check(
      history.length === SHOTS,
      'listCaptureHistory(null) returns every owner-A capture',
    );
    await measure('getPendingCapture(mid)', () =>
      getPendingCapture(db, midCapture),
    );
    await measure('listAnalysisRecords(mid capture)', () =>
      listAnalysisRecords(db, midCapture),
    );
    await measure('listLiveSessionHistory(60)', () =>
      listLiveSessionHistory(db, 60),
    );
    await measure('getKv(week chart)', () =>
      getKv(db, `home.week-chart:${OWNER_A}`),
    );
    await measure('hasShotSyncReceipt(newest) before any drain', () =>
      hasShotSyncReceipt(db, newestId),
    );
    const status = await measure(
      `getShotOutboxStatus(newest) with ${report.tables['outbox']} queued rows [Result]`,
      () => getShotOutboxStatus(db, newestId),
    );
    check(status.state === 'queued', 'newest shot is queued before drain');
    await measure(
      `getShotOutboxStatus(oldest) with ${report.tables['outbox']} queued rows [Result]`,
      () => getShotOutboxStatus(db, oldestId),
    );

    await measure(
      'SCREEN Home = listShots(250)+listRealAnalysisFacts(1000)+getKv',
      async () => {
        await Promise.all([
          listShots(db, 250),
          listRealAnalysisFacts(db),
          getKv(db, `home.week-chart:${OWNER_A}`),
        ]);
      },
    );
    await measure(
      'SCREEN Progress = listRealAnalysisFacts(null)+listCaptureHistory(null)',
      async () => {
        await Promise.all([
          listRealAnalysisFacts(db, null),
          listCaptureHistory(db, null),
        ]);
      },
    );
    await measure(
      'SCREEN Library = listShots(100)+listPendingCaptures(100)',
      async () => {
        await Promise.all([listShots(db, 100), listPendingCaptures(db, 100)]);
      },
    );
    await measure(
      'SCREEN Result sync evidence = hasShotSyncReceipt+getShotOutboxStatus',
      async () => {
        if (!(await hasShotSyncReceipt(db, newestId))) {
          await getShotOutboxStatus(db, newestId);
        }
      },
    );
    report.heap['afterReads'] = heapSnapshot();
  });

  it('verifies owner isolation across every read path', async () => {
    const db = getDb();
    setActiveDataOwner(OWNER_B);
    const bShots = await listShots(db, 100_000);
    const bActivity = await listActivityShots(db);
    const bFacts = await listRealAnalysisFacts(db, null);
    const bHistory = await listCaptureHistory(db, null);
    const bSessions = await listLiveSessionHistory(db, 1000);
    const bPending = await listPendingCaptures(db, 1000);
    const aNewest = shotIds[shotIds.length - 1];
    if (!aNewest) throw new Error('seed missing');
    const crossRead = await getAnalysis(db, aNewest);
    const crossStatus = await getShotOutboxStatus(db, aNewest);
    setActiveDataOwner(OWNER_A);
    report.ownerIsolation = {
      ownerB: {
        listShots: bShots.length,
        listActivityShots: bActivity.length,
        listRealAnalysisFacts: bFacts.length,
        listCaptureHistory: bHistory.length,
        listLiveSessionHistory: bSessions.length,
        listPendingCaptures: bPending.length,
        getAnalysisOfOwnerAShot: crossRead,
        getShotOutboxStatusOfOwnerAShot: crossStatus,
      },
    };
    check(
      bShots.length === OTHER_OWNER_SHOTS,
      'owner B listShots sees only its rows',
    );
    check(
      bActivity.length === OTHER_OWNER_SHOTS,
      'owner B activity sees only its rows',
    );
    check(
      bFacts.length === OTHER_OWNER_SHOTS,
      'owner B facts see only its rows',
    );
    check(bHistory.length === 0, 'owner B has no captures');
    check(
      bSessions.length === 0,
      'owner B live sessions incomplete → none listed',
    );
    check(bPending.length === 0, 'owner B has no pending captures');
    check(crossRead === null, "owner B cannot read owner A's shot by id");
    check(
      crossStatus.state === 'absent',
      "owner B sees owner A's outbox row as absent",
    );
  });

  it('drains the outbox backlog through sync.ts and records batching', async () => {
    const db = getDb();
    setActiveDataOwner(OWNER_A);
    const driver = getHarnessDriver();
    const backlog = count('outbox', 'WHERE owner_key = ?', [OWNER_A]);
    const ownerBBefore = count('outbox', 'WHERE owner_key = ?', [OWNER_B]);
    let syncShotsCalls = 0;
    let createSessionCalls = 0;
    let finalizeSessionCalls = 0;
    let shotsInBatch = 0;
    const batchSizes: number[] = [];
    const transport: SyncTransport = {
      async syncShots(shots) {
        syncShotsCalls += 1;
        shotsInBatch += shots.length;
        batchSizes.push(shots.length);
        return {
          acceptedIds: shots.map(shot => String((shot as { id: string }).id)),
          rejected: [],
        };
      },
      async createSession() {
        createSessionCalls += 1;
      },
      async finalizeSession() {
        finalizeSessionCalls += 1;
      },
    };

    const samples: DrainSample[] = [];
    const firstPlanRecords: StatementRecord[] = [];
    let remaining = backlog;
    let guard = 0;
    const drainStarted = nowMs();
    while (remaining > 0 && guard < backlog) {
      guard += 1;
      syncShotsCalls = 0;
      createSessionCalls = 0;
      finalizeSessionCalls = 0;
      shotsInBatch = 0;
      resetRecords();
      driver.recording = true;
      const t0 = nowMs();
      const result = await drainOutbox(db, transport);
      const wall = nowMs() - t0;
      driver.recording = false;
      const records = resetRecords();
      if (firstPlanRecords.length === 0) firstPlanRecords.push(...records);
      remaining = result.remaining;
      samples.push({
        drain: guard,
        synced: result.synced,
        failed: result.failed,
        remaining: result.remaining,
        wallMs: round(wall),
        sqlMs: round(records.reduce((sum, r) => sum + r.durationMs, 0)),
        statements: records.length,
        syncShotsCalls,
        shotsInBatch,
        createSessionCalls,
        finalizeSessionCalls,
        transactions: records.filter(r => r.sql === 'BEGIN IMMEDIATE').length,
      });
    }
    const drainWallMs = nowMs() - drainStarted;
    collectPlans(firstPlanRecords);

    const ownerBAfter = count('outbox', 'WHERE owner_key = ?', [OWNER_B]);
    const receipts = count('sync_receipt', 'WHERE owner_key = ?', [OWNER_A]);
    const expectedDrains = Math.ceil(backlog / 50);
    const retryDelayMs = nextSyncRetryDelayMs(0, () => 0.5);
    const first = samples[0];
    const breakdown = sqlBreakdown(firstPlanRecords);

    report.outbox = {
      backlogRows: backlog,
      drainsToEmpty: samples.length,
      expectedDrainsAtLimit50: expectedDrains,
      totalDrainWallMs: round(drainWallMs),
      perDrain: {
        wallMs: stats(samples.map(s => s.wallMs)),
        sqlMs: stats(samples.map(s => s.sqlMs)),
        statements: stats(samples.map(s => s.statements)),
        transactions: stats(samples.map(s => s.transactions)),
        rowsProcessed: stats(samples.map(s => s.synced + s.failed)),
        syncShotsCalls: stats(samples.map(s => s.syncShotsCalls)),
        shotBatchSize: stats(batchSizes),
      },
      firstDrainSqlBreakdown: breakdown,
      receiptsWritten: receipts,
      ownerBOutboxBefore: ownerBBefore,
      ownerBOutboxAfter: ownerBAfter,
      runtimeProjection: {
        note: 'syncRuntime.ts schedules the next drain nextSyncRetryDelayMs(0) after a drain that leaves rows behind; it does not loop while remaining > 0',
        retryDelayMsAtZeroFailures: retryDelayMs,
        minutesToClearBacklogAtCadence: round(
          ((samples.length - 1) * retryDelayMs) / 60_000,
          1,
        ),
        minutesToClear500RowBacklog: round(
          ((Math.ceil(500 / 50) - 1) * retryDelayMs) / 60_000,
          1,
        ),
      },
      samplesHead: samples.slice(0, 5),
      samplesTail: samples.slice(-3),
    };
    writeJson(artifactPath('outbox-drains.json'), samples);

    check(remaining === 0, 'backlog fully drained');
    check(
      samples.length === expectedDrains,
      `drains to empty = ceil(${backlog}/50)`,
    );
    check(
      samples.every(s => s.syncShotsCalls <= 1),
      'at most one syncShots call per drain',
    );
    check(
      samples.every(s => s.synced + s.failed <= 50),
      'never more than 50 rows per drain',
    );
    check(
      samples.every(s => s.failed === 0),
      'no failures with an accepting transport',
    );
    check(
      ownerBAfter === ownerBBefore,
      "owner B's queued rows untouched by owner A's drain",
    );
    check(receipts === SHOTS, 'one sync_receipt per owner-A shot');
    check(
      first !== undefined && first.transactions === first.shotsInBatch,
      'one BEGIN IMMEDIATE transaction per accepted shot (per-row receipt/delete)',
    );
  });

  it('probes head-of-line blocking: transient rejections at the queue head vs syncable rows behind them (owner B)', async () => {
    const db = getDb();
    setActiveDataOwner(OWNER_B);
    const [sessionB0] = sessionIdsOwnerB;
    if (!sessionB0) throw new Error('owner B sessions missing');
    const backlog = count('outbox', 'WHERE owner_key = ?', [OWNER_B]);
    const syncable = OTHER_OWNER_SHOTS - BLOCKED_HEAD;
    let offered = 0;
    const offeredIds = new Set<string>();
    const transport: SyncTransport = {
      async syncShots(shots) {
        const typed = shots as Array<{ id: string; sessionId: string | null }>;
        offered += typed.length;
        for (const shot of typed) offeredIds.add(shot.id);
        return {
          acceptedIds: typed
            .filter(shot => shot.sessionId !== sessionB0)
            .map(shot => shot.id),
          rejected: typed
            .filter(shot => shot.sessionId === sessionB0)
            .map(shot => ({
              id: shot.id,
              code: SESSION_NOT_FOUND_REJECTION,
              message: 'harness: session never reaches the server',
            })),
        };
      },
      async createSession() {},
      async finalizeSession() {},
    };
    const drains: Array<{
      drain: number;
      synced: number;
      failed: number;
      remaining: number;
      offeredThisDrain: number;
      maxAttemptsInQueue: number;
    }> = [];
    const DRAINS = 12;
    for (let i = 0; i < DRAINS; i += 1) {
      const before = offered;
      const result = await drainOutbox(db, transport);
      const maxAttempts = requireDb()
        .prepare(
          'SELECT coalesce(max(attempts), 0) AS n FROM outbox WHERE owner_key = ?',
        )
        .get(OWNER_B) as { n: number };
      drains.push({
        drain: i + 1,
        ...result,
        offeredThisDrain: offered - before,
        maxAttemptsInQueue: Number(maxAttempts.n),
      });
    }
    const receipts = count('sync_receipt', 'WHERE owner_key = ?', [OWNER_B]);
    const distinctOffered = offeredIds.size;
    const remaining = count('outbox', 'WHERE owner_key = ?', [OWNER_B]);
    const projectedMinutes = round(
      (DRAINS * nextSyncRetryDelayMs(0, () => 0.5)) / 60_000,
      1,
    );
    setActiveDataOwner(OWNER_A);
    report.outbox['headOfLineProbe'] = {
      ownerBBacklogRows: backlog,
      blockedHeadShots: BLOCKED_HEAD,
      syncableShotsBehindThem: syncable,
      drains,
      distinctShotIdsEverOffered: distinctOffered,
      receiptsForOwnerB: receipts,
      remainingRows: remaining,
      wallClockMinutesTheseDrainsRepresentAtRuntimeCadence: projectedMinutes,
      verdict:
        receipts === syncable
          ? 'syncable rows behind the blocked head were delivered'
          : `${syncable - receipts} syncable shots never offered to the transport after ${DRAINS} drains`,
    };
    writeJson(
      artifactPath('outbox-head-of-line.json'),
      report.outbox['headOfLineProbe'],
    );
    check(
      drains.every(d => d.maxAttemptsInQueue === 0),
      'transient rejection never consumes the attempt budget',
    );
    check(
      remaining === BLOCKED_HEAD + (syncable - receipts),
      'remaining = blocked head + undelivered syncable rows',
    );
  });

  it('measures post-drain sync-evidence reads and startup migrations on the populated file', async () => {
    let db = getDb();
    setActiveDataOwner(OWNER_A);
    const newestId = shotIds[shotIds.length - 1];
    if (!newestId) throw new Error('seed missing');
    const receipt = await measure(
      'hasShotSyncReceipt(newest) after drain',
      () => hasShotSyncReceipt(db, newestId),
    );
    check(receipt === true, 'receipt recorded for drained shot');
    const status = await measure(
      `getShotOutboxStatus(newest) with ${count('outbox')} queued rows (owner B backlog only)`,
      () => getShotOutboxStatus(db, newestId),
    );
    check(status.state === 'absent', 'drained shot absent from outbox');

    const driver = getHarnessDriver();
    const reopenSamples: Array<{
      openMs: number;
      sqlMs: number;
      statements: number;
      slowest: Array<{ sql: string; ms: number }>;
    }> = [];
    for (let i = 0; i < 3; i += 1) {
      db.close();
      check(driver.db === null, 'close() released the connection');
      resetRecords();
      driver.recording = true;
      const t0 = nowMs();
      db = getDb();
      const openMs = nowMs() - t0;
      driver.recording = false;
      const records = resetRecords();
      reopenSamples.push({
        openMs: round(openMs),
        sqlMs: round(records.reduce((sum, r) => sum + r.durationMs, 0)),
        statements: records.length,
        slowest: [...records]
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, 5)
          .map(r => ({ sql: normalizeSql(r.sql), ms: round(r.durationMs) })),
      });
      if (i === 0) {
        for (const r of records) {
          if (isPlannable(r.sql) && !plansBySql.has(normalizeSql(r.sql))) {
            plansBySql.set(normalizeSql(r.sql), planFor(r.sql, r.params));
          }
        }
      }
    }
    report.startup['populatedDatabase'] = {
      rows: tableCounts(),
      reopens: reopenSamples,
      openMs: stats(reopenSamples.map(s => s.openMs)),
    };
    check(
      (await listShots(db, 1)).length === 1,
      'reopened database still serves owner-A shots',
    );
  });

  it('purges owner B (and then owner A) through purgeOwnerData', async () => {
    const db = getDb();
    const purge = async (owner: string): Promise<number> => {
      resetRecords();
      getHarnessDriver().recording = true;
      const t0 = nowMs();
      await purgeOwnerData(db, owner);
      const ms = nowMs() - t0;
      getHarnessDriver().recording = false;
      collectPlans(resetRecords());
      return round(ms);
    };
    const bMs = await purge(OWNER_B);
    const afterB = tableCounts();
    const aMs = await purge(OWNER_A);
    const afterA = tableCounts();
    report.purge = {
      ownerB: { ms: bMs, rowsRemoved: OTHER_OWNER_SHOTS, tablesAfter: afterB },
      ownerA: { ms: aMs, tablesAfter: afterA },
    };
    check(
      afterB['local_shot'] === SHOTS,
      'purging owner B leaves owner A intact',
    );
    check(
      afterA['local_shot'] === 0 && afterA['outbox'] === 0,
      'purging owner A empties its tables',
    );
  });
});
