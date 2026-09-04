/**
 * Deterministic PRNG for the StreakCalendarScreen lifecycle stress campaign.
 * mulberry32 — the same generator the xc lifecycle matrix uses, so a seed
 * printed in an artifact regenerates the exact same schedule anywhere.
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
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick() from an empty list');
  return item;
}

/** Integer in [lo, hi] inclusive. */
export function int(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function weighted<T>(
  rng: () => number,
  entries: readonly (readonly [T, number])[],
): T {
  let total = 0;
  for (const [, weight] of entries) total += weight;
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  const last = entries[entries.length - 1];
  if (!last) throw new Error('weighted() from an empty list');
  return last[0];
}
