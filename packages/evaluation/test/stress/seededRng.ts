/**
 * Small deterministic PRNG for the stress harness (mulberry32 over a 32-bit
 * seed). Every campaign iteration derives its sequence seed from
 * `deriveSeed(seedBase, index)` so any row of the results table can be
 * replayed from its recorded seed alone.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let index = out.length - 1; index > 0; index -= 1) {
      const swap = this.int(0, index);
      const a = out[index] as T;
      out[index] = out[swap] as T;
      out[swap] = a;
    }
    return out;
  }
}

/** 32-bit FNV-1a; used both for seed derivation and trace digests. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function deriveSeed(seedBase: number, index: number): number {
  return fnv1a(`${seedBase >>> 0}:${index}`);
}

/**
 * Canonical JSON (sorted keys) that keeps the values plain JSON would erase:
 * NaN, ±Infinity and undefined are spelled out so a digest changes when they
 * appear.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number") {
      if (Number.isNaN(item)) return "__NaN__";
      if (item === Number.POSITIVE_INFINITY) return "__+Infinity__";
      if (item === Number.NEGATIVE_INFINITY) return "__-Infinity__";
      return item;
    }
    if (item === undefined) return "__undefined__";
    if (typeof item === "function") return "__function__";
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = record[key];
      return sorted;
    }
    return item;
  });
}

export function digest(value: unknown): string {
  return fnv1a(canonicalJson(value)).toString(16).padStart(8, "0");
}
