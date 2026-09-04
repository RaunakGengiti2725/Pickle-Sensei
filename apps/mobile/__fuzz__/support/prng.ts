/**
 * Deterministic PRNG for the persisted-state fuzz harness. Every case derives
 * its own seed from (master seed, surface, generator, index) so a single
 * violation is replayable from the numbers in the JSON report alone.
 */

/** FNV-1a 32-bit over a string; stable across runs and platforms. */
export function hashSeed(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  const text = parts.map(String).join('\u0000');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** mulberry32 — uniform in [0, 1). */
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

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Rng.pick requires a non-empty list');
    }
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Random UTF-16 code units, including lone surrogates, NUL and controls. */
  codeUnits(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += String.fromCharCode(this.int(0, 0xffff));
    }
    return out;
  }

  /** Random printable ASCII (0x20–0x7e). */
  ascii(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += String.fromCharCode(this.int(0x20, 0x7e));
    }
    return out;
  }

  /** Random bytes 0x00–0xff as a Latin-1 string (what a raw byte dump
   * decoded as ISO-8859-1 would look like to `String(value)`). */
  bytesLatin1(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += String.fromCharCode(this.int(0, 0xff));
    }
    return out;
  }
}
