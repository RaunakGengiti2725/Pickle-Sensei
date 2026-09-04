/**
 * STRESS — mod-db / lens `concurrency`
 *
 * Drives `src/data/db.ts` (open + migrate + the LocalDb handle it returns)
 * through the seeded scheduler in `stress-harness/db/` with REAL SQLite
 * (`node:sqlite`) behind the op-sqlite seam. Four families, every iteration
 * a pure function of its seed:
 *
 *   open-burst      N concurrent `getDb()` callers on a fresh or legacy file,
 *                   with 0–3 injected `open()` disk failures or one injected
 *                   migration-statement failure → exactly one migrated
 *                   handle, retry succeeds, legacy rows carried once.
 *   two-actor-file  a second connection takes a lock / inserts a legacy row
 *                   right before migration statement k → the migration
 *                   either completes or fails clean; the retry always
 *                   converges; no row lost or duplicated; no temp table.
 *   close-race      writers, readers and `close()` callers interleave on the
 *                   cached handle → no acknowledged write is lost, no handle
 *                   leaks, the file stays consistent.
 *   txn-interleave  saveAnalysis / saveSession / finishSession / purge /
 *                   drainOutbox / owner rotation / logout interleaved on the
 *                   ONE shared connection → atomicity of each operation,
 *                   no orphan outbox row, failed operations leave no trace,
 *                   bounded wall time. Every seed is also run serialised
 *                   (control) and replayed (determinism).
 *   clock-skew      outbox rows whose created_at jumps backwards/forwards →
 *                   drain order stays insertion (id) order.
 *
 * Scale: STRESS_ITER=<n> (default 24 per family so the suite stays fast).
 * Replay one seed: STRESS_SEED=<n>. STRESS_STRICT=1 also fails the suite on
 * the ADVISORY invariant `onlyExpectedErrors` (a repository operation that
 * fails for a reason other than "signed out"). It is advisory by default
 * because concurrent transactions on the one shared connection collide with
 * `cannot start a transaction within a transaction` (recorded as BROKEN in
 * the JSON table on every seed that hits it); the data-safety invariants —
 * atomicity, no orphan/torn row, no lost acknowledged write, no open
 * transaction, bounded wall time — are always asserted. Artifacts (seed → outcome JSON table,
 * summary, markdown matrix): <repo>/artifacts/stress-mod-db/ (gitignored;
 * override with STRESS_ARTIFACT_DIR).
 *
 * node:sqlite is behind `--experimental-sqlite` on Node 22.12; without the
 * flag this file re-executes itself under jest with the flag set.
 */
import type { LocalDb } from '../../src/data/db';
import {
  childProcess,
  fs,
  loadNodeSqlite,
  nodeProcess,
  os,
  path,
  resolveModule,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';
import {
  matrixMarkdown,
  summarize,
  type MatrixRow,
} from '../../xc-harness/lifecycle-persistence/artifacts';
import {
  makeScheduler,
  makeSerialScheduler,
  settleWithin,
  traceHash,
  type Scheduler,
} from '../../stress-harness/db/scheduler';
import {
  countRows,
  errorMessage,
  integrityOk,
  makeSeam,
  NO_FAULTS,
  probeSchema,
  schemaIsCurrent,
  type JournalMode,
  type Seam,
} from '../../stress-harness/db/sqliteSeam';
import {
  expectedMigratedShots,
  realAnalysis,
  seededLegacyPopulation,
  seedLegacyFile,
  stressIterations,
  stressReplaySeed,
  TORN_OUTBOX_PAYLOAD,
  uuidFrom,
  writeStressJson,
  writeStressText,
} from '../../stress-harness/db/fixtures';
import {
  finishSession,
  getKv,
  listShots,
  purgeOwnerData,
  saveAnalysis,
  saveLocalOnlyAnalysis,
  saveSession,
  setKv,
} from '../../src/data/repository';
import { drainOutbox, type SyncTransport } from '../../src/data/sync';
import {
  getActiveDataOwner,
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

declare const __dirname: string;
declare const __filename: string;

const sqlite = loadNodeSqlite();

// ─── op-sqlite seam ───────────────────────────────────────────────────────────

const seamState: { current: Seam | null } = { current: null };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => {
    const seam = seamState.current;
    if (!seam) throw new Error('stress scenario did not install a seam');
    return seam.open(options.name);
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

const ROOT_DIR = path.join(
  os.tmpdir(),
  `pickle-stress-mod-db-${nodeProcess.getuid?.() ?? 0}-${Date.now()}`,
);

const OWNER_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const OWNER_B = '0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01';
const WALL_MS = 5_000;
const SUITE = 'stress-mod-db-concurrency';

const allRows: MatrixRow[] = [];
const replaySeed = stressReplaySeed();
const ITER = stressIterations(24);
const STRICT = nodeProcess.env['STRESS_STRICT'] === '1';
const ADVISORY_INVARIANTS: ReadonlySet<string> = new Set(
  STRICT ? [] : ['onlyExpectedErrors'],
);

function seedFor(family: string, index: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < family.length; i += 1) {
    h ^= family.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h ^ (index * 7919 + 13)) >>> 0;
}

function seedsFor(family: string): number[] {
  if (replaySeed !== null) return [replaySeed];
  return Array.from({ length: ITER }, (_, i) => seedFor(family, i));
}

function finishRow(
  row: Omit<MatrixRow, 'ok' | 'failed' | 'durationMs'>,
  started: number,
): MatrixRow {
  const failed = Object.entries(row.invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  const full: MatrixRow = {
    ...row,
    ok: failed.length === 0,
    failed,
    durationMs: Date.now() - started,
  };
  allRows.push(full);
  return full;
}

/** Rows whose non-advisory invariants failed (the JSON table keeps every
 * failure, advisory or not). */
function failuresOf(rows: MatrixRow[]): Array<Record<string, unknown>> {
  return rows
    .map(row => ({
      scenario: row.scenario,
      seed: row.seed,
      failed: row.failed.filter(name => !ADVISORY_INVARIANTS.has(name)),
      inputs: row.inputs,
      observed: row.observed,
    }))
    .filter(row => row.failed.length > 0);
}

function withSeam<T>(seam: Seam, body: () => Promise<T>): Promise<T> {
  seamState.current = seam;
  return body().finally(() => {
    seamState.current = null;
    seam.destroy();
  });
}

/** Number of synchronous statements one clean migration issues. */
function migrationStatementCount(legacy: boolean): number {
  const seam = makeSeam({ rootDir: ROOT_DIR, journalMode: 'delete' });
  seamState.current = seam;
  try {
    if (legacy) {
      const raw = seam.rawConnection();
      seedLegacyFile(raw, seededLegacyPopulation(makePrng(1), 3));
      raw.close();
    }
    loadGetDb()();
    return seam.handles[0]?.syncStatements ?? 0;
  } finally {
    seamState.current = null;
    seam.destroy();
  }
}

function shotKeys(raw: SqliteDatabaseSync): string[] {
  return (
    raw
      .prepare(`SELECT owner_key, id, source FROM local_shot ORDER BY 1, 2`)
      .all() as Array<{ owner_key: string; id: string; source: string }>
  ).map(r => `${r.owner_key}|${r.id}|${r.source}`);
}

// ─── family: open-burst ───────────────────────────────────────────────────────

interface OpenBurstInputs {
  callers: number;
  legacy: boolean;
  population: number;
  journalMode: JournalMode;
  openFailures: number;
  syncFailAt: number | null;
  maxMicroTicks: number;
  macroHopProbability: number;
}

function openBurstInputs(
  seed: number,
  statementCounts: number[],
): OpenBurstInputs {
  const rng = makePrng(seed);
  const legacy = rng() < 0.5;
  const faultKind = pick(rng, ['none', 'none', 'open', 'sync'] as const);
  const total = statementCounts[legacy ? 1 : 0] ?? 1;
  const callers = 2 + Math.floor(rng() * 63);
  return {
    callers,
    legacy,
    population: legacy ? Math.floor(rng() * 40) : 0,
    journalMode: pick(rng, ['delete', 'wal'] as const),
    openFailures:
      faultKind === 'open'
        ? Math.min(callers - 1, 1 + Math.floor(rng() * 3))
        : 0,
    syncFailAt: faultKind === 'sync' ? Math.floor(rng() * total) : null,
    maxMicroTicks: Math.floor(rng() * 6),
    macroHopProbability: rng() < 0.5 ? 0 : rng() * 0.5,
  };
}

async function runOpenBurst(
  seed: number,
  statementCounts: number[],
): Promise<MatrixRow> {
  const started = Date.now();
  const inputs = openBurstInputs(seed, statementCounts);
  const scheduler = makeScheduler(seed, {
    maxMicroTicks: inputs.maxMicroTicks,
    macroHopProbability: inputs.macroHopProbability,
  });
  const seam = makeSeam({
    rootDir: ROOT_DIR,
    journalMode: inputs.journalMode,
    scheduler,
    faults: {
      ...NO_FAULTS,
      openFailures: inputs.openFailures,
      syncFailAtStatement: inputs.syncFailAt,
    },
  });
  return withSeam(seam, async () => {
    const population = seededLegacyPopulation(
      makePrng(seed ^ 0x5bd1e995),
      inputs.population,
    );
    if (inputs.legacy) {
      const raw = seam.rawConnection();
      seedLegacyFile(raw, population);
      raw.close();
    }
    const getDb = loadGetDb();
    const errors: string[] = [];
    let successes = 0;
    const actors = Array.from({ length: inputs.callers }, (_, i) =>
      (async () => {
        await scheduler.yieldPoint(`caller${i}`);
        let db: LocalDb;
        try {
          db = getDb();
        } catch (error) {
          errors.push(errorMessage(error));
          return;
        }
        const { rows } = await db.execute(
          `SELECT count(*) AS n FROM local_shot WHERE owner_key = ?`,
          [GUEST_DATA_OWNER],
        );
        if (typeof rows[0]?.['n'] !== 'number') {
          throw new Error(`unexpected count row ${JSON.stringify(rows[0])}`);
        }
        successes += 1;
      })(),
    );
    const settled = await settleWithin(actors, WALL_MS);
    const unexpected = (settled.results ?? [])
      .filter(r => r.status === 'rejected')
      .map(r => errorMessage((r as PromiseRejectedResult).reason));

    // Whatever happened in the burst, one more call must converge.
    let retryError: string | null = null;
    try {
      const db = getDb();
      await db.execute('SELECT 1');
    } catch (error) {
      retryError = errorMessage(error);
    }

    const expectedFailures =
      inputs.openFailures + (inputs.syncFailAt !== null ? 1 : 0);
    const raw = seam.rawConnection();
    const keys = shotKeys(raw);
    const expectedKeys = expectedMigratedShots(population)
      .map(s => `${s.owner}|${s.id}|real`)
      .sort();
    const torn = countRows(
      raw,
      `SELECT count(*) AS n FROM outbox WHERE payload = ?`,
      [TORN_OUTBOX_PAYLOAD],
    );
    const fixtureOutbox = countRows(
      raw,
      `SELECT count(*) AS n FROM outbox WHERE kind = 'shot.sync' AND json_valid(payload) AND json_extract(payload, '$.source') <> 'real'`,
    );
    raw.close();
    const probe = probeSchema(seam);
    const tornExpected =
      inputs.legacy &&
      population.outbox.some(o => o.payload === TORN_OUTBOX_PAYLOAD)
        ? 1
        : 0;

    const invariants: Record<string, boolean> = {
      noDeadlock: !settled.deadlocked,
      noUnexpectedRejection: unexpected.length === 0,
      exactlyOneLiveHandle: seam.liveHandles().length === 1,
      migratedOnce: seam.opens === (inputs.syncFailAt !== null ? 2 : 1),
      openAttemptsMatchFaults:
        seam.openAttempts ===
        inputs.openFailures + (inputs.syncFailAt !== null ? 2 : 1),
      faultsSurfacedExactlyOnceEach: errors.length === expectedFailures,
      everyOtherCallerServed: successes === inputs.callers - expectedFailures,
      retryConverges: retryError === null,
      schemaCurrent: schemaIsCurrent(probe),
      integrityOk: integrityOk(seam),
      realShotsCarriedOnce:
        JSON.stringify(keys) === JSON.stringify(expectedKeys),
      fixtureOutboxRemoved: fixtureOutbox === 0,
      tornOutboxRowKept: torn === tornExpected,
    };
    return finishRow(
      {
        suite: SUITE,
        scenario: 'open-burst',
        seed,
        inputs: { ...inputs },
        observed: {
          opens: seam.opens,
          openAttempts: seam.openAttempts,
          successes,
          errors: errors.slice(0, 5),
          unexpected: unexpected.slice(0, 5),
          retryError,
          liveHandles: seam.liveHandles().length,
          yields: scheduler.yields,
          traceHash: traceHash(scheduler.trace),
          elapsedMs: settled.elapsedMs,
          tables: probe.tables,
        },
        invariants,
      },
      started,
    );
  });
}

// ─── family: two-actor-file ───────────────────────────────────────────────────

type OtherActor =
  | 'begin-immediate-hold'
  | 'begin-deferred-read'
  | 'insert-legacy-real'
  | 'insert-legacy-fixture';

interface TwoActorInputs {
  journalMode: JournalMode;
  population: number;
  atStatement: number;
  other: OtherActor;
}

function twoActorInputs(seed: number, total: number): TwoActorInputs {
  const rng = makePrng(seed);
  return {
    journalMode: pick(rng, ['delete', 'wal'] as const),
    population: 1 + Math.floor(rng() * 30),
    atStatement: Math.floor(rng() * total),
    other: pick(rng, [
      'begin-immediate-hold',
      'begin-deferred-read',
      'insert-legacy-real',
      'insert-legacy-fixture',
    ] as const),
  };
}

async function runTwoActorFile(
  seed: number,
  total: number,
): Promise<MatrixRow> {
  const started = Date.now();
  const inputs = twoActorInputs(seed, total);
  const seam = makeSeam({ rootDir: ROOT_DIR, journalMode: inputs.journalMode });
  return withSeam(seam, async () => {
    const population = seededLegacyPopulation(
      makePrng(seed ^ 0x27d4eb2f),
      inputs.population,
    );
    const seedConnection = seam.rawConnection();
    seedLegacyFile(seedConnection, population);
    seedConnection.close();

    const other = seam.rawConnection();
    const extraId = uuidFrom(makePrng(seed), 0xbeef);
    let otherError: string | null = null;
    let otherActed = false;
    let otherHolds = false;
    let extraRowCommitted = false;
    seam.beforeSync = (index, sql) => {
      if (index !== inputs.atStatement) return;
      otherActed = true;
      seam.statements.push(
        `other:${inputs.other}@${index}:${sql.slice(0, 24)}`,
      );
      try {
        switch (inputs.other) {
          case 'begin-immediate-hold':
            other.exec('BEGIN IMMEDIATE');
            otherHolds = true;
            break;
          case 'begin-deferred-read':
            other.exec('BEGIN');
            other.prepare('SELECT count(*) AS n FROM sqlite_master').get();
            otherHolds = true;
            break;
          case 'insert-legacy-real':
          case 'insert-legacy-fixture': {
            const source =
              inputs.other === 'insert-legacy-real' ? 'real' : 'fixture';
            const legacyShape =
              (
                other.prepare(`PRAGMA table_info(local_shot)`).all() as Array<{
                  name: string;
                }>
              ).some(c => c.name === 'owner_key') === false;
            if (legacyShape) {
              other
                .prepare(
                  `INSERT INTO local_shot (id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
                   VALUES (?, NULL, 'forehand_drive', '2026-02-02T00:00:00.000Z', 5.5, 0.9, 'scored', ?, 0, '{}')`,
                )
                .run(extraId, source);
            } else {
              other
                .prepare(
                  `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
                   VALUES (?, ?, NULL, 'forehand_drive', '2026-02-02T00:00:00.000Z', 5.5, 0.9, 'scored', ?, 0, '{}')`,
                )
                .run(GUEST_DATA_OWNER, extraId, source);
            }
            extraRowCommitted = true;
            break;
          }
        }
      } catch (error) {
        otherError = errorMessage(error);
      }
    };

    const getDb = loadGetDb();
    let firstError: string | null = null;
    try {
      getDb();
    } catch (error) {
      firstError = errorMessage(error);
    }
    seam.beforeSync = null;
    if (otherHolds) {
      try {
        other.exec('ROLLBACK');
      } catch (error) {
        otherError = `${otherError ?? ''} release:${errorMessage(error)}`;
      }
    }
    other.close();

    let retryError: string | null = null;
    try {
      const db = getDb();
      await db.execute('SELECT 1');
    } catch (error) {
      retryError = errorMessage(error);
    }

    const raw = seam.rawConnection();
    const keys = shotKeys(raw);
    const expected = expectedMigratedShots(population).map(
      s => `${s.owner}|${s.id}|real`,
    );
    // A fixture inserted BEFORE the autocommit fixture-delete ran is removed;
    // one inserted after it survives the migration (the delete is one-shot).
    // Both are legitimate engine outcomes, so the fixture case is recorded
    // and only the real row is asserted.
    const fixtureRowsLeft = keys.filter(k => k.endsWith('|fixture')).length;
    if (extraRowCommitted && inputs.other === 'insert-legacy-real') {
      expected.push(`${GUEST_DATA_OWNER}|${extraId}|real`);
    }
    expected.sort();
    const realKeys = keys.filter(k => k.endsWith('|real'));
    const distinct = new Set(keys.map(k => k.split('|').slice(0, 2).join('|')));
    raw.close();
    const probe = probeSchema(seam);

    const invariants: Record<string, boolean> = {
      otherActorReachedStatement: otherActed,
      failedOpenClosedItsHandle:
        firstError === null || seam.handles[0]?.closed === true,
      retryConverges: retryError === null,
      exactlyOneLiveHandle: seam.liveHandles().length === 1,
      opensMatchOutcome: seam.opens === (firstError === null ? 1 : 2),
      schemaCurrent: schemaIsCurrent(probe),
      noLeftoverTempTable: probe.leftoverTempTables.length === 0,
      integrityOk: integrityOk(seam),
      realShotsCarriedOnce:
        JSON.stringify(realKeys) === JSON.stringify(expected),
      noDuplicatePrimaryKeys: distinct.size === keys.length,
    };
    return finishRow(
      {
        suite: SUITE,
        scenario: 'two-actor-file',
        seed,
        inputs: { ...inputs, totalStatements: total },
        observed: {
          firstError,
          retryError,
          otherError,
          otherHolds,
          extraRowCommitted,
          fixtureRowsLeft,
          opens: seam.opens,
          liveHandles: seam.liveHandles().length,
          statementsAroundFault: seam.statements
            .slice(Math.max(0, inputs.atStatement - 1), inputs.atStatement + 4)
            .map(s => s.slice(0, 64)),
          tables: probe.tables,
        },
        invariants,
      },
      started,
    );
  });
}

// ─── family: close-race ───────────────────────────────────────────────────────

type CloseRaceOp = 'write' | 'read' | 'close' | 'close-stale' | 'reopen-write';

interface CloseRaceInputs {
  journalMode: JournalMode;
  ops: CloseRaceOp[];
  maxMicroTicks: number;
  macroHopProbability: number;
}

function closeRaceInputs(seed: number): CloseRaceInputs {
  const rng = makePrng(seed);
  const count = 3 + Math.floor(rng() * 14);
  return {
    journalMode: pick(rng, ['delete', 'wal'] as const),
    ops: Array.from({ length: count }, () =>
      pick(rng, [
        'write',
        'write',
        'write',
        'read',
        'close',
        'close-stale',
        'reopen-write',
      ] as const),
    ),
    maxMicroTicks: Math.floor(rng() * 6),
    macroHopProbability: rng() < 0.5 ? 0 : rng() * 0.5,
  };
}

async function runCloseRace(seed: number): Promise<MatrixRow> {
  const started = Date.now();
  const inputs = closeRaceInputs(seed);
  const scheduler = makeScheduler(seed, {
    maxMicroTicks: inputs.maxMicroTicks,
    macroHopProbability: inputs.macroHopProbability,
  });
  const seam = makeSeam({
    rootDir: ROOT_DIR,
    journalMode: inputs.journalMode,
    scheduler,
  });
  return withSeam(seam, async () => {
    const getDb = loadGetDb();
    const acknowledged: string[] = [];
    const outcomes: Array<{ op: CloseRaceOp; result: string }> = [];
    const stale: LocalDb = getDb();
    const actors = inputs.ops.map((op, i) =>
      (async () => {
        await scheduler.yieldPoint(`actor${i}`);
        try {
          switch (op) {
            case 'write': {
              const db = getDb();
              await setKv(db, `k${i}`, `v${seed}`);
              acknowledged.push(`k${i}`);
              outcomes.push({ op, result: 'ok' });
              break;
            }
            case 'reopen-write': {
              const db = getDb();
              await scheduler.yieldPoint(`reopen${i}`);
              await db.execute(
                `INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`,
                [`k${i}`, `v${seed}`],
              );
              acknowledged.push(`k${i}`);
              outcomes.push({ op, result: 'ok' });
              break;
            }
            case 'read': {
              const db = getDb();
              await getKv(db, `k${Math.max(0, i - 1)}`);
              outcomes.push({ op, result: 'ok' });
              break;
            }
            case 'close': {
              getDb().close();
              outcomes.push({ op, result: 'ok' });
              break;
            }
            case 'close-stale': {
              stale.close();
              outcomes.push({ op, result: 'ok' });
              break;
            }
          }
        } catch (error) {
          outcomes.push({ op, result: errorMessage(error) });
        }
      })(),
    );
    const settled = await settleWithin(actors, WALL_MS);

    // Whatever the race did, the next caller must get a working handle, and
    // the ONLY live handle must be the one it returns.
    let retryError: string | null = null;
    try {
      await getDb().execute('SELECT 1');
    } catch (error) {
      retryError = errorMessage(error);
    }
    const liveAfterRetry = seam.liveHandles().length;
    seam.closeAll();

    const raw = seam.rawConnection();
    const present = new Set(
      (raw.prepare(`SELECT key FROM kv`).all() as Array<{ key: string }>).map(
        r => r.key,
      ),
    );
    raw.close();
    const lost = acknowledged.filter(key => !present.has(key));
    const errorKinds = outcomes
      .filter(o => o.result !== 'ok')
      .map(o => `${o.op}:${o.result}`);
    const knownStale = errorKinds.every(k =>
      k.includes('database is not open'),
    );

    const invariants: Record<string, boolean> = {
      noDeadlock: !settled.deadlocked,
      noLostAcknowledgedWrite: lost.length === 0,
      onlyStaleHandleErrors: knownStale,
      retryConverges: retryError === null,
      noHandleLeak: liveAfterRetry === 1,
      integrityOk: integrityOk(seam),
    };
    return finishRow(
      {
        suite: SUITE,
        scenario: 'close-race',
        seed,
        inputs: { ...inputs },
        observed: {
          opens: seam.opens,
          liveAfterRetry,
          acknowledged: acknowledged.length,
          lost,
          errorKinds: errorKinds.slice(0, 8),
          retryError,
          yields: scheduler.yields,
          traceHash: traceHash(scheduler.trace),
          elapsedMs: settled.elapsedMs,
        },
        invariants,
      },
      started,
    );
  });
}

// ─── family: txn-interleave ───────────────────────────────────────────────────

type TxnOp =
  | 'saveAnalysis'
  | 'saveLocalOnly'
  | 'saveSession'
  | 'finishSession'
  | 'purge'
  | 'drain'
  | 'list'
  | 'rotate'
  | 'logout';

interface TxnActor {
  op: TxnOp;
  shot: number;
  session: number;
  owner: 'A' | 'B';
  permit: string;
}

interface TxnInputs {
  journalMode: JournalMode;
  actors: TxnActor[];
  maxMicroTicks: number;
  macroHopProbability: number;
}

const OWNERS = { A: OWNER_A, B: OWNER_B } as const;

function txnInputs(seed: number): TxnInputs {
  const rng = makePrng(seed);
  const count = 2 + Math.floor(rng() * 5);
  const actors: TxnActor[] = Array.from({ length: count }, (_, i) => ({
    op: pick(rng, [
      'saveAnalysis',
      'saveAnalysis',
      'saveAnalysis',
      'saveLocalOnly',
      'saveSession',
      'finishSession',
      'purge',
      'drain',
      'list',
      'rotate',
      'logout',
    ] as const),
    shot: Math.floor(rng() * 3),
    session: Math.floor(rng() * 2),
    owner: rng() < 0.8 ? 'A' : 'B',
    permit: `permit-${seed}-${i}`,
  }));
  return {
    journalMode: pick(rng, ['delete', 'wal'] as const),
    actors,
    maxMicroTicks: Math.floor(rng() * 6),
    macroHopProbability: rng() < 0.5 ? 0 : rng() * 0.5,
  };
}

interface TxnOutcome {
  index: number;
  op: TxnOp;
  owner: string;
  target: string;
  result: string;
}

interface TxnRun {
  outcomes: TxnOutcome[];
  invariants: Record<string, boolean>;
  observed: Record<string, unknown>;
  traceHash: string;
}

const NESTED_TXN = 'cannot start a transaction within a transaction';
const NO_TXN = 'cannot commit - no transaction is active';

async function executeTxnScenario(
  inputs: TxnInputs,
  scheduler: Scheduler,
  mode: 'concurrent' | 'sequential',
): Promise<TxnRun> {
  const seam = makeSeam({
    rootDir: ROOT_DIR,
    journalMode: inputs.journalMode,
    scheduler,
  });
  return withSeam(seam, async () => {
    setActiveDataOwner(OWNER_A);
    const getDb = loadGetDb();
    const db = getDb();
    // Sessions referenced by finishSession exist up-front in both owners so
    // the UPDATE has something to hit; a finalize outbox row is written
    // regardless (that is the production code's behaviour).
    for (const owner of [OWNER_A, OWNER_B]) {
      for (let s = 0; s < 2; s += 1) {
        await db.execute(
          `INSERT INTO local_session (owner_key, id, mode, shot_type, focus_checkpoint, started_at) VALUES (?, ?, 'live', NULL, NULL, '2026-01-01T00:00:00.000Z')`,
          [owner, `session-${s}`],
        );
      }
    }
    setActiveDataOwner(OWNER_A);

    const transport: SyncTransport = {
      async syncShots(shots) {
        await scheduler.yieldPoint('transport.syncShots');
        return {
          acceptedIds: (shots as Array<{ id: string }>).map(s => s.id),
          rejected: [],
        };
      },
      async createSession() {
        await scheduler.yieldPoint('transport.createSession');
      },
      async finalizeSession() {
        await scheduler.yieldPoint('transport.finalizeSession');
      },
    };

    const outcomes: TxnOutcome[] = [];
    const runActor = (actor: TxnActor, index: number) =>
      (async () => {
        await scheduler.yieldPoint(`actor${index}`);
        const shotId = `shot-${actor.shot}`;
        const sessionId = `session-${actor.session}`;
        let target = '';
        let owner: string = OWNERS[actor.owner];
        try {
          switch (actor.op) {
            case 'saveAnalysis':
              target = shotId;
              owner = currentOwner();
              await saveAnalysis(
                db,
                realAnalysis({ id: shotId, overallScore: 5 + actor.shot }),
                actor.permit,
              );
              break;
            case 'saveLocalOnly':
              target = shotId;
              owner = currentOwner();
              await saveLocalOnlyAnalysis(
                db,
                realAnalysis({
                  id: shotId,
                  overallScore: null,
                  resultKind: 'low_confidence',
                }),
              );
              break;
            case 'saveSession':
              target = sessionId;
              owner = currentOwner();
              await saveSession(db, {
                id: sessionId,
                mode: 'live',
                shotType: null,
                focusCheckpoint: null,
                startedAt: '2026-01-01T00:00:00.000Z',
              });
              break;
            case 'finishSession':
              target = sessionId;
              owner = currentOwner();
              await finishSession(db, sessionId, { shots: 1 });
              break;
            case 'purge':
              target = owner;
              await purgeOwnerData(db, owner);
              break;
            case 'drain':
              owner = currentOwner();
              target = owner;
              await drainOutbox(db, transport);
              break;
            case 'list':
              owner = currentOwner();
              target = owner;
              await listShots(db);
              break;
            case 'rotate':
              target = owner;
              setActiveDataOwner(owner);
              break;
            case 'logout':
              target = SIGNED_OUT_DATA_OWNER;
              setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
              break;
          }
          outcomes.push({ index, op: actor.op, owner, target, result: 'ok' });
        } catch (error) {
          outcomes.push({
            index,
            op: actor.op,
            owner,
            target,
            result: errorMessage(error),
          });
        }
      })();
    const actors =
      mode === 'concurrent'
        ? inputs.actors.map(runActor)
        : [
            (async () => {
              for (const [index, actor] of inputs.actors.entries()) {
                await runActor(actor, index);
              }
            })(),
          ];
    const settled = await settleWithin(actors, WALL_MS);
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);

    // Post-state through an independent connection (the shared handle may be
    // mid-transaction if the run deadlocked).
    let inTxn = false;
    try {
      await db.execute('COMMIT');
      inTxn = true;
    } catch {
      // No transaction was left open — the expected state.
    }
    seam.closeAll();
    const raw = seam.rawConnection();
    const shots = raw
      .prepare(`SELECT owner_key, id, result_kind FROM local_shot`)
      .all() as Array<{ owner_key: string; id: string; result_kind: string }>;
    const outbox = raw
      .prepare(`SELECT owner_key, kind, payload FROM outbox`)
      .all() as Array<{ owner_key: string; kind: string; payload: string }>;
    const receipts = raw
      .prepare(`SELECT owner_key, entity_id FROM sync_receipt`)
      .all() as Array<{ owner_key: string; entity_id: string }>;
    const sessions = raw
      .prepare(`SELECT owner_key, id, completed FROM local_session`)
      .all() as Array<{ owner_key: string; id: string; completed: number }>;
    const integrity = integrityOk(seam);
    raw.close();

    const shotSet = new Set(shots.map(s => `${s.owner_key}|${s.id}`));
    const sessionSet = new Set(sessions.map(s => `${s.owner_key}|${s.id}`));
    const receiptSet = new Set(
      receipts.map(r => `${r.owner_key}|${r.entity_id}`),
    );
    const outboxByTarget = new Map<string, number>();
    const orphanOutbox: string[] = [];
    for (const row of outbox) {
      const payload = JSON.parse(row.payload) as { id: string };
      const key = `${row.owner_key}|${payload.id}`;
      outboxByTarget.set(
        `${row.kind}|${key}`,
        (outboxByTarget.get(`${row.kind}|${key}`) ?? 0) + 1,
      );
      // session.finalize is written unconditionally by finishSession (an
      // UPDATE that hit nothing still enqueues), so only rows whose writer
      // inserts the parent in the same transaction can be orphans.
      const hasParent =
        row.kind === 'shot.sync'
          ? shotSet.has(key)
          : row.kind === 'session.create'
            ? sessionSet.has(key)
            : true;
      if (!hasParent) orphanOutbox.push(`${row.kind}|${key}`);
    }

    const purgedOwners = new Set(
      outcomes.filter(o => o.op === 'purge').map(o => o.owner),
    );
    const drained = outcomes.some(o => o.op === 'drain');
    const byTarget = new Map<string, TxnOutcome[]>();
    for (const o of outcomes) {
      const key = `${o.op}|${o.owner}|${o.target}`;
      byTarget.set(key, [...(byTarget.get(key) ?? []), o]);
    }

    const tracesOfFailure: string[] = [];
    const lostAcknowledged: string[] = [];
    for (const [key, group] of byTarget) {
      const [op, owner, target] = key.split('|') as [TxnOp, string, string];
      const okCount = group.filter(o => o.result === 'ok').length;
      const rowKey = `${owner}|${target}`;
      if (op === 'saveAnalysis' || op === 'saveLocalOnly') {
        const localOnlyOk = (
          byTarget.get(`saveLocalOnly|${owner}|${target}`) ?? []
        ).some(o => o.result === 'ok');
        const analysisOk = (
          byTarget.get(`saveAnalysis|${owner}|${target}`) ?? []
        ).some(o => o.result === 'ok');
        if (!localOnlyOk && !analysisOk) {
          if (
            shotSet.has(rowKey) ||
            (outboxByTarget.get(`shot.sync|${rowKey}`) ?? 0) > 0
          ) {
            tracesOfFailure.push(key);
          }
        }
        if (okCount > 0 && !purgedOwners.has(owner) && !shotSet.has(rowKey)) {
          lostAcknowledged.push(key);
        }
        if (
          op === 'saveAnalysis' &&
          okCount > 0 &&
          !purgedOwners.has(owner) &&
          (outboxByTarget.get(`shot.sync|${rowKey}`) ?? 0) === 0 &&
          !receiptSet.has(rowKey)
        ) {
          lostAcknowledged.push(`${key}:outbox`);
        }
      }
      if (op === 'saveSession') {
        const created = outboxByTarget.get(`session.create|${rowKey}`) ?? 0;
        if (okCount === 0 && created > 0) tracesOfFailure.push(key);
        if (
          okCount > 0 &&
          !purgedOwners.has(owner) &&
          !drained &&
          created === 0
        ) {
          lostAcknowledged.push(key);
        }
      }
      if (op === 'finishSession') {
        const finalized = outboxByTarget.get(`session.finalize|${rowKey}`) ?? 0;
        if (okCount === 0 && finalized > 0) tracesOfFailure.push(key);
        if (okCount > 0 && !purgedOwners.has(owner) && !drained) {
          // saveSession on the same id is INSERT OR REPLACE and legitimately
          // resets `completed`; only the finalize outbox row is unconditional.
          const reSaved = (
            byTarget.get(`saveSession|${owner}|${target}`) ?? []
          ).some(o => o.result === 'ok');
          const row = sessions.find(
            s => s.owner_key === owner && s.id === target,
          );
          if (finalized === 0 || (!reSaved && row?.completed !== 1)) {
            lostAcknowledged.push(key);
          }
        }
      }
    }

    const errorKinds = outcomes
      .filter(o => o.result !== 'ok')
      .map(o => classifyError(o.result));
    const failedOps = countBy(
      outcomes
        .filter(o => o.result !== 'ok')
        .map(o => `${o.op}:${classifyError(o.result)}`),
    );
    const maxOutboxPerTarget = Math.max(0, ...outboxByTarget.values());
    const expectedErrors = errorKinds.every(
      kind => kind === 'signed-out' || kind === 'ok',
    );

    const invariants: Record<string, boolean> = {
      noDeadlock: !settled.deadlocked,
      noOpenTransactionLeft: !inTxn,
      integrityOk: integrity,
      noOrphanOutbox: orphanOutbox.length === 0,
      failedOperationLeftNoTrace: tracesOfFailure.length === 0,
      acknowledgedOperationPersisted: lostAcknowledged.length === 0,
      onlyExpectedErrors: expectedErrors,
    };
    return {
      outcomes,
      invariants,
      observed: {
        errorKinds: countBy(errorKinds),
        failedOps,
        maxOutboxPerTarget,
        orphanOutbox: orphanOutbox.slice(0, 6),
        tracesOfFailure: tracesOfFailure.slice(0, 6),
        lostAcknowledged: lostAcknowledged.slice(0, 6),
        outboxRows: outbox.length,
        shots: shots.length,
        receipts: receipts.length,
        yields: scheduler.yields,
        elapsedMs: settled.elapsedMs,
        trace: scheduler.trace.slice(0, 120),
      },
      traceHash: traceHash(scheduler.trace),
    };
  });
}

/** The production writers resolve the owner themselves; this mirrors that
 * read for the outcome record only. */
function currentOwner(): string {
  return getActiveDataOwner();
}

function classifyError(message: string): string {
  if (message === 'ok') return 'ok';
  if (message.includes(NESTED_TXN)) return 'nested-transaction';
  if (message.includes(NO_TXN)) return 'commit-without-transaction';
  if (message.includes('no transaction is active'))
    return 'rollback-without-transaction';
  if (message.includes('Sign in or continue locally')) return 'signed-out';
  if (message.includes('database is locked')) return 'locked';
  if (message.includes('database is not open')) return 'not-open';
  return `other:${message.slice(0, 60)}`;
}

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

async function runTxnInterleave(seed: number): Promise<MatrixRow> {
  const started = Date.now();
  const inputs = txnInputs(seed);
  const options = {
    maxMicroTicks: inputs.maxMicroTicks,
    macroHopProbability: inputs.macroHopProbability,
  };
  const interleaved = await executeTxnScenario(
    inputs,
    makeScheduler(seed, options),
    'concurrent',
  );
  const replay = await executeTxnScenario(
    inputs,
    makeScheduler(seed, options),
    'concurrent',
  );
  const serial = await executeTxnScenario(
    inputs,
    makeSerialScheduler(seed),
    'sequential',
  );

  const invariants: Record<string, boolean> = {
    ...interleaved.invariants,
    replayDeterministic:
      interleaved.traceHash === replay.traceHash &&
      JSON.stringify(interleaved.outcomes) === JSON.stringify(replay.outcomes),
    serialControlHolds: Object.values(serial.invariants).every(Boolean),
  };
  return finishRow(
    {
      suite: SUITE,
      scenario: 'txn-interleave',
      seed,
      inputs: { ...inputs },
      observed: {
        interleaved: {
          outcomes: interleaved.outcomes,
          ...interleaved.observed,
          traceHash: interleaved.traceHash,
        },
        serial: {
          outcomes: serial.outcomes,
          failed: Object.entries(serial.invariants)
            .filter(([, held]) => !held)
            .map(([name]) => name),
        },
      },
      invariants,
    },
    started,
  );
}

// ─── family: clock-skew ───────────────────────────────────────────────────────

async function runClockSkew(seed: number): Promise<MatrixRow> {
  const started = Date.now();
  const rng = makePrng(seed);
  const count = 2 + Math.floor(rng() * 6);
  const skewsMs = Array.from({ length: count }, () =>
    Math.round((rng() - 0.5) * 2 * 36 * 3_600_000),
  );
  const journalMode = pick(rng, ['delete', 'wal'] as const);
  const seam = makeSeam({ rootDir: ROOT_DIR, journalMode });
  return withSeam(seam, async () => {
    setActiveDataOwner(OWNER_A);
    const db = loadGetDb()();
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = `skew-${i}`;
      ids.push(id);
      const capturedAt = new Date(
        Date.UTC(2026, 5, 1) + (skewsMs[i] ?? 0),
      ).toISOString();
      await saveAnalysis(
        db,
        realAnalysis({ id, capturedAtIso: capturedAt }),
        `permit-${seed}-${i}`,
      );
      // The device clock jumped between inserts: created_at is not monotonic.
      await db.execute(
        `UPDATE outbox SET created_at = ? WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
        [capturedAt.replace('T', ' ').slice(0, 19), OWNER_A, id],
      );
    }
    const seen: string[] = [];
    const transport: SyncTransport = {
      async syncShots(shots) {
        for (const shot of shots as Array<{ id: string }>) seen.push(shot.id);
        return {
          acceptedIds: (shots as Array<{ id: string }>).map(s => s.id),
          rejected: [],
        };
      },
      async createSession() {},
      async finalizeSession() {},
    };
    const first = await drainOutbox(db, transport);
    const second = await drainOutbox(db, transport);
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    seam.closeAll();
    const raw = seam.rawConnection();
    const receipts = countRows(
      raw,
      `SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ?`,
      [OWNER_A],
    );
    const remaining = countRows(
      raw,
      `SELECT count(*) AS n FROM outbox WHERE owner_key = ?`,
      [OWNER_A],
    );
    raw.close();
    const invariants: Record<string, boolean> = {
      drainOrderIsInsertionOrder: JSON.stringify(seen) === JSON.stringify(ids),
      everyRowSyncedOnce: first.synced === count && seen.length === count,
      secondDrainIdempotent: second.synced === 0 && seen.length === count,
      oneReceiptPerShot: receipts === count && remaining === 0,
      integrityOk: integrityOk(seam),
    };
    return finishRow(
      {
        suite: SUITE,
        scenario: 'clock-skew',
        seed,
        inputs: { count, skewsMs, journalMode },
        observed: { seen, first, second, receipts, remaining },
        invariants,
      },
      started,
    );
  });
}

// ─── suite ────────────────────────────────────────────────────────────────────

if (sqlite === null) {
  describe('db concurrency stress (re-exec under --experimental-sqlite)', () => {
    it(
      'runs the whole file under node --experimental-sqlite',
      () => {
        if (nodeProcess.env['STRESS_SQLITE_CHILD'] === '1') {
          throw new Error(
            'node:sqlite is unavailable even with --experimental-sqlite; Node >= 22.5 is required',
          );
        }
        const jestBin = resolveModule('jest/bin/jest');
        const result = childProcess.spawnSync(
          nodeProcess.execPath,
          [
            jestBin,
            '--ci',
            '--runInBand',
            '--silent',
            '--runTestsByPath',
            __filename,
          ],
          {
            cwd: path.resolve(__dirname, '../..'),
            env: {
              ...nodeProcess.env,
              STRESS_SQLITE_CHILD: '1',
              NODE_OPTIONS:
                `${nodeProcess.env['NODE_OPTIONS'] ?? ''} --experimental-sqlite`.trim(),
            },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(
          -6000,
        );
        expect({ status: result.status, tail }).toEqual({ status: 0, tail });
      },
      30 * 60_000,
    );
  });
} else {
  describe('db.ts concurrency stress (real SQLite via node:sqlite, seeded scheduler)', () => {
    let statementCounts: number[] = [];
    const ensureStatementCounts = (): number[] => {
      if (statementCounts.length === 0) {
        statementCounts = [
          migrationStatementCount(false),
          migrationStatementCount(true),
        ];
      }
      return statementCounts;
    };

    beforeAll(() => {
      fs.mkdirSync(ROOT_DIR, { recursive: true });
    });

    afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

    afterAll(() => {
      const summary = {
        ...summarize(allRows),
        iterationsPerFamily: ITER,
        replaySeed,
        strict: STRICT,
        advisoryInvariants: [...ADVISORY_INVARIANTS],
        executions:
          allRows.length +
          2 * allRows.filter(row => row.scenario === 'txn-interleave').length,
        migrationStatementCounts: {
          fresh: statementCounts[0] ?? null,
          legacy: statementCounts[1] ?? null,
        },
        byScenario: allRows.reduce<
          Record<string, { rows: number; failed: number }>
        >((acc, row) => {
          const slot = (acc[row.scenario] ??= { rows: 0, failed: 0 });
          slot.rows += 1;
          if (!row.ok) slot.failed += 1;
          return acc;
        }, {}),
        sqliteVersion: (() => {
          const probe = new sqlite.DatabaseSync(':memory:');
          const row = probe.prepare('SELECT sqlite_version() AS v').get() as {
            v: string;
          };
          probe.close();
          return row.v;
        })(),
      };
      writeStressJson('db-concurrency.rows.json', allRows);
      writeStressJson('db-concurrency.summary.json', summary);
      writeStressText('db-concurrency.matrix.md', matrixMarkdown(allRows));
      fs.rmSync(ROOT_DIR, { recursive: true, force: true });
    });

    it(
      `open-burst: ${ITER} seeded bursts of concurrent getDb() callers`,
      async () => {
        const rows: MatrixRow[] = [];
        for (const seed of seedsFor('open-burst')) {
          rows.push(await runOpenBurst(seed, ensureStatementCounts()));
        }
        expect(failuresOf(rows)).toEqual([]);
      },
      10 * 60_000,
    );

    it(
      `two-actor-file: ${ITER} seeded second-connection interruptions of the migration`,
      async () => {
        const rows: MatrixRow[] = [];
        for (const seed of seedsFor('two-actor-file')) {
          rows.push(
            await runTwoActorFile(seed, ensureStatementCounts()[1] ?? 1),
          );
        }
        expect(failuresOf(rows)).toEqual([]);
      },
      10 * 60_000,
    );

    it(
      `close-race: ${ITER} seeded close()/write/read races on the cached handle`,
      async () => {
        const rows: MatrixRow[] = [];
        for (const seed of seedsFor('close-race')) {
          rows.push(await runCloseRace(seed));
        }
        expect(failuresOf(rows)).toEqual([]);
      },
      10 * 60_000,
    );

    it(
      `txn-interleave: ${ITER} seeded interleavings of repository transactions on one connection (+replay +serial control)`,
      async () => {
        const rows: MatrixRow[] = [];
        for (const seed of seedsFor('txn-interleave')) {
          rows.push(await runTxnInterleave(seed));
        }
        expect(failuresOf(rows)).toEqual([]);
      },
      10 * 60_000,
    );

    it(
      `clock-skew: ${ITER} seeded non-monotonic created_at outboxes`,
      async () => {
        const rows: MatrixRow[] = [];
        for (const seed of seedsFor('clock-skew')) {
          rows.push(await runClockSkew(seed));
        }
        expect(failuresOf(rows)).toEqual([]);
      },
      10 * 60_000,
    );
  });
}
