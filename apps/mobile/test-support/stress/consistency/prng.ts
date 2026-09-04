/**
 * Deterministic randomness for the consistency stress campaigns.
 *
 * Every scenario is a pure function of a 32-bit seed, so any row of the
 * emitted JSON tables can be replayed by seed alone (`STRESS_SEED=<n>`).
 * mulberry32 — same generator as xc-harness/lifecycle-persistence/seeds.ts.
 */
export type Rng = () => number;

export function makePrng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() from empty list');
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

/** Uniform integer in [lo, hi] (inclusive). */
export function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

/** Weighted choice: `[item, weight]` pairs. */
export function weighted<T>(
  rng: Rng,
  items: readonly (readonly [T, number])[],
): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1]![0];
}

export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Campaign sizing: `STRESS_ITER` seeds (default small so the suite stays
 * fast), or a single `STRESS_SEED` to replay one row. */
export function campaignSeeds(
  env: Record<string, string | undefined>,
  defaultIterations: number,
  base = 1,
): number[] {
  const single = env['STRESS_SEED'];
  if (single !== undefined && single !== '') {
    return single
      .split(',')
      .map(part => Number(part.trim()))
      .filter(seed => Number.isInteger(seed));
  }
  const configured = Number(env['STRESS_ITER']);
  const count =
    Number.isInteger(configured) && configured > 0
      ? configured
      : defaultIterations;
  return Array.from({ length: count }, (_, i) => base + i);
}
