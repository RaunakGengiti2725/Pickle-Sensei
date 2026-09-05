/**
 * Shared plumbing for the seeded stress campaigns under `__tests__/stress/`.
 *
 * Every campaign iteration is driven by one integer seed through a mulberry32
 * PRNG, so any outcome is replayable from its seed alone:
 *
 *   STRESS_ITER=<n>              iterations per campaign (small default)
 *   STRESS_ONLY=<campaign>:<seed>  replay exactly one seed of one campaign
 *   STRESS_OUT=<dir>             JSON result tables (default artifacts/stress)
 *
 * Each campaign writes `<campaign>.json` — a seed → outcome table plus a
 * summary — so a run's evidence is machine-readable, not just a green tick.
 */

// The mobile tsconfig excludes node typings (see __tests__/matrix); keep the
// handful of Node built-ins the artifact writer needs behind local shims.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };

const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

export type Rng = () => number;

/** mulberry32 — the same generator the existing stress suites use. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

/** Uniform integer in [lo, hi] (inclusive). */
export function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export interface CampaignPlan {
  /** Seeds this run executes, in order. */
  seeds: number[];
  /** Iterations requested (STRESS_ITER or the campaign default). */
  requested: number;
  /** Non-null when STRESS_ONLY pinned a single seed. */
  only: number | null;
}

/**
 * Seeds for one campaign. Seeds are `base + i` so a report can name a seed
 * without also naming the iteration count it was found under.
 */
export function planCampaign(
  campaign: string,
  base: number,
  defaultIterations: number,
): CampaignPlan {
  const only = process.env.STRESS_ONLY ?? null;
  if (only) {
    const [name, seed] = only.split(':');
    if (name === campaign) {
      const parsed = Number(seed);
      if (!Number.isInteger(parsed)) {
        throw new Error(`STRESS_ONLY must be <campaign>:<seed>, got ${only}`);
      }
      return { seeds: [parsed], requested: 1, only: parsed };
    }
    // Another campaign was pinned: this one runs its smallest useful slice
    // so the suite still executes end to end.
    return { seeds: [base], requested: 1, only: null };
  }
  const raw = process.env.STRESS_ITER;
  const requested = raw === undefined ? defaultIterations : Number(raw);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${raw}`);
  }
  const seeds: number[] = [];
  for (let i = 0; i < requested; i += 1) seeds.push(base + i);
  return { seeds, requested, only: null };
}

export type Outcome = 'held' | 'broken';

export interface StressRow {
  seed: number;
  /** Which injected fault(s) this seed exercised. */
  fault: string;
  outcome: Outcome;
  /** Invariants that failed (empty when held). */
  failures: string[];
  /** Small, JSON-safe description of what happened (for the table). */
  detail: Record<string, unknown>;
  replay: string;
}

export class StressTable {
  readonly rows: StressRow[] = [];
  private readonly startedAt = Date.now();

  constructor(
    readonly campaign: string,
    readonly plan: CampaignPlan,
  ) {}

  replayCommand(seed: number): string {
    return `cd apps/mobile && STRESS_ONLY=${this.campaign}:${seed} npx jest --ci __tests__/stress`;
  }

  record(
    seed: number,
    fault: string,
    failures: string[],
    detail: Record<string, unknown>,
  ): StressRow {
    const row: StressRow = {
      seed,
      fault,
      outcome: failures.length === 0 ? 'held' : 'broken',
      failures,
      detail,
      replay: this.replayCommand(seed),
    };
    this.rows.push(row);
    return row;
  }

  get broken(): StressRow[] {
    return this.rows.filter(row => row.outcome === 'broken');
  }

  /** Writes `<campaign>.json` and returns its path. */
  write(): string {
    const outDir =
      process.env.STRESS_OUT ??
      join(__dirname, '..', '..', '..', '..', 'artifacts', 'stress');
    mkdirSync(outDir, { recursive: true });
    const byFault: Record<string, { executed: number; broken: number }> = {};
    const byInvariant: Record<string, number> = {};
    for (const row of this.rows) {
      const family = row.fault.split('+')[0]!;
      byFault[family] ??= { executed: 0, broken: 0 };
      byFault[family].executed += 1;
      if (row.outcome === 'broken') byFault[family].broken += 1;
      for (const failure of row.failures) {
        const key = failure.split(':')[0]!;
        byInvariant[key] = (byInvariant[key] ?? 0) + 1;
      }
    }
    const path = join(outDir, `${this.campaign}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          campaign: this.campaign,
          generatedAt: new Date().toISOString(),
          requested: this.plan.requested,
          only: this.plan.only,
          executed: this.rows.length,
          held: this.rows.length - this.broken.length,
          broken: this.broken.length,
          wallMs: Date.now() - this.startedAt,
          byFault,
          byInvariant,
          brokenSeeds: this.broken.map(row => row.seed),
          rows: this.rows,
        },
        null,
        2,
      ),
    );
    return path;
  }
}

/** Every number reachable inside `value` (arrays/objects, any depth). */
export function numbersIn(value: unknown, path = '$'): Array<[string, number]> {
  if (typeof value === 'number') return [[path, value]];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => numbersIn(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, item]) => numbersIn(item, `${path}.${key}`),
    );
  }
  return [];
}

/** Paths of every non-finite number inside `value`. */
export function nonFinitePaths(value: unknown): string[] {
  return numbersIn(value)
    .filter(([, number]) => !Number.isFinite(number))
    .map(([path]) => path);
}

/** Every string reachable inside `value`. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => stringsIn(item));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(item =>
      stringsIn(item),
    );
  }
  return [];
}

const LEAK_MARKERS = ['NaN', 'Infinity', 'undefined', 'null', '[object'];

/** Strings a user could read that betray an unformatted internal value. */
export function leakedMarkers(text: string): string[] {
  return LEAK_MARKERS.filter(marker => text.includes(marker));
}

/**
 * Formats a failure as `<invariant>: <detail>` so the JSON summary can bucket
 * by invariant while the row keeps the specifics.
 */
export function fail(invariant: string, detail: string): string {
  return `${invariant}: ${detail}`;
}

/** Whether a fault descriptor asked for this family (`a+b+c` joined). */
export function hasFault(fault: string, family: string): boolean {
  return fault.split('+').includes(family);
}
