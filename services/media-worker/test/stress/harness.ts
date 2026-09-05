import type pg from "pg";
import type { ObjectDeleter } from "../../src/worker.js";

/**
 * Seeded concurrency harness for the media worker.
 *
 * Every iteration is driven by one 32-bit seed: the seed picks the scenario
 * parameters, and a Scheduler derived from the same seed inserts a random
 * (but replayable) yield before every database query and object-store call
 * of every actor. Running several actors under Promise.all therefore explores
 * a different interleaving per seed while staying fully deterministic on the
 * harness side (the database's own scheduling is the only external source of
 * nondeterminism — a seed that fails is re-run to measure its rate).
 */

/** mulberry32 — small, fast, good enough for interleaving exploration. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }
}

/** FNV-1a over (base, scenario, index) → per-iteration seed. */
export function deriveSeed(base: number, scenario: string, index: number): number {
  let h = 0x811c9dc5;
  const input = `${base}|${scenario}|${index}`;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Seeded yield point. Mixes zero-cost continuations, microtask hops,
 * setImmediate and short timers so actors overtake each other at every
 * await boundary in a seed-determined way.
 */
export class Scheduler {
  constructor(private rng: Rng) {}

  async yield(): Promise<void> {
    const roll = this.rng.int(0, 9);
    if (roll <= 2) return;
    if (roll <= 5) {
      const hops = this.rng.int(1, 4);
      for (let i = 0; i < hops; i++) await Promise.resolve();
      return;
    }
    if (roll <= 7) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    const ms = this.rng.int(0, 4);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

export class InjectedCrash extends Error {
  constructor(actor: string, at: number) {
    super(`injected worker crash (actor ${actor}, query #${at})`);
    this.name = "InjectedCrash";
  }
}

/** One concurrent worker/process. `alive` flips to false at its crash point. */
export interface Actor {
  id: string;
  alive: boolean;
  queries: number;
  /** Crash (every later query/store call throws) once this many queries ran. */
  crashAtQuery: number | null;
  crashed: boolean;
}

export function makeActor(id: string, crashAtQuery: number | null = null): Actor {
  return { id, alive: true, queries: 0, crashAtQuery, crashed: false };
}

export interface QueryHook {
  (text: string, params: unknown[] | undefined, actor: Actor): Promise<void>;
}

/**
 * pg.Pool stand-in for one actor: yields before every query, counts queries,
 * enforces the actor's crash point, and calls an observer hook (used to
 * assert invariants at the exact moment a statement is issued).
 */
export function scheduledPool(
  real: pg.Pool,
  sched: Scheduler,
  actor: Actor,
  errors: DeadlockLog,
  hook?: QueryHook,
): pg.Pool {
  const proxy = {
    async query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
      if (!actor.alive) throw new InjectedCrash(actor.id, actor.queries);
      await sched.yield();
      if (!actor.alive) throw new InjectedCrash(actor.id, actor.queries);
      actor.queries++;
      if (actor.crashAtQuery !== null && actor.queries >= actor.crashAtQuery) {
        actor.alive = false;
        actor.crashed = true;
        throw new InjectedCrash(actor.id, actor.queries);
      }
      if (hook) await hook(text, params, actor);
      try {
        return await real.query(text, params);
      } catch (error) {
        errors.record(error);
        throw error;
      }
    },
  };
  return proxy as unknown as pg.Pool;
}

/** Collects database errors seen by any actor; deadlocks are what we hunt. */
export class DeadlockLog {
  deadlocks: string[] = [];
  otherErrors: string[] = [];

  record(error: unknown): void {
    const code = (error as { code?: string } | null)?.code;
    if (code === "40P01") this.deadlocks.push(String(error));
    else this.otherErrors.push(String(error));
  }
}

/** Object-store failure plan shared by every actor of one iteration. */
export interface StorePlan {
  /** Fail this many deleteObject calls (transient), then succeed. */
  transientFailures: number;
  /** While true every call fails (outage). */
  down: boolean;
}

/**
 * In-memory object store with a full key inventory (orphan detection), seeded
 * yields, an injectable failure plan and a per-call history.
 */
export class StressStore implements ObjectDeleter {
  keys = new Set<string>();
  deleteCalls: string[] = [];
  failedCalls = 0;
  plan: StorePlan = { transientFailures: 0, down: false };

  constructor(private sched: Scheduler) {}

  forActor(actor: Actor): ObjectDeleter {
    return {
      deleteObject: async (key) => {
        if (!actor.alive) throw new InjectedCrash(actor.id, actor.queries);
        await this.sched.yield();
        if (!actor.alive) throw new InjectedCrash(actor.id, actor.queries);
        await this.deleteObject(key);
      },
      listObjects: async (prefix) => {
        if (!actor.alive) throw new InjectedCrash(actor.id, actor.queries);
        await this.sched.yield();
        return this.listObjects(prefix);
      },
    };
  }

  async deleteObject(key: string): Promise<void> {
    if (this.plan.down) {
      this.failedCalls++;
      throw new Error("injected object store outage");
    }
    if (this.plan.transientFailures > 0) {
      this.plan.transientFailures--;
      this.failedCalls++;
      throw new Error("injected transient object store failure");
    }
    this.deleteCalls.push(key);
    this.keys.delete(key);
  }

  async listObjects(prefix: string): Promise<string[]> {
    return [...this.keys].filter((k) => k.startsWith(prefix));
  }

  keysUnder(prefix: string): string[] {
    return [...this.keys].filter((k) => k === prefix || k.startsWith(`${prefix}/`));
  }
}

export interface IterationResult {
  scenario: string;
  seed: number;
  index: number;
  ok: boolean;
  violations: string[];
  params: Record<string, unknown>;
  metrics: Record<string, number | string | boolean | null>;
  durationMs: number;
}

/** Runs one iteration under a wall-clock cap; a hang is a failed iteration. */
export async function withWallClock<T>(
  capMs: number,
  run: () => Promise<T>,
): Promise<{ result: T | null; timedOut: boolean; durationMs: number }> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), capMs);
  });
  try {
    const outcome = await Promise.race([run(), timeout]);
    if (outcome === "timeout") {
      return { result: null, timedOut: true, durationMs: Date.now() - started };
    }
    return { result: outcome as T, timedOut: false, durationMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Awaits every promise, never throws: each actor's failure is data. */
export async function settleAll<T>(
  runs: Array<Promise<T>>,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: string; injected: boolean }>> {
  const settled = await Promise.allSettled(runs);
  return settled.map((s) =>
    s.status === "fulfilled"
      ? { ok: true as const, value: s.value }
      : {
          ok: false as const,
          error: String(s.reason),
          injected: s.reason instanceof InjectedCrash,
        },
  );
}
