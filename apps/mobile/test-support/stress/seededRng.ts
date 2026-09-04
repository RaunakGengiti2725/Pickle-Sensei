/**
 * Seeded PRNG + helpers shared by the consistency stress suites. Every
 * campaign iteration derives its own stream from `(campaignSeed, index)` so
 * a single failing sequence replays from its seed alone.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    if (hi < lo) return lo;
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Picks by integer weight; `weights[i]` belongs to `items[i]`. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const weight of weights) total += weight;
    let roll = this.next() * total;
    for (let index = 0; index < items.length; index += 1) {
      roll -= weights[index] ?? 0;
      if (roll < 0) return items[index]!;
    }
    return items[items.length - 1]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }
}

/** Stable per-iteration seed: mixes the campaign seed with the index. */
export function iterationSeed(campaignSeed: number, index: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** FNV-1a over a string — cheap trace fingerprint for determinism checks. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** JSON with object keys sorted at every level (byte-stable comparisons). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortKeys(record[key]);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return `__nonfinite:${String(value)}`;
  }
  return value;
}

/**
 * ddmin-style shrinker: removes chunks of `items` while `stillFails` holds,
 * returning a 1-minimal subsequence. Bounded by `maxProbes` evaluations.
 */
export function minimizeSequence<T>(
  items: readonly T[],
  stillFails: (candidate: readonly T[]) => boolean,
  maxProbes = 400,
): { minimized: T[]; probes: number } {
  let current = [...items];
  let probes = 0;
  let chunk = Math.max(1, Math.floor(current.length / 2));
  while (chunk >= 1 && probes < maxProbes) {
    let removedAny = false;
    for (let start = 0; start < current.length && probes < maxProbes;) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      probes += 1;
      if (candidate.length < current.length && stillFails(candidate)) {
        current = candidate;
        removedAny = true;
      } else {
        start += chunk;
      }
    }
    if (!removedAny) {
      if (chunk === 1) break;
      chunk = Math.floor(chunk / 2);
    }
  }
  return { minimized: current, probes };
}

// Node built-ins for artifacts. The mobile tsconfig excludes node typings, so
// the shims stay local (same pattern as __tests__/matrix).
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };

const fs = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const path = require('path') as { join: (...parts: string[]) => string };

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envString(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

export function writeArtifact(
  outDir: string,
  fileName: string,
  payload: unknown,
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, fileName);
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  return target;
}

export function joinPath(...parts: string[]): string {
  return path.join(...parts);
}
