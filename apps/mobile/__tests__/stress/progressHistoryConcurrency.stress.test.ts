/**
 * CONCURRENCY stress campaign for unit `mod-progress-api-history`
 * (src/progress/api.ts + practiceHistory.ts + practiceSetProgress.ts).
 *
 * Each iteration is one seeded Promise.all burst against the real module
 * surfaces — see `test-support/stress/progressHistoryConcurrencyHarness.ts`
 * for the scheduler and the invariants. The suite is deterministic: the same
 * seed always builds the same scenario and reaches the same verdict.
 *
 *   STRESS_ITER=<n>      iterations (default 40; the campaign ran 600)
 *   STRESS_SEED=<n>      first seed (default 1)
 *   STRESS_ONLY=<seed>   replay a single seed (a,b,c also accepted)
 *   STRESS_OUT=<dir>     artifact dir (default apps/mobile/artifacts/stress)
 *
 * Known api.ts gap (pinned, not asserted away): `fetchCanonicalProgress`
 * clears its deadline timer once headers arrive and then awaits
 * `response.json()` with no bound (api.ts:159-162). Under a spec-compliant
 * streaming fetch a stalled body therefore hangs the call forever — and with
 * it ProgressScreen's `Promise.all`. React Native 0.87 ships whatwg-fetch
 * over XHR, which only resolves after the FULL body arrived, so the device
 * path is bounded by the same deadline; the gap is reachable only where fetch
 * streams. An iteration whose only violations are of that class counts as
 * `held_with_known`; everything else must hold on every seed.
 */
import {
  runIteration,
  type IterationResult,
} from '../../test-support/stress/progressHistoryConcurrencyHarness';

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');

const KNOWN_GAPS: ReadonlySet<string> = new Set(['unbounded_body_read']);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return Math.floor(value);
}

function seedsToRun(): number[] {
  const only = process.env.STRESS_ONLY;
  if (only) {
    return only
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n));
  }
  const first = envInt('STRESS_SEED', 1);
  const count = envInt('STRESS_ITER', 40);
  return Array.from({ length: count }, (_, i) => first + i);
}

type Verdict = 'held' | 'held_with_known' | 'broken';

interface TableRow {
  seed: number;
  verdict: Verdict;
  violationClasses: Record<string, number>;
  failures: IterationResult['failures'];
  unknownFailures: IterationResult['failures'];
  stats: IterationResult['stats'];
  replay: string;
}

function classify(result: IterationResult): {
  verdict: Verdict;
  unknown: IterationResult['failures'];
} {
  const unknown = result.failures.filter(f => !KNOWN_GAPS.has(f.invariant));
  if (unknown.length > 0) return { verdict: 'broken', unknown };
  return {
    verdict: result.failures.length > 0 ? 'held_with_known' : 'held',
    unknown,
  };
}

const rows: TableRow[] = [];
const seeds = seedsToRun();
/** Real wall-clock budget per seed — the deadlock guard. */
const REAL_BUDGET_MS_PER_SEED = 5_000;

describe('progress api + practice history + practice set concurrency stress', () => {
  afterAll(() => {
    const verdicts = rows.reduce<Record<Verdict, number>>(
      (acc, row) => {
        acc[row.verdict] += 1;
        return acc;
      },
      { held: 0, held_with_known: 0, broken: 0 },
    );
    const classTotals: Record<string, number> = {};
    for (const row of rows) {
      for (const [cls, n] of Object.entries(row.violationClasses)) {
        classTotals[cls] = (classTotals[cls] ?? 0) + n;
      }
    }
    const summary = {
      generatedAt: new Date().toISOString(),
      unit: 'mod-progress-api-history',
      lens: 'concurrency',
      targets: [
        'apps/mobile/src/progress/api.ts',
        'apps/mobile/src/progress/practiceHistory.ts',
        'apps/mobile/src/progress/practiceSetProgress.ts',
      ],
      seeds: { first: seeds[0] ?? null, count: seeds.length },
      scenariosExecuted: rows.length,
      opsExecuted: rows.reduce((n, row) => n + row.stats.launched, 0),
      verdicts,
      violationClassTotals: classTotals,
      knownGapClasses: [...KNOWN_GAPS],
      brokenSeeds: rows.filter(r => r.verdict === 'broken').map(r => r.seed),
      knownGapSeeds: rows
        .filter(r => r.verdict === 'held_with_known')
        .map(r => r.seed),
      maxRealMsPerSeed: rows.reduce(
        (n, row) => Math.max(n, row.stats.realMs),
        0,
      ),
      totalRealMs: rows.reduce((n, row) => n + row.stats.realMs, 0),
      rows,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, 'progressHistoryConcurrency.results.json'),
      JSON.stringify(summary, null, 2),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(seeds.map(seed => [seed] as const))(
    'seed %i: bounded, typed, isolated, header-at-call, pure and oracle-consistent',
    async seed => {
      const result = await runIteration(seed);
      const { verdict, unknown } = classify(result);
      const violationClasses: Record<string, number> = {};
      for (const failure of result.failures) {
        violationClasses[failure.invariant] =
          (violationClasses[failure.invariant] ?? 0) + 1;
      }
      rows.push({
        seed,
        verdict,
        violationClasses,
        failures: result.failures,
        unknownFailures: unknown,
        stats: result.stats,
        replay: result.replay,
      });
      expect(result.stats.realMs).toBeLessThan(REAL_BUDGET_MS_PER_SEED);
      expect(result.stats.launched).toBeGreaterThan(0);
      if (unknown.length > 0) {
        throw new Error(
          `seed ${seed} BROKEN — ${unknown.length} violation(s):\n` +
            unknown
              .map(f => `  [${f.invariant}] ${f.op}: ${f.detail}`)
              .join('\n') +
            `\nreplay: ${result.replay}`,
        );
      }
    },
  );
});
