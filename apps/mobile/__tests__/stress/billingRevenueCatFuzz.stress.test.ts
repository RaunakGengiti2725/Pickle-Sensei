/**
 * STRESS / boundary-malformed — `src/billing/revenueCatClient.ts`
 *
 * Drives the RevenueCat adapter with a hostile fake SDK: malformed offerings
 * (wrong package types, NaN / -0 / Infinity prices, 64 KB identifiers, path
 * traversal, prototype keys, Unicode look-alikes, future fields, empty
 * containers), malformed customer info, rejecting / hanging SDK calls and
 * boundary configuration values. Per seed it asserts:
 *   - configuration outside the contract never reaches the SDK and yields the
 *     documented `billing.unconfigured` reason;
 *   - `loadPlans` either returns a fully validated `StorePlans` (finite,
 *     non-negative price; non-empty identifiers; matching package type;
 *     lifetime carries no monthly price / trial; trial label only from a
 *     zero-priced offer the store says is eligible) or a typed error;
 *   - purchase / restore reject only with typed errors, cancellation is
 *     mapped only from `userCancelled === true` / `code === '1'`, and an
 *     unknown plan id (path traversal, `__proto__`, stale) never reaches
 *     `purchasePackage`;
 *   - anything that escapes untyped is the SDK's own rejection or a
 *     TypeError raised on an out-of-contract SDK shape (counted separately);
 *   - `Object.prototype` is untouched afterwards.
 *
 * Replay one seed:  STRESS_ONLY=<seed> npx jest --ci __tests__/stress/billingRevenueCatFuzz.stress.test.ts
 * Scale:            STRESS_ITER=3000 npx jest --ci __tests__/stress/billingRevenueCatFuzz.stress.test.ts
 */
import {
  createRevenueCatBillingClient,
  type BillingPlatform,
  type RevenueCatCustomerInfoLike,
  type RevenueCatSdk,
} from '../../src/billing/revenueCatClient';
import type { StorePlan } from '../../src/billing/types';
import {
  describeError,
  isTypedBillingError,
  mutate,
  pollutionObject,
  pollutionProbe,
  replayCommand,
  Rng,
  seedsFor,
  stressConfig,
  summarize,
  WEIRD_NUMBERS,
  WEIRD_STRINGS,
  weirdValue,
  writeTable,
  type StressRow,
} from '../../test-support/stress/billingFuzz';

const SUITE_FILE = 'billingRevenueCatFuzz.stress.test.ts';
const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';
const ELIGIBLE = 2;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

function goodPackage(
  rng: Rng,
  period: 'annual' | 'monthly' | 'lifetime',
): JsonRecord {
  const packageType = period.toUpperCase();
  const productId = `pickle_sensei_pro_${period}`;
  const trial = rng.chance(0.5);
  return {
    identifier: `$rc_${period}`,
    packageType,
    product: {
      identifier: productId,
      price: period === 'annual' ? 59.99 : period === 'monthly' ? 7.99 : 159.99,
      priceString:
        period === 'annual'
          ? '$59.99'
          : period === 'monthly'
            ? '$7.99'
            : '$159.99',
      pricePerMonthString: period === 'lifetime' ? null : '$5.00',
      introPrice: trial
        ? {
            price: 0,
            cycles: 1,
            period: rng.pick(['P7D', 'P1W', 'P1M', 'P3D']),
          }
        : null,
      defaultOption: trial
        ? {
            freePhase: {
              billingPeriod: 'P1W',
              billingCycleCount: 1,
              price: { amountMicros: 0 },
            },
          }
        : null,
    },
  };
}

function goodOffering(rng: Rng): JsonRecord {
  return {
    identifier: rng.pick(['default', 'launch', 'pro']),
    annual: rng.chance(0.85) ? goodPackage(rng, 'annual') : null,
    monthly: rng.chance(0.85) ? goodPackage(rng, 'monthly') : null,
    lifetime: rng.chance(0.85) ? goodPackage(rng, 'lifetime') : null,
  };
}

function goodCustomerInfo(rng: Rng): JsonRecord {
  const active: JsonRecord = {};
  if (rng.chance(0.5)) {
    active[rng.pick(['pickle_sensei_pro', 'premium'])] = {
      productIdentifier: 'pickle_sensei_pro_annual',
      expirationDate: rng.chance(0.7) ? '2027-08-27T00:00:00Z' : null,
    };
  }
  if (rng.chance(0.2)) {
    active['some_other_entitlement'] = {
      productIdentifier: 'other',
      expirationDate: null,
    };
  }
  return { entitlements: { active } };
}

type Reaction =
  | { kind: 'value'; value: unknown; mutations: string[] }
  | { kind: 'reject'; reason: unknown }
  | { kind: 'throw_sync'; reason: unknown };

function reactionFor(rng: Rng, base: Json, weight = 0.6, clean = 0): Reaction {
  if (rng.chance(clean)) return { kind: 'value', value: base, mutations: [] };
  const roll = rng.next();
  if (roll < weight) {
    const { value, mutations } = mutate(
      rng,
      base,
      rng.pick([0, 0, 1, 1, 1, 2, 3, 5]),
    );
    return {
      kind: 'value',
      value,
      mutations: mutations.map(m => `${m.kind}@${m.path}`),
    };
  }
  if (roll < weight + 0.2)
    return {
      kind: 'value',
      value: weirdValue(rng),
      mutations: ['whole_weird'],
    };
  if (roll < weight + 0.3)
    return { kind: 'reject', reason: injectedRejection(rng) };
  if (roll < weight + 0.35)
    return { kind: 'throw_sync', reason: injectedRejection(rng) };
  return { kind: 'value', value: base, mutations: [] };
}

const INJECTED_TAG = Symbol('injected');

function injectedRejection(rng: Rng): unknown {
  const reason = rng.pick<unknown>([
    () => Object.assign(new Error('StoreKit failure'), { code: '2' }),
    () => ({ userCancelled: true, code: '1', message: 'cancelled' }),
    () => ({ userCancelled: 'true' }),
    () => ({ code: 1 }),
    () => ({ code: '1' }),
    () => ({ userCancelled: false, code: '01' }),
    () => 'PURCHASE_CANCELLED',
    () => null,
    () => undefined,
    () => 42,
    () => pollutionObject(rng),
    () =>
      Object.assign(new TypeError('bridge exploded'), { userCancelled: true }),
  ] as ReadonlyArray<() => unknown>);
  const value = (reason as () => unknown)();
  if (typeof value === 'object' && value !== null) {
    Object.defineProperty(value, INJECTED_TAG, {
      value: true,
      enumerable: false,
    });
  }
  return value;
}

function isInjected(value: unknown, reaction: Reaction | undefined): boolean {
  if (!reaction || reaction.kind === 'value') return false;
  if (typeof value === 'object' && value !== null) {
    return (value as Record<symbol, unknown>)[INJECTED_TAG] === true;
  }
  return Object.is(value, reaction.reason);
}

type ConfigValue = string | null | undefined;

function pickKey(rng: Rng): ConfigValue {
  if (rng.chance(0.7))
    return rng.pick(['appl_public', ' appl_public ', 'test_store']);
  return rng.pick<ConfigValue>([
    '',
    '  ',
    '\uFEFF',
    'sk_secret',
    'SK_SECRET',
    ' sk_secret ',
    '\uFEFFsk_secret',
    'sk\u200b_secret',
    '\u0455k_secret', // Cyrillic s
    'Sk_',
    'sk',
    WEIRD_STRINGS[8]!,
    null,
    undefined,
  ]);
}

function pickUserId(rng: Rng): ConfigValue {
  if (rng.chance(0.7))
    return rng.pick([
      CANONICAL_ID,
      ` ${CANONICAL_ID} `,
      CANONICAL_ID.toUpperCase(),
    ]);
  return rng.pick<ConfigValue>([
    '',
    '  ',
    '11111111-1111-4111-8111-11111111111',
    '11111111-1111-4111-8111-1111111111111',
    '11111111-1111-0111-8111-111111111111',
    '11111111-1111-4111-0111-111111111111',
    '00000000-0000-0000-0000-000000000000',
    `${CANONICAL_ID}\u200d`,
    `${CANONICAL_ID}\n`,
    `\uFEFF${CANONICAL_ID}`,
    '\uff11\uff11\uff11\uff11\uff11\uff11\uff11\uff11-1111-4111-8111-111111111111',
    'apple:001234.abcdef',
    'google-oauth2|123456789',
    '../../etc/passwd',
    '__proto__',
    WEIRD_STRINGS[8]!,
    null,
    undefined,
  ]);
}

interface Scenario {
  platform: BillingPlatform;
  publicSdkKey: ConfigValue;
  canonicalAppUserId: ConfigValue;
  sdk: {
    isConfigured: Reaction;
    configure: Reaction;
    appUserId: Reaction;
    logIn: Reaction;
    offerings: Reaction;
    /** Second `loadPlans` (a store re-initialise) — may fail after a good first load. */
    offeringsReload: Reaction | null;
    eligibility: Reaction;
    purchase: Reaction;
    restore: Reaction;
    customerInfo: Reaction;
  };
  purchasePlanIds: Array<'first_plan' | string>;
}

function generate(seed: number): Scenario {
  const rng = new Rng(seed);
  const platform = rng.pick<BillingPlatform>([
    'ios',
    'ios',
    'ios',
    'android',
    'other',
  ]);
  const publicSdkKey = pickKey(rng);
  const canonicalAppUserId = pickUserId(rng);
  const appUserId: Json = rng.chance(0.75)
    ? typeof canonicalAppUserId === 'string'
      ? canonicalAppUserId.trim()
      : CANONICAL_ID
    : rng.pick<Json>(['someone-else', CANONICAL_ID.toUpperCase(), '', null]);
  const eligibilityBase: JsonRecord = {
    pickle_sensei_pro_annual: {
      status: rng.pick([ELIGIBLE, ELIGIBLE, 0, 1, 3]),
    },
    pickle_sensei_pro_monthly: {
      status: rng.pick([ELIGIBLE, ELIGIBLE, 0, 1, 3]),
    },
  };
  const purchaseCount = rng.int(1, 3);
  const purchasePlanIds: string[] = [];
  for (let i = 0; i < purchaseCount; i++) {
    purchasePlanIds.push(
      rng.chance(0.6)
        ? 'first_plan'
        : rng.pick([
            '',
            '__proto__',
            'constructor',
            '../../etc/passwd',
            'default:annual:$rc_annual:pickle_sensei_pro_annual',
            'default:annual:$rc_annual:pickle_sensei_pro_annual\u200b',
            WEIRD_STRINGS[8]!,
            'default:lifetime:x:y',
          ]),
    );
  }
  return {
    platform,
    publicSdkKey,
    canonicalAppUserId,
    sdk: {
      isConfigured: reactionFor(rng, rng.chance(0.6) ? false : true, 0.85, 0.7),
      configure: reactionFor(rng, null, 0.9, 0.8),
      appUserId: reactionFor(rng, appUserId, 0.9, 0.8),
      logIn: reactionFor(rng, {}, 0.9, 0.8),
      offerings: reactionFor(
        rng,
        { current: rng.chance(0.9) ? goodOffering(rng) : null },
        0.65,
      ),
      offeringsReload: rng.chance(0.5)
        ? reactionFor(
            rng,
            { current: rng.chance(0.8) ? goodOffering(rng) : null },
            0.5,
          )
        : null,
      eligibility: reactionFor(rng, eligibilityBase, 0.7),
      purchase: reactionFor(rng, { customerInfo: goodCustomerInfo(rng) }, 0.55),
      restore: reactionFor(rng, goodCustomerInfo(rng), 0.55),
      customerInfo: reactionFor(rng, goodCustomerInfo(rng), 0.6),
    },
    purchasePlanIds,
  };
}

function trimmed(value: ConfigValue): string {
  return typeof value === 'string' ? value.trim() : '';
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function expectedUnconfiguredReason(scenario: Scenario): string | null {
  const key = trimmed(scenario.publicSdkKey);
  if (!key) return 'missing_public_sdk_key';
  if (/^sk_/i.test(key)) return 'secret_key_supplied_to_client';
  const id = trimmed(scenario.canonicalAppUserId);
  if (!id) return 'missing_canonical_app_user_id';
  if (!UUID_PATTERN.test(id)) return 'invalid_canonical_app_user_id';
  return null;
}

function planIdsOf(plans: unknown): string[] {
  if (typeof plans !== 'object' || plans === null) return [];
  const p = plans as {
    annual: StorePlan | null;
    monthly: StorePlan | null;
    lifetime: StorePlan | null;
  };
  return [p.annual, p.monthly, p.lifetime]
    .filter(
      (x): x is StorePlan =>
        typeof x === 'object' && x !== null && typeof x.id === 'string',
    )
    .map(x => x.id);
}

function run(reaction: Reaction): Promise<unknown> {
  switch (reaction.kind) {
    case 'value':
      return Promise.resolve(reaction.value);
    case 'reject':
      return Promise.reject(reaction.reason);
    case 'throw_sync':
      throw reaction.reason;
  }
}

/** `passthrough:` results are out-of-contract SDK field types (non-string
 * identifier / priceString) that the adapter forwards unchanged; they are
 * tallied as notes, everything else is a failure. */
function isValidPlan(
  plan: unknown,
  period: 'annual' | 'monthly' | 'lifetime',
  offeringId: unknown,
): string | null {
  if (typeof plan !== 'object' || plan === null) return 'plan_not_object';
  const p = plan as StorePlan;
  if (Object.getPrototypeOf(plan) !== Object.prototype) return 'plan_prototype';
  const keys = Object.keys(plan).sort().join(',');
  if (
    keys !==
    'freeTrial,id,period,price,pricePerMonthString,priceString,productId'
  )
    return `plan_keys:${keys}`;
  if (p.period !== period) return 'plan_period';
  if (typeof p.productId !== 'string')
    return `passthrough:productId:${typeof p.productId}`;
  if (p.productId.length === 0) return 'plan_productId_empty';
  if (typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price < 0)
    return `plan_price:${String(p.price)}`;
  if (typeof p.priceString !== 'string')
    return `passthrough:priceString:${typeof p.priceString}`;
  if (p.priceString.length === 0) return 'plan_priceString_empty';
  if (!(
    p.pricePerMonthString === null || typeof p.pricePerMonthString === 'string'
  ))
    return `passthrough:pricePerMonthString:${typeof p.pricePerMonthString}`;
  if (p.pricePerMonthString === '') return 'plan_ppm_empty';
  if (
    typeof p.id !== 'string' ||
    !p.id.startsWith(`${String(offeringId)}:${period}:`)
  )
    return 'plan_id';
  if (
    period === 'lifetime' &&
    (p.pricePerMonthString !== null || p.freeTrial !== null)
  )
    return 'lifetime_has_monthly_or_trial';
  if (p.freeTrial !== null) {
    if (typeof p.freeTrial !== 'object') return 'trial_shape';
    if (!/^\d+-(day|week|month|year) free trial$/.test(p.freeTrial.label))
      return `trial_label:${p.freeTrial.label}`;
    if (!/^P[1-9]\d*[DWMY]$/.test(p.freeTrial.periodIso8601))
      return `trial_period:${p.freeTrial.periodIso8601}`;
  }
  return null;
}

async function runScenario(
  seed: number,
  scenario: Scenario,
): Promise<StressRow> {
  const start = Date.now();
  const failures: string[] = [];
  const notes: string[] = [];
  const calls: string[] = [];
  const purchasedPackages: unknown[] = [];
  const eligibilityQueried: unknown[] = [];
  let offeringsCalls = 0;

  const sdk: RevenueCatSdk = {
    isConfigured: () => {
      calls.push('isConfigured');
      return run(scenario.sdk.isConfigured) as Promise<boolean>;
    },
    configure: () => {
      calls.push('configure');
      return run(scenario.sdk.configure) as Promise<void>;
    },
    getAppUserID: () => {
      calls.push('getAppUserID');
      return run(scenario.sdk.appUserId) as Promise<string>;
    },
    logIn: () => {
      calls.push('logIn');
      return run(scenario.sdk.logIn);
    },
    getOfferings: () => {
      calls.push('getOfferings');
      offeringsCalls += 1;
      const reaction =
        offeringsCalls > 1 && scenario.sdk.offeringsReload
          ? scenario.sdk.offeringsReload
          : scenario.sdk.offerings;
      return run(reaction) as ReturnType<RevenueCatSdk['getOfferings']>;
    },
    purchasePackage: aPackage => {
      calls.push('purchasePackage');
      purchasedPackages.push(aPackage);
      return run(scenario.sdk.purchase) as ReturnType<
        RevenueCatSdk['purchasePackage']
      >;
    },
    restorePurchases: () => {
      calls.push('restorePurchases');
      return run(scenario.sdk.restore) as Promise<RevenueCatCustomerInfoLike>;
    },
    getCustomerInfo: () => {
      calls.push('getCustomerInfo');
      return run(
        scenario.sdk.customerInfo,
      ) as Promise<RevenueCatCustomerInfoLike>;
    },
    checkTrialOrIntroductoryPriceEligibility: ids => {
      calls.push('checkTrialOrIntroductoryPriceEligibility');
      eligibilityQueried.push(...ids);
      return run(scenario.sdk.eligibility) as Promise<
        Record<string, { status: number }>
      >;
    },
  };

  const client = createRevenueCatBillingClient(
    {
      publicSdkKey: scenario.publicSdkKey,
      canonicalAppUserId: scenario.canonicalAppUserId,
    },
    sdk,
    scenario.platform,
  );
  const expectedReason = expectedUnconfiguredReason(scenario);

  const classify = (
    label: string,
    error: unknown,
    injected: Reaction | undefined,
    outOfContractAllowed: boolean,
  ) => {
    if (isTypedBillingError(error)) return 'typed';
    if (isInjected(error, injected)) return 'injected';
    if (outOfContractAllowed && error instanceof TypeError) {
      notes.push(
        `${label}: out-of-contract SDK shape → TypeError contained by caller (${error.message.slice(0, 80)})`,
      );
      return 'type_error';
    }
    failures.push(`${label}_untyped_throw: ${describeError(error)}`);
    return 'untyped';
  };

  // ── configure ─────────────────────────────────────────────────────────────
  let configureError: unknown = null;
  let configured = false;
  try {
    await client.configure();
    configured = true;
  } catch (error) {
    configureError = error;
  }
  if (expectedReason) {
    if (configured) failures.push(`configured_despite_${expectedReason}`);
    else if (
      !isTypedBillingError(configureError) ||
      configureError.code !== 'billing.unconfigured' ||
      configureError.unconfiguredReason !== expectedReason
    ) {
      failures.push(
        `wrong_unconfigured: ${describeError(configureError)} expected ${expectedReason}`,
      );
    }
    if (calls.length !== 0)
      failures.push(`sdk_called_when_unconfigured: ${calls.join(',')}`);
  } else if (!configured) {
    const injected = [
      scenario.sdk.isConfigured,
      scenario.sdk.configure,
      scenario.sdk.appUserId,
      scenario.sdk.logIn,
    ].find(r => isInjected(configureError, r));
    classify('configure', configureError, injected, false);
    if (
      isTypedBillingError(configureError) &&
      configureError.code !== 'billing.unconfigured'
    ) {
      failures.push(`configure_wrong_code: ${configureError.code}`);
    }
  } else {
    // Bound to the canonical id: the SDK's reported user must equal the trimmed id.
    const reported =
      scenario.sdk.appUserId.kind === 'value'
        ? scenario.sdk.appUserId.value
        : undefined;
    if (reported !== trimmed(scenario.canonicalAppUserId))
      failures.push(
        `configured_with_mismatched_user: ${String(summarize(reported))}`,
      );
  }

  // The second configure must be idempotent (memoised promise) and never re-drive the SDK differently.
  const callsBefore = calls.length;
  try {
    await client.configure();
    if (!configured) failures.push('configure_recovered_without_new_input');
  } catch (error) {
    if (configured)
      failures.push(`configure_flipped_to_failure: ${describeError(error)}`);
    else if (
      String(describeError(error)) !== String(describeError(configureError))
    )
      failures.push('configure_retry_changed_error_class');
  }
  if (configured && calls.length !== callsBefore)
    failures.push('configure_memo_broken');

  // ── loadPlans (once, or twice when a reload is scheduled) ────────────────
  const NO_ERROR = Symbol('no error');
  let plans: unknown = null;
  let plansError: unknown = NO_ERROR;
  let previousPlanIds: string[] = [];
  const loads = scenario.sdk.offeringsReload ? 2 : 1;
  for (let attempt = 0; attempt < loads; attempt++) {
    if (attempt === 1 && plansError === NO_ERROR)
      previousPlanIds = planIdsOf(plans);
    plans = null;
    plansError = NO_ERROR;
    try {
      plans = await client.loadPlans();
    } catch (error) {
      plansError = error;
    }
  }
  const offeringsReaction =
    loads === 2 && scenario.sdk.offeringsReload
      ? scenario.sdk.offeringsReload
      : scenario.sdk.offerings;
  if (!configured) {
    if (plans !== null) failures.push('plans_loaded_while_unconfigured');
  } else if (plansError !== NO_ERROR) {
    classify('loadPlans', plansError, offeringsReaction, true);
    if (
      isTypedBillingError(plansError) &&
      plansError.code !== 'billing.offerings_unavailable'
    )
      failures.push(`loadPlans_wrong_code: ${plansError.code}`);
  } else if (typeof plans !== 'object' || plans === null) {
    failures.push(`plans_not_object: ${String(plans)}`);
  } else {
    const p = plans as {
      offeringId: unknown;
      annual: unknown;
      monthly: unknown;
      lifetime: unknown;
    };
    if (
      Object.keys(p).sort().join(',') !== 'annual,lifetime,monthly,offeringId'
    )
      failures.push('plans_keys');
    const reasons = [
      p.annual === null ? null : isValidPlan(p.annual, 'annual', p.offeringId),
      p.monthly === null
        ? null
        : isValidPlan(p.monthly, 'monthly', p.offeringId),
      p.lifetime === null
        ? null
        : isValidPlan(p.lifetime, 'lifetime', p.offeringId),
    ].filter((r): r is string => r !== null);
    for (const r of reasons) {
      if (r.startsWith('passthrough:'))
        notes.push(`loadPlans: ${r} forwarded without a type check`);
      else failures.push(`invalid_plan: ${r}`);
    }
    if (p.annual === null && p.monthly === null && p.lifetime === null)
      failures.push('plans_all_null_accepted');
    // Trial claims need the store's eligibility answer (iOS) or a zero-priced free phase (Android).
    for (const plan of [p.annual, p.monthly] as Array<StorePlan | null>) {
      if (plan && plan.freeTrial) {
        if (scenario.platform === 'other')
          failures.push('trial_on_other_platform');
        if (scenario.platform === 'ios') {
          const e = scenario.sdk.eligibility;
          const status =
            e.kind === 'value' &&
            typeof e.value === 'object' &&
            e.value !== null
              ? (e.value as Record<string, { status?: unknown } | undefined>)[
                  plan.productId
                ]?.status
              : undefined;
          if (status !== ELIGIBLE)
            failures.push(
              `trial_without_eligibility: status=${String(status)}`,
            );
          if (!eligibilityQueried.includes(plan.productId))
            failures.push('trial_without_query');
        }
      }
    }
  }

  // ── purchase ──────────────────────────────────────────────────────────────
  const knownIds = new Set<string>(
    plansError === NO_ERROR ? planIdsOf(plans) : [],
  );
  const staleCandidates = new Set<string>(
    previousPlanIds.filter(id => !knownIds.has(id)),
  );
  for (const requested of scenario.purchasePlanIds) {
    const planId =
      requested === 'first_plan'
        ? ([...knownIds][0] ??
          [...staleCandidates][0] ??
          'default:annual:none:none')
        : requested;
    const before = purchasedPackages.length;
    let result: unknown = null;
    let error: unknown = NO_ERROR;
    try {
      result = await client.purchase(planId);
    } catch (caught) {
      error = caught;
    }
    if (!knownIds.has(planId)) {
      if (purchasedPackages.length !== before) {
        // The adapter keeps package entries from a previous / partially failed
        // load; accessStore never reaches here because it drops `plans` on
        // failure, so this is tallied rather than failed.
        notes.push(
          `purchase: stale package id reached purchasePackage after failed reload (${planId.slice(0, 60)})`,
        );
        if (error !== NO_ERROR && !isTypedBillingError(error))
          failures.push(`purchase_untyped_throw: ${describeError(error)}`);
        continue;
      }
      if (error === NO_ERROR)
        failures.push('purchase_succeeded_for_unknown_plan');
      else if (
        !isTypedBillingError(error) ||
        !(
          error.code === 'billing.offerings_unavailable' ||
          error.code === 'billing.unconfigured'
        )
      ) {
        failures.push(
          `purchase_unknown_plan_wrong_error: ${describeError(error)}`,
        );
      }
      continue;
    }
    if (purchasedPackages.length !== before + 1)
      failures.push('purchase_sdk_not_called_once');
    if (error !== NO_ERROR) {
      if (!isTypedBillingError(error))
        failures.push(`purchase_untyped_throw: ${describeError(error)}`);
      else {
        if (!(
          error.code === 'billing.purchase_cancelled' ||
          error.code === 'billing.purchase_failed'
        ))
          failures.push(`purchase_wrong_code: ${error.code}`);
        const r = scenario.sdk.purchase;
        const reason = r.kind === 'value' ? undefined : r.reason;
        const cancelled =
          typeof reason === 'object' &&
          reason !== null &&
          ((reason as { userCancelled?: unknown }).userCancelled === true ||
            (reason as { code?: unknown }).code === '1');
        if (
          r.kind !== 'value' &&
          cancelled !== (error.code === 'billing.purchase_cancelled')
        )
          failures.push(
            `purchase_cancel_mapping: cancelled=${cancelled} code=${error.code}`,
          );
        if (r.kind === 'value' && error.code === 'billing.purchase_cancelled')
          failures.push('purchase_cancelled_without_cancel');
      }
    } else {
      const s = result as {
        premium?: unknown;
        productId?: unknown;
        expirationDate?: unknown;
      };
      if (typeof s.premium !== 'boolean')
        failures.push('entitlement_premium_not_boolean');
      if (
        Object.keys(s).sort().join(',') !== 'expirationDate,premium,productId'
      )
        failures.push('entitlement_keys');
      if (!(s.productId === null || typeof s.productId === 'string'))
        notes.push(
          `purchase: productId passed through as ${typeof s.productId}`,
        );
      if (!(s.expirationDate === null || typeof s.expirationDate === 'string'))
        notes.push(
          `purchase: expirationDate passed through as ${typeof s.expirationDate}`,
        );
    }
  }

  // ── restore / readEntitlement ────────────────────────────────────────────
  for (const op of ['restore', 'readEntitlement'] as const) {
    let error: unknown = NO_ERROR;
    let result: unknown = null;
    try {
      result =
        op === 'restore'
          ? await client.restore()
          : await client.readEntitlement();
    } catch (caught) {
      error = caught;
    }
    if (!configured) {
      if (error === NO_ERROR) failures.push(`${op}_without_configuration`);
      continue;
    }
    if (error !== NO_ERROR) {
      if (op === 'restore') {
        if (
          !isTypedBillingError(error) ||
          error.code !== 'billing.restore_failed'
        )
          failures.push(`restore_wrong_error: ${describeError(error)}`);
      } else {
        classify('readEntitlement', error, scenario.sdk.customerInfo, true);
      }
    } else {
      const s = result as { premium?: unknown };
      if (typeof s.premium !== 'boolean')
        failures.push(`${op}_premium_not_boolean`);
    }
  }

  const pollution = pollutionProbe();
  if (pollution) failures.push(`prototype_pollution: ${pollution}`);
  const wallMs = Date.now() - start;
  if (wallMs > 2000) failures.push(`slow: ${wallMs}ms`);

  return {
    seed,
    scenario: `${scenario.platform}/${expectedReason ?? 'configured'}/offerings:${scenario.sdk.offerings.kind}/purchase:${scenario.sdk.purchase.kind}`,
    outcome: failures.length === 0 ? 'held' : 'broken',
    failures,
    wallMs,
    detail: {
      config: {
        publicSdkKey: summarize(scenario.publicSdkKey),
        canonicalAppUserId: summarize(scenario.canonicalAppUserId),
      },
      sdk: summarize(scenario.sdk),
      purchasePlanIds: summarize(scenario.purchasePlanIds),
      calls,
      notes,
      plans: summarize(plans),
      plansError: plansError === NO_ERROR ? null : describeError(plansError),
      configureError:
        configureError === null ? null : describeError(configureError),
      replay: replayCommand(SUITE_FILE, seed),
    },
  };
}

describe('stress/boundary-malformed: RevenueCat adapter', () => {
  const config = stressConfig(120);
  const seeds = seedsFor(config);

  it(`holds the store-client contract across ${seeds.length} generated SDK shapes`, async () => {
    const rows: StressRow[] = [];
    const noteSeeds: Record<string, number[]> = {};
    for (const seed of seeds) {
      const row = await runScenario(seed, generate(seed));
      for (const note of row.detail['notes'] as string[]) {
        const key = note.replace(/\(.*$/, '').trim();
        (noteSeeds[key] ??= []).push(seed);
      }
      rows.push(row);
    }
    const { summaryPath, tablePath } = writeTable(
      config,
      'billingRevenueCatFuzz',
      rows,
      {
        contractNotes: Object.fromEntries(
          Object.entries(noteSeeds).map(([k, v]) => [
            k,
            { count: v.length, seeds: v.slice(0, 12) },
          ]),
        ),
        weirdNumberPool: WEIRD_NUMBERS.length,
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
  }, 600_000);
});
