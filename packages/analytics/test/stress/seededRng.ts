/**
 * Deterministic PRNG for the stress harness (mulberry32). Every campaign
 * iteration derives its own generator from `baseSeed + iteration`, so any
 * single outcome is replayable from its seed alone.
 */
export class SeededRng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Log-uniform integer in [min, max] — spreads sizes across magnitudes. */
  logInt(min: number, max: number): number {
    const lo = Math.log(Math.max(1, min));
    const hi = Math.log(Math.max(1, max));
    return Math.min(max, Math.max(min, Math.round(Math.exp(lo + this.next() * (hi - lo)))));
  }

  string(length: number, alphabet: string): string {
    const chars = Array.from(alphabet);
    let out = "";
    for (let i = 0; i < length; i++) out += this.pick(chars);
    return out;
  }
}

export const ASCII_WORD = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
export const ASCII_PRINTABLE =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
export const CONTROL_CHARS = "\u0000\u0001\u0007\u0008\u001b\u007f\r\n\t";
export const ASTRAL = "😀🎾🏓🥒🍕🚀🧠🪐";
/** Five combining marks: appended to a base letter they form ONE grapheme of six code units. */
export const COMBINING = "\u0301\u0308\u0327\u0331\u20d7";
