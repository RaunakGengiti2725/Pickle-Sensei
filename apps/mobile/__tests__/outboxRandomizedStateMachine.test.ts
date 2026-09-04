/**
 * Seeded randomized state-machine test over the REAL sync outbox +
 * repository + offline-capability derivation (harness/outbox/*).
 *
 * Seeds 2000-2099 × SEQUENCES_PER_SEED sequences (default 20 → 2000
 * sequences) drive saveAnalysis / saveSession / finishSession /
 * enqueueEvaluationTrial / purgeOwnerData / drainOutbox (through the real
 * createTransport fetch client) against an independent durable store under
 * randomized network + storage faults, asserting after every step:
 *   - no committed scored shot is ever lost (receipted or still queued),
 *   - no receipt exists for a shot the server never stored,
 *   - the server holds each shot once (no duplicate accepted shots),
 *   - outbox ids are strictly monotone and never reused,
 *   - attempts accounting matches the transient/permanent contract per row,
 *   - derived status (deriveUploadQueueStatus / getShotOutboxStatus /
 *     hasShotSyncReceipt) agrees with the durable rows,
 *   - a shot whose session the server does not know makes progress on every
 *     healthy drain: its session.create is re-enqueued from local_session
 *     (I-SESSION-REPAIR) or its bounded budget is charged, so after the
 *     healthy_convergence drains it is receipted or exhausted — never still
 *     retryable (I-ORPHAN-SHOT-PROGRESS / I-SHOT-BEHIND-FAILED-SESSION).
 *
 * Every failure prints `{seed, index, sequenceSeed}` plus the operation
 * trace, and `OUTBOX_FUZZ_REPLAY=<seed>:<index>` re-runs exactly that one.
 * `OUTBOX_FUZZ_ARTIFACTS=<dir>` writes the raw JSON tables / matrices /
 * heap numbers there (used by harness/outbox/run.sh).
 *
 * The real-SQLite differential leg needs node:sqlite
 * (`NODE_OPTIONS=--experimental-sqlite` on Node 22.12); it is reported as
 * skipped — never as passing — when the module is unavailable.
 */
import { createMemoryDb } from '../harness/outbox/memoryDb';
import { env, fs, heapUsed, path, rss } from '../harness/outbox/nodeEnv';
import { createSqliteDb, isSqliteAvailable } from '../harness/outbox/sqliteDb';
import {
  runSequence,
  type SequenceResult,
} from '../harness/outbox/stateMachine';
import { canonicalSnapshot } from '../harness/outbox/durableStore';

const FIRST_SEED = 2000;
const LAST_SEED = 2099;
const SEQUENCES_PER_SEED = Number(env('OUTBOX_FUZZ_SEQUENCES') ?? 20);
const SQLITE_PER_SEED = Number(env('OUTBOX_FUZZ_SQLITE_SEQUENCES') ?? 4);
const ARTIFACT_DIR = env('OUTBOX_FUZZ_ARTIFACTS') ?? null;
const REPLAY = env('OUTBOX_FUZZ_REPLAY') ?? null;

const clock = {
  advance: (ms: number) => jest.advanceTimersByTimeAsync(ms),
};

function describeFailure(result: SequenceResult): string {
  const lines = [
    `seed=${result.seed} index=${result.index} sequenceSeed=${result.sequenceSeed} backend=${result.backend}`,
    `replay: OUTBOX_FUZZ_REPLAY=${result.seed}:${result.index} npx jest __tests__/outboxRandomizedStateMachine.test.ts`,
    ...result.violations.map(
      v => `  [${v.invariant}] step ${v.step}: ${v.detail}`,
    ),
    '  trace:',
    ...result.trace.flatMap(t => [
      `    ${t.step} (${t.owner}) ${JSON.stringify(t.operation)} -> ${t.result}`,
      ...t.requests.map(
        r =>
          `        req#${r.n} ${r.path} bearer=${r.bearer ?? 'none'} outcome=${r.outcome} status=${r.status} shots=[${r.shotIds.join(',')}] trials=[${r.trialIds.join(',')}] session=${r.sessionId ?? '-'} accepted=[${r.acceptedIds.join(',')}] rejected=${JSON.stringify(r.rejected)}`,
      ),
    ]),
  ];
  return lines.join('\n');
}

interface RunTable {
  seed: number;
  index: number;
  sequenceSeed: number;
  backend: string;
  ok: boolean;
  steps: number;
  drains: number;
  requests: number;
  shotsSaved: number;
  receipts: number;
  serverStoredShots: number;
  faultsFired: number;
  resendAfterReceipt: number;
  idempotentReplays: number;
  orphanShotsStuck: number;
  sessionRepairs: number;
  sessionNotFoundCharges: number;
  exhaustedRows: number;
  maxOutboxDepth: number;
  statements: number;
  heapUsedBefore: number;
  heapUsedAfter: number;
  durationMs: number;
  violations: number;
  observations: string[];
}

function toRow(result: SequenceResult): RunTable {
  return {
    seed: result.seed,
    index: result.index,
    sequenceSeed: result.sequenceSeed,
    backend: result.backend,
    ok: result.ok,
    steps: result.metrics.steps,
    drains: result.metrics.drains,
    requests: result.metrics.requests,
    shotsSaved: result.metrics.shotsSaved,
    receipts: result.metrics.receipts,
    serverStoredShots: result.metrics.serverStoredShots,
    faultsFired: result.metrics.faultsFired,
    resendAfterReceipt: result.metrics.resendAfterReceipt,
    idempotentReplays: result.metrics.idempotentReplays,
    orphanShotsStuck: result.metrics.orphanShotsStuck,
    sessionRepairs: result.metrics.sessionRepairs,
    sessionNotFoundCharges: result.metrics.sessionNotFoundCharges,
    exhaustedRows: result.metrics.exhaustedRows,
    maxOutboxDepth: result.metrics.maxOutboxDepth,
    statements: result.metrics.statements,
    heapUsedBefore: result.heapUsedBefore,
    heapUsedAfter: result.heapUsedAfter,
    durationMs: result.durationMs,
    violations: result.violations.length,
    observations: result.observations.map(o => o.kind),
  };
}

function addMatrix(
  target: Record<string, number>,
  source: Record<string, number>,
) {
  for (const [k, v] of Object.entries(source)) target[k] = (target[k] ?? 0) + v;
}

function writeArtifacts(
  name: string,
  rows: RunTable[],
  results: SequenceResult[],
) {
  if (!ARTIFACT_DIR) return;
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const opMatrix: Record<string, number> = {};
  const outcomeMatrix: Record<string, number> = {};
  const invariantMatrix: Record<string, number> = {};
  const observationMatrix: Record<string, number> = {};
  for (const r of results) {
    addMatrix(opMatrix, r.metrics.opMatrix);
    addMatrix(outcomeMatrix, r.metrics.outcomeMatrix);
    for (const v of r.violations)
      invariantMatrix[v.invariant] = (invariantMatrix[v.invariant] ?? 0) + 1;
    for (const o of r.observations)
      observationMatrix[o.kind] = (observationMatrix[o.kind] ?? 0) + 1;
  }
  const heaps = rows.map(r => r.heapUsedAfter);
  const summary = {
    name,
    sequences: rows.length,
    failures: rows.filter(r => !r.ok).length,
    totals: {
      steps: rows.reduce((a, r) => a + r.steps, 0),
      drains: rows.reduce((a, r) => a + r.drains, 0),
      requests: rows.reduce((a, r) => a + r.requests, 0),
      shotsSaved: rows.reduce((a, r) => a + r.shotsSaved, 0),
      receipts: rows.reduce((a, r) => a + r.receipts, 0),
      serverStoredShots: rows.reduce((a, r) => a + r.serverStoredShots, 0),
      faultsFired: rows.reduce((a, r) => a + r.faultsFired, 0),
      resendAfterReceipt: rows.reduce((a, r) => a + r.resendAfterReceipt, 0),
      idempotentReplays: rows.reduce((a, r) => a + r.idempotentReplays, 0),
      orphanShotsStuck: rows.reduce((a, r) => a + r.orphanShotsStuck, 0),
      sessionRepairs: rows.reduce((a, r) => a + r.sessionRepairs, 0),
      sessionNotFoundCharges: rows.reduce(
        (a, r) => a + r.sessionNotFoundCharges,
        0,
      ),
      statements: rows.reduce((a, r) => a + r.statements, 0),
      durationMs: rows.reduce((a, r) => a + r.durationMs, 0),
    },
    heap: {
      minHeapUsed: Math.min(...heaps),
      maxHeapUsed: Math.max(...heaps),
      finalHeapUsed: heapUsed(),
      rss: rss(),
    },
    opMatrix,
    outcomeMatrix,
    invariantMatrix,
    observationMatrix,
  };
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, `${name}.summary.json`),
    JSON.stringify(summary, null, 2),
  );
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, `${name}.sequences.json`),
    JSON.stringify(rows),
  );
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, `${name}.failures.json`),
    JSON.stringify(
      results
        .filter(r => !r.ok)
        .map(r => ({
          seed: r.seed,
          index: r.index,
          sequenceSeed: r.sequenceSeed,
          backend: r.backend,
          violations: r.violations,
          trace: r.trace,
          finalSnapshot: r.finalSnapshot,
        })),
      null,
      2,
    ),
  );
  if (REPLAY) {
    // A single replayed sequence: dump everything (operations, oracle
    // choices, every request, observations, final durable snapshot).
    for (const r of results) {
      fs.writeFileSync(
        path.join(ARTIFACT_DIR, `${name}.replay.${r.seed}-${r.index}.json`),
        JSON.stringify(r, null, 2),
      );
    }
  }
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, `${name}.observations.json`),
    JSON.stringify(
      results
        .filter(r => r.observations.length > 0)
        .map(r => ({
          seed: r.seed,
          index: r.index,
          sequenceSeed: r.sequenceSeed,
          observations: r.observations,
        })),
      null,
      2,
    ),
  );
}

function plannedRuns(perSeed: number): Array<[number, number]> {
  if (REPLAY) {
    const [seed, index] = REPLAY.split(':').map(Number);
    if (
      seed === undefined ||
      index === undefined ||
      Number.isNaN(seed) ||
      Number.isNaN(index)
    ) {
      throw new Error(
        `OUTBOX_FUZZ_REPLAY must be <seed>:<index>, got ${REPLAY}`,
      );
    }
    return [[seed, index]];
  }
  const runs: Array<[number, number]> = [];
  for (let seed = FIRST_SEED; seed <= LAST_SEED; seed++) {
    for (let index = 0; index < perSeed; index++) runs.push([seed, index]);
  }
  return runs;
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['performance', 'nextTick', 'queueMicrotask', 'setImmediate'],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('randomized outbox state machine (seeds 2000-2099)', () => {
  it(
    `holds every outbox invariant across ${plannedRuns(SEQUENCES_PER_SEED).length} sequences on the in-memory reference store`,
    async () => {
      const results: SequenceResult[] = [];
      for (const [seed, index] of plannedRuns(SEQUENCES_PER_SEED)) {
        results.push(
          await runSequence({
            seed,
            index,
            createDb: createMemoryDb,
            clock,
            keepTrace: true,
          }),
        );
      }
      const rows = results.map(toRow);
      writeArtifacts('memory', rows, results);
      const failures = results.filter(r => !r.ok);
      if (failures.length > 0) {
        throw new Error(
          `${failures.length}/${results.length} sequences violated invariants\n` +
            failures.slice(0, 5).map(describeFailure).join('\n\n'),
        );
      }
      expect(results.length).toBeGreaterThanOrEqual(REPLAY ? 1 : 2000);
      // The run must have exercised the whole operation alphabet.
      const ops = new Set(
        results.flatMap(r => Object.keys(r.metrics.opMatrix)),
      );
      for (const op of [
        'save_shot',
        'save_shot_in_set',
        'save_shot_burst',
        'save_shot_duplicate',
        'save_abstention',
        'start_set',
        'finish_session',
        'enqueue_trial',
        'drain',
        'drain_concurrent',
        'switch_owner',
        'write_signed_out',
        'purge_owner',
        'corrupt_row',
        'healthy_convergence',
      ]) {
        if (!REPLAY) expect(ops).toContain(op);
      }
      const outcomes = new Set(
        results.flatMap(r => Object.keys(r.metrics.outcomeMatrix)),
      );
      for (const outcome of [
        'ok',
        'offline',
        'timeout',
        'http_500',
        'http_429',
        'http_401',
        'http_400',
        'response_lost',
        'malformed_body',
        'wrong_shape',
      ]) {
        if (!REPLAY) expect(outcomes).toContain(outcome);
      }
      if (!REPLAY) {
        expect(rows.reduce((a, r) => a + r.faultsFired, 0)).toBeGreaterThan(0);
        expect(rows.reduce((a, r) => a + r.receipts, 0)).toBeGreaterThan(0);
        // Orphan shots and shots behind a failed session are hard invariants
        // now, not observations: no sequence may record them softly, and the
        // campaign must have exercised both the repair and the charge path.
        const observed = new Set(
          results.flatMap(r => r.observations.map(o => o.kind)),
        );
        expect(observed).not.toContain('O-ORPHAN-SHOT-STUCK');
        expect(observed).not.toContain('O-SHOT-BEHIND-FAILED-SESSION');
        expect(rows.reduce((a, r) => a + r.orphanShotsStuck, 0)).toBe(0);
        expect(rows.reduce((a, r) => a + r.sessionRepairs, 0)).toBeGreaterThan(
          0,
        );
        expect(
          rows.reduce((a, r) => a + r.sessionNotFoundCharges, 0),
        ).toBeGreaterThan(0);
      }
    },
    20 * 60 * 1000,
  );

  const sqliteIt = isSqliteAvailable() ? it : it.skip;
  sqliteIt(
    `agrees with real SQLite (node:sqlite, production schema) across ${plannedRuns(SQLITE_PER_SEED).length} differential sequences`,
    async () => {
      const results: SequenceResult[] = [];
      const divergences: string[] = [];
      for (const [seed, index] of plannedRuns(SQLITE_PER_SEED)) {
        const sqlite = await runSequence({
          seed,
          index,
          createDb: createSqliteDb,
          clock,
          keepTrace: true,
        });
        const memory = await runSequence({
          seed,
          index,
          createDb: createMemoryDb,
          clock,
          keepTrace: true,
        });
        results.push(sqlite);
        const a = JSON.stringify(canonicalSnapshot(sqlite.finalSnapshot));
        const b = JSON.stringify(canonicalSnapshot(memory.finalSnapshot));
        if (a !== b) {
          divergences.push(
            `seed=${seed} index=${index}: final durable state differs between sqlite and memory\n  sqlite=${a.slice(0, 2000)}\n  memory=${b.slice(0, 2000)}`,
          );
        }
        const ta = sqlite.trace.map(t => t.result).join('|');
        const tb = memory.trace.map(t => t.result).join('|');
        if (ta !== tb)
          divergences.push(
            `seed=${seed} index=${index}: step results differ\n  sqlite=${ta}\n  memory=${tb}`,
          );
      }
      const rows = results.map(toRow);
      writeArtifacts('sqlite', rows, results);
      if (ARTIFACT_DIR) {
        fs.writeFileSync(
          path.join(ARTIFACT_DIR, 'sqlite.divergences.json'),
          JSON.stringify(divergences, null, 2),
        );
      }
      const failures = results.filter(r => !r.ok);
      if (failures.length > 0) {
        throw new Error(
          `${failures.length}/${results.length} sqlite sequences violated invariants\n` +
            failures.slice(0, 5).map(describeFailure).join('\n\n'),
        );
      }
      expect(divergences).toEqual([]);
    },
    20 * 60 * 1000,
  );
});
