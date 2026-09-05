/**
 * Deterministic randomness for the mod-app-root stress campaigns.
 *
 * Every campaign row is a pure function of a 32-bit seed: the same seed
 * regenerates the same hostile value, the same store state and the same
 * step sequence, so any row of the emitted JSON tables can be replayed by
 * seed alone (`STRESS_SEED=<n>`). Nothing here is random at import time.
 */

/** mulberry32 — the same generator the xc lifecycle matrix uses. */
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

export type Rng = () => number;

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

/** Integer in [min, max] inclusive. */
export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

/**
 * Seed schedule for a campaign: `count` distinct 32-bit seeds derived from
 * `campaignSeed`, so `STRESS_ITER=3000` and `STRESS_ITER=50` share their
 * first 50 seeds (a small default run is a strict prefix of the big one).
 */
export function seedSchedule(campaignSeed: number, count: number): number[] {
  const rng = makePrng(campaignSeed);
  const seeds: number[] = [];
  for (let i = 0; i < count; i += 1) {
    seeds.push(Math.floor(rng() * 4294967296) >>> 0);
  }
  return seeds;
}
