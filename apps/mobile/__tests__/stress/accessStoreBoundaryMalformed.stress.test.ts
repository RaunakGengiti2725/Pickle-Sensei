/**
 * STRESS / mod-access-store / lens boundary-malformed.
 *
 * Seeded campaign of malformed, truncated, wrong-typed, prototype-polluting,
 * numerically-extreme, oversized and unicode-hostile inputs against the REAL
 * `src/state/accessStore.ts` through its public surface. The model, the
 * generators and the invariants live in
 * test-support/stress/accessStoreMalformedHarness.ts.
 *
 * Scale:   STRESS_ITER=<n>      iterations (default 300; campaign runs used 3000+)
 *          STRESS_SEED=<n>      campaign seed (default 20260904)
 *          STRESS_STRUCTURAL=<p> share of dependency methods that are missing /
 *                               not a function / throw synchronously (default 0.08)
 * Replay:  STRESS_REPLAY=<seed>[,<seed>...] run exactly those iteration seeds
 * Output:  STRESS_OUT=<dir>     JSON table seed → outcome
 *                               (default artifacts/stress/access-store-boundary-malformed)
 *
 * Every violation is classified against the KNOWN_DEFECTS table below by its
 * exact signature. The campaign FAILS on any violation that is not a listed
 * known defect. Each known defect also has a deterministic pin below written
 * with `test.failing`, so fixing the store flips that pin red and tells the
 * fixer to delete the table entry.
 */
import {
  BillingError,
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type StorePlans,
} from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectHasPremium,
  selectPaywallRequired,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  iterationSeed,
  runIteration,
  hasStructuralPlan,
  type IterationResult,
  type Violation,
} from '../../test-support/stress/accessStoreMalformedHarness';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see be-mobile-sync-outbox.test.ts), so the shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const REPLAY = process.env.STRESS_REPLAY;
const REPLAY_COUNT = REPLAY === undefined ? 0 : REPLAY.split(',').length;
const ITERATIONS =
  REPLAY === undefined ? Number(process.env.STRESS_ITER ?? 300) : REPLAY_COUNT;
const CAMPAIGN_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const STRUCTURAL_RATE = Number(process.env.STRESS_STRUCTURAL ?? 0.08);
const OUT_DIR =
  process.env.STRESS_OUT ??
  join(
    __dirname,
    '..',
    '..',
    'artifacts',
    'stress',
    'access-store-boundary-malformed',
  );

// ---------------------------------------------------------------------------
// Known defects (exact signatures). Delete an entry once the store is fixed —
// its `test.failing` pin below turns red at the same moment.
// ---------------------------------------------------------------------------

interface KnownDefect {
  id: string;
  severity: 'P2' | 'P3';
  where: string;
  matches(v: Violation): boolean;
}

const KNOWN_DEFECTS: readonly KnownDefect[] = [
  {
    id: 'KD1-initialize-rejects-on-sync-throwing-dependency',
    severity: 'P3',
    where: 'src/state/accessStore.ts:103-145',
    matches: v =>
      (v.invariant === 'op-no-throw' && v.afterOp === 'initialize') ||
      (v.invariant === 'settled-idle' &&
        v.detail === 'status=loading with nothing in flight'),
  },
  {
    id: 'KD2-selectPaywallRequired-not-fail-closed',
    severity: 'P3',
    where: 'src/state/accessStore.ts:97-98',
    matches: v =>
      v.invariant === 'selectors-boolean' &&
      v.detail.startsWith('selectPaywallRequired'),
  },
  {
    id: 'KD3-syncBilling-returns-raw-premium',
    severity: 'P3',
    where: 'src/state/accessStore.ts:240',
    matches: v =>
      v.invariant === 'op-returns-boolean' &&
      v.detail.startsWith('syncBilling()'),
  },
  {
    id: 'KD4-purchase-called-with-non-string-plan-id',
    severity: 'P3',
    where: 'src/state/accessStore.ts:273-296 (selectedPlan, plan.id)',
    matches: v => v.invariant === 'purchase-arg-string',
  },
  {
    id: 'KD5-billing-error-fields-passed-through-unchecked',
    severity: 'P3',
    where: 'src/state/accessStore.ts:47-55 (billingError passthrough)',
    matches: v => v.invariant === 'error-shape',
  },
  {
    id: 'KD6-concurrent-refresh-out-of-order-keeps-stale-snapshot',
    severity: 'P2',
    where: 'src/state/accessStore.ts:194-200',
    matches: v => v.invariant === 'latest-refresh-wins',
  },
];

function classify(v: Violation): string | null {
  return KNOWN_DEFECTS.find(d => d.matches(v))?.id ?? null;
}

interface ClassifiedResult extends IterationResult {
  knownDefects: string[];
  unknownViolations: Violation[];
  structural: boolean;
  replay: string;
}

function seeds(): Array<{ index: number; seed: number }> {
  if (REPLAY !== undefined) {
    return REPLAY.split(',').map((raw, index) => {
      const seed = Number(raw.trim());
      if (!Number.isInteger(seed)) {
        throw new Error(`STRESS_REPLAY must be integer seeds, got ${REPLAY}`);
      }
      return { index: -1 - index, seed };
    });
  }
  return Array.from({ length: ITERATIONS }, (_, index) => ({
    index,
    seed: iterationSeed(CAMPAIGN_SEED, index),
  }));
}

const results: ClassifiedResult[] = [];
const wallStart = Date.now();

afterAll(() => {
  const byInvariant: Record<string, number> = {};
  const byKnownDefect: Record<string, { hits: number; minimalSeed: number }> =
    {};
  const byOp: Record<string, number> = {};
  let unknown = 0;
  let totalOps = 0;
  let maxErrorMessageLength = 0;
  for (const r of results) {
    totalOps += r.ops.length;
    maxErrorMessageLength = Math.max(
      maxErrorMessageLength,
      r.stats.maxErrorMessageLength,
    );
    for (const op of r.ops) byOp[op.op] = (byOp[op.op] ?? 0) + 1;
    for (const v of r.violations) {
      byInvariant[v.invariant] = (byInvariant[v.invariant] ?? 0) + 1;
    }
    for (const id of r.knownDefects) {
      const entry = byKnownDefect[id] ?? { hits: 0, minimalSeed: r.seed };
      entry.hits += 1;
      const current = results.find(x => x.seed === entry.minimalSeed);
      if (current && r.ops.length < current.ops.length) {
        entry.minimalSeed = r.seed;
      }
      byKnownDefect[id] = entry;
    }
    unknown += r.unknownViolations.length;
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    unit: 'apps/mobile/src/state/accessStore.ts',
    lens: 'boundary-malformed',
    campaignSeed: CAMPAIGN_SEED,
    iterations: ITERATIONS,
    structuralRate: STRUCTURAL_RATE,
    replay: REPLAY ?? null,
    executed: results.length,
    executedOps: totalOps,
    clean: results.filter(r => r.violations.length === 0).length,
    withKnownDefectsOnly: results.filter(
      r => r.violations.length > 0 && r.unknownViolations.length === 0,
    ).length,
    withUnknownViolations: results.filter(r => r.unknownViolations.length > 0)
      .length,
    unknownViolations: unknown,
    structuralIterations: results.filter(r => r.structural).length,
    wallMs: Date.now() - wallStart,
    maxErrorMessageLength,
    byInvariant,
    byOp,
    byKnownDefect,
    knownDefects: KNOWN_DEFECTS.map(d => ({
      id: d.id,
      severity: d.severity,
      where: d.where,
    })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, 'results.json'),
    JSON.stringify(
      results.map(r => ({
        seed: r.seed,
        index: r.index,
        ok: r.ok,
        structural: r.structural,
        knownDefects: r.knownDefects,
        unknownViolations: r.unknownViolations,
        violations: r.violations,
        ops: r.ops,
        dependencyPlans: r.dependencyPlans,
        stats: r.stats,
        replay: r.replay,
      })),
      null,
      1,
    ),
  );
});

describe('accessStore × boundary-malformed campaign', () => {
  test(`${ITERATIONS} seeded iterations hold every invariant (known defects tabulated)`, async () => {
    for (const { index, seed } of seeds()) {
      let result: IterationResult;
      try {
        result = await runIteration(seed, index, {
          structuralRate: STRUCTURAL_RATE,
          maxOps: 8,
        });
      } catch (error) {
        // Never lose the seed table to one exploding iteration: a throw out
        // of the harness itself is reported as an (unknown) violation.
        result = {
          seed,
          index,
          ok: false,
          ops: [],
          dependencyPlans: [],
          violations: [
            {
              invariant: 'harness-threw',
              detail: String(
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : error,
              ),
              afterOp: 'runIteration',
            },
          ],
          stats: {
            storeCalls: 0,
            deferredSettled: 0,
            maxErrorMessageLength: 0,
          },
        };
      }
      const knownDefects = Array.from(
        new Set(
          result.violations
            .map(classify)
            .filter((id): id is string => id !== null),
        ),
      );
      const unknownViolations = result.violations.filter(
        v => classify(v) === null,
      );
      results.push({
        ...result,
        knownDefects,
        unknownViolations,
        structural: hasStructuralPlan(result),
        replay: `cd apps/mobile && STRESS_REPLAY=${seed} npx jest --ci __tests__/stress/accessStoreBoundaryMalformed.stress.test.ts`,
      });
    }
    const unknown = results.filter(r => r.unknownViolations.length > 0);
    expect(
      unknown.map(r => ({
        seed: r.seed,
        replay: r.replay,
        ops: r.ops,
        unknownViolations: r.unknownViolations,
      })),
    ).toEqual([]);
    expect(results.length).toBe(ITERATIONS);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Deterministic pins for every known defect (minimized payloads).
// `test.failing` passes while the defect exists and FAILS once it is fixed.
// ---------------------------------------------------------------------------

const validAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 0,
    reserved: 0,
    remaining: 2,
    availableToReserve: 2,
  },
  canStartRating: true,
  paywallRequired: false,
};

const validPlans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
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

function deps(overrides: {
  store?: Partial<BillingAccessDependencies['store']>;
  backend?: Partial<BillingAccessDependencies['backend']>;
}): BillingAccessDependencies {
  return {
    store: {
      configure: async () => undefined,
      loadPlans: async () => validPlans,
      purchase: async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_yearly',
        expirationDate: null,
      }),
      restore: async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_yearly',
        expirationDate: null,
      }),
      readEntitlement: async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      }),
      ...overrides.store,
    },
    backend: {
      getAccess: async () => validAccess,
      syncBilling: async () => ({
        billing: {
          premium: true,
          productKey: 'pickle_sensei_pro_yearly',
          expiresAt: null,
          verifiedAt: '2026-09-04T00:00:00.000Z',
        },
        access: { ...validAccess, premium: true, entitlements: ['premium'] },
      }),
      ...overrides.backend,
    },
  };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('known defects — deterministic pins (flip red when fixed)', () => {
  test.failing(
    'KD1: initialize() settles and leaves status≠loading when backend.getAccess throws synchronously',
    async () => {
      configureAccessStore(
        deps({
          backend: {
            getAccess: (() => {
              throw new TypeError('not a promise');
            }) as unknown as () => Promise<CanonicalAccessState>,
          },
        }),
      );
      let rejected: unknown = null;
      await useAccessStore
        .getState()
        .initialize()
        .catch((reason: unknown) => {
          rejected = reason;
        });
      expect(rejected).toBeNull();
      expect(useAccessStore.getState().status).not.toBe('loading');
    },
  );

  test.failing(
    'KD1b: a second initialize() after the rejected one is not a permanent no-op',
    async () => {
      let calls = 0;
      configureAccessStore(
        deps({
          backend: {
            getAccess: (() => {
              calls += 1;
              if (calls === 1) throw new TypeError('not a promise');
              return Promise.resolve(validAccess);
            }) as unknown as () => Promise<CanonicalAccessState>,
          },
        }),
      );
      await useAccessStore
        .getState()
        .initialize()
        .catch(() => undefined);
      await useAccessStore.getState().initialize();
      expect(calls).toBe(2);
      expect(useAccessStore.getState().status).toBe('ready');
    },
  );

  test.failing(
    'KD1c: initialize() settles when the dependencies object has no backend',
    async () => {
      const partial = { store: deps({}).store } as BillingAccessDependencies;
      configureAccessStore(partial);
      let rejected: unknown = null;
      await useAccessStore
        .getState()
        .initialize()
        .catch((reason: unknown) => {
          rejected = reason;
        });
      expect(rejected).toBeNull();
      expect(useAccessStore.getState().status).not.toBe('loading');
    },
  );

  test.failing(
    'KD2: selectPaywallRequired is a strict boolean for a snapshot without paywallRequired',
    async () => {
      configureAccessStore(
        deps({
          backend: {
            getAccess: async () =>
              ({
                premium: false,
                entitlements: [],
                freeRatings: validAccess.freeRatings,
                canStartRating: false,
              }) as unknown as CanonicalAccessState,
          },
        }),
      );
      await useAccessStore.getState().refreshAccess();
      const state = useAccessStore.getState();
      expect(selectCanStartRating(state)).toBe(false);
      expect(selectHasPremium(state)).toBe(false);
      expect(typeof selectPaywallRequired(state)).toBe('boolean');
      // Fail-closed like its siblings: unknown → paywall required.
      expect(selectPaywallRequired(state)).toBe(true);
    },
  );

  test.failing(
    'KD2b: selectPaywallRequired does not throw when the backend resolved undefined',
    async () => {
      configureAccessStore(
        deps({
          backend: {
            getAccess: async () => undefined as unknown as CanonicalAccessState,
          },
        }),
      );
      await useAccessStore.getState().refreshAccess();
      expect(() =>
        selectPaywallRequired(useAccessStore.getState()),
      ).not.toThrow();
    },
  );

  test.failing(
    'KD3: syncBilling() resolves a strict boolean when access.premium is a string',
    async () => {
      configureAccessStore(
        deps({
          backend: {
            syncBilling: async () =>
              ({
                billing: {
                  premium: true,
                  productKey: null,
                  expiresAt: null,
                  verifiedAt: '2026-09-04T00:00:00.000Z',
                },
                access: { ...validAccess, premium: 'true' },
              }) as unknown as Awaited<
                ReturnType<BillingAccessDependencies['backend']['syncBilling']>
              >,
          },
        }),
      );
      await useAccessStore.getState().initialize();
      const result: unknown = await useAccessStore.getState().syncBilling();
      expect(typeof result).toBe('boolean');
    },
  );

  test.failing(
    'KD4: purchaseSelected() never calls store.purchase with a non-string plan id',
    async () => {
      const purchase = jest.fn(async () => ({
        premium: true,
        productId: 'x',
        expirationDate: null,
      }));
      configureAccessStore(
        deps({
          store: {
            loadPlans: async () =>
              ({
                offeringId: 'default',
                annual: 'pickle_sensei_pro_yearly',
                monthly: null,
                lifetime: null,
              }) as unknown as StorePlans,
            purchase,
          },
        }),
      );
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().purchaseSelected();
      for (const call of purchase.mock.calls as unknown[][]) {
        expect(typeof call[0]).toBe('string');
      }
      expect(purchase).not.toHaveBeenCalledWith(undefined);
    },
  );

  test.failing(
    'KD5: a dependency BillingError with an out-of-enum code is not surfaced verbatim',
    async () => {
      configureAccessStore(
        deps({
          backend: {
            getAccess: async () => {
              throw new BillingError(
                'billing.nope' as BillingError['code'],
                'x'.repeat(70_000),
                'yes' as unknown as boolean,
              );
            },
          },
        }),
      );
      await useAccessStore.getState().refreshAccess();
      const error = useAccessStore.getState().error;
      expect(error).not.toBeNull();
      expect([
        'billing.unconfigured',
        'billing.offerings_unavailable',
        'billing.purchase_cancelled',
        'billing.purchase_failed',
        'billing.restore_failed',
        'billing.backend_unconfigured',
        'billing.backend_unavailable',
        'billing.backend_invalid_response',
        'billing.backend_verification_pending',
      ]).toContain(error?.code);
      expect(typeof error?.retryable).toBe('boolean');
    },
  );

  test.failing(
    'KD6: when two refreshes of one account resolve out of order, the later-issued snapshot wins',
    async () => {
      const resolvers: Array<(value: CanonicalAccessState) => void> = [];
      configureAccessStore(
        deps({
          backend: {
            getAccess: () =>
              new Promise<CanonicalAccessState>(resolve => {
                resolvers.push(resolve);
              }),
          },
        }),
      );
      const older: CanonicalAccessState = {
        ...validAccess,
        freeRatings: {
          limit: 2,
          used: 1,
          reserved: 0,
          remaining: 1,
          availableToReserve: 1,
        },
      };
      const newer: CanonicalAccessState = {
        ...validAccess,
        freeRatings: {
          limit: 2,
          used: 2,
          reserved: 0,
          remaining: 0,
          availableToReserve: 0,
        },
        canStartRating: false,
        paywallRequired: true,
      };
      const first = useAccessStore.getState().refreshAccess();
      const second = useAccessStore.getState().refreshAccess();
      expect(resolvers).toHaveLength(2);
      resolvers[1]?.(newer);
      await second;
      resolvers[0]?.(older);
      await first;
      expect(useAccessStore.getState().canonicalAccess).toBe(newer);
    },
  );
});

describe('boundaries that HELD (deterministic pins of the campaign invariants)', () => {
  test('prototype-pollution keys in a snapshot never reach Object.prototype', async () => {
    const polluted = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"premium":true,"entitlements":["premium"],"freeRatings":{"limit":2,"used":0,"reserved":0,"remaining":2,"availableToReserve":2},"canStartRating":true,"paywallRequired":false}',
    ) as CanonicalAccessState;
    configureAccessStore(
      deps({ backend: { getAccess: async () => polluted } }),
    );
    await useAccessStore.getState().initialize();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(useAccessStore.getState().canonicalAccess).toBe(polluted);
  });

  test('selectPeriod ignores every non-enum period including prototype keys', () => {
    configureAccessStore(deps({}));
    for (const period of [
      '__proto__',
      'constructor',
      '',
      null,
      undefined,
      0,
      Number.NaN,
      'ANNUAL',
      'annual\u0000',
      ['annual'],
      { toString: () => 'annual' },
    ]) {
      expect(() =>
        useAccessStore.getState().selectPeriod(period as 'annual'),
      ).not.toThrow();
      expect(useAccessStore.getState().selectedPeriod).toBe('annual');
    }
  });

  test('non-Error rejection reasons (null, string, bigint, object) become typed billing errors', async () => {
    for (const reason of [null, undefined, 'offline', 42, BigInt(7), {}, []]) {
      clearAccessStoreConfiguration();
      configureAccessStore(
        deps({
          backend: {
            getAccess: async () => {
              throw reason;
            },
          },
        }),
      );
      await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(
        false,
      );
      const state = useAccessStore.getState();
      expect(state.status).toBe('error');
      expect(state.canonicalAccess).toBeNull();
      expect(state.error?.code).toBe('billing.backend_unavailable');
      expect(selectCanStartRating(state)).toBe(false);
    }
  });

  test('a stale response landing after sign-out never repopulates the store, whatever its shape', async () => {
    for (const payload of [
      validAccess,
      { ...validAccess, premium: true, entitlements: ['premium'] },
      'premium',
      null,
      { __proto__: { polluted: 'yes' } },
    ]) {
      let resolve!: (value: CanonicalAccessState) => void;
      configureAccessStore(
        deps({
          backend: {
            getAccess: () =>
              new Promise<CanonicalAccessState>(r => {
                resolve = r;
              }),
          },
        }),
      );
      const refresh = useAccessStore.getState().refreshAccess();
      clearAccessStoreConfiguration();
      resolve(payload as CanonicalAccessState);
      await expect(refresh).resolves.toBe(false);
      const state = useAccessStore.getState();
      expect(state.status).toBe('idle');
      expect(state.canonicalAccess).toBeNull();
      expect(selectHasPremium(state)).toBe(false);
    }
  });

  test('syncBilling with a non-object response fails closed without throwing', async () => {
    for (const payload of [
      null,
      undefined,
      'ok',
      0,
      [],
      {},
      { access: null },
    ]) {
      clearAccessStoreConfiguration();
      configureAccessStore(
        deps({
          backend: {
            syncBilling: async () =>
              payload as unknown as Awaited<
                ReturnType<BillingAccessDependencies['backend']['syncBilling']>
              >,
          },
        }),
      );
      await useAccessStore.getState().initialize();
      await expect(useAccessStore.getState().syncBilling()).resolves.toBe(
        false,
      );
      const state = useAccessStore.getState();
      expect(state.operation).toBe('idle');
      expect(state.canonicalAccess).toBeNull();
      expect(state.error?.code).toBe('billing.backend_verification_pending');
    }
  });
});
