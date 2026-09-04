/**
 * Seeded interleaving scheduler for concurrency stress tests.
 *
 * Every asynchronous hop a stressed module performs (a kv read, a kv write,
 * a fetch) is routed through `scheduler.hop()`. The hop parks the caller's
 * continuation; `drain()` then releases parked continuations ONE AT A TIME in
 * an order drawn from a seeded PRNG, waiting for the released continuation to
 * run (and park again, or finish) before choosing the next one. Actor steps
 * (owner rotation, dismiss, walkthrough toggles) are parked the same way, so
 * the schedule decides whether "logout" lands before or after a particular
 * kv write. Replaying a seed replays the exact same interleaving.
 *
 * `drain()` also detects deadlock: if nothing is parked but tracked promises
 * are still unsettled, the run is stuck (a continuation is waiting on
 * something the scheduler will never release) and drain rejects rather than
 * hanging jest. Wall time is bounded by `maxWallMs`.
 */

declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
declare function setImmediate(callback: () => void): unknown;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SeededRng {
  private readonly next: () => number;

  constructor(public readonly seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() on empty list');
    return items[this.int(0, items.length - 1)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const tmp = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = tmp;
    }
    return copy;
  }
}

interface Parked {
  label: string;
  release: () => void;
}

const settleTick = (): Promise<void> =>
  new Promise(resolve => setImmediate(resolve));

export class SeededScheduler {
  readonly rng: SeededRng;
  private parked: Parked[] = [];
  private tracked = 0;
  private settled = 0;
  private readonly trace: string[] = [];
  private hops = 0;

  constructor(seed: number) {
    this.rng = new SeededRng(seed);
  }

  /** Park the caller until the schedule releases it. */
  hop(label = 'hop'): Promise<void> {
    this.hops += 1;
    return new Promise<void>(resolve => {
      this.parked.push({ label, release: resolve });
    });
  }

  /** A promise the drain must see settle before declaring the run complete. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.tracked += 1;
    const done = () => {
      this.settled += 1;
    };
    promise.then(done, done);
    return promise;
  }

  /** Enqueue an actor step (runs when the schedule picks it). */
  step(label: string, action: () => void | Promise<void>): Promise<void> {
    return this.track(
      (async () => {
        await this.hop(label);
        await action();
      })(),
    );
  }

  get hopCount(): number {
    return this.hops;
  }

  /** Ordered labels of every released continuation — the replayable schedule. */
  get schedule(): readonly string[] {
    return this.trace;
  }

  /**
   * Release parked continuations in seeded order until everything tracked has
   * settled. Rejects on deadlock (nothing parked, work outstanding) or when
   * the wall-time budget is exceeded.
   */
  async drain(maxWallMs = 5000): Promise<void> {
    const startedAt = Date.now();
    // Let synchronously started work reach its first hop.
    await settleTick();
    for (;;) {
      if (Date.now() - startedAt > maxWallMs) {
        throw new Error(
          `scheduler wall-time budget exceeded (${maxWallMs}ms) after ${this.trace.length} releases; parked=${this.parked.map(p => p.label).join(',')}`,
        );
      }
      if (this.parked.length === 0) {
        if (this.settled >= this.tracked) return;
        // Give any trailing microtasks a chance before declaring deadlock.
        await settleTick();
        await settleTick();
        if (this.parked.length === 0) {
          if (this.settled >= this.tracked) return;
          throw new Error(
            `scheduler deadlock: ${this.tracked - this.settled} tracked promise(s) unsettled with nothing parked; schedule=${this.trace.join('>')}`,
          );
        }
        continue;
      }
      const index = this.rng.int(0, this.parked.length - 1);
      const [next] = this.parked.splice(index, 1) as [Parked];
      this.trace.push(next.label);
      next.release();
      // Run the released continuation until it parks again or finishes.
      await settleTick();
    }
  }
}

/** Iteration count: STRESS_ITER overrides the default when set to a positive integer. */
export function stressIterations(defaultCount: number): number {
  const raw = process.env['STRESS_ITER'];
  if (raw === undefined || raw === '') return defaultCount;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${raw}`);
  }
  return parsed;
}

/** Base seed: STRESS_SEED replays a campaign from a chosen starting point. */
export function stressBaseSeed(defaultSeed: number): number {
  const raw = process.env['STRESS_SEED'];
  if (raw === undefined || raw === '') return defaultSeed;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`STRESS_SEED must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

/** Optional JSON results table (seed → outcome) for evidence uploads. */
export function writeStressReport(
  fileName: string,
  report: unknown,
): string | null {
  const dir = process.env['STRESS_REPORT_DIR'];
  if (!dir) return null;
  const { mkdirSync, writeFileSync } = require('fs') as {
    mkdirSync: (path: string, options: { recursive: boolean }) => void;
    writeFileSync: (path: string, data: string) => void;
  };
  const { join } = require('path') as { join: (...parts: string[]) => string };
  mkdirSync(dir, { recursive: true });
  const target = join(dir, fileName);
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  return target;
}
