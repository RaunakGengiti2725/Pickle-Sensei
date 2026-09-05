/**
 * Seeded PRNG for the stress harnesses. Mulberry32: tiny, fast, and fully
 * determined by its 32-bit seed, so every generated sequence is replayable
 * from `seed` alone.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [lo, hi] (inclusive). */
export function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() from an empty list');
  return items[int(rng, 0, items.length - 1)]!;
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

/** Weighted choice: `[value, weight]` pairs. */
export function weighted<T>(rng: Rng, entries: ReadonlyArray<[T, number]>): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1]![0];
}

/** Fisher–Yates permutation of 0..n-1. */
export function permutation(rng: Rng, n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = int(rng, 0, i);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** Deterministic RFC-4122-shaped id derived from the rng (NOT random). */
export function seededUuid(rng: Rng): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = int(rng, 0, 255);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable 32-bit hash (FNV-1a) — turns a campaign label + index into a seed. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
