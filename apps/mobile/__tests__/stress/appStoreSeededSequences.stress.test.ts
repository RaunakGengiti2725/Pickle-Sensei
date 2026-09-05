/**
 * STRESS (randomized-seeded) — state/appStore + state/profile.
 *
 * Seeded random sequences of public-API actions (owner switches, hydrate,
 * completeOnboarding, completePreAuthOnboarding, remote profile changes,
 * SQLite / network faults) interleaved at every async hop through a deferred
 * scheduler; invariants (see `checkInvariants` in the harness) are checked
 * after EVERY step, then a recoverability epilogue runs. Every failing seed is
 * ddmin-minimized and recorded; the same seed is replayed to prove the trace
 * is identical.
 *
 * Failures matching a DOCUMENTED deviation (`KnownDeviation` D1–D6 in the
 * harness, each reported as a finding) are recorded as BROKEN/known in the
 * results table and do not fail the suite; any other failure does.
 *
 *   STRESS_ITER=2000 npx jest --ci --silent appStoreSeededSequences
 *
 * Default in-suite campaign is small (STRESS_ITER unset → 120 sequences).
 * Results: artifacts/stress-mod-app-store/<run>/{results,failures}.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ApiSession } from '../../src/account/apiSession';
import type { Profile } from '../../src/state/profile';
import {
  World,
  type Action,
  type Mode,
  type RunResult,
  hashTrace,
  minimize,
  resetStore,
  runSequence,
} from '../../stress-harness/mod-app-store/world';

// `runSequence` builds a fresh World per sequence; the store's seams always
// resolve to the newest one.
function mockCurrentWorld(): World {
  const world = World.current;
  if (!world) throw new Error('no World installed');
  return world;
}

jest.mock('../../src/data/db', () => ({
  getDb: () => mockCurrentWorld().getDb(),
}));

jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: ApiSession) =>
    mockCurrentWorld().fetchCanonical(session),
  saveCanonicalOnboardingProfile: (session: ApiSession, profile: Profile) =>
    mockCurrentWorld().saveCanonical(session, profile),
}));

const ITER = Number(process.env['STRESS_ITER'] ?? 120);
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? 20260905);
const DETERMINISM_SAMPLE = Math.min(ITER, 100);
const RUN_ID =
  process.env['STRESS_RUN_ID'] ??
  new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.resolve(
  __dirname,
  '../../../../artifacts/stress-mod-app-store',
  RUN_ID,
);

interface Row {
  seed: number;
  mode: Mode;
  length: number;
  executedLength: number;
  outcome: 'HELD' | 'BROKEN';
  known: string | null;
  failedInvariants: string[];
  failedAtStep: number | null;
  traceHash: string;
  opsReleased: number;
  calls: number;
  durationMs: number;
}

interface FailureRecord {
  seed: number;
  mode: Mode;
  known: string | null;
  invariants: string[];
  minimizedActions: Action[];
  minimizedLength: number;
  originalLength: number;
  initial: RunResult['initial'];
  snapshot: Record<string, unknown>;
  flakeRate: string;
  trace: string[];
}

function toRow(result: RunResult): Row {
  return {
    seed: result.seed,
    mode: result.mode,
    length: result.length,
    executedLength: result.executedLength,
    outcome: result.outcome,
    known: result.failure?.known ?? null,
    failedInvariants: result.failure?.invariants ?? [],
    failedAtStep: result.failure?.step ?? null,
    traceHash: result.traceHash,
    opsReleased: result.opsReleased,
    calls: result.calls,
    durationMs: result.durationMs,
  };
}

jest.setTimeout(30 * 60 * 1000);

describe('appStore seeded randomized long-run', () => {
  const rows: Row[] = [];
  const failures: FailureRecord[] = [];
  const summary: Record<string, unknown> = {};

  beforeEach(() => {
    resetStore();
  });

  afterAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUT_DIR, 'results.json'),
      JSON.stringify(
        {
          unit: 'mod-app-store',
          lens: 'randomized-seeded',
          baseSeed: BASE_SEED,
          iterations: ITER,
          executed: rows.length,
          ...summary,
          rows,
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(OUT_DIR, 'failures.json'),
      JSON.stringify(failures, null, 2),
    );
  });

  /** Runs every seed, minimizes + flake-checks (10×) each failure, and
   * returns the failures that match NO documented deviation. */
  const campaign = async (mode: Mode, seeds: number[]) => {
    const results: RunResult[] = [];
    for (const seed of seeds) {
      const result = await runSequence(seed, mode);
      rows.push(toRow(result));
      results.push(result);
    }
    const broken = results.filter(result => result.outcome === 'BROKEN');
    const byKnown: Record<string, number[]> = {};
    for (const result of broken) {
      const minimized = await minimize(result);
      let reproduced = 0;
      for (let i = 0; i < 10; i += 1) {
        const again = await runSequence(result.seed, result.mode);
        if (again.outcome === 'BROKEN') reproduced += 1;
      }
      const known = result.failure?.known ?? null;
      const bucket = known ?? 'UNKNOWN';
      byKnown[bucket] = [...(byKnown[bucket] ?? []), result.seed];
      failures.push({
        seed: result.seed,
        mode: result.mode,
        known,
        invariants: result.failure?.invariants ?? [],
        minimizedActions: minimized.actions,
        minimizedLength: minimized.actions.length,
        originalLength: result.length,
        initial: result.initial,
        snapshot: minimized.failure?.snapshot ?? {},
        flakeRate: `${reproduced}/10`,
        trace: minimized.trace,
      });
    }
    summary[`${mode}:executed`] = results.length;
    summary[`${mode}:brokenByDeviation`] = byKnown;
    const lengths = results.map(result => result.length);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(60);
    return broken
      .filter(result => result.failure?.known === null)
      .map(result => ({ seed: result.seed, failure: result.failure }));
  };

  it(`legal sequences: no undocumented failure (${Math.ceil(ITER / 2)} seeds)`, async () => {
    const count = Math.ceil(ITER / 2);
    const seeds = Array.from({ length: count }, (_, i) => BASE_SEED + i);
    expect(await campaign('legal', seeds)).toEqual([]);
  });

  // Near-legal sequences drive the store outside the Gate's reachable
  // orderings (completeOnboarding while signed out or mid-hydrate, two
  // pre-auth saves in flight, ...). The expected rejection of
  // completeOnboarding while signed out is whitelisted by the harness; every
  // other failure must be one of the documented deviations.
  it(`near-legal sequences: no undocumented failure (${Math.floor(
    ITER / 2,
  )} seeds)`, async () => {
    const count = Math.floor(ITER / 2);
    const seeds = Array.from(
      { length: count },
      (_, i) => BASE_SEED + 1_000_000 + i,
    );
    expect(await campaign('near-legal', seeds)).toEqual([]);
  });

  it(`same seed twice → identical trace (${DETERMINISM_SAMPLE} seeds × 2 modes)`, async () => {
    const mismatches: { seed: number; mode: Mode }[] = [];
    for (let i = 0; i < DETERMINISM_SAMPLE; i += 1) {
      for (const mode of ['legal', 'near-legal'] as const) {
        const seed = BASE_SEED + (mode === 'legal' ? i : 1_000_000 + i);
        const first = await runSequence(seed, mode);
        const second = await runSequence(seed, mode);
        if (
          first.traceHash !== second.traceHash ||
          hashTrace(first.trace) !== hashTrace(second.trace) ||
          JSON.stringify(first.actions) !== JSON.stringify(second.actions)
        ) {
          mismatches.push({ seed, mode });
        }
        // Replaying the recorded action list must reproduce the same trace.
        const replay = await runSequence(seed, mode, {
          actions: first.actions,
        });
        if (replay.traceHash !== first.traceHash)
          mismatches.push({ seed, mode });
      }
    }
    summary['determinismChecked'] = DETERMINISM_SAMPLE * 2;
    summary['determinismMismatches'] = mismatches;
    expect(mismatches).toEqual([]);
  });
});
