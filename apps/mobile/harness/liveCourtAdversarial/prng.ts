/**
 * Deterministic PRNG for the Live Court adversarial harness. Every generated
 * stream is a pure function of its seed, so any failing scenario is replayable
 * from the seed recorded in the evidence tables.
 */
export class SeededRng {
  private state: number;

  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32 — uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick() from empty list');
    return item;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Fisher–Yates, in place, seeded. */
  shuffle<T>(items: T[]): T[] {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const swap = this.int(0, index);
      const a = items[index];
      const b = items[swap];
      if (a === undefined || b === undefined) continue;
      items[index] = b;
      items[swap] = a;
    }
    return items;
  }
}
