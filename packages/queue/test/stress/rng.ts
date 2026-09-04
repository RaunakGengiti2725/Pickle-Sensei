/**
 * Seeded PRNG for replayable stress campaigns (mulberry32). Every iteration of
 * a campaign derives its own stream from `(campaignSeed, iteration)` so any
 * single failing iteration can be replayed in isolation from its seed.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Bernoulli trial. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick(items) {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error("pick() on empty list");
      return item;
    },
  };
}

/** Deterministic per-iteration seed derived from the campaign seed. */
export function iterationSeed(campaignSeed: number, iteration: number): number {
  // splitmix-style mixing so neighbouring iterations do not share prefixes
  let x = (campaignSeed ^ Math.imul(iteration + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** FNV-1a 32-bit over a string — cheap stable digest for determinism checks. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function randomPayload(rng: Rng): { id: string; blob: string; n: number } {
  const len = rng.int(0, 2048);
  let blob = "";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < len; i++) blob += alphabet[rng.int(0, alphabet.length - 1)];
  return { id: `p-${rng.int(0, 1_000_000)}`, blob, n: rng.int(-1_000_000, 1_000_000) };
}
