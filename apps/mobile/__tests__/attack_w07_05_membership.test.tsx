/**
 * W07-05 adversarial attacks — membership states from server truth.
 *
 * Each `describe` is one attack against candidate 184af537. Attacks that
 * pass show the boundary held; attacks that fail are reported as breaks.
 * Nothing here modifies candidate production code or candidate tests.
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
const mockShowBrandNotice = jest.fn();
jest.mock('../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));

import React from 'react';
import { Dimensions, Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  describeMembershipState,
  formatMembershipDate,
  type MembershipStateInput,
} from '../src/billing/membershipState';
import {
  MEMBERSHIP_VERIFICATION_HERO,
  membershipHeroCopy,
} from '../src/screens/paywallCopy';
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

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.parse('2026-09-08T12:00:00.000Z');
const FUTURE = '2027-03-01T00:00:00.000Z';
const PAST = '2026-09-01T00:00:00.000Z';
const VERIFIED_AT = '2026-09-08T11:59:00.000Z';

const iso = (ms: number) => new Date(ms).toISOString();

function sessionFor(owner: string): AuthSession {
  return {
    provider: 'apple',
    subject: owner,
    canonicalAppUserId: owner,
    localOnly: false,
    displayName: 'Alex Chen',
    email: 'alex@example.com',
  };
}

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

type SyncAnswer = (
  request?: BillingFulfilmentRequest,
) => CanonicalBillingSync | Promise<CanonicalBillingSync>;

/** A scriptable backend: every answer can be changed between calls. */
function server(initial: {
  access: CanonicalAccessState | Error;
  sync?: SyncAnswer | Error;
}) {
  const state = {
    access: initial.access as CanonicalAccessState | Error,
    sync: (initial.sync ?? new Error('sync not exercised')) as
      SyncAnswer | Error,
  };
  const clients = {
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
      getAccess: jest.fn(async () => {
        if (state.access instanceof Error) throw state.access;
        return state.access;
      }),
      syncBilling: jest.fn(async (request?: BillingFulfilmentRequest) => {
        if (state.sync instanceof Error) throw state.sync;
        return state.sync(request);
      }),
    },
  } satisfies BillingAccessDependencies;
  return { state, clients };
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

function corruptStorage(value: unknown): PendingFulfilmentStorage {
  return {
    read: jest.fn(async () => value as PendingFulfilment),
    write: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
  };
}

function configure(
  clients: BillingAccessDependencies,
  storage: PendingFulfilmentStorage,
  owner = OWNER_A,
) {
  setActiveDataOwner(owner);
  useAuthStore.setState({ session: sessionFor(owner) });
  configureAccessStore(clients, { owner, pendingFulfilmentStorage: storage });
}

function boundVerdict(
  request: BillingFulfilmentRequest,
  outcome: 'pending' | 'fulfilled' | 'expired' | 'refunded',
) {
  return { ...request, outcome, verifiedAt: VERIFIED_AT };
}

function pendingRecord(source: 'purchase' | 'restore' = 'purchase') {
  return createPendingFulfilment(
    OWNER_A,
    source,
    source === 'purchase' ? transaction : undefined,
  );
}

let clock: number | null = null;
function useClock(startMs: number) {
  clock = startMs;
  jest.spyOn(Date, 'now').mockImplementation(() => clock ?? startMs);
}
function advanceClock(ms: number) {
  if (clock === null) throw new Error('useClock first');
  clock += ms;
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

function pressablesWithTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
}

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = pressablesWithTestId(renderer, testID);
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

const label = () => selectMembershipState(useAccessStore.getState()).label;

const baseInput: MembershipStateInput = {
  access: access(false),
  billing: null,
  pendingFulfilment: null,
  fulfilmentStatus: 'clear',
  reconciliationStatus: 'verified',
  fulfilmentVerdict: null,
  error: null,
  nowMs: T0,
};

function expectNoInventedPrice(text: string) {
  expect(text).not.toMatch(/[$€£]\s?\d/);
  expect(text).not.toMatch(/\d+\.\d{2}/);
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockShowBrandNotice.mockClear();
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  jest
    .spyOn(Dimensions, 'get')
    .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 1 });
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({ session: sessionFor(OWNER_A) });
  useConsentStore.setState({
    availability: 'signed_out',
    modelTrainingActive: false,
    hydrate: jest.fn(() => Promise.resolve()),
  });
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  clock = null;
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
});

describe('A1 replay: a stale refunded verdict outlives the purchase it described', () => {
  it('labels a LATER membership lapse as "Purchase refunded" (Settings + Paywall)', async () => {
    useClock(T0);
    // Purchase #1 settles as refunded (bound verdict, journal removed).
    const api = server({
      access: access(false, 2),
      sync: request => ({
        billing: billing(false, null),
        access: access(false, 2),
        fulfilment: boundVerdict(request!, 'refunded'),
      }),
    });
    const storage = memoryStorage(pendingRecord('purchase'));
    configure(api.clients, storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().pendingFulfilment).toBeNull();
    expect(label()).toBe('Purchase refunded');

    // The member re-subscribes OUTSIDE the app (App Store subscriptions
    // page, another device). The server now grants premium through HORIZON;
    // the app learns it from the periodic reconcile — no new journal entry.
    const HORIZON = iso(T0 + HOUR_MS);
    api.state.access = access(true);
    api.state.sync = () => ({
      billing: billing(true, HORIZON),
      access: access(true),
    });
    await act(async () => {
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    expect(label()).toBe(`Pro active through ${formatMembershipDate(HORIZON)}`);

    // Purchase #2 simply lapses (no refund). Server truth: not premium.
    advanceClock(2 * HOUR_MS);
    api.state.access = access(false, 2);
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(false);
    expect(state.fulfilmentVerdict?.outcome).toBe('refunded'); // stale
    const membership = selectMembershipState(state);
    // The ONLY refund the server ever confirmed was purchase #1; purchase #2
    // expired. A refund claim about the current lapse invents a money event.
    expect(membership.label).toBe('Membership expired');
    expect(membership.detail).not.toContain('refunded');
    const renderer = await renderSettings();
    expect(membershipValue(renderer)).toBe('Membership expired');
  });

  it('shows PURCHASE REFUNDED on the paywall for the later lapse', async () => {
    useClock(T0);
    const api = server({
      access: access(false, 2),
      sync: request => ({
        billing: billing(false, null),
        access: access(false, 2),
        fulfilment: boundVerdict(request!, 'refunded'),
      }),
    });
    configure(api.clients, memoryStorage(pendingRecord('purchase')));
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    const HORIZON = iso(T0 + HOUR_MS);
    api.state.access = access(true);
    api.state.sync = () => ({
      billing: billing(true, HORIZON),
      access: access(true),
    });
    await act(async () => {
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    advanceClock(2 * HOUR_MS);
    api.state.access = access(false, 2);
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    const renderer = await renderPaywall();
    const copy = allText(renderer);
    expect(copy).toContain('MEMBERSHIP EXPIRED');
    expect(copy).not.toContain('PURCHASE REFUNDED');
    expect(copy).not.toContain('confirmed this purchase was refunded');
  });
});

describe('A2 clock/order: the expired state depends on which endpoint answered last', () => {
  it('flips "Membership expired" to "Upgrade required" on the very next sync for the SAME server truth', async () => {
    useClock(T0);
    const HORIZON = iso(T0 + HOUR_MS);
    const api = server({
      access: access(true),
      sync: () => ({ billing: billing(true, HORIZON), access: access(true) }),
    });
    configure(api.clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    expect(label()).toBe(`Pro active through ${formatMembershipDate(HORIZON)}`);

    // The subscription lapses. Server truth from now on: not premium; the
    // sync endpoint reports expiresAt: null for a non-premium row.
    advanceClock(2 * HOUR_MS);
    api.state.access = access(false, 2);
    api.state.sync = () => ({
      billing: billing(false, null),
      access: access(false, 2),
    });
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    expect(label()).toBe('Membership expired');

    await act(async () => {
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    // Same server truth (lapsed subscription), one more successful sync.
    expect(useAccessStore.getState().canonicalBilling?.premium).toBe(false);
    expect(label()).toBe('Membership expired');
  });

  it('loses the expired state entirely across process death (cold start after the lapse)', async () => {
    useClock(T0);
    const HORIZON = iso(T0 + HOUR_MS);
    const api = server({
      access: access(true),
      sync: () => ({ billing: billing(true, HORIZON), access: access(true) }),
    });
    configure(api.clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    advanceClock(2 * HOUR_MS);
    api.state.access = access(false, 2);
    api.state.sync = () => ({
      billing: billing(false, null),
      access: access(false, 2),
    });
    // Process death: in-memory store gone, same owner signs back in.
    clearAccessStoreConfiguration();
    configure(api.clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const renderer = await renderPaywall();
    const membership = selectMembershipState(useAccessStore.getState());
    expect(membership.kind).toBe('expired');
    expect(allText(renderer)).toContain('MEMBERSHIP EXPIRED');
  });
});

describe('A3 network: grace copy claims a live server report while the server is unreachable', () => {
  it('says "Our server still reports your membership active" after every server call failed', async () => {
    useClock(T0);
    const HORIZON = iso(T0 + HOUR_MS);
    const api = server({
      access: access(true),
      sync: () => ({ billing: billing(true, HORIZON), access: access(true) }),
    });
    configure(api.clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    // Server goes away (timeout/5xx). Reconciliation fails, snapshot kept.
    api.state.sync = new Error('503 upstream unavailable');
    api.state.access = new Error('503 upstream unavailable');
    await act(async () => {
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    expect(useAccessStore.getState().reconciliation.status).toBe('unavailable');
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);

    // Device clock passes the last verified horizon with NO server contact.
    advanceClock(2 * HOUR_MS);
    const membership = selectMembershipState(useAccessStore.getState());
    expect(membership.kind).toBe('grace');
    const renderer = await renderPaywall();
    const copy = allText(renderer);
    expect(copy).toContain('RENEWAL UNCONFIRMED');
    // The last server answer was a FAILURE; nothing "still reports" anything.
    expect(copy).not.toContain('Our server still reports');
  });

  it('describeMembershipState: grace + reconciliationStatus unavailable must not claim a current server report', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, PAST),
      reconciliationStatus: 'unavailable',
    });
    expect(state.kind).toBe('grace');
    expect(state.detail).not.toContain('still reports');
  });
});

describe('A4 product boundary: a lifetime purchase is offered "Manage subscription"', () => {
  it('shows a subscription-management row for a non-subscription (lifetime) product', async () => {
    const api = server({
      access: access(true),
      sync: () => ({
        billing: billing(true, null, 'pickle_sensei_pro_lifetime'),
        access: access(true),
      }),
    });
    configure(api.clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    expect(useAccessStore.getState().canonicalBilling?.productKey).toBe(
      'pickle_sensei_pro_lifetime',
    );
    const renderer = await renderSettings();
    expect(membershipValue(renderer)).toBe('Pro active');
    // There is no subscription to manage: the App Store subscriptions page
    // lists nothing for a non-consumable. Offering it is a false affordance.
    expect(manageRows(renderer)).toHaveLength(0);
  });
});

describe('A5 pending + premium member page: instructs a retry it does not offer', () => {
  it('tells the member to "Retry with our server" but renders no retry control', async () => {
    const api = server({
      access: access(true),
      sync: request => ({
        billing: billing(true, FUTURE),
        access: access(true),
        fulfilment: boundVerdict(request!, 'pending'),
      }),
    });
    configure(api.clients, memoryStorage(pendingRecord('purchase')));
    const renderer = await renderPaywall();
    expect(api.clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(true);
    expect(state.pendingFulfilment).not.toBeNull();
    const copy = allText(renderer);
    expect(copy).toContain('VERIFICATION PENDING');
    expect(copy).toContain('Retry with our server');
    expect(
      pressablesWithTestId(renderer, 'paywall-manage-subscription'),
    ).toHaveLength(0);
    expect(pressablesWithTestId(renderer, 'paywall-retry')).toHaveLength(1);
  });
});

describe('A6 concurrency: account switch while a sync is in flight', () => {
  it("never lets owner A's late billing verdict land in owner B's store or Settings", async () => {
    let resolveSync: ((value: CanonicalBillingSync) => void) | null = null;
    const apiA = server({
      access: access(false),
      sync: () =>
        new Promise<CanonicalBillingSync>(resolve => {
          resolveSync = resolve;
        }),
    });
    configure(apiA.clients, memoryStorage(), OWNER_A);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    const inFlight = useAccessStore.getState().syncBilling();
    await flush();
    expect(apiA.clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(resolveSync).not.toBeNull();

    // Switch to owner B while A's request is still open.
    const apiB = server({ access: access(false, 0) });
    configure(apiB.clients, memoryStorage(), OWNER_B);

    // A's premium answer arrives late.
    resolveSync!({ billing: billing(true, FUTURE), access: access(true) });
    await act(async () => {
      await inFlight;
    });
    await flush();
    const state = useAccessStore.getState();
    expect(state.canonicalBilling).toBeNull();
    expect(state.canonicalAccess).toBeNull();
    expect(selectMembershipState(state).kind).toBe('unverified');

    const renderer = await renderSettings();
    expect(membershipValue(renderer)).toBe('2 free ratings left');
    expect(manageRows(renderer)).toHaveLength(0);
    expect(useAccessStore.getState().canonicalBilling).toBeNull();
  });
});

describe('A7 corrupt / foreign persisted journal', () => {
  it.each([
    ['garbage object', { owner: OWNER_A, id: 'not-a-uuid', attempts: -1 }],
    [
      'record journaled under another owner',
      { ...pendingRecord('purchase'), owner: OWNER_B },
    ],
    ['non-object value', 'purchase-pending'],
  ])(
    'HOLDs (no price, no purchase, no invented entitlement) for %s',
    async (_name, corrupt) => {
      const api = server({ access: access(true) });
      configure(api.clients, corruptStorage(corrupt));
      const settings = await renderSettings();
      expect(membershipValue(settings)).toBe('Verification on hold');
      expect(manageRows(settings)).toHaveLength(0);
      expect(api.clients.backend.getAccess).not.toHaveBeenCalled();
      act(() => settings.unmount());
      mounted = null;

      const paywall = await renderPaywall();
      const copy = allText(paywall);
      expect(copy).toContain('VERIFICATION ON HOLD');
      expect(copy).not.toContain('MEMBERSHIP VERIFIED');
      await act(async () => {
        byTestId(paywall, 'paywall-see-plans').props.onPress();
      });
      await flush();
      expectNoInventedPrice(allText(paywall));
      expect(byTestId(paywall, 'paywall-continue').props.disabled).toBe(true);
      expect(byTestId(paywall, 'paywall-restore').props.disabled).toBe(true);
      expect(api.clients.store.purchase).not.toHaveBeenCalled();
      expect(api.clients.store.restore).not.toHaveBeenCalled();
    },
  );
});

describe('A8 Manage subscription: link failure and double tap', () => {
  it('falls back to a notice on openURL failure and never reaches StoreKit on rapid double taps', async () => {
    const api = server({
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    });
    configure(api.clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    (Linking.openURL as jest.Mock).mockRejectedValue(
      new Error('LSApplicationQueriesSchemes'),
    );
    const settings = await renderSettings();
    const [manage] = manageRows(settings);
    await act(async () => {
      manage!.props.onPress();
      manage!.props.onPress();
    });
    await flush();
    expect(Linking.openURL).toHaveBeenCalledTimes(2);
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(2);
    expect(mockShowBrandNotice.mock.calls[0]![0]).toMatchObject({
      title: 'Could not open subscriptions',
    });
    expect(api.clients.store.purchase).not.toHaveBeenCalled();
    expect(api.clients.store.restore).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    // The membership row is untouched by the failure.
    expect(membershipValue(settings)).toBe(
      `Pro active through ${formatMembershipDate(FUTURE)}`,
    );
    act(() => settings.unmount());
    mounted = null;

    const paywall = await renderPaywall();
    await act(async () => {
      byTestId(paywall, 'paywall-manage-subscription').props.onPress();
    });
    await flush();
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(3);
    expect(api.clients.store.purchase).not.toHaveBeenCalled();
  });
});

describe('A9 boundary values on the verified horizon', () => {
  const request = {
    pendingId: pendingRecord().id,
    attemptId: '33333333-3333-4333-8333-333333333333',
    transaction,
  };

  it('treats expiresAt === now as lapsed (same predicate as the server: expires_at > now)', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, iso(T0)),
    });
    expect(state.kind).toBe('grace');
    const nonPremium = describeMembershipState({
      ...baseInput,
      access: access(false, 2),
      billing: billing(true, iso(T0)),
    });
    expect(nonPremium.kind).toBe('expired');
    const oneMsLater = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, iso(T0 + 1)),
    });
    expect(oneMsLater.kind).toBe('fulfilled');
  });

  it('never renders "Invalid Date" or NaN for an unparsable / extreme horizon', () => {
    const inputs: MembershipStateInput[] = [
      { ...baseInput, access: access(true), billing: billing(true, 'garbage') },
      { ...baseInput, access: access(true), billing: billing(true, '') },
      {
        ...baseInput,
        access: access(true),
        billing: billing(true, '+275760-09-13T00:00:00.000Z'),
      },
      {
        ...baseInput,
        access: access(true),
        billing: billing(true, '9999-12-31T23:59:59.000Z'),
      },
      {
        ...baseInput,
        access: access(false, 2),
        billing: billing(true, '0001-01-01T00:00:00.000Z'),
      },
      {
        ...baseInput,
        access: access(true),
        billing: billing(true, FUTURE),
        nowMs: Number.NaN,
      },
      {
        ...baseInput,
        access: access(true),
        billing: billing(true, FUTURE),
        nowMs: -1,
      },
      {
        ...baseInput,
        access: access(true),
        billing: billing(true, FUTURE),
        nowMs: Number.MAX_SAFE_INTEGER,
      },
    ];
    for (const input of inputs) {
      const state = describeMembershipState(input);
      const text = `${state.label} ${state.eyebrow} ${state.title} ${state.detail}`;
      expect(text).not.toMatch(/Invalid Date|NaN|undefined|null/);
      expectNoInventedPrice(text);
      expect(['fulfilled', 'grace', 'expired']).toContain(state.kind);
    }
  });

  it('a clock rolled back before the purchase keeps a verified member fulfilled, not pending', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, FUTURE),
      fulfilmentVerdict: boundVerdict(request, 'fulfilled'),
      nowMs: Date.parse('2020-01-01T00:00:00.000Z'),
    });
    expect(state.kind).toBe('fulfilled');
    expect(state.purchaseAllowed).toBe(false);
  });

  it('a bound pending verdict outranks premium access AND a fresh horizon', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, FUTURE),
      fulfilmentVerdict: boundVerdict(request, 'pending'),
    });
    expect(state.kind).toBe('pending');
    expect(state.purchaseAllowed).toBe(false);
    expect(state.manageSubscription).toBe(false);
  });
});

describe('A10 partial state: server-shaped non-premium snapshot with a past horizon', () => {
  it('a non-premium billing snapshot whose expiresAt has passed is reported as expired, not free', () => {
    // accessApi accepts { premium:false, expiresAt:<iso> } (only shape is
    // validated). The candidate drops the horizon for premium:false rows.
    const state = describeMembershipState({
      ...baseInput,
      access: access(false, 2),
      billing: {
        premium: false,
        productKey: null,
        expiresAt: PAST,
        verifiedAt: VERIFIED_AT,
      },
    });
    expect(state.kind).toBe('expired');
  });
});

describe('A11 partial state: pending error without a journal record', () => {
  it('a pending hero never sits above an ENABLED priced Continue button', async () => {
    const api = server({ access: access(false) });
    configure(api.clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(useAccessStore.getState().plans).not.toBeNull();
    act(() => {
      useAccessStore.setState({
        error: {
          code: 'billing.backend_verification_pending',
          message: 'pending',
          retryable: true,
        },
      });
    });
    const renderer = await renderPaywall();
    await act(async () => {
      byTestId(renderer, 'paywall-see-plans').props.onPress();
    });
    await flush();
    const copy = allText(renderer);
    expect(copy).toContain('VERIFICATION PENDING');
    expect(pressablesWithTestId(renderer, 'paywall-plan-options')).toHaveLength(
      0,
    );
    const cta = byTestId(renderer, 'paywall-continue');
    // The candidate's own pending path disables the CTA under this hero.
    expect([cta.props.disabled, cta.props.accessibilityLabel]).toEqual([
      true,
      'Membership verification pending',
    ]);
  });
});

describe('A12 network: server unreachable after verification keeps truth, never invents it', () => {
  it('keeps the last verified horizon while unreachable and fails closed once a refresh fails', async () => {
    useClock(T0);
    const api = server({
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    });
    configure(api.clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    api.state.sync = new Error('request timed out');
    await act(async () => {
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    expect(useAccessStore.getState().reconciliation.status).toBe('unavailable');
    // Snapshot retained: still the server-verified horizon, no new claim.
    expect(label()).toBe(`Pro active through ${formatMembershipDate(FUTURE)}`);

    api.state.access = new Error('429 Too Many Requests');
    const settings = await renderSettings(); // focus → refreshAccess fails
    expect(membershipValue(settings)).toBe('Verify access');
    expect(manageRows(settings)).toHaveLength(0);
    expect(useAccessStore.getState().canonicalBilling).toBeNull();
    expectNoInventedPrice(allText(settings));
  });
});

describe('A13 copy / accessibility audit of every new state string', () => {
  const forbidden =
    /android|google play|guest mode|guest|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|accura|best|#1|most accurate|as good as a coach|ai coach/i;

  it('no state, hero or Manage subscription copy contains prohibited claims or invented prices', () => {
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
      { ...baseInput, access: access(true), billing: billing(true, null) },
      { ...baseInput, access: access(true), billing: billing(true, PAST) },
      { ...baseInput, fulfilmentVerdict: boundVerdict(request, 'expired') },
      { ...baseInput, fulfilmentVerdict: boundVerdict(request, 'refunded') },
      { ...baseInput, access: access(false, 2), billing: billing(true, PAST) },
      baseInput,
    ];
    for (const input of inputs) {
      const state = describeMembershipState(input);
      for (const recovery of [false, true]) {
        const hero = membershipHeroCopy(state, recovery);
        const text = [
          state.label,
          state.eyebrow,
          state.title,
          state.detail,
          hero?.eyebrow ?? '',
          hero?.title ?? '',
          hero?.detail ?? '',
        ].join(' ');
        expect(text).not.toMatch(forbidden);
        expectNoInventedPrice(text);
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
    expect(
      `${MEMBERSHIP_VERIFICATION_HERO.eyebrow} ${MEMBERSHIP_VERIFICATION_HERO.title} ${MEMBERSHIP_VERIFICATION_HERO.detail}`,
    ).not.toMatch(forbidden);
  });

  it('Manage subscription controls carry a descriptive accessibility label in both surfaces', async () => {
    const api = server({
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    });
    configure(api.clients, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const settings = await renderSettings();
    const [row] = manageRows(settings);
    expect(row!.props.accessibilityLabel).toBe(
      'Manage subscription, App Store',
    );
    expect(row!.props.accessibilityLabel).not.toMatch(forbidden);
    act(() => settings.unmount());
    mounted = null;
    const paywall = await renderPaywall();
    const button = byTestId(paywall, 'paywall-manage-subscription');
    expect(button.props.accessibilityLabel).toBe(
      'Manage subscription in the App Store',
    );
    expect(button.props.accessibilityLabel).not.toMatch(forbidden);
  });
});

describe('A14 process death and restart with a pending purchase journaled', () => {
  it('cold start with a journaled purchase the server still holds pending withholds every offer and price', async () => {
    const api = server({
      access: access(false),
      sync: request => ({
        billing: billing(false, null),
        access: access(false),
        fulfilment: boundVerdict(request!, 'pending'),
      }),
    });
    const storage = memoryStorage(pendingRecord('purchase'));
    configure(api.clients, storage);
    const first = await renderPaywall();
    expect(allText(first)).toContain('VERIFICATION PENDING');
    act(() => first.unmount());
    mounted = null;

    // Process death: memory gone, journal survives, same owner.
    clearAccessStoreConfiguration();
    configure(api.clients, storage);
    const paywall = await renderPaywall();
    expect(api.clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(allText(paywall)).toContain('VERIFICATION PENDING');
    await act(async () => {
      byTestId(paywall, 'paywall-see-plans').props.onPress();
    });
    await flush();
    expectNoInventedPrice(allText(paywall));
    expect(pressablesWithTestId(paywall, 'paywall-plan-options')).toHaveLength(
      0,
    );
    expect(byTestId(paywall, 'paywall-continue').props.disabled).toBe(true);
    expect(byTestId(paywall, 'paywall-restore').props.disabled).toBe(true);
    expect(api.clients.store.purchase).not.toHaveBeenCalled();
    act(() => paywall.unmount());
    mounted = null;

    const settings = await renderSettings();
    expect(membershipValue(settings)).toBe('Verification pending');
    expect(manageRows(settings)).toHaveLength(0);
  });
});
