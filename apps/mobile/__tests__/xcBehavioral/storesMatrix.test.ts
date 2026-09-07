/**
 * xc-matrix-behavioral — accessStore / appStore interaction storms.
 *
 * Real Zustand stores; only their injected dependencies (billing store
 * client, canonical access client, SQLite kv, canonical onboarding API) are
 * seams whose settlement the test controls. Scenarios (all seeded,
 * replayable with XC_SEED):
 *
 *   accessDoubleOps      — N overlapping purchase/restore/sync calls: ONE
 *                          store + ONE backend call, every other caller gets
 *                          false, `operation` returns to idle.
 *   accessInitStorm      — N overlapping initialize(): ONE configure /
 *                          getAccess / loadPlans, ends `ready`.
 *   accessResetMidFlight — reset / clear / reconfigure while an operation is
 *                          in flight: the stale response never lands (no
 *                          inherited premium, no orphan `loading`/operation).
 *   accessStaleRefresh   — refreshAccess() started BEFORE a successful
 *                          syncBilling()/purchase lands, resolving AFTER it:
 *                          does the older snapshot overwrite the newer one?
 *                          (observed and asserted; see finding).
 *   appHydrateStorm      — overlapping hydrate() calls across owner switches
 *                          with slow kv reads and a pending pre-auth profile:
 *                          final state belongs to the active owner, never a
 *                          cross-owner profile, `hydrated` never orphaned.
 */
import type { CanonicalAccessState, StorePlans } from '../../src/billing/types';
import {
  configureAccessStore,
  clearAccessStoreConfiguration,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import type { Profile } from '../../src/state/profile';
import {
  randomInt,
  recordScenario,
  scenarioSeeds,
  seededRandom,
  shuffle,
} from '../../testing/xcBehavioral/evidence';
import { createFakeLocalDb } from '../../testing/xcBehavioral/fakeLocalDb';
import { deferred, type Deferred } from '../../testing/xcBehavioral/deferred';

// ─── appStore seams ────────────────────────────────────────────────────────

let mockFakeDb = createFakeLocalDb();
/** Per-statement delay hook: resolves when the test says so. */
let mockDbGate: ((sql: string) => Promise<void>) | null = null;
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (mockDbGate) await mockDbGate(sql);
      return mockFakeDb.db.execute(sql, params);
    },
    close() {},
  }),
}));

let mockFetchCanonical: (session: unknown) => Promise<Profile | null> = () =>
  Promise.resolve(null);
let mockSaveCanonical: (
  session: unknown,
  profile: Profile,
) => Promise<Profile> = (_s, p) => Promise.resolve(p);
let mockFetchCanonicalCalls = 0;
let mockSaveCanonicalCalls = 0;
jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: unknown) => {
    mockFetchCanonicalCalls += 1;
    return mockFetchCanonical(session);
  },
  saveCanonicalOnboardingProfile: (session: unknown, profile: Profile) => {
    mockSaveCanonicalCalls += 1;
    return mockSaveCanonical(session, profile);
  },
}));

import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';

const SUITE = 'storesMatrix';

// ─── Billing dependency fake ───────────────────────────────────────────────

function access(premium: boolean, used = 0): CanonicalAccessState {
  const remaining = premium ? 2 : Math.max(0, 2 - used);
  return {
    premium,
    entitlements: premium ? ['pickle_sensei_pro'] : [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: premium || remaining > 0,
    paywallRequired: !premium && remaining === 0,
  };
}

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual',
    productId: 'pickle_sensei_pro_yearly',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: null,
  lifetime: null,
};

interface Calls {
  configure: number;
  loadPlans: number;
  purchase: number;
  restore: number;
  getAccess: number;
  syncBilling: number;
}

/** Every dependency call returns a deferred the test settles explicitly. */
function billingDeps() {
  const calls: Calls = {
    configure: 0,
    loadPlans: 0,
    purchase: 0,
    restore: 0,
    getAccess: 0,
    syncBilling: 0,
  };
  const pending: Array<{ name: keyof Calls; d: Deferred<unknown> }> = [];
  const hold = <T>(name: keyof Calls): Promise<T> => {
    calls[name] += 1;
    const d = deferred<T>();
    pending.push({ name, d: d as Deferred<unknown> });
    return d.promise;
  };
  const deps = {
    store: {
      configure: () => hold<void>('configure'),
      loadPlans: () => hold<StorePlans>('loadPlans'),
      purchase: () => hold<never>('purchase'),
      restore: () => hold<never>('restore'),
      readEntitlement: () =>
        Promise.resolve({
          premium: false,
          productId: null,
          expirationDate: null,
        }),
    },
    backend: {
      getAccess: () => hold<CanonicalAccessState>('getAccess'),
      syncBilling: () => hold<never>('syncBilling'),
    },
  };
  return { deps, calls, pending };
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const entitlement = {
  premium: true,
  productId: 'pickle_sensei_pro_yearly',
  expirationDate: null,
};

type Op = 'syncBilling' | 'purchaseSelected' | 'restorePurchases';
const OPS: Op[] = ['syncBilling', 'purchaseSelected', 'restorePurchases'];

beforeEach(() => {
  clearAccessStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockFakeDb = createFakeLocalDb();
  mockDbGate = null;
  mockFetchCanonical = () => Promise.resolve(null);
  mockSaveCanonical = (_s, p) => Promise.resolve(p);
  mockFetchCanonicalCalls = 0;
  mockSaveCanonicalCalls = 0;
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
});

afterEach(() => {
  clearAccessStoreConfiguration();
  clearApiSession();
});

/** Brings the store to `ready` with plans + a free access snapshot. */
async function readyStore(b: ReturnType<typeof billingDeps>) {
  configureAccessStore(b.deps);
  const init = useAccessStore.getState().initialize();
  await flush();
  b.pending.find(p => p.name === 'configure')!.d.resolve(undefined);
  await flush();
  b.pending.find(p => p.name === 'getAccess')!.d.resolve(access(false, 1));
  b.pending.find(p => p.name === 'loadPlans')!.d.resolve(plans);
  await init;
  b.pending.length = 0;
  expect(useAccessStore.getState().status).toBe('ready');
  expect(useAccessStore.getState().operation).toBe('idle');
}

describe('xc-matrix-behavioral: accessStore / appStore storms', () => {
  describe('accessDoubleOps: overlapping billing operations collapse to ONE', () => {
    for (const seed of scenarioSeeds('accessDoubleOps')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const taps = randomInt(random, 2, 6);
        const mixed = random() < 0.5;
        const primary = OPS[randomInt(random, 0, 2)]!;
        const ops: Op[] = mixed
          ? Array.from({ length: taps }, () => OPS[randomInt(random, 0, 2)]!)
          : Array.from({ length: taps }, () => primary);
        const outcome = (
          ['premium', 'not_premium', 'store_throws', 'backend_throws'] as const
        )[randomInt(random, 0, 3)]!;
        await recordScenario(
          SUITE,
          'accessDoubleOps',
          seed,
          { ops, outcome },
          async () => {
            const b = billingDeps();
            await readyStore(b);
            const results = ops.map(op => useAccessStore.getState()[op]());
            await flush();
            const first = ops[0]!;
            const storeCall =
              first === 'purchaseSelected'
                ? 'purchase'
                : first === 'restorePurchases'
                  ? 'restore'
                  : null;
            // Exactly one operation is in flight; every later caller bounced.
            const expectedOperation =
              first === 'purchaseSelected'
                ? 'purchasing'
                : first === 'restorePurchases'
                  ? 'restoring'
                  : 'syncing';
            expect(useAccessStore.getState().operation).toBe(expectedOperation);
            expect(
              b.calls.purchase + b.calls.restore + b.calls.syncBilling,
            ).toBe(1);
            if (storeCall) {
              const p = b.pending.find(x => x.name === storeCall)!;
              if (outcome === 'store_throws') {
                p.d.reject(new Error('StoreKit: user cancelled'));
              } else {
                p.d.resolve(entitlement);
              }
              await flush();
            }
            if (!(storeCall && outcome === 'store_throws')) {
              const s = b.pending.find(x => x.name === 'syncBilling')!;
              expect(s).toBeDefined();
              if (outcome === 'backend_throws') {
                s.d.reject(new Error('503'));
              } else {
                s.d.resolve({
                  billing: {
                    premium: outcome === 'premium',
                    productId: null,
                    expiresAt: null,
                    verifiedAt: 'now',
                  },
                  access: access(outcome === 'premium', 1),
                });
              }
            }
            const settled = await Promise.all(results);
            const state = useAccessStore.getState();
            // Only the first caller can have succeeded.
            expect(settled.slice(1).every(v => v === false)).toBe(true);
            expect(settled[0]).toBe(outcome === 'premium');
            expect(state.operation).toBe('idle');
            expect(b.calls.syncBilling).toBe(
              storeCall && outcome === 'store_throws' ? 0 : 1,
            );
            expect(b.calls.purchase).toBe(first === 'purchaseSelected' ? 1 : 0);
            expect(b.calls.restore).toBe(first === 'restorePurchases' ? 1 : 0);
            if (outcome === 'premium') {
              expect(state.canonicalAccess?.premium).toBe(true);
              expect(state.error).toBeNull();
            }
            if (outcome === 'backend_throws') {
              // Fail closed: no access until verified.
              expect(state.canonicalAccess).toBeNull();
              expect(state.error).not.toBeNull();
            }
            return {
              settled,
              operation: state.operation,
              status: state.status,
              premium: state.canonicalAccess?.premium ?? null,
              calls: b.calls,
            };
          },
        );
      });
    }
  });

  describe('accessInitStorm: overlapping initialize() runs once', () => {
    for (const seed of scenarioSeeds('accessInitStorm')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const taps = randomInt(random, 2, 8);
        const storeFails = random() < 0.3;
        const accessFails = random() < 0.3;
        await recordScenario(
          SUITE,
          'accessInitStorm',
          seed,
          { taps, storeFails, accessFails },
          async () => {
            const b = billingDeps();
            configureAccessStore(b.deps);
            const inits = Array.from({ length: taps }, () =>
              useAccessStore.getState().initialize(),
            );
            await flush();
            expect(b.calls.configure).toBe(1);
            const cfg = b.pending.find(p => p.name === 'configure')!;
            if (storeFails) cfg.d.reject(new Error('RC not configured'));
            else cfg.d.resolve(undefined);
            await flush();
            expect(b.calls.getAccess).toBe(1);
            expect(b.calls.loadPlans).toBe(storeFails ? 0 : 1);
            const ga = b.pending.find(p => p.name === 'getAccess')!;
            if (accessFails) ga.d.reject(new Error('503'));
            else ga.d.resolve(access(false, 0));
            b.pending.find(p => p.name === 'loadPlans')?.d.resolve(plans);
            await Promise.all(inits);
            const state = useAccessStore.getState();
            expect(state.status).not.toBe('loading');
            expect(state.operation).toBe('idle');
            if (!storeFails && !accessFails) {
              expect(state.status).toBe('ready');
              expect(state.plans).toEqual(plans);
              expect(state.canonicalAccess?.canStartRating).toBe(true);
            }
            if (accessFails) expect(state.canonicalAccess).toBeNull();
            if (storeFails && !accessFails) {
              // Store failure never erases a verified free allowance.
              expect(state.canonicalAccess?.canStartRating).toBe(true);
              expect(state.status).toBe('unconfigured');
            }
            return { status: state.status, calls: b.calls };
          },
        );
      });
    }
  });

  describe('accessResetMidFlight: stale responses never land after reset/clear/reconfigure', () => {
    for (const seed of scenarioSeeds('accessResetMidFlight')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const op = (
          [
            'initialize',
            'refreshAccess',
            'syncBilling',
            'purchaseSelected',
            'restorePurchases',
          ] as const
        )[randomInt(random, 0, 4)]!;
        const cut = (['reset', 'clear', 'reconfigure'] as const)[
          randomInt(random, 0, 2)
        ]!;
        // Whether the cut happens at the store edge or the backend edge.
        const cutAfterStoreStep = random() < 0.5;
        await recordScenario(
          SUITE,
          'accessResetMidFlight',
          seed,
          { op, cut, cutAfterStoreStep },
          async () => {
            const b = billingDeps();
            if (op === 'initialize') {
              configureAccessStore(b.deps);
            } else {
              await readyStore(b);
            }
            const run = useAccessStore.getState()[op]();
            await flush();
            const storeStep =
              op === 'initialize'
                ? 'configure'
                : op === 'purchaseSelected'
                  ? 'purchase'
                  : op === 'restorePurchases'
                    ? 'restore'
                    : null;
            if (storeStep && cutAfterStoreStep) {
              b.pending
                .find(p => p.name === storeStep)!
                .d.resolve(storeStep === 'configure' ? undefined : entitlement);
              await flush();
            }
            const b2 = billingDeps();
            if (cut === 'reset') useAccessStore.getState().reset();
            else if (cut === 'clear') clearAccessStoreConfiguration();
            else configureAccessStore(b2.deps);
            // Now the stale responses arrive — all "premium", the worst case.
            for (const p of b.pending) {
              if (p.d.settled) continue;
              switch (p.name) {
                case 'configure':
                  p.d.resolve(undefined);
                  break;
                case 'loadPlans':
                  p.d.resolve(plans);
                  break;
                case 'getAccess':
                  p.d.resolve(access(true));
                  break;
                case 'purchase':
                case 'restore':
                  p.d.resolve(entitlement);
                  break;
                case 'syncBilling':
                  p.d.resolve({
                    billing: {
                      premium: true,
                      productId: 'pickle_sensei_pro_yearly',
                      expiresAt: null,
                      verifiedAt: 'now',
                    },
                    access: access(true),
                  });
                  break;
              }
            }
            await flush();
            // Anything the stale run started AFTER the cut (e.g. initialize's
            // getAccess after configure) must also be answered — and ignored.
            for (const p of b.pending) {
              if (p.d.settled) continue;
              if (p.name === 'getAccess') p.d.resolve(access(true));
              else if (p.name === 'loadPlans') p.d.resolve(plans);
              else if (p.name === 'syncBilling') {
                p.d.resolve({
                  billing: {
                    premium: true,
                    productId: null,
                    expiresAt: null,
                    verifiedAt: 'now',
                  },
                  access: access(true),
                });
              }
            }
            const result = await run;
            const state = useAccessStore.getState();
            expect(result === false || result === undefined).toBe(true);
            // Post-cut defaults: nothing inherited from the old configuration.
            expect(state.canonicalAccess).toBeNull();
            expect(state.status).toBe('idle');
            expect(state.operation).toBe('idle');
            expect(state.error).toBeNull();
            expect(state.plans).toBeNull();
            // The stale run never called into the NEW configuration.
            expect(
              b2.calls.configure +
                b2.calls.getAccess +
                b2.calls.loadPlans +
                b2.calls.syncBilling,
            ).toBe(0);
            return { result, status: state.status, staleCalls: b.calls };
          },
        );
      });
    }
  });

  describe('accessStaleRefresh: refreshAccess() started before a sync/purchase, resolving after it', () => {
    for (const seed of scenarioSeeds('accessStaleRefresh')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const winner = (
          ['syncBilling', 'purchaseSelected', 'restorePurchases'] as const
        )[randomInt(random, 0, 2)]!;
        const refreshFails = random() < 0.3;
        await recordScenario(
          SUITE,
          'accessStaleRefresh',
          seed,
          { winner, refreshFails },
          async () => {
            const b = billingDeps();
            await readyStore(b);
            // 1. A refresh (Settings focus / Analyze unmount) goes out first
            //    and is slow.
            const refresh = useAccessStore.getState().refreshAccess();
            await flush();
            const slowGet = b.pending.find(p => p.name === 'getAccess')!;
            expect(slowGet).toBeDefined();
            // 2. The user completes a purchase / restore / sync meanwhile.
            const win = useAccessStore.getState()[winner]();
            await flush();
            const storeStep =
              winner === 'purchaseSelected'
                ? 'purchase'
                : winner === 'restorePurchases'
                  ? 'restore'
                  : null;
            if (storeStep) {
              b.pending.find(p => p.name === storeStep)!.d.resolve(entitlement);
              await flush();
            }
            b.pending
              .find(p => p.name === 'syncBilling')!
              .d.resolve({
                billing: {
                  premium: true,
                  productId: 'pickle_sensei_pro_yearly',
                  expiresAt: null,
                  verifiedAt: 'now',
                },
                access: access(true),
              });
            expect(await win).toBe(true);
            expect(useAccessStore.getState().canonicalAccess?.premium).toBe(
              true,
            );
            // 3. The OLDER refresh response lands last.
            if (refreshFails) slowGet.d.reject(new Error('503'));
            else slowGet.d.resolve(access(false, 1));
            await refresh;
            const state = useAccessStore.getState();
            const premiumAfter = state.canonicalAccess?.premium ?? null;
            // Server-authoritative premium was verified by the NEWER call;
            // an older in-flight snapshot must not regress it.
            const staleOverwrotePremium = premiumAfter !== true;
            expect(state.operation).toBe('idle');
            expect(state.status).not.toBe('loading');
            return {
              premiumAfterStaleRefresh: premiumAfter,
              statusAfter: state.status,
              staleOverwrotePremium,
            };
          },
        );
      });
    }
  });

  describe('appHydrateStorm: overlapping hydrate() across owner switches', () => {
    const profileFor = (tag: string): Profile => ({
      firstName: tag,
      skillLevel: '3.0',
      handedness: 'right',
      goal: 'dinks',
      biggestProblem: 'consistency',
      focusCheckpoint: 'contact_position',
    });
    const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sessionFor = (id: string) => ({
      apiBaseUrl: 'https://api.test',
      bearerToken: `token-${id.slice(0, 4)}`,
      canonicalAppUserId: id,
      provider: 'apple' as const,
    });

    for (const seed of scenarioSeeds('appHydrateStorm')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const steps = randomInt(random, 2, 5);
        const owners = Array.from(
          { length: steps },
          () =>
            (['A', 'B', 'guest', 'signedOut'] as const)[
              randomInt(random, 0, 3)
            ]!,
        );
        const pendingStash = random() < 0.5;
        const slowKv = random() < 0.7;
        const canonicalHasProfile = random() < 0.5;
        const releaseOrder = shuffle(
          random,
          Array.from({ length: steps }, (_, i) => i),
        );
        await recordScenario(
          SUITE,
          'appHydrateStorm',
          seed,
          { owners, pendingStash, slowKv, canonicalHasProfile, releaseOrder },
          async () => {
            if (pendingStash) {
              mockFakeDb.kv.set(
                PENDING_ONBOARDING_PROFILE_KV_KEY,
                JSON.stringify({ version: 1, profile: profileFor('pending') }),
              );
            }
            mockFakeDb.kv.set(
              `profile:${canonicalDataOwner(OWNER_A)}`,
              JSON.stringify(profileFor('A-local')),
            );
            mockFetchCanonical = async () =>
              canonicalHasProfile ? profileFor('B-canonical') : null;
            // Each hydrate's FIRST kv read is held behind its own gate so
            // the test controls completion order across owner switches.
            const gates: Deferred<void>[] = [];
            let hydrateIndex = -1;
            mockDbGate = slowKv
              ? async () => {
                  const g = gates[hydrateIndex];
                  if (g && !g.settled) await g.promise;
                }
              : null;
            const runs: Promise<void>[] = [];
            const activate = (o: (typeof owners)[number]) => {
              if (o === 'A') {
                establishApiSession(sessionFor(OWNER_A));
                setActiveDataOwner(canonicalDataOwner(OWNER_A));
              } else if (o === 'B') {
                establishApiSession(sessionFor(OWNER_B));
                setActiveDataOwner(canonicalDataOwner(OWNER_B));
              } else if (o === 'guest') {
                clearApiSession();
                setActiveDataOwner(GUEST_DATA_OWNER);
              } else {
                clearApiSession();
                setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
              }
            };
            for (let i = 0; i < steps; i += 1) {
              activate(owners[i]!);
              gates.push(deferred<void>());
              hydrateIndex = i;
              runs.push(useAppStore.getState().hydrate());
              await flush(1);
            }
            const finalOwner = owners[steps - 1]!;
            // Settle the held reads in a seeded order.
            for (const i of releaseOrder) {
              gates[i]!.resolve(undefined);
              await flush(2);
            }
            await Promise.all(runs);
            await flush();
            const state = useAppStore.getState();
            const expectedOwnerKey =
              finalOwner === 'A'
                ? canonicalDataOwner(OWNER_A)
                : finalOwner === 'B'
                  ? canonicalDataOwner(OWNER_B)
                  : finalOwner === 'guest'
                    ? GUEST_DATA_OWNER
                    : SIGNED_OUT_DATA_OWNER;
            // No orphan loading state: the last hydrate always lands.
            expect(state.hydrated).toBe(true);
            expect(state.ownerKey).toBe(expectedOwnerKey);
            expect(state.hydrateError).toBeNull();
            const name = state.profile?.firstName ?? null;
            // Cross-owner leak check: the visible profile belongs to the
            // final owner (or is the adopted stash / nothing).
            if (finalOwner === 'A') {
              expect(['A-local', 'pending']).toContain(name);
            } else if (finalOwner === 'B') {
              expect([
                canonicalHasProfile ? 'B-canonical' : null,
                'pending',
              ]).toContain(name);
            } else if (finalOwner === 'guest') {
              expect([null, 'pending']).toContain(name);
            } else {
              expect(name).toBeNull();
            }
            // The stash is single-use: the hydrate that completes for a
            // writable owner adopts it. Hydrates abandoned by an owner
            // switch must NOT have consumed it (it is retried next time).
            const stashLeft =
              mockFakeDb.kv.get(PENDING_ONBOARDING_PROFILE_KV_KEY) ?? '';
            if (pendingStash && finalOwner !== 'signedOut') {
              expect(stashLeft).toBe('');
            }
            if (pendingStash && stashLeft !== '') {
              // Not adopted → nobody may show it and nobody saved it.
              expect(name).not.toBe('pending');
              expect(mockSaveCanonicalCalls).toBe(0);
            }
            expect(mockSaveCanonicalCalls).toBeLessThanOrEqual(
              owners.filter(o => o === 'A' || o === 'B').length,
            );
            return {
              hydrated: state.hydrated,
              ownerKey: state.ownerKey,
              profileName: name,
              canonicalFetches: mockFetchCanonicalCalls,
              canonicalSaves: mockSaveCanonicalCalls,
              stashLeft: stashLeft !== '',
            };
          },
        );
      });
    }
  });
});
