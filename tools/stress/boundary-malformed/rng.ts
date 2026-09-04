/**
 * Deterministic PRNG for the boundary/malformed-input stress harness.
 *
 * splitmix32: 32-bit state, good avalanche, trivially replayable — every
 * generated case is fully determined by its 32-bit seed, so a failing row can
 * be re-run from the seed printed in the JSON table.
 */
export class Rng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 0x1_0000_0000;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick on empty list");
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("Rng.pick out of range");
    return item;
  }

  /** k distinct picks (k clamped to list length), order preserved from the list. */
  sample<T>(items: readonly T[], k: number): T[] {
    const indices = items.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = indices[i];
      const b = indices[j];
      if (a === undefined || b === undefined) throw new Error("unreachable");
      indices[i] = b;
      indices[j] = a;
    }
    return indices
      .slice(0, Math.min(k, items.length))
      .sort((a, b) => a - b)
      .map((i) => {
        const item = items[i];
        if (item === undefined) throw new Error("unreachable");
        return item;
      });
  }
}

/** Per-iteration seed derived from the campaign base seed. */
export function iterationSeed(baseSeed: number, iteration: number): number {
  let z = (baseSeed ^ Math.imul(iteration + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}
