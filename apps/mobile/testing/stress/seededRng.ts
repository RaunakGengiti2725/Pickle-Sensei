/**
 * Hand-rolled seeded PRNG for the stress campaigns (mulberry32 — 32-bit
 * state, period 2^32, good enough to enumerate action sequences and replay
 * them byte-for-byte from a single integer seed). Every random decision the
 * harness makes flows through one of these so a sequence is fully determined
 * by its seed.
 */
export interface SeededRng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Uniform pick from a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick: weights need not sum to 1. */
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T;
  /** Bernoulli trial. */
  chance(probability: number): boolean;
  /** Bytes in [0, 255] — used to make uuid generation replayable. */
  fillBytes(target: Uint8Array): void;
}

export function mulberry32(seed: number): SeededRng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: SeededRng = {
    next,
    int(min, max) {
      if (max < min) throw new Error(`int(${min}, ${max}): empty range`);
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new Error('pick(): empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    weighted(items) {
      let total = 0;
      for (const [, weight] of items) total += weight;
      if (total <= 0) throw new Error('weighted(): no positive weight');
      let roll = next() * total;
      for (const [item, weight] of items) {
        roll -= weight;
        if (roll < 0) return item;
      }
      return items[items.length - 1]![0];
    },
    chance(probability) {
      return next() < probability;
    },
    fillBytes(target) {
      for (let i = 0; i < target.length; i += 1) {
        target[i] = Math.floor(next() * 256);
      }
    },
  };
  return rng;
}

/** Deterministic seed list: `count` seeds starting at `base` (inclusive). */
export function seedRange(base: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => (base + i) >>> 0);
}
