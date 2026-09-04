/**
 * Deterministic PRNG for the ProgressScreen lifecycle stress campaign.
 *
 * mulberry32: a 32-bit seed reproduces the exact same interleaving, so every
 * row of the results table can be replayed with
 * `STRESS_SEED=<seed> npx jest --ci progressScreen.lifecycle.stress`.
 */
export interface Prng {
  /** uniform in [0, 1) */
  next(): number;
  /** uniform integer in [min, max] */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

export function makePrng(seed: number): Prng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: items => {
      if (items.length === 0) throw new Error('pick() from an empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    chance: probability => next() < probability,
  };
}
