/**
 * STRESS / failure-injection — `src/walkthrough/walkthroughStore.ts`.
 *
 * Every dependency of the store is faulted from a seeded plan: the SQLite
 * handle (`getDb`), the KV read (`getKv` → `db.execute` SELECT), the KV write
 * (`setKv` → `db.execute` INSERT), the registered yield targets
 * (`walkthroughYieldsTo`), the clock (slow / never-settling calls under fake
 * timers) and the caller interleavings App.tsx / Settings can produce
 * (concurrent landings, replay, dismiss, a ceremony starting or ending while
 * the landing is in flight, a second landing wave).
 *
 * Each iteration is replayable from its seed, runs against a FRESH module
 * instance (`jest.isolateModules`, so a hung `evaluationQueue` in one
 * iteration cannot leak into the next) and is checked against an oracle model
 * of the documented contract plus the lens invariants:
 *
 *  I1 booleans      `visible`/`queued` are booleans and never both true.
 *  I2 write-first   the durable record is written (setKv resolved) BEFORE the
 *                   overlay is raised by a landing (crash-loop rule).
 *  I3 no-overlap    the tour is never raised while a yield target reports a
 *                   ceremony showing.
 *  I4 no-fake-show  a landing never raises the tour after a read/write fault.
 *  I5 no-hang       every landing promise settles within 60 s of fake time
 *                   unless the fault is a never-settling DB call.
 *  I6 no-spinner    a never-settling call leaves the store idle (no overlay,
 *                   nothing queued) and Settings → replay still works.
 *  I7 single-write  a wave of concurrent landings writes the record at most
 *                   once, with exactly the constant SEEN value.
 *  I8 no-corrupt    the KV row is either absent or the SEEN constant.
 *  I9 oracle        the terminal state equals the oracle's prediction.
 *  I10 dismiss-final a dismiss with no later replay / ceremony hand-off is not
 *                   undone by the landing that was in flight.
 *  I11 no-reject    `maybeShowFirstRun` never rejects (App.tsx calls it with
 *                   `void`, so a rejection is an unhandled rejection).
 *  I12 second-wave  after the fault clears, the next landing behaves exactly
 *                   like a fresh device (record present → no show; absent →
 *                   one write + show).
 *
 * Scale:  STRESS_ITER=<n>  iterations (default 300 ≈ 1.5 s; campaign used 5000)
 * Replay: STRESS_SEED=<seed> runs exactly one seed
 * Output: STRESS_OUT=<dir> (default artifacts/stress under the repo root)
 *         writes walkthrough-failure-injection.json — one row per seed.
 * Gaps:   STRESS_KNOWN_GAPS=I10-dismiss-final,I11-no-reject lets a campaign
 *         run to completion while a documented deviation is still open; the
 *         JSON table always records every violation regardless.
 *
 * The two `minimized` tests at the bottom are the deterministic, seed-free
 * reproductions of the deviations the 5000-seed campaign surfaced. They
 * assert the CONTRACT (what the store should do) and therefore fail until
 * the store is fixed — they are the pinning tests for those findings.
 */

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

import type * as WalkthroughModule from '../../src/walkthrough/walkthroughStore';

type Store = typeof WalkthroughModule;

let mockGetDb: () => unknown = () => {
  throw new Error('getDb fault plan not configured');
};

jest.mock('../../src/data/db', () => ({ getDb: () => mockGetDb() }));

const ITERATIONS = Number(process.env.STRESS_ITER ?? 300);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const OUT_DIR =
  process.env.STRESS_OUT ??
  join(__dirname, '..', '..', '..', '..', 'artifacts', 'stress');
const SIXTY_SECONDS = 60_000;

// ── seeded RNG ────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

// ── fault catalogue ───────────────────────────────────────────────────────

const READ_FAULTS = [
  'ok',
  'reject',
  'throw-sync',
  'hang',
  'slow',
  'getdb-throw',
  'getdb-undefined',
  'getdb-no-execute',
  'execute-returns-undefined',
  'execute-returns-non-promise',
  'rows-undefined',
  'rows-null',
  'rows-not-array',
  'row-empty-object',
  'row-value-empty-string',
  'row-value-zero',
  'row-value-null',
  'row-value-false',
  'row-value-object',
  'row-value-garbage-string',
  'row-value-number',
  'row-value-true',
] as const;
type ReadFault = (typeof READ_FAULTS)[number];

const WRITE_FAULTS = [
  'ok',
  'reject',
  'throw-sync',
  'hang',
  'slow',
  'getdb-throw-on-write',
  'partial-not-persisted',
  'returns-undefined',
] as const;
type WriteFault = (typeof WRITE_FAULTS)[number];

const TARGET_FAULTS = [
  'none',
  'not-showing',
  'showing',
  'showing-two-targets',
  'is-showing-throws',
  'subscribe-throws',
  'subscribe-returns-undefined',
  'listener-never-fires',
] as const;
type TargetFault = (typeof TARGET_FAULTS)[number];

const INTERLEAVES = [
  'none',
  'replay',
  'dismiss',
  'replay-then-dismiss',
  'target-starts-showing',
  'target-dismisses',
] as const;
type Interleave = (typeof INTERLEAVES)[number];

const INTERLEAVE_TIMINGS = ['sync', 'after-read', 'mid-delay'] as const;
type InterleaveTiming = (typeof INTERLEAVE_TIMINGS)[number];

interface Plan {
  seed: number;
  preSeen: boolean;
  read: ReadFault;
  write: WriteFault;
  target: TargetFault;
  concurrency: number;
  interleave: Interleave;
  interleaveTiming: InterleaveTiming;
  delayMs: number;
  secondWave: boolean;
}

function planFor(seed: number): Plan {
  const rng = mulberry32(seed);
  const preSeen = rng() < 0.2;
  // Bias toward the interesting cells: a clean read most of the time so the
  // write and target faults are actually reached.
  const read: ReadFault = rng() < 0.45 ? 'ok' : pick(rng, READ_FAULTS);
  const write: WriteFault = rng() < 0.4 ? 'ok' : pick(rng, WRITE_FAULTS);
  const target = pick(rng, TARGET_FAULTS);
  const concurrency = 1 + Math.floor(rng() * 5);
  const interleave = pick(rng, INTERLEAVES);
  const interleaveTiming = pick(rng, INTERLEAVE_TIMINGS);
  const delayMs = pick(rng, [1, 250, 5_000, 30_000, 59_000]);
  const secondWave = rng() < 0.7;
  return {
    seed,
    preSeen,
    read,
    write,
    target,
    concurrency,
    interleave,
    interleaveTiming,
    delayMs,
    secondWave,
  };
}

// ── fake SQLite handle ────────────────────────────────────────────────────

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface WriteCall {
  key: string;
  value: string;
  resolvedAt: number | null;
}

class FakeDb {
  readonly kv = new Map<string, string>();
  readonly writes: WriteCall[] = [];
  readCalls = 0;
  readSettled = 0;
  writeSettled = 0;
  writesAfterPersist = 0;
  readFault: ReadFault;
  writeFault: WriteFault;
  readonly hung: Deferred[] = [];
  private getDbCalls = 0;
  private tick = 0;

  constructor(plan: Plan) {
    this.readFault = plan.read;
    this.writeFault = plan.write;
    this.delayMs = plan.delayMs;
  }

  private delayMs: number;

  /**
   * The `getDb()` the store sees on each call. Handle faults persist until
   * `heal()`; the store calls getDb once for the read and once more for the
   * write, so "closed between read and write" faults every second call.
   */
  handle(): unknown {
    this.getDbCalls += 1;
    if (this.readFault === 'getdb-throw') {
      throw new Error('getDb: database not open');
    }
    if (
      this.writeFault === 'getdb-throw-on-write' &&
      this.getDbCalls % 2 === 0
    ) {
      throw new Error('getDb: database closed between read and write');
    }
    if (this.readFault === 'getdb-undefined') {
      return undefined;
    }
    if (this.readFault === 'getdb-no-execute') {
      return { close() {} };
    }
    return {
      execute: (sql: string, params: unknown[] = []) =>
        this.execute(sql, params),
      close() {},
    };
  }

  private later<T>(value: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(value());
        } catch (error) {
          reject(error);
        }
      }, this.delayMs);
    });
  }

  private hang(): Promise<never> {
    return new Promise<never>((resolve, reject) => {
      this.hung.push({ resolve: resolve as (v: unknown) => void, reject });
    });
  }

  private execute(sql: string, params: unknown[]): unknown {
    if (sql.startsWith('SELECT value FROM kv')) return this.read(params);
    if (sql.startsWith('INSERT OR REPLACE INTO kv')) return this.write(params);
    return Promise.resolve({ rows: [] });
  }

  private read(params: unknown[]): unknown {
    this.readCalls += 1;
    const key = String(params[0]);
    const stored = this.kv.get(key);
    const okRows = () => ({
      rows: stored === undefined ? [] : [{ value: stored }],
    });
    const settle = <T>(p: Promise<T>): Promise<T> =>
      p.finally(() => {
        this.readSettled += 1;
      });
    switch (this.readFault) {
      case 'ok':
      case 'getdb-throw':
      case 'getdb-undefined':
      case 'getdb-no-execute':
        return settle(Promise.resolve(okRows()));
      case 'reject':
        return settle(Promise.reject(new Error('kv read failed')));
      case 'throw-sync':
        throw new Error('kv read threw synchronously');
      case 'hang':
        return this.hang();
      case 'slow':
        return settle(this.later(okRows));
      case 'execute-returns-undefined':
        return undefined;
      case 'execute-returns-non-promise':
        return okRows();
      case 'rows-undefined':
        return settle(Promise.resolve({}));
      case 'rows-null':
        return settle(Promise.resolve({ rows: null }));
      case 'rows-not-array':
        return settle(Promise.resolve({ rows: 'not-an-array' }));
      case 'row-empty-object':
        return settle(Promise.resolve({ rows: [{}] }));
      case 'row-value-empty-string':
        return settle(Promise.resolve({ rows: [{ value: '' }] }));
      case 'row-value-zero':
        return settle(Promise.resolve({ rows: [{ value: 0 }] }));
      case 'row-value-null':
        return settle(Promise.resolve({ rows: [{ value: null }] }));
      case 'row-value-false':
        return settle(Promise.resolve({ rows: [{ value: false }] }));
      case 'row-value-object':
        return settle(Promise.resolve({ rows: [{ value: { version: 1 } }] }));
      case 'row-value-garbage-string':
        return settle(Promise.resolve({ rows: [{ value: '\u0000garbage' }] }));
      case 'row-value-number':
        return settle(Promise.resolve({ rows: [{ value: 1 }] }));
      case 'row-value-true':
        return settle(Promise.resolve({ rows: [{ value: true }] }));
    }
  }

  private write(params: unknown[]): unknown {
    const call: WriteCall = {
      key: String(params[0]),
      value: String(params[1]),
      resolvedAt: null,
    };
    if (this.kv.has(call.key)) this.writesAfterPersist += 1;
    this.writes.push(call);
    const persist = () => {
      this.tick += 1;
      call.resolvedAt = this.tick;
      this.writeSettled += 1;
      if (this.writeFault !== 'partial-not-persisted') {
        this.kv.set(call.key, call.value);
      }
      return { rows: [] };
    };
    switch (this.writeFault) {
      case 'ok':
      case 'partial-not-persisted':
      case 'getdb-throw-on-write':
        return Promise.resolve(persist());
      case 'returns-undefined':
        persist();
        return undefined;
      case 'reject':
        return Promise.reject(new Error('kv write failed')).finally(() => {
          this.writeSettled += 1;
        });
      case 'throw-sync':
        this.writeSettled += 1;
        throw new Error('kv write threw synchronously');
      case 'hang':
        return this.hang();
      case 'slow':
        return this.later(persist);
    }
  }

  /** The DB "recovers": later calls behave. */
  heal(): void {
    this.readFault = 'ok';
    this.writeFault = 'ok';
    this.getDbCalls = 0;
  }

  /** A hung call finally fails (driver timeout). */
  timeOutHung(): number {
    const n = this.hung.length;
    for (const d of this.hung.splice(0)) d.reject(new Error('sqlite timeout'));
    return n;
  }
}

// ── yield targets ─────────────────────────────────────────────────────────

interface FakeTarget {
  showing: boolean;
  listeners: Set<() => void>;
  target: WalkthroughModule.WalkthroughYieldTarget;
  dismiss(): void;
  show(): void;
}

function makeTarget(fault: TargetFault, showing: boolean): FakeTarget {
  const listeners = new Set<() => void>();
  const self: FakeTarget = {
    showing,
    listeners,
    target: {
      isShowing: () => {
        if (fault === 'is-showing-throws') {
          throw new Error('ceremony store unavailable');
        }
        return self.showing;
      },
      subscribe: listener => {
        if (fault === 'subscribe-throws') {
          throw new Error('ceremony store subscribe failed');
        }
        listeners.add(listener);
        if (fault === 'subscribe-returns-undefined') {
          return undefined as unknown as () => void;
        }
        return () => listeners.delete(listener);
      },
    },
    dismiss() {
      self.showing = false;
      if (fault === 'listener-never-fires') return;
      for (const l of [...listeners]) l();
    },
    show() {
      self.showing = true;
      for (const l of [...listeners]) l();
    },
  };
  return self;
}

// ── oracle ────────────────────────────────────────────────────────────────

type ReadModel = 'absent' | 'seen' | 'error' | 'hang';

function modelRead(plan: Plan, seenNow: boolean): ReadModel {
  switch (plan.read) {
    case 'ok':
    case 'slow':
    case 'execute-returns-non-promise':
      return seenNow ? 'seen' : 'absent';
    case 'hang':
      return 'hang';
    case 'reject':
    case 'throw-sync':
    case 'getdb-throw':
    case 'getdb-undefined':
    case 'getdb-no-execute':
    case 'execute-returns-undefined':
    case 'rows-undefined':
    case 'rows-null':
      return 'error';
    case 'rows-not-array':
      // 'not-an-array'[0] is 'n' → 'n'['value'] undefined → absent.
      return 'absent';
    case 'row-empty-object':
    case 'row-value-empty-string':
    case 'row-value-zero':
    case 'row-value-null':
    case 'row-value-false':
      return 'absent';
    case 'row-value-object':
    case 'row-value-garbage-string':
    case 'row-value-number':
    case 'row-value-true':
      return 'seen';
  }
}

type WriteModel = 'ok' | 'error' | 'hang';

function modelWrite(plan: Plan): WriteModel {
  switch (plan.write) {
    case 'ok':
    case 'slow':
    case 'partial-not-persisted':
    case 'returns-undefined':
      return 'ok';
    case 'hang':
      return 'hang';
    case 'reject':
    case 'throw-sync':
    case 'getdb-throw-on-write':
      return 'error';
  }
}

// ── result rows ───────────────────────────────────────────────────────────

interface Failure {
  invariant: string;
  detail: string;
}

interface ResultRow extends Plan {
  ok: boolean;
  failures: Failure[];
  terminal: { visible: boolean; queued: boolean };
  writes: number;
  readCalls: number;
  landingsSettled: number;
  landingsRejected: number;
  landingsPending: number;
  raisedByLanding: boolean;
  registrationThrew: boolean;
  kvAfter: string | null;
}

const results: ResultRow[] = [];
const wallStart = Date.now();

function seeds(): number[] {
  if (ONLY_SEED !== null) return [ONLY_SEED];
  return Array.from({ length: ITERATIONS }, (_, i) => 1_000 + i);
}

// ── one iteration ─────────────────────────────────────────────────────────

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

async function runIteration(plan: Plan): Promise<ResultRow> {
  const failures: Failure[] = [];
  const fail = (invariant: string, detail: string) =>
    failures.push({ invariant, detail });

  jest.useFakeTimers();
  const db = new FakeDb(plan);
  mockGetDb = () => db.handle();

  let store!: Store;
  jest.isolateModules(() => {
    store = require('../../src/walkthrough/walkthroughStore') as Store;
  });
  const {
    useWalkthroughStore,
    walkthroughYieldsTo,
    WALKTHROUGH_KV_KEY,
    WALKTHROUGH_SEEN_VALUE,
  } = store;

  if (plan.preSeen) db.kv.set(WALKTHROUGH_KV_KEY, WALKTHROUGH_SEEN_VALUE);

  // Targets.
  const targets: FakeTarget[] = [];
  let registrationThrew = false;
  const unsubscribes: Array<() => void> = [];
  const register = (t: FakeTarget) => {
    try {
      unsubscribes.push(walkthroughYieldsTo(t.target));
    } catch {
      registrationThrew = true;
    }
  };
  switch (plan.target) {
    case 'none':
      break;
    case 'not-showing':
    case 'is-showing-throws':
    case 'subscribe-throws':
    case 'subscribe-returns-undefined':
      targets.push(makeTarget(plan.target, false));
      break;
    case 'showing':
    case 'listener-never-fires':
      targets.push(makeTarget(plan.target, true));
      break;
    case 'showing-two-targets':
      targets.push(makeTarget('showing', true), makeTarget('showing', true));
      break;
  }
  targets.forEach(register);

  const anyTargetShowing = () =>
    targets.some(t =>
      plan.target === 'is-showing-throws' ? false : t.showing,
    );

  // Transition log.
  interface Transition {
    visible: boolean;
    queued: boolean;
    writesResolved: number;
    replaysSoFar: number;
    ceremonyShowing: boolean;
  }
  const transitions: Transition[] = [];
  let replays = 0;
  let dismissals = 0;
  let lastDismissIndex = -1;
  let lastReplayIndex = -1;
  const replayIndices = new Set<number>();
  let lastCeremonyHandoffIndex = -1;
  let replayThrew: string | null = null;
  const unsubscribeLog = useWalkthroughStore.subscribe(state => {
    transitions.push({
      visible: state.visible,
      queued: state.queued,
      writesResolved: db.writeSettled,
      replaysSoFar: replays,
      ceremonyShowing: anyTargetShowing(),
    });
  });
  const api = () => useWalkthroughStore.getState();
  const userReplay = () => {
    replays += 1;
    lastReplayIndex = transitions.length;
    replayIndices.add(lastReplayIndex);
    try {
      api().replay();
    } catch (error) {
      replayThrew = (error as Error).message;
    }
  };
  const userDismiss = () => {
    dismissals += 1;
    // Only a dismiss that actually took a showing/queued tour down counts as
    // "the user dismissed the tour" — dismissing nothing is a no-op.
    const s = api();
    lastDismissIndex = s.visible || s.queued ? transitions.length : -1;
    api().dismiss();
  };

  // Landing wave.
  interface Landing {
    state: 'pending' | 'resolved' | 'rejected';
    reason: unknown;
  }
  const landings: Landing[] = [];
  const fireLanding = () => {
    const landing: Landing = { state: 'pending', reason: null };
    landings.push(landing);
    api()
      .maybeShowFirstRun()
      .then(
        () => {
          landing.state = 'resolved';
        },
        reason => {
          landing.state = 'rejected';
          landing.reason = reason;
        },
      );
  };
  for (let i = 0; i < plan.concurrency; i++) fireLanding();

  const doInterleave = () => {
    switch (plan.interleave) {
      case 'none':
        return;
      case 'replay':
        userReplay();
        return;
      case 'dismiss':
        userDismiss();
        return;
      case 'replay-then-dismiss':
        userReplay();
        userDismiss();
        return;
      case 'target-starts-showing':
        for (const t of targets) t.show();
        return;
      case 'target-dismisses':
        for (const t of targets) {
          lastCeremonyHandoffIndex = transitions.length;
          t.dismiss();
        }
        return;
    }
  };

  switch (plan.interleaveTiming) {
    case 'sync':
      doInterleave();
      break;
    case 'after-read':
      await flushMicrotasks(4);
      doInterleave();
      break;
    case 'mid-delay':
      await jest.advanceTimersByTimeAsync(Math.max(0, plan.delayMs - 1));
      doInterleave();
      break;
  }

  // Let 60 s of fake time pass — everything short of a true hang settles.
  // Landings are serialized by contract, so a wave of N slow landings (slow
  // read + slow write each) legitimately needs N × 2 × delay on top.
  const budgetMs = SIXTY_SECONDS + plan.concurrency * 2 * plan.delayMs;
  await jest.advanceTimersByTimeAsync(budgetMs);
  await flushMicrotasks();

  const readModel = modelRead(plan, plan.preSeen);
  const writeModel = modelWrite(plan);
  const expectHang =
    readModel === 'hang' || (readModel === 'absent' && writeModel === 'hang');

  // I5 / I6 — settlement.
  const pending = landings.filter(l => l.state === 'pending').length;
  if (!expectHang && pending > 0) {
    fail(
      'I5-no-hang',
      `${pending}/${landings.length} landings still pending after ${budgetMs} ms`,
    );
  }
  if (expectHang) {
    const s = api();
    const userRaisedIt = replays > 0 && lastReplayIndex > lastDismissIndex;
    if ((s.visible || s.queued) && !userRaisedIt) {
      fail(
        'I6-no-spinner',
        `hung DB call left store visible=${s.visible} queued=${s.queued}`,
      );
    }
    if (userRaisedIt) userDismiss();
    // Recovery control: Settings → replay must still work while the queue is stuck.
    const showingNow = anyTargetShowing();
    if (plan.target !== 'is-showing-throws') {
      userReplay();
      const after = api();
      const raised = showingNow ? after.queued : after.visible;
      if (!raised) {
        fail(
          'I6-no-spinner',
          'replay() did not raise the tour while the landing queue is hung',
        );
      }
      userDismiss();
    }
    // The driver eventually times the hung call out: every landing that was
    // waiting behind it must settle (errors are swallowed by contract).
    for (let i = 0; i <= plan.concurrency; i++) {
      if (db.timeOutHung() === 0) break;
      await flushMicrotasks(16);
      await jest.advanceTimersByTimeAsync(2 * plan.delayMs);
    }
    const stillPending = landings.filter(l => l.state === 'pending').length;
    if (stillPending > 0) {
      fail(
        'I5-no-hang',
        `${stillPending}/${landings.length} landings still pending after the hung call failed`,
      );
    }
  }
  if (replayThrew !== null) {
    fail('I11-no-reject', `replay() threw synchronously: ${replayThrew}`);
  }

  // I11 — rejections.
  const rejected = landings.filter(l => l.state === 'rejected');
  if (rejected.length > 0) {
    fail(
      'I11-no-reject',
      `${rejected.length}/${landings.length} landings rejected: ${String(
        (rejected[0]!.reason as Error)?.message ?? rejected[0]!.reason,
      )}`,
    );
  }

  // I1 — booleans, never both.
  for (const t of transitions) {
    if (typeof t.visible !== 'boolean' || typeof t.queued !== 'boolean') {
      fail('I1-booleans', `non-boolean state ${JSON.stringify(t)}`);
      break;
    }
    if (t.visible && t.queued) {
      fail('I1-booleans', 'visible and queued were true at once');
      break;
    }
  }

  // I2 / I4 — a landing-driven raise requires a resolved write.
  const landingRaises = transitions.filter(
    (t, i) =>
      (t.visible || t.queued) &&
      !(i > 0 && (transitions[i - 1]!.visible || transitions[i - 1]!.queued)) &&
      // Not attributable to replay(): the replay counter did not change at
      // this transition versus the previous one.
      !replayIndices.has(i) &&
      !(i === lastCeremonyHandoffIndex && transitions[i - 1]?.queued),
  );
  const raisedByLanding = landingRaises.length > 0;
  for (const t of landingRaises) {
    if (t.writesResolved === 0) {
      fail(
        'I2-write-first',
        `tour raised with ${t.writesResolved} writes resolved`,
      );
    }
  }
  if (raisedByLanding && (readModel === 'error' || writeModel === 'error')) {
    fail(
      'I4-no-fake-show',
      `tour raised despite read=${plan.read} write=${plan.write}`,
    );
  }

  // I3 — never visible while a ceremony shows.
  for (const t of transitions) {
    if (t.visible && t.ceremonyShowing) {
      fail('I3-no-overlap', 'tour became visible while a ceremony was showing');
      break;
    }
  }

  // I7 / I8 — writes. Once the record is durably written and readable, no
  // later landing may write it again (a failed or unreadable write is
  // legitimately retried by the next landing).
  if (db.writesAfterPersist > 0 && plan.read === 'ok') {
    fail(
      'I7-single-write',
      `${db.writesAfterPersist} record write(s) after the record was already persisted`,
    );
  }
  for (const w of db.writes) {
    if (w.key !== WALKTHROUGH_KV_KEY || w.value !== WALKTHROUGH_SEEN_VALUE) {
      fail('I7-single-write', `unexpected write ${w.key}=${w.value}`);
    }
  }
  const kvAfter = db.kv.get(WALKTHROUGH_KV_KEY) ?? null;
  if (kvAfter !== null && kvAfter !== WALKTHROUGH_SEEN_VALUE) {
    fail('I8-no-corrupt', `kv holds ${kvAfter}`);
  }

  // I9 — oracle for the landing wave (ignoring interleave side effects).
  const registrationBroken =
    plan.target === 'subscribe-throws' || plan.target === 'is-showing-throws';
  if (!registrationBroken) {
    // A replay() that lands before the serialized landing starts makes the
    // landing a no-op (`visible` already true) — no read, no write.
    const replayPreempted =
      plan.interleaveTiming === 'sync' && plan.interleave === 'replay';
    const expectRaise = readModel === 'absent' && writeModel === 'ok';
    // `getDb()` throwing on the write path means setKv is never reached.
    const expectWrite =
      readModel === 'absent' &&
      !replayPreempted &&
      plan.write !== 'getdb-throw-on-write';
    if (expectWrite !== db.writes.length > 0) {
      fail(
        'I9-oracle',
        `expected write=${expectWrite}, saw ${db.writes.length} writes`,
      );
    }
    if (expectRaise !== raisedByLanding && plan.interleave === 'none') {
      fail(
        'I9-oracle',
        `expected landing raise=${expectRaise}, saw ${raisedByLanding}`,
      );
    }
    if (!expectRaise && plan.interleave === 'none' && !expectHang) {
      const s = api();
      if (s.visible || s.queued) {
        fail(
          'I9-oracle',
          `store not idle after skip: visible=${s.visible} queued=${s.queued}`,
        );
      }
    }
  }

  // I10 — a user dismiss with nothing after it stays dismissed.
  if (
    dismissals > 0 &&
    lastDismissIndex > lastReplayIndex &&
    lastDismissIndex > lastCeremonyHandoffIndex &&
    plan.interleave !== 'target-dismisses'
  ) {
    const later = transitions.slice(lastDismissIndex);
    // The dismiss itself appears as a transition (visible=false). Anything
    // after it that raises the tour undid the user's dismiss.
    if (later.some((t, i) => i > 0 && t.visible)) {
      fail(
        'I10-dismiss-final',
        'tour re-raised after the user dismissed it during the in-flight landing',
      );
    }
  }

  // I12 — second wave after the fault clears.
  let secondWaveOk = true;
  if (plan.secondWave) {
    db.heal();
    for (const t of targets) t.showing = false;
    api().dismiss();
    const writesBefore = db.writes.length;
    const recordPresent = db.kv.has(WALKTHROUGH_KV_KEY);
    const second: Landing = { state: 'pending', reason: null };
    api()
      .maybeShowFirstRun()
      .then(
        () => {
          second.state = 'resolved';
        },
        reason => {
          second.state = 'rejected';
          second.reason = reason;
        },
      );
    await jest.advanceTimersByTimeAsync(SIXTY_SECONDS);
    await flushMicrotasks();
    const s = api();
    if (plan.target === 'is-showing-throws') {
      // raise() throws again on a record-absent device; covered by I11.
    } else if (second.state !== 'resolved') {
      secondWaveOk = false;
      fail('I12-second-wave', `second landing ${second.state}`);
    } else if (recordPresent) {
      if (s.visible || db.writes.length !== writesBefore) {
        secondWaveOk = false;
        fail(
          'I12-second-wave',
          'record present but tour re-shown or re-written',
        );
      }
    } else if (!s.visible || db.writes.length !== writesBefore + 1) {
      secondWaveOk = false;
      fail(
        'I12-second-wave',
        `record absent after fault but healed landing gave visible=${s.visible} writes=${db.writes.length - writesBefore}`,
      );
    }
  }
  void secondWaveOk;

  // Cleanup: release hung promises so the isolated module can be collected.
  for (const d of db.hung) d.reject(new Error('iteration over'));
  await flushMicrotasks();
  unsubscribeLog();
  for (const u of unsubscribes) {
    try {
      u();
    } catch {
      // subscribe-returns-undefined: unsubscribe is not callable — the
      // registration fault, not the store's; recorded via the plan.
    }
  }
  jest.useRealTimers();

  const terminal = api();
  return {
    ...plan,
    ok: failures.length === 0,
    failures,
    terminal: { visible: terminal.visible, queued: terminal.queued },
    writes: db.writes.length,
    readCalls: db.readCalls,
    landingsSettled: landings.filter(l => l.state === 'resolved').length,
    landingsRejected: landings.filter(l => l.state === 'rejected').length,
    landingsPending: landings.filter(l => l.state === 'pending').length,
    raisedByLanding,
    registrationThrew,
    kvAfter,
  };
}

// ── campaign ──────────────────────────────────────────────────────────────

afterAll(() => {
  const failed = results.filter(r => !r.ok);
  const byInvariant: Record<string, number[]> = {};
  const byCell: Record<string, { executed: number; failed: number }> = {};
  for (const r of results) {
    for (const f of r.failures) (byInvariant[f.invariant] ??= []).push(r.seed);
    const cell = `read=${r.read}|write=${r.write}|target=${r.target}|inter=${r.interleave}@${r.interleaveTiming}`;
    byCell[cell] ??= { executed: 0, failed: 0 };
    byCell[cell]!.executed += 1;
    if (!r.ok) byCell[cell]!.failed += 1;
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    unit: 'apps/mobile/src/walkthrough/walkthroughStore.ts',
    lens: 'failure-injection',
    iterations: ITERATIONS,
    onlySeed: ONLY_SEED,
    executed: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    wallMs: Date.now() - wallStart,
    byInvariant: Object.fromEntries(
      Object.entries(byInvariant).map(([k, v]) => [
        k,
        { count: v.length, seeds: v.slice(0, 50) },
      ]),
    ),
    cellsCovered: Object.keys(byCell).length,
    faultsCovered: {
      read: [...new Set(results.map(r => r.read))].sort(),
      write: [...new Set(results.map(r => r.write))].sort(),
      target: [...new Set(results.map(r => r.target))].sort(),
      interleave: [...new Set(results.map(r => r.interleave))].sort(),
    },
    rows: results,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'walkthrough-failure-injection.json'),
    JSON.stringify(summary, null, 2),
  );
});

describe('walkthroughStore failure injection (seeded)', () => {
  it.each(seeds())('seed %i', async seed => {
    const row = await runIteration(planFor(seed));
    results.push(row);
    const knownGaps = new Set<string>(
      (process.env.STRESS_KNOWN_GAPS ?? '').split(',').filter(Boolean),
    );
    const hard = row.failures.filter(f => !knownGaps.has(f.invariant));
    expect(hard).toEqual([]);
  });
});

// ── minimized reproductions ─────────────────────────────────────────────────

describe('walkthroughStore failure injection (minimized)', () => {
  const okDb = () => ({
    kv: new Map<string, string>(),
    handle() {
      const kv = this.kv;
      return {
        execute: (sql: string, params: unknown[] = []) => {
          if (sql.startsWith('SELECT value FROM kv')) {
            const v = kv.get(String(params[0]));
            return Promise.resolve({
              rows: v === undefined ? [] : [{ value: v }],
            });
          }
          kv.set(String(params[0]), String(params[1]));
          return Promise.resolve({ rows: [] });
        },
        close() {},
      };
    },
  });

  // Campaign seeds 1003, 1004, 1044 (STRESS_SEED=1044) — I11-no-reject.
  it('a yield target that throws from isShowing does not reject the landing or escape replay()', async () => {
    const db = okDb();
    mockGetDb = () => db.handle();
    let store!: Store;
    jest.isolateModules(() => {
      store = require('../../src/walkthrough/walkthroughStore') as Store;
    });
    store.walkthroughYieldsTo({
      isShowing: () => {
        throw new Error('ceremony store unavailable');
      },
      subscribe: () => () => {},
    });

    const landing = store.useWalkthroughStore.getState().maybeShowFirstRun();
    await expect(landing).resolves.toBeUndefined();
    // The record was already written when raise() blew up, so this device
    // will never be offered the first-run tour again.
    expect(db.kv.get(store.WALKTHROUGH_KV_KEY)).toBe(
      store.WALKTHROUGH_SEEN_VALUE,
    );
    expect(() => store.useWalkthroughStore.getState().replay()).not.toThrow();
  });

  // Campaign seeds 1268, 1271 (STRESS_SEED=1268) — I10-dismiss-final.
  it('a dismiss during a slow first-run write is not undone when the write lands', async () => {
    jest.useFakeTimers();
    const db = okDb();
    let writeStarted = false;
    mockGetDb = () => {
      const h = db.handle();
      return {
        execute: (sql: string, params: unknown[] = []) => {
          if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
            writeStarted = true;
            return new Promise(resolve => {
              setTimeout(() => resolve(h.execute(sql, params)), 5_000);
            });
          }
          return h.execute(sql, params);
        },
        close() {},
      };
    };
    let store!: Store;
    jest.isolateModules(() => {
      store = require('../../src/walkthrough/walkthroughStore') as Store;
    });
    const api = () => store.useWalkthroughStore.getState();

    const landing = api().maybeShowFirstRun();
    await flushMicrotasks(8);
    expect(writeStarted).toBe(true);
    expect(api().visible).toBe(false);

    // While the write is still in flight the user opens Settings → replay,
    // walks the tour, and dismisses it.
    api().replay();
    expect(api().visible).toBe(true);
    api().dismiss();
    expect(api().visible).toBe(false);

    await jest.advanceTimersByTimeAsync(SIXTY_SECONDS);
    await landing;
    jest.useRealTimers();

    expect(db.kv.get(store.WALKTHROUGH_KV_KEY)).toBe(
      store.WALKTHROUGH_SEEN_VALUE,
    );
    // The user has just seen and dismissed the tour; the landing must not
    // put it straight back on screen.
    expect(api().visible).toBe(false);
  });
});
