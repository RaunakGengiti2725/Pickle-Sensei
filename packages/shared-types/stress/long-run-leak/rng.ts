/**
 * Seeded PRNG for the long-run-leak stress harness. Every generated input is
 * a pure function of the 32-bit seed, so any iteration is replayable from the
 * seed recorded in the results table. splitmix32 core (deterministic, no
 * platform dependence).
 */
export interface Rng {
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates shuffle into a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Lowercase alphanumeric-ish string of the given length. */
  word(length: number): string;
  /** RFC-4122-shaped v4 uuid built from the stream. */
  uuid(): string;
  /** ISO-8601 timestamp between 2024-01-01 and 2027-01-01 (ms precision). */
  isoDate(): string;
}

export function mixSeed(base: number, index: number): number {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const WORD_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const EPOCH_START = Date.UTC(2024, 0, 1);
const EPOCH_END = Date.UTC(2027, 0, 1);

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error("rng.pick on empty list");
    return items[int(0, items.length - 1)] as T;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  };
  const word = (length: number): string => {
    let s = "";
    for (let i = 0; i < length; i += 1) s += WORD_ALPHABET[int(0, WORD_ALPHABET.length - 1)];
    return s;
  };
  const hex = (n: number): string => {
    let s = "";
    for (let i = 0; i < n; i += 1) s += HEX[int(0, 15)];
    return s;
  };
  const uuid = (): string =>
    `${hex(8)}-${hex(4)}-4${hex(3)}-${HEX[8 + int(0, 3)]}${hex(3)}-${hex(12)}`;
  const isoDate = (): string =>
    new Date(EPOCH_START + Math.floor(next() * (EPOCH_END - EPOCH_START))).toISOString();
  return {
    seed,
    next,
    int,
    chance: (p) => next() < p,
    pick,
    shuffle,
    word,
    uuid,
    isoDate,
  };
}
