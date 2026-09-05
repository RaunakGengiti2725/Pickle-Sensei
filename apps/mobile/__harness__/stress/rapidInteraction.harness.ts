/**
 * Shared plumbing for the seeded rapid-interaction stress suites.
 *
 * Every campaign iteration derives its own seed from a campaign base seed, so
 * a single failing iteration is replayable in isolation:
 *
 *   STRESS_SEED=<seed> npx jest --ci __tests__/stress/<suite>
 *
 * Knobs (all optional):
 *   STRESS_ITER      iterations per suite (default: small enough for the
 *                    normal test run; the reported campaigns use 1000+).
 *   STRESS_SEED      replay exactly one iteration with this seed.
 *   STRESS_BASE      campaign base seed (default 0x5EED0001).
 *   STRESS_OUT_DIR   when set, each suite writes `<suite>.json` (seed →
 *                    outcome table) into this directory.
 *   STRESS_MINIMIZE  when set together with STRESS_SEED, greedily shrink the
 *                    failing action list and print the minimal script.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** mulberry32 — tiny, deterministic, good enough for scenario generation. */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() from empty list');
    return items[this.int(items.length)]!;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Weighted pick: `[[weight, value], ...]`. */
  weighted<T>(entries: readonly (readonly [number, T])[]): T {
    const total = entries.reduce((sum, [w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [w, value] of entries) {
      roll -= w;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1]![1];
  }
}

/** Derives the per-iteration seed from the campaign base seed. */
export function iterationSeed(base: number, iteration: number): number {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ iteration, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export type CampaignConfig = {
  iterations: number;
  base: number;
  replaySeed: number | null;
  minimize: boolean;
  outDir: string | null;
};

export function campaignConfig(defaultIterations: number): CampaignConfig {
  const iter = Number(process.env.STRESS_ITER);
  const base = Number(process.env.STRESS_BASE);
  const replay = process.env.STRESS_SEED;
  return {
    iterations:
      Number.isFinite(iter) && iter > 0 ? Math.floor(iter) : defaultIterations,
    base: Number.isFinite(base) && base >= 0 ? Math.floor(base) : 0x5eed0001,
    replaySeed: replay !== undefined && replay !== '' ? Number(replay) : null,
    minimize: Boolean(process.env.STRESS_MINIMIZE),
    outDir: process.env.STRESS_OUT_DIR || null,
  };
}

/** The seeds a campaign will run, honouring STRESS_SEED replay. */
export function campaignSeeds(config: CampaignConfig): number[] {
  if (config.replaySeed !== null) return [config.replaySeed >>> 0];
  return Array.from({ length: config.iterations }, (_, i) =>
    iterationSeed(config.base, i),
  );
}

export type IterationOutcome = {
  seed: number;
  outcome: 'pass' | 'fail';
  actions: number;
  /** Compact action script (for replay by eye). */
  script: string[];
  /** Failure detail, only when outcome === 'fail'. */
  failure?: string;
  /** Informational counters that are NOT failures. */
  info?: Record<string, number>;
};

export type CampaignTable = {
  suite: string;
  base: number;
  iterations: number;
  executed: number;
  passed: number;
  failed: number;
  info: Record<string, number>;
  results: IterationOutcome[];
};

export function summarize(
  suite: string,
  config: CampaignConfig,
  results: IterationOutcome[],
): CampaignTable {
  const info: Record<string, number> = {};
  for (const result of results) {
    for (const [key, value] of Object.entries(result.info ?? {})) {
      info[key] = (info[key] ?? 0) + value;
    }
  }
  return {
    suite,
    base: config.base,
    iterations: config.replaySeed === null ? config.iterations : 1,
    executed: results.length,
    passed: results.filter(r => r.outcome === 'pass').length,
    failed: results.filter(r => r.outcome === 'fail').length,
    info,
    results,
  };
}

export function writeTable(config: CampaignConfig, table: CampaignTable): void {
  if (!config.outDir) return;
  mkdirSync(config.outDir, { recursive: true });
  writeFileSync(
    join(config.outDir, `${table.suite}.json`),
    JSON.stringify(table, null, 1),
  );
}

/**
 * Captures console.error / console.warn output and unhandled promise
 * rejections for the duration of one iteration. React's act() warnings,
 * React Navigation's "action was not handled" errors and duplicate-key
 * warnings all surface through console.error.
 */
export class NoiseCapture {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  readonly rejections: string[] = [];
  private errorSpy: jest.SpyInstance | null = null;
  private warnSpy: jest.SpyInstance | null = null;
  private readonly onRejection = (reason: unknown) => {
    this.rejections.push(describe(reason));
  };

  start(): void {
    this.errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        this.errors.push(args.map(describe).join(' '));
      });
    this.warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation((...args: unknown[]) => {
        this.warnings.push(args.map(describe).join(' '));
      });
    process.on('unhandledRejection', this.onRejection);
  }

  stop(): void {
    this.errorSpy?.mockRestore();
    this.warnSpy?.mockRestore();
    process.off('unhandledRejection', this.onRejection);
  }

  report(): string | null {
    const lines: string[] = [];
    if (this.errors.length)
      lines.push(`console.error×${this.errors.length}: ${this.errors[0]}`);
    if (this.warnings.length)
      lines.push(`console.warn×${this.warnings.length}: ${this.warnings[0]}`);
    if (this.rejections.length)
      lines.push(
        `unhandledRejection×${this.rejections.length}: ${this.rejections[0]}`,
      );
    return lines.length ? lines.join('\n') : null;
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

export function invariant(
  condition: unknown,
  message: () => string,
): asserts condition {
  if (!condition) throw new InvariantViolation(message());
}

/**
 * Greedy one-at-a-time shrink: drops any action whose removal keeps the
 * script failing. `run` must return null on pass or a failure string.
 */
export function minimizeScript<A>(
  script: A[],
  run: (script: A[]) => string | null,
): { script: A[]; failure: string } {
  let current = script;
  let failure = run(current);
  if (failure === null) throw new Error('minimizeScript: script passes');
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < current.length; i += 1) {
      const candidate = current.filter((_, index) => index !== i);
      const result = run(candidate);
      if (result !== null) {
        current = candidate;
        failure = result;
        progress = true;
        i -= 1;
      }
    }
  }
  return { script: current, failure };
}

/** Deep-param fuzz corpus for string route params (analysisId, phase, …). */
export const FUZZ_STRINGS: readonly string[] = [
  '',
  ' ',
  'a',
  '0',
  '-1',
  'null',
  'undefined',
  '[object Object]',
  '__proto__',
  'constructor',
  'analysis-00000000-0000-0000-0000-000000000000',
  'x'.repeat(4096),
  '🥒'.repeat(64),
  '\u0000\u0001\u001f',
  '\u202e\u200f rtl',
  '../../etc/passwd',
  '<script>alert(1)</script>',
  '{"analysisId":"nested"}',
  'Ω≈ç√∫˜µ≤≥÷',
  '\uD83D', // lone surrogate
];
