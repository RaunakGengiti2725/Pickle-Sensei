/**
 * Deterministic PRNG for replayable stress campaigns (mulberry32). Every
 * scenario derives all of its choices from one 32-bit seed so a failing
 * iteration is reproduced by re-running that seed alone.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`int(): max ${max} < min ${min}`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick(): empty list');
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick(): unreachable');
    return item;
  }

  /** `count` distinct items, order preserved from the source list. */
  sample<T>(items: readonly T[], count: number): T[] {
    const indexes = items.map((_, index) => index);
    for (let i = indexes.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = indexes[i];
      const b = indexes[j];
      if (a === undefined || b === undefined) continue;
      indexes[i] = b;
      indexes[j] = a;
    }
    return indexes
      .slice(0, Math.min(count, items.length))
      .sort((a, b) => a - b)
      .map(index => items[index] as T);
  }

  /** Deterministic v4-shaped UUID (matches the API's UUID_PATTERN). */
  uuid(): string {
    const hex = (bits: number) =>
      this.int(0, 2 ** bits - 1)
        .toString(16)
        .padStart(bits / 4, '0');
    const variant = this.pick(['8', '9', 'a', 'b']);
    return `${hex(32)}-${hex(16)}-4${hex(12)}-${variant}${hex(12)}-${hex(
      32,
    )}${hex(16)}`;
  }
}
