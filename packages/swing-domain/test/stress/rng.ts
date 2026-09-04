/**
 * Seeded PRNG for the randomized stress harness. splitmix32-style state
 * mixing: every sequence is fully determined by its 32-bit seed, so any
 * recorded seed replays the identical action plan.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.float() * (max - min);
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick() from empty array");
    return items[this.int(0, items.length - 1)]!;
  }

  /** Pick by relative weight; entries are [weight, value]. */
  weighted<T>(entries: readonly (readonly [number, T])[]): T {
    let total = 0;
    for (const [w] of entries) total += w;
    let r = this.float() * total;
    for (const [w, v] of entries) {
      r -= w;
      if (r < 0) return v;
    }
    return entries[entries.length - 1]![1];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  /** Random sub-multiset of items (each kept with probability p). */
  subset<T>(items: readonly T[], p: number): T[] {
    return items.filter(() => this.chance(p));
  }

  /** Deterministic derived seed for a child sequence. */
  fork(): number {
    return Math.floor(this.float() * 4294967296) >>> 0;
  }
}

/** Mix a base seed and an index into a per-sequence seed (stable across runs). */
export function sequenceSeed(baseSeed: number, index: number): number {
  let h = (baseSeed ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h === 0 ? 1 : h;
}

/**
 * Canonical JSON: sorted object keys, NaN/±Infinity encoded as tagged
 * strings so non-finite values survive (and are visible in) the trace.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "number" && !Number.isFinite(v)) return `__nonfinite:${String(v)}`;
    if (typeof v === "bigint") return `__bigint:${v.toString()}`;
    if (v instanceof Map) return { __map: [...v.entries()] };
    if (v instanceof Set) return { __set: [...v.values()] };
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
