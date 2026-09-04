/**
 * CONCURRENCY stress campaign for `mod-bootstrap-api-session`
 * (src/account/bootstrap.ts + src/account/apiSession.ts).
 *
 * Six seeded scenario families (see test-support/stress/
 * bootstrapApiSessionConcurrencyHarness.ts) drive the real modules with
 * Promise.all bursts over a virtual network under jest fake timers:
 * duplicate bootstraps on a one-use token, multi-actor bootstrap+install with
 * interleaved rotations/logouts and per-request bearer resolution, 401s that
 * land after the bearer rotated or the account switched, the 15 s client
 * timeout boundary, skewed/malformed `expiresAt`, and subscriber churn.
 *
 * Scale:   STRESS_ITER=<n>          seeds per family (default 100 → 600 iterations)
 * Replay:  STRESS_ONLY=<family>:<seed>
 * Flake:   STRESS_REPEAT=<n>        run every (family, seed) n times
 * Output:  STRESS_OUT=<dir>         JSON seed table (default artifacts/stress)
 *
 * Every failing iteration is reported with its family, seed, generated plan
 * and the exact replay command.
 */
import {
  FAMILIES,
  runIteration,
  type Clock,
  type Family,
  type IterationResult,
} from '../../test-support/stress/bootstrapApiSessionConcurrencyHarness';
import { bootstrapCanonicalAccount } from '../../src/account/bootstrap';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see be-mobile-sync-outbox.test.ts), so the shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const ITER = Number(process.env.STRESS_ITER ?? 100);
const REPEAT = Math.max(1, Number(process.env.STRESS_REPEAT ?? 1));
const ONLY = process.env.STRESS_ONLY ?? null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const TEST_FILE =
  '__tests__/stress/bootstrapApiSessionConcurrency.stress.test.ts';

/** The one invariant whose violation is reported separately: a finite
 * `expiresAt` whose ×1000 conversion overflows to Infinity. It is asserted
 * by its own deterministic test below so the campaign table stays readable. */
const EXPIRY_FINITE = 'expiry-finite';

function replay(family: Family, seed: number): string {
  return `STRESS_ONLY=${family}:${seed} npx jest --ci ${TEST_FILE}`;
}

function selection(): Array<{ family: Family; seed: number }> {
  if (ONLY) {
    const [family, seed] = ONLY.split(':');
    if (
      !FAMILIES.includes(family as Family) ||
      !Number.isInteger(Number(seed))
    ) {
      throw new Error(`STRESS_ONLY must be <family>:<seed>, got ${ONLY}`);
    }
    return [{ family: family as Family, seed: Number(seed) }];
  }
  const list: Array<{ family: Family; seed: number }> = [];
  for (const family of FAMILIES) {
    for (let seed = 1; seed <= ITER; seed++) list.push({ family, seed });
  }
  return list;
}

const clock: Clock = {
  advance: ms => jest.advanceTimersByTimeAsync(ms),
  timerCount: () => jest.getTimerCount(),
  realNow: () => jest.getRealSystemTime(),
};

const results: IterationResult[] = [];
const wallStart = Date.now();

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
  const failed = results.filter(r => !r.ok);
  const byFamily: Record<string, { executed: number; failed: number }> = {};
  const byInvariant: Record<string, number> = {};
  const aggregate: Record<string, number> = {};
  for (const r of results) {
    byFamily[r.family] ??= { executed: 0, failed: 0 };
    byFamily[r.family]!.executed += 1;
    if (!r.ok) byFamily[r.family]!.failed += 1;
    for (const f of r.failures)
      byInvariant[f.invariant] = (byInvariant[f.invariant] ?? 0) + 1;
    for (const [k, v] of Object.entries(r.stats))
      aggregate[k] = (aggregate[k] ?? 0) + v;
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    unit: 'mod-bootstrap-api-session',
    lens: 'concurrency',
    iterPerFamily: ITER,
    repeat: REPEAT,
    only: ONLY,
    executed: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    wallMs: Date.now() - wallStart,
    maxIterationWallMs: Math.max(0, ...results.map(r => r.wallMs)),
    byFamily,
    byInvariant,
    aggregate,
    failures: failed.map(r => ({
      family: r.family,
      seed: r.seed,
      rngSeed: r.rngSeed,
      plan: r.plan,
      failures: r.failures,
      replay: replay(r.family, r.seed),
    })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'bootstrap-api-session-concurrency.summary.json'),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, 'bootstrap-api-session-concurrency.seeds.json'),
    JSON.stringify(
      results.map(r => ({
        family: r.family,
        seed: r.seed,
        rngSeed: r.rngSeed,
        outcome: r.ok ? 'HELD' : 'BROKEN',
        wallMs: r.wallMs,
        plan: r.plan,
        stats: r.stats,
        failures: r.failures,
      })),
      null,
      2,
    ),
  );
});

describe('mod-bootstrap-api-session × concurrency (seeded)', () => {
  const cases = selection();
  const families = ONLY ? [cases[0]!.family] : [...FAMILIES];

  it.each(families)(
    '%s: every seeded interleaving holds its invariants',
    async family => {
      const mine = cases.filter(c => c.family === family);
      const broken: IterationResult[] = [];
      for (const { seed } of mine) {
        for (let rep = 0; rep < REPEAT; rep++) {
          const result = await runIteration(family, seed, clock);
          // Campaign-level assertion excludes the separately-tested invariant.
          const campaign: IterationResult = {
            ...result,
            failures: result.failures.filter(
              f => f.invariant !== EXPIRY_FINITE,
            ),
          };
          campaign.ok = campaign.failures.length === 0;
          results.push(result);
          if (!campaign.ok) broken.push(campaign);
        }
      }
      expect(mine.length * REPEAT).toBeGreaterThan(0);
      const report = broken
        .map(
          r =>
            `${r.family} seed=${r.seed} (rng ${r.rngSeed})\n  plan: ${r.plan}\n` +
            r.failures.map(f => `  [${f.invariant}] ${f.detail}`).join('\n') +
            `\n  replay: ${replay(r.family, r.seed)}`,
        )
        .join('\n\n');
      expect(report).toBe('');
    },
  );

  it('a finite server expiresAt never yields a non-finite bearerExpiresAtMs', async () => {
    // Deterministic single payload: parseSessionTokens accepts expiresAt=1e306
    // (finite) and multiplies by 1000, so bearerExpiresAtMs becomes Infinity.
    const result = await bootstrapCanonicalAccount({
      apiBaseUrl: 'https://api.pickle.example',
      bearerToken: 'idtok',
      provider: 'apple',
      environment: {
        locale: 'en-US',
        timezone: 'UTC',
        device: {
          platform: 'ios',
          osVersion: '18.5',
          appVersion: '1.0',
          model: 'iOS phone',
        },
      },
      fetchFn: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            user: { id: '7fc2c743-028f-4ec6-942c-a84508f3be38', email: null },
            onboardingState: 'complete',
            session: { accessToken: 'a', refreshToken: 'r', expiresAt: 1e306 },
          }),
        }) as unknown as Response,
    });
    expect(result.apiSession.refreshToken).toBe('r');
    expect(Number.isFinite(result.apiSession.bearerExpiresAtMs)).toBe(true);
  });
});
