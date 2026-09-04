/**
 * Rapid/concurrent-interaction stress support (lens `rapid-interaction`).
 *
 * Every campaign iteration is derived from ONE integer seed through the
 * mulberry32 generator in ../xcBehavioral/evidence.ts, so any recorded
 * outcome replays exactly with `STRESS_SEED=<seed> npx jest <suite>`.
 *
 * Scale knobs (all optional):
 *   STRESS_ITER    number of seeds per campaign (default: the suite's small
 *                  in-suite default, so the normal `npx jest` run stays fast)
 *   STRESS_SEED    replay exactly one seed (ignores STRESS_ITER)
 *   STRESS_REPEAT  run every seed N times (flake-rate measurement)
 *   STRESS_RUN_ID  evidence folder name under artifacts/stress/ (default
 *                  `local`); one NDJSON line per executed iteration.
 */
import { randomInt, seededRandom } from '../xcBehavioral/evidence';

// Node built-ins for the evidence sink; the mobile tsconfig has no node
// typings, so the shims stay local (same convention as evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  on: (event: string, listener: (reason: unknown) => void) => unknown;
  off: (event: string, listener: (reason: unknown) => void) => unknown;
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export { randomInt, seededRandom };

/**
 * Decorrelates consecutive seeds before mulberry32 (its first outputs for
 * adjacent seeds are close); a plan stays a pure function of its seed.
 */
export function mixSeed(seed: number): number {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export interface StressCampaign {
  /** Seeds to execute, in order. */
  seeds: number[];
  /** How many times each seed runs (STRESS_REPEAT, default 1). */
  repeat: number;
  /** True when STRESS_SEED pinned a single seed. */
  replay: boolean;
}

function envInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

export function stressCampaign(
  defaultIterations: number,
  seedBase: number,
): StressCampaign {
  const pinned = envInt('STRESS_SEED');
  const repeat = Math.max(1, envInt('STRESS_REPEAT') ?? 1);
  if (pinned !== null) return { seeds: [pinned], repeat, replay: true };
  const iterations = Math.max(1, envInt('STRESS_ITER') ?? defaultIterations);
  const seeds: number[] = [];
  for (let i = 0; i < iterations; i += 1) seeds.push(seedBase + i);
  return { seeds, repeat, replay: false };
}

export interface StressRecord {
  suite: string;
  seed: number;
  run: number;
  plan: Record<string, unknown>;
  observed: Record<string, unknown>;
  violations: string[];
  verdict: 'pass' | 'fail';
  durationMs: number;
  atIso: string;
}

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

export function stressEvidenceDir(): string {
  // apps/mobile/testing/stress → repo root
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(root, 'artifacts', 'stress', RUN_ID);
}

export function appendStressRecord(record: StressRecord): void {
  const dir = stressEvidenceDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, `${record.suite}.ndjson`),
    `${JSON.stringify(record)}\n`,
  );
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
    .join(' ')
    .slice(0, 600);
}

/**
 * Captures console.error / console.warn / unhandled promise rejections for
 * the lifetime of one iteration. act() warnings, "Cannot update a component"
 * and every other React/RN complaint arrive through console.error, so an
 * empty capture is the "no thrown act() warnings" invariant.
 */
export class NoiseGuard {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  readonly rejections: string[] = [];
  private restore: (() => void) | null = null;

  install(): void {
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => {
      this.errors.push(formatConsoleArgs(args));
    };
    console.warn = (...args: unknown[]) => {
      this.warnings.push(formatConsoleArgs(args));
    };
    const onRejection = (reason: unknown) => {
      this.rejections.push(formatConsoleArgs([reason]));
    };
    process.on('unhandledRejection', onRejection);
    this.restore = () => {
      console.error = originalError;
      console.warn = originalWarn;
      process.off('unhandledRejection', onRejection);
    };
  }

  uninstall(): void {
    this.restore?.();
    this.restore = null;
  }

  violations(): string[] {
    return [
      ...this.errors.map(e => `console.error: ${e}`),
      ...this.warnings.map(w => `console.warn: ${w}`),
      ...this.rejections.map(r => `unhandledRejection: ${r}`),
    ];
  }
}

/** One scheduled interaction on the fake-timer timeline. */
export interface TimedEvent<K extends string> {
  t: number;
  kind: K;
  detail: Record<string, unknown>;
}

export function sortEvents<K extends string>(
  events: TimedEvent<K>[],
): TimedEvent<K>[] {
  // Stable by (t, insertion) so same-tick bursts keep their generated order.
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.t - b.event.t || a.index - b.index)
    .map(({ event }) => event);
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[randomInt(random, 0, items.length - 1)];
  if (item === undefined) throw new Error('pick() from an empty list');
  return item;
}

export function chance(random: () => number, probability: number): boolean {
  return random() < probability;
}

export function summarizeViolations(violations: string[], limit = 8): string {
  const head = violations.slice(0, limit).join('\n  - ');
  const more =
    violations.length > limit ? `\n  … +${violations.length - limit} more` : '';
  return `\n  - ${head}${more}`;
}
