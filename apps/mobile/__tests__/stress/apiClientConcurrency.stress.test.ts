/**
 * CONCURRENCY stress campaign for `src/data/api.ts` (unit `mod-api-client`).
 *
 * Each iteration is one seeded Promise.all burst against the real api.ts
 * clients wired to the real apiSession store — see
 * `test-support/stress/apiClientConcurrencyHarness.ts` for the scheduler and
 * the invariants. The suite is deterministic: the same seed always builds the
 * same scenario and reaches the same verdict.
 *
 *   STRESS_ITER=<n>      iterations (default 40; the campaign ran 600)
 *   STRESS_SEED=<n>      first seed (default 1)
 *   STRESS_ONLY=<seed>   replay a single seed (a,b,c also accepted)
 *   STRESS_OUT=<dir>     artifact dir (default apps/mobile/artifacts/stress)
 *
 * Known api.ts contract gaps (documented in serverResponseMatrix as F5/F8-ish
 * "2xx with an unreadable / wrong-shape body is handed to the caller") are
 * PINNED, not asserted away: an iteration that hits ONLY those classes counts
 * as `held_with_known` and the table records the class counts. Everything
 * else — bounded settlement, one fetch per op, bearer-at-call-time, exact
 * unauthorized reporting, response isolation, permit contract — must hold on
 * every seed.
 */
import {
  MAX_TIMER_STEPS,
  runIteration,
  type IterationResult,
} from '../../test-support/stress/apiClientConcurrencyHarness';

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

/**
 * Pre-existing api.ts behaviour on 2xx bodies the client does not validate.
 * These are the ONLY violation classes an iteration may carry and still be
 * classified `held_with_known`; their counts are reported in the table so a
 * fix (or a regression that widens them) is visible.
 */
const KNOWN_2XX_GAPS: ReadonlySet<string> = new Set([
  // syncShots / uploadEvaluationTrials return `json as T`: null / wrong shape
  // resolve as success (sync.ts then classifies as shot.sync_unacknowledged).
  'fake_success_2xx',
  // submitAnalysisFeedback reads `response.feedback.reviewEligible`: a null
  // body throws a raw TypeError instead of an ApiError.
  'untyped_rejection_2xx',
  // reserve(): a 2xx whose body is unparsable / null reaches
  // `response.permit` on null → TypeError instead of ApiError 502.
  'permit_contract_unreadable_2xx',
]);

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
  /** Every contract violation, known classes included. */
  failures: IterationResult['failures'];
  unknownFailures: IterationResult['failures'];
  stats: IterationResult['stats'];
  permitConfig: IterationResult['permitConfig'];
  replay: string;
}

function classify(result: IterationResult): {
  verdict: Verdict;
  unknown: IterationResult['failures'];
} {
  const unknown = result.failures.filter(f => !KNOWN_2XX_GAPS.has(f.invariant));
  if (unknown.length > 0) return { verdict: 'broken', unknown };
  return {
    verdict: result.failures.length > 0 ? 'held_with_known' : 'held',
    unknown,
  };
}

const rows: TableRow[] = [];
const brokenDetails: IterationResult[] = [];

const seeds = seedsToRun();
const REAL_BUDGET_MS_PER_SEED = 5_000;

describe('api.ts concurrency stress (seeded Promise.all bursts)', () => {
  afterAll(() => {
    const summary = {
      generatedAt: new Date().toISOString(),
      unit: 'mod-api-client',
      lens: 'concurrency',
      target: 'apps/mobile/src/data/api.ts',
      seeds: seeds.length,
      firstSeed: seeds[0] ?? null,
      lastSeed: seeds[seeds.length - 1] ?? null,
      held: rows.filter(r => r.verdict === 'held').length,
      heldWithKnown: rows.filter(r => r.verdict === 'held_with_known').length,
      broken: rows.filter(r => r.verdict === 'broken').length,
      knownGapClasses: [...KNOWN_2XX_GAPS],
      knownGapHits: rows.reduce<Record<string, number>>((acc, r) => {
        for (const [k, n] of Object.entries(r.violationClasses)) {
          acc[k] = (acc[k] ?? 0) + n;
        }
        return acc;
      }, {}),
      totals: rows.reduce(
        (acc, r) => ({
          ops: acc.ops + r.stats.ops,
          fetches: acc.fetches + r.stats.fetches,
          timeouts: acc.timeouts + r.stats.timeouts,
          lost: acc.lost + r.stats.lost,
          served401: acc.served401 + r.stats.served401,
          listenerFires: acc.listenerFires + r.stats.listenerFires,
          rotations: acc.rotations + r.stats.rotations,
          logouts: acc.logouts + r.stats.logouts,
          relogins: acc.relogins + r.stats.relogins,
          skews: acc.skews + r.stats.skews,
          duplicatesKeys: acc.duplicatesKeys + r.stats.duplicatesKeys,
          chained: acc.chained + r.stats.chained,
          abandoned: acc.abandoned + r.stats.abandoned,
          realElapsedMs: acc.realElapsedMs + r.stats.realElapsedMs,
        }),
        {
          ops: 0,
          fetches: 0,
          timeouts: 0,
          lost: 0,
          served401: 0,
          listenerFires: 0,
          rotations: 0,
          logouts: 0,
          relogins: 0,
          skews: 0,
          duplicatesKeys: 0,
          chained: 0,
          abandoned: 0,
          realElapsedMs: 0,
        },
      ),
      rows,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, 'api-client-concurrency.json'),
      JSON.stringify(summary, null, 2),
    );
    if (brokenDetails.length > 0) {
      writeFileSync(
        join(OUT_DIR, 'api-client-concurrency.broken.json'),
        JSON.stringify(brokenDetails, null, 2),
      );
    }
  });

  it('exercises every requested interleaving class across the seed range', async () => {
    const seen = {
      duplicateKeys: false,
      chained: false,
      abandoned: false,
      rotation: false,
      logout: false,
      skew: false,
      timeout: false,
      timerStart: false,
    };
    for (const seed of seeds) {
      const result = await runIteration(seed);
      const { verdict, unknown } = classify(result);
      rows.push({
        seed,
        verdict,
        violationClasses: result.violationClasses,
        failures: result.failures,
        unknownFailures: unknown,
        stats: result.stats,
        permitConfig: result.permitConfig,
        replay: result.replay,
      });
      if (verdict === 'broken') brokenDetails.push(result);
      seen.duplicateKeys ||= result.stats.duplicatesKeys > 0;
      seen.chained ||= result.stats.chained > 0;
      seen.abandoned ||= result.stats.abandoned > 0;
      seen.rotation ||= result.stats.rotations > 0;
      seen.logout ||= result.stats.logouts > 0;
      seen.skew ||= result.stats.skews > 0;
      seen.timeout ||= result.stats.timeouts > 0;
      seen.timerStart ||= result.ops.some(o => o.startMode === 'timer');
      // Deadlock bound on the driver itself, in real time and timer steps.
      expect(result.stats.timerSteps).toBeLessThan(MAX_TIMER_STEPS);
      expect(result.stats.realElapsedMs).toBeLessThan(REAL_BUDGET_MS_PER_SEED);
    }
    const broken = rows.filter(r => r.verdict === 'broken');
    expect(
      broken.map(r => ({
        seed: r.seed,
        replay: r.replay,
        failures: r.unknownFailures,
      })),
    ).toEqual([]);
    if (seeds.length >= 20) {
      expect(seen).toEqual({
        duplicateKeys: true,
        chained: true,
        abandoned: true,
        rotation: true,
        logout: true,
        skew: true,
        timeout: true,
        timerStart: true,
      });
    }
  }, 600_000);

  it('is replayable: the same seed reaches the same verdict and fetch log', async () => {
    const seed = seeds[0] ?? 1;
    const first = await runIteration(seed);
    const second = await runIteration(seed);
    const strip = (r: IterationResult) => ({
      ok: r.ok,
      failures: r.failures,
      fetches: r.fetches.map(f => ({
        seq: f.seq,
        op: f.opIndex,
        url: f.url,
        bearer: f.bearerSent,
        outcome: f.outcome,
        status: f.servedStatus,
      })),
      ops: r.ops.map(o => ({
        settlement: o.settlement,
        error: o.error,
        startedAtMs: o.startedAtMs,
        settledAtMs: o.settledAtMs,
      })),
    });
    expect(strip(second)).toEqual(strip(first));
  });
});
