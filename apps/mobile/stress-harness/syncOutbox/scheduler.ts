import { int, chance, type Prng } from './prng';

/**
 * Seeded interleaving scheduler.
 *
 * Real op-sqlite resolves each `execute` on a later turn of the event loop
 * (native thread → JS callback) and the network resolves much later still.
 * The harness makes every asynchronous hop take a seeded number of
 * microtask/macrotask turns, so N concurrent `drainOutbox` calls interleave
 * differently for every seed while staying fully replayable. Nothing here
 * uses fake timers: the promises actually run on Node's real event loop.
 */
export interface SchedulerProfile {
  /** Max event-loop hops for one SQLite statement round trip. */
  dbMaxHops: number;
  /** Hop range for one network request. */
  netMinHops: number;
  netMaxHops: number;
  /** Max hops before an actor issues its first call (staggered starts). */
  actorStartMaxHops: number;
  /** Probability a hop is a macrotask (setTimeout 0) instead of a microtask. */
  macroChance: number;
}

export class Scheduler {
  private hopsTaken = 0;

  constructor(
    private readonly rng: Prng,
    readonly profile: SchedulerProfile,
  ) {}

  get hops(): number {
    return this.hopsTaken;
  }

  async hop(times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      this.hopsTaken += 1;
      if (chance(this.rng, this.profile.macroChance)) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      } else {
        await Promise.resolve();
      }
    }
  }

  dbRoundTrip(): Promise<void> {
    return this.hop(int(this.rng, 0, this.profile.dbMaxHops));
  }

  networkRoundTrip(): Promise<void> {
    return this.hop(
      int(this.rng, this.profile.netMinHops, this.profile.netMaxHops),
    );
  }

  actorStart(): Promise<void> {
    return this.hop(int(this.rng, 0, this.profile.actorStartMaxHops));
  }
}

/** Rejects if `work` does not settle within `ms` — the deadlock detector. */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`deadline ${ms}ms exceeded: ${label}`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
