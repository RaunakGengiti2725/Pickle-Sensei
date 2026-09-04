/**
 * Seeded cooperative scheduler for the SQLite concurrency stress suites.
 *
 * Every `await db.execute()` the production code performs passes through the
 * op-sqlite seam, which calls `yieldPoint()` before AND after touching the
 * engine. The number of microtask ticks (or one macrotask hop) inserted at
 * each point is drawn from a mulberry32 stream, so the interleaving of any
 * set of concurrent actors is a pure function of the seed: the same seed
 * always replays the same statement order (`trace`), which the suite checks
 * by hashing the trace of a re-run.
 *
 * Node's event loop is deterministic when nothing real is in flight
 * (node:sqlite is synchronous), which is what makes the replay exact.
 */
import { makePrng } from '../../xc-harness/lifecycle-persistence/seeds';

export interface SchedulerOptions {
  /** Upper bound (inclusive) of microtask ticks inserted per yield point. */
  maxMicroTicks: number;
  /** Probability [0,1] that a yield point hops to the next macrotask turn. */
  macroHopProbability: number;
}

export interface Scheduler {
  readonly seed: number;
  readonly options: SchedulerOptions;
  /** Statement/actor trace in the order the engine saw them. */
  readonly trace: string[];
  /** Number of yield points that were driven. */
  readonly yields: number;
  yieldPoint(tag: string): Promise<void>;
  /** Independent stream derived from the scheduler seed (for input data). */
  rng(): number;
  record(entry: string): void;
}

export function makeScheduler(
  seed: number,
  options: SchedulerOptions,
): Scheduler {
  const scheduleRng = makePrng(seed);
  const dataRng = makePrng((seed ^ 0x9e3779b9) >>> 0);
  const trace: string[] = [];
  let yields = 0;
  return {
    seed,
    options,
    trace,
    get yields() {
      return yields;
    },
    async yieldPoint(tag: string) {
      yields += 1;
      const r = scheduleRng();
      if (options.macroHopProbability > 0 && r < options.macroHopProbability) {
        trace.push(`~${tag}`);
        await new Promise<void>(resolve => setImmediate(resolve));
        return;
      }
      const ticks = Math.floor(scheduleRng() * (options.maxMicroTicks + 1));
      for (let i = 0; i < ticks; i += 1) {
        await Promise.resolve();
      }
    },
    rng: dataRng,
    record(entry: string) {
      trace.push(entry);
    },
  };
}

/** A scheduler that never yields: the sequential control for any campaign. */
export function makeSerialScheduler(seed: number): Scheduler {
  return makeScheduler(seed, { maxMicroTicks: 0, macroHopProbability: 0 });
}

/** FNV-1a over the trace so two runs can be compared without storing both. */
export function traceHash(trace: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const entry of trace) {
    for (let i = 0; i < entry.length; i += 1) {
      hash ^= entry.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Bounded wait: resolves with the settled results, or reports a deadlock when
 * the actors did not all settle within `wallMs`. Never throws, so the caller
 * can still snapshot the database state after a hang.
 */
export async function settleWithin<T>(
  actors: Promise<T>[],
  wallMs: number,
): Promise<{
  deadlocked: boolean;
  results: PromiseSettledResult<T>[] | null;
  elapsedMs: number;
}> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), wallMs);
  });
  const outcome = await Promise.race([Promise.allSettled(actors), timeout]);
  if (timer !== null) clearTimeout(timer);
  const elapsedMs = Date.now() - started;
  if (outcome === 'timeout') {
    return { deadlocked: true, results: null, elapsedMs };
  }
  return { deadlocked: false, results: outcome, elapsedMs };
}
