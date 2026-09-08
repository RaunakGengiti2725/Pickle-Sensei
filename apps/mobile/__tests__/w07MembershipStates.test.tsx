/**
 * W07-05 — Settings and Paywall state their membership from SERVER truth:
 * pending (a completed store purchase/restore the backend has not confirmed),
 * fulfilled (server-verified premium, with the server's access horizon),
 * grace (the server still grants access past the horizon it last verified),
 * expired (a bound expired/refunded disposition, or a verified horizon that
 * has passed), and HOLD (the durable journal cannot be read, so it is unknown
 * whether a purchase is waiting). Active members reach "Manage subscription",
 * which opens the App Store subscriptions surface. No state ever invents an
 * entitlement or a price.
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
  useAccessStore,
} from '../src/state/accessStore';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';
import { useConsentStore } from '../src/state/consentStore';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { PaywallScreen } from '../src/screens/PaywallScreen';

const OWNER = '11111111-1111-4111-8111-111111111111';
const NOW_MS = Date.parse('2026-09-08T12:00:00.000Z');
const FUTURE = '2027-03-01T00:00:00.000Z';
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
): CanonicalBillingState {
  return {
    premium,
    productKey: premium ? 'pickle_sensei_pro_annual' : null,
    expiresAt: premium ? expiresAt : null,
    verifiedAt: VERIFIED_AT,
  };
}

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

function dependencies(options: {
  access: CanonicalAccessState;
  sync?: (request?: BillingFulfilmentRequest) => CanonicalBillingSync;
}) {
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
    });
    expect(state.detail).toContain('not another purchase');
  });

  it('reports pending when the server itself answered pending for a bound purchase', () => {
    const request = {
      pendingId: pendingRecord().id,
      attemptId: '33333333-3333-4333-8333-333333333333',
      transaction,
    };
    const state = describeMembershipState({
      ...baseInput,
      fulfilmentVerdict: boundVerdict(request, 'pending'),
    });
    expect(state.kind).toBe('pending');
  });

  it('keeps a pending record visible even when the server already grants access', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, FUTURE),
      pendingFulfilment: pendingRecord('restore'),
      fulfilmentStatus: 'pending',
    });
    expect(state.kind).toBe('pending');
    expect(state.label).toBe('Pro active · verification pending');
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

  it('reports fulfilled with the server-verified access horizon', () => {
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
    });
  });

  it('reports fulfilled without a date when the server states no end (lifetime)', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, null),
    });
    expect(state).toMatchObject({
      kind: 'fulfilled',
      label: 'Pro active',
      horizon: null,
      manageSubscription: true,
    });
  });

  it('reports fulfilled from access alone before any billing sync has run', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
    });
    expect(state).toMatchObject({
      kind: 'fulfilled',
      label: 'Pro active',
      horizon: null,
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
  });

  it.each(['expired', 'refunded'] as const)(
    'reports expired from a bound %s disposition and allows a new store purchase',
    outcome => {
      const request = {
        pendingId: pendingRecord().id,
        attemptId: '33333333-3333-4333-8333-333333333333',
        transaction,
      };
      const state = describeMembershipState({
        ...baseInput,
        fulfilmentVerdict: boundVerdict(request, outcome),
        error: {
          code: 'billing.purchase_settled',
          message: 'settled',
          retryable: false,
        },
      });
      expect(state).toMatchObject({
        kind: 'expired',
        label:
          outcome === 'refunded' ? 'Purchase refunded' : 'Membership expired',
        purchaseAllowed: true,
        manageSubscription: false,
      });
    },
  );

  it('reports expired when a previously verified horizon has passed and access is no longer premium', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(false, 2),
      billing: billing(true, PAST),
    });
    expect(state).toMatchObject({
      kind: 'expired',
      label: 'Membership expired',
      horizon: PAST,
      purchaseAllowed: true,
    });
    expect(state.detail).toContain(formatMembershipDate(PAST));
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
    const request = {
      pendingId: pendingRecord().id,
      attemptId: '33333333-3333-4333-8333-333333333333',
      transaction,
    };
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, FUTURE),
      fulfilmentVerdict: boundVerdict(request, 'fulfilled'),
    });
    expect(state.kind).toBe('fulfilled');
  });

  it('never contains a price or currency in any state copy', () => {
    const request = {
      pendingId: pendingRecord().id,
      attemptId: '33333333-3333-4333-8333-333333333333',
      transaction,
    };
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

  it('shows grace when the server keeps access open past its last verified horizon', async () => {
    const clients = dependencies({
      access: access(true),
      sync: () => ({ billing: billing(true, PAST), access: access(true) }),
    });
    configure(clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const renderer = await renderSettings();
    expect(membershipValue(renderer)).toBe('Pro active · renewal unconfirmed');
    expect(manageRows(renderer)).toHaveLength(1);
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
  it('states pending explicitly and blocks purchase and restore', async () => {
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
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(true);
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
  });

  it('states HOLD explicitly when the journal is unreadable', async () => {
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
    expectNoInventedPrice(
      allText(renderer).replace(plans.annual!.priceString, ''),
    );
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

  it('shows the verified horizon and Manage subscription to a member', async () => {
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
    await act(async () => {
      byTestId(renderer, 'paywall-manage-subscription').props.onPress();
    });
    expect(Linking.openURL).toHaveBeenCalledWith(APP_STORE_SUBSCRIPTIONS_URL);
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
    expect(byTestId(renderer, 'paywall-manage-subscription')).toBeDefined();
  });
});
