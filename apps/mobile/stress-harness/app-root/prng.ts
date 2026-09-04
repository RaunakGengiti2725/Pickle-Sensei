/**
 * Deterministic PRNG for the app-root stress suites. Every campaign row is a
 * pure function of its seed, so `STRESS_SEED=<n>` replays exactly one row.
 */
export function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[index] as T;
}

export function chance(rng: () => number, probability: number): boolean {
  return rng() < probability;
}
