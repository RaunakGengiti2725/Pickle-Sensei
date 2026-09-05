/**
 * STRESS `mod-db` / lens `boundary-malformed`: src/data/db.ts open + migrate
 * against generated hostile persisted state.
 *
 * Every scenario is derived from a 32-bit seed (mulberry32) and drives the
 * PRODUCTION getDb() — LOCAL_MIGRATIONS + ensureAccountScopedSchema — over a
 * REAL SQLite file (node:sqlite, Node >= 22.13) through the same
 * `@op-engineering/op-sqlite` seam the app uses. Each seed picks a historical
 * or future schema, fills it with malformed rows (truncated/JSON5/deep/NUL/
 * 64KB–1MB/prototype-key/unicode-pair/path-traversal/overflow cells), opens,
 * and checks the outcome against a pure-TS oracle of the purge statements:
 *
 *   - open never throws on malformed rows; integrity_check = ok;
 *   - exactly the fixture rows the statements target disappear and every
 *     other row survives byte-for-byte (owner bucket / new-column defaults
 *     asserted for legacy shapes; future columns/tables/user_version kept);
 *   - hostile params/SQL through LocalDb.execute settle as rejections, leave
 *     the handle usable and write nothing;
 *   - injected I/O throw / disk-full / locked file / read-only file / garbage
 *     file: getDb throws the original error, closes the handle exactly once,
 *     caches nothing, loses no real row, and converges to the control once
 *     the fault clears;
 *   - a second launch is a byte-identical no-op; same-process concurrency on
 *     the cached handle settles.
 *
 * Default run: STRESS_ITER (default 40) seeds from STRESS_SEED (default
 * 20260905). Full campaign: STRESS_ITER=3000. Replay: STRESS_ONLY=<seed[,seed]>.
 * Artifacts (seed → outcome JSON + summary) land in STRESS_ARTIFACT_DIR
 * (default artifacts/stress/db-boundary-malformed/ at the repo root).
 */
import type { LocalDb } from '../../src/data/db';
import {
  fs,
  loadNodeSqlite,
  openSqlite as mockOpenSqlite,
  nodeProcess,
  path,
  type SqliteDatabaseSync,
  type SqlInputValue,
} from '../../stress-harness/db-boundary-malformed/node';
import {
  describeScenario,
  generateScenario,
  type OpSqliteMockState,
  runScenario,
  type ScenarioResult,
} from '../../stress-harness/db-boundary-malformed/scenario';

declare const __dirname: string;

const mockSqlite = loadNodeSqlite();

// ─── op-sqlite seam ───────────────────────────────────────────────────────────

const mockState: OpSqliteMockState = {
  file: '',
  opens: 0,
  statements: [],
  fault: null,
  maxPageCount: null,
  lastHandle: null,
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockSqlite) throw new Error('node:sqlite unavailable');
    if (!mockState.file) throw new Error('harness did not set a database file');
    mockState.opens += 1;
    const real: SqliteDatabaseSync = mockOpenSqlite(mockSqlite, mockState.file);
    if (mockState.maxPageCount !== null) {
      real.exec(`PRAGMA max_page_count = ${mockState.maxPageCount}`);
    }
    const handle = { closed: 0 };
    mockState.lastHandle = handle;
    let executed = 0;
    return {
      executeSync: (sql: string) => {
        executed += 1;
        mockState.statements.push(sql);
        if (mockState.fault && mockState.fault.at === executed) {
          throw mockState.fault.value;
        }
        return { rows: real.prepare(sql).all() };
      },
      execute: async (sql: string, params: unknown[] = []) => ({
        rows: real.prepare(sql).all(...(params as SqlInputValue[])),
      }),
      close: () => {
        handle.closed += 1;
        real.close();
      },
    };
  },
}));

function loadGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb =
      jest.requireActual<typeof import('../../src/data/db')>(
        '../../src/data/db',
      ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

// ─── campaign plan ────────────────────────────────────────────────────────────

const DEFAULT_ITER = 40;
const DEFAULT_SEED = 20260905;
const CHUNK = 50;

function envInt(name: string, fallback: number): number {
  const raw = nodeProcess.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return value;
}

function plannedSeeds(): number[] {
  const only = nodeProcess.env['STRESS_ONLY'];
  if (only) {
    return only.split(',').map(part => {
      const seed = Number(part.trim());
      if (!Number.isInteger(seed)) throw new Error(`STRESS_ONLY seed ${part}`);
      return seed >>> 0;
    });
  }
  const iterations = envInt('STRESS_ITER', DEFAULT_ITER);
  const base = envInt('STRESS_SEED', DEFAULT_SEED);
  // Spread seeds over the 32-bit space so neighbouring iterations do not
  // share RNG prefixes.
  return Array.from(
    { length: iterations },
    (_, i) => (base + i * 2654435761) >>> 0,
  );
}

const seeds = plannedSeeds();
const chunks: number[][] = [];
for (let i = 0; i < seeds.length; i += CHUNK)
  chunks.push(seeds.slice(i, i + CHUNK));

const artifactDir =
  nodeProcess.env['STRESS_ARTIFACT_DIR'] ??
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'artifacts',
    'stress',
    'db-boundary-malformed',
  );

const results: ScenarioResult[] = [];
const inputs: Record<string, unknown>[] = [];
const startedAt = Date.now();

function sqliteVersion(): string {
  if (!mockSqlite) return 'unavailable';
  const db = mockOpenSqlite(mockSqlite, ':memory:');
  try {
    return String(db.prepare('SELECT sqlite_version() AS v').get()?.['v']);
  } finally {
    db.close();
  }
}

afterAll(() => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const broken = results.filter(r => r.outcome === 'BROKEN');
  const checkTotals: Record<string, Record<string, number>> = {};
  for (const r of results) {
    for (const [name, status] of Object.entries(r.checks)) {
      const bucket = (checkTotals[name] ??= {});
      bucket[status] = (bucket[status] ?? 0) + 1;
    }
  }
  const bySchema: Record<string, number> = {};
  const byFault: Record<string, number> = {};
  let rowsSeeded = 0;
  let probes = 0;
  for (const r of results) {
    bySchema[r.schema] = (bySchema[r.schema] ?? 0) + 1;
    byFault[r.fault] = (byFault[r.fault] ?? 0) + 1;
    rowsSeeded += Object.values(r.rowsSeeded).reduce((a, b) => a + b, 0);
    probes += r.probes.count;
  }
  const summary = {
    unit: 'mod-db',
    lens: 'boundary-malformed',
    node: nodeProcess.version,
    sqlite: sqliteVersion(),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    seedBase: nodeProcess.env['STRESS_ONLY']
      ? null
      : envInt('STRESS_SEED', DEFAULT_SEED),
    scenariosPlanned: seeds.length,
    scenariosExecuted: results.length,
    held: results.length - broken.length,
    broken: broken.length,
    brokenSeeds: broken.map(r => r.seed),
    faultUnavailable: results.filter(r =>
      Object.values(r.checks).includes('unavailable'),
    ).length,
    rowsSeeded,
    probesExecuted: probes,
    bySchema,
    byFault,
    checkTotals,
    replay:
      'cd apps/mobile && STRESS_ONLY=<seed> npx jest --ci __tests__/stress/dbBoundaryMalformed',
  };
  fs.writeFileSync(
    path.join(artifactDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  fs.writeFileSync(
    path.join(artifactDir, 'results.json'),
    JSON.stringify(
      results.map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        schema: r.schema,
        fault: r.fault,
        faultDetail: r.faultDetail,
        faultEffective: r.faultEffective,
        rowsSeeded: r.rowsSeeded,
        rowsRejectedAtSeed: r.rowsRejectedAtSeed,
        controlStatements: r.controlStatements,
        probes: r.probes,
        checks: r.checks,
        failures: r.failures,
        notes: r.notes,
        replay: r.replay,
      })),
      null,
      1,
    ),
  );
  fs.writeFileSync(
    path.join(artifactDir, 'inputs.json'),
    JSON.stringify(inputs),
  );
  fs.writeFileSync(
    path.join(artifactDir, 'seed-rejections.json'),
    JSON.stringify(
      results
        .filter(r => r.rejectedAtSeed.length)
        .map(r => ({ seed: r.seed, rejected: r.rejectedAtSeed })),
      null,
      1,
    ),
  );
});

describe('mod-db boundary-malformed stress (production getDb over real SQLite)', () => {
  it('runs on a Node with node:sqlite (>= 22.13)', () => {
    if (!mockSqlite) {
      throw new Error(
        `node:sqlite unavailable on ${nodeProcess.version}; run under Node >= 22.13`,
      );
    }
  });

  it.each(chunks.map((chunk, index) => [index, chunk] as const))(
    'chunk %i holds every invariant',
    async (_index, chunk) => {
      if (!mockSqlite) throw new Error('node:sqlite unavailable');
      const ctx = { state: mockState, loadGetDb, sqlite: mockSqlite };
      const brokenHere: ScenarioResult[] = [];
      for (const seed of chunk) {
        const scenario = generateScenario(seed);
        inputs.push(describeScenario(scenario));
        const result = await runScenario(scenario, ctx);
        results.push(result);
        if (result.outcome === 'BROKEN') brokenHere.push(result);
      }
      if (brokenHere.length) {
        throw new Error(
          brokenHere
            .map(
              r =>
                `seed ${r.seed} [${r.schema}/${r.faultDetail}]\n  ${r.failures.join('\n  ')}\n  replay: ${r.replay}`,
            )
            .join('\n'),
        );
      }
    },
    20 * 60 * 1000,
  );

  it('every scenario is replayable from its seed (same seed → same inputs)', () => {
    const seed = seeds[0] ?? DEFAULT_SEED;
    const a = JSON.stringify(describeScenario(generateScenario(seed)));
    const b = JSON.stringify(describeScenario(generateScenario(seed)));
    expect(a).toBe(b);
    expect(
      JSON.stringify(describeScenario(generateScenario(seed + 1))),
    ).not.toBe(a);
  });
});
