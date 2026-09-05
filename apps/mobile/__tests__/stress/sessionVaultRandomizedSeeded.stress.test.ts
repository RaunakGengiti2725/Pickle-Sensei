/**
 * Seeded randomized long-run stress campaign over the sessionVault public API.
 *
 * Each sequence is 5–60 legal/near-legal actions (save / load / clear, plus a
 * foreign build planting a corrupt or oversized record in the vault's own
 * Keychain slot and the Keychain refusing individual operations), replayed
 * against a reference model of the documented contract. Invariants are checked
 * after EVERY step; failing seeds are delta-debugged to a minimal step list and
 * replayed 10× to measure flake rate.
 *
 * Scale: `STRESS_ITER` sequences (default keeps the suite fast).
 *   cd apps/mobile && STRESS_ITER=2000 npx jest --ci --silent __tests__/stress/sessionVaultRandomizedSeeded.stress.test.ts
 * Replay one sequence: `STRESS_SEED_BASE=<seed> STRESS_ITER=1`.
 * Raw table: `artifacts/stress-session-vault/` (override STRESS_ARTIFACT_DIR).
 */
import { writeStressArtifact } from '../../stress-harness/session-vault/artifacts';
import {
  runSequence,
  runSteps,
  shrink,
} from '../../stress-harness/session-vault/driver';
import {
  CORRUPT_VARIANT_NAMES,
  SESSION_VARIANT_NAMES,
  describeStep,
  generateSequence,
} from '../../stress-harness/session-vault/generator';
import { keychainFake } from '../../stress-harness/session-vault/keychainFake';

jest.mock(
  'react-native-keychain',
  () =>
    jest.requireActual<
      typeof import('../../stress-harness/session-vault/keychainFake')
    >('../../stress-harness/session-vault/keychainFake'),
  { virtual: true },
);

const ITERATIONS = Number.parseInt(process.env['STRESS_ITER'] ?? '', 10) || 120;
const SEED_BASE =
  Number.parseInt(process.env['STRESS_SEED_BASE'] ?? '', 10) || 1_000_000;
/** Every Nth sequence is replayed immediately to prove seed determinism. */
const DETERMINISM_EVERY = 25;

interface TableRow {
  seed: number;
  steps: number;
  outcome: 'held' | 'violated';
  traceHash: string;
  violations?: string[];
  minimizedSteps?: string[];
  flakeRate?: string;
}

jest.setTimeout(20 * 60 * 1000);

beforeEach(() => {
  keychainFake.reset();
});

describe('sessionVault — seeded randomized long-run', () => {
  it('holds every documented vault invariant across the seeded campaign', async () => {
    const rows: TableRow[] = [];
    const counters: Record<string, number> = {};
    const determinismChecked: number[] = [];
    const determinismMismatches: number[] = [];
    let executedSteps = 0;

    for (let index = 0; index < ITERATIONS; index += 1) {
      const seed = SEED_BASE + index;
      const result = await runSequence(seed);
      executedSteps += result.steps;
      for (const [key, value] of Object.entries(result.counters)) {
        counters[key] = (counters[key] ?? 0) + value;
      }

      const row: TableRow = {
        seed,
        steps: result.steps,
        outcome: result.outcome,
        traceHash: result.traceHash,
      };

      if (result.outcome === 'violated') {
        row.violations = result.violations;
        const minimized = await shrink(seed, generateSequence(seed).steps);
        row.minimizedSteps = minimized.steps.map(describeStep);
        let failures = 0;
        for (let replay = 0; replay < 10; replay += 1) {
          const again = await runSteps(seed, minimized.steps);
          if (again.outcome === 'violated') failures += 1;
        }
        row.flakeRate = `${failures}/10`;
      }

      if (index % DETERMINISM_EVERY === 0) {
        const replay = await runSequence(seed);
        determinismChecked.push(seed);
        if (
          replay.traceHash !== result.traceHash ||
          replay.trace.join('\n') !== result.trace.join('\n')
        ) {
          determinismMismatches.push(seed);
        }
      }

      rows.push(row);
    }

    const violated = rows.filter(row => row.outcome === 'violated');
    const artifact = writeStressArtifact(
      `campaign-${SEED_BASE}-${ITERATIONS}.json`,
      {
        unit: 'apps/mobile/src/account/sessionVault.ts',
        lens: 'randomized-seeded',
        seedBase: SEED_BASE,
        sequences: rows.length,
        executedSteps,
        sessionVariants: SESSION_VARIANT_NAMES,
        corruptVariants: CORRUPT_VARIANT_NAMES,
        counters,
        determinismChecked,
        determinismMismatches,
        violatedSeeds: violated.map(row => row.seed),
        rows,
      },
    );

    console.log(
      `[stress] ${rows.length} sequences / ${executedSteps} steps, ` +
        `${violated.length} violated → ${artifact}`,
    );

    expect(determinismMismatches).toEqual([]);
    expect(
      violated.map(row => ({ seed: row.seed, why: row.violations })),
    ).toEqual([]);
    expect(rows).toHaveLength(ITERATIONS);
    // The campaign is only meaningful if it actually reached the interesting
    // states; these witnesses fail loudly if the generator stops covering them.
    expect(counters['loadRestored'] ?? 0).toBeGreaterThan(0);
    expect(counters['loadDiscardedMalformed'] ?? 0).toBeGreaterThan(0);
    expect(counters['loadUnderKeychainFault'] ?? 0).toBeGreaterThan(0);
    expect(counters['saveUnderKeychainFault'] ?? 0).toBeGreaterThan(0);
    expect(counters['saveOversized1Mb'] ?? 0).toBeGreaterThan(0);
  });

  it('replays an identical trace for the same seed', async () => {
    for (const seed of [7, 1337, 424_242]) {
      const first = await runSequence(seed);
      const second = await runSequence(seed);
      expect(second.trace).toEqual(first.trace);
      expect(second.traceHash).toBe(first.traceHash);
      expect(first.outcome).toBe('held');
    }
  });

  it('generates sequences of the specified shape from the seed alone', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const sequence = generateSequence(seed);
      expect(sequence.steps.length).toBeGreaterThanOrEqual(5);
      expect(sequence.steps.length).toBeLessThanOrEqual(60);
      expect(generateSequence(seed).steps.map(describeStep)).toEqual(
        sequence.steps.map(describeStep),
      );
    }
  });

  it('detects a real divergence and shrinks the seed to a minimal step list', async () => {
    // Harness self-test: a Keychain whose reset reports success but keeps the
    // item breaks the "explicit sign-out empties the vault" invariant. The
    // driver must catch it and the minimizer must reduce a long sequence.
    const seed = 99_991;
    const full = generateSequence(seed).steps;
    keychainFake.sabotageReset = true;
    try {
      const { steps, result } = await shrink(seed, full);
      expect(result.outcome).toBe('violated');
      expect(steps.length).toBeLessThan(full.length);
      expect(steps.length).toBeLessThanOrEqual(2);
      expect(result.violations.join('\n')).toMatch(
        /survived an explicit clearPersistedSession|item count/,
      );
    } finally {
      keychainFake.sabotageReset = false;
    }
    const healthy = await runSteps(seed, full);
    expect(healthy.outcome).toBe('held');
  });
});
