/**
 * Deterministic PRNG for the api.ts boundary/malformed stress campaign.
 * Every iteration derives its own 32-bit seed from (base seed, index), so a
 * single row is replayable with `STRESS_REPLAY=<seed>` without re-running the
 * campaign that produced it.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probabilityTrue?: number): boolean;
  /** Pick `count` distinct items (or all of them when fewer exist). */
  sample<T>(items: readonly T[], count: number): T[];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  const rng: Rng = {
    next,
    int(min, max) {
      if (max < min) throw new Error(`rng.int: max ${max} < min ${min}`);
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new Error('rng.pick: empty list');
      const item = items[Math.floor(next() * items.length)];
      // `noUncheckedIndexedAccess` cannot see the bounds check above.
      return item as (typeof items)[number];
    },
    bool(probabilityTrue = 0.5) {
      return next() < probabilityTrue;
    },
    sample(items, count) {
      const pool = [...items];
      const out: (typeof items)[number][] = [];
      while (pool.length > 0 && out.length < count) {
        const index = Math.floor(next() * pool.length);
        const [taken] = pool.splice(index, 1);
        if (taken !== undefined) out.push(taken);
      }
      return out;
    },
  };
  return rng;
}

/** splitmix-style mix so neighbouring indices produce unrelated seeds. */
export function iterationSeed(baseSeed: number, index: number): number {
  let z = (baseSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

export function parseSeedEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`seed must be an unsigned 32-bit integer, got "${value}"`);
  }
  return parsed;
}
