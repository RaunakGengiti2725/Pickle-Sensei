/**
 * Seeded, replayable evidence for the `__tests__/stress/` campaigns.
 *
 * Scale: `STRESS_ITER` seeds per fault case (default 1 — one fault of every
 * kind runs in the normal suite). Replay: `STRESS_SEED=<n>` pins the seed
 * for every case, `STRESS_CASE=<a.b,c.d>` runs only those cases and
 * `STRESS_REPEAT=<n>` re-runs each seed n times (flake rate). Every
 * scenario appends one JSON row to
 * `artifacts/stress/<suite>/<STRESS_RUN_ID>/results.ndjson` (repo-root
 * relative) — the seed → outcome table the campaign report is built from.
 *
 * Node built-ins are declared locally (the mobile tsconfig has no node
 * typings), same convention as testing/xcBehavioral/evidence.ts.
 */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export type Verdict = 'HELD' | 'BROKEN';

export interface StressRow {
  suite: string;
  /** `<dependency>.<mode>` — the fault case. */
  case: string;
  seed: number;
  /** The exact seed-derived plan, enough to replay by hand. */
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  /** Invariants that did not hold (empty when HELD). */
  broken: string[];
  verdict: Verdict;
  durationMs: number;
  atIso: string;
}

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

function repoRoot(): string {
  // apps/mobile/testing/stress → repo root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function stressArtifactDir(suite: string): string {
  return path.join(repoRoot(), 'artifacts', 'stress', suite, RUN_ID);
}

export function appendStressRow(row: StressRow): void {
  const dir = stressArtifactDir(row.suite);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, 'results.ndjson'),
    `${JSON.stringify(row)}\n`,
  );
}

export function writeStressArtifact(
  suite: string,
  name: string,
  data: string,
): string {
  const dir = stressArtifactDir(suite);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

/** mulberry32 — deterministic, replayable from the 32-bit seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(random: () => number, min: number, max: number) {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick from empty list');
  // `undefined` is a legitimate payload to pick (e.g. a resolve-with-nothing
  // fault), so index by bounds rather than by value.
  return items[Math.floor(random() * items.length)] as T;
}

export function shuffle<T>(random: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** Seeds for one fault case: the pinned `STRESS_SEED`, otherwise
 * `STRESS_ITER` deterministic seeds derived from the case name. Each seed is
 * repeated `STRESS_REPEAT` times (default 1) for flakiness-rate runs. */
export function caseSeeds(caseName: string): number[] {
  const pinned = process.env['STRESS_SEED'];
  const repeat = Math.max(1, Number(process.env['STRESS_REPEAT'] ?? '1'));
  const seeds: number[] = [];
  if (pinned !== undefined && pinned !== '') {
    seeds.push(Number(pinned));
  } else {
    const iterations = Math.max(1, Number(process.env['STRESS_ITER'] ?? '1'));
    const base = fnv1a(caseName);
    for (let i = 0; i < iterations; i += 1) {
      seeds.push((base + i * 7919) >>> 0);
    }
  }
  return seeds.flatMap(seed => Array<number>(repeat).fill(seed));
}

/** `STRESS_CASE` filter: run only those `<dependency>.<mode>` names (or
 * prefixes), comma-separated. */
export function caseSelected(caseName: string): boolean {
  const only = process.env['STRESS_CASE'];
  if (only === undefined || only === '') return true;
  return only
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '')
    .some(name => caseName === name || caseName.startsWith(`${name}.`));
}
