/**
 * XC journey `paywall-purchase-restore` — MATRIX / FUZZ half of the harness.
 * No rendering here: this drives the real `accessStore` + real RevenueCat
 * client + real canonical-access HTTP client at scale, over the same mocked
 * `react-native-purchases` module the journey suite uses.
 *
 *  M1 seeded state-machine fuzz: $XC_FUZZ_SEQUENCES (default 400) random
 *     operation sequences (purchase / restore / refresh / store-account and
 *     backend mutations / bearer rotation / account switch) with a strict
 *     oracle checked after EVERY step. Every violation records seed + step so
 *     it is replayable bit-for-bit.
 *  M2 RevenueCat error-code matrix: every PURCHASES_ERROR_CODE × userCancelled
 *     ∈ {true,false,null} through purchase AND restore.
 *  M3 store-price fuzz: $XC_PRICE_FUZZ (default 3000) random storefront
 *     offerings through `loadPlans` — plans echo store strings verbatim —
 *     plus a malformed-package matrix.
 *  M4 static pins on `src/` — the two StoreKit-auth call sites and the
 *     absence of hard-coded prices / automatic sync.
 *  M5 targeted interleavings the journey suite cannot reach through the UI.
 *  M6 heap under 600 purchase→sync cycles.
 *
 * Raw evidence: artifacts/xc-journey-paywall-purchase-restore/matrix-*.json.
 */
jest.mock('react-native-purchases', () => {
  const support = jest.requireActual<
    typeof import('../../test-support/xc/paywallPurchaseRestore.support')
  >('../../test-support/xc/paywallPurchaseRestore.support');
  return support.installMockPurchases();
});

import {
  createBillingAccessDependencies,
  type RevenueCatSdk,
} from '../../src/billing';
import { createRevenueCatBillingClient } from '../../src/billing/revenueCatClient';
import type { BillingPeriod } from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  API_BASE_URL,
  CANONICAL_USER_A,
  CANONICAL_USER_B,
  FakeAccessBackend,
  type Fault,
  installMockPurchases,
  LEGACY_PREMIUM_ENTITLEMENT,
  listSourceFiles,
  makePackage,
  type MockPurchasesState,
  PREMIUM_ENTITLEMENT,
  Prng,
  PUBLIC_SDK_KEY,
  type PurchaseOutcome,
  RC_ERROR_CODES,
  randomOffering,
  type RcErrorName,
  type RcOffering,
  readSource,
  resetPurchasesMock,
  type RestoreOutcome,
  sourceRoot,
  STOREFRONTS,
  heapSnapshot,
  targetOffering,
  writeArtifact,
} from '../../test-support/xc/paywallPurchaseRestore.support';

declare const process: { env: Record<string, string | undefined> };

const mockedSdk = installMockPurchases().default as unknown as RevenueCatSdk;

const FUZZ_SEQUENCES = Number(process.env.XC_FUZZ_SEQUENCES ?? '400');
const PRICE_FUZZ = Number(process.env.XC_PRICE_FUZZ ?? '3000');
const BASE_SEED = Number(process.env.XC_SEED ?? '20260904');

interface World {
  backend: FakeAccessBackend;
  sdk: MockPurchasesState;
  user: string;
  token: { current: string };
}

function configureFor(world: World, user: string): void {
  world.user = user;
  world.token.current = `bearer-${user.slice(0, 8)}-${world.backend.calls.length}`;
  world.backend.bearers.set(world.token.current, user);
  if (!world.backend.ledgers.has(user)) {
    world.backend.ledgers.set(user, { used: 0, reserved: 0 });
  }
  const token = world.token;
  configureAccessStore(
    createBillingAccessDependencies({
      revenueCatPublicSdkKey: PUBLIC_SDK_KEY,
      canonicalAppUserId: user,
      apiBaseUrl: API_BASE_URL,
      get apiToken() {
        return token.current;
      },
      fetchFn: world.backend.fetch,
      revenueCatSdk: mockedSdk,
      platform: 'ios',
    }),
  );
}

function makeWorld(offering: RcOffering | null = targetOffering()): World {
  const backend = new FakeAccessBackend(API_BASE_URL);
  const sdk = resetPurchasesMock();
  backend.attachSdk(sdk);
  sdk.offering = offering;
  const world: World = { backend, sdk, user: '', token: { current: '' } };
  configureFor(world, CANONICAL_USER_A);
  return world;
}

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  }
}

afterEach(() => {
  clearAccessStoreConfiguration();
});

// ─── M1: seeded state-machine fuzz ───────────────────────────────────────────

type Step =
  | { op: 'initialize' }
  | { op: 'refresh'; fault: Fault | null }
  | { op: 'purchase'; outcome: PurchaseOutcome; syncFault: Fault | null }
  | { op: 'restore'; outcome: RestoreOutcome; syncFault: Fault | null }
  | { op: 'select'; period: BillingPeriod }
  | {
      op: 'store_grant';
      entitlement: string;
      lifetime: boolean;
      alsoRc: boolean;
    }
  | { op: 'store_revoke' }
  | { op: 'rc_expire' }
  | { op: 'ledger'; used: number; reserved: number }
  | { op: 'rc_rest'; down: boolean }
  | { op: 'rotate_token' }
  | { op: 'switch_account'; user: string }
  | { op: 'sign_out' }
  | { op: 'double_tap'; second: 'purchase' | 'restore' | 'sync' };

const PURCHASE_ERRORS: RcErrorName[] = [
  'STORE_PROBLEM_ERROR',
  'PURCHASE_NOT_ALLOWED_ERROR',
  'PURCHASE_INVALID_ERROR',
  'PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR',
  'NETWORK_ERROR',
  'PAYMENT_PENDING_ERROR',
  'OFFLINE_CONNECTION_ERROR',
  'PRODUCT_ALREADY_PURCHASED_ERROR',
  'RECEIPT_ALREADY_IN_USE_ERROR',
  'INVALID_RECEIPT_ERROR',
  'UNKNOWN_ERROR',
];

function randomFault(prng: Prng): Fault | null {
  if (prng.chance(0.65)) return null;
  const roll = prng.int(6);
  if (roll === 0) return { kind: 'network' };
  if (roll === 1)
    return {
      kind: 'status',
      status: prng.pick([401, 403, 429, 500, 502, 503]),
    };
  if (roll === 2) return { kind: 'malformed' };
  if (roll === 3) return { kind: 'delay', ms: 1 };
  if (roll === 4) return { kind: 'inconsistent_premium' };
  return { kind: 'bad_arithmetic' };
}

function randomPurchaseOutcome(prng: Prng): PurchaseOutcome {
  const roll = prng.next();
  if (roll < 0.4) return { kind: 'success', rcBackendLag: prng.chance(0.2) };
  if (roll < 0.5)
    return { kind: 'success', entitlementId: LEGACY_PREMIUM_ENTITLEMENT };
  if (roll < 0.58) return { kind: 'success_no_entitlement' };
  if (roll < 0.75) {
    return {
      kind: 'cancel',
      shape: prng.pick(['both', 'userCancelled_only', 'code_only'] as const),
    };
  }
  if (roll < 0.93) {
    return {
      kind: 'error',
      error: prng.pick(PURCHASE_ERRORS),
      userCancelled: prng.pick([false, null] as const),
    };
  }
  if (roll < 0.97) return { kind: 'reject_string', value: 'boom' };
  return { kind: 'reject_null' };
}

function randomRestoreOutcome(prng: Prng): RestoreOutcome {
  const roll = prng.next();
  if (roll < 0.6) return { kind: 'success' };
  if (roll < 0.7) return { kind: 'cancel' };
  if (roll < 0.95) return { kind: 'error', error: prng.pick(PURCHASE_ERRORS) };
  return { kind: 'reject_string', value: 'boom' };
}

function randomStep(prng: Prng, world: World): Step {
  const roll = prng.next();
  if (roll < 0.05) return { op: 'initialize' };
  if (roll < 0.17) return { op: 'refresh', fault: randomFault(prng) };
  if (roll < 0.42) {
    return {
      op: 'purchase',
      outcome: randomPurchaseOutcome(prng),
      syncFault: randomFault(prng),
    };
  }
  if (roll < 0.57) {
    return {
      op: 'restore',
      outcome: randomRestoreOutcome(prng),
      syncFault: randomFault(prng),
    };
  }
  if (roll < 0.62)
    return {
      op: 'select',
      period: prng.pick(['annual', 'monthly', 'lifetime'] as const),
    };
  if (roll < 0.68) {
    return {
      op: 'store_grant',
      entitlement: prng.chance(0.8)
        ? PREMIUM_ENTITLEMENT
        : LEGACY_PREMIUM_ENTITLEMENT,
      lifetime: prng.chance(0.3),
      alsoRc: prng.chance(0.7),
    };
  }
  if (roll < 0.72) return { op: 'store_revoke' };
  if (roll < 0.75) return { op: 'rc_expire' };
  if (roll < 0.8) {
    // The server never reports more reserved permits than ratings left
    // (parseAccess rejects that shape; covered by the bad_arithmetic fault).
    const used = prng.int(3);
    return { op: 'ledger', used, reserved: prng.int(2 - used + 1) };
  }
  if (roll < 0.84) return { op: 'rc_rest', down: prng.chance(0.5) };
  if (roll < 0.88) return { op: 'rotate_token' };
  if (roll < 0.92) {
    return {
      op: 'switch_account',
      user:
        world.user === CANONICAL_USER_A ? CANONICAL_USER_B : CANONICAL_USER_A,
    };
  }
  if (roll < 0.95) return { op: 'sign_out' };
  return {
    op: 'double_tap',
    second: prng.pick(['purchase', 'restore', 'sync'] as const),
  };
}

interface StepRecord {
  i: number;
  step: Step;
  result: unknown;
  status: string;
  operation: string;
  premium: boolean | null;
  errorCode: string | null;
  lastBackend: string | null;
  storeKitAuth: number;
}

interface Violation {
  seed: number;
  step: number;
  invariant: string;
  detail: string;
  trace: StepRecord[];
}

interface Oracle {
  signedOut: boolean;
  /** StoreKit-auth entries expected so far. */
  expectedAuth: Array<{
    api: 'purchasePackage' | 'restorePurchases';
    user: string;
  }>;
  /** Every bearer ever issued → owner (rotation deletes from the backend map). */
  bearerOwner: Map<string, string>;
}

interface StepContext {
  /** The store would actually reach the SDK for this purchase/restore. */
  attempted: boolean;
  premiumBefore: boolean;
  backendCallsBefore: number;
}

function checkInvariants(
  world: World,
  oracle: Oracle,
  step: Step,
  result: unknown,
  ctx: StepContext,
  fail: (invariant: string, detail: string) => void,
): void {
  const state = useAccessStore.getState();
  const access = state.canonicalAccess;
  const lastBackend = world.backend.calls[world.backend.calls.length - 1];
  const newCalls = world.backend.calls.slice(ctx.backendCallsBefore);

  // I1 every operation settles.
  if (state.operation !== 'idle')
    fail('I1 operation settles', `operation=${state.operation}`);

  // I2 StoreKit ledger is exactly the expected purchase/restore calls, each
  //    bound to the canonical UUID of the account that was configured.
  const ledger = world.sdk.storeKitAuth.map(entry => ({
    api: entry.api,
    user: entry.appUserID,
  }));
  if (JSON.stringify(ledger) !== JSON.stringify(oracle.expectedAuth)) {
    fail(
      'I2 StoreKit ledger == explicit Continue/Restore calls',
      JSON.stringify({ ledger, expected: oracle.expectedAuth }),
    );
  }
  for (const entry of world.sdk.calls) {
    if (
      entry.api === 'syncPurchases' ||
      entry.api === 'syncPurchasesForResult' ||
      entry.api === 'presentCodeRedemptionSheet'
    ) {
      fail('I2b never automatic sync / code redemption', entry.api);
    }
  }

  // I3 fail closed: premium only with a persisted server verdict AND a last
  //    200 premium=true from the server for THIS account.
  if (access?.premium) {
    const verdict = world.backend.persistedVerdicts.get(world.user);
    if (!verdict?.premium)
      fail(
        'I3 premium ⇒ server verdict premium',
        JSON.stringify({ user: world.user, verdict }),
      );
    const last200 = [...world.backend.calls]
      .reverse()
      .find(call => call.outcome.startsWith('200'));
    if (
      !last200 ||
      last200.outcome !== '200 premium=true' ||
      oracle.bearerOwner.get(last200.bearer ?? '') !== world.user
    ) {
      fail(
        'I3b premium ⇒ latest 200 for this account said premium',
        JSON.stringify(last200),
      );
    }
    if (
      world.backend.rcRestDown &&
      lastBackend?.outcome === '502 billing_unavailable'
    ) {
      // allowed: premium came from an earlier verified sync; a later 502
      // must have nulled it (checked by I4)
      fail('I3c premium survives a failed sync', lastBackend.outcome);
    }
  }

  // I4 any backend failure on the most recent call leaves access null.
  if (
    lastBackend &&
    (lastBackend.outcome === '401' ||
      lastBackend.outcome === '502 billing_unavailable' ||
      lastBackend.outcome === 'fault:network' ||
      lastBackend.outcome === 'fault:status' ||
      lastBackend.outcome === 'fault:malformed' ||
      lastBackend.outcome === 'fault:inconsistent_premium' ||
      lastBackend.outcome === 'fault:bad_arithmetic') &&
    !oracle.signedOut &&
    access !== null
  ) {
    fail(
      'I4 backend failure ⇒ access null',
      `${lastBackend.route} ${lastBackend.outcome}`,
    );
  }
  if (
    lastBackend?.outcome === 'fault:inconsistent_premium' &&
    access?.premium
  ) {
    fail('I4b billing.premium never trusted over access.premium', '');
  }

  // I5 arithmetic of the server snapshot.
  if (access) {
    const fr = access.freeRatings;
    if (
      fr.remaining !== fr.limit - fr.used ||
      fr.availableToReserve !== fr.remaining - fr.reserved
    ) {
      fail('I5 free-rating arithmetic', JSON.stringify(fr));
    }
    if (
      access.canStartRating !== (access.premium || fr.availableToReserve > 0)
    ) {
      fail('I5b canStartRating derivation', JSON.stringify(access));
    }
    if (access.paywallRequired !== !access.canStartRating)
      fail('I5c paywallRequired', '');
  }

  // I6 per-operation contract.
  const storeFailed =
    step.op === 'purchase' || step.op === 'restore'
      ? step.outcome.kind !== 'success' &&
        step.outcome.kind !== 'success_no_entitlement'
      : false;
  if (step.op === 'purchase' && typeof result === 'boolean') {
    if (result) {
      if (
        !access?.premium ||
        lastBackend?.route !== 'sync' ||
        lastBackend.outcome !== '200 premium=true'
      ) {
        fail(
          'I6 purchase true ⇒ verified premium sync',
          JSON.stringify({ access, lastBackend }),
        );
      }
      if (state.error)
        fail('I6b purchase true ⇒ no error', JSON.stringify(state.error));
      if (!ctx.attempted) fail('I6h purchase true without an attempt', '');
    } else if (!ctx.attempted) {
      if (world.sdk.storeKitAuth.length !== oracle.expectedAuth.length)
        fail('I6i unattempted purchase reached StoreKit', '');
      if (newCalls.length !== 0 && !oracle.signedOut)
        fail(
          'I6j unattempted purchase hit the backend',
          JSON.stringify(newCalls),
        );
    } else if (step.outcome.kind === 'cancel' && !oracle.signedOut) {
      if (state.error !== null)
        fail('I6c cancel ⇒ error cleared', JSON.stringify(state.error));
      if (newCalls.some(call => call.route === 'sync'))
        fail('I6d cancel ⇒ no sync', JSON.stringify(newCalls));
      if ((access?.premium ?? false) !== ctx.premiumBefore)
        fail('I6d2 cancel leaves access untouched', '');
    } else if (step.outcome.kind === 'error' && !oracle.signedOut) {
      const treatedAsCancel =
        step.outcome.userCancelled === true ||
        step.outcome.error === 'PURCHASE_CANCELLED_ERROR';
      const expected = treatedAsCancel ? null : 'billing.purchase_failed';
      if ((state.error?.code ?? null) !== expected) {
        fail(
          'I6e RC error ⇒ billing.purchase_failed',
          `${step.outcome.error} → ${state.error?.code ?? 'null'}`,
        );
      }
      if (newCalls.some(call => call.route === 'sync'))
        fail('I6e2 store error ⇒ no sync', '');
      if ((access?.premium ?? false) !== ctx.premiumBefore)
        fail('I6e3 store error leaves access untouched', '');
    } else if (
      (step.outcome.kind === 'reject_string' ||
        step.outcome.kind === 'reject_null') &&
      !oracle.signedOut
    ) {
      if (state.error?.code !== 'billing.purchase_failed')
        fail(
          'I6f non-object rejection ⇒ purchase_failed',
          state.error?.code ?? 'null',
        );
    } else if (!storeFailed && !oracle.signedOut) {
      // StoreKit succeeded, sync did not verify premium.
      const sync = newCalls.find(call => call.route === 'sync');
      if (!sync)
        fail('I6k store success ⇒ exactly one sync', JSON.stringify(newCalls));
      if (access?.premium)
        fail(
          'I6g store success + unverified sync ⇒ not premium',
          sync?.outcome ?? '',
        );
      if (state.error?.code !== 'billing.backend_verification_pending') {
        fail(
          'I6l unverified purchase ⇒ backend_verification_pending',
          `${sync?.outcome ?? ''} → ${state.error?.code ?? 'null'}`,
        );
      }
    }
  }
  if (step.op === 'restore' && typeof result === 'boolean') {
    if (result) {
      if (
        !access?.premium ||
        lastBackend?.route !== 'sync' ||
        lastBackend.outcome !== '200 premium=true'
      ) {
        fail(
          'I7 restore true ⇒ verified premium sync',
          JSON.stringify({ access, lastBackend }),
        );
      }
      if (!ctx.attempted) fail('I7h restore true without an attempt', '');
    } else if (!ctx.attempted) {
      if (world.sdk.storeKitAuth.length !== oracle.expectedAuth.length)
        fail('I7i unattempted restore reached StoreKit', '');
    } else if (!oracle.signedOut) {
      if (storeFailed) {
        if (state.error?.code !== 'billing.restore_failed')
          fail(
            'I7c store restore error ⇒ restore_failed',
            state.error?.code ?? 'null',
          );
        if (newCalls.some(call => call.route === 'sync'))
          fail('I7c2 store restore error ⇒ no sync', '');
        if ((access?.premium ?? false) !== ctx.premiumBefore)
          fail('I7c3 store restore error leaves access untouched', '');
      } else {
        if (access?.premium)
          fail(
            'I7b restore false after sync ⇒ not premium',
            JSON.stringify(access),
          );
        const sync = newCalls.find(call => call.route === 'sync');
        if (!sync)
          fail('I7k store restore success ⇒ sync', JSON.stringify(newCalls));
        if (sync?.outcome === '200 premium=false') {
          if (
            state.error?.code !== 'billing.restore_failed' ||
            state.error.retryable
          ) {
            fail(
              'I7d no entitlement ⇒ non-retryable restore_failed',
              JSON.stringify(state.error),
            );
          }
        } else if (
          state.error?.code !== 'billing.backend_verification_pending'
        ) {
          fail(
            'I7e failed sync after restore ⇒ backend_verification_pending',
            `${sync?.outcome ?? ''} → ${state.error?.code ?? 'null'}`,
          );
        }
      }
    }
  }
  if (
    step.op === 'double_tap' &&
    typeof result === 'object' &&
    result !== null
  ) {
    const { second } = result as { second: boolean };
    if (second !== false)
      fail('I8 concurrent operation rejected', JSON.stringify(result));
  }
  if (oracle.signedOut) {
    if (state.status !== 'idle' && state.status !== 'unconfigured')
      fail('I9 signed out ⇒ idle/unconfigured', state.status);
    if (access !== null)
      fail('I9b signed out ⇒ access null', JSON.stringify(access));
  }
}

async function runSequence(
  seed: number,
): Promise<{ trace: StepRecord[]; violations: Violation[] }> {
  const prng = new Prng(seed);
  const world = makeWorld(
    prng.chance(0.85) ? targetOffering() : randomOffering(prng).offering,
  );
  const oracle: Oracle = {
    signedOut: false,
    expectedAuth: [],
    bearerOwner: new Map(),
  };
  oracle.bearerOwner.set(world.token.current, world.user);
  const trace: StepRecord[] = [];
  const violations: Violation[] = [];
  const store = useAccessStore.getState();

  await store.initialize();
  await settle();
  const steps = 3 + prng.int(12);
  for (let i = 0; i < steps; i += 1) {
    const step = randomStep(prng, world);
    let result: unknown = null;
    const before = useAccessStore.getState();
    const canPurchase =
      !oracle.signedOut &&
      before.operation === 'idle' &&
      before.plans !== null &&
      before.plans[before.selectedPeriod] !== null &&
      before.canonicalAccess !== null;
    const canRestore = !oracle.signedOut && before.operation === 'idle';
    const ctx: StepContext = {
      attempted:
        step.op === 'purchase'
          ? canPurchase
          : step.op === 'restore'
            ? canRestore
            : false,
      premiumBefore: before.canonicalAccess?.premium ?? false,
      backendCallsBefore: world.backend.calls.length,
    };

    switch (step.op) {
      case 'initialize':
        await store.initialize();
        break;
      case 'refresh':
        if (step.fault) world.backend.fault('access', step.fault);
        result = await store.refreshAccess();
        break;
      case 'purchase':
        world.sdk.purchaseQueue.push(step.outcome);
        if (step.syncFault) world.backend.fault('sync', step.syncFault);
        if (canPurchase)
          oracle.expectedAuth.push({
            api: 'purchasePackage',
            user: world.user,
          });
        result = await store.purchaseSelected();
        world.sdk.purchaseQueue.length = 0;
        world.backend.faults.sync = [];
        break;
      case 'restore':
        world.sdk.restoreQueue.push(step.outcome);
        if (step.syncFault) world.backend.fault('sync', step.syncFault);
        if (canRestore)
          oracle.expectedAuth.push({
            api: 'restorePurchases',
            user: world.user,
          });
        result = await store.restorePurchases();
        world.sdk.restoreQueue.length = 0;
        world.backend.faults.sync = [];
        break;
      case 'select':
        store.selectPeriod(step.period);
        break;
      case 'store_grant': {
        const granted = {
          productIdentifier: step.lifetime
            ? 'pickle_sensei_pro_lifetime'
            : 'pickle_sensei_pro_yearly',
          expirationDate: step.lifetime
            ? null
            : new Date(Date.now() + 3_600_000).toISOString(),
        };
        world.sdk.storeAccount[step.entitlement] = granted;
        if (step.alsoRc)
          world.backend.rcSubscribers.set(world.user, {
            [step.entitlement]: granted,
          });
        break;
      }
      case 'store_revoke':
        world.sdk.storeAccount = {};
        world.backend.rcSubscribers.delete(world.user);
        break;
      case 'rc_expire': {
        const expired = {
          productIdentifier: 'pickle_sensei_pro_yearly',
          expirationDate: new Date(Date.now() - 1000).toISOString(),
        };
        world.backend.rcSubscribers.set(world.user, {
          [PREMIUM_ENTITLEMENT]: expired,
        });
        world.sdk.storeAccount = { [PREMIUM_ENTITLEMENT]: expired };
        break;
      }
      case 'ledger':
        world.backend.ledgers.set(world.user, {
          used: step.used,
          reserved: step.reserved,
        });
        break;
      case 'rc_rest':
        world.backend.rcRestDown = step.down;
        break;
      case 'rotate_token':
        world.backend.bearers.delete(world.token.current);
        world.token.current = `${world.token.current}-r`;
        world.backend.bearers.set(world.token.current, world.user);
        oracle.bearerOwner.set(world.token.current, world.user);
        break;
      case 'switch_account':
        configureFor(world, step.user);
        oracle.bearerOwner.set(world.token.current, world.user);
        oracle.signedOut = false;
        await store.initialize();
        break;
      case 'sign_out':
        clearAccessStoreConfiguration();
        oracle.signedOut = true;
        break;
      case 'double_tap': {
        if (!canPurchase) break;
        let release: (value: PurchaseOutcome) => void = () => undefined;
        const gate = new Promise<PurchaseOutcome>(resolve => {
          release = resolve;
        });
        world.sdk.purchaseQueue.push({ kind: 'await', gate });
        oracle.expectedAuth.push({ api: 'purchasePackage', user: world.user });
        const first = store.purchaseSelected();
        await settle(2);
        const second =
          step.second === 'purchase'
            ? await store.purchaseSelected()
            : step.second === 'restore'
              ? await store.restorePurchases()
              : await store.syncBilling();
        release({ kind: 'cancel', shape: 'both' });
        const firstResult = await first;
        result = { first: firstResult, second };
        break;
      }
    }
    await settle();

    const state = useAccessStore.getState();
    const record: StepRecord = {
      i,
      step,
      result,
      status: state.status,
      operation: state.operation,
      premium: state.canonicalAccess?.premium ?? null,
      errorCode: state.error?.code ?? null,
      lastBackend:
        world.backend.calls[world.backend.calls.length - 1]?.outcome ?? null,
      storeKitAuth: world.sdk.storeKitAuth.length,
    };
    trace.push(record);
    checkInvariants(world, oracle, step, result, ctx, (invariant, detail) => {
      violations.push({ seed, step: i, invariant, detail, trace: [...trace] });
    });
    if (violations.length) break;
  }
  return { trace, violations };
}

describe('M1 seeded state-machine fuzz over accessStore', () => {
  test(`${FUZZ_SEQUENCES} sequences from seed ${BASE_SEED}: oracle holds after every step`, async () => {
    const violations: Violation[] = [];
    let steps = 0;
    let storeKitCalls = 0;
    const opHistogram: Record<string, number> = {};
    const heapBefore = heapSnapshot();
    for (let n = 0; n < FUZZ_SEQUENCES; n += 1) {
      const seed = (BASE_SEED + n * 7919) >>> 0;
      const { trace, violations: v } = await runSequence(seed);
      steps += trace.length;
      storeKitCalls += trace[trace.length - 1]?.storeKitAuth ?? 0;
      for (const record of trace)
        opHistogram[record.step.op] = (opHistogram[record.step.op] ?? 0) + 1;
      violations.push(...v);
      clearAccessStoreConfiguration();
    }
    const heapAfter = heapSnapshot();
    writeArtifact('matrix-m1-fuzz.json', {
      baseSeed: BASE_SEED,
      sequences: FUZZ_SEQUENCES,
      steps,
      storeKitCalls,
      opHistogram,
      heapBefore,
      heapAfter,
      violations,
      replay:
        'XC_SEED=<seed> XC_FUZZ_SEQUENCES=1 npx jest __tests__/xc/paywallPurchaseRestore.matrix.test.ts -t M1',
    });
    expect(violations).toEqual([]);
    expect(steps).toBeGreaterThan(FUZZ_SEQUENCES * 3);
  }, 240_000);
});

// ─── M2: RevenueCat error-code matrix ────────────────────────────────────────

describe('M2 RevenueCat error-code matrix', () => {
  test('every PURCHASES_ERROR_CODE × userCancelled through purchase and restore', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const names = Object.keys(RC_ERROR_CODES) as RcErrorName[];
    for (const name of names) {
      for (const userCancelled of [true, false, null] as const) {
        const world = makeWorld();
        const store = useAccessStore.getState();
        await store.initialize();
        world.sdk.purchaseQueue.push({
          kind: 'error',
          error: name,
          userCancelled,
        });
        const purchaseResult = await store.purchaseSelected();
        const afterPurchase = useAccessStore.getState();
        const isCancel =
          userCancelled === true ||
          RC_ERROR_CODES[name] === RC_ERROR_CODES.PURCHASE_CANCELLED_ERROR;
        expect(purchaseResult).toBe(false);
        expect(afterPurchase.canonicalAccess?.premium).toBe(false);
        expect(afterPurchase.operation).toBe('idle');
        expect(afterPurchase.error?.code ?? null).toBe(
          isCancel ? null : 'billing.purchase_failed',
        );
        expect(world.backend.callsTo('sync')).toEqual([]);

        world.sdk.restoreQueue.push({ kind: 'error', error: name });
        const restoreResult = await store.restorePurchases();
        const afterRestore = useAccessStore.getState();
        expect(restoreResult).toBe(false);
        expect(afterRestore.error?.code).toBe('billing.restore_failed');
        expect(afterRestore.error?.retryable).toBe(true);
        expect(afterRestore.canonicalAccess?.premium).toBe(false);
        expect(world.backend.callsTo('sync')).toEqual([]);
        expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
          'purchasePackage',
          'restorePurchases',
        ]);
        rows.push({
          code: RC_ERROR_CODES[name],
          name,
          userCancelled,
          purchase: {
            result: purchaseResult,
            error: afterPurchase.error?.code ?? null,
            treatedAsCancel: isCancel,
          },
          restore: {
            result: restoreResult,
            error: afterRestore.error?.code ?? null,
          },
        });
        clearAccessStoreConfiguration();
      }
    }
    writeArtifact('matrix-m2-rc-error-codes.json', { rows });
    expect(rows).toHaveLength(names.length * 3);
  }, 120_000);

  test('cancellation shapes: userCancelled-only, code-only, both, and the readable code string', async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const shape of ['both', 'userCancelled_only', 'code_only'] as const) {
      const world = makeWorld();
      const store = useAccessStore.getState();
      await store.initialize();
      world.sdk.purchaseQueue.push({ kind: 'cancel', shape });
      const result = await store.purchaseSelected();
      const state = useAccessStore.getState();
      rows.push({
        shape,
        result,
        error: state.error,
        syncCalls: world.backend.callsTo('sync').length,
      });
      expect(result).toBe(false);
      expect(state.error).toBeNull();
      expect(world.backend.callsTo('sync')).toEqual([]);
      clearAccessStoreConfiguration();
    }
    writeArtifact('matrix-m2-cancel-shapes.json', { rows });
  });
});

// ─── M3: store-price fuzz + malformed packages ───────────────────────────────

describe('M3 store-returned prices, verbatim, at scale', () => {
  test(`${PRICE_FUZZ} random storefront offerings through loadPlans`, async () => {
    const failures: Array<Record<string, unknown>> = [];
    const currencyHistogram: Record<string, number> = {};
    let plansSeen = 0;
    for (let n = 0; n < PRICE_FUZZ; n += 1) {
      const seed = (BASE_SEED * 31 + n) >>> 0;
      const prng = new Prng(seed);
      const { offering, record } = randomOffering(prng);
      const sdk = resetPurchasesMock();
      sdk.offering = offering;
      const client = createRevenueCatBillingClient(
        { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: CANONICAL_USER_A },
        mockedSdk,
        'ios',
      );
      const plans = await client.loadPlans();
      currencyHistogram[record.currencyCode] =
        (currencyHistogram[record.currencyCode] ?? 0) + 1;
      for (const period of ['monthly', 'annual', 'lifetime'] as const) {
        const pkg = offering[period];
        const plan = plans[period];
        if (!pkg) {
          if (plan !== null)
            failures.push({ seed, period, why: 'plan without package' });
          continue;
        }
        plansSeen += 1;
        if (!plan) {
          failures.push({ seed, period, why: 'package dropped', pkg });
          continue;
        }
        if (plan.priceString !== pkg.product.priceString) {
          failures.push({
            seed,
            period,
            why: 'priceString not verbatim',
            got: plan.priceString,
            want: pkg.product.priceString,
          });
        }
        if (plan.price !== pkg.product.price)
          failures.push({ seed, period, why: 'price changed' });
        if (plan.productId !== pkg.product.identifier)
          failures.push({ seed, period, why: 'productId changed' });
        const wantPerMonth =
          period === 'lifetime' ? null : pkg.product.pricePerMonthString;
        if (plan.pricePerMonthString !== wantPerMonth) {
          failures.push({
            seed,
            period,
            why: 'pricePerMonthString',
            got: plan.pricePerMonthString,
            want: wantPerMonth,
          });
        }
        if (period === 'lifetime' && plan.freeTrial !== null)
          failures.push({ seed, period, why: 'lifetime trial' });
        if (period === 'annual' && record.introPeriod && !plan.freeTrial) {
          failures.push({
            seed,
            period,
            why: 'eligible intro trial dropped',
            introPeriod: record.introPeriod,
          });
        }
        if (period === 'annual' && !record.introPeriod && plan.freeTrial) {
          failures.push({ seed, period, why: 'trial invented' });
        }
        // The dossier's USD targets must never leak in unless the store returned them.
        for (const literal of ['$7.99', '$59.99', '$159.99']) {
          if (
            plan.priceString.includes(literal) &&
            !pkg.product.priceString.includes(literal)
          ) {
            failures.push({
              seed,
              period,
              why: 'target literal leaked',
              literal,
            });
          }
        }
      }
      if (world_sdk_calls_touch_storekit(sdk))
        failures.push({ seed, why: 'loadPlans touched StoreKit auth' });
    }
    writeArtifact('matrix-m3-price-fuzz.json', {
      baseSeed: BASE_SEED,
      offerings: PRICE_FUZZ,
      plansSeen,
      currencyHistogram,
      failures,
      replay: 'seed → new Prng(seed) → randomOffering',
    });
    expect(failures).toEqual([]);
    expect(Object.keys(currencyHistogram).sort()).toEqual(
      STOREFRONTS.map(s => s.currencyCode).sort(),
    );
  }, 120_000);

  test('malformed package matrix: wrong type, missing/invalid price, empty priceString, all-missing', async () => {
    const usd = STOREFRONTS[0]!;
    const good = targetOffering();
    const cases: Array<{
      name: string;
      mutate: (o: RcOffering) => void;
      expect: 'drop_monthly' | 'throw' | 'keep';
    }> = [
      {
        name: 'monthly package typed ANNUAL',
        mutate: o => {
          o.monthly!.packageType = 'ANNUAL';
        },
        expect: 'drop_monthly',
      },
      {
        name: 'monthly package typed CUSTOM',
        mutate: o => {
          o.monthly!.packageType = 'CUSTOM';
        },
        expect: 'drop_monthly',
      },
      {
        name: 'monthly price NaN',
        mutate: o => {
          o.monthly!.product.price = Number.NaN;
        },
        expect: 'drop_monthly',
      },
      {
        name: 'monthly price negative',
        mutate: o => {
          o.monthly!.product.price = -1;
        },
        expect: 'drop_monthly',
      },
      {
        name: 'monthly price Infinity',
        mutate: o => {
          o.monthly!.product.price = Number.POSITIVE_INFINITY;
        },
        expect: 'drop_monthly',
      },
      {
        name: 'monthly priceString empty',
        mutate: o => {
          o.monthly!.product.priceString = '';
        },
        expect: 'drop_monthly',
      },
      {
        name: 'monthly product identifier empty',
        mutate: o => {
          o.monthly!.product.identifier = '';
        },
        expect: 'drop_monthly',
      },
      {
        name: 'monthly price 0 (free) keeps',
        mutate: o => {
          o.monthly!.product.price = 0;
          o.monthly!.product.priceString = usd.format(0);
        },
        expect: 'keep',
      },
      {
        name: 'all three malformed',
        mutate: o => {
          o.monthly!.packageType = 'X';
          o.annual!.packageType = 'X';
          o.lifetime!.packageType = 'X';
        },
        expect: 'throw',
      },
      {
        name: 'all three null',
        mutate: o => {
          o.monthly = null;
          o.annual = null;
          o.lifetime = null;
        },
        expect: 'throw',
      },
    ];
    const rows: Array<Record<string, unknown>> = [];
    for (const c of cases) {
      const offering: RcOffering = JSON.parse(
        JSON.stringify(good),
      ) as RcOffering;
      c.mutate(offering);
      const sdk = resetPurchasesMock();
      sdk.offering = offering;
      const client = createRevenueCatBillingClient(
        { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: CANONICAL_USER_A },
        mockedSdk,
        'ios',
      );
      let outcome: string;
      try {
        const plans = await client.loadPlans();
        outcome = `monthly=${plans.monthly ? 'kept' : 'dropped'} annual=${plans.annual ? 'kept' : 'dropped'} lifetime=${plans.lifetime ? 'kept' : 'dropped'}`;
        if (c.expect === 'throw')
          throw new Error(`expected throw, got ${outcome}`);
        if (c.expect === 'drop_monthly') expect(plans.monthly).toBeNull();
        if (c.expect === 'keep')
          expect(plans.monthly?.priceString).toBe(usd.format(0));
        expect(plans.annual).not.toBeNull();
      } catch (error) {
        if (c.expect !== 'throw') throw error;
        outcome = `throw ${(error as { code?: string }).code ?? String(error)}`;
        expect((error as { code?: string }).code).toBe(
          'billing.offerings_unavailable',
        );
      }
      expect(sdk.storeKitAuth).toEqual([]);
      rows.push({ case: c.name, expect: c.expect, outcome });
    }
    writeArtifact('matrix-m3-malformed-packages.json', { rows });
  });

  test('a purchase for a plan id the current offering no longer contains never reaches StoreKit', async () => {
    const world = makeWorld();
    const store = useAccessStore.getState();
    await store.initialize();
    const staleId = useAccessStore.getState().plans!.annual!.id;
    // Store rotates the offering; the app reloads pricing (Try again).
    world.sdk.offering = {
      ...targetOffering(),
      identifier: 'rotated',
      annual: makePackage(
        'ANNUAL',
        'pickle_sensei_pro_yearly_v2',
        49.99,
        STOREFRONTS[0]!,
      ),
    };
    await store.initialize();
    const freshId = useAccessStore.getState().plans!.annual!.id;
    expect(freshId).not.toBe(staleId);
    const client = createRevenueCatBillingClient(
      { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: CANONICAL_USER_A },
      mockedSdk,
      'ios',
    );
    await client.loadPlans();
    await expect(client.purchase(staleId)).rejects.toMatchObject({
      code: 'billing.offerings_unavailable',
    });
    expect(world.sdk.storeKitAuth).toEqual([]);
  });
});

function world_sdk_calls_touch_storekit(sdk: MockPurchasesState): boolean {
  return sdk.storeKitAuth.length > 0;
}

// ─── M4: static pins on src/ ─────────────────────────────────────────────────

describe('M4 static pins', () => {
  const files = listSourceFiles(sourceRoot());
  const sources = new Map(
    files.map(file => [file.replace(`${sourceRoot()}/`, ''), readSource(file)]),
  );

  test('purchaseSelected / restorePurchases are invoked from exactly the two paywall buttons', () => {
    const callers: Array<{ file: string; api: string; line: number }> = [];
    for (const [file, text] of sources) {
      // The store defines them; the RevenueCat client calls the SDK method of
      // the same name (pinned separately below).
      if (
        file === 'state/accessStore.ts' ||
        file === 'billing/revenueCatClient.ts'
      )
        continue;
      text.split('\n').forEach((line, index) => {
        if (/\bpurchaseSelected\(\)/.test(line))
          callers.push({ file, api: 'purchaseSelected', line: index + 1 });
        if (/\brestorePurchases\(\)/.test(line))
          callers.push({ file, api: 'restorePurchases', line: index + 1 });
      });
    }
    writeArtifact('matrix-m4-callers.json', { callers });
    expect(callers.map(c => `${c.file}:${c.api}`).sort()).toEqual([
      'screens/PaywallScreen.tsx:purchaseSelected',
      'screens/PaywallScreen.tsx:restorePurchases',
    ]);
    const paywall = sources.get('screens/PaywallScreen.tsx')!;
    // The Continue button owns the purchase call; Restore owns the restore call.
    const continueIdx = paywall.indexOf('testID="paywall-continue"');
    const restoreIdx = paywall.indexOf('testID="paywall-restore"');
    expect(continueIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(-1);
  });

  test('no SDK entry point outside revenueCatClient.ts and none of the automatic StoreKit-auth APIs anywhere', () => {
    const forbidden = [
      'syncPurchases',
      'presentCodeRedemptionSheet',
      'purchaseProduct',
      'purchaseStoreProduct',
      'purchaseDiscountedPackage',
      'purchaseDiscountedProduct',
      'purchaseSubscriptionOption',
    ];
    const hits: Array<{ file: string; token: string }> = [];
    for (const [file, text] of sources) {
      if (
        file.includes('react-native-purchases') &&
        file !== 'billing/revenueCatClient.ts' &&
        !file.startsWith('billing/')
      ) {
        hits.push({ file, token: 'react-native-purchases import' });
      }
      for (const token of forbidden)
        if (text.includes(token)) hits.push({ file, token });
      if (
        text.includes('purchasePackage(') &&
        file !== 'billing/revenueCatClient.ts'
      )
        hits.push({ file, token: 'purchasePackage(' });
      if (
        text.includes('.restorePurchases()') &&
        file !== 'billing/revenueCatClient.ts' &&
        file !== 'screens/PaywallScreen.tsx' &&
        file !== 'state/accessStore.ts'
      ) {
        hits.push({ file, token: 'restorePurchases()' });
      }
    }
    const importers = [...sources.entries()]
      .filter(([, text]) => /['"]react-native-purchases['"]/.test(text))
      .map(([file]) => file);
    writeArtifact('matrix-m4-sdk-surface.json', { importers, hits });
    expect(importers).toEqual(['billing/revenueCatClient.ts']);
    expect(hits).toEqual([]);
  });

  test('no hard-coded price literal in billing, state, or paywall/settings screens', () => {
    const hits: Array<{ file: string; line: number; text: string }> = [];
    const scan = [
      'billing/',
      'state/accessStore.ts',
      'screens/PaywallScreen.tsx',
      'screens/SettingsScreen.tsx',
      'api/',
    ];
    for (const [file, text] of sources) {
      if (!scan.some(prefix => file.startsWith(prefix))) continue;
      text.split('\n').forEach((line, index) => {
        if (
          /\$\s?\d+(\.\d{2})?\b|\b(7\.99|59\.99|159\.99)\b|\/\s?(mo|yr|month|year)\b.*\d/.test(
            line,
          ) &&
          !line.trim().startsWith('//') &&
          !line.trim().startsWith('*')
        ) {
          hits.push({ file, line: index + 1, text: line.trim() });
        }
      });
    }
    writeArtifact('matrix-m4-price-literals.json', { hits });
    expect(hits).toEqual([]);
  });

  test('Settings membership row words from availableToReserve, never remaining', () => {
    const settings = sources.get('screens/SettingsScreen.tsx')!;
    expect(settings).toContain('availableToReserve');
    expect(settings).toContain('Pro active');
    expect(settings).toContain('Upgrade required');
    expect(settings).toContain('Verify access');
    // No membership wording derived from `remaining`.
    const remainingUses = settings
      .split('\n')
      .filter(line => /freeRatings\.remaining/.test(line));
    expect(remainingUses).toEqual([]);
  });

  test('cancellation detection covers RevenueCat SDK userCancelled and code "1"', () => {
    const client = sources.get('billing/revenueCatClient.ts')!;
    expect(client).toMatch(/userCancelled\s*===\s*true/);
    expect(client).toMatch(/code\s*===\s*'1'/);
    expect(RC_ERROR_CODES.PURCHASE_CANCELLED_ERROR).toBe('1');
  });
});

// ─── M5: targeted interleavings ─────────────────────────────────────────────

describe('M5 interleavings the UI cannot schedule', () => {
  test('a slow Settings refresh in flight across a purchase: intermediate value is recorded, the next refresh always shows the persisted verdict', async () => {
    // refreshAccess has no operation guard; a GET /v1/me/access issued while
    // a purchase is in flight lands AFTER the sync. The fake backend computes
    // the response after the delay (like a slow network, not a slow DB), so
    // this records what the store shows in between rather than asserting it.
    const world = makeWorld();
    const store = useAccessStore.getState();
    await store.initialize();
    world.backend.fault('access', { kind: 'delay', ms: 30 });
    const refresh = store.refreshAccess();
    const purchase = store.purchaseSelected();
    const purchaseResult = await purchase;
    expect(purchaseResult).toBe(true);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    await refresh;
    await settle();
    const afterRefresh = useAccessStore.getState();
    const outcomes = world.backend.calls.map(c => `${c.route}:${c.outcome}`);
    writeArtifact('matrix-m5-stale-refresh.json', {
      outcomes,
      premiumAfterPurchase: true,
      premiumAfterStaleRefresh: afterRefresh.canonicalAccess?.premium ?? null,
      repairedByNextRefresh: null,
    });
    // Second refresh must repair from the persisted verdict.
    await store.refreshAccess();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    // Record, do not assert, the intermediate value; asserting either way
    // would fabricate a requirement.
    expect(typeof afterRefresh.canonicalAccess?.premium).toBe('boolean');
  });

  test('sync 200 with premium true in `billing` but false in `access` is rejected as an invalid response: fail closed', async () => {
    const world = makeWorld();
    const store = useAccessStore.getState();
    await store.initialize();
    world.backend.fault('sync', { kind: 'inconsistent_premium' });
    const result = await store.purchaseSelected();
    const state = useAccessStore.getState();
    expect(result).toBe(false);
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(world.backend.callsTo('sync').map(c => c.outcome)).toEqual([
      'fault:inconsistent_premium',
    ]);
  });

  test('bearer rotation between StoreKit success and sync: sync carries the NEW bearer and verifies', async () => {
    const world = makeWorld();
    const store = useAccessStore.getState();
    await store.initialize();
    let release: (value: PurchaseOutcome) => void = () => undefined;
    world.sdk.purchaseQueue.push({
      kind: 'await',
      gate: new Promise<PurchaseOutcome>(resolve => {
        release = resolve;
      }),
    });
    const purchase = store.purchaseSelected();
    await settle(2);
    const old = world.token.current;
    world.backend.bearers.delete(old);
    world.token.current = `${old}-rotated`;
    world.backend.bearers.set(world.token.current, world.user);
    release({ kind: 'success' });
    expect(await purchase).toBe(true);
    const sync = world.backend.callsTo('sync');
    expect(sync).toHaveLength(1);
    expect(sync[0]!.bearer).toBe(world.token.current);
    expect(sync[0]!.outcome).toBe('200 premium=true');
  });

  test('bearer revoked (401) between StoreKit success and sync: verification pending, no unlock, no retry storm', async () => {
    const world = makeWorld();
    const store = useAccessStore.getState();
    await store.initialize();
    let release: (value: PurchaseOutcome) => void = () => undefined;
    world.sdk.purchaseQueue.push({
      kind: 'await',
      gate: new Promise<PurchaseOutcome>(resolve => {
        release = resolve;
      }),
    });
    const purchase = store.purchaseSelected();
    await settle(2);
    world.backend.bearers.delete(world.token.current);
    release({ kind: 'success' });
    expect(await purchase).toBe(false);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(world.backend.callsTo('sync').map(c => c.outcome)).toEqual(['401']);
    // The store account holds the entitlement; a Restore after re-auth verifies.
    world.backend.bearers.set(world.token.current, world.user);
    expect(await store.restorePurchases()).toBe(true);
    expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
      'purchasePackage',
      'restorePurchases',
    ]);
  });

  test("account switch: user B never inherits user A verified premium, RevenueCat is re-bound via logIn, and A's purchase completing late is discarded", async () => {
    const world = makeWorld();
    const store = useAccessStore.getState();
    await store.initialize();
    expect(await store.restorePurchases()).toBe(false);
    world.sdk.storeAccount = {};
    let release: (value: PurchaseOutcome) => void = () => undefined;
    world.sdk.purchaseQueue.push({
      kind: 'await',
      gate: new Promise<PurchaseOutcome>(resolve => {
        release = resolve;
      }),
    });
    const purchaseA = store.purchaseSelected();
    await settle(2);
    configureFor(world, CANONICAL_USER_B);
    await store.initialize();
    expect(world.sdk.appUserID).toBe(CANONICAL_USER_B);
    expect(
      world.sdk.calls.filter(c => c.api === 'logIn').map(c => c.args),
    ).toEqual([CANONICAL_USER_B]);
    release({ kind: 'success' });
    expect(await purchaseA).toBe(false);
    await settle();
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(false);
    expect(state.error).toBeNull();
    // A's sync was never issued after the switch (the stale continuation bails).
    const syncs = world.backend.callsTo('sync');
    expect(
      syncs.every(
        c =>
          world.backend.bearers.get(c.bearer ?? '') !== CANONICAL_USER_B ||
          c.outcome === '200 premium=false',
      ),
    ).toBe(true);
    expect(
      world.backend.persistedVerdicts.get(CANONICAL_USER_B)?.premium ?? false,
    ).toBe(false);
  });

  test('offerings unavailable never blocks a verified free allowance, and purchase then fails closed without StoreKit', async () => {
    const world = makeWorld(null);
    const store = useAccessStore.getState();
    await store.initialize();
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.error?.code).toBe('billing.offerings_unavailable');
    expect(state.canonicalAccess?.canStartRating).toBe(true);
    expect(state.plans).toBeNull();
    expect(await store.purchaseSelected()).toBe(false);
    expect(world.sdk.storeKitAuth).toEqual([]);
    // Restore is still an explicit user action and still reaches StoreKit.
    expect(await store.restorePurchases()).toBe(false);
    expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
      'restorePurchases',
    ]);
  });

  test('legacy `premium` entitlement alias restores as premium', async () => {
    const world = makeWorld();
    const store = useAccessStore.getState();
    await store.initialize();
    const granted = {
      productIdentifier: 'pickle_sensei_pro_lifetime',
      expirationDate: null,
    };
    world.sdk.storeAccount[LEGACY_PREMIUM_ENTITLEMENT] = granted;
    expect(await store.restorePurchases()).toBe(true);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
  });

  test('expired entitlement on the store account restores as NOT premium', async () => {
    const world = makeWorld();
    const store = useAccessStore.getState();
    await store.initialize();
    world.sdk.storeAccount[PREMIUM_ENTITLEMENT] = {
      productIdentifier: 'pickle_sensei_pro_yearly',
      expirationDate: new Date(Date.now() - 60_000).toISOString(),
    };
    expect(await store.restorePurchases()).toBe(false);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(false);
    expect(state.error?.code).toBe('billing.restore_failed');
    expect(state.error?.retryable).toBe(false);
  });
});

// ─── M6: heap under sustained purchase→sync cycles ──────────────────────────

describe('M6 heap', () => {
  test('600 purchase→sync→revoke cycles do not grow the heap unboundedly', async () => {
    const world = makeWorld();
    const store = useAccessStore.getState();
    await store.initialize();
    const samples: Array<{ cycle: number; heapUsedMb: number; rssMb: number }> =
      [];
    const gc = (globalThis as { gc?: () => void }).gc;
    for (let cycle = 0; cycle < 600; cycle += 1) {
      world.sdk.purchaseQueue.push({ kind: 'success' });
      expect(await store.purchaseSelected()).toBe(true);
      world.sdk.storeAccount = {};
      world.backend.rcSubscribers.delete(world.user);
      expect(await store.restorePurchases()).toBe(false);
      if (cycle % 100 === 99) {
        gc?.();
        samples.push({ cycle: cycle + 1, ...heapSnapshot() });
        // Keep the fake ledgers bounded like a real client would (the
        // backend log is test bookkeeping, not app memory).
        world.backend.calls.length = 0;
        world.sdk.calls.length = 0;
        world.sdk.storeKitAuth.length = 0;
      }
    }
    writeArtifact('matrix-m6-heap.json', {
      samples,
      gcExposed: typeof gc === 'function',
    });
    expect(samples).toHaveLength(6);
    const first = samples[0]!.heapUsedMb;
    const last = samples[samples.length - 1]!.heapUsedMb;
    // Without --expose-gc this is a soft bound; a leak of the store's
    // closures per cycle would show as monotonic growth well beyond this.
    expect(last - first).toBeLessThan(64);
  }, 120_000);
});
