/**
 * xc-perf-startup-hydrate — cost of the SYNCHRONOUS work `getDb()` performs on
 * the JS thread the first time it is called in a launch (`openMigrated()` in
 * src/data/db.ts: LOCAL_MIGRATIONS + ensureAccountScopedSchema, every launch).
 *
 * The real `db.ts` is executed; only `@op-engineering/op-sqlite` is replaced
 * with a `node:sqlite`-backed shim so the same statements run against a real
 * SQLite engine on Linux. Absolute numbers are a LINUX PROXY (desktop CPU,
 * ext4, no iOS file protection) — the shape (which statements scale with row
 * count, and how) is what this measures; iPhone wall-clock is UNKNOWN from
 * here.
 *
 * Run (needs Node's experimental sqlite):
 *   cd apps/mobile && NODE_OPTIONS=--experimental-sqlite \
 *     npx jest --ci __tests__/xc/perfStartupSqliteOpenCost.test.ts
 * Scale: XC_PERF_SQLITE_ROWS (comma list, default "0,1000,10000,50000"),
 *        XC_PERF_SQLITE_REPS (default 5).
 */
import {
  OUT_DIR,
  heapSnapshot,
  nodeEnv,
  nodeFs,
  nodeOs,
  nodePath,
  nodePerf,
  percentile,
  writeArtifact,
} from '../../__perf__/perfStartupHarness';

declare const require: (id: string) => unknown;
const { performance } = nodePerf;

/** `node:sqlite` needs `--experimental-sqlite` on Node 22; without it this
 * probe is reported as SKIPPED (never as passed). */
const nodeSqliteAvailable = (() => {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const describeProbe = nodeSqliteAvailable ? describe : describe.skip;

// ─── op-sqlite shim over node:sqlite ─────────────────────────────────────────

interface NodeSqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (file: string) => NodeSqliteDatabase;
}
type FactoryPath = { join: (...parts: string[]) => string };
type FactoryPerf = { performance: { now: () => number } };

const mockSqliteShim = {
  dir: nodePath.join(OUT_DIR, 'sqlite-open-cost'),
  file: '',
  statements: [] as Array<{ sql: string; ms: number }>,
  timing: false,
};

jest.mock('@op-engineering/op-sqlite', () => {
  // Factory runs before imports are bound: resolve node modules locally.
  const { DatabaseSync } = require('node:sqlite') as NodeSqliteModule;
  const factoryPath = require('path') as FactoryPath;
  const { performance: perf } = require('perf_hooks') as FactoryPerf;
  const isRowQuery = (sql: string) => /^\s*(SELECT|PRAGMA|WITH)/i.test(sql);
  return {
    open: ({ name }: { name: string }) => {
      const file =
        mockSqliteShim.file || factoryPath.join(mockSqliteShim.dir, name);
      const db = new DatabaseSync(file);
      const executeSync = (sql: string, params: unknown[] = []) => {
        const t0 = perf.now();
        let rows: unknown[] = [];
        if (isRowQuery(sql)) rows = db.prepare(sql).all(...params);
        else if (params.length) db.prepare(sql).run(...params);
        else db.exec(sql);
        if (mockSqliteShim.timing)
          mockSqliteShim.statements.push({
            sql: sql.replace(/\s+/g, ' ').trim().slice(0, 90),
            ms: perf.now() - t0,
          });
        return { rows };
      };
      return {
        executeSync,
        execute: async (sql: string, params: unknown[] = []) =>
          executeSync(sql, params),
        close: () => db.close(),
      };
    },
  };
});

// Required lazily so the op-sqlite mock factory (and node:sqlite) only load
// when the probe actually runs.
const loadDb = () =>
  require('../../src/data/db') as typeof import('../../src/data/db');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ROW_COUNTS: number[] = String(
  nodeEnv.XC_PERF_SQLITE_ROWS ?? '0,1000,10000,50000',
)
  .split(',')
  .map(Number);
const REPS = Number(nodeEnv.XC_PERF_SQLITE_REPS ?? 5);

function freshFile(tag: string): string {
  nodeFs.mkdirSync(mockSqliteShim.dir, { recursive: true });
  const file = nodePath.join(mockSqliteShim.dir, `${tag}.db`);
  for (const suffix of ['', '-journal', '-wal', '-shm'])
    nodeFs.rmSync(file + suffix, { force: true });
  return file;
}

/** Populate a CURRENT-schema database with N real shots/sessions/captures + a few outbox rows. */
function seedRows(file: string, n: number): void {
  const { DatabaseSync } = require('node:sqlite') as NodeSqliteModule;
  const db = new DatabaseSync(file);
  db.exec('BEGIN');
  const shot = db.prepare(
    `INSERT INTO local_shot (owner_key,id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload)
     VALUES ('owner-a',?,?,'forehand_drive',?,72.5,0.9,'scored','real',0,?)`,
  );
  const session = db.prepare(
    `INSERT INTO local_session (owner_key,id,mode,shot_type,focus_checkpoint,started_at,ended_at,completed,summary)
     VALUES ('owner-a',?,'practice','forehand_drive','contact_position',?,?,1,'{"shots":10}')`,
  );
  const capture = db.prepare(
    `INSERT INTO local_capture (owner_key,id,uri,shot_type,captured_at,duration_ms,fps,width,height,status,payload)
     VALUES ('owner-a',?,?,'forehand_drive',?,4000,30,1080,1920,'analyzed','{}')`,
  );
  const payload = JSON.stringify({
    source: 'real',
    checkpoints: Array.from({ length: 12 }, (_, i) => ({ i, score: 70 + i })),
  });
  for (let i = 0; i < n; i++) {
    const ts = new Date(1_700_000_000_000 + i * 60_000).toISOString();
    if (i % 10 === 0) session.run(`session-${i / 10}`, ts, ts);
    shot.run(`shot-${i}`, `session-${Math.floor(i / 10)}`, ts, payload);
    if (i % 5 === 0)
      capture.run(`capture-${i}`, `file:///captures/${i}.mov`, ts);
  }
  const outbox = db.prepare(
    `INSERT INTO outbox (owner_key,kind,payload,attempts) VALUES ('owner-a','shot.sync',?,0)`,
  );
  for (let i = 0; i < Math.min(n, 200); i++)
    outbox.run(JSON.stringify({ source: 'real', id: `shot-${i}` }));
  db.exec('COMMIT');
  db.close();
}

/** A pre-account-scope legacy schema (no owner_key, single-column PKs) with N rows — exercises the table rebuilds. */
function seedLegacySchema(file: string, n: number): void {
  const { DatabaseSync } = require('node:sqlite') as NodeSqliteModule;
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE local_shot (id TEXT PRIMARY KEY, session_id TEXT, shot_type TEXT NOT NULL, captured_at TEXT NOT NULL,
     overall_score REAL, confidence REAL NOT NULL, result_kind TEXT NOT NULL, source TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`);
  db.exec(`CREATE TABLE local_session (id TEXT PRIMARY KEY, mode TEXT NOT NULL, shot_type TEXT, focus_checkpoint TEXT,
     started_at TEXT NOT NULL, ended_at TEXT, completed INTEGER NOT NULL DEFAULT 0, summary TEXT)`);
  db.exec(`CREATE TABLE local_capture (id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE, shot_type TEXT NOT NULL, captured_at TEXT NOT NULL,
     duration_ms INTEGER NOT NULL, fps REAL NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')))`);
  db.exec(`CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`);
  db.exec('BEGIN');
  const shot = db.prepare(
    `INSERT INTO local_shot (id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload)
     VALUES (?,?,'forehand_drive',?,72.5,0.9,'scored','real',0,'{"source":"real"}')`,
  );
  const session = db.prepare(
    `INSERT INTO local_session (id,mode,shot_type,focus_checkpoint,started_at,ended_at,completed,summary) VALUES (?,'practice','forehand_drive','contact_position',?,?,1,'{}')`,
  );
  for (let i = 0; i < n; i++) {
    const ts = new Date(1_700_000_000_000 + i * 60_000).toISOString();
    if (i % 10 === 0) session.run(`session-${i / 10}`, ts, ts);
    shot.run(`shot-${i}`, `session-${Math.floor(i / 10)}`, ts);
  }
  db.exec('COMMIT');
  db.close();
}

interface OpenSample {
  case: string;
  rows: number;
  rep: number;
  openMs: number;
  statementCount: number;
  topStatements: Array<{ sql: string; ms: number }>;
}

function timeOpen(
  caseName: string,
  rows: number,
  rep: number,
  file: string,
): OpenSample {
  mockSqliteShim.file = file;
  mockSqliteShim.statements.length = 0;
  mockSqliteShim.timing = true;
  const t0 = performance.now();
  const db = loadDb().getDb(); // first call in this "launch": open + every migration statement, synchronously
  const openMs = performance.now() - t0;
  mockSqliteShim.timing = false;
  db.close(); // resets db.ts's singleton so the next call re-opens (= next launch)
  const top = [...mockSqliteShim.statements]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5);
  return {
    case: caseName,
    rows,
    rep,
    openMs,
    statementCount: mockSqliteShim.statements.length,
    topStatements: top,
  };
}

const samples: OpenSample[] = [];

describeProbe(
  'xc-perf-startup-hydrate: synchronous getDb() open+migrate cost (node:sqlite proxy)',
  () => {
    afterAll(() => {
      const groups = new Map<string, number[]>();
      for (const s of samples) {
        const key = `${s.case}@${s.rows}`;
        groups.set(key, [...(groups.get(key) ?? []), s.openMs]);
      }
      const summary = [...groups.entries()].map(([key, xs]) => ({
        case: key,
        reps: xs.length,
        medianMs: Math.round(percentile(xs, 0.5) * 100) / 100,
        p90Ms: Math.round(percentile(xs, 0.9) * 100) / 100,
        maxMs: Math.round(Math.max(...xs) * 100) / 100,
        statementCount: samples.find(s => `${s.case}@${s.rows}` === key)
          ?.statementCount,
        slowestStatements: samples
          .filter(s => `${s.case}@${s.rows}` === key)
          .sort((a, b) => b.openMs - a.openMs)[0]
          ?.topStatements.map(t => `${t.ms.toFixed(2)}ms ${t.sql}`),
      }));
      writeArtifact('sqlite_open_cost.json', {
        proxy: `node:sqlite on ${nodeOs.platform()}/${nodeOs.arch()} (${nodeOs.cpus()[0]?.model ?? 'unknown cpu'}) — NOT iPhone timing`,
        heap: heapSnapshot(),
        summary,
        samples,
      });
      nodeFs.rmSync(mockSqliteShim.dir, { recursive: true, force: true });
    });

    it('fresh install: creates the schema from nothing', () => {
      for (let rep = 0; rep < REPS; rep++) {
        const file = freshFile(`fresh-${rep}`);
        samples.push(timeOpen('fresh-install', 0, rep, file));
      }
      expect(samples.filter(s => s.case === 'fresh-install')).toHaveLength(
        REPS,
      );
    });

    for (const rows of ROW_COUNTS) {
      it(`warm launch on a current-schema DB with ${rows} shots: every launch re-runs the 3 fixture DELETEs + 8 PRAGMA probes`, () => {
        const file = freshFile(`warm-${rows}`);
        timeOpen('schema-only-setup', rows, -1, file); // create schema via the real migrations
        seedRows(file, rows);
        for (let rep = 0; rep < REPS; rep++)
          samples.push(timeOpen('warm-launch', rows, rep, file));
        const mine = samples.filter(
          s => s.case === 'warm-launch' && s.rows === rows,
        );
        expect(mine).toHaveLength(REPS);
        // Nothing is versioned: LOCAL_MIGRATIONS (11 statements) + the
        // account-scope PRAGMA probes run on every launch.
        for (const s of mine) expect(s.statementCount).toBe(25);
      });
    }

    for (const rows of ROW_COUNTS.filter(n => n > 0)) {
      it(`one-time legacy → account-scoped rebuild with ${rows} shots (first launch after the 2026 account-scope release)`, () => {
        const file = freshFile(`legacy-${rows}`);
        seedLegacySchema(file, rows);
        samples.push(timeOpen('legacy-rebuild', rows, 0, file));
        // Second launch on the same file must be a plain warm launch again.
        samples.push(timeOpen('legacy-rebuild-then-warm', rows, 1, file));
        const rebuild = samples.find(
          s => s.case === 'legacy-rebuild' && s.rows === rows,
        )!;
        const warm = samples.find(
          s => s.case === 'legacy-rebuild-then-warm' && s.rows === rows,
        )!;
        expect(rebuild.statementCount).toBeGreaterThan(warm.statementCount);
      });
    }

    it('no migration versioning: a warm launch re-runs every statement except the three one-time ADD COLUMNs on local_capture', () => {
      const fresh = samples.find(s => s.case === 'fresh-install')!;
      const warm = samples.find(s => s.case === 'warm-launch' && s.rows === 0)!;
      // fresh: 11 LOCAL_MIGRATIONS + BEGIN + 3 PK probes + 5 column probes +
      // 3 ADD COLUMN + 3 CREATE INDEX + 1 CREATE TABLE + COMMIT = 28
      expect(fresh.statementCount).toBe(28);
      expect(warm.statementCount).toBe(fresh.statementCount - 3);
    });
  },
);
