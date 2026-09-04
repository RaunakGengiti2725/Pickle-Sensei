/**
 * Seeded cooperative scheduler for concurrency stress tests.
 *
 * Every async seam the unit under test crosses (sidecar read, permit HTTP,
 * each SQL statement) awaits `scheduler.yieldAt(label)`. The scheduler then
 * decides — from a seeded RNG — which of the currently blocked continuations
 * runs next, so a burst of `Promise.all` calls explores a different but
 * fully replayable interleaving per seed.
 *
 * Bounded: a run fails with `StressDeadlock` when no continuation is runnable
 * while tasks are still pending, when the step budget is exceeded, or when
 * the wall-clock budget is exceeded — a hang can never stall the suite.
 */
import { seededRandom } from '../xcBehavioral/evidence';

export class StressDeadlock extends Error {
  constructor(
    message: string,
    readonly trace: readonly string[],
  ) {
    super(message);
    this.name = 'StressDeadlock';
  }
}

interface Waiter {
  label: string;
  resolve: () => void;
}

export interface SchedulerRun<T> {
  results: PromiseSettledResult<T>[];
  /** Labels in the order the scheduler released them — the interleaving. */
  trace: string[];
  steps: number;
  wallMs: number;
}

export interface StressScheduler {
  readonly seed: number;
  /** Seeded RNG in [0, 1) shared with scenario-level choices. */
  random(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Block until the scheduler releases this continuation. */
  yieldAt(label: string): Promise<void>;
  /** Number of continuations currently parked. */
  parked(): number;
  /** Labels of parked continuations (diagnostics). */
  parkedLabels(): string[];
  /**
   * Run `tasks` concurrently under the scheduler until every one settles.
   * Tasks are started together (Promise.allSettled burst) and then stepped
   * one released continuation at a time.
   */
  run<T>(tasks: ReadonlyArray<() => Promise<T>>): Promise<SchedulerRun<T>>;
  /**
   * Register an extra actor that fires when the scheduler releases it (used
   * for "logout during request", "second actor joins mid-call", …). The
   * hook is parked like any other continuation and competes for a slot.
   */
  injectActor(label: string, act: () => void | Promise<void>): void;
}

export interface SchedulerOptions {
  maxSteps?: number;
  maxWallMs?: number;
}

const settleMicrotasks = (): Promise<void> =>
  new Promise<void>(resolve => setImmediate(resolve));

export function createScheduler(
  seed: number,
  options: SchedulerOptions = {},
): StressScheduler {
  const random = seededRandom(seed);
  const maxSteps = options.maxSteps ?? 5000;
  const maxWallMs = options.maxWallMs ?? 15_000;
  const waiters: Waiter[] = [];
  const trace: string[] = [];
  const pendingActors: Array<{
    label: string;
    act: () => void | Promise<void>;
  }> = [];
  let running = false;
  const actorSettles: Promise<void>[] = [];

  const int = (min: number, max: number): number =>
    min + Math.floor(random() * (max - min + 1));

  const scheduler: StressScheduler = {
    seed,
    random,
    int,
    pick(items) {
      if (items.length === 0) throw new Error('pick() on empty list');
      return items[int(0, items.length - 1)]!;
    },
    yieldAt(label) {
      if (!running) return Promise.resolve();
      return new Promise<void>(resolve => {
        waiters.push({ label, resolve });
      });
    },
    parked: () => waiters.length,
    parkedLabels: () => waiters.map(w => w.label),
    injectActor(label, act) {
      pendingActors.push({ label, act });
    },
    async run(tasks) {
      running = true;
      const startedAt = Date.now();
      let steps = 0;
      let settledCount = 0;
      const promises = tasks.map(task =>
        Promise.resolve()
          .then(task)
          .finally(() => {
            settledCount += 1;
          }),
      );
      const all = Promise.allSettled(promises);
      // Injected actors park immediately and compete with real seams.
      for (const actor of pendingActors) {
        actorSettles.push(
          scheduler.yieldAt(actor.label).then(() => actor.act()),
        );
      }
      pendingActors.length = 0;
      try {
        for (;;) {
          await settleMicrotasks();
          if (settledCount === tasks.length) break;
          if (waiters.length === 0) {
            // Give any real-timer based continuation one more chance.
            await settleMicrotasks();
            if (settledCount === tasks.length) break;
            if (waiters.length === 0) {
              throw new StressDeadlock(
                `deadlock: ${tasks.length - settledCount} task(s) pending with no runnable continuation after ${steps} steps`,
                trace,
              );
            }
          }
          if (steps >= maxSteps) {
            throw new StressDeadlock(
              `step budget exceeded (${maxSteps}); parked=${scheduler.parkedLabels().join(',')}`,
              trace,
            );
          }
          if (Date.now() - startedAt > maxWallMs) {
            throw new StressDeadlock(
              `wall-clock budget exceeded (${maxWallMs}ms) after ${steps} steps`,
              trace,
            );
          }
          const idx = int(0, waiters.length - 1);
          const [next] = waiters.splice(idx, 1);
          trace.push(next!.label);
          steps += 1;
          next!.resolve();
        }
        // Release anything still parked (e.g. an injected actor that never
        // got a slot) so no promise leaks across scenarios.
        running = false;
        while (waiters.length > 0) {
          const w = waiters.shift()!;
          trace.push(`${w.label}#drain`);
          w.resolve();
        }
        await Promise.allSettled(actorSettles);
        await settleMicrotasks();
        const results = await all;
        return { results, trace, steps, wallMs: Date.now() - startedAt };
      } finally {
        running = false;
        while (waiters.length > 0) waiters.shift()!.resolve();
      }
    },
  };
  return scheduler;
}
