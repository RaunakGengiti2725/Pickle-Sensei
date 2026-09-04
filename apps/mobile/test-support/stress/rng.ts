/**
 * Seeded RNG for the stress campaigns under `__tests__/stress/`.
 *
 * mulberry32: a 32-bit generator with a single `uint32` of state, so every
 * iteration is fully replayable from `{ seed }` alone — the campaign result
 * tables record the seed next to each outcome.
 */
export interface Rng {
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Uniform pick from a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** Bernoulli draw with probability `p`. */
  chance(p: number): boolean;
  /** Fisher–Yates shuffle (returns a copy). */
  shuffle<T>(items: readonly T[]): T[];
  /** `count` distinct picks (or fewer when the list is shorter). */
  sample<T>(items: readonly T[], count: number): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    seed,
    next,
    int(min, max) {
      if (max < min) throw new Error(`int(${min}, ${max}) is inverted`);
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new Error('pick() from an empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    chance(p) {
      return next() < p;
    },
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = copy[i] as (typeof items)[number];
        copy[i] = copy[j] as (typeof items)[number];
        copy[j] = tmp;
      }
      return copy;
    },
    sample(items, count) {
      return rng.shuffle(items).slice(0, Math.max(0, count));
    },
  };
  return rng;
}

/** FNV-1a: stable 32-bit seed derived from a label such as a cell name. */
export function seedFromString(label: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
