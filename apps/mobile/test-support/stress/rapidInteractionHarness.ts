import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Shared machinery for the rapid/concurrent interaction stress campaigns.
 *
 * Every iteration is a burst of interactions driven by a seeded generator, so
 * a failure is replayable from its seed alone:
 *
 *   STRESS_SEEDS=<seed>[,<seed>…] npx jest --ci __tests__/stress/<suite>
 *
 * The campaign size is `STRESS_ITER` (small default so the suite stays in the
 * normal Jest run) and the JSON seed → outcome table lands at `STRESS_OUT`.
 */

export interface Rng {
  /** Raw float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Integer in [min, max]. */
  between(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
}

/** mulberry32 — tiny, fast, fully deterministic for a 32-bit seed. */
export function rngFor(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number) =>
    maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive) % maxExclusive;
  return {
    next,
    int,
    between: (min, max) => min + int(max - min + 1),
    pick: items => items[int(items.length)]!,
    bool: (probability = 0.5) => next() < probability,
  };
}

export function iterationCount(fallback: number): number {
  const raw = process.env['STRESS_ITER'];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Explicit replay list: `STRESS_SEEDS=123,456`. */
export function replaySeeds(): number[] | null {
  const raw = process.env['STRESS_SEEDS'];
  if (!raw) return null;
  const seeds = raw
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(seed => Number.isFinite(seed));
  return seeds.length > 0 ? seeds : null;
}

export function seedsFor(base: number, count: number): number[] {
  const replay = replaySeeds();
  if (replay) return replay;
  return Array.from({ length: count }, (_, index) => base + index);
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

export interface ConsoleSentinel {
  /** Everything console.error/console.warn received since install. */
  readonly messages: string[];
  /** React's "not wrapped in act(...)" and friends. */
  actWarnings(): string[];
  drain(): string[];
  restore(): void;
}

/**
 * React reports interleaved/unbatched updates as console.error act() warnings
 * rather than throwing, so the sentinel is the only way a rapid-interaction
 * campaign can see them. Messages are captured (not printed) and asserted on.
 */
export function installConsoleSentinel(): ConsoleSentinel {
  const messages: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const capture = (...args: unknown[]) => {
    messages.push(formatConsoleArgs(args));
  };
  console.error = capture as typeof console.error;
  console.warn = capture as typeof console.warn;
  return {
    messages,
    actWarnings: () =>
      messages.filter(message =>
        /not wrapped in act|inside a test was not wrapped|act\(\)/i.test(
          message,
        ),
      ),
    drain: () => messages.splice(0, messages.length),
    restore: () => {
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

export interface RejectionSentinel {
  readonly rejections: string[];
  drain(): string[];
  restore(): void;
}

export function installRejectionSentinel(): RejectionSentinel {
  const rejections: string[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason),
    );
  };
  process.on('unhandledRejection', onRejection);
  return {
    rejections,
    drain: () => rejections.splice(0, rejections.length),
    restore: () => {
      process.off('unhandledRejection', onRejection);
    },
  };
}

export interface IterationRecord {
  seed: number;
  scenario: string;
  /** HELD = every invariant held; BROKEN = at least one failed. */
  outcome: 'HELD' | 'BROKEN';
  /** Interactions actually dispatched in this burst. */
  interactions: number;
  /** Short, replayable description of the generated burst. */
  script: string;
  failures: string[];
}

export interface ResultTable {
  unit: string;
  lens: string;
  baseSeed: number;
  iterations: number;
  interactions: number;
  broken: number;
  scenarioCounts: Record<string, number>;
  generatedAtIso: string;
  results: IterationRecord[];
}

export function buildResultTable(input: {
  unit: string;
  lens: string;
  baseSeed: number;
  results: IterationRecord[];
}): ResultTable {
  const scenarioCounts: Record<string, number> = {};
  for (const record of input.results) {
    scenarioCounts[record.scenario] =
      (scenarioCounts[record.scenario] ?? 0) + 1;
  }
  return {
    unit: input.unit,
    lens: input.lens,
    baseSeed: input.baseSeed,
    iterations: input.results.length,
    interactions: input.results.reduce(
      (total, record) => total + record.interactions,
      0,
    ),
    broken: input.results.filter(record => record.outcome === 'BROKEN').length,
    scenarioCounts,
    generatedAtIso: new Date().toISOString(),
    results: input.results,
  };
}

/** Writes the seed → outcome table and returns its absolute path. */
export function writeResultTable(name: string, table: ResultTable): string {
  const target =
    process.env['STRESS_OUT'] ??
    path.join(os.tmpdir(), 'pickle-stress', `${name}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(table, null, 2)}\n`);
  return target;
}
