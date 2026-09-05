/**
 * STRESS · mod-billing · concurrency lens.
 *
 * Drives the REAL access store (`src/state/accessStore.ts`), the REAL
 * RevenueCat client and the REAL canonical access API through seeded bursts of
 * overlapping calls — duplicate calls, call-during-call, cancel-during-call,
 * two accounts on one RevenueCat singleton, token rotation / sign-out mid
 * request, backend outages, malformed bodies and clock-skewed payloads — and
 * asserts the invariants the paywall relies on:
 *
 *  I1  bounded: every interleaving drains within the step budget, no promise
 *      is left pending (no deadlock / livelock);
 *  I2  quiescent: once everything settled `operation` is 'idle' and `status`
 *      is not 'loading';
 *  I3  no cross-account leak: `canonicalAccess` / `plans` always came from the
 *      dependencies (account + configuration version) the store holds NOW;
 *      after sign-out both are null;
 *  I4  premium only from the backend: an object in `canonicalAccess` that the
 *      backend wrapper never produced is a violation (a local RevenueCat
 *      entitlement must never unlock access);
 *  I5  purchase attribution: `purchasePackage` is invoked only while the
 *      RevenueCat singleton is bound to the purchasing client's own canonical
 *      id (a purchase can never land on another account's ledger);
 *  I6  single purchase in flight: two `purchasePackage` calls never overlap;
 *  I7  return contract: `purchaseSelected` / `restorePurchases` /
 *      `syncBilling` resolve true only when the store now shows premium for
 *      the account that issued the call;
 *  I8  `selectedPeriod` always names a plan that exists;
 *  I9  401 semantics: `reportApiUnauthorized` fires exactly once per 401
 *      whose bearer was still current when the response landed;
 *  I10 every request bears the current session's token for the account whose
 *      dependencies issued it (never a stale/other account's token);
 *  I11 freshness (metric): a backend response issued EARLIER never overwrites
 *      one issued LATER for the same configuration;
 *  I12 fail closed: when the last backend response that landed for the
 *      current configuration was an error, `canonicalAccess` is null.
 *
 * Known-broken invariants (reproduced deterministically by the
 * `REPRODUCES BUG` tests in `billingDirectedInterleavings.stress.test.ts`):
 * I11 and I12 — `initialize()` applies the `getAccess` snapshot it fetched
 * only after `loadPlans()` (StoreKit offerings + eligibility) also finishes,
 * so a newer `refreshAccess` / `syncBilling` result adopted in between is
 * overwritten by the older snapshot; I6 — the same final `set` writes
 * `operation: 'idle'` over an in-flight purchase, reopening the duplicate
 * guard. Their violations are recorded in the
 * JSON table as BROKEN but only fail this suite under STRESS_STRICT=1, so the
 * campaign keeps guarding the other invariants in CI until the store is
 * fixed. Once it is, the pins start failing — invert them and delete the
 * KNOWN_BROKEN entry together.
 *
 * Campaign controls: STRESS_ITER (default 40), STRESS_BASE (first seed,
 * default 1), STRESS_SEED (run one seed), STRESS_OUT (write the JSON table),
 * STRESS_STRICT=1 (fail on known-broken invariants too).
 */
import { writeFileSync } from 'node:fs';
import type { BillingPeriod } from '../../src/billing/types';
import { useAccessStore } from '../../src/state/accessStore';
import {
  ACCOUNTS,
  Driver,
  World,
  type Account,
  type Tag,
} from '../../testing/stress/billingStressHarness';

const ITERATIONS = Number(process.env.STRESS_ITER ?? 40);
const BASE_SEED = Number(process.env.STRESS_BASE ?? 1);
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const STRICT = process.env.STRESS_STRICT === '1';
const KNOWN_BROKEN = new Set(['I6', 'I11', 'I12']);
const MAX_STEPS = 600;
const SETTLE_TIMEOUT_MS = 2_000;

type ActionName =
  | 'initialize'
  | 'refreshAccess'
  | 'syncBilling'
  | 'purchaseSelected'
  | 'restorePurchases'
  | 'selectPeriod'
  | 'clearError'
  | 'reset'
  | 'rotateToken'
  | 'expireBearer'
  | 'signOut'
  | 'signInOther'
  | 'rebootstrapSame'
  | 'serverSpend'
  | 'serverReserve'
  | 'serverRelease'
  | 'rcRevoke'
  | 'rcGrant'
  | 'offeringChange';

const ACTION_WEIGHTS: Array<[ActionName, number]> = [
  ['initialize', 4],
  ['refreshAccess', 4],
  ['syncBilling', 2],
  ['purchaseSelected', 5],
  ['restorePurchases', 3],
  ['selectPeriod', 1],
  ['clearError', 1],
  ['reset', 0.5],
  ['rotateToken', 1.5],
  ['expireBearer', 1],
  ['signOut', 0.8],
  ['signInOther', 0.8],
  ['rebootstrapSame', 0.6],
  ['serverSpend', 1],
  ['serverReserve', 0.5],
  ['serverRelease', 0.5],
  ['rcRevoke', 0.5],
  ['rcGrant', 0.3],
  ['offeringChange', 0.5],
];
const TOTAL_WEIGHT = ACTION_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

interface Violation {
  invariant: string;
  detail: string;
}

interface IterationResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  actions: string[];
  trace: string[];
  steps: number;
  ms: number;
  violations: Violation[];
  metrics: {
    requests: number;
    sdkPurchases: number;
    staleOverwrites: number;
    stalePremiumFlips: number;
    /** Successful purchases whose SDK call resolved after the singleton moved to another account. */
    purchasesSettledUnderOtherAccount: number;
    unauthorizedReports: number;
  };
}

interface ActionOutcome {
  label: string;
  account: string | null;
  result: unknown;
  storeAfter: {
    premium: boolean;
    tagAccount: string | null;
    storeAccount: string | null;
  } | null;
}

function pickAction(world: World): ActionName {
  let roll = world.rng.next() * TOTAL_WEIGHT;
  for (const [name, weight] of ACTION_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return name;
  }
  return 'refreshAccess';
}

async function runIteration(seed: number): Promise<IterationResult> {
  const startedAt = Date.now();
  const world = new World(seed);
  const rng = world.rng;
  const violations: Violation[] = [];
  const actions: string[] = [];
  const outcomes: ActionOutcome[] = [];
  const pendingActions: Array<Promise<void>> = [];
  let staleOverwrites = 0;
  let stalePremiumFlips = 0;
  let purchasesSettledUnderOtherAccount = 0;

  const driver = new Driver(world);
  const signIn = (account: Account) => driver.signIn(account);
  const signOut = () => driver.signOut();

  const tagOf = (value: object | null): Tag | null =>
    value ? (world.tags.get(value) ?? null) : null;

  // The auth store's reaction to a 401 (authStore.handleApiUnauthorized):
  // rotate the bearer, or — when the refresh token is refused — sign out.
  world.installUnauthorizedListener(() => {
    const roll = rng.next();
    if (roll < 0.6) world.rotateSession();
    else if (roll < 0.8) signOut();
  });

  // Adopted-access ledger for I11 (freshness).
  const newestAdopted = new Map<number, Tag>();
  let lastAdopted: Tag | null = null;
  const unsubscribe = useAccessStore.subscribe(state => {
    const tag = tagOf(state.canonicalAccess);
    if (!tag || tag === lastAdopted) {
      if (!tag) lastAdopted = null;
      return;
    }
    lastAdopted = tag;
    const newest = newestAdopted.get(tag.configVersion);
    if (newest && tag.seq < newest.seq) {
      staleOverwrites += 1;
      if (newest.premium && !tag.premium) stalePremiumFlips += 1;
    } else {
      newestAdopted.set(tag.configVersion, tag);
    }
  });

  const checkLeak = (when: string) => {
    const state = useAccessStore.getState();
    const { current, configVersion } = driver;
    const accessTag = tagOf(state.canonicalAccess);
    const plansTag = tagOf(state.plans);
    if (state.canonicalAccess && !accessTag) {
      violations.push({
        invariant: 'I4',
        detail: `${when}: canonicalAccess object not produced by the backend`,
      });
    }
    if (current === null) {
      if (state.canonicalAccess || state.plans) {
        violations.push({
          invariant: 'I3',
          detail: `${when}: signed out but store holds access/plans`,
        });
      }
      return;
    }
    if (
      accessTag &&
      (accessTag.account !== current.canonicalId ||
        accessTag.configVersion !== configVersion)
    ) {
      violations.push({
        invariant: 'I3',
        detail: `${when}: canonicalAccess from ${accessTag.account}@v${accessTag.configVersion}, store is ${current.canonicalId}@v${configVersion}`,
      });
    }
    if (
      plansTag &&
      (plansTag.account !== current.canonicalId ||
        plansTag.configVersion !== configVersion)
    ) {
      violations.push({
        invariant: 'I3',
        detail: `${when}: plans from ${plansTag.account}@v${plansTag.configVersion}, store is ${current.canonicalId}@v${configVersion}`,
      });
    }
  };

  const fire = (label: string, run: () => Promise<unknown>) => {
    const account = driver.current?.canonicalId ?? null;
    actions.push(label);
    pendingActions.push(
      run().then(
        result => {
          const state = useAccessStore.getState();
          outcomes.push({
            label,
            account,
            result,
            storeAfter: {
              premium: state.canonicalAccess?.premium === true,
              tagAccount: tagOf(state.canonicalAccess)?.account ?? null,
              storeAccount: world.storeAccount,
            },
          });
        },
        error => {
          violations.push({
            invariant: 'I1',
            detail: `${label} rejected: ${String(error)}`,
          });
        },
      ),
    );
  };

  const performAction = (name: ActionName) => {
    const store = useAccessStore.getState();
    const { current } = driver;
    switch (name) {
      case 'initialize':
        return fire('initialize', () => store.initialize());
      case 'refreshAccess':
        return fire('refreshAccess', () => store.refreshAccess());
      case 'syncBilling':
        return fire('syncBilling', () => store.syncBilling());
      case 'purchaseSelected':
        return fire('purchaseSelected', () => store.purchaseSelected());
      case 'restorePurchases':
        return fire('restorePurchases', () => store.restorePurchases());
      case 'selectPeriod': {
        const period = rng.pick<BillingPeriod>([
          'annual',
          'monthly',
          'lifetime',
        ]);
        actions.push(`selectPeriod(${period})`);
        store.selectPeriod(period);
        return;
      }
      case 'clearError':
        actions.push('clearError');
        store.clearError();
        return;
      case 'reset':
        actions.push('reset');
        store.reset();
        return;
      case 'rotateToken':
        actions.push('rotateToken');
        world.rotateSession();
        return;
      case 'expireBearer':
        actions.push('expireBearer');
        world.expireCurrentBearer();
        return;
      case 'signOut':
        actions.push('signOut');
        signOut();
        return;
      case 'signInOther': {
        const other = rng.pick(ACCOUNTS.filter(a => a !== current));
        actions.push(`signIn(${other.name})`);
        if (current) signOut();
        signIn(other);
        return;
      }
      case 'rebootstrapSame':
        if (!current) return;
        actions.push(`rebootstrap(${current.name})`);
        signIn(current);
        return;
      case 'serverSpend':
        if (!current) return;
        actions.push('serverSpend');
        world.serverSpend(current.canonicalId);
        return;
      case 'serverReserve':
        if (!current) return;
        actions.push('serverReserve');
        world.serverReserve(current.canonicalId);
        return;
      case 'serverRelease':
        if (!current) return;
        actions.push('serverRelease');
        world.serverRelease(current.canonicalId);
        return;
      case 'rcRevoke':
        if (!current) return;
        actions.push('rcRevoke');
        world.rcRevoke(current.canonicalId);
        return;
      case 'rcGrant':
        if (!current) return;
        actions.push('rcGrant');
        world.rcGrant(current.canonicalId, 'pickle_sensei_pro_yearly');
        return;
      case 'offeringChange':
        actions.push('offeringChange');
        world.offeringVersion += 1;
        return;
    }
  };

  try {
    // Start signed in as A; often with a fully settled first initialize so
    // purchases are actually reachable.
    signIn(ACCOUNTS[0] as Account);
    if (rng.chance(0.65)) {
      fire('initialize(warm)', () => useAccessStore.getState().initialize());
      await world.scheduler.run(rng, { maxSteps: MAX_STEPS });
    }
    if (rng.chance(0.3)) {
      fire('refreshAccess(warm)', () =>
        useAccessStore.getState().refreshAccess(),
      );
      await world.scheduler.run(rng, { maxSteps: MAX_STEPS });
    }

    const phases = 1 + rng.int(4);
    for (let phase = 0; phase < phases; phase += 1) {
      const burst = 1 + rng.int(6);
      for (let i = 0; i < burst; i += 1) performAction(pickAction(world));
      // Settle a seed-chosen prefix of the outstanding native/network calls
      // before the next burst arrives, injecting external events between them.
      const count = rng.int(world.scheduler.pending.length + 3);
      await world.scheduler.run(rng, {
        count,
        maxSteps: MAX_STEPS,
        between: () => {
          checkLeak(`step ${world.scheduler.steps}`);
          if (rng.chance(0.15)) {
            performAction(
              rng.pick<ActionName>([
                'rotateToken',
                'expireBearer',
                'serverSpend',
                'signOut',
                'signInOther',
                'refreshAccess',
                'purchaseSelected',
                'rcRevoke',
              ]),
            );
          }
        },
      });
    }
    await world.scheduler.run(rng, {
      maxSteps: MAX_STEPS,
      between: () => checkLeak(`step ${world.scheduler.steps}`),
    });
    await world.scheduler.flush();

    // I1: every action promise settled.
    const settled = await Promise.race([
      Promise.all(pendingActions).then(() => true),
      new Promise<boolean>(resolve =>
        setTimeout(() => resolve(false), SETTLE_TIMEOUT_MS),
      ),
    ]);
    if (!settled) {
      violations.push({
        invariant: 'I1',
        detail: `deadlock: ${pendingActions.length} action promises still pending after ${SETTLE_TIMEOUT_MS}ms; pending ops=${world.scheduler.pending.map(op => op.label).join(',')}`,
      });
    }

    const state = useAccessStore.getState();
    // I2
    if (state.operation !== 'idle' || state.status === 'loading') {
      violations.push({
        invariant: 'I2',
        detail: `not quiescent: operation=${state.operation} status=${state.status}`,
      });
    }
    // I3 / I4
    checkLeak('final');
    // I5 / I6
    for (const purchase of world.sdkPurchases) {
      if (
        purchase.outcome === 'success' &&
        purchase.appUserIdAtSettle !== purchase.owner
      ) {
        purchasesSettledUnderOtherAccount += 1;
      }
      if (purchase.appUserIdAtInvoke !== purchase.owner) {
        violations.push({
          invariant: 'I5',
          detail: `purchasePackage by ${purchase.owner} while singleton bound to ${purchase.appUserIdAtInvoke}`,
        });
      }
      if (purchase.concurrentInFlight > 0) {
        violations.push({
          invariant: 'I6',
          detail: `purchasePackage invoked with ${purchase.concurrentInFlight} purchase(s) already in flight (step ${purchase.step})`,
        });
      }
    }
    // I7
    for (const outcome of outcomes) {
      if (
        (outcome.label === 'purchaseSelected' ||
          outcome.label === 'restorePurchases' ||
          outcome.label === 'syncBilling') &&
        outcome.result === true
      ) {
        const after = outcome.storeAfter;
        if (
          !after ||
          !after.premium ||
          after.tagAccount !== outcome.account ||
          after.storeAccount !== outcome.account
        ) {
          violations.push({
            invariant: 'I7',
            detail: `${outcome.label} resolved true but store shows ${JSON.stringify(after)} for issuer ${outcome.account}`,
          });
        }
      }
    }
    // I8
    if (state.plans) {
      const plan =
        state.selectedPeriod === 'annual'
          ? state.plans.annual
          : state.selectedPeriod === 'monthly'
            ? state.plans.monthly
            : state.plans.lifetime;
      if (!plan) {
        violations.push({
          invariant: 'I8',
          detail: `selectedPeriod=${state.selectedPeriod} but plans has no such plan`,
        });
      }
    }
    // I9
    if (
      world.unauthorizedReports.length !== world.expectedUnauthorizedReports
    ) {
      violations.push({
        invariant: 'I9',
        detail: `reportApiUnauthorized fired ${world.unauthorizedReports.length}×, expected ${world.expectedUnauthorizedReports}`,
      });
    }
    // I10
    for (const request of world.requests) {
      if (
        request.tokenAccount === null ||
        request.tokenAccount !== request.sessionAccountAtIssue ||
        request.tokenAccount !== request.storeAccountAtIssue
      ) {
        violations.push({
          invariant: 'I10',
          detail: `request #${request.seq} ${request.path} bore token of ${request.tokenAccount}; session=${request.sessionAccountAtIssue} store=${request.storeAccountAtIssue}`,
        });
      }
    }
    // I11 (metric → violation)
    if (staleOverwrites > 0) {
      violations.push({
        invariant: 'I11',
        detail: `${staleOverwrites} stale overwrite(s) of canonicalAccess (${stalePremiumFlips} flipped premium→free)`,
      });
    }
    // I12
    const { current, configVersion } = driver;
    if (current !== null) {
      const landed = world.requests
        .filter(
          r =>
            r.landedStep >= 0 &&
            r.tokenAccount === current.canonicalId &&
            r.storeAccountAtIssue === current.canonicalId,
        )
        .sort((a, b) => a.landedStep - b.landedStep);
      const last = landed[landed.length - 1];
      const lastWasError = last ? !last.outcome.startsWith('200') : false;
      const lastTag = tagOf(state.canonicalAccess);
      if (
        last &&
        lastWasError &&
        state.canonicalAccess &&
        lastTag &&
        lastTag.configVersion === configVersion &&
        // A response for THIS configuration (not one that was discarded).
        world.requests.some(r => r.seq === lastTag.seq && r.landedStep >= 0)
      ) {
        violations.push({
          invariant: 'I12',
          detail: `last landed backend response #${last.seq} was ${last.outcome} yet canonicalAccess is set (seq ${lastTag.seq})`,
        });
      }
    }
  } catch (error) {
    violations.push({ invariant: 'I1', detail: `harness: ${String(error)}` });
  } finally {
    unsubscribe();
    driver.dispose();
  }

  return {
    seed,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    trace: world.scheduler.trace,
    actions,
    steps: world.scheduler.steps,
    ms: Date.now() - startedAt,
    violations,
    metrics: {
      requests: world.requests.length,
      sdkPurchases: world.sdkPurchases.length,
      staleOverwrites,
      stalePremiumFlips,
      purchasesSettledUnderOtherAccount,
      unauthorizedReports: world.unauthorizedReports.length,
    },
  };
}

const results: IterationResult[] = [];

afterAll(() => {
  if (!process.env.STRESS_OUT) return;
  const held = results.filter(r => r.outcome === 'HELD').length;
  writeFileSync(
    process.env.STRESS_OUT,
    JSON.stringify(
      {
        suite: 'billingStoreConcurrency',
        baseSeed: BASE_SEED,
        iterations: results.length,
        held,
        broken: results.length - held,
        totalSteps: results.reduce((sum, r) => sum + r.steps, 0),
        totalActions: results.reduce((sum, r) => sum + r.actions.length, 0),
        totalRequests: results.reduce((sum, r) => sum + r.metrics.requests, 0),
        totalSdkPurchases: results.reduce(
          (sum, r) => sum + r.metrics.sdkPurchases,
          0,
        ),
        staleOverwrites: results.reduce(
          (sum, r) => sum + r.metrics.staleOverwrites,
          0,
        ),
        stalePremiumFlips: results.reduce(
          (sum, r) => sum + r.metrics.stalePremiumFlips,
          0,
        ),
        seedsWithStaleOverwrite: results
          .filter(r => r.metrics.staleOverwrites > 0)
          .map(r => r.seed),
        seedsWithStalePremiumFlip: results
          .filter(r => r.metrics.stalePremiumFlips > 0)
          .map(r => r.seed),
        purchasesSettledUnderOtherAccount: results.reduce(
          (sum, r) => sum + r.metrics.purchasesSettledUnderOtherAccount,
          0,
        ),
        seedsWithPurchaseSettledUnderOtherAccount: results
          .filter(r => r.metrics.purchasesSettledUnderOtherAccount > 0)
          .map(r => r.seed),
        brokenSeeds: results
          .filter(r => r.outcome === 'BROKEN')
          .map(r => ({
            seed: r.seed,
            invariants: [...new Set(r.violations.map(v => v.invariant))],
          })),
        violationsByInvariant: results
          .flatMap(r => r.violations)
          .reduce<Record<string, number>>((acc, v) => {
            acc[v.invariant] = (acc[v.invariant] ?? 0) + 1;
            return acc;
          }, {}),
        results,
      },
      null,
      2,
    ),
  );
});

describe('billing store concurrency (seeded interleavings)', () => {
  const seeds =
    ONLY_SEED !== null
      ? [ONLY_SEED]
      : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);

  it.each(seeds)('seed %i holds every invariant', async seed => {
    const result = await runIteration(seed);
    results.push(result);
    const gating = STRICT
      ? result.violations
      : result.violations.filter(v => !KNOWN_BROKEN.has(v.invariant));
    expect({ seed, actions: result.actions, violations: gating }).toEqual({
      seed,
      actions: result.actions,
      violations: [],
    });
    expect(result.steps).toBeLessThanOrEqual(MAX_STEPS);
  });
});
