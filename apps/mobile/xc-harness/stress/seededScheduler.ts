/**
 * Deterministic interleaving driver for async store code.
 *
 * Every I/O boundary the code under test awaits (SQLite kv statements, the
 * onboarding API) is turned into a `defer()`ed promise that settles ONLY when
 * the scheduler fires it. The scheduler picks which pending operation fires
 * next with a seeded PRNG, drains the microtask queue after each firing so the
 * awaiting continuation runs up to its next I/O boundary, and repeats. Because
 * the PRNG is the only source of non-determinism, an interleaving is fully
 * replayable from its seed.
 */

export function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

export function pickWeighted<T>(
  rng: () => number,
  items: readonly { weight: number; value: T }[],
): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item.value;
  }
  return (items[items.length - 1] as { value: T }).value;
}

interface PendingOp {
  id: number;
  label: string;
  fire: () => void;
}

/** Yield to a macrotask so every settled promise continuation has run. */
export async function drainMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

export class SeededScheduler {
  private pending: PendingOp[] = [];
  private nextId = 0;
  readonly trace: string[] = [];

  constructor(readonly rng: () => number) {}

  /**
   * Register an I/O completion. `settle` runs when the scheduler fires the
   * operation; a thrown error rejects the awaiting caller (fault injection
   * lives inside `settle`, so it is decided at firing time by the same PRNG).
   */
  defer<T>(label: string, settle: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      this.pending.push({
        id,
        label,
        fire: () => {
          try {
            resolve(settle());
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

  pendingLabels(): string[] {
    return this.pending.map(op => op.label);
  }

  /** Fire one randomly chosen pending operation; returns its label. */
  fireRandom(): string {
    const index = Math.floor(this.rng() * this.pending.length);
    const [op] = this.pending.splice(
      Math.min(index, this.pending.length - 1),
      1,
    );
    if (!op) throw new Error('fireRandom() with nothing pending');
    op.fire();
    this.trace.push(`io:${op.label}`);
    return op.label;
  }

  note(entry: string): void {
    this.trace.push(entry);
  }
}
