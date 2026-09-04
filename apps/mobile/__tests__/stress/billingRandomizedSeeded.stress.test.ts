/**
 * mod-billing — SEEDED RANDOMIZED LONG-RUN stress (lens `randomized-seeded`).
 *
 * Drives the real accessStore + revenueCatClient + accessApi composition with
 * seeded sequences of user actions (initialize / refresh / purchase / restore
 * / sync / plan selection / sign-in / sign-out / reset / token rotation /
 * misconfiguration) interleaved with seeded settlements of the pending
 * RevenueCat and backend calls (success, cancellation, store errors, 401 /
 * 429 / 5xx, malformed and incoherent bodies, network failures). The
 * invariants are documented and checked after EVERY step in
 * test-support/stress/billingStressModel.ts.
 *
 * Knobs (all optional):
 *   STRESS_ITER      sequences per run (default 100; the campaign uses 2000+)
 *   STRESS_SEED      replay exactly one seed
 *   STRESS_SEED_BASE first seed of the deterministic seed ladder
 *   STRESS_RUN_ID    artifact folder name (default "local")
 *   STRESS_STRICT=1  also FAIL on the observed (F*) invariants
 *
 * Artifacts (repo-root relative, gitignored):
 *   artifacts/stress/mod-billing-randomized-seeded/<run>/results.json
 *     seed → outcome table, one row per executed sequence
 *   .../failures.json   minimized repro + trace + 10× re-run rate per failure
 *   .../observed.json   every observed-invariant hit with its seed and step
 *   .../determinism.json  same-seed-twice fingerprints
 *
 * Replay one seed: STRESS_SEED=<seed> npx jest --ci __tests__/stress/billingRandomizedSeeded
 */
import {
  MAX_LENGTH,
  MIN_LENGTH,
  generateSequence,
  minimize,
  runSeed,
  runSequence,
  traceFingerprint,
  type Action,
  type RunResult,
  type Violation,
} from '../../test-support/stress/billingStressModel';

// Node built-ins for the artifacts. The mobile tsconfig excludes node typings
// (see testing/xcBehavioral/evidence.ts), so the shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join, resolve } = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const RUN_ID = process.env.STRESS_RUN_ID ?? 'local';
const OUT_DIR = join(
  resolve(__dirname, '..', '..', '..', '..'),
  'artifacts',
  'stress',
  'mod-billing-randomized-seeded',
  RUN_ID,
);
const STRICT = process.env.STRESS_STRICT === '1';
const RERUNS = 10;

function fnv(text: string): number {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function seeds(): number[] {
  const pinned = process.env.STRESS_SEED;
  if (pinned !== undefined && pinned !== '') return [Number(pinned) >>> 0];
  const iterations = Number(process.env.STRESS_ITER ?? '100');
  const base = Number(
    process.env.STRESS_SEED_BASE ?? fnv('mod-billing-randomized-seeded'),
  );
  return Array.from({ length: iterations }, (_, i) => (base + i * 7919) >>> 0);
}

interface Row {
  seed: number;
  length: number;
  outcome: 'pass' | 'fail';
  hardViolations: string[];
  observed: string[];
  callsIssued: number;
  callsSettled: number;
  opsEntered: number;
  hung: boolean;
  durationMs: number;
}

interface FailureRecord {
  seed: number;
  violations: Violation[];
  originalLength: number;
  minimizedLength: number;
  minimizedActions: Action[];
  minimizedViolations: Violation[];
  rerun: { runs: number; failed: number; rate: number };
  trace: RunResult['trace'];
}

function write(name: string, data: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, name);
  writeFileSync(file, JSON.stringify(data, null, 1));
  return file;
}

const failing = (result: RunResult) =>
  result.violations.length > 0 || (STRICT && result.observed.length > 0);

const violationsOf = (result: RunResult): Violation[] =>
  STRICT ? [...result.violations, ...result.observed] : result.violations;

const CAMPAIGN = seeds();
const TIMEOUT_MS = Math.max(60_000, CAMPAIGN.length * 400);

describe('mod-billing randomized-seeded stress', () => {
  it('generator: every sequence has 5–60 actions and is a pure function of its seed', () => {
    for (const seed of CAMPAIGN) {
      const a = generateSequence(seed);
      const b = generateSequence(seed);
      expect(a.length).toBeGreaterThanOrEqual(MIN_LENGTH);
      expect(a.length).toBeLessThanOrEqual(MAX_LENGTH);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it(
    `campaign: ${CAMPAIGN.length} seeded sequences hold every hard invariant after every step`,
    async () => {
      const rows: Row[] = [];
      const failures: FailureRecord[] = [];
      const observed: Array<Violation & { seed: number }> = [];
      const observedTraces: Array<{
        seed: number;
        observed: Violation[];
        trace: RunResult['trace'];
      }> = [];
      const started = Date.now();
      for (const seed of CAMPAIGN) {
        const t0 = Date.now();
        const result = await runSeed(seed);
        const hard = violationsOf(result);
        rows.push({
          seed,
          length: result.length,
          outcome: hard.length > 0 ? 'fail' : 'pass',
          hardViolations: hard.map(
            v => `${v.invariant}@${v.step}: ${v.detail}`,
          ),
          observed: result.observed.map(
            v => `${v.invariant}@${v.step}: ${v.detail}`,
          ),
          callsIssued: result.callsIssued,
          callsSettled: result.callsSettled,
          opsEntered: result.opsEntered,
          hung: result.hung,
          durationMs: Date.now() - t0,
        });
        for (const v of result.observed) observed.push({ seed, ...v });
        if (result.observed.length > 0) {
          observedTraces.push({
            seed,
            observed: result.observed,
            trace: result.trace,
          });
        }
        if (hard.length > 0) {
          const minimized = await minimize(seed, result.actions, failing);
          let failed = 0;
          for (let i = 0; i < RERUNS; i += 1) {
            const again = await runSequence(seed, result.actions);
            if (failing(again)) failed += 1;
          }
          failures.push({
            seed,
            violations: hard,
            originalLength: result.length,
            minimizedLength: minimized.actions.length,
            minimizedActions: minimized.actions,
            minimizedViolations: violationsOf(minimized.result),
            rerun: { runs: RERUNS, failed, rate: failed / RERUNS },
            trace: minimized.result.trace,
          });
        }
      }
      const summary = {
        runId: RUN_ID,
        strict: STRICT,
        iterations: CAMPAIGN.length,
        executed: rows.length,
        passed: rows.filter(r => r.outcome === 'pass').length,
        failed: rows.filter(r => r.outcome === 'fail').length,
        hung: rows.filter(r => r.hung).length,
        totalActions: rows.reduce((n, r) => n + r.length, 0),
        totalCallsIssued: rows.reduce((n, r) => n + r.callsIssued, 0),
        totalCallsSettled: rows.reduce((n, r) => n + r.callsSettled, 0),
        totalOpsEntered: rows.reduce((n, r) => n + r.opsEntered, 0),
        observedByInvariant: observed.reduce<Record<string, number>>(
          (acc, v) => {
            acc[v.invariant] = (acc[v.invariant] ?? 0) + 1;
            return acc;
          },
          {},
        ),
        seedsWithObserved: [...new Set(observed.map(v => v.seed))].length,
        lengthMin: Math.min(...rows.map(r => r.length)),
        lengthMax: Math.max(...rows.map(r => r.length)),
        durationMs: Date.now() - started,
        seedBase: CAMPAIGN[0],
        replay:
          'STRESS_SEED=<seed> npx jest --ci __tests__/stress/billingRandomizedSeeded',
      };
      write('results.json', { summary, rows });
      write('failures.json', failures);
      write('observed.json', observed);
      write('observedTraces.json', observedTraces);
      expect(
        failures.map(f => ({
          seed: f.seed,
          violations: f.minimizedViolations,
        })),
      ).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'determinism: the same seed twice yields an identical trace',
    async () => {
      const records: Array<{
        seed: number;
        steps: number;
        identical: boolean;
      }> = [];
      const mismatches: number[] = [];
      for (const seed of CAMPAIGN) {
        const first = traceFingerprint(await runSeed(seed));
        const second = traceFingerprint(await runSeed(seed));
        const identical = first === second;
        records.push({ seed, steps: JSON.parse(first).length, identical });
        if (!identical) mismatches.push(seed);
      }
      write('determinism.json', {
        sampled: CAMPAIGN.length,
        mismatches,
        records,
      });
      expect(mismatches).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
