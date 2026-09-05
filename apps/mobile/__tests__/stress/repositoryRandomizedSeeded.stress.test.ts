/**
 * STRESS / randomized-seeded — src/data/repository.ts + accountScope.ts.
 *
 * Seeded action sequences (5–60 legal or near-legal public-API calls) run
 * against the PRODUCTION-migrated schema (getDb() → LOCAL_MIGRATIONS +
 * ensureAccountScopedSchema) on a real in-memory SQLite (node:sqlite), with
 * every read projection and the raw owner partition model-checked after
 * every step. Same seed twice must produce an identical trace. Failing seeds
 * are ddmin-minimized and re-run 10× for a flake rate.
 *
 * Scale: STRESS_ITER sequences (default 25 so the suite stays fast; the
 * campaign run for the stress report used STRESS_ITER=2000). STRESS_SEED
 * moves the seed window. Artifacts (seed → outcome JSON tables) land in
 * STRESS_ARTIFACT_DIR or apps/mobile/artifacts/stress-repository/.
 *
 * Needs node:sqlite (Node >= 22.13, or --experimental-sqlite on 22.5–22.12)
 * exactly like __tests__/dbMigrationMalformedOutbox.test.ts.
 */
import { getDb, type LocalDb } from '../../src/data/db';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  executeActions,
  generateActions,
  minimizeFailure,
  traceKey,
  type MinimizedFailure,
  type SequenceResult,
  type StressDb,
} from '../../xc-harness/stress-repository/campaign';
import { openStressDb } from '../../xc-harness/stress-repository/sqliteDriver';
import {
  buildAnalysis,
  OWNER_A,
  OWNER_B,
  PERMIT_ID,
  shotId,
  shotTypeFor,
  type ShotSpec,
} from '../../xc-harness/stress-repository/fixtures';
import { OWNER_SCOPED_TABLES } from '../../xc-harness/stress-repository/model';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  getShotOutboxStatus,
  listActivityShots,
  listRealAnalysisFacts,
  listShots,
  purgeOwnerData,
  recentScores,
  saveAnalysis,
} from '../../src/data/repository';

jest.mock('@op-engineering/op-sqlite', () =>
  jest
    .requireActual<
      typeof import('../../xc-harness/stress-repository/sqliteDriver')
    >('../../xc-harness/stress-repository/sqliteDriver')
    .opSqliteMockModule(),
);

const openDb = (seed: number): StressDb => openStressDb(getDb, seed);

const ITERATIONS = Math.max(
  1,
  Number.parseInt(nodeProcess.env['STRESS_ITER'] ?? '25', 10) || 25,
);
const BASE_SEED =
  Number.parseInt(nodeProcess.env['STRESS_SEED'] ?? '20260905', 10) || 20260905;
const ARTIFACT_DIR =
  nodeProcess.env['STRESS_ARTIFACT_DIR'] ??
  path.resolve(__dirname, '..', '..', 'artifacts', 'stress-repository');

function writeArtifact(name: string, value: unknown): string {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

interface SeedRow {
  seed: number;
  outcome: 'held' | 'broken';
  length: number;
  executedSteps: number;
  durationMs: number;
  deterministic: boolean;
  failure: SequenceResult['failure'];
}

interface FlakeReport {
  seed: number;
  reruns: number;
  failures: number;
  rate: number;
}

interface CampaignReport {
  name: string;
  node: string;
  baseSeed: number;
  sequences: number;
  executedSteps: number;
  held: number;
  broken: number;
  nonDeterministic: number[];
  lengthRange: { min: number; max: number };
  totalDurationMs: number;
  actionHistogram: Record<string, number>;
  /** action type → observed step outcome → count (what the near-legal
   * actions actually did: rejected duplicates, pre/post reads, tx races). */
  stepOutcomes: Record<string, Record<string, number>>;
  rows: SeedRow[];
  minimized: MinimizedFailure[];
  flakeRates: FlakeReport[];
}

async function runCampaign(
  name: string,
  options: { concurrentTransactions?: boolean },
): Promise<CampaignReport> {
  const rows: SeedRow[] = [];
  const minimized: MinimizedFailure[] = [];
  const flakeRates: FlakeReport[] = [];
  const nonDeterministic: number[] = [];
  const actionHistogram: Record<string, number> = {};
  const stepOutcomes: Record<string, Record<string, number>> = {};
  const traceLines: string[] = [];
  let executedSteps = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  const startedAt = Date.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const seed = BASE_SEED + i;
    const actions = generateActions(seed, options);
    for (const action of actions) {
      actionHistogram[action.type] = (actionHistogram[action.type] ?? 0) + 1;
    }
    const first = await executeActions(openDb, seed, actions);
    const second = await executeActions(openDb, seed, actions);
    const deterministic = traceKey(first) === traceKey(second);
    if (!deterministic) nonDeterministic.push(seed);
    for (const [index, step] of first.trace.entries()) {
      const type = actions[index]?.type ?? 'unknown';
      const bucket = (stepOutcomes[type] ??= {});
      const outcome = step.outcome.slice(0, 96);
      bucket[outcome] = (bucket[outcome] ?? 0) + 1;
    }
    traceLines.push(JSON.stringify({ seed, trace: first.trace }));
    executedSteps += first.executedSteps + second.executedSteps;
    min = Math.min(min, actions.length);
    max = Math.max(max, actions.length);
    rows.push({
      seed,
      outcome: first.ok && deterministic ? 'held' : 'broken',
      length: actions.length,
      executedSteps: first.executedSteps,
      durationMs: first.durationMs,
      deterministic,
      failure: first.failure,
    });
    if (first.failure) {
      minimized.push(
        await minimizeFailure(openDb, seed, actions, first.failure),
      );
      let failures = 0;
      for (let rerun = 0; rerun < 10; rerun++) {
        const result = await executeActions(openDb, seed, actions);
        if (!result.ok) failures += 1;
      }
      flakeRates.push({ seed, reruns: 10, failures, rate: failures / 10 });
    }
  }
  const report: CampaignReport = {
    name,
    node: nodeProcess.version,
    baseSeed: BASE_SEED,
    sequences: rows.length,
    executedSteps,
    held: rows.filter(row => row.outcome === 'held').length,
    broken: rows.filter(row => row.outcome === 'broken').length,
    nonDeterministic,
    lengthRange: { min, max },
    totalDurationMs: Date.now() - startedAt,
    actionHistogram,
    stepOutcomes,
    rows,
    minimized,
    flakeRates,
  };
  writeArtifact(`${name}.json`, report);
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, `${name}.traces.jsonl`),
    `${traceLines.join('\n')}\n`,
  );
  return report;
}

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('repository stress — seeded randomized long-run', () => {
  jest.setTimeout(30 * 60 * 1000);

  it('every generated sequence is 5–60 actions and replays byte-identically from its seed', () => {
    for (let i = 0; i < Math.min(ITERATIONS, 500); i++) {
      const seed = BASE_SEED + i;
      const a = generateActions(seed);
      const b = generateActions(seed);
      expect(a.length).toBeGreaterThanOrEqual(5);
      expect(a.length).toBeLessThanOrEqual(60);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('holds every repository invariant after every step across the seeded campaign (same seed → same trace)', async () => {
    const report = await runCampaign('campaign-main', {});
    expect(report.sequences).toBe(ITERATIONS);
    expect(report.nonDeterministic).toEqual([]);
    expect(report.minimized).toEqual([]);
    expect(report.broken).toBe(0);
  });

  it('keeps every write atomic with its outbox row when two repository transactions overlap on the shared connection', async () => {
    const report = await runCampaign('campaign-concurrent', {
      concurrentTransactions: true,
    });
    expect(report.nonDeterministic).toEqual([]);
    expect(report.minimized).toEqual([]);
    expect(report.broken).toBe(0);
  });
});

describe('repository stress — 10k rows, duplicates, deletes during reads', () => {
  jest.setTimeout(10 * 60 * 1000);

  const ROWS = 10_000;
  const DUPES = 1_000;

  function spec(seq: number, id: string): ShotSpec {
    return {
      id,
      seq,
      shotType: shotTypeFor(seq),
      scored: seq % 5 !== 0,
      score: seq % 5 !== 0 ? Math.round((seq * 37) % 100) / 10 : null,
      sessionId: seq % 3 === 0 ? `session-${seq % 7}` : null,
      checkpointVariant: seq % 2 === 0 ? 'mixed' : 'all_applicable',
      priority: seq % 4 === 0,
      source: 'real',
    };
  }

  async function ownerCounts(db: LocalDb, owner: string) {
    const counts: Record<string, number> = {};
    for (const table of OWNER_SCOPED_TABLES) {
      const { rows } = await db.execute(
        `SELECT COUNT(*) AS n FROM ${table} WHERE owner_key = ?`,
        [owner],
      );
      counts[table] = Number(rows[0]?.['n']);
    }
    return counts;
  }

  it('keeps ordering, limits, scores, facts and the owner partition exact at 10k+10k rows with 1k duplicate re-saves, and a purge racing an unbounded read is linearizable', async () => {
    const db = openDb(BASE_SEED);
    const timings: Record<string, number> = {};
    try {
      let t = Date.now();
      setActiveDataOwner(OWNER_A);
      for (let seq = 1; seq <= ROWS; seq++) {
        await saveAnalysis(
          db,
          buildAnalysis(spec(seq, shotId(seq))),
          PERMIT_ID,
        );
      }
      timings['insertA10k'] = Date.now() - t;
      t = Date.now();
      setActiveDataOwner(OWNER_B);
      for (let seq = 1; seq <= ROWS; seq++) {
        // Same ids as owner A — the partition key must keep them apart.
        await saveAnalysis(
          db,
          buildAnalysis(spec(ROWS + seq, shotId(seq))),
          PERMIT_ID,
        );
      }
      timings['insertB10k'] = Date.now() - t;

      // Duplicate re-saves under A: newer captured_at, same id → replace.
      t = Date.now();
      setActiveDataOwner(OWNER_A);
      for (let k = 1; k <= DUPES; k++) {
        const id = shotId(k * 7);
        await saveAnalysis(
          db,
          buildAnalysis(spec(3 * ROWS + k, id)),
          PERMIT_ID,
        );
      }
      timings['dupes1k'] = Date.now() - t;

      t = Date.now();
      const countsA = await ownerCounts(db, OWNER_A);
      const countsB = await ownerCounts(db, OWNER_B);
      expect(countsA['local_shot']).toBe(ROWS);
      expect(countsA['outbox']).toBe(ROWS + DUPES);
      expect(countsB['local_shot']).toBe(ROWS);
      expect(countsB['outbox']).toBe(ROWS);

      const activity = await listActivityShots(db);
      expect(activity).toHaveLength(ROWS);
      expect(new Set(activity.map(row => row.id)).size).toBe(ROWS);
      for (let i = 1; i < activity.length; i++) {
        expect(activity[i]!.capturedAt > activity[i - 1]!.capturedAt).toBe(
          true,
        );
      }
      // The 1k replaced ids carry the newest captured_at and sit at the tail.
      const tail = activity.slice(-DUPES).map(row => row.id);
      expect(new Set(tail)).toEqual(
        new Set(Array.from({ length: DUPES }, (_, k) => shotId((k + 1) * 7))),
      );

      const top50 = await listShots(db, 50);
      expect(top50).toHaveLength(50);
      expect(top50.map(row => row.id)).toEqual(
        Array.from({ length: 50 }, (_, k) => shotId((DUPES - k) * 7)),
      );

      const facts = await listRealAnalysisFacts(db, null);
      expect(facts).toHaveLength(ROWS);
      expect(facts.map(fact => fact.id)).toEqual(
        activity.map(row => row.id).reverse(),
      );

      const scores = await recentScores(db, null, 30);
      const expectedScores = activity
        .filter(row => row.resultKind === 'scored')
        .slice(-30)
        .map(row => row.overallScore);
      expect(scores).toEqual(expectedScores);

      expect(await getShotOutboxStatus(db, shotId(7))).toEqual({
        state: 'queued',
        attempts: 0,
        lastError: null,
      });
      timings['reads'] = Date.now() - t;

      // Delete during an unbounded read: A's 10k rows vanish while
      // listActivityShots is in flight. The read sees all or nothing.
      t = Date.now();
      const pending = listActivityShots(db);
      const purge = purgeOwnerData(db, OWNER_A);
      const [readResult] = await Promise.all([pending, purge]);
      expect([0, ROWS]).toContain(readResult.length);
      expect(db.inTransaction()).toBe(false);
      timings['purgeAduringRead'] = Date.now() - t;

      const afterA = await ownerCounts(db, OWNER_A);
      for (const table of OWNER_SCOPED_TABLES) expect(afterA[table]).toBe(0);
      expect(await ownerCounts(db, OWNER_B)).toEqual(countsB);
      expect(await listShots(db, 10)).toEqual([]);

      setActiveDataOwner(OWNER_B);
      const bTop = await listShots(db, 50);
      expect(bTop.map(row => row.id)).toEqual(
        Array.from({ length: 50 }, (_, k) => shotId(ROWS - k)),
      );
      expect(await listActivityShots(db)).toHaveLength(ROWS);
      writeArtifact('scale-10k.json', {
        node: nodeProcess.version,
        rows: ROWS,
        duplicates: DUPES,
        timings,
        readDuringPurgeObserved: readResult.length,
        countsA,
        countsB,
        afterPurgeA: afterA,
      });
    } finally {
      db.close();
    }
  });
});
