/**
 * Deterministic RNG for the boundary/malformed stress harness.
 *
 * Every iteration derives ALL of its randomness from a single 32-bit seed,
 * so any row of the results table can be replayed with
 * `replayIteration(seed)` regardless of how many iterations ran before it.
 * splitmix32-style mixing (rather than the propertyInvariants LCG) so
 * adjacent seeds do not produce correlated category choices.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform pick from a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** Bernoulli(p). */
  chance(p: number): boolean;
  /** Fisher–Yates shuffle (returns a copy). */
  shuffle<T>(items: readonly T[]): T[];
}

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 0x1_0000_0000;
  };
  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`rng.int: max ${max} < min ${min}`);
    return min + Math.floor(next() * (max - min + 1));
  };
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error("rng.pick: empty list");
    return items[int(0, items.length - 1)] as T;
  };
  return {
    next,
    int,
    pick,
    chance: (p) => next() < p,
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        const a = out[i] as (typeof out)[number];
        out[i] = out[j] as (typeof out)[number];
        out[j] = a;
      }
      return out;
    },
  };
}

/** Stable seed for iteration `index` of a campaign rooted at `campaignSeed`. */
export function iterationSeed(campaignSeed: number, index: number): number {
  let z = (campaignSeed ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}
