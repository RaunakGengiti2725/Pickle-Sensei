/**
 * Deterministic PRNG + drawing helpers for the `mod-app-root` seeded stress
 * campaigns (`__tests__/stress/mod-app-root/`). Every sequence in a campaign
 * is a pure function of its 32-bit seed, so any row of the results table can
 * be replayed on its own with `STRESS_SEED=<seed>`.
 *
 * mulberry32 — the same generator the lifecycle-persistence xc harness uses.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Uniform pick from a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick: `weights[i]` is the relative weight of `items[i]`. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Bernoulli trial with probability `p` of `true`. */
  chance(p: number): boolean;
}

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number =>
    min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: items => {
      if (items.length === 0) throw new Error('pick() from an empty list');
      return items[int(0, items.length - 1)]!;
    },
    weighted: (items, weights) => {
      if (items.length === 0 || items.length !== weights.length) {
        throw new Error('weighted() needs one weight per item');
      }
      const total = weights.reduce((sum, w) => sum + w, 0);
      let roll = next() * total;
      for (let i = 0; i < items.length; i += 1) {
        roll -= weights[i]!;
        if (roll < 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
    chance: p => next() < p,
  };
}

/**
 * Campaign sizing shared by both stress suites.
 *
 * - `STRESS_ITER`  number of sequences (default keeps the suite fast in CI).
 * - `STRESS_SEED`  replay exactly one seed (also forces the trace into the
 *                  artifact so the failure can be read without re-running).
 * - `STRESS_SEED_BASE` first seed of the campaign (seeds are contiguous).
 * - `STRESS_MIN_LEN` / `STRESS_MAX_LEN`  sequence length bounds (5..60 by
 *                  default — the lens contract).
 */
export interface CampaignPlan {
  seeds: readonly number[];
  minLen: number;
  maxLen: number;
  replayOnly: number | null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

export function planCampaign(defaultIterations: number): CampaignPlan {
  const minLen = envInt('STRESS_MIN_LEN', 5);
  const maxLen = envInt('STRESS_MAX_LEN', 60);
  if (minLen < 1 || maxLen < minLen) {
    throw new Error('STRESS_MIN_LEN/STRESS_MAX_LEN out of order');
  }
  const replayRaw = process.env.STRESS_SEED;
  if (replayRaw !== undefined && replayRaw !== '') {
    const seed = Number(replayRaw) >>> 0;
    return { seeds: [seed], minLen, maxLen, replayOnly: seed };
  }
  const base = envInt('STRESS_SEED_BASE', 1);
  const iterations = envInt('STRESS_ITER', defaultIterations);
  const seeds: number[] = [];
  for (let i = 0; i < iterations; i += 1) seeds.push((base + i) >>> 0);
  return { seeds, minLen, maxLen, replayOnly: null };
}

/** Split seeds into it()-sized chunks so no single test runs for minutes. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
