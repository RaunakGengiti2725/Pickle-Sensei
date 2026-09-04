/**
 * Deterministic PRNG for the seeded stress campaigns (mulberry32). Every
 * sequence in the campaign is fully replayable from its 32-bit seed; the
 * generator never touches Math.random or the clock.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from empty list");
    return item;
  }

  /** Weighted pick: weights need not sum to 1. */
  weighted<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights) as Array<[T, number]>;
    const total = entries.reduce((acc, [, w]) => acc + w, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
}

/** FNV-1a 32-bit over a string — used to fingerprint traces for determinism checks. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * JSON serializer that keeps non-JSON numerics visible (NaN, ±Infinity,
 * undefined) instead of silently turning them into null — the campaign
 * needs to see exactly what the unit produced.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number") {
      if (Number.isNaN(item)) return "__NaN__";
      if (item === Infinity) return "__Infinity__";
      if (item === -Infinity) return "__-Infinity__";
      return item;
    }
    if (item === undefined) return "__undefined__";
    return item;
  });
}
