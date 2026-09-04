import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Shared plumbing for the `rapid-interaction` stress lens.
 *
 * Every campaign iteration is driven by a 32-bit seed through a mulberry32
 * stream, so any row of the emitted JSON table is replayable with
 * `STRESS_SEEDS=<seed>`. Campaign size is `STRESS_ITER` (small default so the
 * suites stay cheap in the regular run); `STRESS_OUT` writes the seed →
 * outcome table for upload.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SeededRng {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly [T, ...T[]] | readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) {
      throw new Error('SeededRng.pick: empty list');
    }
    return item;
  }

  /** Weighted pick; weights need not sum to 1. */
  weighted<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) return key;
    }
    const last = entries[entries.length - 1];
    if (!last) {
      throw new Error('SeededRng.weighted: no weights');
    }
    return last[0];
  }
}

export interface CampaignConfig {
  /** Number of seeded iterations to run. */
  iterations: number;
  /** Explicit seeds (from STRESS_SEEDS) — overrides `iterations`. */
  seeds: number[] | null;
  /** Base seed the campaign derives per-iteration seeds from. */
  baseSeed: number;
  /** Optional JSON table destination. */
  out: string | null;
}

export function campaignConfig(defaults: {
  iterations: number;
  baseSeed: number;
}): CampaignConfig {
  const iterEnv = process.env.STRESS_ITER;
  const iterations =
    iterEnv && /^\d+$/.test(iterEnv) ? Number(iterEnv) : defaults.iterations;
  const seedsEnv = process.env.STRESS_SEEDS;
  const seeds = seedsEnv
    ? seedsEnv
        .split(',')
        .map(s => s.trim())
        .filter(s => /^\d+$/.test(s))
        .map(Number)
    : null;
  const baseEnv = process.env.STRESS_BASE_SEED;
  const baseSeed =
    baseEnv && /^\d+$/.test(baseEnv) ? Number(baseEnv) : defaults.baseSeed;
  return {
    iterations,
    seeds: seeds && seeds.length > 0 ? seeds : null,
    baseSeed,
    out: process.env.STRESS_OUT ?? null,
  };
}

/** Deterministic per-iteration seed from the campaign base seed. */
export function iterationSeeds(config: CampaignConfig): number[] {
  if (config.seeds) return config.seeds;
  const rng = mulberry32(config.baseSeed);
  const seeds: number[] = [];
  for (let i = 0; i < config.iterations; i += 1) {
    seeds.push(Math.floor(rng() * 0xffffffff) >>> 0);
  }
  return seeds;
}

export interface ScenarioOutcome {
  seed: number;
  /** Human-readable op script, replayable from the seed. */
  script: string[];
  /** Invariant id → violation message (empty object = HELD). */
  violations: Record<string, string>;
  /** Free-form counters the classifier uses (requests sent, taps, …). */
  counters: { [key: string]: number };
  /** Uncaught error thrown while driving the scenario, if any. */
  threw: string | null;
}

export interface CampaignTable {
  unit: string;
  lens: 'rapid-interaction';
  commit: string | null;
  baseSeed: number;
  iterations: number;
  executed: number;
  held: number;
  broken: number;
  /**
   * Rows whose only violations are invariants already pinned as findings
   * (test.failing in the suite) — reported, not counted as new breakage.
   */
  pinned: number;
  pinnedInvariants: string[];
  failingSeeds: number[];
  pinnedSeeds: number[];
  invariantViolations: Record<string, number>;
  rows: ScenarioOutcome[];
}

export function summarise(
  unit: string,
  config: CampaignConfig,
  rows: ScenarioOutcome[],
  pinnedInvariants: string[] = [],
): CampaignTable {
  const isPinned = (id: string) => pinnedInvariants.includes(id);
  const failing = rows.filter(
    row =>
      row.threw !== null ||
      Object.keys(row.violations).some(id => !isPinned(id)),
  );
  const pinnedRows = rows.filter(
    row =>
      !failing.includes(row) &&
      Object.keys(row.violations).some(id => isPinned(id)),
  );
  const invariantViolations: Record<string, number> = {};
  for (const row of rows) {
    for (const id of Object.keys(row.violations)) {
      invariantViolations[id] = (invariantViolations[id] ?? 0) + 1;
    }
    if (row.threw !== null) {
      invariantViolations.threw = (invariantViolations.threw ?? 0) + 1;
    }
  }
  return {
    unit,
    lens: 'rapid-interaction',
    commit: process.env.STRESS_COMMIT ?? null,
    baseSeed: config.baseSeed,
    iterations: config.seeds ? config.seeds.length : config.iterations,
    executed: rows.length,
    held: rows.length - failing.length - pinnedRows.length,
    broken: failing.length,
    pinned: pinnedRows.length,
    pinnedInvariants,
    failingSeeds: failing.map(row => row.seed),
    pinnedSeeds: pinnedRows.map(row => row.seed),
    invariantViolations,
    rows,
  };
}

export function writeTable(config: CampaignConfig, table: CampaignTable) {
  if (!config.out) return;
  mkdirSync(dirname(config.out), { recursive: true });
  writeFileSync(config.out, `${JSON.stringify(table, null, 2)}\n`);
}

/**
 * Captures console.error / console.warn (React act() warnings, unhandled
 * effect errors) and unhandled promise rejections while a scenario runs.
 * The prompt's own submit() swallows API errors, so any rejection surfacing
 * here is a real leak.
 */
export class NoiseRecorder {
  readonly consoleErrors: string[] = [];
  readonly consoleWarnings: string[] = [];
  readonly unhandledRejections: string[] = [];
  private readonly originalError = console.error;
  private readonly originalWarn = console.warn;
  private readonly onRejection = (reason: unknown) => {
    this.unhandledRejections.push(describe(reason));
  };

  start() {
    console.error = (...args: unknown[]) => {
      this.consoleErrors.push(args.map(describe).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      this.consoleWarnings.push(args.map(describe).join(' '));
    };
    process.on('unhandledRejection', this.onRejection);
  }

  stop() {
    console.error = this.originalError;
    console.warn = this.originalWarn;
    process.off('unhandledRejection', this.onRejection);
  }

  reset() {
    this.consoleErrors.length = 0;
    this.consoleWarnings.length = 0;
    this.unhandledRejections.length = 0;
  }
}

export function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Flush the microtask queue enough times for chained awaits to settle. */
export async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}
