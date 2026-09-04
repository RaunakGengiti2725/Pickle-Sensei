/**
 * Deterministic PRNG for the randomized outbox state-machine harness.
 *
 * sfc32 seeded through splitmix32 so that (seed, sequenceIndex) always yields
 * the same operation stream — every failure is replayable from its seed pair.
 */

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  /** Number of draws taken; recorded in failure reports for replay audits. */
  draws = 0;

  constructor(seed: number) {
    const mix = splitmix32(seed);
    this.a = mix();
    this.b = mix();
    this.c = mix();
    this.d = mix();
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  nextUint32(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    this.draws += 1;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.int: max ${max} < min ${min}`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list');
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('Rng.pick: index out of range');
    return item;
  }

  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    let total = 0;
    for (const [, weight] of entries) total += weight;
    if (total <= 0) throw new Error('Rng.weighted: non-positive total weight');
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    const last = entries[entries.length - 1];
    if (!last) throw new Error('Rng.weighted: empty entries');
    return last[0];
  }

  /** Lowercase hex string of `bytes` random bytes. */
  hex(bytes: number): string {
    let out = '';
    for (let i = 0; i < bytes; i++) {
      out += (this.nextUint32() & 0xff).toString(16).padStart(2, '0');
    }
    return out;
  }

  /** RFC 4122 shaped v4 UUID drawn from this generator. */
  uuid(): string {
    const h = this.hex(16);
    return (
      `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-` +
      `${(8 + (parseInt(h.slice(16, 17), 16) & 3)).toString(16)}${h.slice(17, 20)}-` +
      `${h.slice(20, 32)}`
    );
  }
}

/** Independent per-sequence seed derived from the run seed and the index. */
export function deriveSequenceSeed(seed: number, index: number): number {
  const mix = splitmix32((seed * 0x1000193) ^ (index * 0x01000193) ^ 0x5eed);
  mix();
  return mix();
}
