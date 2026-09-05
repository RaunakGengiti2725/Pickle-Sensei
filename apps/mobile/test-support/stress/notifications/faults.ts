/**
 * Fault model shared by the notification failure-injection campaigns.
 *
 * Every dependency call site (kv read/write, scheduler op, notifee native
 * call, context loader, settings deep-link) is wrapped in `runFault`, which
 * turns a healthy producer into one of the injected failure classes:
 *
 *   throw     synchronous exception from the call itself
 *   reject    returned promise rejects immediately
 *   timeout   rejects after DEPENDENCY_TIMEOUT_MS (dependency-side timeout)
 *   slow      resolves normally after 0.5–5 s of fake time
 *   never     the promise never settles
 *   malformed resolves with a value outside the dependency's contract
 *   partial   half the work lands, then the call rejects
 *
 * Callers supply `malformed`/`partial` hooks because those two are
 * dependency-specific. Every injection is journaled so a campaign can report
 * exactly how many faults actually fired (not merely how many were planned).
 */

export const FAULT_MODES = [
  'ok',
  'throw',
  'reject',
  'timeout',
  'slow',
  'never',
  'malformed',
  'partial',
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export const INJECTED_FAULT_MODES: readonly FaultMode[] = FAULT_MODES.filter(
  mode => mode !== 'ok',
);

/** Dependency-side timeout — well under the 60 s no-spinner budget. */
export const DEPENDENCY_TIMEOUT_MS = 30_000;
export const SLOW_MIN_MS = 500;
export const SLOW_MAX_MS = 5_000;

export class InjectedFaultError extends Error {
  constructor(
    readonly dependency: string,
    readonly op: string,
    readonly mode: FaultMode,
  ) {
    super(`injected ${mode} in ${dependency}.${op}`);
    this.name = 'InjectedFaultError';
  }
}

export interface FaultJournalEntry {
  dependency: string;
  op: string;
  mode: FaultMode;
  /** Fake-clock time when the call was made. */
  atMs: number;
}

export class FaultJournal {
  readonly entries: FaultJournalEntry[] = [];

  record(entry: FaultJournalEntry): void {
    this.entries.push(entry);
  }

  /** Calls where a non-`ok` mode actually fired. */
  injected(): FaultJournalEntry[] {
    return this.entries.filter(entry => entry.mode !== 'ok');
  }

  /** Compact replay-readable trace, relative to the first call's clock. */
  trace(): string[] {
    const origin = this.entries[0]?.atMs ?? 0;
    return this.entries.map(
      entry =>
        `${entry.dependency}.${entry.op}:${entry.mode}@${entry.atMs - origin}`,
    );
  }

  byMode(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.injected()) {
      counts[entry.mode] = (counts[entry.mode] ?? 0) + 1;
    }
    return counts;
  }
}

export interface FaultHooks<T> {
  malformed?: () => T | Promise<T>;
  partial?: () => T | Promise<T>;
  /** Fixed slow latency for this call (fake ms); defaults to SLOW_MIN_MS. */
  slowMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Applies `mode` to `produce`. NOT an async function on purpose: the `throw`
 * mode must escape synchronously, exactly like a misbehaving dependency
 * whose call site throws before it ever hands back a promise.
 */
export function runFault<T>(
  journal: FaultJournal,
  dependency: string,
  op: string,
  mode: FaultMode,
  produce: () => T | Promise<T>,
  hooks: FaultHooks<T> = {},
): Promise<T> {
  journal.record({ dependency, op, mode, atMs: Date.now() });
  const error = new InjectedFaultError(dependency, op, mode);
  switch (mode) {
    case 'ok':
      return Promise.resolve().then(produce);
    case 'throw':
      throw error;
    case 'reject':
      return Promise.reject(error);
    case 'timeout':
      return delay(DEPENDENCY_TIMEOUT_MS).then(() => {
        throw error;
      });
    case 'slow':
      return delay(hooks.slowMs ?? SLOW_MIN_MS).then(produce);
    case 'never':
      return new Promise<T>(() => {});
    case 'malformed':
      if (!hooks.malformed) return Promise.reject(error);
      return Promise.resolve().then(hooks.malformed);
    case 'partial':
      // The hook performs the partial side effect itself (half a plan
      // applied, a torn kv row, an OS grant whose reply was lost) and either
      // returns the partial data or throws `error` once the damage is done.
      if (!hooks.partial) return Promise.reject(error);
      return Promise.resolve().then(hooks.partial);
  }
}

/**
 * Settles `promise` under fake timers, advancing the fake clock in steps
 * until the promise settles or `budgetMs` of fake time has elapsed. Returns
 * whether it settled — a `never` fault produces `settled: false` and that is
 * the "infinite spinner after 60 s" signal.
 */
export async function settleWithin<T>(
  promise: Promise<T>,
  budgetMs: number,
  advance: (ms: number) => Promise<void>,
  stepMs = 1_000,
): Promise<
  | { settled: true; ok: true; value: T }
  | { settled: true; ok: false; error: unknown }
  | { settled: false }
> {
  let done:
    | { settled: true; ok: true; value: T }
    | { settled: true; ok: false; error: unknown }
    | null = null;
  const tracked = promise.then(
    value => {
      done = { settled: true, ok: true, value };
    },
    (error: unknown) => {
      done = { settled: true, ok: false, error };
    },
  );
  let elapsed = 0;
  // Flush microtasks first; a healthy dependency settles without any timer.
  await flushMicrotasks();
  while (done === null && elapsed < budgetMs) {
    await advance(stepMs);
    elapsed += stepMs;
    await flushMicrotasks();
  }
  if (done === null) {
    // Keep the dangling promise from turning into an unhandled rejection
    // if the campaign later releases the fault.
    void tracked.catch(() => {});
    return { settled: false };
  }
  return done;
}

export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}
