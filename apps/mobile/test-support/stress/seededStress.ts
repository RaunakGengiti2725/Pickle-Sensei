/**
 * Seeded randomized stress support — deterministic RNG, campaign sizing from
 * the environment, a delta-debugging minimizer and a JSON result table
 * writer. Shared by the Live Court stress suites under __tests__/stress/.
 *
 * Every sequence is replayable from (baseSeed, index) → per-sequence seed;
 * nothing here touches Math.random or Date.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

declare const process: { env: Record<string, string | undefined> };

/** splitmix32-style seeded generator — small, fast, deterministic. */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 0x100000000;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick() from empty list');
    return item;
  }

  /** Weighted choice; weights need not sum to 1. */
  weighted<T extends string>(table: Record<T, number>): T {
    const entries = Object.entries(table) as Array<[T, number]>;
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
}

/** FNV-1a mix of (seed, salt) → a fresh 32-bit seed for a sub-stream. */
export function subSeed(seed: number, salt: number | string): number {
  const text = `${seed}:${salt}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface CampaignConfig {
  /** Number of sequences to run (STRESS_ITER, default small). */
  iterations: number;
  /** Base seed (STRESS_SEED). Sequence i uses subSeed(baseSeed, i). */
  baseSeed: number;
  /** Optional JSON output path (STRESS_OUT); a suffix is appended per suite. */
  outPath: string | null;
  /** Replay exactly one sequence seed (STRESS_REPLAY_SEED), skipping the campaign. */
  replaySeed: number | null;
}

export function campaignConfig(defaultIterations: number): CampaignConfig {
  const parse = (raw: string | undefined): number | null => {
    if (raw === undefined || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const iterations = parse(process.env.STRESS_ITER);
  return {
    iterations:
      iterations !== null && iterations > 0 ? iterations : defaultIterations,
    baseSeed: parse(process.env.STRESS_SEED) ?? 20260904,
    outPath: process.env.STRESS_OUT ?? null,
    replaySeed: parse(process.env.STRESS_REPLAY_SEED),
  };
}

export class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    readonly step: number,
    detail: string,
  ) {
    super(`[${invariant}] step ${step}: ${detail}`);
    this.name = 'InvariantViolation';
  }
}

export function check(
  condition: boolean,
  invariant: string,
  step: number,
  detail: () => string,
): void {
  if (!condition) throw new InvariantViolation(invariant, step, detail());
}

export interface SequenceOutcome {
  seed: number;
  length: number;
  status: 'HELD' | 'BROKEN' | 'NONDETERMINISTIC';
  /** First invariant violated (or the unexpected error) when BROKEN. */
  failure: string | null;
  invariant: string | null;
  failingStep: number | null;
  /** Minimized action list (JSON) reproducing the same invariant. */
  minimized: unknown[] | null;
  minimizedLength: number | null;
  stats: Record<string, number>;
  traceDigest: string;
}

/**
 * ddmin-style minimizer over an action list: keeps removing chunks while
 * `stillFails(actions)` reports the SAME invariant. Deterministic and bounded
 * (chunk size halves down to 1).
 */
export async function minimizeActions<A>(
  actions: readonly A[],
  stillFails: (candidate: readonly A[]) => Promise<boolean>,
): Promise<A[]> {
  let current = [...actions];
  let chunk = Math.max(1, Math.floor(current.length / 2));
  while (current.length > 1 && chunk >= 1) {
    let removedAny = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      if (await stillFails(candidate)) {
        current = candidate;
        removedAny = true;
        start -= chunk;
      }
    }
    if (!removedAny) chunk = Math.floor(chunk / 2);
  }
  return current;
}

export function digest(value: unknown): string {
  const text = JSON.stringify(value);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h2 >>> 0).toString(16).padStart(8, '0') +
    (h1 >>> 0).toString(16).padStart(8, '0')
  );
}

export interface CampaignReport {
  suite: string;
  baseSeed: number;
  iterations: number;
  executed: number;
  held: number;
  broken: number;
  nondeterministic: number;
  totals: Record<string, number>;
  outcomes: SequenceOutcome[];
}

export function writeReport(report: CampaignReport, suffix: string): void {
  const config = campaignConfig(0);
  if (config.outPath === null) return;
  const path = config.outPath.replace(/\.json$/, '') + `.${suffix}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}

/** Drain every queued microtask + one macrotask turn (promise chains inside
 * LiveSessionFlow.dispatchAnalysis settle within this). Deterministic. */
export function flushAsync(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

export function sumStats(
  outcomes: readonly SequenceOutcome[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const outcome of outcomes) {
    for (const [key, value] of Object.entries(outcome.stats)) {
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}
