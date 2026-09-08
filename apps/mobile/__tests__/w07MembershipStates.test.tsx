/**
 * W07-05 — Settings and Paywall state their membership from SERVER truth:
 * pending (a completed store purchase/restore the backend has not confirmed),
 * fulfilled (server-verified premium, with the server's access horizon),
 * grace (the server still grants access past the horizon it last verified),
 * expired (a disposition the server bound to THIS device's own purchase —
 * never a stale snapshot), and HOLD (the durable journal cannot be read, so
 * it is unknown whether a purchase is waiting). Subscribed members reach
 * "Manage subscription", which opens the App Store subscriptions surface;
 * lifetime access has nothing to manage there. No state ever invents an
 * entitlement, a refund, a live server report, or a price.
 */
jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
jest.mock('../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
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
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
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

import React from 'react';
import { Dimensions, Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  APP_STORE_SUBSCRIPTIONS_URL,
  describeMembershipState,
  formatMembershipDate,
  type MembershipStateInput,
} from '../src/billing/membershipState';
import type {
  BillingAccessDependencies,
  BillingFulfilmentRequest,
  CanonicalAccessState,
  CanonicalBillingState,
  CanonicalBillingSync,
  StorePlans,
} from '../src/billing/types';
import {
  createPendingFulfilment,
  type PendingFulfilment,
  type PendingFulfilmentStorage,
} from '../src/billing/pendingFulfilment';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectMembershipState,
  useAccessStore,
} from '../src/state/accessStore';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';
import { useConsentStore } from '../src/state/consentStore';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { PaywallScreen } from '../src/screens/PaywallScreen';

const OWNER = '11111111-1111-4111-8111-111111111111';
const NOW_MS = Date.parse('2026-09-08T12:00:00.000Z');
const FUTURE = '2027-03-01T00:00:00.000Z';
const AFTER_FUTURE_MS = Date.parse('2027-03-02T00:00:00.000Z');
const PAST = '2026-09-01T00:00:00.000Z';
const VERIFIED_AT = '2026-09-08T11:59:00.000Z';

const session: AuthSession = {
  provider: 'apple',
  subject: OWNER,
  canonicalAppUserId: OWNER,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function access(premium: boolean, used = 1): CanonicalAccessState {
  const remaining = 2 - used;
  return {
    premium,
    entitlements: premium ? ['premium'] : [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: premium || remaining > 0,
    paywallRequired: !(premium || remaining > 0),
  };
}

function billing(
  premium: boolean,
  expiresAt: string | null,
  productKey = 'pickle_sensei_pro_annual',
): CanonicalBillingState {
  return {
    premium,
    productKey: premium ? productKey : null,
    expiresAt: premium ? expiresAt : null,
    verifiedAt: VERIFIED_AT,
  };
}

const LIFETIME = 'pickle_sensei_pro_lifetime';

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: null,
  lifetime: null,
};

const transaction = {
  productId: 'pickle_sensei_pro_annual',
  transactionId: '1000000123456789',
  purchasedAt: PAST,
};

interface ServerTruth {
  access: CanonicalAccessState;
  sync?: (request?: BillingFulfilmentRequest) => CanonicalBillingSync;
}

/** Reads `options` on every call, so a test can move server truth forward. */
function dependencies(options: ServerTruth) {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: transaction.productId,
        expirationDate: FUTURE,
        transaction,
      })),
      restore: jest.fn(async () => ({
        premium: true,
        productId: transaction.productId,
        expirationDate: FUTURE,
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(async () => options.access),
      syncBilling: jest.fn(async (request?: BillingFulfilmentRequest) => {
        if (!options.sync) throw new Error('sync not exercised');
        return options.sync(request);
      }),
    },
  } satisfies BillingAccessDependencies;
}

function memoryStorage(seed: PendingFulfilment | null = null) {
  const records = new Map<string, string>();
  if (seed) records.set(seed.owner, JSON.stringify(seed));
  const storage: PendingFulfilmentStorage = {
    read: jest.fn(async owner => {
      const raw = records.get(owner);
      return raw ? (JSON.parse(raw) as PendingFulfilment) : null;
    }),
    write: jest.fn(async (record, assertActive) => {
      assertActive?.();
      records.set(record.owner, JSON.stringify(record));
    }),
    remove: jest.fn(async (record, assertActive) => {
      assertActive?.();
      records.delete(record.owner);
    }),
  };
  return storage;
}

function unreadableStorage(): PendingFulfilmentStorage {
  return {
    read: jest.fn(async () => {
      throw new Error('journal unreadable');
    }),
    write: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
  };
}

function configure(
  clients: BillingAccessDependencies,
  storage: PendingFulfilmentStorage,
) {
  setActiveDataOwner(OWNER);
  configureAccessStore(clients, {
    owner: OWNER,
    pendingFulfilmentStorage: storage,
  });
}

function boundVerdict(
  request: BillingFulfilmentRequest,
  outcome: 'pending' | 'fulfilled' | 'expired' | 'refunded',
) {
  return { ...request, outcome, verifiedAt: VERIFIED_AT };
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressableWithLabel(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (label: string) => boolean,
) {
  // PressableScale forwards its props to the inner Pressable, so keep only
  // the outermost node per row.
  const matches = (node: TestRenderer.ReactTestInstance) =>
    typeof node.props.accessibilityLabel === 'string' &&
    predicate(node.props.accessibilityLabel) &&
    typeof node.props.onPress === 'function';
  return renderer.root.findAll(node => {
    if (!matches(node)) return false;
    for (let up = node.parent; up; up = up.parent) {
      if (matches(up)) return false;
    }
    return true;
  });
}

function membershipValue(renderer: TestRenderer.ReactTestRenderer): string {
  const rows = pressableWithLabel(renderer, label =>
    label.startsWith('Pickle Sensei Pro, '),
  );
  expect(rows).toHaveLength(1);
  return String(rows[0]!.props.accessibilityLabel).replace(
    'Pickle Sensei Pro, ',
    '',
  );
}

function manageRows(renderer: TestRenderer.ReactTestRenderer) {
  return pressableWithLabel(renderer, label =>
    label.startsWith('Manage subscription'),
  );
}

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

let mounted: TestRenderer.ReactTestRenderer | null = null;

async function renderSettings() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<SettingsScreen />);
  });
  mounted = renderer;
  await flush();
  return renderer;
}

async function renderPaywall() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<PaywallScreen onClose={jest.fn()} />);
  });
  mounted = renderer;
  await flush();
  return renderer;
}

const baseInput: MembershipStateInput = {
  access: access(false),
  billing: null,
  pendingFulfilment: null,
  fulfilmentStatus: 'clear',
  reconciliationStatus: 'verified',
  fulfilmentVerdict: null,
  error: null,
  nowMs: NOW_MS,
};

function pendingRecord(source: 'purchase' | 'restore' = 'purchase') {
  return createPendingFulfilment(
    OWNER,
    source,
    source === 'purchase' ? transaction : undefined,
  );
}

function expectNoInventedPrice(text: string) {
  expect(text).not.toMatch(/[$€£]\s?\d/);
  expect(text).not.toMatch(/\d+\.\d{2}/);
}

beforeEach(() => {
  mockNavigate.mockClear();
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  jest
    .spyOn(Dimensions, 'get')
    .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 1 });
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({ session });
  useConsentStore.setState({
    availability: 'signed_out',
    modelTrainingActive: false,
    hydrate: jest.fn(() => Promise.resolve()),
  });
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
});

const boundRequest = (): BillingFulfilmentRequest => ({
  pendingId: pendingRecord().id,
  attemptId: '33333333-3333-4333-8333-333333333333',
  transaction,
});

/** Grace copy may name the last verified end date; it must never assert a
 * live server report the client has not received. */
function expectNoInventedServerReport(text: string) {
  expect(text).not.toMatch(/server still reports/i);
  expect(text).not.toMatch(/still reports your membership/i);
}

function selectMembership(now = NOW_MS) {
  return selectMembershipState(useAccessStore.getState(), now);
}

describe('describeMembershipState (server truth only)', () => {
  it('fails closed to unverified when the server has not answered', () => {
    const state = describeMembershipState({ ...baseInput, access: null });
    expect(state).toMatchObject({
      kind: 'unverified',
      label: 'Verify access',
      purchaseAllowed: false,
      manageSubscription: false,
      horizon: null,
    });
  });

  it('reports pending for a durable store completion the backend has not confirmed', () => {
    const state = describeMembershipState({
      ...baseInput,
      pendingFulfilment: pendingRecord('purchase'),
      fulfilmentStatus: 'pending',
    });
    expect(state).toMatchObject({
      kind: 'pending',
      label: 'Verification pending',
      eyebrow: 'VERIFICATION PENDING',
      purchaseAllowed: false,
      manageSubscription: false,
      retryAllowed: true,
    });
    expect(state.detail).toContain('not another purchase');
  });

  it('reports pending when the server itself answered pending for a bound purchase', () => {
    const state = describeMembershipState({
      ...baseInput,
      fulfilmentVerdict: boundVerdict(boundRequest(), 'pending'),
    });
    expect(state.kind).toBe('pending');
    expect(state.retryAllowed).toBe(true);
  });

  it('keeps a pending record visible even when the server already grants access, withholding a new offer but keeping retry', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, FUTURE),
      pendingFulfilment: pendingRecord('purchase'),
      fulfilmentStatus: 'pending',
    });
    expect(state).toMatchObject({
      kind: 'pending',
      label: 'Pro active · verification pending',
      purchaseAllowed: false,
      manageSubscription: false,
      retryAllowed: true,
    });
  });

  it('reports HOLD when the pending journal cannot be read', () => {
    const state = describeMembershipState({
      ...baseInput,
      fulfilmentStatus: 'unavailable',
    });
    expect(state).toMatchObject({
      kind: 'hold',
      label: 'Verification on hold',
      eyebrow: 'VERIFICATION ON HOLD',
      purchaseAllowed: false,
      manageSubscription: false,
      retryAllowed: true,
    });
  });

  it('reports HOLD when a pending record exists but the server cannot be reached', () => {
    const state = describeMembershipState({
      ...baseInput,
      pendingFulfilment: pendingRecord('purchase'),
      fulfilmentStatus: 'pending',
      reconciliationStatus: 'unavailable',
    });
    expect(state.kind).toBe('hold');
    expect(state.purchaseAllowed).toBe(false);
  });

  it('reports fulfilled with the server-verified access horizon and offers Manage subscription', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, FUTURE),
    });
    expect(state).toMatchObject({
      kind: 'fulfilled',
      label: `Pro active through ${formatMembershipDate(FUTURE)}`,
      eyebrow: 'MEMBERSHIP VERIFIED',
      horizon: FUTURE,
      manageSubscription: true,
      purchaseAllowed: false,
      retryAllowed: false,
    });
  });

  it('reports lifetime access as fulfilled with nothing to manage in App Store subscriptions', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, null, LIFETIME),
    });
    expect(state).toMatchObject({
      kind: 'fulfilled',
      label: 'Pro active',
      horizon: null,
      manageSubscription: false,
    });
  });

  it('reports fulfilled from access alone before any billing sync has run, without a subscription to manage', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
    });
    expect(state).toMatchObject({
      kind: 'fulfilled',
      label: 'Pro active',
      horizon: null,
      manageSubscription: false,
    });
  });

  it('reports grace when the server still grants access past its last verified horizon', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, PAST),
    });
    expect(state).toMatchObject({
      kind: 'grace',
      label: 'Pro active · renewal unconfirmed',
      horizon: PAST,
      manageSubscription: true,
      purchaseAllowed: false,
    });
    expect(state.detail).toContain(formatMembershipDate(PAST));
    expectNoInventedServerReport(state.detail);
  });

  it('grace copy says the server could not be reached when reconciliation is unavailable', () => {
    const verified = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, PAST),
      reconciliationStatus: 'verified',
    });
    const unavailable = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, PAST),
      reconciliationStatus: 'unavailable',
    });
    expect(unavailable.kind).toBe('grace');
    expect(unavailable.detail).not.toBe(verified.detail);
    expect(unavailable.detail).toContain('could not be reached');
    expect(unavailable.detail).not.toMatch(/still grants/i);
    expectNoInventedServerReport(unavailable.detail);
    expectNoInventedServerReport(verified.detail);
  });

  it.each(['expired', 'refunded'] as const)(
    'reports expired from a bound %s disposition and allows a new store purchase',
    outcome => {
      const state = describeMembershipState({
        ...baseInput,
        fulfilmentVerdict: boundVerdict(boundRequest(), outcome),
        error: {
          code: 'billing.purchase_settled',
          message: 'settled',
          retryable: false,
        },
      });
      expect(state).toMatchObject({
        kind: 'expired',
        label: `${outcome === 'refunded' ? 'Purchase refunded' : 'Membership expired'} · 1 free rating left`,
        purchaseAllowed: true,
        manageSubscription: false,
      });
      expect(state.detail).toContain('1 free rating left');
      const spent = describeMembershipState({
        ...baseInput,
        access: access(false, 2),
        fulfilmentVerdict: boundVerdict(boundRequest(), outcome),
      });
      expect(spent.label).toBe(
        outcome === 'refunded' ? 'Purchase refunded' : 'Membership expired',
      );
      expect(spent.detail).not.toMatch(/free rating/i);
    },
  );

  it('never asserts a charging guarantee the client cannot verify', () => {
    const inputs: MembershipStateInput[] = [
      {
        ...baseInput,
        pendingFulfilment: pendingRecord(),
        fulfilmentStatus: 'pending',
      },
      {
        ...baseInput,
        access: access(true),
        pendingFulfilment: pendingRecord(),
        fulfilmentStatus: 'pending',
      },
      { ...baseInput, fulfilmentStatus: 'unavailable' },
      { ...baseInput, access: access(true), fulfilmentStatus: 'unavailable' },
      { ...baseInput, access: access(true), billing: billing(true, PAST) },
    ];
    for (const input of inputs) {
      const state = describeMembershipState(input);
      const copy = `${state.label} ${state.eyebrow} ${state.title} ${state.detail}`;
      expect(copy).not.toMatch(/nothing more will be charged/i);
      expect(copy).not.toMatch(/will (not|never) be charged/i);
      expect(copy).not.toMatch(/no(t| further) charge/i);
    }
  });

  it('never derives expired from a premium snapshot the current access answer has superseded', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(false, 2),
      billing: billing(true, PAST),
    });
    expect(state).toMatchObject({
      kind: 'free',
      label: 'Upgrade required',
      horizon: null,
      manageSubscription: false,
    });
    expect(state.eyebrow).not.toContain('EXPIRED');
  });

  it('never lets a stale billing snapshot grant access the server denies', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(false),
      billing: billing(true, FUTURE),
    });
    expect(state.kind).toBe('free');
    expect(state.horizon).toBeNull();
    expect(state.manageSubscription).toBe(false);
  });

  it('keeps the free-allowance wording for non-members', () => {
    expect(describeMembershipState(baseInput).label).toBe('1 free rating left');
    expect(
      describeMembershipState({ ...baseInput, access: access(false, 0) }).label,
    ).toBe('2 free ratings left');
    expect(
      describeMembershipState({ ...baseInput, access: access(false, 2) }),
    ).toMatchObject({ kind: 'free', label: 'Upgrade required' });
  });

  it('prefers the newest server answer: a fulfilled verdict after an expired one is fulfilled', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, FUTURE),
      fulfilmentVerdict: boundVerdict(boundRequest(), 'fulfilled'),
    });
    expect(state.kind).toBe('fulfilled');
  });

  it('never contains a price or currency in any state copy', () => {
    const request = boundRequest();
    const inputs: MembershipStateInput[] = [
      { ...baseInput, access: null },
      {
        ...baseInput,
        pendingFulfilment: pendingRecord(),
        fulfilmentStatus: 'pending',
      },
      { ...baseInput, fulfilmentStatus: 'unavailable' },
      { ...baseInput, access: access(true), billing: billing(true, FUTURE) },
      { ...baseInput, access: access(true), billing: billing(true, PAST) },
      {
        ...baseInput,
        access: access(true),
        billing: billing(true, PAST),
        reconciliationStatus: 'unavailable',
      },
      { ...baseInput, fulfilmentVerdict: boundVerdict(request, 'expired') },
      { ...baseInput, fulfilmentVerdict: boundVerdict(request, 'refunded') },
      baseInput,
    ];
    for (const input of inputs) {
      const state = describeMembershipState(input);
      expectNoInventedPrice(`${state.label} ${state.eyebrow} ${state.detail}`);
    }
  });
});

describe('accessStore membership lifecycle (one server truth, one state)', () => {
  it('A1: a refunded verdict bound to purchase #1 never describes a LATER membership lapse', async () => {
    const truth: ServerTruth = {
      access: access(false, 2),
      sync: request => ({
        billing: billing(false, null),
        access: access(false, 2),
        fulfilment: boundVerdict(request!, 'refunded'),
      }),
    };
    const clients = dependencies(truth);
    const storage = memoryStorage(pendingRecord('purchase'));
    configure(clients, storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(selectMembership()).toMatchObject({
      kind: 'expired',
      label: 'Purchase refunded',
    });

    // The member re-subscribes outside the app; the server grants premium.
    truth.access = access(true);
    truth.sync = () => ({
      billing: billing(true, FUTURE),
      access: access(true),
    });
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    expect(selectMembership()).toMatchObject({
      kind: 'fulfilled',
      label: `Pro active through ${formatMembershipDate(FUTURE)}`,
    });

    // That later membership lapses. The only refund the server ever confirmed
    // was purchase #1 — it must not be replayed onto this lapse.
    truth.access = access(false, 2);
    truth.sync = () => ({
      billing: billing(false, null),
      access: access(false, 2),
    });
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    const afterAccess = selectMembership(AFTER_FUTURE_MS);
    expect(afterAccess.kind).toBe('free');
    expect(afterAccess.label).toBe('Upgrade required');
    expect(`${afterAccess.eyebrow} ${afterAccess.detail}`).not.toMatch(
      /refund/i,
    );
    await act(async () => {
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    expect(selectMembership(AFTER_FUTURE_MS)).toMatchObject({
      kind: 'free',
      label: 'Upgrade required',
    });
  });

  it('A2: a lapsed member reads the same after /v1/me/access, after /v1/billing/sync and after a cold start', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    };
    const clients = dependencies(truth);
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    expect(selectMembership()).toMatchObject({
      kind: 'fulfilled',
      horizon: FUTURE,
    });

    // The horizon passes and the server stops granting access.
    truth.access = access(false, 2);
    truth.sync = () => ({
      billing: billing(false, null),
      access: access(false, 2),
    });
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    const afterAccess = selectMembership(AFTER_FUTURE_MS);
    await act(async () => {
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    const afterSync = selectMembership(AFTER_FUTURE_MS);

    // Process death: nothing in memory survives but the server truth.
    clearAccessStoreConfiguration();
    configure(dependencies(truth), memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const afterColdStart = selectMembership(AFTER_FUTURE_MS);

    expect(afterAccess.kind).toBe(afterSync.kind);
    expect(afterAccess.label).toBe(afterSync.label);
    expect(afterSync.kind).toBe(afterColdStart.kind);
    expect(afterSync.label).toBe(afterColdStart.label);
    expect(afterColdStart).toMatchObject({
      kind: 'free',
      label: 'Upgrade required',
      horizon: null,
      manageSubscription: false,
    });
  });

  it('A3: with every server call failing since the horizon, grace copy never claims a live server report', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, PAST), access: access(true) }),
    };
    const clients = dependencies(truth);
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    expect(selectMembership().kind).toBe('grace');

    clients.backend.syncBilling.mockRejectedValue(new Error('503'));
    clients.backend.getAccess.mockRejectedValue(new Error('503'));
    await act(async () => {
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    const state = useAccessStore.getState();
    expect(state.reconciliation.status).toBe('unavailable');
    expect(state.canonicalAccess?.premium).toBe(true);
    const membership = selectMembership();
    expect(membership).toMatchObject({
      kind: 'grace',
      horizon: PAST,
      manageSubscription: true,
    });
    expect(membership.detail).toContain(formatMembershipDate(PAST));
    expect(membership.detail).toContain('could not be reached');
    expect(membership.detail).not.toMatch(/still grants/i);
    expectNoInventedServerReport(membership.detail);
  });

  // Server contract (POST /v1/billing/sync + effectivePremium()):
  // billing.premium === access.premium, and a horizon is only reported while
  // expires_at > now. A non-premium access answer therefore supersedes every
  // horizon the client holds, and a later premium answer says nothing about
  // the new period until the client re-syncs — exactly what a cold start knows.
  it('A4: a non-premium access answer supersedes the synced horizon; a later premium answer without a new sync reads exactly like a cold start', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    };
    const clients = dependencies(truth);
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    expect(selectMembership().label).toBe(
      `Pro active through ${formatMembershipDate(FUTURE)}`,
    );

    // The annual is refunded: access answers non-premium.
    truth.access = access(false, 2);
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    expect(useAccessStore.getState().canonicalBilling).toBeNull();
    expect(selectMembership()).toMatchObject({
      kind: 'free',
      horizon: null,
      manageSubscription: false,
    });

    // Premium again (a lifetime purchase completed on another device); no
    // billing sync has run since.
    truth.access = access(true);
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    const afterRegrant = selectMembership();

    clearAccessStoreConfiguration();
    configure(dependencies({ access: access(true) }), memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    const coldStart = selectMembership();
    expect(coldStart).toMatchObject({
      kind: 'fulfilled',
      label: 'Pro active',
      horizon: null,
      manageSubscription: false,
    });
    expect(afterRegrant).toEqual(coldStart);
  });

  it('A4: Settings offers no Manage subscription and states no revoked horizon to a member the server re-granted without a subscription horizon', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    };
    const clients = dependencies(truth);
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    truth.access = access(false, 2);
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    truth.access = access(true);
    const renderer = await renderSettings();
    expect(clients.backend.getAccess).toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(membershipValue(renderer)).toBe('Pro active');
    expect(manageRows(renderer)).toHaveLength(0);
  });

  it('A4: a premium access answer received after the horizon is never described as an unconfirmed renewal', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    };
    const clients = dependencies(truth);
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    expect(selectMembership(AFTER_FUTURE_MS).kind).toBe('grace');

    // Past the horizon the server answers premium again — under
    // effectivePremium() only possible with a newer expires_at.
    jest.spyOn(Date, 'now').mockReturnValue(AFTER_FUTURE_MS);
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    const state = selectMembership(AFTER_FUTURE_MS);
    expect(state).toMatchObject({
      kind: 'fulfilled',
      label: 'Pro active',
      horizon: null,
      manageSubscription: false,
    });
    expect(state.detail).not.toMatch(/has not re-verified a renewal/i);
    expect(state.label).not.toContain('renewal unconfirmed');
  });

  it('A4: a premium access answer before the horizon keeps the synced horizon and Manage subscription', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    };
    const clients = dependencies(truth);
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
      await useAccessStore.getState().refreshAccess();
    });
    expect(selectMembership()).toMatchObject({
      kind: 'fulfilled',
      horizon: FUTURE,
      manageSubscription: true,
    });
  });

  it('A4: a lifetime member keeps the synced (horizon-less) billing answer across premium access answers', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({
        billing: billing(true, null, LIFETIME),
        access: access(true),
      }),
    };
    const clients = dependencies(truth);
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
      await useAccessStore.getState().refreshAccess();
    });
    expect(useAccessStore.getState().canonicalBilling).toMatchObject({
      premium: true,
      productKey: LIFETIME,
    });
    expect(selectMembership()).toMatchObject({
      kind: 'fulfilled',
      label: 'Pro active',
      manageSubscription: false,
    });
  });
});

describe('Settings membership row states', () => {
  it('shows pending after a purchase the server has not confirmed and offers no Manage subscription', async () => {
    const clients = dependencies({
      access: access(false),
      sync: request => ({
        billing: billing(false, null),
        access: access(false),
        fulfilment: boundVerdict(request!, 'pending'),
      }),
    });
    configure(clients, memoryStorage(pendingRecord('purchase')));
    const renderer = await renderSettings();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(membershipValue(renderer)).toBe('Verification pending');
    expect(manageRows(renderer)).toHaveLength(0);
  });

  it('shows HOLD when the durable journal cannot be read', async () => {
    const clients = dependencies({ access: access(false) });
    configure(clients, unreadableStorage());
    const renderer = await renderSettings();
    expect(membershipValue(renderer)).toBe('Verification on hold');
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(manageRows(renderer)).toHaveLength(0);
  });

  it('shows expired once the server settles a bound purchase as expired', async () => {
    const clients = dependencies({
      access: access(false, 2),
      sync: request => ({
        billing: billing(false, null),
        access: access(false, 2),
        fulfilment: boundVerdict(request!, 'expired'),
      }),
    });
    const storage = memoryStorage(pendingRecord('purchase'));
    configure(clients, storage);
    const renderer = await renderSettings();
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(membershipValue(renderer)).toBe('Membership expired');
    expect(manageRows(renderer)).toHaveLength(0);
  });

  it('shows the verified horizon for a member and opens App Store subscriptions from Manage subscription', async () => {
    const clients = dependencies({
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    });
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const renderer = await renderSettings();
    expect(membershipValue(renderer)).toBe(
      `Pro active through ${formatMembershipDate(FUTURE)}`,
    );
    const [manage] = manageRows(renderer);
    expect(manage).toBeDefined();
    expect(manage!.props.accessibilityLabel).toBe(
      'Manage subscription, App Store',
    );
    await act(async () => {
      manage!.props.onPress();
    });
    expect(Linking.openURL).toHaveBeenCalledWith(APP_STORE_SUBSCRIPTIONS_URL);
    expect(APP_STORE_SUBSCRIPTIONS_URL).toBe(
      'https://apps.apple.com/account/subscriptions',
    );
    expect(mockNavigate).not.toHaveBeenCalledWith('Paywall', {
      source: 'settings',
    });
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
  });

  it('offers no Manage subscription to a lifetime (non-consumable) member', async () => {
    const clients = dependencies({
      access: access(true),
      sync: () => ({
        billing: billing(true, null, LIFETIME),
        access: access(true),
      }),
    });
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const renderer = await renderSettings();
    expect(membershipValue(renderer)).toBe('Pro active');
    expect(manageRows(renderer)).toHaveLength(0);
  });

  it('shows grace from the last verified truth while the focus re-check past the horizon is still in flight', async () => {
    const clients = dependencies({
      access: access(true),
      sync: () => ({ billing: billing(true, PAST), access: access(true) }),
    });
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    let answer!: (value: CanonicalAccessState) => void;
    clients.backend.getAccess.mockClear();
    clients.backend.getAccess.mockImplementation(
      () =>
        new Promise<CanonicalAccessState>(resolve => {
          answer = resolve;
        }),
    );
    const renderer = await renderSettings();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(membershipValue(renderer)).toBe('Pro active · renewal unconfirmed');
    expect(manageRows(renderer)).toHaveLength(1);

    // The server answers premium past the horizon: the stale horizon is
    // superseded and the row reads exactly like a cold start.
    answer(access(true));
    await flush();
    expect(membershipValue(renderer)).toBe('Pro active');
    expect(manageRows(renderer)).toHaveLength(0);
  });

  it('keeps the server free-rating ledger visible beside an expired verdict', async () => {
    const clients = dependencies({
      access: access(false, 0),
      sync: request => ({
        billing: billing(false, null),
        access: access(false, 0),
        fulfilment: boundVerdict(request!, 'refunded'),
      }),
    });
    configure(clients, memoryStorage(pendingRecord('purchase')));
    const renderer = await renderSettings();
    expect(selectMembership().kind).toBe('expired');
    expect(membershipValue(renderer)).toBe(
      'Purchase refunded · 2 free ratings left',
    );
    expect(manageRows(renderer)).toHaveLength(0);
  });

  it('offers no Manage subscription to a free account', async () => {
    const clients = dependencies({ access: access(false) });
    configure(clients, memoryStorage());
    const renderer = await renderSettings();
    expect(membershipValue(renderer)).toBe('1 free rating left');
    expect(manageRows(renderer)).toHaveLength(0);
  });

  it('never invents a price in any membership row', async () => {
    const clients = dependencies({
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    });
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const renderer = await renderSettings();
    expectNoInventedPrice(
      pressableWithLabel(
        renderer,
        label =>
          label.startsWith('Pickle Sensei Pro, ') ||
          label.startsWith('Manage subscription'),
      )
        .map(node => String(node.props.accessibilityLabel))
        .join(' '),
    );
  });
});

describe('Paywall membership states', () => {
  it('states pending explicitly, withholds every plan and price, and blocks purchase and restore', async () => {
    const clients = dependencies({
      access: access(false),
      sync: request => ({
        billing: billing(false, null),
        access: access(false),
        fulfilment: boundVerdict(request!, 'pending'),
      }),
    });
    configure(clients, memoryStorage(pendingRecord('purchase')));
    const renderer = await renderPaywall();
    const copy = allText(renderer);
    expect(copy).toContain('VERIFICATION PENDING');
    expect(copy).toContain('Verification is pending, not another purchase.');
    expect(copy).not.toContain('A coach for every stroke.');
    await act(async () => {
      byTestId(renderer, 'paywall-see-plans').props.onPress();
    });
    await flush();
    expect(allText(renderer)).not.toContain(plans.annual!.priceString);
    expectNoInventedPrice(allText(renderer));
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(true);
    expect(byTestId(renderer, 'paywall-retry')).toBeDefined();
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
  });

  it('states HOLD explicitly when the journal is unreadable and offers no plan', async () => {
    const clients = dependencies({ access: access(false) });
    configure(clients, unreadableStorage());
    const renderer = await renderPaywall();
    const copy = allText(renderer);
    expect(copy).toContain('VERIFICATION ON HOLD');
    expect(copy).not.toContain('A coach for every stroke.');
    await act(async () => {
      byTestId(renderer, 'paywall-see-plans').props.onPress();
    });
    await flush();
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(byTestId(renderer, 'paywall-retry')).toBeDefined();
    expectNoInventedPrice(allText(renderer));
  });

  it('states expired explicitly and lets the member buy again from store pricing', async () => {
    const clients = dependencies({
      access: access(false, 2),
      sync: request => ({
        billing: billing(false, null),
        access: access(false, 2),
        fulfilment: boundVerdict(request!, 'expired'),
      }),
    });
    configure(clients, memoryStorage(pendingRecord('purchase')));
    const renderer = await renderPaywall();
    expect(allText(renderer)).toContain('MEMBERSHIP EXPIRED');
    await act(async () => {
      byTestId(renderer, 'paywall-see-plans').props.onPress();
    });
    await flush();
    expect(allText(renderer)).toContain('MEMBERSHIP EXPIRED');
    expect(allText(renderer)).toContain(plans.annual!.priceString);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
  });

  it('keeps the server free-rating ledger in the expired copy for a buyer who never spent one', async () => {
    const clients = dependencies({
      access: access(false, 0),
      sync: request => ({
        billing: billing(false, null),
        access: access(false, 0),
        fulfilment: boundVerdict(request!, 'expired'),
      }),
    });
    configure(clients, memoryStorage(pendingRecord('purchase')));
    const renderer = await renderPaywall();
    const copy = allText(renderer);
    expect(copy).toContain('MEMBERSHIP EXPIRED');
    expect(copy).toMatch(/2 free ratings left/);
    expectNoInventedPrice(copy);
  });

  it('shows the verified horizon and Manage subscription to a member, with no retry to press', async () => {
    const clients = dependencies({
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    });
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const renderer = await renderPaywall();
    const copy = allText(renderer);
    expect(copy).toContain('MEMBERSHIP VERIFIED');
    expect(copy).toContain('Your full court is open.');
    expect(copy).toContain(formatMembershipDate(FUTURE));
    expectNoInventedPrice(copy);
    expect(() => byTestId(renderer, 'paywall-retry')).toThrow();
    await act(async () => {
      byTestId(renderer, 'paywall-manage-subscription').props.onPress();
    });
    expect(Linking.openURL).toHaveBeenCalledWith(APP_STORE_SUBSCRIPTIONS_URL);
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
  });

  it('offers a lifetime member no Manage subscription', async () => {
    const clients = dependencies({
      access: access(true),
      sync: () => ({
        billing: billing(true, null, LIFETIME),
        access: access(true),
      }),
    });
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const renderer = await renderPaywall();
    expect(allText(renderer)).toContain('MEMBERSHIP VERIFIED');
    expect(() => byTestId(renderer, 'paywall-manage-subscription')).toThrow();
  });

  it('keeps a member with a pending purchase on retry — no new offer, no subscription management', async () => {
    const clients = dependencies({
      access: access(true),
      sync: request => ({
        billing: billing(true, FUTURE),
        access: access(true),
        fulfilment: boundVerdict(request!, 'pending'),
      }),
    });
    configure(clients, memoryStorage(pendingRecord('purchase')));
    const renderer = await renderPaywall();
    const copy = allText(renderer);
    expect(copy).toContain('VERIFICATION PENDING');
    expect(copy).not.toContain('MEMBERSHIP VERIFIED');
    expectNoInventedPrice(copy);
    expect(() => byTestId(renderer, 'paywall-see-plans')).toThrow();
    expect(() => byTestId(renderer, 'paywall-manage-subscription')).toThrow();
    const syncsBefore = clients.backend.syncBilling.mock.calls.length;
    await act(async () => {
      byTestId(renderer, 'paywall-retry').props.onPress();
    });
    await flush();
    expect(clients.backend.syncBilling.mock.calls.length).toBe(syncsBefore + 1);
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
  });

  it('states grace on the active page without inventing a renewal', async () => {
    const clients = dependencies({
      access: access(true),
      sync: () => ({ billing: billing(true, PAST), access: access(true) }),
    });
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const renderer = await renderPaywall();
    const copy = allText(renderer);
    expect(copy).toContain('RENEWAL UNCONFIRMED');
    expect(copy).toContain(formatMembershipDate(PAST));
    expect(copy).not.toContain('MEMBERSHIP VERIFIED');
    expectNoInventedPrice(copy);
    expectNoInventedServerReport(copy);
    expect(byTestId(renderer, 'paywall-manage-subscription')).toBeDefined();
  });

  it('A3: grace copy on the member page says the server could not be reached once reconciliation fails', async () => {
    const clients = dependencies({
      access: access(true),
      sync: () => ({ billing: billing(true, PAST), access: access(true) }),
    });
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    clients.backend.syncBilling.mockRejectedValue(new Error('503'));
    clients.backend.getAccess.mockRejectedValue(new Error('503'));
    await act(async () => {
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    expect(useAccessStore.getState().reconciliation.status).toBe('unavailable');
    const renderer = await renderPaywall();
    const copy = allText(renderer);
    expect(copy).toContain('RENEWAL UNCONFIRMED');
    expect(copy).toContain('could not be reached');
    expect(copy).not.toMatch(/still grants/i);
    expectNoInventedServerReport(copy);
  });
});
