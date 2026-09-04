/**
 * Seeded interleaving driver for concurrency stress suites.
 *
 * Every asynchronous seam a unit under test touches (SQLite statement,
 * native notification call, permission prompt, context load) is wrapped in
 * `hold(...)`: the call returns a promise that settles only when the driver
 * picks it. User actions (`enqueue`) fire at driver-chosen points in FIFO
 * order, so causal user sequences ("enable, then disable") stay causal while
 * their completions interleave arbitrarily with everything else in flight.
 *
 * `drain()` runs the schedule to quiescence with a step budget; exhausting
 * the budget, or an action promise that never settles once nothing is held,
 * is reported as a deadlock/livelock — never silently tolerated.
 *
 * Two completion disciplines are available per lane:
 *   - `random` (default): any held op in the lane may complete next — models
 *     independent native calls (UNUserNotificationCenter, permission prompts).
 *   - `fifo`: ops complete in issue order — models op-sqlite, whose async
 *     `execute` runs on a single-thread FIFO pool (verified in the vendored
 *     cpp/OPThreadPool.cpp: `number_of_threads = 1`, `work_queue` FIFO).
 */

export type LaneDiscipline = 'random' | 'fifo';

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

interface HeldOp {
  id: number;
  lane: string;
  label: string;
  run: () => void;
}

export interface DrainResult {
  steps: number;
  trace: string[];
}

export class Interleaver {
  readonly trace: string[] = [];
  private readonly held: HeldOp[] = [];
  private readonly actions: Array<{ label: string; fire: () => void }> = [];
  private readonly inFlight: Promise<unknown>[] = [];
  private readonly lanes = new Map<string, LaneDiscipline>();
  private nextId = 1;
  private actionBias = 0.35;

  constructor(readonly random: () => number) {}

  /** Declare how completions within `lane` are ordered. */
  lane(name: string, discipline: LaneDiscipline): void {
    this.lanes.set(name, discipline);
  }

  /** Probability that the next step fires a queued user action rather than
   * completing a held op (when both are available). */
  setActionBias(bias: number): void {
    this.actionBias = bias;
  }

  /** Wrap an async seam: `produce` runs (effects included) when the driver
   * picks this op; a throw rejects the caller's promise. */
  hold<T>(lane: string, label: string, produce: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      this.held.push({
        id,
        lane,
        label,
        run: () => {
          this.trace.push(`complete ${lane}:${label}#${id}`);
          try {
            resolve(produce());
          } catch (error) {
            reject(error);
          }
        },
      });
      this.trace.push(`issue ${lane}:${label}#${id}`);
    });
  }

  /** Queue a user action; fires at a driver-chosen step, FIFO. */
  enqueue(label: string, action: () => unknown): void {
    this.actions.push({
      label,
      fire: () => {
        this.trace.push(`action ${label}`);
        const result = action();
        if (isThenable(result)) {
          this.inFlight.push(Promise.resolve(result).catch(() => undefined));
        }
      },
    });
  }

  /** Number of held ops not yet completed. */
  pendingCount(): number {
    return this.held.length;
  }

  private pickHeld(): HeldOp {
    const candidates: HeldOp[] = [];
    const seenFifoLanes = new Set<string>();
    for (const op of this.held) {
      const discipline = this.lanes.get(op.lane) ?? 'random';
      if (discipline === 'fifo') {
        if (seenFifoLanes.has(op.lane)) continue;
        seenFifoLanes.add(op.lane);
      }
      candidates.push(op);
    }
    const chosen = candidates[Math.floor(this.random() * candidates.length)]!;
    const index = this.held.indexOf(chosen);
    this.held.splice(index, 1);
    return chosen;
  }

  private async flush(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  async drain(maxSteps = 2000): Promise<DrainResult> {
    let steps = 0;
    await this.flush();
    while (this.held.length > 0 || this.actions.length > 0) {
      steps += 1;
      if (steps > maxSteps) {
        throw new Error(
          `interleaver: step budget ${maxSteps} exhausted (livelock?) — held=${this.held
            .map(op => `${op.lane}:${op.label}`)
            .join(',')} actions=${this.actions.length}`,
        );
      }
      const fireAction =
        this.actions.length > 0 &&
        (this.held.length === 0 || this.random() < this.actionBias);
      if (fireAction) {
        this.actions.shift()!.fire();
      } else {
        this.pickHeld().run();
      }
      await this.flush();
    }
    // Everything held has completed; every action promise must now settle
    // on its own. Anything still pending is blocked on something outside
    // the harness (a real timer, an un-held await) — a deadlock for us.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settled = await Promise.race([
      Promise.allSettled(this.inFlight).then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    if (!settled) {
      throw new Error(
        'interleaver: action promises did not settle after quiescence (deadlock?)',
      );
    }
    return { steps, trace: [...this.trace] };
  }
}
