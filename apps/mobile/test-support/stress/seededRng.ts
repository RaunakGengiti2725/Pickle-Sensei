/**
 * Deterministic PRNG for stress campaigns (mulberry32). Every campaign
 * iteration derives its own generator from `campaignSeed + iteration`, so a
 * single failing iteration replays with `STRESS_SEED=<seed> STRESS_ITER=1`.
 */
export interface SeededRng {
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Bernoulli trial. */
  chance(probability: number): boolean;
}

export function createSeededRng(seed: number): SeededRng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) {
        throw new Error('pick() on empty array');
      }
      const index = Math.floor(next() * items.length);
      return items[index] as (typeof items)[number];
    },
    chance(probability) {
      return next() < probability;
    },
  };
}

export function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got ${raw}`);
  }
  return Math.floor(value);
}
