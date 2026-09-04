/**
 * STRESS / boundary-malformed — `src/state/accessStore.ts` composed with the
 * real `src/billing` clients (`createBillingAccessDependencies`).
 *
 * Every seed is a random interleaving of store operations (initialize /
 * refreshAccess / syncBilling / purchaseSelected / restorePurchases /
 * selectPeriod / reset / reconfigure / sign-out / token rotation) against a
 * RevenueCat SDK and a backend whose responses are deferred and settled out of
 * order with malformed bodies (mutated / weird JSON, wrong types, prototype
 * keys, 64 KB strings, NaN / Infinity / -0, future keys, empty containers),
 * transport failures, 4xx/5xx and cancellations. Invariants checked after
 * every step and at quiescence:
 *   - no store method ever rejects;
 *   - `status` / `operation` / `selectedPeriod` stay in their enums, `error`
 *     is null or a fully typed `BillingErrorState`;
 *   - `canonicalAccess` is null or byte-identical to a coherent 2xx body the
 *     backend actually returned — store entitlement never unlocks access;
 *   - `plans` is null or a `StorePlans` the adapter returned, and the selected
 *     period always resolves to an existing plan;
 *   - after `clearAccessStoreConfiguration()` / `reset()` the state stays at
 *     the defaults no matter what settles late;
 *   - every completed store purchase / restore under an unchanged
 *     configuration is followed by a canonical `/v1/billing/sync` POST;
 *   - at quiescence `operation === 'idle'` and `status !== 'loading'`;
 *   - `Object.prototype` is untouched afterwards.
 *
 * Replay one seed:  STRESS_ONLY=<seed> npx jest --ci __tests__/stress/billingStoreInterleavingFuzz.stress.test.ts
 * Scale:            STRESS_ITER=3000 npx jest --ci __tests__/stress/billingStoreInterleavingFuzz.stress.test.ts
 */
import {
  clearApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  createBillingAccessDependencies,
  type RevenueCatCustomerInfoLike,
  type RevenueCatSdk,
  type StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
  type AccessStoreState,
} from '../../src/state/accessStore';
import {
  BILLING_ERROR_CODES,
  corruptJsonText,
  deferred,
  describeError,
  isCoherentAccess,
  isCoherentBilling,
  mutate,
  pollutionProbe,
  replayCommand,
  Rng,
  seedsFor,
  settle,
  stressConfig,
  summarize,
  TEXT_CORRUPTIONS,
  UNCONFIGURED_REASONS,
  WEIRD_STRINGS,
  weirdValue,
  writeTable,
  type Deferred,
  type StressRow,
} from '../../test-support/stress/billingFuzz';

const SUITE_FILE = 'billingStoreInterleavingFuzz.stress.test.ts';
const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

// ─── Base payloads ───────────────────────────────────────────────────────────

function coherentAccess(rng: Rng): JsonRecord {
  const premium = rng.chance(0.4);
  const used = rng.int(0, 2);
  const remaining = 2 - used;
  const reserved = rng.int(0, remaining);
  const available = remaining - reserved;
  const canStart = premium || available > 0;
  const entitlements: Json[] = premium ? ['premium'] : [];
  if (rng.chance(0.2)) entitlements.push('pickle_sensei_pro');
  return {
    premium,
    entitlements,
    freeRatings: {
      limit: 2,
      used,
      reserved,
      remaining,
      availableToReserve: available,
    },
    canStartRating: canStart,
    paywallRequired: !canStart,
  };
}

function coherentSync(rng: Rng): JsonRecord {
  const access = coherentAccess(rng);
  const premium = access['premium'] === true;
  return {
    access,
    billing: {
      premium,
      productKey: premium ? rng.pick(['annual', 'monthly', 'lifetime']) : null,
      expiresAt: premium && rng.chance(0.7) ? '2027-08-27T00:00:00.000Z' : null,
      verifiedAt: '2026-09-04T00:00:00.000Z',
    },
  };
}

function goodPackage(period: 'annual' | 'monthly' | 'lifetime'): JsonRecord {
  return {
    identifier: `$rc_${period}`,
    packageType: period.toUpperCase(),
    product: {
      identifier: `pickle_sensei_pro_${period}`,
      price: period === 'annual' ? 59.99 : period === 'monthly' ? 7.99 : 159.99,
      priceString:
        period === 'annual'
          ? '$59.99'
          : period === 'monthly'
            ? '$7.99'
            : '$159.99',
      pricePerMonthString: period === 'lifetime' ? null : '$5.00',
      introPrice:
        period === 'lifetime' ? null : { price: 0, cycles: 1, period: 'P7D' },
      defaultOption: null,
    },
  };
}

function goodOfferings(rng: Rng): JsonRecord {
  return {
    current: {
      identifier: 'default',
      annual: rng.chance(0.85) ? goodPackage('annual') : null,
      monthly: rng.chance(0.85) ? goodPackage('monthly') : null,
      lifetime: rng.chance(0.85) ? goodPackage('lifetime') : null,
    },
  };
}

function goodCustomerInfo(rng: Rng): JsonRecord {
  const active: JsonRecord = {};
  if (rng.chance(0.6)) {
    active[rng.pick(['pickle_sensei_pro', 'premium'])] = {
      productIdentifier: 'pickle_sensei_pro_annual',
      expirationDate: null,
    };
  }
  return { entitlements: { active } };
}

// ─── Reactions ───────────────────────────────────────────────────────────────

type Body =
  | { kind: 'value'; value: unknown; mutations: string[] }
  | { kind: 'text'; text: string; corruption: string }
  | { kind: 'json_throws' };

type HttpReaction =
  { kind: 'network_error' } | { kind: 'response'; status: number; body: Body };

type SdkReaction =
  | { kind: 'value'; value: unknown; mutations: string[] }
  | { kind: 'reject'; reason: unknown };

function bodyFor(rng: Rng, base: Json): Body {
  const roll = rng.int(0, 9);
  if (roll <= 5) {
    const { value, mutations } = mutate(
      rng,
      base,
      rng.pick([0, 0, 0, 1, 1, 2, 3, 5]),
    );
    return {
      kind: 'value',
      value,
      mutations: mutations.map(m => `${m.kind}@${m.path}`),
    };
  }
  if (roll <= 7) {
    const corruption = rng.pick(TEXT_CORRUPTIONS);
    return {
      kind: 'text',
      text: corruptJsonText(rng, base, corruption),
      corruption,
    };
  }
  if (roll === 8)
    return {
      kind: 'value',
      value: weirdValue(rng),
      mutations: ['whole_weird'],
    };
  return { kind: 'json_throws' };
}

const STATUS_POOL = [
  200,
  200,
  200,
  200,
  200,
  200,
  201,
  204,
  400,
  401,
  403,
  404,
  409,
  422,
  429,
  500,
  502,
  503,
  0,
  NaN,
];

function httpReaction(rng: Rng, base: Json, cleanBias: number): HttpReaction {
  if (rng.chance(cleanBias))
    return {
      kind: 'response',
      status: 200,
      body: { kind: 'value', value: base, mutations: [] },
    };
  if (rng.chance(0.1)) return { kind: 'network_error' };
  return {
    kind: 'response',
    status: rng.pick(STATUS_POOL),
    body: bodyFor(rng, base),
  };
}

function sdkReaction(
  rng: Rng,
  base: Json,
  cleanChance: number,
  cleanBias = 0,
): SdkReaction {
  if (rng.chance(Math.max(cleanChance, cleanBias)))
    return { kind: 'value', value: base, mutations: [] };
  const roll = rng.int(0, 9);
  if (roll <= 4) {
    const { value, mutations } = mutate(rng, base, rng.pick([1, 1, 2, 3]));
    return {
      kind: 'value',
      value,
      mutations: mutations.map(m => `${m.kind}@${m.path}`),
    };
  }
  if (roll <= 6)
    return {
      kind: 'value',
      value: weirdValue(rng),
      mutations: ['whole_weird'],
    };
  return {
    kind: 'reject',
    reason: rng.pick<unknown>([
      { userCancelled: true, code: '1' },
      { code: '1' },
      { userCancelled: false, code: '2', message: 'store unavailable' },
      new Error('StoreKit failure'),
      'PURCHASE_NOT_ALLOWED',
      null,
      undefined,
      Object.assign(new TypeError('bridge exploded'), { userCancelled: true }),
    ]),
  };
}

// ─── Steps ───────────────────────────────────────────────────────────────────

type Step =
  | { op: 'initialize' }
  | { op: 'refreshAccess' }
  | { op: 'syncBilling' }
  | { op: 'purchaseSelected' }
  | { op: 'restorePurchases' }
  | { op: 'selectPeriod'; period: string }
  | { op: 'clearError' }
  | { op: 'reset' }
  | { op: 'reconfigure'; account: 'same' | 'other' | 'broken' }
  | { op: 'signOut' }
  | { op: 'rotateToken'; to: 'valid' | 'null' | 'blank' | 'huge' }
  | { op: 'settleOne' }
  | { op: 'settleAll' }
  | { op: 'tick' };

const STEP_POOL: ReadonlyArray<Step['op']> = [
  'initialize',
  'initialize',
  'refreshAccess',
  'refreshAccess',
  'syncBilling',
  'purchaseSelected',
  'purchaseSelected',
  'purchaseSelected',
  'restorePurchases',
  'restorePurchases',
  'selectPeriod',
  'clearError',
  'reset',
  'reconfigure',
  'signOut',
  'rotateToken',
  'settleOne',
  'settleOne',
  'settleOne',
  'settleOne',
  'settleAll',
  'tick',
  'tick',
];

function generateSteps(rng: Rng): Step[] {
  const count = rng.int(4, 14);
  const steps: Step[] = [{ op: 'initialize' }];
  // Half the seeds warm the store up so purchase / restore actually reach the
  // adapter and the backend; the other half attack it cold.
  if (rng.chance(0.5))
    steps.push(
      { op: 'settleAll' },
      { op: 'refreshAccess' },
      { op: 'settleAll' },
    );
  for (let i = 0; i < count; i++) {
    const op = rng.pick(STEP_POOL);
    switch (op) {
      case 'selectPeriod':
        steps.push({
          op,
          period: rng.pick([
            'annual',
            'monthly',
            'lifetime',
            'weekly',
            '',
            '__proto__',
            'ANNUAL',
          ]),
        });
        break;
      case 'reconfigure':
        steps.push({
          op,
          account: rng.pick(['same', 'same', 'other', 'broken']),
        });
        break;
      case 'rotateToken':
        steps.push({
          op,
          to: rng.pick(['valid', 'valid', 'null', 'blank', 'huge']),
        });
        break;
      default:
        steps.push({ op } as Step);
    }
  }
  return steps;
}

// ─── Environment ─────────────────────────────────────────────────────────────

interface PendingCall {
  id: number;
  label: string;
  settle(): void;
}

interface Env {
  rng: Rng;
  pending: PendingCall[];
  log: string[];
  nextId: number;
  token: string | null;
  account: 'same' | 'other' | 'broken';
  configVersion: number;
  /** Per-seed probability that a response is a clean, coherent 200 / SDK value. */
  cleanBias: number;
  /** JSON of every coherent access body a 2xx backend response carried. */
  servedAccess: Set<string>;
  servedPlans: unknown[];
  storeSuccesses: Array<{
    kind: 'purchase' | 'restore';
    version: number;
    completedUnder: number;
    seq: number;
  }>;
  syncPosts: Array<{ version: number; seq: number }>;
  seq: number;
  failures: string[];
  notes: string[];
}

function makeSdk(env: Env): RevenueCatSdk {
  const call = <T>(label: string, reaction: () => SdkReaction): Promise<T> => {
    const d: Deferred<T> = deferred<T>();
    const id = env.nextId++;
    env.log.push(`sdk:${label}#${id}`);
    const planned = reaction();
    env.pending.push({
      id,
      label: `sdk:${label}`,
      settle: () => {
        env.seq += 1;
        if (planned.kind === 'reject') d.reject(planned.reason);
        else d.resolve(planned.value as T);
      },
    });
    return d.promise;
  };
  return {
    isConfigured: () =>
      call('isConfigured', () => sdkReaction(env.rng, false, 0.9)),
    configure: () => call('configure', () => sdkReaction(env.rng, null, 0.9)),
    getAppUserID: () =>
      call('getAppUserID', () =>
        sdkReaction(
          env.rng,
          env.account === 'other' ? OTHER_ID : CANONICAL_ID,
          0.9,
        ),
      ),
    logIn: () => call('logIn', () => sdkReaction(env.rng, {}, 0.9)),
    getOfferings: () =>
      call('getOfferings', () =>
        sdkReaction(env.rng, goodOfferings(env.rng), 0.55, env.cleanBias),
      ),
    purchasePackage: () =>
      call('purchasePackage', () =>
        sdkReaction(
          env.rng,
          { customerInfo: goodCustomerInfo(env.rng) },
          0.5,
          env.cleanBias,
        ),
      ),
    restorePurchases: () =>
      call<RevenueCatCustomerInfoLike>('restorePurchases', () =>
        sdkReaction(env.rng, goodCustomerInfo(env.rng), 0.5, env.cleanBias),
      ),
    getCustomerInfo: () =>
      call('getCustomerInfo', () =>
        sdkReaction(env.rng, goodCustomerInfo(env.rng), 0.6, env.cleanBias),
      ),
    checkTrialOrIntroductoryPriceEligibility: () =>
      call('eligibility', () =>
        sdkReaction(
          env.rng,
          {
            pickle_sensei_pro_annual: { status: 2 },
            pickle_sensei_pro_monthly: { status: 0 },
          },
          0.6,
          env.cleanBias,
        ),
      ),
  };
}

function makeFetch(env: Env) {
  return (input: string, init?: RequestInit): Promise<Response> => {
    const d = deferred<Response>();
    const id = env.nextId++;
    const isSync = input.endsWith('/v1/billing/sync');
    env.log.push(
      `http:${init?.method ?? 'GET'} ${input.slice(input.lastIndexOf('/v1'))}#${id}`,
    );
    const base = isSync ? coherentSync(env.rng) : coherentAccess(env.rng);
    const planned = httpReaction(env.rng, base, env.cleanBias);
    env.pending.push({
      id,
      label: `http:${isSync ? 'sync' : 'access'}`,
      settle: () => {
        env.seq += 1;
        if (planned.kind === 'network_error') {
          d.reject(new TypeError('Network request failed'));
          return;
        }
        const ok = planned.status >= 200 && planned.status <= 299;
        let parsed: unknown;
        let parseable = true;
        if (planned.body.kind === 'value') parsed = planned.body.value;
        else if (planned.body.kind === 'text') {
          try {
            parsed = JSON.parse(planned.body.text);
          } catch {
            parseable = false;
          }
        } else parseable = false;
        if (ok && parseable) {
          const access = isSync
            ? (parsed as { access?: unknown } | null)?.access
            : parsed;
          if (isCoherentAccess(access)) {
            const syncOk =
              !isSync ||
              (isCoherentBilling((parsed as { billing?: unknown }).billing) &&
                (parsed as { billing: { premium: boolean } }).billing
                  .premium === access.premium);
            if (syncOk)
              env.servedAccess.add(JSON.stringify(normalizeAccess(access)));
          }
        }
        const body = planned.body;
        d.resolve({
          ok,
          status: planned.status,
          json: () => {
            if (body.kind === 'json_throws')
              return Promise.reject(
                new SyntaxError('Unexpected end of JSON input'),
              );
            if (body.kind === 'text') {
              try {
                return Promise.resolve(JSON.parse(body.text) as unknown);
              } catch (error) {
                return Promise.reject(error);
              }
            }
            return Promise.resolve(body.value);
          },
        } as unknown as Response);
      },
    });
    return d.promise;
  };
}

/** Same field order the parser emits, so byte comparison is meaningful. */
function normalizeAccess(access: unknown): unknown {
  const a = access as {
    premium: boolean;
    entitlements: string[];
    freeRatings: {
      used: number;
      reserved: number;
      remaining: number;
      availableToReserve: number;
    };
    canStartRating: boolean;
    paywallRequired: boolean;
  };
  return {
    premium: a.premium,
    entitlements: [...a.entitlements],
    freeRatings: {
      limit: 2,
      used: a.freeRatings.used,
      reserved: a.freeRatings.reserved,
      remaining: a.freeRatings.remaining,
      availableToReserve: a.freeRatings.availableToReserve,
    },
    canStartRating: a.canStartRating,
    paywallRequired: a.paywallRequired,
  };
}

function configure(env: Env): void {
  const sdk = makeSdk(env);
  const fetchFn = makeFetch(env);
  const config = {
    revenueCatPublicSdkKey:
      env.account === 'broken' ? 'sk_secret' : 'appl_public',
    canonicalAppUserId: env.account === 'other' ? OTHER_ID : CANONICAL_ID,
    apiBaseUrl: 'https://api.example.test',
    get apiToken() {
      return env.token;
    },
    fetchFn,
    revenueCatSdk: sdk,
    platform: 'ios' as const,
  };
  env.configVersion += 1;
  const deps = createBillingAccessDependencies(config);
  // Observe the adapter/backend boundary the store actually consumes (the
  // production objects are untouched; these are harness wrappers).
  const store = deps.store;
  const backend = deps.backend;
  configureAccessStore({
    store: {
      ...store,
      purchase: async planId => {
        const startedUnder = env.configVersion;
        const result = await store.purchase(planId);
        env.storeSuccesses.push({
          kind: 'purchase',
          version: startedUnder,
          completedUnder: env.configVersion,
          seq: env.seq,
        });
        return result;
      },
      restore: async () => {
        const startedUnder = env.configVersion;
        const result = await store.restore();
        env.storeSuccesses.push({
          kind: 'restore',
          version: startedUnder,
          completedUnder: env.configVersion,
          seq: env.seq,
        });
        return result;
      },
    },
    backend: {
      ...backend,
      syncBilling: () => {
        env.syncPosts.push({ version: env.configVersion, seq: env.seq });
        return backend.syncBilling();
      },
    },
  });
}

const DEFAULTS = {
  status: 'idle',
  operation: 'idle',
  plans: null,
  selectedPeriod: 'annual',
  canonicalAccess: null,
  error: null,
};

function dataOf(state: AccessStoreState) {
  return {
    status: state.status,
    operation: state.operation,
    plans: state.plans,
    selectedPeriod: state.selectedPeriod,
    canonicalAccess: state.canonicalAccess,
    error: state.error,
  };
}

function selectedPlanExists(plans: StorePlans | null, period: string): boolean {
  if (!plans) return true;
  return (
    (period === 'annual' && plans.annual !== null) ||
    (period === 'monthly' && plans.monthly !== null) ||
    (period === 'lifetime' && plans.lifetime !== null)
  );
}

function checkState(env: Env, where: string, expectDefaults: boolean): void {
  const state = useAccessStore.getState();
  const push = (f: string) => {
    if (!env.failures.some(existing => existing.startsWith(f.split(':')[0]!)))
      env.failures.push(`${f} @${where}`);
  };
  if (
    !['idle', 'loading', 'ready', 'unconfigured', 'error'].includes(
      state.status,
    )
  )
    push(`status_enum: ${String(state.status)}`);
  if (!['idle', 'purchasing', 'restoring', 'syncing'].includes(state.operation))
    push(`operation_enum: ${String(state.operation)}`);
  if (!['annual', 'monthly', 'lifetime'].includes(state.selectedPeriod))
    push(`period_enum: ${String(state.selectedPeriod)}`);
  if (state.error !== null) {
    const e = state.error;
    if (
      typeof e !== 'object' ||
      !BILLING_ERROR_CODES.has(e.code) ||
      typeof e.message !== 'string' ||
      e.message.length === 0 ||
      typeof e.retryable !== 'boolean' ||
      (e.unconfiguredReason !== undefined &&
        !UNCONFIGURED_REASONS.has(e.unconfiguredReason)) ||
      Object.keys(e).some(
        k =>
          !['code', 'message', 'retryable', 'unconfiguredReason'].includes(k),
      )
    ) {
      push(`error_shape: ${JSON.stringify(summarize(e))}`);
    }
    if (/\b(TypeError|SyntaxError|Unexpected token|at )\b/.test(e.message))
      push('error_leaks_internal_detail');
  }
  if (state.canonicalAccess !== null) {
    if (!isCoherentAccess(state.canonicalAccess))
      push('canonical_access_incoherent');
    else if (
      !env.servedAccess.has(
        JSON.stringify(normalizeAccess(state.canonicalAccess)),
      )
    )
      push('canonical_access_not_from_backend');
  }
  if (state.plans !== null && !env.servedPlans.includes(state.plans)) {
    // The adapter returns a fresh object per load; compare structurally.
    const json = JSON.stringify(state.plans);
    if (!env.servedPlans.some(p => JSON.stringify(p) === json))
      push('plans_not_from_adapter');
  }
  if (!selectedPlanExists(state.plans, state.selectedPeriod))
    push(`selected_period_without_plan: ${state.selectedPeriod}`);
  if (
    expectDefaults &&
    JSON.stringify(dataOf(state)) !== JSON.stringify(DEFAULTS)
  ) {
    push(
      `defaults_violated: ${JSON.stringify(summarize(dataOf(state))).slice(0, 200)}`,
    );
  }
}

async function runScenario(seed: number): Promise<StressRow> {
  const start = Date.now();
  const rng = new Rng(seed);
  const steps = generateSteps(rng);
  const cleanBias = rng.pick([0, 0.3, 0.6, 0.85]);
  const env: Env = {
    rng,
    pending: [],
    log: [],
    nextId: 1,
    token: 'tok-valid',
    account: 'same',
    configVersion: 0,
    cleanBias,
    servedAccess: new Set(),
    servedPlans: [],
    storeSuccesses: [],
    syncPosts: [],
    seq: 0,
    failures: [],
    notes: [],
  };
  clearApiSession();
  setApiUnauthorizedListener(null);
  clearAccessStoreConfiguration();
  configure(env);

  const inflight: Array<Promise<void>> = [];
  const rejections: string[] = [];
  let expectDefaults = false;
  const track = (label: string, promise: Promise<unknown>) => {
    inflight.push(
      promise.then(
        value => {
          if (
            label === 'initialize'
              ? value !== undefined
              : typeof value !== 'boolean'
          ) {
            env.failures.push(`${label}_bad_return: ${String(value)}`);
          }
        },
        error => {
          rejections.push(`${label}: ${describeError(error)}`);
        },
      ),
    );
  };

  // `plans` provenance: observe what the adapter hands the store.
  const unsubscribe = useAccessStore.subscribe(state => {
    if (state.plans !== null && !env.servedPlans.includes(state.plans))
      env.servedPlans.push(state.plans);
  });

  const settleOne = () => {
    if (env.pending.length === 0) return;
    const index = env.rng.int(0, env.pending.length - 1);
    const [call] = env.pending.splice(index, 1);
    env.log.push(`settle:${call!.label}#${call!.id}`);
    call!.settle();
  };

  for (const step of steps) {
    const store = useAccessStore.getState();
    env.log.push(
      `step:${step.op}${'period' in step ? `(${step.period})` : ''}${'account' in step ? `(${step.account})` : ''}${'to' in step ? `(${step.to})` : ''}`,
    );
    switch (step.op) {
      case 'initialize':
      case 'refreshAccess':
      case 'syncBilling':
      case 'purchaseSelected':
      case 'restorePurchases':
        expectDefaults = false;
        try {
          track(step.op, store[step.op]());
        } catch (error) {
          env.failures.push(`${step.op}_threw_sync: ${describeError(error)}`);
        }
        break;
      case 'selectPeriod':
        try {
          store.selectPeriod(step.period as 'annual');
        } catch (error) {
          env.failures.push(`selectPeriod_threw: ${describeError(error)}`);
        }
        break;
      case 'clearError':
        store.clearError();
        break;
      case 'reset':
        store.reset();
        env.configVersion += 1;
        expectDefaults = true;
        break;
      case 'reconfigure':
        env.account = step.account;
        configure(env);
        expectDefaults = true;
        break;
      case 'signOut':
        env.token = null;
        clearAccessStoreConfiguration();
        env.configVersion += 1;
        expectDefaults = true;
        break;
      case 'rotateToken':
        env.token =
          step.to === 'valid'
            ? `tok-${env.nextId}`
            : step.to === 'null'
              ? null
              : step.to === 'blank'
                ? '   '
                : WEIRD_STRINGS[8]!;
        break;
      case 'settleOne':
        settleOne();
        break;
      case 'settleAll':
        while (env.pending.length > 0) {
          settleOne();
          await settle();
        }
        break;
      case 'tick':
        break;
    }
    await settle();
    checkState(env, `after ${step.op}`, expectDefaults);
  }

  // Quiescence: settle everything still pending, in random order.
  let guard = 0;
  while (env.pending.length > 0 && guard++ < 200) {
    settleOne();
    await settle();
  }
  await Promise.all(inflight);
  await settle();
  if (env.pending.length > 0)
    env.failures.push(
      `unsettled_calls: ${env.pending.map(p => p.label).join(',')}`,
    );
  checkState(env, 'quiescence', expectDefaults);
  const final = useAccessStore.getState();
  if (final.operation !== 'idle')
    env.failures.push(`operation_stuck: ${final.operation}`);
  if (final.status === 'loading') env.failures.push('status_stuck_loading');
  for (const r of rejections) env.failures.push(`store_rejected: ${r}`);

  // Every store purchase/restore success under an unchanged configuration must be followed by a sync POST.
  for (const success of env.storeSuccesses) {
    const followed = env.syncPosts.some(
      p => p.version === success.version && p.seq >= success.seq,
    );
    if (success.version === success.completedUnder && !followed)
      env.failures.push(`${success.kind}_without_sync`);
    if (success.version !== success.completedUnder && followed)
      env.failures.push(`${success.kind}_synced_after_reconfigure`);
  }

  unsubscribe();
  clearAccessStoreConfiguration();
  await settle();
  if (
    JSON.stringify(dataOf(useAccessStore.getState())) !==
    JSON.stringify(DEFAULTS)
  )
    env.failures.push('teardown_defaults_violated');

  const pollution = pollutionProbe();
  if (pollution) env.failures.push(`prototype_pollution: ${pollution}`);
  const wallMs = Date.now() - start;
  if (wallMs > 3000) env.failures.push(`slow: ${wallMs}ms`);

  return {
    seed,
    scenario: `bias=${cleanBias} ${steps.map(s => s.op).join('>')}`,
    outcome: env.failures.length === 0 ? 'held' : 'broken',
    failures: env.failures,
    wallMs,
    detail: {
      steps: steps.map(s => summarize(s)),
      log: env.log,
      finalState: summarize(dataOf(final)),
      servedAccessCount: env.servedAccess.size,
      storeSuccesses: env.storeSuccesses.length,
      syncPosts: env.syncPosts.length,
      notes: env.notes,
      replay: replayCommand(SUITE_FILE, seed),
    },
  };
}

describe('stress/boundary-malformed: access store interleavings', () => {
  const config = stressConfig(120);
  const seeds = seedsFor(config);

  afterAll(() => {
    clearAccessStoreConfiguration();
    clearApiSession();
  });

  it(`keeps the access store coherent across ${seeds.length} randomized operation/response interleavings`, async () => {
    const rows: StressRow[] = [];
    let totalSteps = 0;
    let totalSettled = 0;
    let premiumUnlocks = 0;
    for (const seed of seeds) {
      const row = await runScenario(seed);
      totalSteps += (row.detail['steps'] as unknown[]).length;
      totalSettled += (row.detail['log'] as string[]).filter(l =>
        l.startsWith('settle:'),
      ).length;
      const finalState = row.detail['finalState'] as {
        canonicalAccess: { premium?: boolean } | null;
      };
      if (finalState.canonicalAccess?.premium === true) premiumUnlocks += 1;
      rows.push(row);
    }
    const { summaryPath, tablePath } = writeTable(
      config,
      'billingStoreInterleavingFuzz',
      rows,
      {
        totalSteps,
        totalSettledCalls: totalSettled,
        scenariosEndingPremium: premiumUnlocks,
      },
    );
    const broken = rows.filter(r => r.outcome === 'broken');
    expect(pollutionProbe()).toBeNull();
    expect({
      executed: rows.length,
      broken: broken.slice(0, 10).map(r => ({
        seed: r.seed,
        failures: r.failures,
        replay: r.detail['replay'],
      })),
      summaryPath,
      tablePath,
    }).toEqual({ executed: seeds.length, broken: [], summaryPath, tablePath });
  }, 900_000);
});
