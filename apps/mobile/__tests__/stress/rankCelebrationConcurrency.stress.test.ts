/**
 * STRESS / concurrency — `progress/rankCelebration`.
 *
 * Drives the REAL celebration store (serialized evaluation queue, owner-scoped
 * KV record, write-before-show) through a seeded scheduler that decides, per
 * iteration, the exact interleaving of:
 *   - bursts of duplicate / near-duplicate `maybeCelebrate` calls (Promise.all),
 *   - calls issued while another evaluation is mid-flight,
 *   - owner rotation and sign-out between any two KV hops ("cancel during call"),
 *   - two accounts reporting against the same store,
 *   - walkthrough show/hide (the ceremony must queue behind the tour),
 *   - dismissals, and KV read/write failures.
 *
 * Every KV round trip is a scheduling point, so a seed fully determines the
 * schedule; `STRESS_SEED=<n> STRESS_ITER=1` replays one iteration. Default
 * iteration count is small so the suite stays cheap; `STRESS_ITER=600` runs the
 * campaign and `STRESS_REPORT_DIR=<dir>` writes the seed → outcome table.
 *
 * Invariants:
 *   L1 liveness — every call settles, no deadlock, bounded wall time.
 *   X1 exclusivity — a showing ceremony is never overwritten by another.
 *   D1 no duplicate — the same owner never celebrates the same tier twice
 *      without an intervening lower record.
 *   R1 record integrity — the durable record equals the last write (no lost
 *      update) and is always parseable.
 *   S1 signed-out — nothing is raised while the active owner is signed out.
 *   O1 owner isolation — a ceremony raised (or promoted from pending) while
 *      owner B is active never carries a summary reported for owner A, and an
 *      owner's record never holds a summary reported for another owner.
 *   P1 promotion delivery — an upward tier change that was durably recorded is
 *      also celebrated (current or pending), unless a same-owner ceremony at
 *      that tier or higher is already showing/pending.
 *
 * L1/X1/D1/R1 HELD across the campaigns and are asserted in the main test.
 * S1/O1 and P1 are BROKEN at the stated revision; they are kept as
 * `test.failing` blocks that assert the EXPECTED behaviour (a hand-minimized
 * replay each, plus the campaign-wide count) and must be flipped to plain
 * `it` once the store binds the owner at report time / re-checks it before
 * raising, and stops dropping a recorded promotion behind a showing ceremony.
 */

import {
  playerRankDivisionForRating,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  SeededRng,
  SeededScheduler,
  stressBaseSeed,
  stressIterations,
  writeStressReport,
} from '../../test-support/stress/seededScheduler';

interface MockDbState {
  table: Map<string, string>;
  scheduler: SeededScheduler | null;
  failReads: number;
  failWrites: number;
  onRead: (key: string) => void;
  onWrite: (key: string, value: string) => void;
}

const mockDb: MockDbState = {
  table: new Map(),
  scheduler: null,
  failReads: 0,
  failWrites: 0,
  onRead: () => {},
  onWrite: () => {},
};

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const key = String(params[0]);
      if (sql.startsWith('SELECT value FROM kv')) {
        await mockDb.scheduler?.hop(`kv:read:${key}`);
        if (mockDb.failReads > 0) {
          mockDb.failReads -= 1;
          throw new Error('injected read failure');
        }
        mockDb.onRead(key);
        const value = mockDb.table.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        await mockDb.scheduler?.hop(`kv:write:${key}`);
        if (mockDb.failWrites > 0) {
          mockDb.failWrites -= 1;
          throw new Error('injected write failure');
        }
        const value = String(params[1]);
        mockDb.table.set(key, value);
        mockDb.onWrite(key, value);
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import {
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
  type RankCelebration,
} from '../../src/progress/rankCelebration';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';

const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNERS = [OWNER_A, OWNER_B] as const;

type Tier = PlayerRankSummary['tier'];
const TIERS: readonly Tier[] = [
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
];
const TIER_INDEX: Record<Tier, number> = {
  bronze: 0,
  silver: 1,
  gold: 2,
  platinum: 3,
  diamond: 4,
};
const TIER_LABEL: Record<Tier, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
  diamond: 'Diamond',
};
/** [min, max] rating band per tier (shared-types thresholds 0/3.5/5/6.5/7.5). */
const TIER_BAND: Record<Tier, readonly [number, number]> = {
  bronze: [0, 3.49],
  silver: [3.5, 4.99],
  gold: [5, 6.49],
  platinum: [6.5, 7.49],
  diamond: [7.5, 10],
};

function summaryFor(tier: Tier, rating: number): PlayerRankSummary {
  const { division, label: divisionLabel } =
    playerRankDivisionForRating(rating);
  return {
    rating,
    tier,
    tierLabel: TIER_LABEL[tier],
    division,
    divisionLabel,
    techniqueCount: 2,
    scoredAnalysisCount: 4,
    techniques: [],
    nextTier:
      tier === 'diamond'
        ? null
        : {
            key: TIERS[TIER_INDEX[tier] + 1] as Tier,
            label: TIER_LABEL[TIERS[TIER_INDEX[tier] + 1] as Tier],
            minRating: TIER_BAND[TIERS[TIER_INDEX[tier] + 1] as Tier][0],
            pointsNeeded: 1,
          },
  };
}

type Event =
  | {
      t: 'call';
      id: number;
      intendedOwner: string;
      tier: Tier;
      rating: number;
      phase: 'burst' | 'step';
    }
  | { t: 'owner'; owner: string }
  | { t: 'walkthrough'; visible: boolean }
  | { t: 'dismiss' }
  | { t: 'read'; key: string }
  | {
      t: 'write';
      key: string;
      tier: Tier;
      rating: number;
      callId: number;
      activeOwner: string;
    }
  | {
      t: 'raise';
      slot: 'current' | 'pending';
      callId: number;
      intendedOwner: string;
      activeOwner: string;
      fromTier: Tier | null;
      toTier: Tier;
    }
  | { t: 'promote'; callId: number; intendedOwner: string; activeOwner: string }
  | { t: 'clear' }
  | { t: 'overwrite'; fromCallId: number; toCallId: number };

interface CallRecord {
  id: number;
  intendedOwner: string;
  summary: PlayerRankSummary;
  phase: 'burst' | 'step';
  /** The store's queue is FIFO: the first unsettled call is the running one. */
  done: boolean;
}

interface Program {
  seed: number;
  initialOwner: string;
  initialWalkthroughVisible: boolean;
  prefill: Array<{ owner: string; tier: Tier; rating: number }>;
  burst: Array<{ owner: string; tier: Tier; rating: number }>;
  steps: string[];
}

interface Violation {
  invariant: string;
  detail: string;
}

interface IterationOutcome {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  hops: number;
  calls: number;
  raises: number;
  writes: number;
  schedule: string[];
  /** L1/X1/D1/R1 (+ harness self-checks): the HELD class. */
  violations: Violation[];
  /** S1/O1: owner rotation / sign-out leaking across the queue boundary. */
  ownerIsolation: Violation[];
  /** P1 lost promotions. */
  lostPromotions: Violation[];
  program: Program;
}

function pickRating(rng: SeededRng, tier: Tier): number {
  const [min, max] = TIER_BAND[tier];
  if (rng.chance(0.25)) return min;
  if (rng.chance(0.1)) return max;
  return Math.round((min + rng.float() * (max - min)) * 100) / 100;
}

function pickOwner(rng: SeededRng, allowSignedOut: boolean): string {
  if (allowSignedOut && rng.chance(0.15)) return SIGNED_OUT_DATA_OWNER;
  return rng.chance(0.7) ? OWNER_A : OWNER_B;
}

function generateProgram(seed: number): Program {
  const rng = new SeededRng(seed);
  const initialOwner = pickOwner(rng, true);
  const prefill: Program['prefill'] = [];
  for (const owner of OWNERS) {
    if (rng.chance(0.5)) {
      const tier = rng.pick(TIERS);
      prefill.push({ owner, tier, rating: pickRating(rng, tier) });
    }
  }
  const burstCount = rng.int(2, 8);
  const burst: Program['burst'] = [];
  for (let i = 0; i < burstCount; i += 1) {
    const previous = burst[rng.int(0, Math.max(0, burst.length - 1))];
    if (previous && rng.chance(0.3)) {
      burst.push({ ...previous });
    } else {
      const tier = rng.pick(TIERS);
      burst.push({
        owner: initialOwner,
        tier,
        rating: pickRating(rng, tier),
      });
    }
  }
  const stepCount = rng.int(0, 8);
  const steps: string[] = [];
  const stepKinds = [
    'celebrate',
    'celebrate',
    'celebrate',
    'rotate',
    'rotate',
    'signout',
    'dismiss',
    'dismiss',
    'walkthrough:show',
    'walkthrough:hide',
    'fail:read',
    'fail:write',
  ] as const;
  for (let i = 0; i < stepCount; i += 1) {
    const kind = rng.pick(stepKinds);
    if (kind === 'celebrate') {
      const tier = rng.pick(TIERS);
      steps.push(`celebrate:${tier}:${pickRating(rng, tier)}`);
    } else if (kind === 'rotate') {
      steps.push(`rotate:${rng.pick(OWNERS)}`);
    } else {
      steps.push(kind);
    }
  }
  return {
    seed,
    initialOwner,
    initialWalkthroughVisible: rng.chance(0.2),
    prefill,
    burst,
    steps,
  };
}

function parseRecord(value: string): { tier: Tier; rating: number } | null {
  try {
    const parsed = JSON.parse(value) as { tier?: unknown; rating?: unknown };
    if (
      typeof parsed.tier === 'string' &&
      (TIERS as readonly string[]).includes(parsed.tier) &&
      typeof parsed.rating === 'number'
    ) {
      return { tier: parsed.tier as Tier, rating: parsed.rating };
    }
    return null;
  } catch {
    return null;
  }
}

/** Pure oracle over the event log; unit-tested below against synthetic logs. */
export function checkInvariants(
  events: readonly Event[],
  initialTable: ReadonlyMap<string, string>,
  finalTable: ReadonlyMap<string, string>,
  calls: readonly CallRecord[],
): {
  violations: Violation[];
  ownerIsolation: Violation[];
  lostPromotions: Violation[];
} {
  const violations: Violation[] = [];
  const ownerIsolation: Violation[] = [];
  const lostPromotions: Violation[] = [];
  const callById = new Map(calls.map(c => [c.id, c]));
  const keyToOwner = new Map(
    OWNERS.map(o => [rankCelebrationKeyForOwner(o), o] as const),
  );

  // X1 exclusivity
  for (const e of events) {
    if (e.t === 'overwrite') {
      violations.push({
        invariant: 'X1-exclusivity',
        detail: `current ceremony from call#${e.fromCallId} replaced by call#${e.toCallId} without dismiss`,
      });
    }
  }

  // S1 signed-out + O1 owner isolation (raise/promote)
  for (const e of events) {
    if (e.t === 'raise' || e.t === 'promote') {
      if (e.activeOwner === SIGNED_OUT_DATA_OWNER) {
        ownerIsolation.push({
          invariant: 'S1-signed-out',
          detail: `${e.t} of call#${e.callId} while signed out`,
        });
      } else if (e.activeOwner !== e.intendedOwner) {
        ownerIsolation.push({
          invariant: 'O1-owner-isolation',
          detail: `${e.t} of call#${e.callId} (reported for ${e.intendedOwner}) while ${e.activeOwner} is active`,
        });
      }
    }
  }

  // R1/O1 record integrity: a write under key(O) must carry a summary
  // reported for O.
  for (const e of events) {
    if (e.t !== 'write') continue;
    const keyOwner = keyToOwner.get(e.key);
    const call = callById.get(e.callId);
    if (!keyOwner || !call) {
      violations.push({
        invariant: 'R1-record',
        detail: `write to unknown key ${e.key} or unknown call#${e.callId}`,
      });
      continue;
    }
    if (call.intendedOwner !== keyOwner) {
      ownerIsolation.push({
        invariant: 'O1-owner-isolation',
        detail: `record of ${keyOwner} written from call#${e.callId} reported for ${call.intendedOwner}`,
      });
    }
  }

  // R1: final table equals the last write per key and parses.
  const lastWrite = new Map<string, Event & { t: 'write' }>();
  for (const e of events) if (e.t === 'write') lastWrite.set(e.key, e);
  for (const [key, value] of finalTable) {
    const parsed = parseRecord(value);
    const last = lastWrite.get(key);
    if (!parsed) {
      violations.push({
        invariant: 'R1-record',
        detail: `unparseable record under ${key}: ${value}`,
      });
    } else if (
      last &&
      (last.tier !== parsed.tier || last.rating !== parsed.rating)
    ) {
      violations.push({
        invariant: 'R1-record',
        detail: `record under ${key} is ${parsed.tier}/${parsed.rating} but the last write was ${last.tier}/${last.rating} (lost update)`,
      });
    }
  }

  // D1 no duplicate ceremony per owner: same toTier twice without a lower
  // record for that owner in between.
  for (const owner of OWNERS) {
    const key = rankCelebrationKeyForOwner(owner);
    let lastCelebrated: Tier | null = null;
    for (const e of events) {
      if (e.t === 'write' && e.key === key) {
        if (
          lastCelebrated !== null &&
          TIER_INDEX[e.tier] < TIER_INDEX[lastCelebrated]
        ) {
          lastCelebrated = null;
        }
      } else if (e.t === 'raise' && e.intendedOwner === owner) {
        if (lastCelebrated !== null && e.toTier === lastCelebrated) {
          violations.push({
            invariant: 'D1-no-duplicate',
            detail: `${owner} celebrated ${e.toTier} twice (call#${e.callId})`,
          });
        }
        lastCelebrated = e.toTier;
      }
    }
  }

  // P1 promotion delivery: a durably recorded upward tier move (relative to
  // the record it replaced, i.e. exactly what the module itself calls a
  // promotion) must raise a ceremony — unless a ceremony for that owner at
  // the same or a higher tier is already showing/pending, which covers it.
  const raisedCalls = new Set<number>();
  for (const e of events) {
    if (e.t === 'raise') raisedCalls.add(e.callId);
  }
  for (const owner of OWNERS) {
    const key = rankCelebrationKeyForOwner(owner);
    const initial = initialTable.get(key);
    let storedTier: Tier | null = initial
      ? (parseRecord(initial)?.tier ?? null)
      : null;
    let showing: { owner: string; toTier: Tier } | null = null;
    let pending: { owner: string; toTier: Tier } | null = null;
    for (const e of events) {
      if (e.t === 'raise') {
        const entry = { owner: e.intendedOwner, toTier: e.toTier };
        if (e.slot === 'current') showing = entry;
        else pending = entry;
      } else if (e.t === 'promote') {
        showing = pending;
        pending = null;
      } else if (e.t === 'clear') {
        showing = null;
      } else if (e.t === 'write' && e.key === key) {
        const promoted =
          storedTier === null || TIER_INDEX[e.tier] > TIER_INDEX[storedTier];
        const covered = [showing, pending].some(
          c =>
            c !== null &&
            c.owner === owner &&
            TIER_INDEX[c.toTier] >= TIER_INDEX[e.tier],
        );
        if (promoted && !covered && !raisedCalls.has(e.callId)) {
          lostPromotions.push({
            invariant: 'P1-promotion-delivery',
            detail: `${owner} record moved ${storedTier ?? 'none'} -> ${e.tier} (call#${e.callId}) but no ceremony was raised; showing=${showing ? `${showing.toTier}@${showing.owner === owner ? 'same-owner' : 'other-owner'}` : 'none'} pending=${pending ? `${pending.toTier}@${pending.owner === owner ? 'same-owner' : 'other-owner'}` : 'none'}`,
          });
        }
        storedTier = e.tier;
      }
    }
  }

  return { violations, ownerIsolation, lostPromotions };
}

async function runProgram(
  program: Program,
  scheduleSeed: number,
): Promise<IterationOutcome> {
  const scheduler = new SeededScheduler(scheduleSeed ^ 0x9e3779b9);
  const events: Event[] = [];
  const calls: CallRecord[] = [];
  const callBySummary = new Map<PlayerRankSummary, CallRecord>();
  const callByCelebration = (c: RankCelebration): CallRecord | undefined =>
    callBySummary.get(c.summary);

  mockDb.table.clear();
  mockDb.failReads = 0;
  mockDb.failWrites = 0;
  for (const p of program.prefill) {
    mockDb.table.set(
      rankCelebrationKeyForOwner(p.owner),
      JSON.stringify({ version: 1, tier: p.tier, rating: p.rating }),
    );
  }
  const initialTable = new Map(mockDb.table);
  useRankCelebrationStore.setState({ current: null, pending: null });
  useWalkthroughStore.setState({
    visible: program.initialWalkthroughVisible,
    queued: false,
  });
  setActiveDataOwner(program.initialOwner);
  events.push({ t: 'owner', owner: program.initialOwner });
  events.push({ t: 'walkthrough', visible: program.initialWalkthroughVisible });

  const runningCall = (): CallRecord | undefined => calls.find(c => !c.done);
  const harnessErrors: Violation[] = [];
  mockDb.onRead = key => events.push({ t: 'read', key });
  mockDb.onWrite = (key, value) => {
    const parsed = parseRecord(value);
    const running = runningCall();
    if (
      running &&
      parsed &&
      (running.summary.tier !== parsed.tier ||
        running.summary.rating !== parsed.rating)
    ) {
      harnessErrors.push({
        invariant: 'HARNESS-attribution',
        detail: `running call#${running.id} is ${running.summary.tier}/${running.summary.rating} but ${parsed.tier}/${parsed.rating} was written`,
      });
    }
    events.push({
      t: 'write',
      key,
      tier: parsed?.tier ?? 'bronze',
      rating: parsed?.rating ?? Number.NaN,
      callId: running?.id ?? -1,
      activeOwner: getActiveDataOwner(),
    });
  };

  let previous = useRankCelebrationStore.getState();
  const unsubscribe = useRankCelebrationStore.subscribe(state => {
    const owner = getActiveDataOwner();
    if (state.current !== previous.current) {
      if (state.current && previous.current) {
        events.push({
          t: 'overwrite',
          fromCallId: callByCelebration(previous.current)?.id ?? -1,
          toCallId: callByCelebration(state.current)?.id ?? -1,
        });
      } else if (state.current) {
        const call = callByCelebration(state.current);
        if (previous.pending === state.current) {
          events.push({
            t: 'promote',
            callId: call?.id ?? -1,
            intendedOwner: call?.intendedOwner ?? 'unknown',
            activeOwner: owner,
          });
        } else {
          events.push({
            t: 'raise',
            slot: 'current',
            callId: call?.id ?? -1,
            intendedOwner: call?.intendedOwner ?? 'unknown',
            activeOwner: owner,
            fromTier: state.current.fromTier,
            toTier: state.current.toTier,
          });
        }
      } else {
        events.push({ t: 'clear' });
      }
    }
    if (state.pending !== previous.pending && state.pending) {
      const call = callByCelebration(state.pending);
      events.push({
        t: 'raise',
        slot: 'pending',
        callId: call?.id ?? -1,
        intendedOwner: call?.intendedOwner ?? 'unknown',
        activeOwner: owner,
        fromTier: state.pending.fromTier,
        toTier: state.pending.toTier,
      });
    }
    previous = state;
  });

  const { maybeCelebrate, dismiss } = useRankCelebrationStore.getState();
  const issue = (
    tier: Tier,
    rating: number,
    phase: 'burst' | 'step',
  ): Promise<void> => {
    const summary = summaryFor(tier, rating);
    const call: CallRecord = {
      id: calls.length,
      intendedOwner: getActiveDataOwner(),
      summary,
      phase,
      done: false,
    };
    calls.push(call);
    callBySummary.set(summary, call);
    events.push({
      t: 'call',
      id: call.id,
      intendedOwner: call.intendedOwner,
      tier,
      rating,
      phase,
    });
    const promise = maybeCelebrate(summary);
    const markDone = () => {
      call.done = true;
    };
    promise.then(markDone, markDone);
    return scheduler.track(promise);
  };

  mockDb.scheduler = scheduler;
  const settled: Promise<void>[] = [];
  try {
    // Burst: duplicate + interleaved calls issued in one synchronous tick.
    settled.push(
      Promise.all(
        program.burst.map(b => issue(b.tier, b.rating, 'burst')),
      ).then(() => {}),
    );
    // Actor steps: parked, released wherever the schedule decides.
    for (const step of program.steps) {
      settled.push(
        scheduler.step(`actor:${step}`, () => {
          if (step.startsWith('celebrate:')) {
            const [, tier, rating] = step.split(':') as [string, Tier, string];
            void issue(tier, Number(rating), 'step');
          } else if (step.startsWith('rotate:')) {
            const owner = step.slice('rotate:'.length);
            setActiveDataOwner(owner);
            events.push({ t: 'owner', owner });
          } else if (step === 'signout') {
            setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
            events.push({ t: 'owner', owner: SIGNED_OUT_DATA_OWNER });
          } else if (step === 'dismiss') {
            events.push({ t: 'dismiss' });
            dismiss();
          } else if (step === 'walkthrough:show') {
            // Mirrors walkthroughStore.raise(): the tour queues behind a
            // showing ceremony instead of covering it.
            if (useRankCelebrationStore.getState().current) {
              useWalkthroughStore.setState({ queued: true });
            } else {
              events.push({ t: 'walkthrough', visible: true });
              useWalkthroughStore.setState({ visible: true, queued: false });
            }
          } else if (step === 'walkthrough:hide') {
            events.push({ t: 'walkthrough', visible: false });
            useWalkthroughStore.setState({ visible: false, queued: false });
          } else if (step === 'fail:read') {
            mockDb.failReads += 1;
          } else if (step === 'fail:write') {
            mockDb.failWrites += 1;
          }
        }),
      );
    }
    await scheduler.drain(5000);
    await Promise.all(settled);
  } finally {
    unsubscribe();
    mockDb.scheduler = null;
    mockDb.onRead = () => {};
    mockDb.onWrite = () => {};
  }

  const { violations, ownerIsolation, lostPromotions } = checkInvariants(
    events,
    initialTable,
    mockDb.table,
    calls,
  );
  violations.push(...harnessErrors);
  return {
    seed: program.seed,
    outcome:
      violations.length + ownerIsolation.length + lostPromotions.length === 0
        ? 'HELD'
        : 'BROKEN',
    hops: scheduler.hopCount,
    calls: calls.length,
    raises: events.filter(e => e.t === 'raise').length,
    writes: events.filter(e => e.t === 'write').length,
    schedule: [...scheduler.schedule],
    violations,
    ownerIsolation,
    lostPromotions,
    program,
  };
}

function runIteration(seed: number): Promise<IterationOutcome> {
  return runProgram(generateProgram(seed), seed);
}

/**
 * Minimization helper: the smallest schedule seed (0..limit) under which the
 * hand-minimized program produces the interleaving `matches` describes.
 */
async function findScheduleSeed(
  program: Program,
  matches: (outcome: IterationOutcome) => boolean,
  limit = 256,
): Promise<{ seed: number; outcome: IterationOutcome } | null> {
  for (let seed = 0; seed < limit; seed += 1) {
    const outcome = await runProgram(program, seed);
    if (matches(outcome)) return { seed, outcome };
  }
  return null;
}

function describeViolations(list: readonly Violation[]): string {
  return list
    .map(
      v =>
        `${v.invariant}: ${v.detail
          .replaceAll(OWNER_A, 'A')
          .replaceAll(OWNER_B, 'B')}`,
    )
    .join(' | ');
}

const ITERATIONS = stressIterations(40);
const BASE_SEED = stressBaseSeed(1000);

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useRankCelebrationStore.setState({ current: null, pending: null });
  useWalkthroughStore.setState({ visible: false, queued: false });
});

describe('rankCelebration concurrency stress (seeded scheduler)', () => {
  const outcomes: IterationOutcome[] = [];

  afterAll(() => {
    const held = outcomes.filter(o => o.outcome === 'HELD').length;
    const report = {
      suite: 'rankCelebrationConcurrency',
      iterations: outcomes.length,
      baseSeed: BASE_SEED,
      held,
      broken: outcomes.length - held,
      heldClassBrokenSeeds: outcomes
        .filter(o => o.violations.length > 0)
        .map(o => o.seed),
      ownerIsolationSeeds: outcomes
        .filter(o => o.ownerIsolation.length > 0)
        .map(o => o.seed),
      lostPromotionSeeds: outcomes
        .filter(o => o.lostPromotions.length > 0)
        .map(o => o.seed),
      totalHops: outcomes.reduce((n, o) => n + o.hops, 0),
      totalCalls: outcomes.reduce((n, o) => n + o.calls, 0),
      rows: outcomes.map(o => ({
        seed: o.seed,
        outcome: o.outcome,
        hops: o.hops,
        calls: o.calls,
        raises: o.raises,
        writes: o.writes,
        violations: o.violations,
        ownerIsolation: o.ownerIsolation,
        lostPromotions: o.lostPromotions,
        schedule: o.schedule.join('>'),
        program: o.program,
      })),
    };
    writeStressReport('rankCelebrationConcurrency.json', report);
  });

  it(`HELD invariants L1/X1/D1/R1 across ${ITERATIONS} seeded interleavings`, async () => {
    const failures: string[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + i;
      const outcome = await runIteration(seed);
      outcomes.push(outcome);
      if (outcome.violations.length > 0) {
        failures.push(
          `seed=${seed} ${describeViolations(outcome.violations)} schedule=${outcome.schedule.join('>')}`,
        );
      }
    }
    expect(outcomes).toHaveLength(ITERATIONS);
    // Every iteration that had anything to schedule actually interleaved.
    expect(
      outcomes.every(
        o =>
          o.hops > 0 ||
          (o.program.initialOwner === SIGNED_OUT_DATA_OWNER &&
            o.program.steps.length === 0),
      ),
    ).toBe(true);
    expect(failures).toEqual([]);
  }, 120_000);

  // BROKEN at 1fb0efd7 (see header). `test.failing` asserts the EXPECTED
  // behaviour and passes only while it is violated by at least one seed.
  test.failing(
    `S1/O1 owner isolation across ${ITERATIONS} seeded interleavings`,
    () => {
      expect(outcomes).toHaveLength(ITERATIONS);
      expect(
        outcomes
          .filter(o => o.ownerIsolation.length > 0)
          .map(o => `seed=${o.seed} ${describeViolations(o.ownerIsolation)}`),
      ).toEqual([]);
    },
  );

  test.failing(
    `P1 promotion delivery: a recorded upward tier move is celebrated (${ITERATIONS} seeds)`,
    () => {
      expect(outcomes).toHaveLength(ITERATIONS);
      expect(
        outcomes
          .filter(o => o.lostPromotions.length > 0)
          .map(o => `seed=${o.seed} ${describeViolations(o.lostPromotions)}`),
      ).toEqual([]);
    },
  );

  it('is replayable: the same seed yields the same schedule and outcome', async () => {
    const a = await runIteration(BASE_SEED + 7);
    const b = await runIteration(BASE_SEED + 7);
    expect(b.schedule).toEqual(a.schedule);
    expect(b.violations).toEqual(a.violations);
    expect(b.ownerIsolation).toEqual(a.ownerIsolation);
    expect(b.lostPromotions).toEqual(a.lostPromotions);
    const c = await runIteration(BASE_SEED + 8);
    expect(c.schedule.join('>')).not.toEqual(a.schedule.join('>'));
  });
});

/**
 * Hand-minimized replays of the two BROKEN classes. Each fixes the program
 * and searches the smallest schedule seed that realises the interleaving, so
 * the failure is reproducible from `(program, scheduleSeed)` alone and the
 * `test.failing` block reports exactly what happened.
 */
describe('minimized replays (BROKEN at 1fb0efd7)', () => {
  const minimized: Array<{
    name: string;
    scheduleSeed: number;
    outcome: IterationOutcome;
  }> = [];

  afterAll(() => {
    writeStressReport(
      'rankCelebrationMinimized.json',
      minimized.map(m => ({
        name: m.name,
        scheduleSeed: m.scheduleSeed,
        program: m.outcome.program,
        schedule: m.outcome.schedule.join('>'),
        violations: m.outcome.violations,
        ownerIsolation: m.outcome.ownerIsolation,
        lostPromotions: m.outcome.lostPromotions,
      })),
    );
  });

  const noSteps = (
    seed: number,
    initialOwner: string,
    burst: Program['burst'],
    steps: string[] = [],
  ): Program => ({
    seed,
    initialOwner,
    initialWalkthroughVisible: false,
    prefill: [],
    burst,
    steps,
  });

  const keyA = rankCelebrationKeyForOwner(OWNER_A);

  // P1 — two reports for one owner in a single tick, first Silver (placement),
  // then Gold. The Silver placement is showing when the Gold evaluation runs;
  // the Gold record is written, the ceremony is dropped, and nothing ever
  // raises it.
  const p1Program = noSteps(1, OWNER_A, [
    { owner: OWNER_A, tier: 'silver', rating: 3.5 },
    { owner: OWNER_A, tier: 'gold', rating: 5 },
  ]);

  it('P1 replay: preconditions (record advanced to Gold, HELD class clean)', async () => {
    const outcome = await runProgram(p1Program, 0);
    minimized.push({ name: 'P1', scheduleSeed: 0, outcome });
    expect(outcome.violations).toEqual([]);
    expect(outcome.ownerIsolation).toEqual([]);
    expect(mockDb.table.get(keyA)).toBe(
      JSON.stringify({ version: 1, tier: 'gold', rating: 5 }),
    );
    expect(outcome.raises).toBe(1);
  });

  test.failing(
    'P1 replay: the recorded Silver→Gold promotion is celebrated',
    async () => {
      const outcome = await runProgram(p1Program, 0);
      expect(outcome.lostPromotions.map(v => v.detail)).toEqual([]);
    },
  );

  // O1 — two reports for B are issued in one tick; the owner switches to A
  // while the first is inside its KV round trips. The second run binds
  // `getActiveDataOwner()` at run start (rankCelebration.ts), so it writes
  // B's summary under A's key and raises a ceremony while A is active.
  const o1Program = noSteps(
    2,
    OWNER_B,
    [
      { owner: OWNER_B, tier: 'silver', rating: 4 },
      { owner: OWNER_B, tier: 'diamond', rating: 8 },
    ],
    [`rotate:${OWNER_A}`],
  );
  const o1Interleaved = (o: IterationOutcome): boolean => {
    const rotate = o.schedule.indexOf(`actor:rotate:${OWNER_A}`);
    const readA = o.schedule.indexOf(`kv:read:${keyA}`);
    return rotate >= 0 && readA > rotate;
  };

  it('O1 replay: preconditions (a schedule seed realises the switch mid-queue)', async () => {
    const found = await findScheduleSeed(o1Program, o1Interleaved);
    expect(found).not.toBeNull();
    minimized.push({
      name: 'O1',
      scheduleSeed: found!.seed,
      outcome: found!.outcome,
    });
    expect(found!.outcome.violations).toEqual([]);
    expect(found!.outcome.calls).toBe(2);
  });

  test.failing(
    'O1 replay: a report issued for B is never recorded under A or shown to A',
    async () => {
      const found = await findScheduleSeed(o1Program, o1Interleaved);
      expect(found).not.toBeNull();
      expect(mockDb.table.has(keyA)).toBe(false);
      expect(found!.outcome.ownerIsolation.map(v => v.detail)).toEqual([]);
    },
  );

  // S1 — one report for A; sign-out lands between the owner re-check that
  // guards the write and the `set({ current })` after it.
  const s1Program = noSteps(
    3,
    OWNER_A,
    [{ owner: OWNER_A, tier: 'gold', rating: 5 }],
    ['signout'],
  );
  const s1Interleaved = (o: IterationOutcome): boolean => {
    const read = o.schedule.indexOf(`kv:read:${keyA}`);
    const signout = o.schedule.indexOf('actor:signout');
    const write = o.schedule.indexOf(`kv:write:${keyA}`);
    return read >= 0 && signout > read && write > signout;
  };

  it('S1 replay: preconditions (a schedule seed lands sign-out inside the write)', async () => {
    const found = await findScheduleSeed(s1Program, s1Interleaved);
    expect(found).not.toBeNull();
    minimized.push({
      name: 'S1',
      scheduleSeed: found!.seed,
      outcome: found!.outcome,
    });
    expect(found!.outcome.violations).toEqual([]);
    expect(mockDb.table.get(keyA)).toBe(
      JSON.stringify({ version: 1, tier: 'gold', rating: 5 }),
    );
  });

  test.failing(
    'S1 replay: no ceremony is raised once the active owner is signed out',
    async () => {
      const found = await findScheduleSeed(s1Program, s1Interleaved);
      expect(found).not.toBeNull();
      expect(found!.outcome.ownerIsolation.map(v => v.detail)).toEqual([]);
      expect(useRankCelebrationStore.getState().current).toBeNull();
    },
  );
});

describe('oracle self-check (synthetic logs)', () => {
  const keyA = rankCelebrationKeyForOwner(OWNER_A);
  const callA: CallRecord = {
    id: 0,
    intendedOwner: OWNER_A,
    summary: summaryFor('gold', 5.2),
    phase: 'burst',
    done: true,
  };
  const callB: CallRecord = {
    id: 1,
    intendedOwner: OWNER_B,
    summary: summaryFor('gold', 5.2),
    phase: 'burst',
    done: true,
  };

  it('flags a duplicate ceremony, a cross-owner raise and a lost promotion', () => {
    const events: Event[] = [
      { t: 'owner', owner: OWNER_A },
      {
        t: 'write',
        key: keyA,
        tier: 'gold',
        rating: 5.2,
        callId: 0,
        activeOwner: OWNER_A,
      },
      {
        t: 'raise',
        slot: 'current',
        callId: 0,
        intendedOwner: OWNER_A,
        activeOwner: OWNER_A,
        fromTier: null,
        toTier: 'gold',
      },
      {
        t: 'raise',
        slot: 'current',
        callId: 0,
        intendedOwner: OWNER_A,
        activeOwner: OWNER_B,
        fromTier: 'silver',
        toTier: 'gold',
      },
      {
        t: 'write',
        key: keyA,
        tier: 'platinum',
        rating: 6.6,
        callId: 1,
        activeOwner: OWNER_A,
      },
    ];
    const table = new Map([
      [keyA, JSON.stringify({ tier: 'platinum', rating: 6.6 })],
    ]);
    const result = checkInvariants(events, new Map(), table, [callA, callB]);
    expect(result.violations.map(v => v.invariant)).toEqual([
      'D1-no-duplicate',
    ]);
    expect(result.ownerIsolation.map(v => v.invariant)).toEqual([
      'O1-owner-isolation',
      'O1-owner-isolation',
    ]);
    expect(result.lostPromotions).toHaveLength(1);
  });

  it('flags a lost update and an overwrite', () => {
    const events: Event[] = [
      {
        t: 'write',
        key: keyA,
        tier: 'gold',
        rating: 5.2,
        callId: 0,
        activeOwner: OWNER_A,
      },
      { t: 'overwrite', fromCallId: 0, toCallId: 1 },
    ];
    const table = new Map([
      [keyA, JSON.stringify({ tier: 'silver', rating: 4 })],
    ]);
    const result = checkInvariants(events, new Map(), table, [callA]);
    expect(result.violations.map(v => v.invariant).sort()).toEqual([
      'R1-record',
      'X1-exclusivity',
    ]);
  });

  it('accepts a clean log', () => {
    const events: Event[] = [
      {
        t: 'write',
        key: keyA,
        tier: 'gold',
        rating: 5.2,
        callId: 0,
        activeOwner: OWNER_A,
      },
      {
        t: 'raise',
        slot: 'current',
        callId: 0,
        intendedOwner: OWNER_A,
        activeOwner: OWNER_A,
        fromTier: null,
        toTier: 'gold',
      },
    ];
    const table = new Map([
      [keyA, JSON.stringify({ tier: 'gold', rating: 5.2 })],
    ]);
    const result = checkInvariants(events, new Map(), table, [callA]);
    expect(result.violations).toEqual([]);
    expect(result.lostPromotions).toEqual([]);
  });

  it('treats a promotion covered by a higher showing ceremony as delivered, and a downgrade as no promotion', () => {
    const initial = new Map([
      [keyA, JSON.stringify({ tier: 'gold', rating: 5.2 })],
    ]);
    const events: Event[] = [
      // gold -> bronze: downgrade, no ceremony expected
      {
        t: 'write',
        key: keyA,
        tier: 'bronze',
        rating: 1,
        callId: 0,
        activeOwner: OWNER_A,
      },
      // bronze -> diamond: celebrated
      {
        t: 'write',
        key: keyA,
        tier: 'diamond',
        rating: 8,
        callId: 1,
        activeOwner: OWNER_A,
      },
      {
        t: 'raise',
        slot: 'current',
        callId: 1,
        intendedOwner: OWNER_A,
        activeOwner: OWNER_A,
        fromTier: 'bronze',
        toTier: 'diamond',
      },
      // diamond -> silver (down), then silver -> gold (up) while the diamond
      // ceremony is still showing: covered, not lost.
      {
        t: 'write',
        key: keyA,
        tier: 'silver',
        rating: 4,
        callId: 2,
        activeOwner: OWNER_A,
      },
      {
        t: 'write',
        key: keyA,
        tier: 'gold',
        rating: 5,
        callId: 3,
        activeOwner: OWNER_A,
      },
    ];
    const table = new Map([
      [keyA, JSON.stringify({ tier: 'gold', rating: 5 })],
    ]);
    const result = checkInvariants(events, initial, table, [callA, callB]);
    expect(result.lostPromotions).toEqual([]);
  });
});
