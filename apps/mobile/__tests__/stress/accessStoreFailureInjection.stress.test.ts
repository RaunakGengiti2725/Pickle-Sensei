/**
 * STRESS — mod-access-store × failure-injection.
 *
 * Every dependency of `src/state/accessStore.ts` (the canonical access API
 * over fetch, the RevenueCat SDK behind the store client, and the client
 * configuration it is built from) is driven through throw / reject / never /
 * slow / HTTP-status / malformed / partial answers, alone (deterministic
 * catalogue sweep) and in seeded random combinations interleaved with store
 * operations and configuration cuts (sign-out, account switch).
 *
 * Invariants asserted per scenario (see testing/stress/accessStoreFaults.ts):
 * - recoverable: no `loading`/busy state survives every op settling; a
 *   never-answering dependency is classified against KB1 (no deadline);
 * - the paywall retry control is reachable whenever there is nothing to sell
 *   or no verified allowance;
 * - no silent failure (null snapshot ⇒ visible error, or explicit reset);
 * - no fake success (premium only after the server said premium);
 * - no corrupted snapshot (canonicalAccess is null or exactly a server value,
 *   internally consistent with the free-rating contract);
 * - store methods never reject, selectors never throw, secrets never land in
 *   state, one store purchase/restore per user action.
 *
 * Replay: `STRESS_SEED=<seed> npx jest --ci accessStoreFailureInjection`
 * replays one random-campaign seed; `STRESS_FAULT=<id>` limits the sweep to
 * one catalogue fault. `STRESS_ITER=<n>` scales the random campaigns (default
 * kept small so the suite stays fast). Evidence lands under
 * artifacts/stress/mod-access-store-failure-injection/<STRESS_RUN_ID>/.
 */
import {
  FAULT_CATALOG,
  KB,
  pick,
  randomInt,
  recordScenario,
  scenarioSeeds,
  seededRandom,
  serverAccess,
  stressIterations,
  writeResultsTable,
  CANONICAL_ID,
} from '../../testing/stress/accessStoreFaults';
import type { Fault, StoreOp } from '../../testing/stress/accessStoreFaults';
import { runScenario } from '../../testing/stress/accessStoreScenario';
import type {
  ScenarioPlan,
  Step,
} from '../../testing/stress/accessStoreScenario';

declare const process: { env: Record<string, string | undefined> };

const SUITE = 'accessStoreFailureInjection';

jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });

afterAll(() => {
  writeResultsTable(SUITE);
});

/** A scenario passes when every violation is a pinned known-broken id. */
function expectHeldOrKnownBroken(
  violations: { invariant: string; detail: string; knownBrokenId?: string }[],
) {
  const unexpected = violations.filter(v => !v.knownBrokenId);
  expect(unexpected).toEqual([]);
}

// ─── 1. Deterministic catalogue sweep: one fault, its natural operation ───

const sweepFaults = (() => {
  const only = process.env['STRESS_FAULT'];
  return only ? FAULT_CATALOG.filter(f => f.id === only) : FAULT_CATALOG;
})();

describe('accessStore failure injection — catalogue sweep', () => {
  it('covers at least 60 distinct injected faults', () => {
    expect(FAULT_CATALOG.length).toBeGreaterThanOrEqual(60);
    expect(new Set(FAULT_CATALOG.map(f => f.id)).size).toBe(
      FAULT_CATALOG.length,
    );
  });

  it.each(sweepFaults.map((fault, index) => [fault.id, fault, index] as const))(
    '%s',
    async (_id, fault, index) => {
      const plan: ScenarioPlan = {
        faults: [fault],
        warmup: fault.op !== 'initialize',
        access: serverAccess(false, 1),
        syncPremium: true,
        introOffering: fault.seam === 'rc:checkTrial',
        sdkPreconfiguredFor: fault.seam === 'rc:logIn' ? 'previous-user' : null,
        steps: [{ kind: 'op', op: fault.op }],
      };
      const { violations } = await recordScenario(
        SUITE,
        'sweep',
        index,
        {
          fault: fault.id,
          seam: fault.seam,
          op: fault.op,
          behaviour: fault.behaviour.kind,
          describe: fault.describe,
        },
        () => runScenario(plan),
      );
      expectHeldOrKnownBroken(violations);
      // A never-settling dependency must be visible as the pinned finding —
      // never as a clean pass — so the sweep asserts KB1 is actually hit.
      if (fault.hangs) {
        expect(violations.map(v => v.knownBrokenId)).toContain(KB.noDeadline);
      }
    },
  );
});

// ─── 2. Seeded random campaign: fault combinations × op interleavings ─────

const OP_WEIGHTS: ReadonlyArray<StoreOp> = [
  'initialize',
  'refreshAccess',
  'refreshAccess',
  'syncBilling',
  'purchaseSelected',
  'purchaseSelected',
  'restorePurchases',
];

function randomSteps(random: () => number, count: number): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = random();
    if (roll < 0.5) {
      steps.push({ kind: 'op', op: pick(random, OP_WEIGHTS) });
    } else if (roll < 0.65) {
      steps.push({ kind: 'flush' });
    } else if (roll < 0.8) {
      steps.push({ kind: 'advance', ms: randomInt(random, 0, 30) * 1000 });
    } else if (roll < 0.85) {
      steps.push({ kind: 'reset' });
    } else if (roll < 0.88) {
      steps.push({ kind: 'clear' });
    } else if (roll < 0.91) {
      steps.push({ kind: 'reconfigure' });
    } else if (roll < 0.95) {
      steps.push({
        kind: 'select',
        period: pick(random, ['annual', 'monthly', 'lifetime'] as const),
      });
    } else if (roll < 0.97) {
      steps.push({ kind: 'clearError' });
    } else {
      const premium = random() < 0.3;
      const used = randomInt(random, 0, 2);
      steps.push({
        kind: 'server',
        premium,
        used,
        reserved: randomInt(random, 0, 2 - used),
      });
    }
  }
  if (!steps.some(s => s.kind === 'op')) {
    steps.unshift({ kind: 'op', op: pick(random, OP_WEIGHTS) });
  }
  return steps;
}

function randomPlan(seed: number): ScenarioPlan {
  const random = seededRandom(seed);
  const faultCount = randomInt(random, 1, 3);
  const faults: Fault[] = [];
  const seams = new Set<string>();
  while (faults.length < faultCount) {
    const fault = pick(random, FAULT_CATALOG);
    if (seams.has(fault.seam)) continue;
    seams.add(fault.seam);
    faults.push(fault);
  }
  const used = randomInt(random, 0, 2);
  const premium = random() < 0.2;
  return {
    faults,
    warmup: random() < 0.8,
    access: serverAccess(premium, used, randomInt(random, 0, 2 - used)),
    syncPremium: random() < 0.6,
    introOffering: random() < 0.3,
    sdkPreconfiguredFor:
      random() < 0.15 ? 'previous-user' : random() < 0.3 ? CANONICAL_ID : null,
    steps: randomSteps(random, randomInt(random, 2, 7)),
  };
}

describe('accessStore failure injection — seeded random campaign', () => {
  const seeds = scenarioSeeds('random', stressIterations(48));

  it.each(seeds.map(seed => [seed] as const))('seed %s', async seed => {
    const plan = randomPlan(seed);
    const { violations } = await recordScenario(
      SUITE,
      'random',
      seed,
      {
        faults: plan.faults.map(f => f.id),
        warmup: plan.warmup,
        access: plan.access,
        syncPremium: plan.syncPremium,
        introOffering: plan.introOffering,
        sdkPreconfiguredFor: plan.sdkPreconfiguredFor,
        steps: plan.steps,
      },
      () => runScenario(plan),
    );
    expectHeldOrKnownBroken(violations);
  });
});

// ─── 3. Seeded refresh-race campaign: overlapping reads, moving server ────

function racePlan(seed: number): ScenarioPlan {
  const random = seededRandom(seed);
  const slowRead = FAULT_CATALOG.find(f => f.id === 'F28')!; // getAccess after 45s
  const slowInit = FAULT_CATALOG.find(f => f.id === 'R17')!; // offerings after 15s
  const first: StoreOp = random() < 0.5 ? 'initialize' : 'refreshAccess';
  const second: StoreOp = random() < 0.5 ? 'refreshAccess' : 'syncBilling';
  const cutKind = random();
  const steps: Step[] = [
    { kind: 'op', op: first },
    { kind: 'flush' },
    { kind: 'server', premium: false, used: 2, reserved: 0 },
    { kind: 'op', op: second },
    { kind: 'flush' },
  ];
  if (cutKind < 0.2) steps.push({ kind: 'reset' });
  else if (cutKind < 0.35) steps.push({ kind: 'clear' });
  else if (cutKind < 0.5) steps.push({ kind: 'reconfigure' });
  steps.push({ kind: 'advance', ms: 50_000 });
  return {
    faults:
      first === 'initialize' && random() < 0.5
        ? [slowRead, slowInit]
        : [slowRead],
    warmup: true,
    access: serverAccess(false, 1),
    syncPremium: false,
    introOffering: false,
    sdkPreconfiguredFor: null,
    steps,
  };
}

// ─── 4. Operation-flag races: initialize() landing during a store action ──

const SLOW_ACTION: Record<
  'purchaseSelected' | 'restorePurchases' | 'syncBilling',
  string
> = {
  purchaseSelected: 'R26', // purchasePackage answers after 40s
  restorePurchases: 'R33', // restorePurchases answers after 25s
  syncBilling: 'S17', // billing sync answers after 20s
};

function operationRacePlan(seed: number): ScenarioPlan {
  const random = seededRandom(seed);
  const action = pick(random, [
    'purchaseSelected',
    'restorePurchases',
    'syncBilling',
  ] as const);
  const fault = FAULT_CATALOG.find(f => f.id === SLOW_ACTION[action])!;
  // The second tap happens while the store action is still in flight.
  const secondTap: StoreOp =
    random() < 0.5
      ? action
      : pick(random, [
          'purchaseSelected',
          'restorePurchases',
          'syncBilling',
        ] as const);
  return {
    faults: [fault],
    warmup: true,
    access: serverAccess(false, 1),
    syncPremium: true,
    introOffering: false,
    sdkPreconfiguredFor: null,
    steps: [
      { kind: 'op', op: action },
      { kind: 'flush' },
      // Route gate / paywall retry re-runs initialize() while the sheet is up.
      { kind: 'op', op: 'initialize' },
      { kind: 'flush' },
      { kind: 'op', op: secondTap },
      { kind: 'flush' },
      { kind: 'advance', ms: 45_000 },
    ],
  };
}

describe('accessStore failure injection — operation flag races', () => {
  const seeds = scenarioSeeds('operation-race', stressIterations(12));

  it.each(seeds.map(seed => [seed] as const))('seed %s', async seed => {
    const plan = operationRacePlan(seed);
    const { violations } = await recordScenario(
      SUITE,
      'operation-race',
      seed,
      { faults: plan.faults.map(f => f.id), steps: plan.steps },
      () => runScenario(plan),
    );
    expectHeldOrKnownBroken(violations);
  });
});

// ─── 5. Minimised reproductions of every pinned known-broken finding ──────
//
// Each plan is the smallest step list that reproduces one KB id found by the
// campaigns above. They assert the finding IS reproduced, so a fix in
// accessStore.ts fails here and the pin gets removed instead of going stale.

function faultById(id: string): Fault {
  const fault = FAULT_CATALOG.find(f => f.id === id);
  if (!fault) throw new Error(`unknown fault ${id}`);
  return fault;
}

function minimalPlan(faultIds: string[], steps: Step[]): ScenarioPlan {
  return {
    faults: faultIds.map(faultById),
    warmup: true,
    access: serverAccess(false, 1),
    syncPremium: true,
    introOffering: false,
    sdkPreconfiguredFor: null,
    steps,
  };
}

const KNOWN_BROKEN_REPROS: ReadonlyArray<{
  id: string;
  invariant: string;
  plan: ScenarioPlan;
}> = [
  {
    id: KB.noDeadline,
    invariant: 'no_infinite_spinner_60s',
    plan: minimalPlan(['F27'], [{ kind: 'op', op: 'refreshAccess' }]),
  },
  {
    id: KB.initializeClearsOperation,
    invariant: 'no_concurrent_store_purchase',
    plan: minimalPlan(
      ['R26'],
      [
        { kind: 'op', op: 'purchaseSelected' },
        { kind: 'flush' },
        { kind: 'op', op: 'initialize' },
        { kind: 'flush' },
        { kind: 'op', op: 'purchaseSelected' },
        { kind: 'flush' },
        { kind: 'advance', ms: 45_000 },
      ],
    ),
  },
  {
    id: KB.undefinedSnapshot,
    invariant: 'no_silent_failure',
    plan: minimalPlan(['D02'], [{ kind: 'op', op: 'refreshAccess' }]),
  },
  {
    id: KB.syncThrowRejects,
    invariant: 'store_method_never_rejects',
    plan: {
      ...minimalPlan(['D03'], [{ kind: 'op', op: 'initialize' }]),
      warmup: false,
    },
  },
  {
    id: KB.directPlans,
    invariant: 'plans_never_empty',
    plan: {
      ...minimalPlan(['D05'], [{ kind: 'op', op: 'initialize' }]),
      warmup: false,
    },
  },
  {
    id: KB.staleSnapshotWins,
    invariant: 'newest_requested_snapshot_wins',
    plan: minimalPlan(
      ['F28'],
      [
        { kind: 'op', op: 'refreshAccess' },
        { kind: 'flush' },
        { kind: 'server', premium: false, used: 2, reserved: 0 },
        { kind: 'op', op: 'refreshAccess' },
        { kind: 'flush' },
        { kind: 'advance', ms: 50_000 },
      ],
    ),
  },
  {
    id: KB.cancelClearsError,
    invariant: 'error_status_has_error',
    plan: minimalPlan(
      ['R23', 'F08'],
      [
        { kind: 'op', op: 'purchaseSelected' },
        { kind: 'op', op: 'refreshAccess' },
        { kind: 'flush' },
      ],
    ),
  },
  {
    id: KB.resetClearsOperation,
    invariant: 'no_concurrent_store_restore',
    plan: minimalPlan(
      ['R33'],
      [
        { kind: 'op', op: 'restorePurchases' },
        { kind: 'flush' },
        { kind: 'reset' },
        { kind: 'op', op: 'restorePurchases' },
        { kind: 'flush' },
        { kind: 'advance', ms: 30_000 },
      ],
    ),
  },
];

describe('accessStore failure injection — minimised known-broken repros', () => {
  it('pins every known-broken id exactly once', () => {
    expect(KNOWN_BROKEN_REPROS.map(r => r.id).sort()).toEqual(
      Object.values(KB).sort(),
    );
  });

  it.each(KNOWN_BROKEN_REPROS.map((r, index) => [r.id, r, index] as const))(
    '%s',
    async (_id, repro, index) => {
      const { violations } = await recordScenario(
        SUITE,
        'known-broken-repro',
        index,
        {
          knownBrokenId: repro.id,
          faults: repro.plan.faults.map(f => f.id),
          steps: repro.plan.steps,
        },
        () => runScenario(repro.plan),
      );
      expectHeldOrKnownBroken(violations);
      expect(violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invariant: repro.invariant,
            knownBrokenId: repro.id,
          }),
        ]),
      );
    },
  );
});

describe('accessStore failure injection — refresh races', () => {
  const seeds = scenarioSeeds('race', stressIterations(16));

  it.each(seeds.map(seed => [seed] as const))('seed %s', async seed => {
    const plan = racePlan(seed);
    const { violations } = await recordScenario(
      SUITE,
      'race',
      seed,
      { faults: plan.faults.map(f => f.id), steps: plan.steps },
      () => runScenario(plan),
    );
    expectHeldOrKnownBroken(violations);
  });
});
