/**
 * Failure-injection harness for `src/state/appStore.ts` (hydrate ordering,
 * pre-auth stash adoption, account switch).
 *
 * The unit's real dependencies are: the SQLite kv table (via getDb +
 * repository.getKv/setKv), the API session snapshot (getApiSession), the
 * canonical onboarding transport (fetchCanonicalOnboardingProfile /
 * saveCanonicalOnboardingProfile → fetch), the account-scope clock (which
 * owner is active RIGHT NOW) and wall-clock timers (the 15s request abort).
 * Every fault this harness injects is at one of those seams; nothing is
 * mocked that the store does not actually call.
 *
 * Determinism: every scenario is derived from a 32-bit seed with mulberry32
 * (same generator as __harness__/serverResponseMatrix/scenarios.ts) and can
 * be replayed alone with STRESS_SEED=<seed>. STRESS_ITER controls campaign
 * size (small default so the suite stays fast).
 */
import * as fs from 'fs';
import * as path from 'path';
import { CHECKPOINTS } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import type { Profile } from '../../src/state/profile';

// ── seeded RNG ─────────────────────────────────────────────────────────────

/** mulberry32 — tiny, deterministic. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  /** Weighted pick: entries are [item, weight]. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T;
  chance(p: number): boolean;
}

export function makeRng(seed: number): Rng {
  const next = seededRandom(seed);
  const rng: Rng = {
    next,
    int: max => Math.floor(next() * max),
    pick: items => items[Math.floor(next() * items.length)] as never,
    weighted: entries => {
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      let roll = next() * total;
      for (const [item, weight] of entries) {
        roll -= weight;
        if (roll < 0) return item;
      }
      return entries[entries.length - 1]![0];
    },
    chance: p => next() < p,
  };
  return rng;
}

/** Campaign controls shared by every stress suite in this folder. */
export function campaignConfig(defaultIterations: number): {
  iterations: number;
  seeds: number[];
  replaySeed: number | null;
  /** True when no STRESS_* override is set (seeds 1..defaultIterations). */
  isDefault: boolean;
} {
  const replay = process.env['STRESS_SEED'];
  if (replay !== undefined && replay !== '') {
    const seed = Number(replay) >>> 0;
    return { iterations: 1, seeds: [seed], replaySeed: seed, isDefault: false };
  }
  const iterEnv = process.env['STRESS_ITER'];
  const baseEnv = process.env['STRESS_SEED_BASE'];
  const iterations = Number(iterEnv ?? defaultIterations);
  const base = Number(baseEnv ?? 1);
  const seeds: number[] = [];
  for (let i = 0; i < iterations; i += 1) seeds.push((base + i) >>> 0);
  return {
    iterations,
    seeds,
    replaySeed: null,
    isDefault:
      (iterEnv === undefined || iterEnv === '') &&
      (baseEnv === undefined || baseEnv === ''),
  };
}

// ── artifacts ──────────────────────────────────────────────────────────────

export function artifactDir(): string {
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  const run = process.env['STRESS_RUN_ID'] ?? 'local';
  const dir = path.join(root, 'artifacts', 'stress', 'mod-app-store', run);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArtifact(name: string, data: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}

// ── fault model ────────────────────────────────────────────────────────────

/**
 * How one dependency call misbehaves.
 *  ok        — behaves normally
 *  throw     — synchronous throw (bridge-level failure)
 *  reject    — returns a rejected promise
 *  slow      — resolves after `slowMs` of (fake) time
 *  never     — the promise never settles
 *  malformed — resolves with a value of the wrong shape (see per-seam notes)
 */
export type FaultMode =
  'ok' | 'throw' | 'reject' | 'slow' | 'never' | 'malformed';

export interface Fault {
  mode: FaultMode;
  /** For `slow`. */
  slowMs?: number;
  /** For `malformed` on kv reads: which wrong row shape to return. */
  malformedRows?:
    'no-rows-field' | 'row-without-value' | 'numeric-0' | 'object-value';
}

export const OK: Fault = { mode: 'ok' };

export interface KvCall {
  seq: number;
  op: 'get' | 'set';
  key: string;
  mode: FaultMode;
  /** Value written (set) — recorded before the fault is applied. */
  value?: string;
}

/**
 * In-memory stand-in for the real SQLite kv table that understands EXACTLY
 * the two statements `repository.getKv/setKv` issue, so the real repository
 * layer (including its `rows[0]?.['value'] ? … : null` coercion) is under
 * test. Faults are keyed by `${op}:${key}` and fire on every matching call
 * unless `once` is set.
 */
export class FaultKv implements LocalDb {
  readonly table = new Map<string, string>();
  readonly calls: KvCall[] = [];
  readonly faults = new Map<string, Fault & { once?: boolean }>();
  /** Fired synchronously after each call is recorded (before its fault). */
  onCall: ((call: KvCall) => void) | null = null;
  private seq = 0;

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.table.set(key, value);
  }

  fault(op: 'get' | 'set', key: string, fault: Fault, once = false): void {
    this.faults.set(`${op}:${key}`, { ...fault, once });
  }

  clearFaults(): void {
    this.faults.clear();
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.table.entries()].sort());
  }

  execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const op: 'get' | 'set' = sql.startsWith('SELECT') ? 'get' : 'set';
    const key = String(params[0]);
    const call: KvCall = {
      seq: ++this.seq,
      op,
      key,
      mode: 'ok',
      ...(op === 'set' ? { value: String(params[1]) } : {}),
    };
    const fault = this.faults.get(`${op}:${key}`);
    if (fault) {
      call.mode = fault.mode;
      if (fault.once) this.faults.delete(`${op}:${key}`);
    }
    this.calls.push(call);
    this.onCall?.(call);

    const perform = (): { rows: Record<string, unknown>[] } => {
      if (op === 'get') {
        const value = this.table.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      this.table.set(key, String(params[1]));
      return { rows: [] };
    };

    switch (call.mode) {
      case 'ok':
        return Promise.resolve(perform());
      case 'throw':
        throw new Error(`[op-sqlite] SQLITE_IOERR on ${op} ${key}`);
      case 'reject':
        return Promise.reject(
          new Error(
            `[op-sqlite] SQLITE_BUSY: database is locked (${op} ${key})`,
          ),
        );
      case 'never':
        return new Promise(() => undefined);
      case 'slow':
        return new Promise(resolve =>
          setTimeout(() => resolve(perform()), fault?.slowMs ?? 1_000),
        );
      case 'malformed': {
        if (op === 'set') return Promise.resolve({ rows: [] });
        switch (fault?.malformedRows ?? 'row-without-value') {
          case 'no-rows-field':
            return Promise.resolve({} as { rows: Record<string, unknown>[] });
          case 'row-without-value':
            return Promise.resolve({ rows: [{}] });
          case 'numeric-0':
            return Promise.resolve({ rows: [{ value: 0 }] });
          case 'object-value':
            return Promise.resolve({ rows: [{ value: { nested: true } }] });
        }
      }
    }
    return Promise.resolve(perform());
  }

  close(): void {
    // no-op
  }
}

// ── fixtures ───────────────────────────────────────────────────────────────

export const CANONICAL_A = '11111111-1111-4111-8111-111111111111';
export const CANONICAL_B = '22222222-2222-4222-8222-222222222222';

export const CHECKPOINT_SET: ReadonlySet<string> = new Set(CHECKPOINTS);

export function makeProfile(tag: string, rng: Rng): Profile {
  const goals = [
    'dinks',
    'drives',
    'drops',
    'serve',
    'return',
    'volleys',
    'footwork',
    'all-around',
  ] as const;
  const goal = rng.pick(goals);
  const focusByGoal: Record<string, Profile['focusCheckpoint']> = {
    dinks: 'contact_position',
    drives: 'preparation',
    drops: 'paddle_set',
    serve: 'sequencing',
    return: 'athletic_base',
    volleys: 'face_wrist_stability',
    footwork: 'athletic_base',
    'all-around': 'contact_position',
  };
  const withIdentity = rng.chance(0.5);
  return {
    ...(withIdentity ? { firstName: `Name-${tag}`, gender: 'female' } : {}),
    skillLevel: rng.pick(['2.5', '3.0', '3.5', '4.0', '4.5']),
    handedness: rng.pick(['right', 'left', 'ambidextrous']),
    goal,
    biggestProblem: `problem-${tag}`,
    focusCheckpoint: focusByGoal[goal]!,
  };
}

/** Shape check the Gate + every screen implicitly rely on. */
export function isValidProfile(value: unknown): value is Profile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  for (const key of ['skillLevel', 'handedness', 'goal', 'biggestProblem']) {
    if (typeof p[key] !== 'string') return false;
  }
  if (!['right', 'left', 'ambidextrous'].includes(p['handedness'] as string)) {
    return false;
  }
  if (typeof p['focusCheckpoint'] !== 'string') return false;
  return CHECKPOINT_SET.has(p['focusCheckpoint'] as string);
}

export function parseProfileJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return Symbol.for('unparseable');
  }
}

// ── fake-time settlement ───────────────────────────────────────────────────

export type Settlement = 'resolved' | 'rejected' | 'hung';

/**
 * Drive `promise` under jest modern fake timers: flush microtasks and advance
 * the clock in `stepMs` increments until it settles or `budgetMs` of fake
 * time has elapsed. Returns how it settled and the fake time consumed.
 */
export async function settleWithin(
  promise: Promise<unknown>,
  budgetMs = 60_000,
  stepMs = 500,
): Promise<{ settlement: Settlement; fakeMs: number; error?: unknown }> {
  let settlement: Settlement | null = null;
  let error: unknown;
  void promise.then(
    () => {
      settlement = 'resolved';
    },
    reason => {
      settlement = 'rejected';
      error = reason;
    },
  );
  let elapsed = 0;
  // Let already-resolved chains drain before touching the clock.
  for (let i = 0; i < 20 && settlement === null; i += 1) {
    await Promise.resolve();
  }
  while (settlement === null && elapsed < budgetMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    elapsed += stepMs;
  }
  return {
    settlement: settlement ?? 'hung',
    fakeMs: elapsed,
    ...(error !== undefined ? { error } : {}),
  };
}
