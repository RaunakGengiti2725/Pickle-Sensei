/**
 * mod-sync-outbox / LENS randomized-seeded — seeded randomized long-run
 * model check of `drainOutbox()` (src/data/sync.ts).
 *
 * Every sequence is regenerated from its seed (mulberry32, see
 * testing/stress/outbox/actions.ts), replayed against the REAL drain over
 * (a) an in-memory reference store and (b) the real SQLite engine
 * (`node:sqlite`) when this Node exposes it, and model-checked after every
 * action against invariants I1–I10 documented in
 * testing/stress/outbox/runner.ts. Failing seeds are minimised (greedy
 * 1-minimal), re-run 10× for a flake rate, and every seed → outcome lands in
 * `artifacts/stress/outbox-randomized/<STRESS_RUN_ID>/results.json`
 * (repo-root relative).
 *
 * Knobs:
 *   STRESS_ITER    number of seeds per backend (default 40; campaign ≥ 2000)
 *   STRESS_SEED0   first seed (default 1)
 *   STRESS_SEED    replay exactly one seed (with full trace in the artifact)
 *   STRESS_RUN_ID  artifact folder name (default "local")
 *
 * Campaign: `STRESS_ITER=2000 NODE_OPTIONS=--experimental-sqlite npx jest
 * --ci --silent __tests__/stress/outboxDrainRandomized`.
 */
import { setActiveDataOwner } from '../../src/data/accountScope';
import {
  fs,
  loadNodeSqlite,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  MAX_LENGTH,
  MIN_LENGTH,
  generateSequence,
  type Sequence,
} from '../../testing/stress/outbox/actions';
import {
  createModelOutboxDb,
  createSqliteOutboxDb,
  type StressDb,
} from '../../testing/stress/outbox/backends';
import {
  minimizeSequence,
  runSequence,
  traceDigest,
  type RunResult,
  type Violation,
} from '../../testing/stress/outbox/runner';

declare const __dirname: string;

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    throw new Error('op-sqlite must not be opened by the stress harness');
  },
}));

const env = nodeProcess.env;
const ITER = Math.max(1, Number(env['STRESS_ITER'] ?? '40'));
const SEED0 = Number(env['STRESS_SEED0'] ?? '1');
const PINNED_SEED = env['STRESS_SEED'] ? Number(env['STRESS_SEED']) : null;
const RUN_ID = env['STRESS_RUN_ID'] ?? 'local';
const FLAKE_RERUNS = 10;

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const artifactDir = path.join(
  repoRoot,
  'artifacts',
  'stress',
  'outbox-randomized',
  RUN_ID,
);

type BackendName = StressDb['name'];

interface SeedOutcome {
  seed: number;
  backend: BackendName;
  length: number;
  drains: number;
  outcome: 'HELD' | 'BROKEN';
  deterministic: boolean;
  violations: Array<Pick<Violation, 'invariant' | 'step' | 'detail'>>;
  minimized?: { length: number; actions: unknown[]; runs: number };
  flakeRate?: string;
}

interface BackendReport {
  backend: BackendName;
  status: 'ran' | 'unavailable';
  reason?: string;
  seeds: number;
  sequences: number;
  actions: number;
  drains: number;
  held: number;
  broken: number;
  nondeterministic: number;
  durationMs: number;
  /** Sum of per-sequence coverage counters (first run of each seed). */
  coverage: Record<string, number>;
}

const sqlite = loadNodeSqlite();

function makeBackend(name: BackendName): StressDb {
  if (name === 'model') return createModelOutboxDb();
  if (!sqlite) throw new Error('node:sqlite unavailable');
  return createSqliteOutboxDb(sqlite);
}

async function runOnFreshBackend(
  name: BackendName,
  sequence: Sequence,
): Promise<RunResult> {
  const backend = makeBackend(name);
  try {
    return await runSequence(sequence, {
      backend,
      setOwner: owner => setActiveDataOwner(owner),
    });
  } finally {
    backend.close();
  }
}

function seedsForRun(): number[] {
  if (PINNED_SEED !== null) return [PINNED_SEED];
  const seeds: number[] = [];
  for (let i = 0; i < ITER; i += 1) seeds.push(SEED0 + i);
  return seeds;
}

async function campaign(
  name: BackendName,
  table: SeedOutcome[],
  traces: Record<string, unknown>,
): Promise<BackendReport> {
  const started = Date.now();
  const report: BackendReport = {
    backend: name,
    status: 'ran',
    seeds: 0,
    sequences: 0,
    actions: 0,
    drains: 0,
    held: 0,
    broken: 0,
    nondeterministic: 0,
    durationMs: 0,
    coverage: {},
  };
  for (const seed of seedsForRun()) {
    const sequence = generateSequence(seed);
    expect(sequence.actions.length).toBeGreaterThanOrEqual(MIN_LENGTH);
    expect(sequence.actions.length).toBeLessThanOrEqual(MAX_LENGTH);
    const first = await runOnFreshBackend(name, sequence);
    const second = await runOnFreshBackend(name, sequence);
    const deterministic = traceDigest(first) === traceDigest(second);
    report.seeds += 1;
    report.sequences += 2;
    report.actions += sequence.actions.length * 2;
    report.drains += first.drainsRun + second.drainsRun;
    for (const [key, count] of Object.entries(first.coverage)) {
      report.coverage[key] = (report.coverage[key] ?? 0) + count;
    }
    const violations: Violation[] = [...first.violations];
    if (!deterministic) {
      report.nondeterministic += 1;
      violations.push({
        invariant: 'I10',
        step: -1,
        action: sequence.actions[0]!,
        detail: 'same seed produced a different trace on the second run',
      });
    }
    const outcome: SeedOutcome = {
      seed,
      backend: name,
      length: sequence.actions.length,
      drains: first.drainsRun,
      outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
      deterministic,
      violations: violations.map(({ invariant, step, detail }) => ({
        invariant,
        step,
        detail,
      })),
    };
    if (violations.length > 0) {
      report.broken += 1;
      const target = first.violations[0];
      if (target) {
        const minimized = await minimizeSequence(
          sequence,
          target.invariant,
          candidate => runOnFreshBackend(name, candidate),
        );
        report.sequences += minimized.runs;
        outcome.minimized = {
          length: minimized.sequence.actions.length,
          actions: minimized.sequence.actions,
          runs: minimized.runs,
        };
      }
      let failures = 0;
      for (let i = 0; i < FLAKE_RERUNS; i += 1) {
        const rerun = await runOnFreshBackend(name, sequence);
        report.sequences += 1;
        if (rerun.violations.length > 0) failures += 1;
      }
      outcome.flakeRate = `${failures}/${FLAKE_RERUNS}`;
      traces[`${name}:${seed}`] = first.trace;
    } else {
      report.held += 1;
      if (PINNED_SEED !== null) traces[`${name}:${seed}`] = first.trace;
    }
    table.push(outcome);
  }
  report.durationMs = Date.now() - started;
  return report;
}

function writeArtifacts(
  reports: BackendReport[],
  table: SeedOutcome[],
  traces: Record<string, unknown>,
): string {
  fs.mkdirSync(artifactDir, { recursive: true });
  const summary = {
    unit: 'mod-sync-outbox',
    lens: 'randomized-seeded',
    node: nodeProcess.version,
    knobs: { STRESS_ITER: ITER, STRESS_SEED0: SEED0, STRESS_SEED: PINNED_SEED },
    invariants: 'testing/stress/outbox/runner.ts I1–I10',
    backends: reports,
    totalSequencesExecuted: reports.reduce((sum, r) => sum + r.sequences, 0),
    totalDrainsExecuted: reports.reduce((sum, r) => sum + r.drains, 0),
    broken: table.filter(row => row.outcome === 'BROKEN'),
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(artifactDir, 'results.json'),
    JSON.stringify({ summary, seeds: table }, null, 2),
  );
  fs.writeFileSync(
    path.join(artifactDir, 'traces.json'),
    JSON.stringify(traces, null, 2),
  );
  return artifactDir;
}

describe('mod-sync-outbox randomized-seeded stress (drainOutbox model check)', () => {
  const table: SeedOutcome[] = [];
  const traces: Record<string, unknown> = {};
  const reports: BackendReport[] = [];

  afterAll(() => {
    const dir = writeArtifacts(reports, table, traces);
    const brief = reports.map(report => ({
      ...report,
      coverage: `${Object.keys(report.coverage).length} keys`,
    }));
    console.log(
      `[stress:outbox] ${JSON.stringify(brief)} → ${path.join(dir, 'results.json')}`,
    );
  });

  it('generates 5–60 legal/near-legal actions per seed, deterministically', () => {
    for (const seed of [1, 2, 3, 4096, 2 ** 31 - 1]) {
      const a = generateSequence(seed);
      const b = generateSequence(seed);
      expect(a.actions.length).toBeGreaterThanOrEqual(MIN_LENGTH);
      expect(a.actions.length).toBeLessThanOrEqual(MAX_LENGTH);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
    expect(JSON.stringify(generateSequence(1))).not.toBe(
      JSON.stringify(generateSequence(2)),
    );
  });

  it(`holds I1–I10 over ${ITER} seeded sequences on the reference store`, async () => {
    const report = await campaign('model', table, traces);
    reports.push(report);
    const broken = table.filter(
      row => row.backend === 'model' && row.outcome === 'BROKEN',
    );
    expect(broken).toEqual([]);
    expect(report.seeds).toBe(seedsForRun().length);
  });

  it(`holds I1–I10 over ${ITER} seeded sequences on real node:sqlite`, async () => {
    if (!sqlite) {
      const reason = `node:sqlite not loadable on ${nodeProcess.version} (Node >= 22.13, or NODE_OPTIONS=--experimental-sqlite on 22.5–22.12)`;
      reports.push({
        backend: 'sqlite',
        status: 'unavailable',
        reason,
        seeds: 0,
        sequences: 0,
        actions: 0,
        drains: 0,
        held: 0,
        broken: 0,
        nondeterministic: 0,
        durationMs: 0,
        coverage: {},
      });
      throw new Error(`sqlite stage unavailable, not a pass: ${reason}`);
    }
    const report = await campaign('sqlite', table, traces);
    reports.push(report);
    const broken = table.filter(
      row => row.backend === 'sqlite' && row.outcome === 'BROKEN',
    );
    expect(broken).toEqual([]);
    expect(report.seeds).toBe(seedsForRun().length);
  });
});
