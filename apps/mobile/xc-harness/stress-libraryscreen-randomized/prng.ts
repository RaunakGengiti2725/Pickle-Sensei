/**
 * Deterministic PRNG for the LibraryScreen randomized-seeded stress campaign.
 * splitmix32: every sequence is fully replayable from its 32-bit seed, and
 * the generator never touches Math.random, Date.now, or module state.
 */
export interface Prng {
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick: weights are relative, non-negative, at least one > 0. */
  weighted<T>(items: readonly (readonly [T, number])[]): T;
  /** Number of draws consumed so far (for traces). */
  draws(): number;
}

export function makePrng(seed: number): Prng {
  let state = seed >>> 0;
  let draws = 0;
  const next = (): number => {
    draws += 1;
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return z / 0x100000000;
  };
  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`int(${min}, ${max}): empty range`);
    return min + Math.floor(next() * (max - min + 1));
  };
  return {
    seed,
    next,
    int,
    chance: p => next() < p,
    pick: items => {
      if (items.length === 0) throw new Error('pick from empty array');
      return items[int(0, items.length - 1)]!;
    },
    weighted: items => {
      let total = 0;
      for (const [, weight] of items) {
        if (weight < 0 || !Number.isFinite(weight)) {
          throw new Error(`bad weight ${weight}`);
        }
        total += weight;
      }
      if (total <= 0) throw new Error('weighted pick with zero total');
      let roll = next() * total;
      for (const [item, weight] of items) {
        roll -= weight;
        if (roll < 0) return item;
      }
      return items[items.length - 1]![0];
    },
    draws: () => draws,
  };
}

/** Stable 32-bit hash of a string (FNV-1a) — used to derive sub-seeds. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
