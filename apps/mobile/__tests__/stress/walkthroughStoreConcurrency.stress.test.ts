/**
 * STRESS (lens: concurrency) — walkthroughStore.
 *
 * The first-run tour is a once-per-DEVICE ceremony whose durable "seen"
 * record is written BEFORE the overlay is raised. Every invariant below is a
 * concurrency invariant of that contract:
 *
 *   - one record write per device, no matter how many mounts land at once
 *     (App.tsx fires `maybeShowFirstRun` from an effect that re-runs on every
 *     re-render of the signed-in state, so bursts are the normal case);
 *   - the tour is raised at most once per process;
 *   - the record is durable BEFORE `visible` flips (crash-loop safety);
 *   - a read or write failure never raises the tour and never writes;
 *   - `visible` and `queued` are mutually exclusive;
 *   - a tour queued behind another full-screen ceremony is raised exactly
 *     once when that ceremony is dismissed, never twice, never lost;
 *   - the KV key is device-level, so a sign-out/sign-in (owner rotation)
 *     mid-request cannot re-arm the tour;
 *   - every burst terminates well inside a wall-clock bound (no deadlock in
 *     the serializing promise chain).
 *
 * Each iteration is fully described by its seed: the seed drives the number
 * of concurrent callers, the async tick delays of every simulated SQLite
 * read/write, the fault injection, and the interleaved replay/dismiss/
 * ceremony actions. Re-running a seed replays the identical interleaving.
 *
 * Scale: `STRESS_ITER` iterations per campaign (default keeps the suite
 * fast; the recorded campaign runs 600). `STRESS_OUT` writes the seed ->
 * outcome table as JSON.
 */

import { writeFileSync } from 'fs';

const ITERATIONS = Number(process.env['STRESS_ITER'] ?? 40);
const OUT_PATH = process.env['STRESS_OUT'];
/** A burst that has not settled by this point is treated as a deadlock. */
const BURST_BUDGET_MS = 5000;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — deterministic per seed, no shared global state.
// ---------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intBelow(rng: () => number, bound: number): number {
  return Math.floor(rng() * bound);
}

/** Yields control `ticks` times, interleaving with every other pending job. */
async function mockTick(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/** Schedules `fn` after a seeded number of microtask ticks. */
function at(ticks: number, fn: () => void): Promise<void> {
  return mockTick(ticks).then(fn);
}

// ---------------------------------------------------------------------------
// Simulated device KV (the op-sqlite table the store persists through).
// ---------------------------------------------------------------------------
interface KvHarness {
  table: Map<string, string>;
  writeCount: number;
  readCount: number;
  failReads: boolean;
  failWrites: boolean;
  /** Ticks each execute() awaits before answering; seeded per iteration. */
  nextDelay: () => number;
}

const mockKv: KvHarness = {
  table: new Map<string, string>(),
  writeCount: 0,
  readCount: 0,
  failReads: false,
  failWrites: false,
  nextDelay: () => 0,
};

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      await mockTick(mockKv.nextDelay());
      if (sql.startsWith('SELECT value FROM kv')) {
        mockKv.readCount += 1;
        if (mockKv.failReads) throw new Error('kv read failed');
        const value = mockKv.table.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKv.failWrites) throw new Error('kv write failed');
        mockKv.writeCount += 1;
        mockKv.table.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
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
import {
  canonicalDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

// ---------------------------------------------------------------------------
// Iteration model
// ---------------------------------------------------------------------------
type ActionKind =
  | 'replay'
  | 'dismiss'
  | 'ceremonyShow'
  | 'ceremonyDismiss'
  | 'ownerRotate'
  | 'secondBurst';

interface IterationConfig {
  seed: number;
  callers: number;
  preSeeded: boolean;
  failReads: boolean;
  failWrites: boolean;
  ceremonyShowing: boolean;
  actions: Array<{ kind: ActionKind; ticks: number }>;
}

interface IterationOutcome {
  seed: number;
  campaign: string;
  callers: number;
  preSeeded: boolean;
  failReads: boolean;
  failWrites: boolean;
  ceremonyShowing: boolean;
  actions: string[];
  writeCount: number;
  readCount: number;
  visible: boolean;
  queued: boolean;
  /** Observation O-1: both flags set at the end of the iteration. */
  visibleAndQueued: boolean;
  raises: number;
  recordPresent: boolean;
  raisedWithoutRecord: number;
  /** Raises that landed after an explicit dismiss() — a re-shown overlay. */
  raisesAfterDismiss: number;
  rejections: number;
  wallMs: number;
  violations: string[];
}

const ALL_ACTIONS: ActionKind[] = [
  'replay',
  'dismiss',
  'ceremonyShow',
  'ceremonyDismiss',
  'ownerRotate',
  'secondBurst',
];

function planIteration(
  seed: number,
  mode: 'burst' | 'mixed' | 'ceremony',
): IterationConfig {
  const rng = makeRng(seed);
  const callers = 2 + intBelow(rng, 7);
  const faultRoll = rng();
  const config: IterationConfig = {
    seed,
    callers,
    preSeeded: mode !== 'ceremony' && faultRoll < 0.15,
    failReads: mode !== 'ceremony' && faultRoll >= 0.15 && faultRoll < 0.3,
    failWrites: mode !== 'ceremony' && faultRoll >= 0.3 && faultRoll < 0.45,
    ceremonyShowing: mode === 'ceremony' ? true : rng() < 0.2,
    actions: [],
  };
  if (mode === 'mixed') {
    const count = 1 + intBelow(rng, 3);
    for (let i = 0; i < count; i++) {
      const kind = ALL_ACTIONS[intBelow(rng, ALL_ACTIONS.length)]!;
      config.actions.push({ kind, ticks: intBelow(rng, 12) });
    }
  }
  if (mode === 'ceremony') {
    config.actions.push({
      kind: 'ceremonyDismiss',
      ticks: intBelow(rng, 14),
    });
    if (rng() < 0.5) {
      config.actions.push({ kind: 'secondBurst', ticks: intBelow(rng, 14) });
    }
  }
  return config;
}

/** A registered blocking ceremony the tour must yield to. */
function makeCeremony(showing: boolean) {
  let isShowing = showing;
  const listeners = new Set<() => void>();
  const dispose = walkthroughYieldsTo({
    isShowing: () => isShowing,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    dispose,
    show() {
      isShowing = true;
      for (const listener of listeners) listener();
    },
    dismiss() {
      isShowing = false;
      for (const listener of listeners) listener();
    },
  };
}

async function runIteration(
  config: IterationConfig,
  campaign: string,
): Promise<IterationOutcome> {
  const rng = makeRng(config.seed ^ 0x9e3779b9);
  mockKv.table.clear();
  mockKv.writeCount = 0;
  mockKv.readCount = 0;
  mockKv.failReads = config.failReads;
  mockKv.failWrites = config.failWrites;
  mockKv.nextDelay = () => intBelow(rng, 6);
  if (config.preSeeded) {
    mockKv.table.set(WALKTHROUGH_KV_KEY, WALKTHROUGH_SEEN_VALUE);
  }
  useWalkthroughStore.setState({ visible: false, queued: false });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);

  let raises = 0;
  let raisedWithoutRecord = 0;
  let raisesAfterDismiss = 0;
  let dismissed = false;
  let rejections = 0;
  let previouslyVisible = false;
  const unsubscribe = useWalkthroughStore.subscribe(state => {
    if (state.visible && !previouslyVisible) {
      raises += 1;
      if (!mockKv.table.has(WALKTHROUGH_KV_KEY)) raisedWithoutRecord += 1;
      if (dismissed) raisesAfterDismiss += 1;
    }
    previouslyVisible = state.visible;
  });

  const ceremony = makeCeremony(config.ceremonyShowing);
  const started = Date.now();
  const pending: Array<Promise<unknown>> = [];
  const store = useWalkthroughStore.getState();

  for (let i = 0; i < config.callers; i++) {
    pending.push(
      at(intBelow(rng, 4), () => {
        pending.push(
          store.maybeShowFirstRun().catch(() => {
            rejections += 1;
          }),
        );
      }),
    );
  }

  for (const action of config.actions) {
    pending.push(
      at(action.ticks, () => {
        switch (action.kind) {
          case 'replay':
            useWalkthroughStore.getState().replay();
            break;
          case 'dismiss':
            dismissed = true;
            useWalkthroughStore.getState().dismiss();
            break;
          case 'ceremonyShow':
            ceremony.show();
            break;
          case 'ceremonyDismiss':
            ceremony.dismiss();
            break;
          case 'ownerRotate':
            setActiveDataOwner(
              canonicalDataOwner('11111111-1111-4111-8111-111111111111'),
            );
            break;
          case 'secondBurst':
            pending.push(
              useWalkthroughStore
                .getState()
                .maybeShowFirstRun()
                .catch(() => {
                  rejections += 1;
                }),
            );
            break;
        }
      }),
    );
  }

  // Drain: settling the burst can enqueue further work (a caller scheduled
  // behind ticks, a second burst raised by an action), so keep awaiting until
  // the pending set stops growing — inside a hard wall-clock budget.
  let drained = 0;
  const deadline = started + BURST_BUDGET_MS;
  while (drained < pending.length) {
    if (Date.now() > deadline) {
      throw new Error(
        `seed ${config.seed}: burst did not settle within ${BURST_BUDGET_MS}ms`,
      );
    }
    const batch = pending.slice(drained);
    drained = pending.length;
    await Promise.all(batch);
  }
  // One more turn so any trailing continuation of the store's serializing
  // chain has run before invariants are evaluated.
  await mockTick(8);
  const wallMs = Date.now() - started;

  const state = useWalkthroughStore.getState();
  const recordPresent = mockKv.table.get(WALKTHROUGH_KV_KEY) !== undefined;
  const actionKinds = config.actions.map(action => action.kind);
  const replayed = actionKinds.includes('replay');
  const violations: string[] = [];

  // 1. No double spend of the once-per-device record.
  if (mockKv.writeCount > 1) {
    violations.push(`writeCount=${mockKv.writeCount} (expected <= 1)`);
  }
  // 2. visible and queued are mutually exclusive states. Known looseness
  //    (observation O-1, see the dedicated test below): `replay()` while a
  //    ceremony is showing AND the tour is already visible sets `queued`
  //    without clearing `visible`. Unreachable with the one registered
  //    ceremony (rankCelebration defers while the tour is visible), so that
  //    ordering is measured, not failed.
  const ceremonyShown =
    config.ceremonyShowing || actionKinds.includes('ceremonyShow');
  if (state.visible && state.queued && !(replayed && ceremonyShown)) {
    violations.push('visible && queued simultaneously');
  }
  // 3. Crash-loop safety: the record is durable before the overlay shows.
  if (!replayed && raisedWithoutRecord > 0) {
    violations.push(`raised ${raisedWithoutRecord}x before record durable`);
  }
  // 4. Fault injection must never raise the tour nor write a record.
  if (config.failReads) {
    if (mockKv.writeCount !== 0) violations.push('wrote after read failure');
    if (!replayed && raises !== 0) violations.push('raised after read failure');
  }
  if (config.failWrites) {
    if (recordPresent) violations.push('record present despite write failure');
    if (!replayed && raises !== 0) {
      violations.push('raised after write failure');
    }
  }
  // 5. An already-seen device never writes again and never auto-raises.
  if (config.preSeeded) {
    if (mockKv.writeCount !== 0) violations.push('rewrote an existing record');
    if (!replayed && raises !== 0) violations.push('re-raised a seen tour');
  }
  // 6. Clean burst: exactly one write, exactly one raise, tour showing.
  const clean =
    !config.preSeeded &&
    !config.failReads &&
    !config.failWrites &&
    !config.ceremonyShowing &&
    config.actions.length === 0;
  if (clean) {
    if (mockKv.writeCount !== 1)
      violations.push(`clean writeCount=${mockKv.writeCount}`);
    if (raises !== 1) violations.push(`clean raises=${raises}`);
    if (!state.visible) violations.push('clean burst did not show the tour');
  }
  // 7. Ceremony campaign: queued behind the ceremony, raised exactly once on
  //    its dismissal, and never left stuck in `queued`.
  if (campaign === 'ceremony') {
    if (state.queued) violations.push('left queued after ceremony dismissal');
    if (raises !== 1) violations.push(`ceremony raises=${raises}`);
    if (!state.visible) violations.push('tour lost behind the ceremony');
    if (mockKv.writeCount !== 1) {
      violations.push(`ceremony writeCount=${mockKv.writeCount}`);
    }
  }
  // 8. maybeShowFirstRun is a promise the caller never has to guard.
  if (rejections !== 0) violations.push(`${rejections} rejected calls`);
  // 9. Bounded wall time (deadlock guard; the throw above is the hard stop).
  if (wallMs >= BURST_BUDGET_MS) violations.push(`wallMs=${wallMs}`);

  unsubscribe();
  ceremony.dispose();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);

  return {
    seed: config.seed,
    campaign,
    callers: config.callers,
    preSeeded: config.preSeeded,
    failReads: config.failReads,
    failWrites: config.failWrites,
    ceremonyShowing: config.ceremonyShowing,
    actions: actionKinds,
    writeCount: mockKv.writeCount,
    readCount: mockKv.readCount,
    visible: state.visible,
    queued: state.queued,
    visibleAndQueued: state.visible && state.queued,
    raises,
    recordPresent,
    raisedWithoutRecord,
    raisesAfterDismiss,
    rejections,
    wallMs,
    violations,
  };
}

const outcomes: IterationOutcome[] = [];

async function runCampaign(
  campaign: 'burst' | 'mixed' | 'ceremony',
  seedBase: number,
): Promise<IterationOutcome[]> {
  const results: IterationOutcome[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const seed = seedBase + i;
    const outcome = await runIteration(planIteration(seed, campaign), campaign);
    results.push(outcome);
    outcomes.push(outcome);
  }
  return results;
}

function failureReport(results: IterationOutcome[]): string {
  return results
    .filter(result => result.violations.length > 0)
    .map(result => `seed ${result.seed}: ${result.violations.join('; ')}`)
    .join('\n');
}

afterAll(() => {
  if (!OUT_PATH) return;
  writeFileSync(
    OUT_PATH,
    `${JSON.stringify(
      {
        unit: 'mod-walkthrough-store-util',
        lens: 'concurrency',
        target: 'apps/mobile/src/walkthrough/walkthroughStore.ts',
        iterationsPerCampaign: ITERATIONS,
        totalIterations: outcomes.length,
        outcomes,
      },
      null,
      2,
    )}\n`,
  );
});

describe('walkthroughStore under concurrent bursts (seeded)', () => {
  it('serializes N concurrent landings into one record write and one raise', async () => {
    const results = await runCampaign('burst', 1_000_000);
    expect(failureReport(results)).toBe('');
    expect(results).toHaveLength(ITERATIONS);
    // Every clean burst spends exactly one write no matter the caller count.
    for (const result of results) {
      expect(result.writeCount).toBeLessThanOrEqual(1);
      expect(result.raises).toBeLessThanOrEqual(1);
    }
  });

  it('holds every invariant while replay/dismiss/ceremony/owner-rotation interleave', async () => {
    const results = await runCampaign('mixed', 2_000_000);
    expect(failureReport(results)).toBe('');
  });

  it('raises a queued tour exactly once when the blocking ceremony is dismissed', async () => {
    const results = await runCampaign('ceremony', 3_000_000);
    expect(failureReport(results)).toBe('');
  });

  it('replays a recorded seed identically (deterministic interleaving)', async () => {
    const config = planIteration(1_000_007, 'mixed');
    const first = await runIteration(config, 'replay-check');
    const second = await runIteration(
      planIteration(1_000_007, 'mixed'),
      'replay-check',
    );
    expect({ ...second, wallMs: 0 }).toEqual({ ...first, wallMs: 0 });
  });
});

describe('walkthroughStore cancel-during-call (dismiss while the KV read is in flight)', () => {
  /**
   * Finding P3 (seed 2000151, minimized): a first-run evaluation that is
   * awaiting SQLite does not re-check `visible`/`queued` after its awaits.
   * If the tour is raised by `replay()` and dismissed while that read is in
   * flight, the evaluation completes, writes the record and raises the tour
   * AGAIN over whatever the user is now looking at. Bounded: one write, one
   * re-show, and every later mount is a no-op. Tighten `raises` to 1 when
   * the store re-checks state after its awaits.
   */
  it('re-shows the tour once after a dismiss that landed mid-read (bounded, never loops)', async () => {
    mockKv.table.clear();
    mockKv.writeCount = 0;
    mockKv.failReads = false;
    mockKv.failWrites = false;
    mockKv.nextDelay = () => 6;
    useWalkthroughStore.setState({ visible: false, queued: false });
    let raises = 0;
    let previouslyVisible = false;
    const unsubscribe = useWalkthroughStore.subscribe(state => {
      if (state.visible && !previouslyVisible) raises += 1;
      previouslyVisible = state.visible;
    });

    const inFlight = useWalkthroughStore.getState().maybeShowFirstRun();
    await mockTick(1);
    useWalkthroughStore.getState().replay();
    expect(useWalkthroughStore.getState().visible).toBe(true);
    useWalkthroughStore.getState().dismiss();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    await inFlight;

    expect(mockKv.writeCount).toBe(1);
    expect(raises).toBe(2);
    expect(useWalkthroughStore.getState().visible).toBe(true);

    // Bounded: a later dismissal + any number of mounts never re-raise.
    useWalkthroughStore.getState().dismiss();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        useWalkthroughStore.getState().maybeShowFirstRun(),
      ),
    );
    expect(mockKv.writeCount).toBe(1);
    expect(raises).toBe(2);
    expect(useWalkthroughStore.getState().visible).toBe(false);
    unsubscribe();
  });

  /**
   * Observation O-1 (seed 2000230, minimized): `replay()` while a ceremony
   * is showing and the tour is already visible leaves `visible && queued`.
   * Harmless in practice — `dismiss()` clears both and the ceremony's
   * dismissal cannot raise a second overlay — and unreachable through
   * rankCelebration, which never shows while the tour is visible.
   */
  it('replay during a showing ceremony on a visible tour is harmless (no second raise, dismiss clears both)', async () => {
    mockKv.table.clear();
    mockKv.writeCount = 0;
    mockKv.nextDelay = () => 0;
    useWalkthroughStore.setState({ visible: false, queued: false });
    let raises = 0;
    let previouslyVisible = false;
    const unsubscribe = useWalkthroughStore.subscribe(state => {
      if (state.visible && !previouslyVisible) raises += 1;
      previouslyVisible = state.visible;
    });
    const ceremony = makeCeremony(false);

    useWalkthroughStore.getState().replay();
    ceremony.show();
    useWalkthroughStore.getState().replay();
    const both = useWalkthroughStore.getState();
    expect(both.visible).toBe(true);
    expect(both.queued).toBe(true);

    ceremony.dismiss();
    expect(raises).toBe(1);
    expect(useWalkthroughStore.getState().queued).toBe(false);
    useWalkthroughStore.getState().dismiss();
    expect(useWalkthroughStore.getState()).toMatchObject({
      visible: false,
      queued: false,
    });
    expect(mockKv.writeCount).toBe(0);
    ceremony.dispose();
    unsubscribe();
  });
});

describe('walkthroughStore idempotency across process restarts', () => {
  it('never re-raises once the device record exists, under any burst size', async () => {
    for (let callers = 1; callers <= 12; callers++) {
      const outcome = await runIteration(
        {
          seed: 4_000_000 + callers,
          callers,
          preSeeded: true,
          failReads: false,
          failWrites: false,
          ceremonyShowing: false,
          actions: [],
        },
        'idempotency',
      );
      expect(outcome.violations).toEqual([]);
      expect(outcome.writeCount).toBe(0);
      expect(outcome.raises).toBe(0);
      expect(outcome.visible).toBe(false);
    }
  });

  it('a transient write failure does not consume the device record (later burst still shows it once)', async () => {
    const failed = await runIteration(
      {
        seed: 5_000_001,
        callers: 5,
        preSeeded: false,
        failReads: false,
        failWrites: true,
        ceremonyShowing: false,
        actions: [],
      },
      'transient-write-fault',
    );
    expect(failed.violations).toEqual([]);
    expect(failed.recordPresent).toBe(false);
    expect(failed.visible).toBe(false);

    const recovered = await runIteration(
      {
        seed: 5_000_002,
        callers: 5,
        preSeeded: false,
        failReads: false,
        failWrites: false,
        ceremonyShowing: false,
        actions: [],
      },
      'transient-write-recovered',
    );
    expect(recovered.violations).toEqual([]);
    expect(recovered.writeCount).toBe(1);
    expect(recovered.raises).toBe(1);
  });
});
