/**
 * Deterministic PRNG for the failure-injection stress harnesses. Every
 * iteration derives everything it does from a single integer seed, so any
 * outcome in the JSON results table is replayable with STRESS_SEEDS=<seed>.
 */

/** mulberry32 — small, fast, good enough for scenario selection. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** [0, 1) */
  float(): number;
  /** integer in [min, max] inclusive */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probabilityTrue?: number): boolean;
}

export function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    float: next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      if (items.length === 0) throw new Error("pick() from empty list");
      return items[Math.floor(next() * items.length)]!;
    },
    bool: (probabilityTrue = 0.5) => next() < probabilityTrue,
  };
}

/**
 * Campaign controls shared by every harness:
 *   STRESS_ITER   number of iterations (default `defaultIterations`, small so the
 *                 harness can live in the suite; the campaign runs with a big value)
 *   STRESS_SEED   first seed of the campaign (default 1)
 *   STRESS_SEEDS  comma-separated explicit seeds — replay/minimize exactly these
 *
 * The harnesses are opt-in (`stressEnabled`): a stress cell FAILS when it finds a
 * broken invariant, and the campaigns have reproduced open findings, so running
 * them inside the default `vitest run` / `playwright test` would turn every CI run
 * red until those are fixed. Set STRESS_ITER (or STRESS_SEEDS) to run them.
 */
export function stressEnabled(env: Record<string, string | undefined>): boolean {
  return (env["STRESS_ITER"] ?? "") !== "" || (env["STRESS_SEEDS"] ?? "") !== "";
}

export const STRESS_DISABLED_HINT =
  "stress harness is opt-in: set STRESS_ITER=<n> (campaign) or STRESS_SEEDS=<a,b,...> (replay)";

export function campaignSeeds(
  env: Record<string, string | undefined>,
  defaultIterations: number,
): number[] {
  const explicit = (env["STRESS_SEEDS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => Number(value));
  if (explicit.length > 0) {
    for (const seed of explicit) {
      if (!Number.isInteger(seed) || seed < 0) throw new Error(`STRESS_SEEDS: bad seed ${seed}`);
    }
    return explicit;
  }
  const iterations = Number(env["STRESS_ITER"] ?? defaultIterations);
  const base = Number(env["STRESS_SEED"] ?? 1);
  if (!Number.isInteger(iterations) || iterations < 0) {
    throw new Error(`STRESS_ITER must be a non-negative integer, got ${env["STRESS_ITER"]}`);
  }
  if (!Number.isInteger(base) || base < 0) {
    throw new Error(`STRESS_SEED must be a non-negative integer, got ${env["STRESS_SEED"]}`);
  }
  return Array.from({ length: iterations }, (_, index) => base + index);
}
