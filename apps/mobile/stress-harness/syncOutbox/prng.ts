/**
 * Seeded randomness for the outbox concurrency stress campaign.
 *
 * Every decision the harness makes (scenario shape, server verdicts, yield
 * counts between statements/requests) is drawn from ONE mulberry32 stream
 * per seed, so a row of the emitted seed→outcome table is replayable with
 * nothing but its seed (`STRESS_SEED_ONLY=<seed>`).
 */
export type Prng = () => number;

export function makePrng(seed: number): Prng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [min, max] (inclusive). */
export function int(rng: Prng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function chance(rng: Prng, probability: number): boolean {
  return rng() < probability;
}

export function pick<T>(rng: Prng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

/** Weighted pick: `[[item, weight], ...]`. */
export function weighted<T>(rng: Prng, table: ReadonlyArray<[T, number]>): T {
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [item, w] of table) {
    roll -= w;
    if (roll < 0) return item;
  }
  return table[table.length - 1]![0];
}

export function shuffle<T>(rng: Prng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Deterministic RFC-4122-shaped id (lowercase, version nibble 4). */
export function uuid(rng: Prng): string {
  const hex = () => Math.floor(rng() * 16).toString(16);
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    if (i === 12) out += '4';
    else if (i === 16) out += pick(rng, ['8', '9', 'a', 'b']);
    else out += hex();
    if (i === 7 || i === 11 || i === 15 || i === 19) out += '-';
  }
  return out;
}
