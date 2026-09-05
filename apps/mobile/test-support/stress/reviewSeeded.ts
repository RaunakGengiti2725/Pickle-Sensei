import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Seeded randomized long-run harness shared by the review-model stress
 * suites (apps/mobile/__tests__/stress/*.seeded.test.ts).
 *
 * Every campaign iteration is ONE action sequence (length 5..60) derived
 * entirely from a 32-bit seed, so any outcome is replayable from
 * `<campaign>:<seed>` alone. A sequence HOLDS when every invariant passed
 * after every step, and is BROKEN when a step threw — the harness then
 * shrinks the failing prefix (smallest step count that still fails), re-runs
 * the seed 10× to measure flakiness, and runs every held seed a second time
 * to prove the trace is identical (determinism).
 *
 * Scale is controlled by the environment so the suite stays fast by default:
 *   STRESS_ITER   sequences per campaign (default 40; the full run uses 2000)
 *   STRESS_SEED   base seed (default 0x5eed); seed_i = base + i
 *   STRESS_OUT    directory to write `<campaign>.json` result tables into
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
  private readonly next01: () => number;

  constructor(readonly seed: number) {
    this.next01 = mulberry32(seed);
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.next01();
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next01() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next01() * (max - min);
  }

  chance(probability: number): boolean {
    return this.next01() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on an empty list');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Random subset keeping the source order; each item kept with `keep`. */
  subset<T>(items: readonly T[], keep: number): T[] {
    return items.filter(() => this.chance(keep));
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let index = out.length - 1; index > 0; index -= 1) {
      const swap = this.int(0, index);
      const held = out[index] as T;
      out[index] = out[swap] as T;
      out[swap] = held;
    }
    return out;
  }
}

export const MIN_SEQUENCE_LENGTH = 5;
export const MAX_SEQUENCE_LENGTH = 60;

/** Thrown by a step's invariant check; carries the step index for shrinking. */
export class InvariantViolation extends Error {
  constructor(
    message: string,
    readonly invariant: string,
    readonly step: number,
  ) {
    super(`[${invariant}] step ${step}: ${message}`);
    this.name = 'InvariantViolation';
  }
}

export function invariant(
  condition: boolean,
  name: string,
  step: number,
  detail: () => string,
): void {
  if (!condition) throw new InvariantViolation(detail(), name, step);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === 'number' && !Number.isFinite(entry)) {
      return `__nonfinite:${String(entry)}`;
    }
    if (entry === undefined) return '__undefined';
    if (entry instanceof Set) return [...entry].sort();
    if (entry instanceof Map) return [...entry.entries()];
    return entry;
  });
}

export interface StepTrace {
  step: number;
  action: string;
  [detail: string]: unknown;
}

export interface SequenceRun {
  /** Every executed step, in order (excluded from the JSON table). */
  trace: StepTrace[];
  /** The sequence length the seed drew (5..60). */
  length: number;
  /** Per-run counters the campaign aggregates (e.g. coverage tallies). */
  tallies?: Record<string, number>;
}

export interface CampaignSpec {
  name: string;
  /**
   * Runs the whole sequence for `seed`, stopping after `stepLimit` steps when
   * given (used by shrinking). Throws InvariantViolation on the first broken
   * invariant; any other throw is a crash and also counts as BROKEN.
   */
  run: (seed: number, stepLimit?: number) => Promise<SequenceRun> | SequenceRun;
  /** Extra per-seed determinism runs beyond the mandatory second run. */
  iterations?: number;
}

export interface SeedRecord {
  seed: number;
  length: number;
  steps: number;
  outcome: 'HELD' | 'BROKEN';
  determinism: 'identical' | 'MISMATCH' | 'n/a';
  error?: string;
  invariant?: string;
  failedAtStep?: number;
  minimized?: { seed: number; steps: number; error: string };
  flakyRate?: string;
}

export interface CampaignResult {
  campaign: string;
  seedBase: number;
  requested: number;
  executed: number;
  held: number;
  broken: number;
  determinismMismatches: number;
  totalSteps: number;
  lengthMin: number;
  lengthMax: number;
  durationMs: number;
  tallies: Record<string, number>;
  failures: SeedRecord[];
  seeds: SeedRecord[];
  outFile: string | null;
}

export function campaignConfig(): {
  iterations: number;
  seedBase: number;
  outDir: string | null;
} {
  const iter = Number.parseInt(process.env.STRESS_ITER ?? '', 10);
  const seed = Number.parseInt(process.env.STRESS_SEED ?? '', 10);
  const out = process.env.STRESS_OUT;
  return {
    iterations: Number.isFinite(iter) && iter > 0 ? iter : 40,
    seedBase: Number.isFinite(seed) ? seed >>> 0 : 0x5eed,
    outDir: out && out.length > 0 ? out : null,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Smallest step count in [1, steps] at which `seed` still fails. */
async function shrink(
  spec: CampaignSpec,
  seed: number,
  steps: number,
): Promise<{ seed: number; steps: number; error: string } | undefined> {
  let low = 1;
  let high = steps;
  let found: { steps: number; error: string } | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    try {
      await spec.run(seed, mid);
      low = mid + 1;
    } catch (error) {
      found = { steps: mid, error: describeError(error) };
      high = mid - 1;
    }
  }
  return found ? { seed, ...found } : undefined;
}

export async function runCampaign(spec: CampaignSpec): Promise<CampaignResult> {
  const config = campaignConfig();
  const requested = spec.iterations ?? config.iterations;
  const startedAt = Date.now();
  const seeds: SeedRecord[] = [];
  const tallies: Record<string, number> = {};
  let totalSteps = 0;
  let lengthMin = Number.POSITIVE_INFINITY;
  let lengthMax = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < requested; index += 1) {
    const seed = (config.seedBase + index) >>> 0;
    let record: SeedRecord;
    try {
      const first = await spec.run(seed);
      totalSteps += first.trace.length;
      lengthMin = Math.min(lengthMin, first.length);
      lengthMax = Math.max(lengthMax, first.length);
      for (const [key, value] of Object.entries(first.tallies ?? {})) {
        tallies[key] = (tallies[key] ?? 0) + value;
      }
      const second = await spec.run(seed);
      const identical =
        stableJson(first.trace) === stableJson(second.trace) &&
        first.length === second.length;
      record = {
        seed,
        length: first.length,
        steps: first.trace.length,
        outcome: identical ? 'HELD' : 'BROKEN',
        determinism: identical ? 'identical' : 'MISMATCH',
        ...(identical
          ? {}
          : {
              error:
                'determinism: second run of the same seed produced a different trace',
              invariant: 'determinism',
            }),
      };
    } catch (error) {
      const failedAtStep =
        error instanceof InvariantViolation ? error.step : undefined;
      const stepsGuess = failedAtStep ?? MAX_SEQUENCE_LENGTH;
      totalSteps += stepsGuess;
      const minimized = await shrink(spec, seed, stepsGuess);
      let failures = 0;
      for (let rerun = 0; rerun < 10; rerun += 1) {
        try {
          await spec.run(seed);
        } catch {
          failures += 1;
        }
      }
      record = {
        seed,
        length: stepsGuess,
        steps: stepsGuess,
        outcome: 'BROKEN',
        determinism: 'n/a',
        error: describeError(error),
        invariant:
          error instanceof InvariantViolation ? error.invariant : 'crash',
        failedAtStep,
        minimized,
        flakyRate: `${failures}/10`,
      };
    }
    seeds.push(record);
  }

  const failures = seeds.filter(record => record.outcome === 'BROKEN');
  const result: CampaignResult = {
    campaign: spec.name,
    seedBase: config.seedBase,
    requested,
    executed: seeds.length,
    held: seeds.length - failures.length,
    broken: failures.length,
    determinismMismatches: seeds.filter(
      record => record.determinism === 'MISMATCH',
    ).length,
    totalSteps,
    lengthMin: Number.isFinite(lengthMin) ? lengthMin : 0,
    lengthMax: Number.isFinite(lengthMax) ? lengthMax : 0,
    durationMs: Date.now() - startedAt,
    tallies,
    failures,
    seeds,
    outFile: null,
  };

  if (config.outDir) {
    mkdirSync(config.outDir, { recursive: true });
    const outFile = join(config.outDir, `${spec.name}.json`);
    result.outFile = outFile;
    writeFileSync(outFile, JSON.stringify(result, null, 2));
  }
  return result;
}

/** Sequence length for a seed: the first draw, so shrinking never shifts it. */
export function drawLength(rng: Rng): number {
  return rng.int(MIN_SEQUENCE_LENGTH, MAX_SEQUENCE_LENGTH);
}

/** Store-facing copy the dossier forbids anywhere user-visible. */
export const FORBIDDEN_COPY = [
  'Android',
  'Google Play',
  'guest mode',
  'Live Court',
  'DUPR',
  'SwingVision',
  'PB Vision',
  'Selkirk',
  'JOOLA',
  '%',
] as const;

export function forbiddenCopyIn(text: string): string | null {
  const lower = text.toLowerCase();
  for (const term of FORBIDDEN_COPY) {
    if (lower.includes(term.toLowerCase())) return term;
  }
  return null;
}
