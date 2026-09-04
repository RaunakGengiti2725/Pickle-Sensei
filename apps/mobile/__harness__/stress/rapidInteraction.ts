/**
 * Shared plumbing for the seeded rapid-interaction stress suites under
 * `__tests__/stress/`.
 *
 *  - `mulberry32` — the deterministic PRNG every campaign derives its
 *    interaction script from (same generator as `libraryFocusStress.test.ts`),
 *    so any iteration is replayable from its seed alone.
 *  - `campaignSeeds` — the seed list a suite runs. Defaults are small enough
 *    to live in the regular jest run; `STRESS_ITER=<n>` widens the campaign,
 *    `STRESS_SEED=<n>` (or a comma list) replays exactly those seeds, and
 *    `STRESS_SEED_BASE=<n>` shifts the default window.
 *  - `ConsoleGuard` — captures console.error / console.warn and unhandled
 *    rejections during an iteration so a suite can assert "no act() warning,
 *    no rejected promise" as a first-class invariant instead of relying on
 *    jest's noisy stderr.
 *  - `ResultTable` — collects `{seed → outcome}` rows and, when `STRESS_OUT`
 *    names a directory, writes them as a JSON table for the evidence bundle.
 */
import fs from 'node:fs';
import path from 'node:path';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next: () => number;
  int: (minInclusive: number, maxInclusive: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: (probability: number) => boolean;
}

export function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: items => {
      if (items.length === 0) throw new Error('pick() on empty list');
      return items[int(0, items.length - 1)] as (typeof items)[number];
    },
    chance: probability => next() < probability,
  };
}

function parseIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/**
 * Seeds for one campaign. `defaultIterations` is the count the regular suite
 * runs; every seed is `base + i` so the table stays contiguous and a failing
 * seed is directly replayable with `STRESS_SEED=<seed>`.
 */
export function campaignSeeds(defaultIterations: number): number[] {
  const explicit = process.env.STRESS_SEED;
  if (explicit !== undefined && explicit.trim() !== '') {
    return explicit.split(',').map(part => {
      const seed = Number.parseInt(part.trim(), 10);
      if (!Number.isFinite(seed)) {
        throw new Error(`STRESS_SEED entry "${part}" is not an integer`);
      }
      return seed;
    });
  }
  const iterations = parseIntEnv('STRESS_ITER') ?? defaultIterations;
  const base = parseIntEnv('STRESS_SEED_BASE') ?? 1;
  return Array.from({ length: iterations }, (_, i) => base + i);
}

export interface CapturedDiagnostic {
  kind: 'console.error' | 'console.warn' | 'unhandledRejection';
  message: string;
}

/**
 * Records every console.error / console.warn / unhandled rejection while
 * armed. React's `act()` and "state update on an unmounted component"
 * warnings go through console.error, so a clean guard is the "no act()
 * warnings" invariant the rapid-interaction lens asks for.
 */
export class ConsoleGuard {
  readonly diagnostics: CapturedDiagnostic[] = [];
  private originalError: typeof console.error | null = null;
  private originalWarn: typeof console.warn | null = null;
  private readonly onRejection = (reason: unknown) => {
    this.diagnostics.push({
      kind: 'unhandledRejection',
      message: reason instanceof Error ? reason.message : String(reason),
    });
  };

  arm(): void {
    if (this.originalError) return;
    this.originalError = console.error;
    this.originalWarn = console.warn;
    console.error = (...args: unknown[]) => {
      this.diagnostics.push({
        kind: 'console.error',
        message: args.map(String).join(' '),
      });
    };
    console.warn = (...args: unknown[]) => {
      this.diagnostics.push({
        kind: 'console.warn',
        message: args.map(String).join(' '),
      });
    };
    process.on('unhandledRejection', this.onRejection);
  }

  disarm(): void {
    if (this.originalError) console.error = this.originalError;
    if (this.originalWarn) console.warn = this.originalWarn;
    this.originalError = null;
    this.originalWarn = null;
    process.off('unhandledRejection', this.onRejection);
  }

  /** Empties and returns what was captured since the last drain. */
  drain(): CapturedDiagnostic[] {
    return this.diagnostics.splice(0, this.diagnostics.length);
  }
}

export interface StressRow {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  actions: number;
  script: string;
  failure?: string;
  extra?: Record<string, unknown>;
}

export class ResultTable {
  readonly rows: StressRow[] = [];

  constructor(private readonly campaign: string) {}

  record(row: StressRow): void {
    this.rows.push(row);
  }

  get executed(): number {
    return this.rows.length;
  }

  get broken(): StressRow[] {
    return this.rows.filter(row => row.outcome === 'BROKEN');
  }

  /**
   * Writes `<STRESS_OUT>/<campaign>.json` when STRESS_OUT is set. Silent
   * no-op otherwise so the suite stays side-effect free in CI.
   */
  flush(): string | null {
    const dir = process.env.STRESS_OUT;
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.campaign}.json`);
    const payload = {
      campaign: this.campaign,
      executed: this.executed,
      held: this.rows.filter(row => row.outcome === 'HELD').length,
      broken: this.broken.length,
      seeds_failed: this.broken.map(row => row.seed),
      rows: this.rows,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    return file;
  }
}

/** Append-only log of the interaction script one iteration actually ran. */
export class Trace {
  readonly steps: string[] = [];
  readonly extra: Record<string, unknown> = {};

  step(description: string): void {
    this.steps.push(description);
  }

  get script(): string {
    return this.steps.join(' | ');
  }
}

/**
 * Runs one seeded iteration, records HELD/BROKEN (with the script executed
 * so far) and rethrows so jest still reports the failure.
 */
export async function runSeed(
  table: ResultTable,
  seed: number,
  body: (trace: Trace) => Promise<void>,
): Promise<void> {
  const trace = new Trace();
  try {
    await body(trace);
    table.record({
      seed,
      outcome: 'HELD',
      actions: trace.steps.length,
      script: trace.script,
      extra: trace.extra,
    });
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    table.record({
      seed,
      outcome: 'BROKEN',
      actions: trace.steps.length,
      script: trace.script,
      failure,
      extra: trace.extra,
    });
    throw error;
  }
}
