import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Seed plumbing + evidence sink for `__tests__/stress/*`.
 *
 * - `STRESS_ITER`  iterations per scenario (default small so the suite stays
 *                  fast in CI; the campaign runs with a large value).
 * - `STRESS_SEED`  pin a single seed (replay a failing iteration exactly).
 * - `STRESS_RUN_ID` artifact directory name under `artifacts/stress/`.
 *
 * Each iteration appends one NDJSON line:
 *   { suite, scenario, seed, outcome: 'HELD'|'BROKEN'|'ERROR', durationMs,
 *     inputs, result|error }
 * `outcome` is derived only from the `ok` field the body returns (or a
 * throw) — the harness never decides on its own that something passed.
 */

export const DEFAULT_STRESS_ITER = 12;

export function stressIterations(): number {
  const raw = process.env['STRESS_ITER'];
  if (raw === undefined || raw === '') return DEFAULT_STRESS_ITER;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${raw}`);
  }
  return Math.floor(value);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic seed list for a scenario: index i → seed, replayable with
 * STRESS_SEED=<seed>. */
export function stressSeeds(scenario: string): number[] {
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') {
    const seed = Number(pinned);
    if (!Number.isInteger(seed)) {
      throw new Error(`STRESS_SEED must be an integer, got ${pinned}`);
    }
    return [seed >>> 0];
  }
  const base = fnv1a(scenario);
  const count = stressIterations();
  const seeds: number[] = [];
  for (let i = 0; i < count; i += 1) {
    seeds.push((base + Math.imul(i, 0x9e3779b1)) >>> 0);
  }
  return seeds;
}

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

export function randomInt(
  random: () => number,
  min: number,
  maxInclusive: number,
): number {
  return min + Math.floor(random() * (maxInclusive - min + 1));
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

export function shuffle<T>(random: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

const runId = process.env['STRESS_RUN_ID'] ?? `local-${process.pid}`;
const artifactDir = join(__dirname, '..', '..', 'artifacts', 'stress', runId);
let dirReady = false;

export function stressArtifactDir(): string {
  if (!dirReady) {
    mkdirSync(artifactDir, { recursive: true });
    dirReady = true;
  }
  return artifactDir;
}

function appendEvent(event: Record<string, unknown>): void {
  appendFileSync(
    join(stressArtifactDir(), 'events.ndjson'),
    `${JSON.stringify(event)}\n`,
  );
}

export interface StressResult {
  ok: boolean;
  [key: string]: unknown;
}

export async function recordStress<T extends StressResult>(
  suite: string,
  scenario: string,
  seed: number,
  inputs: Record<string, unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await body();
    appendEvent({
      suite,
      scenario,
      seed,
      outcome: result.ok ? 'HELD' : 'BROKEN',
      durationMs: Date.now() - started,
      inputs,
      result,
    });
    return result;
  } catch (error) {
    appendEvent({
      suite,
      scenario,
      seed,
      outcome: 'ERROR',
      durationMs: Date.now() - started,
      inputs,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
