import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Seeded, replayable scheduling primitives shared by the admin-web concurrency
 * stress harnesses (vitest: src/coachReview/__tests__/labApi.concurrency.stress.test.ts;
 * Playwright: e2e/stress.concurrency.e2e.ts).
 *
 * Every campaign iteration derives ALL of its randomness (burst sizes, start
 * jitter, body chunking, abort offsets, response delays, token sequences) from
 * one 32-bit seed, so a failing row in the results table is replayed with
 * `STRESS_ONLY_SEED=<seed>`.
 *
 * Env:
 *   STRESS_ITER       iterations per campaign (default small so the suite stays fast)
 *   STRESS_SEED       base seed; iteration i uses seed (STRESS_SEED + i) >>> 0
 *   STRESS_ONLY_SEED  comma-separated exact seeds to replay (overrides ITER/SEED)
 *   STRESS_OUT        path for the JSON results table (seed → outcome)
 */

export interface SeededRng {
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform integer in [min, maxInclusive]. */
  range(min: number, maxInclusive: number): number;
  bool(probabilityTrue?: number): boolean;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32 — tiny, deterministic, good enough for scheduling decisions. */
export function createSeededRng(seed: number): SeededRng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: SeededRng = {
    seed,
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    range: (min, maxInclusive) => min + Math.floor(next() * (maxInclusive - min + 1)),
    bool: (probabilityTrue = 0.5) => next() < probabilityTrue,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
  };
  return rng;
}

export interface CampaignPlan {
  baseSeed: number;
  seeds: number[];
  outPath: string | null;
}

export function planCampaign(
  env: NodeJS.ProcessEnv,
  defaults: { iterations: number; baseSeed: number },
): CampaignPlan {
  const only = (env["STRESS_ONLY_SEED"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => Number(value) >>> 0);
  const baseSeed = Number(env["STRESS_SEED"] ?? defaults.baseSeed) >>> 0;
  const iterations = Math.max(1, Number(env["STRESS_ITER"] ?? defaults.iterations) || 1);
  const seeds =
    only.length > 0
      ? only
      : Array.from({ length: iterations }, (_, index) => (baseSeed + index) >>> 0);
  return { baseSeed, seeds, outPath: env["STRESS_OUT"] || null };
}

export interface IterationRow {
  seed: number;
  outcome: "HELD" | "BROKEN" | "TIMEOUT";
  ms: number;
  plan: Record<string, unknown>;
  failures: string[];
  notes: Record<string, unknown>;
}

export interface ResultsTable {
  harness: string;
  baseSeed: number;
  startedAtIso: string;
  finishedAtIso: string;
  iterations: number;
  held: number;
  broken: number;
  timeouts: number;
  failedSeeds: number[];
  rows: IterationRow[];
}

export function summarize(
  harness: string,
  baseSeed: number,
  startedAtIso: string,
  rows: IterationRow[],
): ResultsTable {
  return {
    harness,
    baseSeed,
    startedAtIso,
    finishedAtIso: new Date().toISOString(),
    iterations: rows.length,
    held: rows.filter((row) => row.outcome === "HELD").length,
    broken: rows.filter((row) => row.outcome === "BROKEN").length,
    timeouts: rows.filter((row) => row.outcome === "TIMEOUT").length,
    failedSeeds: rows.filter((row) => row.outcome !== "HELD").map((row) => row.seed),
    rows,
  };
}

export function writeResultsTable(path: string, table: ResultsTable): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(table, null, 2));
}

/** Bounded wall time: a hung iteration is a deadlock finding, not a hang of the suite. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
