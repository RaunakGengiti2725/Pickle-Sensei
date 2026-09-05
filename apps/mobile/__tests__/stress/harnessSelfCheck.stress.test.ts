/**
 * Self-check for the stress harness in `testing/stress/harness.ts` — proves
 * the oracle is not vacuous: violating iterations, throwing iterations and
 * never-settling iterations all land in the table as failing seeds, the
 * scheduler settles every held operation exactly once in a seed-determined
 * order, and the same seed always yields the same interleaving.
 */
import {
  ITERATION_WALL_MS,
  runCampaign,
  scenarioSeeds,
  SeededScheduler,
  seededRandom,
  shuffle,
  stableJson,
  stressIterations,
} from '../../testing/stress/harness';

const SUITE = 'harnessSelfCheck';

describe('stress harness self-check', () => {
  it('records violating and throwing iterations as failing seeds (oracle is live)', async () => {
    const seeds = scenarioSeeds('records_failures');
    const table = await runCampaign(SUITE, 'records_failures', async seed => {
      if (seed % 3 === 0) throw new Error(`boom ${seed}`);
      return {
        detail: { seed },
        violations: seed % 3 === 1 ? [`violation for ${seed}`] : [],
      };
    });
    expect(table.iterations).toBe(seeds.length);
    const wantFailing = seeds.filter(seed => seed % 3 !== 2);
    expect(table.failingSeeds).toEqual(wantFailing);
    expect(table.failed).toBe(wantFailing.length);
    expect(table.passed + table.failed + table.deadlocked).toBe(seeds.length);
    for (const row of table.rows) {
      if (row.seed % 3 === 0) expect(row.error).toContain(`boom ${row.seed}`);
      if (row.seed % 3 === 1) expect(row.error).toContain('violation for');
      if (row.seed % 3 === 2) expect(row.verdict).toBe('pass');
    }
  });

  it('classifies an iteration that never settles as DEADLOCK within the wall bound', async () => {
    jest.useFakeTimers();
    try {
      const pending = runCampaign(
        SUITE,
        'deadlock',
        () => new Promise(() => {}),
      );
      await jest.advanceTimersByTimeAsync(
        ITERATION_WALL_MS * stressIterations(),
      );
      const table = await pending;
      expect(table.deadlocked).toBe(table.iterations);
      expect(table.rows.every(r => r.verdict === 'deadlock')).toBe(true);
      expect(table.failingSeeds.length).toBe(table.iterations);
    } finally {
      jest.useRealTimers();
    }
  });

  it('settles every held operation exactly once, in a seed-determined order', async () => {
    const run = async (seed: number) => {
      const scheduler = new SeededScheduler(seededRandom(seed));
      const settled: string[] = [];
      const ops = Array.from({ length: 12 }, (_, i) =>
        scheduler
          .hold(`op${i}`, () => i)
          .then(value => {
            settled.push(`op${value}`);
          }),
      );
      const rejected = scheduler
        .holdRejection<number>('bad', new Error('planned'))
        .catch(() => {
          settled.push('bad');
        });
      await scheduler.drain();
      await Promise.all([...ops, rejected]);
      return { settled, order: scheduler.settledOrder };
    };
    const a = await run(7);
    const b = await run(7);
    const c = await run(8);
    expect(stableJson(a)).toBe(stableJson(b));
    expect(stableJson(a.order)).not.toBe(stableJson(c.order));
    expect([...a.settled].sort()).toEqual([...a.order].sort());
    expect(new Set(a.settled).size).toBe(13);
    // Not the issue order — the scheduler actually interleaves.
    expect(a.order).not.toEqual([
      ...Array.from({ length: 12 }, (_, i) => `op${i}`),
      'bad',
    ]);
  });

  it('is deterministic per seed and distinct across seeds', () => {
    const items = Array.from({ length: 16 }, (_, i) => i);
    expect(shuffle(seededRandom(1), items)).toEqual(
      shuffle(seededRandom(1), items),
    );
    expect(shuffle(seededRandom(1), items)).not.toEqual(
      shuffle(seededRandom(2), items),
    );
    expect(scenarioSeeds('x')).toEqual(scenarioSeeds('x'));
    expect(scenarioSeeds('x')).not.toEqual(scenarioSeeds('y'));
    expect(new Set(scenarioSeeds('x')).size).toBe(stressIterations());
  });
});
