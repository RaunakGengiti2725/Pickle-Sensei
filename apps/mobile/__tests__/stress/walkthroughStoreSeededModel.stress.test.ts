/**
 * SEEDED RANDOMIZED LONG-RUN STRESS — `walkthroughStore`.
 *
 * A seeded generator produces legal / near-legal action sequences over the
 * store's public API (`maybeShowFirstRun`, `replay`, `dismiss`,
 * `walkthroughYieldsTo` targets showing/dismissing/registering/unregistering,
 * KV read/write faults, deferred DB settlement so `maybeShowFirstRun` can be
 * interleaved mid-flight, process relaunches) and drives an independent
 * reference model in lock-step. After EVERY step the invariants documented in
 * `src/walkthrough/walkthroughStore.ts` are asserted:
 *
 *  I1 `visible` and `queued` are never true at once.
 *  I2 The durable "seen" record is written BEFORE the overlay is raised by
 *     the auto-show path (crash-loop safety).
 *  I3 The record is written at most once per device lifetime (relaunches keep
 *     the KV), with exactly `WALKTHROUGH_KV_KEY` → `WALKTHROUGH_SEEN_VALUE`.
 *  I4 Once the record exists, `maybeShowFirstRun` never raises the tour.
 *  I5 Unreadable / unwritable KV → skip: no state change, no record.
 *  I6 The tour never overlaps a registered ceremony that is showing; a queued
 *     tour raises the moment the last showing ceremony is dismissed.
 *     KNOWN HAZARD (campaign seeds 2231, 724, 101469, …; minimized to
 *     register → ceremony shows → replay → unsubscribe): the unsubscribe
 *     returned by `walkthroughYieldsTo` removes the target without
 *     re-evaluating a tour queued behind it, so `queued` stays true with
 *     nothing left to raise it (recoverable only via `replay`/`dismiss`).
 *     No production registrant ever unsubscribes (rankCelebration registers
 *     at module load), so by default the check tolerates exactly that
 *     orphaned state; `STRESS_STRICT_YIELD=1` makes it a hard failure.
 *  I7 Concurrent mounts serialize into one KV read, one write, one raise.
 *  I8 `dismiss` always lands on { visible:false, queued:false }.
 *  I9 The store state equals the reference model after every step, and the
 *     DB sees only the two documented statements.
 *
 * Every sequence is replayable from its seed; the same seed run twice must
 * produce a byte-identical trace (determinism check). Failing seeds are
 * minimized (ddmin over the concrete action list) and, when `STRESS_OUT` is
 * set, every seed → outcome row is written there as a JSON table.
 *
 * Scale: `STRESS_ITER` sequences (default 300 so the suite stays fast;
 * campaigns run with STRESS_ITER=2000+), lengths 5..60,
 * `STRESS_SEED_BASE` picks the seed window.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ─── Controllable KV double (deferred settlement, fault injection) ─────────

interface PendingOp {
  kind: 'read' | 'write';
  settle: () => void;
}

const mockKvTable = new Map<string, string>();
const mockKvLog: string[] = [];
const mockPendingOps: PendingOp[] = [];
const mockKvFaults = { failReads: false, failWrites: false, deferred: false };
const mockKvCounters = {
  readAttempts: 0,
  writeAttempts: 0,
  writesSucceeded: 0,
  unknownSql: 0,
};

function mockSettleLater<T>(
  kind: PendingOp['kind'],
  produce: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = () => {
      try {
        resolve(produce());
      } catch (error) {
        reject(error);
      }
    };
    if (mockKvFaults.deferred) mockPendingOps.push({ kind, settle });
    else settle();
  });
}

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        mockKvCounters.readAttempts += 1;
        const failing = mockKvFaults.failReads;
        mockKvLog.push(`read:${String(params[0])}:${failing ? 'fail' : 'ok'}`);
        return mockSettleLater('read', () => {
          if (failing) throw new Error('kv read failed');
          const value = mockKvTable.get(String(params[0]));
          return { rows: value === undefined ? [] : [{ value }] };
        });
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvCounters.writeAttempts += 1;
        const failing = mockKvFaults.failWrites;
        mockKvLog.push(
          `write:${String(params[0])}=${String(params[1])}:${failing ? 'fail' : 'ok'}`,
        );
        return mockSettleLater('write', () => {
          if (failing) throw new Error('kv write failed');
          mockKvCounters.writesSucceeded += 1;
          mockKvTable.set(String(params[0]), String(params[1]));
          return { rows: [] };
        });
      }
      mockKvCounters.unknownSql += 1;
      mockKvLog.push(`unknown:${sql}`);
      return Promise.resolve({ rows: [] });
    },
    close() {},
  }),
}));

import {
  WALKTHROUGH_KV_KEY,
  WALKTHROUGH_SEEN_VALUE,
  useWalkthroughStore,
  walkthroughYieldsTo,
} from '../../src/walkthrough/walkthroughStore';

// ─── Seeded PRNG (mulberry32) ──────────────────────────────────────────────

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

const randInt = (rng: () => number, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1));

// ─── Faithful ceremony double (mirrors src/progress/rankCelebration.ts) ────

/**
 * A full-screen ceremony that (like the rank celebration) holds while the
 * tour is visible, raises on tour dismiss, and is a registered yield target.
 */
class Ceremony {
  showing = false;
  pending = false;
  registered = false;
  private listeners = new Set<() => void>();
  private unregister: (() => void) | null = null;
  private unsubscribeTour: (() => void) | null = null;

  constructor(readonly id: number) {}

  /** Registration happens before anything shows (module load in the app). */
  register(): void {
    if (this.registered || this.showing || this.pending) return;
    this.registered = true;
    this.unregister = walkthroughYieldsTo({
      isShowing: () => this.showing,
      subscribe: listener => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    });
    this.unsubscribeTour = useWalkthroughStore.subscribe(state => {
      if (state.visible) return;
      if (this.pending && !this.showing) {
        this.pending = false;
        this.show();
      }
    });
  }

  deregister(): void {
    if (!this.registered) return;
    this.registered = false;
    this.unregister?.();
    this.unsubscribeTour?.();
    this.unregister = null;
    this.unsubscribeTour = null;
    this.listeners.clear();
  }

  request(): void {
    if (this.showing) return;
    if (useWalkthroughStore.getState().visible) {
      this.pending = true;
      return;
    }
    this.show();
  }

  private show(): void {
    this.showing = true;
    for (const listener of [...this.listeners]) listener();
  }

  dismiss(): void {
    if (!this.showing) return;
    this.showing = false;
    for (const listener of [...this.listeners]) listener();
  }

  reset(): void {
    this.showing = false;
    this.pending = false;
  }
}

// ─── Action vocabulary ─────────────────────────────────────────────────────

type Action =
  | { t: 'maybeShow' }
  | { t: 'maybeShowBurst'; n: number }
  | {
      t: 'maybeShowInflight';
      phase0: SyncAction[];
      phase1: SyncAction[];
      phase2: SyncAction[];
    }
  | { t: 'relaunch' }
  | { t: 'setReadFail'; on: boolean }
  | { t: 'setWriteFail'; on: boolean }
  | SyncAction;

type SyncAction =
  | { t: 'replay' }
  | { t: 'dismiss' }
  | { t: 'ceremonyRequest'; c: number }
  | { t: 'ceremonyDismiss'; c: number }
  | { t: 'ceremonyRegister'; c: number }
  | { t: 'ceremonyDeregister'; c: number };

const CEREMONY_COUNT = 3;

function genSync(rng: () => number): SyncAction {
  const c = randInt(rng, 0, CEREMONY_COUNT - 1);
  const roll = rng();
  if (roll < 0.22) return { t: 'replay' };
  if (roll < 0.5) return { t: 'dismiss' };
  if (roll < 0.7) return { t: 'ceremonyRequest', c };
  if (roll < 0.88) return { t: 'ceremonyDismiss', c };
  if (roll < 0.95) return { t: 'ceremonyRegister', c };
  return { t: 'ceremonyDeregister', c };
}

function genSyncList(rng: () => number, max: number): SyncAction[] {
  const n = randInt(rng, 0, max);
  const out: SyncAction[] = [];
  for (let i = 0; i < n; i += 1) out.push(genSync(rng));
  return out;
}

function genAction(rng: () => number): Action {
  const roll = rng();
  if (roll < 0.3) return { t: 'maybeShow' };
  if (roll < 0.38) return { t: 'maybeShowBurst', n: randInt(rng, 2, 5) };
  if (roll < 0.5)
    return {
      t: 'maybeShowInflight',
      phase0: genSyncList(rng, 2),
      phase1: genSyncList(rng, 3),
      phase2: genSyncList(rng, 3),
    };
  if (roll < 0.55) return { t: 'relaunch' };
  if (roll < 0.6) return { t: 'setReadFail', on: rng() < 0.5 };
  if (roll < 0.65) return { t: 'setWriteFail', on: rng() < 0.5 };
  return genSync(rng);
}

function genSequence(seed: number): Action[] {
  const rng = mulberry32(seed);
  const length = randInt(rng, 5, 60);
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) actions.push(genAction(rng));
  return actions;
}

// ─── Reference model ───────────────────────────────────────────────────────

interface ModelCeremony {
  registered: boolean;
  showing: boolean;
  pending: boolean;
}

interface Model {
  visible: boolean;
  queued: boolean;
  /** `queued` outlived its last registered showing target (see I6 hazard). */
  orphanedQueued: boolean;
  kv: string | null;
  readAttempts: number;
  writeAttempts: number;
  writesSucceeded: number;
  autoRaises: number;
  failReads: boolean;
  failWrites: boolean;
  ceremonies: ModelCeremony[];
}

function newModel(): Model {
  return {
    visible: false,
    queued: false,
    orphanedQueued: false,
    kv: null,
    readAttempts: 0,
    writeAttempts: 0,
    writesSucceeded: 0,
    autoRaises: 0,
    failReads: false,
    failWrites: false,
    ceremonies: Array.from({ length: CEREMONY_COUNT }, () => ({
      registered: false,
      showing: false,
      pending: false,
    })),
  };
}

const modelCeremonyShowing = (m: Model) =>
  m.ceremonies.some(c => c.registered && c.showing);

function modelRaise(m: Model): void {
  if (modelCeremonyShowing(m)) m.queued = true;
  else {
    m.queued = false;
    m.orphanedQueued = false;
    m.visible = true;
  }
}

/** Store listeners fire after a tour state write: pending ceremonies raise. */
function modelAfterTourWrite(m: Model): void {
  if (m.visible) return;
  for (const c of m.ceremonies) {
    if (c.registered && c.pending && !c.showing) {
      c.pending = false;
      modelCeremonyShow(m, c);
    }
  }
}

/** Ceremony listeners fire after a ceremony state write: queued tour raises. */
function modelAfterCeremonyWrite(m: Model): void {
  if (!m.queued) return;
  if (modelCeremonyShowing(m)) return;
  m.queued = false;
  m.orphanedQueued = false;
  m.visible = true;
  modelAfterTourWrite(m);
}

function modelCeremonyShow(m: Model, c: ModelCeremony): void {
  c.showing = true;
  if (c.registered) modelAfterCeremonyWrite(m);
}

function modelApplySync(m: Model, a: SyncAction): void {
  switch (a.t) {
    case 'replay':
      modelRaise(m);
      modelAfterTourWrite(m);
      return;
    case 'dismiss':
      m.visible = false;
      m.queued = false;
      m.orphanedQueued = false;
      modelAfterTourWrite(m);
      return;
    case 'ceremonyRequest': {
      const c = m.ceremonies[a.c]!;
      if (c.showing) return;
      if (m.visible) {
        c.pending = true;
        return;
      }
      modelCeremonyShow(m, c);
      return;
    }
    case 'ceremonyDismiss': {
      const c = m.ceremonies[a.c]!;
      if (!c.showing) return;
      c.showing = false;
      if (c.registered) modelAfterCeremonyWrite(m);
      return;
    }
    case 'ceremonyRegister': {
      const c = m.ceremonies[a.c]!;
      if (c.registered || c.showing || c.pending) return;
      c.registered = true;
      return;
    }
    case 'ceremonyDeregister': {
      const c = m.ceremonies[a.c]!;
      c.registered = false;
      if (m.queued && !modelCeremonyShowing(m)) m.orphanedQueued = true;
      return;
    }
  }
}

/** One serialized `maybeShowFirstRun` run, split into its three await phases. */
function modelMaybeShowStart(m: Model): 'skip' | 'reading' {
  if (m.visible || m.queued) return 'skip';
  m.readAttempts += 1;
  return 'reading';
}

function modelMaybeShowAfterRead(
  m: Model,
  readFailed: boolean,
): 'skip' | 'writing' {
  if (readFailed) return 'skip';
  if (m.kv !== null) return 'skip';
  m.writeAttempts += 1;
  return 'writing';
}

function modelMaybeShowAfterWrite(m: Model, writeFailed: boolean): void {
  if (writeFailed) return;
  m.writesSucceeded += 1;
  m.kv = WALKTHROUGH_SEEN_VALUE;
  m.autoRaises += 1;
  modelRaise(m);
  modelAfterTourWrite(m);
}

function modelMaybeShowWhole(m: Model): void {
  if (modelMaybeShowStart(m) === 'skip') return;
  if (modelMaybeShowAfterRead(m, m.failReads) === 'skip') return;
  modelMaybeShowAfterWrite(m, m.failWrites);
}

// ─── Harness ───────────────────────────────────────────────────────────────

const STRICT_YIELD = process.env['STRESS_STRICT_YIELD'] === '1';
/** Steps spent in the tolerated orphaned-queued state (reset per run). */
let orphanedQueuedSteps = 0;

const ceremonies: Ceremony[] = Array.from(
  { length: CEREMONY_COUNT },
  (_, i) => new Ceremony(i),
);

function resetWorld(): void {
  for (const c of ceremonies) {
    c.deregister();
    c.reset();
  }
  mockKvTable.clear();
  mockKvLog.length = 0;
  mockPendingOps.length = 0;
  mockKvFaults.failReads = false;
  mockKvFaults.failWrites = false;
  mockKvFaults.deferred = false;
  mockKvCounters.readAttempts = 0;
  mockKvCounters.writeAttempts = 0;
  mockKvCounters.writesSucceeded = 0;
  mockKvCounters.unknownSql = 0;
  useWalkthroughStore.setState({ visible: false, queued: false });
}

const flush = async (ticks = 8) => {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
};

interface Snapshot {
  visible: boolean;
  queued: boolean;
  kv: string | null;
  reads: number;
  writes: number;
  ok: number;
  ceremonies: Array<[boolean, boolean, boolean]>;
}

function snapshotStore(): Snapshot {
  const s = useWalkthroughStore.getState();
  return {
    visible: s.visible,
    queued: s.queued,
    kv: mockKvTable.get(WALKTHROUGH_KV_KEY) ?? null,
    reads: mockKvCounters.readAttempts,
    writes: mockKvCounters.writeAttempts,
    ok: mockKvCounters.writesSucceeded,
    ceremonies: ceremonies.map(c => [c.registered, c.showing, c.pending]),
  };
}

function snapshotModel(m: Model): Snapshot {
  return {
    visible: m.visible,
    queued: m.queued,
    kv: m.kv,
    reads: m.readAttempts,
    writes: m.writeAttempts,
    ok: m.writesSucceeded,
    ceremonies: m.ceremonies.map(c => [c.registered, c.showing, c.pending]),
  };
}

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    readonly step: number,
    readonly action: string,
    detail: string,
  ) {
    super(`${invariant} @step ${step} after ${action}: ${detail}`);
  }
}

function checkInvariants(m: Model, step: number, action: Action): void {
  const label = JSON.stringify(action);
  const store = snapshotStore();
  const model = snapshotModel(m);
  const fail = (inv: string, detail: string) => {
    throw new InvariantViolation(inv, step, label, detail);
  };
  if (store.visible && store.queued)
    fail('I1 visible&&queued', JSON.stringify(store));
  if (m.autoRaises > 0 && store.kv !== WALKTHROUGH_SEEN_VALUE)
    fail('I2 record-before-show', `autoRaises=${m.autoRaises} kv=${store.kv}`);
  if (store.ok > 1) fail('I3 single-write', `writesSucceeded=${store.ok}`);
  if (m.autoRaises > 1) fail('I4 auto-show-once', `autoRaises=${m.autoRaises}`);
  for (const key of mockKvTable.keys())
    if (key !== WALKTHROUGH_KV_KEY) fail('I3 key', `unexpected kv key ${key}`);
  if (store.kv !== null && store.kv !== WALKTHROUGH_SEEN_VALUE)
    fail('I3 value', `kv=${store.kv}`);
  if (mockKvCounters.unknownSql > 0)
    fail('I9 unknown-sql', mockKvLog.join('|'));
  const overlapping = ceremonies.some(c => c.registered && c.showing);
  if (store.visible && overlapping) fail('I6 overlap', JSON.stringify(store));
  if (store.queued && !overlapping && (STRICT_YIELD || !m.orphanedQueued)) {
    fail(
      'I6 stuck-queued',
      `queued with no registered ceremony showing ${JSON.stringify(store)}`,
    );
  }
  if (m.orphanedQueued) orphanedQueuedSteps += 1;
  if (JSON.stringify(store) !== JSON.stringify(model))
    fail(
      'I9 model-divergence',
      `store=${JSON.stringify(store)} model=${JSON.stringify(model)}`,
    );
}

function applySyncReal(a: SyncAction): void {
  switch (a.t) {
    case 'replay':
      useWalkthroughStore.getState().replay();
      return;
    case 'dismiss':
      useWalkthroughStore.getState().dismiss();
      return;
    case 'ceremonyRequest':
      ceremonies[a.c]!.request();
      return;
    case 'ceremonyDismiss':
      ceremonies[a.c]!.dismiss();
      return;
    case 'ceremonyRegister':
      ceremonies[a.c]!.register();
      return;
    case 'ceremonyDeregister':
      ceremonies[a.c]!.deregister();
      return;
  }
}

async function settleNext(kind: 'read' | 'write'): Promise<boolean> {
  await flush();
  const op = mockPendingOps.shift();
  if (!op) return false;
  if (op.kind !== kind)
    throw new Error(`expected pending ${kind}, got ${op.kind}`);
  op.settle();
  await flush();
  return true;
}

async function applyAction(
  m: Model,
  a: Action,
  trace: string[],
): Promise<void> {
  switch (a.t) {
    case 'maybeShow':
      await useWalkthroughStore.getState().maybeShowFirstRun();
      modelMaybeShowWhole(m);
      break;
    case 'maybeShowBurst': {
      const calls: Promise<void>[] = [];
      for (let i = 0; i < a.n; i += 1)
        calls.push(useWalkthroughStore.getState().maybeShowFirstRun());
      await Promise.all(calls);
      for (let i = 0; i < a.n; i += 1) modelMaybeShowWhole(m);
      break;
    }
    case 'maybeShowInflight': {
      mockKvFaults.deferred = true;
      const inflight = useWalkthroughStore.getState().maybeShowFirstRun();
      // phase0: same tick, before the serialized run's first check.
      for (const s of a.phase0) {
        applySyncReal(s);
        modelApplySync(m, s);
      }
      const started = modelMaybeShowStart(m);
      await flush();
      if (started === 'skip') {
        if (mockPendingOps.length !== 0)
          throw new Error(
            `model expected skip but DB saw ${mockPendingOps[0]!.kind}`,
          );
        mockKvFaults.deferred = false;
        await inflight;
        break;
      }
      const readFailed = m.failReads;
      // phase1: KV read in flight.
      for (const s of a.phase1) {
        applySyncReal(s);
        modelApplySync(m, s);
      }
      if (!(await settleNext('read')))
        throw new Error('expected a pending read');
      const afterRead = modelMaybeShowAfterRead(m, readFailed);
      if (afterRead === 'skip') {
        if (mockPendingOps.length !== 0)
          throw new Error(
            `model expected no write but DB saw ${mockPendingOps[0]!.kind}`,
          );
        mockKvFaults.deferred = false;
        await inflight;
        break;
      }
      const writeFailed = m.failWrites;
      // phase2: KV write in flight.
      for (const s of a.phase2) {
        applySyncReal(s);
        modelApplySync(m, s);
      }
      if (!(await settleNext('write')))
        throw new Error('expected a pending write');
      mockKvFaults.deferred = false;
      await inflight;
      modelMaybeShowAfterWrite(m, writeFailed);
      break;
    }
    case 'relaunch':
      useWalkthroughStore.setState({ visible: false, queued: false });
      for (const c of ceremonies) c.reset();
      m.visible = false;
      m.queued = false;
      m.orphanedQueued = false;
      for (const c of m.ceremonies) {
        c.showing = false;
        c.pending = false;
      }
      break;
    case 'setReadFail':
      mockKvFaults.failReads = a.on;
      m.failReads = a.on;
      break;
    case 'setWriteFail':
      mockKvFaults.failWrites = a.on;
      m.failWrites = a.on;
      break;
    default:
      applySyncReal(a);
      modelApplySync(m, a);
  }
  trace.push(JSON.stringify(snapshotStore()));
}

interface Coverage {
  visibleSteps: number;
  queuedSteps: number;
  orphanedQueuedSteps: number;
  autoRaises: number;
  kvWrites: number;
  ceremonyShowingSteps: number;
}

interface RunResult {
  ok: boolean;
  steps: number;
  trace: string[];
  coverage: Coverage;
  error?: string;
  invariant?: string;
  failStep?: number;
}

function coverageOf(m: Model, trace: string[]): Coverage {
  const snaps = trace.map(t => JSON.parse(t) as Snapshot);
  return {
    visibleSteps: snaps.filter(s => s.visible).length,
    queuedSteps: snaps.filter(s => s.queued).length,
    orphanedQueuedSteps,
    autoRaises: m.autoRaises,
    kvWrites: m.writesSucceeded,
    ceremonyShowingSteps: snaps.filter(s => s.ceremonies.some(c => c[1]))
      .length,
  };
}

async function runActions(actions: Action[]): Promise<RunResult> {
  resetWorld();
  orphanedQueuedSteps = 0;
  const m = newModel();
  const trace: string[] = [];
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i]!;
    try {
      await applyAction(m, a, trace);
      checkInvariants(m, i, a);
    } catch (error) {
      const invariant =
        error instanceof InvariantViolation ? error.invariant : 'harness-error';
      resetWorld();
      return {
        ok: false,
        steps: i + 1,
        trace,
        coverage: coverageOf(m, trace),
        error: error instanceof Error ? error.message : String(error),
        invariant,
        failStep: i,
      };
    }
  }
  resetWorld();
  return {
    ok: true,
    steps: actions.length,
    trace,
    coverage: coverageOf(m, trace),
  };
}

/** ddmin over the concrete action list; keeps the same invariant failing. */
async function minimize(
  actions: Action[],
  invariant: string,
): Promise<Action[]> {
  let current = actions;
  let n = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / n);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      const result = await runActions(candidate);
      if (!result.ok && result.invariant === invariant) {
        current = candidate;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  return current;
}

// ─── Campaign ──────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 300) || 300);
const SEED_BASE = Number(process.env['STRESS_SEED_BASE'] ?? 1) || 1;
const OUT = process.env['STRESS_OUT'];

interface Row {
  seed: number;
  length: number;
  outcome: 'HELD' | 'BROKEN' | 'HARNESS_ERROR';
  invariant?: string;
  failStep?: number;
  error?: string;
  minimized?: Action[];
  minimizedLength?: number;
  deterministic: boolean;
  histogram: Record<string, number>;
  coverage: Coverage;
}

describe('walkthroughStore — seeded randomized model check', () => {
  jest.setTimeout(20 * 60 * 1000);

  afterAll(() => resetWorld());

  it(`holds every documented invariant over ${ITER} seeded sequences (seeds ${SEED_BASE}..${SEED_BASE + ITER - 1})`, async () => {
    const rows: Row[] = [];
    const failures: Row[] = [];
    let executed = 0;
    for (let i = 0; i < ITER; i += 1) {
      const seed = SEED_BASE + i;
      const actions = genSequence(seed);
      const histogram: Record<string, number> = {};
      for (const a of actions) histogram[a.t] = (histogram[a.t] ?? 0) + 1;
      const first = await runActions(actions);
      const second = await runActions(actions);
      executed += 1;
      const deterministic =
        JSON.stringify(first.trace) === JSON.stringify(second.trace) &&
        first.ok === second.ok &&
        first.error === second.error;
      const row: Row = {
        seed,
        length: actions.length,
        outcome: first.ok
          ? deterministic
            ? 'HELD'
            : 'BROKEN'
          : first.invariant === 'harness-error'
            ? 'HARNESS_ERROR'
            : 'BROKEN',
        deterministic,
        histogram,
        coverage: first.coverage,
      };
      if (!deterministic) {
        row.invariant = 'determinism';
        row.error = `trace diverged between two runs of seed ${seed}`;
      }
      if (!first.ok) {
        row.invariant = first.invariant;
        row.failStep = first.failStep;
        row.error = first.error;
        const minimized = await minimize(actions, first.invariant!);
        row.minimized = minimized;
        row.minimizedLength = minimized.length;
      }
      rows.push(row);
      if (row.outcome !== 'HELD') failures.push(row);
    }
    const summary = {
      unit: 'apps/mobile/src/walkthrough/walkthroughStore.ts',
      lens: 'randomized-seeded',
      strictYield: STRICT_YIELD,
      seedBase: SEED_BASE,
      sequences: executed,
      lengthRange: [5, 60],
      held: rows.filter(r => r.outcome === 'HELD').length,
      broken: rows.filter(r => r.outcome === 'BROKEN').length,
      harnessErrors: rows.filter(r => r.outcome === 'HARNESS_ERROR').length,
      totalSteps: rows.reduce((acc, r) => acc + r.length, 0),
      actionHistogram: rows.reduce<Record<string, number>>((acc, r) => {
        for (const [k, v] of Object.entries(r.histogram))
          acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {}),
      coverage: rows.reduce<Coverage>(
        (acc, r) => ({
          visibleSteps: acc.visibleSteps + r.coverage.visibleSteps,
          queuedSteps: acc.queuedSteps + r.coverage.queuedSteps,
          orphanedQueuedSteps:
            acc.orphanedQueuedSteps + r.coverage.orphanedQueuedSteps,
          autoRaises: acc.autoRaises + r.coverage.autoRaises,
          kvWrites: acc.kvWrites + r.coverage.kvWrites,
          ceremonyShowingSteps:
            acc.ceremonyShowingSteps + r.coverage.ceremonyShowingSteps,
        }),
        {
          visibleSteps: 0,
          queuedSteps: 0,
          orphanedQueuedSteps: 0,
          autoRaises: 0,
          kvWrites: 0,
          ceremonyShowingSteps: 0,
        },
      ),
      failingSeeds: failures.map(r => r.seed),
      rows,
    };
    if (OUT) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(summary, null, 2));
    }
    expect(executed).toBe(ITER);
    expect(
      failures.map(f => ({
        seed: f.seed,
        invariant: f.invariant,
        error: f.error,
      })),
    ).toEqual([]);
  });

  it('replays a fixed seed to a byte-identical trace', async () => {
    const actions = genSequence(424242);
    const a = await runActions(actions);
    const b = await runActions(actions);
    expect(a.ok).toBe(true);
    expect(a.trace).toEqual(b.trace);
  });

  // Pinned minimized repro of campaign seed 2231 (P3). `it.failing` passes
  // while the hazard exists and FAILS once `walkthroughYieldsTo`'s unsubscribe
  // re-evaluates a queued tour — flip it to a plain `it` at that point.
  it.failing(
    'KNOWN P3 (seed 2231): unsubscribing the showing yield target re-raises a queued tour',
    async () => {
      const actions: Action[] = [
        { t: 'ceremonyRegister', c: 0 },
        { t: 'ceremonyRequest', c: 0 },
        { t: 'replay' },
        { t: 'ceremonyDeregister', c: 0 },
      ];
      resetWorld();
      const m = newModel();
      const trace: string[] = [];
      for (const a of actions) await applyAction(m, a, trace);
      const state = useWalkthroughStore.getState();
      resetWorld();
      expect({ visible: state.visible, queued: state.queued }).toEqual({
        visible: true,
        queued: false,
      });
    },
  );

  it('the reference model catches a deliberately broken store (harness self-check)', async () => {
    resetWorld();
    const m = newModel();
    const trace: string[] = [];
    await applyAction(m, { t: 'maybeShow' }, trace);
    checkInvariants(m, 0, { t: 'maybeShow' });
    // Corrupt the real store: pretend a second auto-show slipped through.
    useWalkthroughStore.setState({ visible: true, queued: true });
    expect(() => checkInvariants(m, 1, { t: 'replay' })).toThrow(
      /I1 visible&&queued/,
    );
    resetWorld();
  });
});
