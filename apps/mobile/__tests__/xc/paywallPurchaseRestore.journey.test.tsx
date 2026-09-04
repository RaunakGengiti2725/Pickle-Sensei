/**
 * XC journey `paywall-purchase-restore` — EXECUTED end to end through the
 * real screens, the real access store, the real RevenueCat client over a
 * mocked `react-native-purchases`, and the real canonical-access HTTP client
 * against a fake Edge Function backend.
 *
 * `react-native-purchases` is mocked at the module boundary AND the same mock
 * object is injected through `BillingAccessConfig.revenueCatSdk` (the seam the
 * app's own tests use): Jest's babel transform does not lower
 * `import('react-native-purchases')` ("dynamic import callback was invoked
 * without --experimental-vm-modules"), so the one dynamic-import line in
 * `revenueCatClient.loadNativeSdk` is not exercised on Linux — everything
 * after it is.
 *
 * Journey: Paywall value page → "See membership plans" → store-returned
 * prices → Continue (purchase success / cancel / coded StoreKit errors /
 * RC-backend lag / backend outage) → entitlement reflected in `accessStore`
 * ONLY after `POST /v1/billing/sync` says premium → Restore purchases
 * (success / nothing to restore / StoreKit failure) → Settings membership
 * row wording.
 *
 * Invariants asserted on every scenario:
 *  - Only `paywall-continue` and `paywall-restore` ever append to the
 *    StoreKit-auth ledger (`purchasePackage` / `restorePurchases`); every
 *    other control on both pages leaves it untouched.
 *  - Every price string on screen is byte-identical to what the mocked store
 *    returned; the dossier's target prices never appear unless returned.
 *  - `canonicalAccess.premium` flips to true only after a sync response with
 *    `premium: true`; `onPurchased` fires only in that case.
 *  - No forbidden dossier copy is rendered.
 *
 * Raw evidence: artifacts/xc-journey-paywall-purchase-restore/journey.json.
 */
jest.mock('react-native-purchases', () => {
  const support = jest.requireActual<
    typeof import('../../test-support/xc/paywallPurchaseRestore.support')
  >('../../test-support/xc/paywallPurchaseRestore.support');
  return support.installMockPurchases();
});
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: { insets },
  };
});
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  createBillingAccessDependencies,
  type RevenueCatSdk,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useConsentStore } from '../../src/state/consentStore';
import {
  API_BASE_URL,
  CANONICAL_USER_A,
  CANONICAL_USER_B,
  FakeAccessBackend,
  NON_STOREKIT_BUTTON_TEST_IDS,
  PUBLIC_SDK_KEY,
  Prng,
  STOREKIT_BUTTON_TEST_IDS,
  TARGET_PRICE_LITERALS,
  forbiddenCopyIn,
  heapSnapshot,
  installMockPurchases,
  randomOffering,
  resetPurchasesMock,
  targetOffering,
  writeArtifact,
  type MockPurchasesState,
  type PurchaseOutcome,
  type RcErrorName,
  type RcOffering,
  type RestoreOutcome,
} from '../../test-support/xc/paywallPurchaseRestore.support';

// ─── Evidence ────────────────────────────────────────────────────────────────

interface ScenarioRecord {
  id: string;
  title: string;
  seed: number | null;
  inputs: Record<string, unknown>;
  storeKitAuth: MockPurchasesState['storeKitAuth'];
  sdkCalls: string[];
  backendCalls: Array<{
    route: string;
    outcome: string;
    bearer: string | null;
  }>;
  finalAccess: {
    status: string;
    operation: string;
    premium: boolean | null;
    errorCode: string | null;
    errorMessage: string | null;
  };
  onPurchasedCalls: number;
  renderedTextSample: string[];
  verdict: 'passed' | 'documented_failure';
  notes: string[];
  heap: ReturnType<typeof heapSnapshot>;
}

const records: ScenarioRecord[] = [];
const startedAt = new Date().toISOString();

afterAll(() => {
  const file = writeArtifact('journey.json', {
    harness: 'paywallPurchaseRestore.journey',
    baseline: '4d812e1aa699014cc0521fd92fde66908043aaa8',
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios: records.length,
    passed: records.filter(r => r.verdict === 'passed').length,
    documentedFailures: records
      .filter(r => r.verdict === 'documented_failure')
      .map(r => r.id),
    records,
  });
  console.log(`[xc-journey] wrote ${file} (${records.length} scenarios)`);
});

// ─── Harness plumbing ────────────────────────────────────────────────────────

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: 'apple-subject-not-a-uuid',
  canonicalAppUserId: CANONICAL_USER_A,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

interface World {
  backend: FakeAccessBackend;
  sdk: MockPurchasesState;
  token: { current: string | null };
  onPurchased: jest.Mock;
  onClose: jest.Mock;
}

let mounted: TestRenderer.ReactTestRenderer[] = [];

/** Same object `jest.mock('react-native-purchases')` hands the app; both read
 * `purchasesMock.state`. */
const mockedPurchasesModule = installMockPurchases();
const mockedSdk = mockedPurchasesModule.default as unknown as RevenueCatSdk;

function makeWorld(options?: {
  offering?: RcOffering | null;
  userId?: string;
  ledger?: { used: number; reserved: number };
}): World {
  const backend = new FakeAccessBackend(API_BASE_URL);
  const sdk = resetPurchasesMock();
  backend.attachSdk(sdk);
  sdk.offering =
    options?.offering === undefined ? targetOffering() : options.offering;
  const userId = options?.userId ?? CANONICAL_USER_A;
  const token = { current: `bearer-${userId.slice(0, 8)}-1` };
  backend.bearers.set(token.current, userId);
  backend.ledgers.set(userId, options?.ledger ?? { used: 0, reserved: 0 });
  configureAccessStore(
    createBillingAccessDependencies({
      revenueCatPublicSdkKey: PUBLIC_SDK_KEY,
      canonicalAppUserId: userId,
      apiBaseUrl: API_BASE_URL,
      get apiToken() {
        return token.current;
      },
      fetchFn: backend.fetch,
      revenueCatSdk: mockedSdk,
      platform: 'ios',
    }),
  );
  return { backend, sdk, token, onPurchased: jest.fn(), onClose: jest.fn() };
}

async function flush(turns = 12) {
  await act(async () => {
    for (let i = 0; i < turns; i += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  });
}

function renderPaywall(world: World): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PaywallScreen onClose={world.onClose} onPurchased={world.onPurchased} />,
    );
  });
  mounted.push(renderer);
  return renderer;
}

function renderSettings(): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<SettingsScreen />);
  });
  mounted.push(renderer);
  return renderer;
}

function pressable(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
): TestRenderer.ReactTestInstance | null {
  const nodes = renderer.root.findAll(
    node =>
      node.props.testID === testID && typeof node.props.onPress === 'function',
  );
  return nodes[0] ?? null;
}

function pressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance | null {
  const nodes = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  return nodes[0] ?? null;
}

async function press(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  const node = pressable(renderer, testID);
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  await act(async () => {
    node.props.onPress();
  });
  await flush();
}

function isDisabled(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  const node = pressable(renderer, testID);
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node.props.disabled === true;
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  for (const node of renderer.root.findAllByType(Text)) {
    const children = React.Children.toArray(node.props.children);
    const text = children
      .filter(child => typeof child === 'string' || typeof child === 'number')
      .join('');
    if (text.trim()) out.push(text.trim());
  }
  return out;
}

function allLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.props.accessibilityLabel === 'string')
    .map(node => String(node.props.accessibilityLabel));
}

function membershipValue(renderer: TestRenderer.ReactTestRenderer): string {
  const rows = renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Pickle Sensei Pro, ') &&
      typeof node.props.onPress === 'function',
  );
  expect(rows.length).toBeGreaterThan(0);
  return String(rows[0]!.props.accessibilityLabel).replace(
    'Pickle Sensei Pro, ',
    '',
  );
}

/**
 * APP_STORE_SUBMISSION.md §Optional acknowledges ONE in-app third-party
 * trademark: the disclaimed "DUPR-style estimate" note (Settings/Progress/
 * Result). The Settings blob may contain that disclaimer and nothing else
 * from the forbidden list.
 */
function forbiddenCopyExceptKnownDisclaimer(texts: string[]): string[] {
  const rest = texts.filter(
    text =>
      !(
        text.includes('not a verified DUPR or player') ||
        text.startsWith('DUPR figure is a rough estimate')
      ),
  );
  return forbiddenCopyIn(rest.join('\n'));
}

function accessSnapshot() {
  const state = useAccessStore.getState();
  return {
    status: state.status,
    operation: state.operation,
    premium: state.canonicalAccess ? state.canonicalAccess.premium : null,
    errorCode: state.error?.code ?? null,
    errorMessage: state.error?.message ?? null,
  };
}

function recordScenario(
  id: string,
  title: string,
  world: World,
  renderer: TestRenderer.ReactTestRenderer | null,
  extra: Partial<ScenarioRecord> & { seed?: number | null },
): ScenarioRecord {
  const record: ScenarioRecord = {
    id,
    title,
    seed: extra.seed ?? null,
    inputs: extra.inputs ?? {},
    storeKitAuth: [...world.sdk.storeKitAuth],
    sdkCalls: world.sdk.calls.map(call => call.api),
    backendCalls: world.backend.calls.map(call => ({
      route: call.route,
      outcome: call.outcome,
      bearer: call.bearer,
    })),
    finalAccess: accessSnapshot(),
    onPurchasedCalls: world.onPurchased.mock.calls.length,
    renderedTextSample: renderer ? renderedText(renderer).slice(0, 40) : [],
    verdict: extra.verdict ?? 'passed',
    notes: extra.notes ?? [],
    heap: heapSnapshot(),
  };
  records.push(record);
  return record;
}

/** Common invariants every scenario must satisfy. */
function assertGlobalInvariants(
  world: World,
  renderer: TestRenderer.ReactTestRenderer,
  offering: RcOffering | null,
) {
  // 1. Only the two explicit APIs ever appear on the StoreKit ledger.
  for (const entry of world.sdk.storeKitAuth) {
    expect(['purchasePackage', 'restorePurchases']).toContain(entry.api);
    // RevenueCat is bound to the canonical UUID, never the provider subject.
    expect(entry.appUserID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(entry.appUserID).not.toBe(syncedSession.subject);
  }
  // 2. Never an automatic restore / sync.
  expect(world.sdk.calls.map(c => c.api)).not.toContain('syncPurchases');
  expect(world.sdk.calls.map(c => c.api)).not.toContain(
    'syncPurchasesForResult',
  );
  // 3. No forbidden dossier copy on screen.
  const blob = [...renderedText(renderer), ...allLabels(renderer)].join('\n');
  expect(forbiddenCopyIn(blob)).toEqual([]);
  // 4. Prices on screen are store-returned, verbatim.
  const priceStrings = [
    offering?.monthly?.product.priceString,
    offering?.annual?.product.priceString,
    offering?.lifetime?.product.priceString,
    offering?.monthly?.product.pricePerMonthString,
    offering?.annual?.product.pricePerMonthString,
  ].filter((value): value is string => typeof value === 'string');
  for (const literal of TARGET_PRICE_LITERALS) {
    if (priceStrings.some(price => price.includes(literal))) continue;
    expect(blob).not.toContain(literal);
  }
  // 5. premium in store ⇔ last sync said premium.
  const lastSync = [...world.backend.callsTo('sync')].reverse()[0];
  const access = useAccessStore.getState().canonicalAccess;
  if (access?.premium) {
    expect(lastSync?.outcome).toBe('200 premium=true');
  }
}

async function openPricingPage(
  world: World,
): Promise<TestRenderer.ReactTestRenderer> {
  const renderer = renderPaywall(world);
  await flush();
  expect(useAccessStore.getState().status).toBe('ready');
  await press(renderer, 'paywall-see-plans');
  return renderer;
}

beforeEach(() => {
  clearAccessStoreConfiguration();
  useAuthStore.setState({ session: syncedSession });
  useConsentStore.setState({
    availability: 'signed_out',
    modelTrainingActive: false,
    hydrate: jest.fn(() => Promise.resolve()),
  });
  mockNavigate.mockReset();
});

afterEach(() => {
  act(() => {
    for (const renderer of mounted) renderer.unmount();
  });
  mounted = [];
  clearAccessStoreConfiguration();
});

// ─── J1: presentation + store-returned prices ────────────────────────────────

describe('J1 paywall presentation', () => {
  it('value page shows no prices and never touches StoreKit; the pricing page echoes store strings verbatim', async () => {
    const prng = new Prng(0xc0ffee);
    const { offering, record: offeringRecord } = randomOffering(prng);
    const world = makeWorld({ offering });
    const renderer = renderPaywall(world);
    await flush();

    // Value page: initialize ran (configure + offerings + access) but nothing
    // that could put an App Store sheet up.
    const valueText = renderedText(renderer).join('\n');
    expect(world.sdk.storeKitAuth).toEqual([]);
    expect(world.sdk.calls.map(c => c.api)).toEqual(
      expect.arrayContaining(['isConfigured', 'configure', 'getOfferings']),
    );
    expect(world.sdk.appUserID).toBe(CANONICAL_USER_A);
    expect(world.sdk.apiKey).toBe(PUBLIC_SDK_KEY);
    for (const price of [
      offeringRecord.monthly?.priceString,
      offeringRecord.annual?.priceString,
      offeringRecord.lifetime?.priceString,
    ]) {
      if (price) expect(valueText).not.toContain(price);
    }
    expect(pressable(renderer, 'paywall-continue')).toBeNull();
    expect(pressable(renderer, 'paywall-restore')).toBeNull();

    await press(renderer, 'paywall-see-plans');
    const pricingText = renderedText(renderer).join('\n');
    const labels = allLabels(renderer).join('\n');
    if (offering.monthly) {
      expect(pricingText).toContain(offering.monthly.product.priceString);
    }
    if (offering.annual) {
      expect(pricingText).toContain(offering.annual.product.priceString);
      if (offering.annual.product.pricePerMonthString) {
        expect(pricingText).toContain(
          `${offering.annual.product.pricePerMonthString}/mo · billed yearly`,
        );
      }
      expect(labels).toContain(
        `Yearly membership, ${offering.annual.product.priceString} per year, selected`,
      );
    }
    if (offering.lifetime) {
      expect(pricingText).toContain(offering.lifetime.product.priceString);
    }
    expect(world.sdk.storeKitAuth).toEqual([]);
    assertGlobalInvariants(world, renderer, offering);
    recordScenario(
      'J1',
      'presentation + store-returned prices',
      world,
      renderer,
      {
        seed: prng.seed,
        inputs: { offering: offeringRecord },
      },
    );
  });

  it('with no current offering the pricing page says so honestly — no invented price, Continue disabled, Restore still available', async () => {
    const world = makeWorld({ offering: null });
    const renderer = renderPaywall(world);
    await flush();
    expect(useAccessStore.getState().status).toBe('error');
    await press(renderer, 'paywall-see-plans');
    const text = renderedText(renderer).join('\n');
    expect(text).toContain('Store pricing is unavailable');
    expect(text).toContain('Store pricing unavailable');
    for (const literal of TARGET_PRICE_LITERALS) {
      expect(text).not.toContain(literal);
    }
    expect(isDisabled(renderer, 'paywall-continue')).toBe(true);
    expect(isDisabled(renderer, 'paywall-restore')).toBe(false);
    expect(pressable(renderer, 'paywall-retry')).not.toBeNull();
    // Access still verified server-side even though the store failed.
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    assertGlobalInvariants(world, renderer, null);
    recordScenario(
      'J1b',
      'no offering → honest unavailable state',
      world,
      renderer,
      {
        inputs: { offering: null },
      },
    );
  });
});

// ─── J2: purchase success ────────────────────────────────────────────────────

describe('J2 purchase success', () => {
  it.each([
    ['annual', 'pickle_sensei_pro'],
    ['monthly', 'pickle_sensei_pro'],
    ['lifetime', 'pickle_sensei_pro'],
    ['annual', 'premium'],
  ] as const)(
    'Continue on %s (entitlement %s) → exactly one purchasePackage → sync premium → onPurchased → Settings says Pro active',
    async (period, entitlementId) => {
      const world = makeWorld();
      world.sdk.purchaseQueue.push({ kind: 'success', entitlementId });
      const renderer = await openPricingPage(world);
      if (period !== 'annual') await press(renderer, `paywall-plan-${period}`);
      expect(useAccessStore.getState().selectedPeriod).toBe(period);
      expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
      const syncCallsBefore = world.backend.callsTo('sync').length;
      expect(syncCallsBefore).toBe(0);

      await press(renderer, 'paywall-continue');

      expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
        'purchasePackage',
      ]);
      const purchased = world.sdk.calls.find(c => c.api === 'purchasePackage');
      expect((purchased?.args as { packageType: string }).packageType).toBe(
        period.toUpperCase(),
      );
      expect(world.backend.callsTo('sync').map(c => c.outcome)).toEqual([
        '200 premium=true',
      ]);
      expect(world.backend.callsTo('sync')[0]!.bearer).toBe(
        world.token.current,
      );
      const state = useAccessStore.getState();
      expect(state.canonicalAccess?.premium).toBe(true);
      expect(state.canonicalAccess?.canStartRating).toBe(true);
      expect(state.canonicalAccess?.paywallRequired).toBe(false);
      expect(state.operation).toBe('idle');
      expect(state.error).toBeNull();
      expect(world.onPurchased).toHaveBeenCalledTimes(1);
      expect(renderedText(renderer).join('\n')).toContain(
        'MEMBERSHIP VERIFIED',
      );
      // The persisted verdict is what a later GET /v1/me/access reads.
      expect(
        world.backend.persistedVerdicts.get(CANONICAL_USER_A)?.premium,
      ).toBe(true);

      const settings = renderSettings();
      await flush();
      expect(membershipValue(settings)).toBe('Pro active');
      expect(world.backend.callsTo('access').length).toBeGreaterThanOrEqual(2);
      assertGlobalInvariants(world, renderer, world.sdk.offering);
      recordScenario(
        `J2-${period}-${entitlementId}`,
        'purchase success',
        world,
        renderer,
        {
          inputs: { period, entitlementId },
        },
      );
    },
  );
});

// ─── J3: purchase cancelled ──────────────────────────────────────────────────

describe('J3 purchase cancelled', () => {
  it.each(['both', 'userCancelled_only', 'code_only'] as const)(
    'cancel shape %s → no error card, no sync, access unchanged, Continue re-enabled',
    async shape => {
      const world = makeWorld({ ledger: { used: 1, reserved: 0 } });
      world.sdk.purchaseQueue.push({ kind: 'cancel', shape });
      const renderer = await openPricingPage(world);
      const before = useAccessStore.getState().canonicalAccess;

      await press(renderer, 'paywall-continue');

      expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
        'purchasePackage',
      ]);
      expect(world.backend.callsTo('sync')).toEqual([]);
      const state = useAccessStore.getState();
      expect(state.operation).toBe('idle');
      expect(state.error).toBeNull();
      expect(state.canonicalAccess).toEqual(before);
      expect(state.canonicalAccess?.premium).toBe(false);
      expect(world.onPurchased).not.toHaveBeenCalled();
      expect(
        pressableByLabel(renderer, 'Dismiss membership message'),
      ).toBeNull();
      expect(isDisabled(renderer, 'paywall-continue')).toBe(false);
      expect(renderedText(renderer).join('\n')).not.toContain(
        'MEMBERSHIP VERIFIED',
      );

      const settings = renderSettings();
      await flush();
      expect(membershipValue(settings)).toBe('1 free rating left');
      assertGlobalInvariants(world, renderer, world.sdk.offering);
      recordScenario(`J3-${shape}`, 'purchase cancelled', world, renderer, {
        inputs: { shape },
      });
    },
  );
});

// ─── J4: purchase errors ─────────────────────────────────────────────────────

const PURCHASE_ERROR_MATRIX: Array<{
  label: string;
  outcome: PurchaseOutcome;
}> = [
  {
    label: 'STORE_PROBLEM_ERROR',
    outcome: { kind: 'error', error: 'STORE_PROBLEM_ERROR' },
  },
  {
    label: 'NETWORK_ERROR',
    outcome: { kind: 'error', error: 'NETWORK_ERROR' },
  },
  {
    label: 'OFFLINE_CONNECTION_ERROR',
    outcome: { kind: 'error', error: 'OFFLINE_CONNECTION_ERROR' },
  },
  {
    label: 'PAYMENT_PENDING_ERROR',
    outcome: { kind: 'error', error: 'PAYMENT_PENDING_ERROR' },
  },
  {
    label: 'PRODUCT_ALREADY_PURCHASED_ERROR',
    outcome: { kind: 'error', error: 'PRODUCT_ALREADY_PURCHASED_ERROR' },
  },
  {
    label: 'PURCHASE_NOT_ALLOWED_ERROR',
    outcome: { kind: 'error', error: 'PURCHASE_NOT_ALLOWED_ERROR' },
  },
  {
    label: 'PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR',
    outcome: {
      kind: 'error',
      error: 'PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR',
    },
  },
  {
    label: 'RECEIPT_IN_USE_BY_OTHER_SUBSCRIBER_ERROR',
    outcome: {
      kind: 'error',
      error: 'RECEIPT_IN_USE_BY_OTHER_SUBSCRIBER_ERROR',
    },
  },
  {
    label: 'OPERATION_ALREADY_IN_PROGRESS_ERROR',
    outcome: { kind: 'error', error: 'OPERATION_ALREADY_IN_PROGRESS_ERROR' },
  },
  {
    label: 'UNKNOWN_ERROR',
    outcome: { kind: 'error', error: 'UNKNOWN_ERROR' },
  },
  { label: 'reject_string', outcome: { kind: 'reject_string', value: 'boom' } },
  { label: 'reject_null', outcome: { kind: 'reject_null' } },
];

describe('J4 purchase error', () => {
  it.each(PURCHASE_ERROR_MATRIX)(
    '$label → retryable error card, no sync, not premium, onPurchased not called',
    async ({ label, outcome }) => {
      const world = makeWorld();
      world.sdk.purchaseQueue.push(outcome);
      const renderer = await openPricingPage(world);

      await press(renderer, 'paywall-continue');

      expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
        'purchasePackage',
      ]);
      expect(world.backend.callsTo('sync')).toEqual([]);
      const state = useAccessStore.getState();
      expect(state.operation).toBe('idle');
      expect(state.error).toEqual({
        code: 'billing.purchase_failed',
        message:
          'The app store could not complete the purchase. Please try again.',
        retryable: true,
      });
      expect(state.canonicalAccess?.premium).toBe(false);
      expect(world.onPurchased).not.toHaveBeenCalled();
      const card = pressableByLabel(renderer, 'Dismiss membership message');
      expect(card).not.toBeNull();
      expect(card!.props.accessibilityHint).toBe(state.error!.message);
      expect(isDisabled(renderer, 'paywall-continue')).toBe(false);

      // Dismissing the message is not a StoreKit action.
      await act(async () => card!.props.onPress());
      await flush();
      expect(useAccessStore.getState().error).toBeNull();
      expect(world.sdk.storeKitAuth).toHaveLength(1);
      assertGlobalInvariants(world, renderer, world.sdk.offering);
      recordScenario(`J4-${label}`, 'purchase error', world, renderer, {
        inputs: { outcome },
        notes: [
          `RC code ${label} is shown as "${state.error!.message}" (same copy for every non-cancel code)`,
        ],
      });
    },
  );
});

// ─── J5/J6: purchase succeeded at the store, verification not (yet) premium ──

describe('J5 store success but backend verification pending', () => {
  it('RevenueCat backend lag (sync says premium:false) → pending message, access stays free, Settings not Pro', async () => {
    const world = makeWorld({ ledger: { used: 2, reserved: 0 } });
    world.sdk.purchaseQueue.push({ kind: 'success', rcBackendLag: true });
    const renderer = await openPricingPage(world);

    await press(renderer, 'paywall-continue');

    expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual(['purchasePackage']);
    expect(world.backend.callsTo('sync').map(c => c.outcome)).toEqual([
      '200 premium=false',
    ]);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(false);
    expect(state.status).toBe('error');
    expect(state.error).toEqual({
      code: 'billing.backend_verification_pending',
      message:
        'The store completed your purchase, but membership verification is still pending. Try Restore purchases.',
      retryable: true,
    });
    expect(world.onPurchased).not.toHaveBeenCalled();
    expect(renderedText(renderer).join('\n')).not.toContain(
      'MEMBERSHIP VERIFIED',
    );
    // The SDK DID report the entitlement locally — proves local state never unlocks.
    expect(world.sdk.storeAccount['pickle_sensei_pro']).toBeDefined();

    const settings = renderSettings();
    await flush();
    expect(membershipValue(settings)).toBe('Upgrade required');

    // Once RC's backend catches up, the explicit Restore verifies it.
    world.backend.rcSubscribers.set(CANONICAL_USER_A, {
      ...world.sdk.storeAccount,
    });
    await press(renderer, 'paywall-restore');
    expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
      'purchasePackage',
      'restorePurchases',
    ]);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(world.onPurchased).toHaveBeenCalledTimes(1);
    assertGlobalInvariants(world, renderer, world.sdk.offering);
    recordScenario(
      'J5',
      'RC backend lag → pending → restore verifies',
      world,
      renderer,
      {
        inputs: { purchase: 'success rcBackendLag', ledger: { used: 2 } },
      },
    );
  });

  it.each([
    ['502', { kind: 'status', status: 502 } as const],
    ['503', { kind: 'status', status: 503 } as const],
    ['network', { kind: 'network' } as const],
    ['malformed', { kind: 'malformed' } as const],
    ['inconsistent_premium', { kind: 'inconsistent_premium' } as const],
    ['bad_arithmetic', { kind: 'bad_arithmetic' } as const],
  ])(
    'sync fault %s after a store success → pending message, access fails closed (null), Continue disabled, Restore + Try again offered',
    async (label, fault) => {
      const world = makeWorld();
      world.backend.fault('sync', fault);
      const renderer = await openPricingPage(world);

      await press(renderer, 'paywall-continue');

      expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
        'purchasePackage',
      ]);
      const state = useAccessStore.getState();
      expect(state.canonicalAccess).toBeNull();
      expect(state.error?.code).toBe('billing.backend_verification_pending');
      expect(state.error?.message).toContain('Try Restore purchases');
      expect(world.onPurchased).not.toHaveBeenCalled();
      expect(isDisabled(renderer, 'paywall-continue')).toBe(true);
      expect(isDisabled(renderer, 'paywall-restore')).toBe(false);
      expect(pressable(renderer, 'paywall-retry')).not.toBeNull();

      // Recovery path A: Restore purchases (second explicit StoreKit action).
      await press(renderer, 'paywall-restore');
      expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
        'purchasePackage',
        'restorePurchases',
      ]);
      expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
      expect(world.onPurchased).toHaveBeenCalledTimes(1);
      assertGlobalInvariants(world, renderer, world.sdk.offering);
      recordScenario(
        `J6-${label}`,
        'sync fault after store success',
        world,
        renderer,
        {
          inputs: { fault },
        },
      );
    },
  );

  it('sync 401 after a store success → pending message and the expired-session path (no retry loop)', async () => {
    const world = makeWorld();
    const renderer = await openPricingPage(world);
    // Bearer rotates away and the server no longer knows it.
    world.token.current = 'bearer-revoked';
    await press(renderer, 'paywall-continue');
    expect(world.backend.callsTo('sync').map(c => c.outcome)).toEqual(['401']);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(world.onPurchased).not.toHaveBeenCalled();
    assertGlobalInvariants(world, renderer, world.sdk.offering);
    recordScenario('J6-401', 'sync 401 after store success', world, renderer, {
      inputs: { bearer: 'revoked before sync' },
    });
  });
});

// ─── J7/J8/J9: restore ───────────────────────────────────────────────────────

describe('J7 restore purchases', () => {
  it('store account already holds the entitlement → one restorePurchases → sync premium → onPurchased → Settings Pro active', async () => {
    const world = makeWorld({ ledger: { used: 2, reserved: 0 } });
    world.sdk.storeAccount['pickle_sensei_pro'] = {
      productIdentifier: 'pickle_sensei_pro_yearly',
      expirationDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
    const renderer = await openPricingPage(world);
    expect(useAccessStore.getState().canonicalAccess?.paywallRequired).toBe(
      true,
    );

    await press(renderer, 'paywall-restore');

    expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
      'restorePurchases',
    ]);
    expect(world.backend.callsTo('sync').map(c => c.outcome)).toEqual([
      '200 premium=true',
    ]);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(true);
    expect(state.error).toBeNull();
    expect(world.onPurchased).toHaveBeenCalledTimes(1);

    const settings = renderSettings();
    await flush();
    expect(membershipValue(settings)).toBe('Pro active');
    assertGlobalInvariants(world, renderer, world.sdk.offering);
    recordScenario('J7', 'restore success', world, renderer, {
      inputs: { storeAccount: world.sdk.storeAccount },
    });
  });

  it('J8 nothing to restore → non-retryable "No active Pickle Sensei membership" message, access re-synced, not premium', async () => {
    const world = makeWorld({ ledger: { used: 1, reserved: 0 } });
    const renderer = await openPricingPage(world);

    await press(renderer, 'paywall-restore');

    expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
      'restorePurchases',
    ]);
    expect(world.backend.callsTo('sync').map(c => c.outcome)).toEqual([
      '200 premium=false',
    ]);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(false);
    expect(state.status).toBe('ready');
    expect(state.error).toEqual({
      code: 'billing.restore_failed',
      message:
        'No active Pickle Sensei membership was found for this store account.',
      retryable: false,
    });
    expect(world.onPurchased).not.toHaveBeenCalled();
    expect(
      pressableByLabel(renderer, 'Dismiss membership message'),
    ).not.toBeNull();

    const settings = renderSettings();
    await flush();
    expect(membershipValue(settings)).toBe('1 free rating left');
    assertGlobalInvariants(world, renderer, world.sdk.offering);
    recordScenario('J8', 'restore finds nothing', world, renderer, {
      inputs: { storeAccount: {} },
    });
  });

  it('J8b expired store entitlement → restore finds nothing active → not premium', async () => {
    const world = makeWorld();
    world.sdk.storeAccount['pickle_sensei_pro'] = {
      productIdentifier: 'pickle_sensei_pro_monthly',
      expirationDate: new Date(Date.now() - 60_000).toISOString(),
    };
    const renderer = await openPricingPage(world);
    await press(renderer, 'paywall-restore');
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.restore_failed',
    );
    expect(world.onPurchased).not.toHaveBeenCalled();
    assertGlobalInvariants(world, renderer, world.sdk.offering);
    recordScenario('J8b', 'restore with expired entitlement', world, renderer, {
      inputs: { storeAccount: world.sdk.storeAccount },
    });
  });

  const RESTORE_FAULTS: Array<{ label: string; outcome: RestoreOutcome }> = [
    {
      label: 'STORE_PROBLEM_ERROR',
      outcome: { kind: 'error', error: 'STORE_PROBLEM_ERROR' },
    },
    {
      label: 'NETWORK_ERROR',
      outcome: { kind: 'error', error: 'NETWORK_ERROR' },
    },
    {
      label: 'MISSING_RECEIPT_FILE_ERROR',
      outcome: { kind: 'error', error: 'MISSING_RECEIPT_FILE_ERROR' },
    },
    {
      label: 'RECEIPT_ALREADY_IN_USE_ERROR',
      outcome: { kind: 'error', error: 'RECEIPT_ALREADY_IN_USE_ERROR' },
    },
    { label: 'cancel', outcome: { kind: 'cancel' } },
    {
      label: 'reject_string',
      outcome: { kind: 'reject_string', value: 'boom' },
    },
  ];

  it.each(RESTORE_FAULTS)(
    'J9 restore fault $label → retryable "could not restore" message, no sync, access unchanged',
    async ({ label, outcome }) => {
      const world = makeWorld();
      world.sdk.restoreQueue.push(outcome);
      const renderer = await openPricingPage(world);
      const before = useAccessStore.getState().canonicalAccess;

      await press(renderer, 'paywall-restore');

      expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
        'restorePurchases',
      ]);
      expect(world.backend.callsTo('sync')).toEqual([]);
      const state = useAccessStore.getState();
      expect(state.error).toEqual({
        code: 'billing.restore_failed',
        message: 'The app store could not restore purchases. Please try again.',
        retryable: true,
      });
      expect(state.canonicalAccess).toEqual(before);
      expect(world.onPurchased).not.toHaveBeenCalled();
      assertGlobalInvariants(world, renderer, world.sdk.offering);
      recordScenario(`J9-${label}`, 'restore fault', world, renderer, {
        inputs: { outcome },
        notes:
          label === 'cancel'
            ? [
                'A user-cancelled restore (RC code 1 / userCancelled) is shown as a retryable error card; a user-cancelled PURCHASE shows nothing. Whether RC surfaces code 1 on a cancelled restore sheet on-device is UNKNOWN from Linux.',
              ]
            : [],
      });
    },
  );

  it('J9b restore sync outage → "could not be verified yet", access fails closed, Retry offered', async () => {
    const world = makeWorld();
    world.sdk.storeAccount['pickle_sensei_pro'] = {
      productIdentifier: 'pickle_sensei_pro_lifetime',
      expirationDate: null,
    };
    world.backend.fault('sync', { kind: 'status', status: 502 });
    const renderer = await openPricingPage(world);
    await press(renderer, 'paywall-restore');
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.error).toEqual({
      code: 'billing.backend_verification_pending',
      message:
        'Restored purchases could not be verified yet. Please try again.',
      retryable: true,
    });
    expect(world.onPurchased).not.toHaveBeenCalled();
    expect(pressable(renderer, 'paywall-retry')).not.toBeNull();
    // "Try again" is NOT a StoreKit action; it re-reads server + offerings.
    await press(renderer, 'paywall-retry');
    expect(world.sdk.storeKitAuth).toHaveLength(1);
    // The webhook/persisted verdict is what GET /v1/me/access reads; here the
    // 502 happened before persistence, so access stays free until restore.
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    await press(renderer, 'paywall-restore');
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(world.onPurchased).toHaveBeenCalledTimes(1);
    assertGlobalInvariants(world, renderer, world.sdk.offering);
    recordScenario('J9b', 'restore sync outage then retry', world, renderer, {
      inputs: { fault: '502 on first sync' },
    });
  });
});

// ─── J10: StoreKit-auth surface ──────────────────────────────────────────────

describe('J10 only two controls reach StoreKit auth', () => {
  it('pressing every non-StoreKit control on both pages leaves the ledger empty; only Continue and Restore append', async () => {
    const world = makeWorld();
    // Start with the store down so "Try again" is a real control to press.
    world.sdk.offeringsFault = 'NETWORK_ERROR';
    const renderer = renderPaywall(world);
    await flush();

    const pressed: string[] = [];
    const pressLabel = async (label: string) => {
      const node = pressableByLabel(renderer, label);
      expect(node).not.toBeNull();
      await act(async () => node!.props.onPress());
      await flush();
      pressed.push(label);
      expect(world.sdk.storeKitAuth).toEqual([]);
    };
    const pressId = async (id: string) => {
      await press(renderer, id);
      pressed.push(id);
      expect(world.sdk.storeKitAuth).toEqual([]);
    };

    // Value page.
    await pressLabel('Close membership offer');
    expect(world.onClose).toHaveBeenCalledTimes(1);
    await pressId('paywall-see-plans');
    // Pricing page while the store is down: Try again + Restore + (disabled) Continue.
    expect(isDisabled(renderer, 'paywall-continue')).toBe(true);
    world.sdk.offeringsFault = null;
    await pressId('paywall-retry');
    expect(useAccessStore.getState().plans).not.toBeNull();
    expect(world.sdk.calls.filter(c => c.api === 'getOfferings').length).toBe(
      2,
    );
    // Back to value page and forward again.
    await pressId('paywall-back');
    expect(pressable(renderer, 'paywall-continue')).toBeNull();
    await pressId('paywall-see-plans');

    // Every testID'd control on the pricing page except the two allowed
    // (and back, already exercised).
    const pricingIds = new Set(
      renderer.root
        .findAll(
          node =>
            typeof node.props.testID === 'string' &&
            typeof node.props.onPress === 'function',
        )
        .map(node => String(node.props.testID)),
    );
    for (const id of STOREKIT_BUTTON_TEST_IDS)
      expect(pricingIds.has(id)).toBe(true);
    const others = [...pricingIds].filter(
      id => !(STOREKIT_BUTTON_TEST_IDS as readonly string[]).includes(id),
    );
    expect(others.sort()).toEqual(
      [
        'paywall-back',
        'paywall-plan-annual',
        'paywall-plan-lifetime',
        'paywall-plan-monthly',
      ].sort(),
    );
    let lastPlan: string | null = null;
    for (const id of others) {
      expect(NON_STOREKIT_BUTTON_TEST_IDS as readonly string[]).toContain(id);
      if (id === 'paywall-back') continue;
      await pressId(id);
      lastPlan = id.replace('paywall-plan-', '');
    }
    expect(useAccessStore.getState().selectedPeriod).toBe(lastPlan);
    await pressId('paywall-plan-annual');
    // Labelled (non-testID) controls on the pricing page.
    await pressLabel('Close membership offer');
    // Every pressable on the pricing page is accounted for.
    const allPressables = renderer.root.findAll(
      node => typeof node.props.onPress === 'function',
    );
    expect(allPressables.length).toBeGreaterThan(0);
    // A wrapper component (e.g. PlanCard) forwards the SAME onPress to a
    // labelled descendant; it is accounted for through that descendant.
    const keyOf = (node: TestRenderer.ReactTestInstance): string => {
      const own = node.props.testID ?? node.props.accessibilityLabel;
      if (own !== undefined) return String(own);
      const labelled = node.findAll(
        child =>
          child !== node &&
          child.props.onPress === node.props.onPress &&
          (child.props.testID !== undefined ||
            child.props.accessibilityLabel !== undefined),
      );
      const first = labelled[0];
      return first
        ? String(first.props.testID ?? first.props.accessibilityLabel)
        : '<unlabelled>';
    };
    const unaccounted = [...new Set(allPressables.map(keyOf))].filter(
      key => !pricingIds.has(key) && key !== 'Close membership offer',
    );
    expect(unaccounted).toEqual([]);
    expect(world.sdk.storeKitAuth).toEqual([]);

    // Now the two allowed controls, each exactly once.
    world.sdk.purchaseQueue.push({ kind: 'cancel', shape: 'both' });
    await press(renderer, 'paywall-continue');
    expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual(['purchasePackage']);
    world.sdk.restoreQueue.push({
      kind: 'error',
      error: 'STORE_PROBLEM_ERROR',
    });
    await press(renderer, 'paywall-restore');
    expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual([
      'purchasePackage',
      'restorePurchases',
    ]);
    // Dismissing the error card is not a StoreKit action either.
    await pressLabel('Dismiss membership message').catch(() => undefined);
    expect(world.sdk.storeKitAuth).toHaveLength(2);
    assertGlobalInvariants(world, renderer, world.sdk.offering);
    recordScenario('J10', 'StoreKit-auth surface', world, renderer, {
      inputs: { pressed, pricingControls: [...pricingIds] },
    });
  });

  it('a second Continue tap while purchasing is ignored by the store guard and the button is disabled', async () => {
    const world = makeWorld();
    let release!: (outcome: PurchaseOutcome) => void;
    world.sdk.purchaseQueue.push({
      kind: 'await',
      gate: new Promise<PurchaseOutcome>(resolve => {
        release = resolve;
      }),
    });
    const renderer = await openPricingPage(world);
    const first = pressable(renderer, 'paywall-continue')!;
    await act(async () => first.props.onPress());
    await flush();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(isDisabled(renderer, 'paywall-continue')).toBe(true);
    expect(isDisabled(renderer, 'paywall-restore')).toBe(true);
    // Simulate a double-tap that beat the disabled re-render.
    let secondResult: boolean | null = null;
    let restoreResult: boolean | null = null;
    await act(async () => {
      secondResult = await useAccessStore.getState().purchaseSelected();
      restoreResult = await useAccessStore.getState().restorePurchases();
    });
    expect(secondResult).toBe(false);
    expect(restoreResult).toBe(false);
    expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual(['purchasePackage']);
    release({ kind: 'success' });
    await flush();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(world.onPurchased).toHaveBeenCalledTimes(1);
    expect(world.sdk.storeKitAuth).toHaveLength(1);
    assertGlobalInvariants(world, renderer, world.sdk.offering);
    recordScenario('J11', 'double tap guard', world, renderer, { inputs: {} });
  });
});

// ─── J12: account switch while StoreKit is open ──────────────────────────────

describe('J12 sign-out / account switch mid-purchase', () => {
  it('a purchase that completes after sign-out never syncs, never unlocks, never calls onPurchased', async () => {
    const world = makeWorld();
    let release!: (outcome: PurchaseOutcome) => void;
    world.sdk.purchaseQueue.push({
      kind: 'await',
      gate: new Promise<PurchaseOutcome>(resolve => {
        release = resolve;
      }),
    });
    const renderer = await openPricingPage(world);
    await act(async () =>
      pressable(renderer, 'paywall-continue')!.props.onPress(),
    );
    await flush();
    expect(useAccessStore.getState().operation).toBe('purchasing');

    // Sign-out: RootNavigator unmounts the paywall and the auth flow clears
    // the store configuration; StoreKit's sheet resolves afterwards.
    act(() => renderer.unmount());
    mounted = mounted.filter(r => r !== renderer);
    clearAccessStoreConfiguration();
    release({ kind: 'success' });
    await flush();

    const state = useAccessStore.getState();
    expect(state.status).toBe('idle');
    expect(state.operation).toBe('idle');
    expect(state.canonicalAccess).toBeNull();
    expect(world.backend.callsTo('sync')).toEqual([]);
    expect(world.onPurchased).not.toHaveBeenCalled();
    recordScenario(
      'J12-signout',
      'purchase completes after sign-out',
      world,
      null,
      {
        inputs: {},
      },
    );
  });

  it('a purchase that completes after another account signed in never lands on the new account', async () => {
    const worldA = makeWorld();
    let release!: (outcome: PurchaseOutcome) => void;
    worldA.sdk.purchaseQueue.push({
      kind: 'await',
      gate: new Promise<PurchaseOutcome>(resolve => {
        release = resolve;
      }),
    });
    const renderer = await openPricingPage(worldA);
    await act(async () =>
      pressable(renderer, 'paywall-continue')!.props.onPress(),
    );
    await flush();

    // Account B signs in (new backend, new dependencies) while A's sheet is up.
    const backendB = new FakeAccessBackend(API_BASE_URL);
    backendB.bearers.set('bearer-B', CANONICAL_USER_B);
    backendB.ledgers.set(CANONICAL_USER_B, { used: 0, reserved: 0 });
    configureAccessStore(
      createBillingAccessDependencies({
        revenueCatPublicSdkKey: PUBLIC_SDK_KEY,
        canonicalAppUserId: CANONICAL_USER_B,
        apiBaseUrl: API_BASE_URL,
        apiToken: 'bearer-B',
        fetchFn: backendB.fetch,
        revenueCatSdk: mockedSdk,
        platform: 'ios',
      }),
    );
    await act(async () => useAccessStore.getState().initialize());
    await flush();
    release({ kind: 'success' });
    await flush();

    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(false);
    expect(worldA.backend.callsTo('sync')).toEqual([]);
    expect(backendB.callsTo('sync')).toEqual([]);
    expect(worldA.onPurchased).not.toHaveBeenCalled();
    expect(worldA.sdk.storeKitAuth.map(e => e.appUserID)).toEqual([
      CANONICAL_USER_A,
    ]);
    recordScenario(
      'J12-switch',
      'purchase completes after account switch',
      worldA,
      null,
      {
        inputs: { userB: CANONICAL_USER_B },
      },
    );
  });
});

// ─── J13: bearer rotation ────────────────────────────────────────────────────

describe('J13 rotating bearer', () => {
  it('sync after a token rotation uses the CURRENT bearer, never the one captured at configure', async () => {
    const world = makeWorld();
    const renderer = await openPricingPage(world);
    const original = world.token.current!;
    world.backend.bearers.delete(original);
    world.token.current = 'bearer-rotated-2';
    world.backend.bearers.set('bearer-rotated-2', CANONICAL_USER_A);

    await press(renderer, 'paywall-continue');

    expect(world.backend.callsTo('sync').map(c => c.bearer)).toEqual([
      'bearer-rotated-2',
    ]);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    assertGlobalInvariants(world, renderer, world.sdk.offering);
    recordScenario('J13', 'bearer rotation', world, renderer, {
      inputs: { original: 'rotated away', current: 'bearer-rotated-2' },
    });
  });
});

// ─── J14: Settings membership row wording matrix ─────────────────────────────

describe('J14 Settings membership row wording', () => {
  it.each([
    ['premium', { used: 2, reserved: 0 }, true, 'Pro active'],
    ['fresh', { used: 0, reserved: 0 }, false, '2 free ratings left'],
    ['one used', { used: 1, reserved: 0 }, false, '1 free rating left'],
    [
      'one used one reserved',
      { used: 1, reserved: 1 },
      false,
      'Upgrade required',
    ],
    ['both used', { used: 2, reserved: 0 }, false, 'Upgrade required'],
    [
      'none used one reserved',
      { used: 0, reserved: 1 },
      false,
      '1 free rating left',
    ],
  ] as const)('%s → "%s"', async (label, ledger, premium, expected) => {
    const world = makeWorld({ ledger: { ...ledger } });
    if (premium) {
      world.backend.rcSubscribers.set(CANONICAL_USER_A, {
        pickle_sensei_pro: {
          productIdentifier: 'pickle_sensei_pro_yearly',
          expirationDate: null,
        },
      });
      world.backend.persistedVerdicts.set(CANONICAL_USER_A, {
        premium: true,
        productKey: 'pickle_sensei_pro_yearly',
        expiresAt: null,
        verifiedAt: world.backend.now(),
      });
    }
    const settings = renderSettings();
    await flush();
    expect(membershipValue(settings)).toBe(expected);
    expect(world.sdk.storeKitAuth).toEqual([]);
    expect(world.backend.callsTo('access')).toHaveLength(1);
    expect(
      forbiddenCopyExceptKnownDisclaimer([
        ...renderedText(settings),
        ...allLabels(settings),
      ]),
    ).toEqual([]);
    recordScenario(`J14-${label}`, 'settings wording', world, settings, {
      inputs: { ledger, premium },
    });
  });

  it('server outage on focus → "Verify access" (fails closed) and the paywall Continue is disabled until access is re-verified', async () => {
    const world = makeWorld();
    world.backend.fault('access', { kind: 'status', status: 503 });
    const settings = renderSettings();
    await flush();
    expect(membershipValue(settings)).toBe('Verify access');
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    const renderer = renderPaywall(world);
    await flush();
    await press(renderer, 'paywall-see-plans');
    // status was 'error' (not idle) so the paywall did not re-initialize:
    // plans are still null → Try again is the recovery.
    expect(pressable(renderer, 'paywall-retry')).not.toBeNull();
    await press(renderer, 'paywall-retry');
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    expect(isDisabled(renderer, 'paywall-continue')).toBe(false);
    expect(world.sdk.storeKitAuth).toEqual([]);
    recordScenario(
      'J14-outage',
      'settings outage then paywall retry',
      world,
      renderer,
      {
        inputs: { fault: '503 on GET /v1/me/access' },
      },
    );
  });

  it('local-only guest: no server call, row says "Sign in first"', async () => {
    const world = makeWorld();
    useAuthStore.setState({
      session: {
        provider: 'guest',
        subject: 'local-only',
        canonicalAppUserId: null,
        localOnly: true,
        displayName: null,
        email: null,
      },
    });
    const settings = renderSettings();
    await flush();
    expect(membershipValue(settings)).toBe('Sign in first');
    expect(world.backend.calls).toEqual([]);
    expect(world.sdk.calls).toEqual([]);
    recordScenario('J14-guest', 'guest row', world, settings, { inputs: {} });
  });
});

// ─── J15: Paywall opened after (or during) a Settings access refresh ─────────

// FINDING XC-PPR-01 (P2): PaywallScreen only calls initialize() when
// `status === 'idle'` (PaywallScreen.tsx:263-265), and nothing else ever
// loads offerings. SettingsScreen's focus refresh (`refreshAccess`) moves the
// store to 'loading' → 'ready' WITHOUT loading plans. Any user whose first
// server access read came from Settings (or any other refreshAccess caller)
// therefore opens the paywall — from the Settings membership row, or later
// via `useRatingRouteGate` once their free ratings run out — with
// `plans === null` and no initialize: the pricing page renders "Store pricing
// is unavailable" and Continue is disabled until "Try again" is tapped,
// although the store was never asked for offerings.
//
// `test.failing` keeps the EXPECTED behaviour as the assertion: these tests
// start passing (and must be un-marked) once the paywall also initializes on
// `plans === null`.
describe('J15 paywall opened after / during a Settings access refresh', () => {
  test.failing(
    'deterministic: Settings refresh landed (status ready, plans null) → paywall should load store pricing on mount',
    async () => {
      const world = makeWorld();
      renderSettings();
      await flush();
      expect(useAccessStore.getState().status).toBe('ready');
      expect(useAccessStore.getState().plans).toBeNull();

      const renderer = renderPaywall(world);
      await flush();
      await press(renderer, 'paywall-see-plans');
      const observed = {
        plans: useAccessStore.getState().plans !== null,
        getOfferingsCalls: world.sdk.calls.filter(c => c.api === 'getOfferings')
          .length,
        showsUnavailable: renderedText(renderer)
          .join('\n')
          .includes('Store pricing is unavailable'),
        continueDisabled: isDisabled(renderer, 'paywall-continue'),
        continueLabel: pressable(renderer, 'paywall-continue')?.props
          .accessibilityLabel,
      };
      recordScenario(
        'J15-after-refresh',
        'paywall opened after Settings refresh landed',
        world,
        renderer,
        {
          inputs: {
            order: [
              'SettingsScreen mount (refreshAccess)',
              'PaywallScreen mount',
              'See membership plans',
            ],
          },
          verdict: observed.plans ? 'passed' : 'documented_failure',
          notes: [
            `getOfferings calls: ${observed.getOfferingsCalls}`,
            `plans loaded: ${observed.plans}`,
            `shows "Store pricing is unavailable": ${observed.showsUnavailable}`,
            `Continue disabled: ${observed.continueDisabled} (label "${String(observed.continueLabel)}")`,
          ],
        },
      );
      expect(observed.getOfferingsCalls).toBeGreaterThan(0);
      expect(observed.plans).toBe(true);
      expect(observed.showsUnavailable).toBe(false);
    },
  );

  test.failing(
    'race: paywall mounts while the Settings refresh is still in flight → should still load store pricing',
    async () => {
      const world = makeWorld();
      world.backend.fault('access', { kind: 'delay', ms: 30 });
      renderSettings();
      expect(useAccessStore.getState().status).toBe('loading');
      const renderer = renderPaywall(world);
      await act(async () => {
        await new Promise<void>(resolve => setTimeout(() => resolve(), 60));
      });
      await flush();
      expect(useAccessStore.getState().status).toBe('ready');
      await press(renderer, 'paywall-see-plans');
      const observed = {
        plans: useAccessStore.getState().plans !== null,
        getOfferingsCalls: world.sdk.calls.filter(c => c.api === 'getOfferings')
          .length,
        showsUnavailable: renderedText(renderer)
          .join('\n')
          .includes('Store pricing is unavailable'),
      };
      recordScenario(
        'J15-race',
        'paywall mounts during Settings refresh',
        world,
        renderer,
        {
          inputs: { accessDelayMs: 30 },
          verdict: observed.plans ? 'passed' : 'documented_failure',
          notes: [
            `getOfferings calls: ${observed.getOfferingsCalls}`,
            `plans loaded: ${observed.plans}`,
            `shows "Store pricing is unavailable": ${observed.showsUnavailable}`,
          ],
        },
      );
      expect(observed.getOfferingsCalls).toBeGreaterThan(0);
      expect(observed.plans).toBe(true);
    },
  );

  it('recovery: "Try again" loads pricing with no StoreKit auth, and the purchase then completes normally', async () => {
    const world = makeWorld();
    renderSettings();
    await flush();
    const renderer = renderPaywall(world);
    await flush();
    await press(renderer, 'paywall-see-plans');
    // Current behaviour (XC-PPR-01) — pinned so the recovery path is real.
    expect(useAccessStore.getState().plans).toBeNull();
    expect(pressable(renderer, 'paywall-retry')).not.toBeNull();
    await press(renderer, 'paywall-retry');
    expect(useAccessStore.getState().plans).not.toBeNull();
    expect(isDisabled(renderer, 'paywall-continue')).toBe(false);
    expect(world.sdk.storeKitAuth).toEqual([]);
    await press(renderer, 'paywall-continue');
    expect(world.sdk.storeKitAuth.map(e => e.api)).toEqual(['purchasePackage']);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(world.onPurchased).toHaveBeenCalledTimes(1);
    assertGlobalInvariants(world, renderer, world.sdk.offering);
    recordScenario(
      'J15-recovery',
      'Try again recovers pricing, purchase completes',
      world,
      renderer,
      {
        inputs: {},
      },
    );
  });

  it('control: a paywall mounted from an idle store loads pricing on mount', async () => {
    const world = makeWorld();
    const renderer = renderPaywall(world);
    await flush();
    expect(world.sdk.calls.filter(c => c.api === 'getOfferings')).toHaveLength(
      1,
    );
    expect(useAccessStore.getState().plans).not.toBeNull();
    recordScenario(
      'J15-control',
      'paywall from idle loads plans',
      world,
      renderer,
      { inputs: {} },
    );
  });
});

// ─── J16: seeded storefront fuzz through the real screen ─────────────────────

describe('J16 seeded storefront fuzz (real screen)', () => {
  const SEEDS = Array.from({ length: 24 }, (_, i) => 0x5eed0000 + i * 7919);

  it.each(SEEDS)(
    'seed %d: every rendered price is store-returned and the purchase path is unchanged',
    async seed => {
      const prng = new Prng(seed);
      const { offering, record: offeringRecord } = randomOffering(prng);
      const world = makeWorld({ offering });
      const renderer = await openPricingPage(world);
      const text = renderedText(renderer).join('\n');
      const labels = allLabels(renderer).join('\n');
      const state = useAccessStore.getState();
      expect(state.plans).not.toBeNull();
      const expectedSelected = offering.annual
        ? 'annual'
        : offering.lifetime
          ? 'lifetime'
          : 'monthly';
      expect(state.selectedPeriod).toBe(expectedSelected);
      // Every store string present; nothing else that looks like a price.
      const storeStrings = new Set<string>();
      for (const pkg of [
        offering.monthly,
        offering.annual,
        offering.lifetime,
      ]) {
        if (!pkg) continue;
        storeStrings.add(pkg.product.priceString);
        expect(text).toContain(pkg.product.priceString);
        if (pkg.packageType !== 'LIFETIME' && pkg.product.pricePerMonthString) {
          storeStrings.add(pkg.product.pricePerMonthString);
        }
      }
      const priceLike =
        text.match(
          /(?:[$£¥₹₩]|R\$ |CHF )\s?\d[\d,]*(?:[.,]\d{2})?(?: €)?|\d+[.,]\d{2} €/g,
        ) ?? [];
      for (const found of priceLike) {
        expect(
          [...storeStrings].some(
            s => s.includes(found.trim()) || found.trim().includes(s),
          ),
        ).toBe(true);
      }
      // SAVE chip arithmetic follows store numbers only.
      const saveChip = text.match(/SAVE (\d+)%/);
      if (
        offering.annual &&
        offering.monthly &&
        offering.monthly.product.price > 0
      ) {
        const annualAtMonthly = offering.monthly.product.price * 12;
        const expectedPercent = Math.round(
          ((annualAtMonthly - offering.annual.product.price) /
            annualAtMonthly) *
            100,
        );
        if (
          offering.annual.product.price < annualAtMonthly &&
          expectedPercent > 0
        ) {
          expect(saveChip?.[1]).toBe(String(expectedPercent));
        } else {
          expect(saveChip).toBeNull();
        }
      } else {
        expect(saveChip).toBeNull();
      }
      // Trial label only when the store offered an intro period.
      if (offering.annual?.product.introPrice) {
        expect(text).toMatch(/\d+-(day|week|month) free trial/);
        expect(labels).toContain('Start free trial');
      } else {
        expect(text).not.toMatch(/free trial/);
      }
      // Purchase the selected plan: the package handed to StoreKit is the one
      // whose price was displayed.
      const period = prng.pick(
        (['monthly', 'annual', 'lifetime'] as const).filter(p => offering[p]),
      );
      if (period !== expectedSelected)
        await press(renderer, `paywall-plan-${period}`);
      await press(renderer, 'paywall-continue');
      const purchased = world.sdk.calls.find(c => c.api === 'purchasePackage')
        ?.args as
        { product: { identifier: string; priceString: string } } | undefined;
      expect(purchased?.product.identifier).toBe(
        offering[period]!.product.identifier,
      );
      expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
      expect(world.onPurchased).toHaveBeenCalledTimes(1);
      assertGlobalInvariants(world, renderer, offering);
      recordScenario(`J16-${seed}`, 'storefront fuzz', world, renderer, {
        seed,
        inputs: { offering: offeringRecord, purchasedPeriod: period },
      });
    },
  );
});

// ─── J17: offerings faults ───────────────────────────────────────────────────

describe('J17 offerings faults', () => {
  it.each<RcErrorName>([
    'NETWORK_ERROR',
    'CONFIGURATION_ERROR',
    'STORE_PROBLEM_ERROR',
  ])(
    'getOfferings throws %s → honest unavailable state, access still verified, Continue disabled, no StoreKit auth',
    async fault => {
      const world = makeWorld();
      world.sdk.offeringsFault = fault;
      const renderer = renderPaywall(world);
      await flush();
      await press(renderer, 'paywall-see-plans');
      const state = useAccessStore.getState();
      expect(state.plans).toBeNull();
      expect(state.canonicalAccess?.premium).toBe(false);
      expect(state.error?.code).toBe('billing.offerings_unavailable');
      expect(isDisabled(renderer, 'paywall-continue')).toBe(true);
      expect(renderedText(renderer).join('\n')).toContain(
        'Store pricing is unavailable',
      );
      // Retry after the store recovers.
      world.sdk.offeringsFault = null;
      await press(renderer, 'paywall-retry');
      expect(useAccessStore.getState().plans).not.toBeNull();
      expect(isDisabled(renderer, 'paywall-continue')).toBe(false);
      expect(world.sdk.storeKitAuth).toEqual([]);
      assertGlobalInvariants(world, renderer, world.sdk.offering);
      recordScenario(
        `J17-${fault}`,
        'offerings fault then retry',
        world,
        renderer,
        {
          inputs: { fault },
        },
      );
    },
  );

  it('a package of the wrong type is dropped (never mis-priced); the remaining plans still purchase', async () => {
    const world = makeWorld();
    const offering = targetOffering();
    // Store returns a LIFETIME package in the annual slot: must be dropped.
    offering.annual = { ...offering.lifetime!, identifier: '$rc_annual' };
    world.sdk.offering = offering;
    const renderer = await openPricingPage(world);
    const plans = useAccessStore.getState().plans!;
    expect(plans.annual).toBeNull();
    expect(plans.monthly?.priceString).toBe('$7.99');
    expect(plans.lifetime?.priceString).toBe('$159.99');
    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');
    expect(renderedText(renderer).join('\n')).not.toContain('Yearly');
    await press(renderer, 'paywall-continue');
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    recordScenario(
      'J17-wrong-type',
      'wrong package type dropped',
      world,
      renderer,
      {
        inputs: { annualSlot: 'LIFETIME package' },
      },
    );
  });
});
