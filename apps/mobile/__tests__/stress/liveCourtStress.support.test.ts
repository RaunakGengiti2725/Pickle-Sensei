/**
 * Shared support for the live-court CONCURRENCY stress campaign
 * (`__tests__/stress/liveCourt*.stress.test.ts`, `liveSession*.stress.test.ts`).
 *
 * Everything here is deterministic: a seeded RNG (mulberry32) drives a
 * SeededScheduler that releases in-flight provider promises in a seeded
 * order, so every interleaving is replayable from `(campaign seed, index)`.
 *
 * Campaign knobs (all environment variables, none required):
 *   STRESS_ITER        iterations per campaign (default small so the suite
 *                      stays fast; the full run uses 500+)
 *   STRESS_SEED        base seed (default 1); iteration i uses base + i
 *   STRESS_RESULTS_DIR when set, each campaign writes `<name>.json`
 *                      (seed → outcome table) into this directory
 *   STRESS_REPLAY_SEED replay exactly one seed (minimization / flake re-run)
 *
 * Jest treats every file under __tests__ as a suite, so this module carries
 * its own (guarded) self-tests: they register only when this file is the one
 * being executed, not when another suite imports the helpers.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32 — small, fast, full-period 32-bit generator. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(lo, hi) {
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick(items) {
      if (items.length === 0) throw new Error('pick() on empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const tmp = copy[i] as (typeof items)[number];
        copy[i] = copy[j] as (typeof items)[number];
        copy[j] = tmp;
      }
      return copy;
    },
  };
}

// ─── Seeded scheduler ───────────────────────────────────────────────────────

/** Lets every pending microtask/continuation run (setImmediate is a macrotask,
 * so the whole microtask queue drains first). */
export function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

interface Gate {
  id: number;
  label: string;
  release: () => void;
}

/**
 * Holds promises until `drain()` releases them one at a time in a seeded
 * order. Continuations that create new gates (call-during-call) are picked
 * up on the next step, so any interleaving of the async graph is reachable
 * and the sequence of released gate labels is the replayable trace.
 */
export class SeededScheduler {
  private readonly pending: Gate[] = [];
  private nextId = 0;
  readonly trace: string[] = [];

  constructor(private readonly rng: Rng) {}

  /** Defers `work` until the scheduler releases this gate. Rejections from
   * `work` propagate to the caller exactly like a failing provider would. */
  gate<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      this.pending.push({
        id,
        label,
        release: () => {
          try {
            resolve(work());
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Releases gates in seeded order until none remain (including gates that
   * appear while draining). `onStep` runs after every release + microtask
   * flush so a scenario can inject work mid-flight. Returns the step count.
   * Bounded by `maxSteps` — exceeding it is reported as a livelock.
   */
  async drain(
    options: {
      maxSteps?: number;
      onStep?: (step: number) => void | Promise<void>;
    } = {},
  ): Promise<number> {
    const maxSteps = options.maxSteps ?? 100_000;
    let steps = 0;
    // Let synchronously-started work reach its first gate.
    await flushMicrotasks();
    while (this.pending.length > 0) {
      if (steps >= maxSteps) {
        throw new Error(
          `scheduler livelock: ${steps} steps, ${this.pending.length} still pending`,
        );
      }
      const index = Math.floor(this.rng.next() * this.pending.length);
      const [gate] = this.pending.splice(index, 1) as [Gate];
      this.trace.push(`${gate.id}:${gate.label}`);
      gate.release();
      steps += 1;
      await flushMicrotasks();
      if (options.onStep) await options.onStep(steps);
      await flushMicrotasks();
    }
    return steps;
  }
}

// ─── Wall-time bound (deadlock detector) ────────────────────────────────────

export class DeadlineExceeded extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: did not settle within ${ms}ms (possible deadlock)`);
    this.name = 'DeadlineExceeded';
  }
}

export async function withDeadline<T>(
  label: string,
  ms: number,
  promise: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ─── Campaign plumbing ──────────────────────────────────────────────────────

function envInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got '${raw}'`);
  }
  return value;
}

/** The seeds a campaign runs: STRESS_REPLAY_SEED alone, or
 * STRESS_SEED .. STRESS_SEED + STRESS_ITER - 1 (STRESS_ITER defaults to
 * `defaultIterations`). */
export function campaignSeeds(defaultIterations: number): number[] {
  const replay = envInt('STRESS_REPLAY_SEED');
  if (replay !== null) return [replay];
  const iterations = envInt('STRESS_ITER') ?? defaultIterations;
  const base = envInt('STRESS_SEED') ?? 1;
  return Array.from({ length: iterations }, (_, i) => base + i);
}

export type Outcome = 'HELD' | 'BROKEN';

export interface SeedResult {
  seed: number;
  outcome: Outcome;
  /** Distinct invariant ids that failed for this seed (empty when HELD). */
  violated: string[];
  /** Human-readable violation details (first few). */
  details: string[];
  /** Scenario-specific counters (events, steps, …). */
  counters: Record<string, number>;
  /** Scheduler trace (release order) — the replayable interleaving. */
  trace?: string[];
  durationMs: number;
}

/** Collects `<invariant id> → message` violations for one seed. */
export class Violations {
  private readonly byInvariant = new Map<string, string[]>();

  check(invariant: string, ok: boolean, message: () => string): void {
    if (ok) return;
    const list = this.byInvariant.get(invariant) ?? [];
    list.push(message());
    this.byInvariant.set(invariant, list);
  }

  fail(invariant: string, message: string): void {
    this.check(invariant, false, () => message);
  }

  ids(): string[] {
    return [...this.byInvariant.keys()].sort();
  }

  messages(limit = 6): string[] {
    const out: string[] = [];
    for (const [id, list] of this.byInvariant) {
      for (const message of list) {
        if (out.length >= limit) return out;
        out.push(`[${id}] ${message}`);
      }
    }
    return out;
  }
}

export interface CampaignSummary {
  campaign: string;
  seeds: number;
  held: number;
  broken: number;
  /** Total per-seed counters, summed (e.g. events, interleavingSteps). */
  totals: Record<string, number>;
  /** invariant id → seeds that violated it. */
  violationsByInvariant: Record<string, number[]>;
  results: SeedResult[];
}

export class ResultsTable {
  private readonly results: SeedResult[] = [];

  constructor(private readonly campaign: string) {}

  record(result: SeedResult): void {
    this.results.push(result);
  }

  seedsViolating(invariant: string): number[] {
    return this.results
      .filter(result => result.violated.includes(invariant))
      .map(result => result.seed);
  }

  total(counter: string): number {
    return this.results.reduce(
      (sum, result) => sum + (result.counters[counter] ?? 0),
      0,
    );
  }

  summary(): CampaignSummary {
    const totals: Record<string, number> = {};
    const violationsByInvariant: Record<string, number[]> = {};
    for (const result of this.results) {
      for (const [key, value] of Object.entries(result.counters)) {
        totals[key] = (totals[key] ?? 0) + value;
      }
      for (const id of result.violated) {
        (violationsByInvariant[id] ??= []).push(result.seed);
      }
    }
    return {
      campaign: this.campaign,
      seeds: this.results.length,
      held: this.results.filter(result => result.outcome === 'HELD').length,
      broken: this.results.filter(result => result.outcome === 'BROKEN').length,
      totals,
      violationsByInvariant,
      results: this.results,
    };
  }

  /** Writes `<STRESS_RESULTS_DIR>/<campaign>.json` when the directory is set;
   * returns the path (or null when not writing). */
  write(): string | null {
    const dir = process.env['STRESS_RESULTS_DIR'];
    if (!dir) return null;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.campaign}.json`);
    writeFileSync(path, JSON.stringify(this.summary(), null, 2));
    return path;
  }
}

/** Formats the failing seeds of one invariant for an assertion message. */
export function describeViolations(
  table: ResultsTable,
  invariant: string,
): string {
  const seeds = table.seedsViolating(invariant);
  if (seeds.length === 0) return `${invariant}: held on every seed`;
  const sample = table
    .summary()
    .results.filter(result => result.violated.includes(invariant))
    .slice(0, 3)
    .map(
      result =>
        `seed ${result.seed}: ${result.details
          .filter(detail => detail.startsWith(`[${invariant}]`))
          .slice(0, 2)
          .join(' | ')}`,
    );
  return (
    `${invariant} BROKEN on ${seeds.length} seed(s) [${seeds.slice(0, 12).join(', ')}` +
    `${seeds.length > 12 ? ', …' : ''}] — replay with STRESS_REPLAY_SEED=<seed>\n` +
    sample.join('\n')
  );
}

/** Stable, key-sorted JSON so two runs of the same seed can be compared
 * byte-for-byte. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const record = inner as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key];
          return acc;
        }, {});
    }
    if (typeof inner === 'number' && !Number.isFinite(inner))
      return `<${String(inner)}>`;
    return inner;
  });
}

/** Human-readable pointer at the first byte where two canonical strings
 * diverge (with context) — for violation messages. */
export function firstDifference(a: string, b: string, context = 80): string {
  if (a === b) return 'identical';
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const from = Math.max(0, i - context);
  return `@${i}: …${a.slice(from, i + context)}… vs …${b.slice(from, i + context)}…`;
}

// ─── Self-tests (only when this file is the suite under execution) ─────────

const thisFile = 'liveCourtStress.support.test.ts';
const isSelfRun = (expect.getState().testPath ?? '').endsWith(thisFile);

if (isSelfRun) {
  describe('stress support: seeded RNG', () => {
    it('replays byte-identical sequences from the same seed', () => {
      const a = mulberry32(42);
      const b = mulberry32(42);
      const seqA = Array.from({ length: 1000 }, () => a.next());
      const seqB = Array.from({ length: 1000 }, () => b.next());
      expect(seqA).toEqual(seqB);
      expect(new Set(seqA).size).toBeGreaterThan(990);
    });

    it('int() stays inside the inclusive bounds and shuffle() is a permutation', () => {
      const rng = mulberry32(7);
      for (let i = 0; i < 10_000; i += 1) {
        const v = rng.int(3, 9);
        expect(v).toBeGreaterThanOrEqual(3);
        expect(v).toBeLessThanOrEqual(9);
      }
      const items = Array.from({ length: 50 }, (_, i) => i);
      const shuffled = rng.shuffle(items);
      expect([...shuffled].sort((x, y) => x - y)).toEqual(items);
      expect(items).toEqual(Array.from({ length: 50 }, (_, i) => i));
    });
  });

  describe('stress support: seeded scheduler', () => {
    it('releases gates in a seed-determined order and picks up gates created mid-drain', async () => {
      const run = async (seed: number): Promise<string[]> => {
        const scheduler = new SeededScheduler(mulberry32(seed));
        const order: string[] = [];
        const tasks = ['a', 'b', 'c', 'd'].map(label =>
          scheduler.gate(label, async () => {
            order.push(label);
            // call-during-call: a continuation that opens a new gate
            await scheduler.gate(`${label}2`, () => order.push(`${label}2`));
          }),
        );
        const steps = await scheduler.drain();
        await Promise.all(tasks);
        expect(steps).toBe(8);
        return order;
      };
      const first = await run(11);
      const second = await run(11);
      const other = await run(12);
      expect(first).toEqual(second);
      expect(first).toHaveLength(8);
      expect(first).not.toEqual(other);
    });

    it('propagates rejections to the gated caller only', async () => {
      const scheduler = new SeededScheduler(mulberry32(3));
      const good = scheduler.gate('ok', () => 1);
      const bad = scheduler.gate('boom', () => {
        throw new Error('provider exploded');
      });
      const settled = Promise.allSettled([good, bad]);
      await scheduler.drain();
      const [goodResult, badResult] = await settled;
      expect(goodResult).toEqual({ status: 'fulfilled', value: 1 });
      expect(badResult.status).toBe('rejected');
      expect((badResult as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      expect(
        ((badResult as PromiseRejectedResult).reason as Error).message,
      ).toBe('provider exploded');
    });

    it('withDeadline flags a never-settling promise instead of hanging', async () => {
      await expect(
        withDeadline('hang', 20, new Promise<never>(() => {})),
      ).rejects.toBeInstanceOf(DeadlineExceeded);
      await expect(
        withDeadline('fast', 1000, Promise.resolve('x')),
      ).resolves.toBe('x');
    });
  });

  describe('stress support: campaign plumbing', () => {
    it('canonicalJson is key-order independent', () => {
      expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toBe(
        canonicalJson({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }),
      );
    });

    it('ResultsTable aggregates seeds, totals and violations', () => {
      const table = new ResultsTable('unit');
      table.record({
        seed: 1,
        outcome: 'HELD',
        violated: [],
        details: [],
        counters: { events: 3 },
        durationMs: 1,
      });
      table.record({
        seed: 2,
        outcome: 'BROKEN',
        violated: ['I1'],
        details: ['[I1] nope'],
        counters: { events: 4 },
        durationMs: 1,
      });
      const summary = table.summary();
      expect(summary.held).toBe(1);
      expect(summary.broken).toBe(1);
      expect(summary.totals['events']).toBe(7);
      expect(summary.violationsByInvariant).toEqual({ I1: [2] });
      expect(table.seedsViolating('I1')).toEqual([2]);
      expect(describeViolations(table, 'I1')).toContain('seed 2');
    });
  });
}
