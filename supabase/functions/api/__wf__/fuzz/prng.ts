// Deterministic PRNG for the edge-input fuzz harness. Every generated case is
// derived from (campaign seed, case index) alone, so a single failing case
// replays without regenerating the cases before it.

/** cyrb128: 128-bit hash of a string → four 32-bit lanes (seed material). */
function cyrb128(input: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < input.length; i += 1) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** sfc32 — small fast counter generator; passes PractRand to 2^40+. */
export class Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly label: string) {
    const [a, b, c, d] = cyrb128(label);
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    for (let i = 0; i < 16; i += 1) this.nextU32();
  }

  nextU32(): number {
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
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    if (max < min) throw new RangeError(`int(${min}, ${max})`);
    return min + Math.floor(this.float() * (max - min + 1));
  }

  bool(probabilityTrue = 0.5): boolean {
    return this.float() < probabilityTrue;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick from empty list");
    return items[this.int(0, items.length - 1)];
  }

  /** Weighted choice: entries are [weight, value]. */
  weighted<T>(entries: ReadonlyArray<readonly [number, T]>): T {
    let total = 0;
    for (const [w] of entries) total += w;
    let roll = this.float() * total;
    for (const [w, value] of entries) {
      roll -= w;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1][1];
  }

  /** Fisher–Yates shuffle (copy). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Lower-case hex string of `length` nibbles. */
  hex(length: number): string {
    let out = "";
    while (out.length < length) out += this.nextU32().toString(16).padStart(8, "0");
    return out.slice(0, length);
  }

  /** RFC 4122 v4-shaped UUID (satisfies the edge function's UUID_RE). */
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${this.pick(["8", "9", "a", "b"])}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  /** Independent child generator for a sub-scope (never shares state). */
  fork(scope: string): Prng {
    return new Prng(`${this.label}/${scope}/${this.nextU32()}`);
  }
}

export const caseLabel = (seed: string, index: number): string => `fuzz-edge:${seed}:${index}`;
