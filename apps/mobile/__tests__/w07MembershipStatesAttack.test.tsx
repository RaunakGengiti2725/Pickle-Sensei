/**
 * W07-05 adversarial suite (attack branch only — the candidate's own suite is
 * `w07MembershipStates.test.tsx` and is not modified here).
 *
 * Every test states the behaviour the package objective requires — states
 * from SERVER truth, never an invented entitlement, horizon, lapse or price —
 * and drives the candidate through a failure boundary: clock skew, a journal
 * that is corrupt then readable, process death, an interleaved account
 * switch, replayed verdict identities, HTTP failures at each step, double
 * submit, boundary horizons and copy/accessibility.
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
  BILLING_REQUEST_TIMEOUT_MS,
  createCanonicalAccessClient,
} from '../src/billing/accessApi';
import {
  APP_STORE_SUBSCRIPTIONS_URL,
  billingSnapshotAfterAccess,
  describeMembershipState,
  formatMembershipDate,
  type MembershipStateInput,
  type MembershipStateKind,
} from '../src/billing/membershipState';
import {
  BillingError,
  type BillingAccessDependencies,
  type BillingFulfilmentRequest,
  type BillingFulfilmentVerdict,
  type CanonicalAccessState,
  type CanonicalBillingState,
  type CanonicalBillingSync,
  type StorePlans,
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
const NOW_MS = Date.parse('2026-09-08T12:00:00.000Z');
const FUTURE = '2027-03-01T00:00:00.000Z';
const AFTER_FUTURE_MS = Date.parse('2027-03-02T00:00:00.000Z');
const PAST = '2026-09-01T00:00:00.000Z';
const VERIFIED_AT = '2026-09-08T11:59:00.000Z';
const ANNUAL = 'pickle_sensei_pro_annual';

function sessionFor(owner: string): AuthSession {
  return {
    provider: 'apple',
    subject: owner,
    canonicalAppUserId: owner,
    localOnly: false,
    displayName: owner === OWNER_A ? 'Alex Chen' : 'Bao Tran',
    email: owner === OWNER_A ? 'alex@example.com' : 'bao@example.com',
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
  productKey = ANNUAL,
  verifiedAt = VERIFIED_AT,
): CanonicalBillingState {
  return {
    premium,
    productKey: premium ? productKey : null,
    expiresAt: premium ? expiresAt : null,
    verifiedAt,
  };
}

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: ANNUAL,
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
  productId: ANNUAL,
  transactionId: '1000000123456789',
  purchasedAt: PAST,
};

type SyncAnswer = CanonicalBillingSync | Promise<CanonicalBillingSync>;

interface ServerTruth {
  access: CanonicalAccessState | (() => Promise<CanonicalAccessState>);
  sync?: (request?: BillingFulfilmentRequest) => SyncAnswer;
}

function dependencies(truth: ServerTruth) {
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
      getAccess: jest.fn(async () =>
        typeof truth.access === 'function' ? truth.access() : truth.access,
      ),
      syncBilling: jest.fn(async (request?: BillingFulfilmentRequest) => {
        if (!truth.sync) throw new Error('sync not exercised');
        return truth.sync(request);
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
  return { storage, records };
}

/** Journal whose first `failures` reads throw, then reads an empty journal. */
function healingStorage(failures: number): PendingFulfilmentStorage {
  let remaining = failures;
  return {
    read: jest.fn(async () => {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error('journal unreadable');
      }
      return null;
    }),
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

function pendingRecord(owner = OWNER_A) {
  return createPendingFulfilment(owner, 'purchase', transaction);
}

function verdict(
  request: BillingFulfilmentRequest,
  outcome: BillingFulfilmentVerdict['outcome'],
  overrides: Partial<BillingFulfilmentVerdict> = {},
): BillingFulfilmentVerdict {
  return { ...request, outcome, verifiedAt: VERIFIED_AT, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  const nodes = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  return nodes.filter(node => {
    for (let up = node.parent; up; up = up.parent) {
      if (up.props.testID === testID && typeof up.props.onPress === 'function')
        return false;
    }
    return true;
  });
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

function selectMembership(now = NOW_MS) {
  return selectMembershipState(useAccessStore.getState(), now);
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
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('ATTACK 1 — device clock ahead of the server (far-future clock boundary)', () => {
  // The sync answer arrives while Date.now() is already past the horizon
  // the server just called active. The client can prove that is clock skew,
  // not a lapsed period: the server said "active until FUTURE" at the very
  // moment this answer was received.
  it('a sync answer that names an active period is never described as a period that has ended', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    };
    configure(dependencies(truth), memoryStorage().storage);
    jest.spyOn(Date, 'now').mockReturnValue(AFTER_FUTURE_MS);
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    expect(useAccessStore.getState().canonicalBilling).toEqual(
      billing(true, FUTURE),
    );
    const state = selectMembership(AFTER_FUTURE_MS);
    expect(state.kind).toBe('fulfilled');
    expect(state.detail).not.toMatch(/ended/i);
    expect(state.label).not.toMatch(/not yet loaded/i);
  });

  it('a subscription the server just verified keeps Manage subscription across the next access-only answer', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    };
    const clients = dependencies(truth);
    configure(clients, memoryStorage().storage);
    jest.spyOn(Date, 'now').mockReturnValue(AFTER_FUTURE_MS);
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    expect(selectMembership(AFTER_FUTURE_MS).manageSubscription).toBe(true);
    const renderer = await renderSettings();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(2);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(manageRows(renderer)).toHaveLength(1);
    expect(membershipValue(renderer)).not.toBe('Pro active');
  });
});

describe('ATTACK 2 — journal corrupt then readable, server unreachable (corrupt/partial state + network failure)', () => {
  it('Retry after a HOLD whose journal now reads empty does not report a pending verification that does not exist', async () => {
    const storage = healingStorage(1);
    const clients = dependencies({ access: access(false) });
    configure(clients, storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(selectMembership().kind).toBe('hold');

    await act(async () => {
      await useAccessStore.getState().retryPendingFulfilment();
    });
    const state = useAccessStore.getState();
    expect(state.pendingFulfilment).toBeNull();
    expect(state.fulfilmentStatus).toBe('clear');
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    const membership = selectMembership();
    expect(membership.kind).not.toBe('pending');
    expect(membership.label).not.toBe('Verification pending');
  });

  it('forced reconcile with an empty journal and a 5xx server does not label a free account "Verification pending"', async () => {
    const storage = healingStorage(1);
    const clients = dependencies({
      access: access(false),
      sync: () => {
        throw new BillingError(
          'billing.backend_unavailable',
          'Membership verification is temporarily unavailable.',
          true,
        );
      },
    });
    configure(clients, storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(selectMembership().kind).toBe('hold');

    await act(async () => {
      await useAccessStore.getState().reconcileBilling({ force: true });
    });
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(access(false));
    expect(state.pendingFulfilment).toBeNull();
    expect(state.fulfilmentStatus).toBe('clear');
    expect(state.reconciliation.status).toBe('unavailable');

    // The paywall renders the store as-is (no focus refresh heals it here).
    const renderer = await renderPaywall();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).not.toContain('VERIFICATION PENDING');
    expect(selectMembership().kind).not.toBe('pending');
  });
});

describe('ATTACK 3 — process death after a server-bound expired verdict', () => {
  it('a relaunch still names the expired disposition the server bound to this purchase', async () => {
    const record = pendingRecord();
    const { storage, records } = memoryStorage(record);
    const truth: ServerTruth = {
      access: access(false),
      sync: request => ({
        billing: billing(false, null),
        access: access(false),
        ...(request ? { fulfilment: verdict(request, 'expired') } : {}),
      }),
    };
    configure(dependencies(truth), storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(records.size).toBe(0);
    expect(selectMembership().kind).toBe('expired');

    clearAccessStoreConfiguration();
    configure(dependencies(truth), storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    const relaunched = selectMembership();
    expect(relaunched.kind).toBe('expired');
    expect(relaunched.label).toContain('Membership expired');
  });
});

describe('ATTACK 4 — interleaved account switch (concurrency)', () => {
  it("account A's late sync answer never becomes account B's membership, horizon or Manage subscription", async () => {
    const late = deferred<CanonicalBillingSync>();
    const clientsA = dependencies({
      access: access(true),
      sync: () => late.promise,
    });
    configure(clientsA, memoryStorage().storage, OWNER_A);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    const syncA = useAccessStore.getState().syncBilling();

    const clientsB = dependencies({ access: access(false, 0) });
    configure(clientsB, memoryStorage().storage, OWNER_B);
    late.resolve({ billing: billing(true, FUTURE), access: access(true) });
    await act(async () => {
      await syncA;
    });

    const stateB = useAccessStore.getState();
    expect(stateB.canonicalBilling).toBeNull();
    expect(stateB.canonicalAccess).toBeNull();
    expect(selectMembership()).toMatchObject({
      kind: 'unverified',
      manageSubscription: false,
      horizon: null,
    });

    const renderer = await renderSettings();
    expect(clientsB.backend.getAccess).toHaveBeenCalled();
    expect(membershipValue(renderer)).toBe('2 free ratings left');
    expect(manageRows(renderer)).toHaveLength(0);
    expect(allText(renderer)).not.toContain(formatMembershipDate(FUTURE));
  });

  it("account A's journaled purchase never shows as pending on account B, and switching back restores A's own pending state", async () => {
    const recordA = pendingRecord(OWNER_A);
    const storageA = memoryStorage(recordA);
    const clientsA = dependencies({
      access: access(false),
      sync: request => ({
        billing: billing(false, null),
        access: access(false),
        ...(request ? { fulfilment: verdict(request, 'pending') } : {}),
      }),
    });
    configure(clientsA, storageA.storage, OWNER_A);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(selectMembership().kind).toBe('pending');

    const clientsB = dependencies({ access: access(false, 0) });
    configure(clientsB, memoryStorage().storage, OWNER_B);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(selectMembership()).toMatchObject({
      kind: 'free',
      label: '2 free ratings left',
    });
    expect(useAccessStore.getState().pendingFulfilment).toBeNull();

    configure(clientsA, storageA.storage, OWNER_A);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(selectMembership().kind).toBe('pending');
    expect(storageA.records.size).toBe(1);
  });
});

describe('ATTACK 5 — replayed and duplicate verdict identities', () => {
  const foreign = {
    pendingId: '99999999-9999-4999-8999-999999999999',
    attemptId: '88888888-8888-4888-8888-888888888888',
  };

  async function replay(
    forge: (request: BillingFulfilmentRequest) => BillingFulfilmentVerdict,
  ) {
    const record = pendingRecord();
    const { storage, records } = memoryStorage(record);
    const clients = dependencies({
      access: access(false),
      sync: request => ({
        billing: billing(false, null),
        access: access(false),
        ...(request ? { fulfilment: forge(request) } : {}),
      }),
    });
    configure(clients, storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    return { records, state: useAccessStore.getState() };
  }

  it("an 'expired' verdict replayed from another pending id never settles this purchase", async () => {
    const { records, state } = await replay(request =>
      verdict(request, 'expired', { pendingId: foreign.pendingId }),
    );
    expect(records.size).toBe(1);
    expect(state.fulfilmentVerdict).toBeNull();
    expect(selectMembership().kind).toBe('pending');
  });

  it("an 'expired' verdict replayed from an earlier attempt id never settles this purchase", async () => {
    const { records, state } = await replay(request =>
      verdict(request, 'expired', { attemptId: foreign.attemptId }),
    );
    expect(records.size).toBe(1);
    expect(state.fulfilmentVerdict).toBeNull();
    expect(selectMembership().kind).toBe('pending');
  });

  it("a 'refunded' verdict for a different transaction id never settles this purchase", async () => {
    const { records, state } = await replay(request =>
      verdict(request, 'refunded', {
        transaction: {
          ...request.transaction,
          transactionId: '2000000000000000',
        },
      }),
    );
    expect(records.size).toBe(1);
    expect(state.fulfilmentVerdict).toBeNull();
    expect(selectMembership().kind).not.toBe('expired');
  });

  it('a verdict verified before the purchase happened is a clock-rollback replay and never settles', async () => {
    const { records, state } = await replay(request =>
      verdict(request, 'expired', { verifiedAt: '2026-08-31T23:59:59.000Z' }),
    );
    expect(records.size).toBe(1);
    expect(state.fulfilmentVerdict).toBeNull();
    expect(selectMembership().kind).toBe('pending');
  });

  it("a 'fulfilled' verdict beside a non-premium access answer never invents entitlement", async () => {
    const { state } = await replay(request => verdict(request, 'fulfilled'));
    expect(state.canonicalAccess?.premium).toBe(false);
    const membership = selectMembership();
    expect(membership.kind).not.toBe('fulfilled');
    expect(membership.label).not.toMatch(/Pro active/);
  });
});

describe('ATTACK 6 — HTTP failure at the sync step of a pending purchase (real access client)', () => {
  function clientWith(
    fetchFn: jest.Mock<Promise<Response>, [string, RequestInit?]>,
  ) {
    return createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: 'bearer-test-token',
      fetchFn,
    });
  }

  function response(
    status: number,
    body: unknown = {},
    headers: Record<string, string> = {},
  ): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      json: async () => body,
    } as Response;
  }

  async function pendingPurchaseAgainst(
    fetchFn: jest.Mock<Promise<Response>, [string, RequestInit?]>,
  ) {
    const record = pendingRecord();
    const { storage, records } = memoryStorage(record);
    const clients = dependencies({ access: access(false) });
    const backend = clientWith(fetchFn);
    configure(
      {
        store: clients.store,
        backend: { ...backend, getAccess: clients.backend.getAccess },
      },
      storage,
    );
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    return { clients, records };
  }

  async function expectHoldWithNothingInvented(
    clients: ReturnType<typeof dependencies>,
    records: Map<string, string>,
  ) {
    expect(records.size).toBe(1);
    const membership = selectMembership();
    expect(membership).toMatchObject({
      kind: 'hold',
      purchaseAllowed: false,
      manageSubscription: false,
      horizon: null,
    });
    const renderer = await renderPaywall();
    const text = allText(renderer);
    expectNoInventedPrice(text);
    expect(pressablesWithTestId(renderer, 'paywall-continue')).toHaveLength(0);
    expect(pressablesWithTestId(renderer, 'paywall-plan-annual')).toHaveLength(
      0,
    );
    await act(async () => {
      expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    });
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
  }

  it('429 + Retry-After', async () => {
    const fetchFn = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () => response(429, {}, { 'Retry-After': '30' }),
    );
    const { clients, records } = await pendingPurchaseAgainst(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await expectHoldWithNothingInvented(clients, records);
  });

  it('503', async () => {
    const fetchFn = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () => response(503),
    );
    const { clients, records } = await pendingPurchaseAgainst(fetchFn);
    await expectHoldWithNothingInvented(clients, records);
  });

  it('302 redirect surfaced as a non-OK response', async () => {
    const fetchFn = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () => response(302, {}, { Location: 'https://elsewhere.test/' }),
    );
    const { clients, records } = await pendingPurchaseAgainst(fetchFn);
    await expectHoldWithNothingInvented(clients, records);
  });

  it('200 with a body that grants premium billing beside non-premium access is rejected, never trusted', async () => {
    const fetchFn = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () =>
        response(200, {
          billing: billing(true, FUTURE),
          access: access(false),
        }),
    );
    const { clients, records } = await pendingPurchaseAgainst(fetchFn);
    expect(useAccessStore.getState().canonicalBilling).toBeNull();
    await expectHoldWithNothingInvented(clients, records);
  });

  it('timeout: a request that never answers holds, does not invent state, and does not re-submit the purchase', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn<Promise<Response>, [string, RequestInit?]>(
      () => new Promise<Response>(() => undefined),
    );
    const record = pendingRecord();
    const { storage, records } = memoryStorage(record);
    const clients = dependencies({ access: access(false) });
    const backend = clientWith(fetchFn);
    configure(
      {
        store: clients.store,
        backend: { ...backend, getAccess: clients.backend.getAccess },
      },
      storage,
    );
    const initialize = useAccessStore.getState().initialize();
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      jest.advanceTimersByTime(BILLING_REQUEST_TIMEOUT_MS + 1);
      await initialize;
    });
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(records.size).toBe(1);
    expect(selectMembership()).toMatchObject({
      kind: 'hold',
      purchaseAllowed: false,
    });
    await act(async () => {
      expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    });
    expect(clients.store.purchase).not.toHaveBeenCalled();
  });
});

describe('ATTACK 7 — double submit', () => {
  it('two rapid Retry presses on the pending paywall issue exactly one sync request and never a store purchase', async () => {
    const record = pendingRecord();
    const gate = deferred<CanonicalBillingSync>();
    const clients = dependencies({
      access: access(false),
      sync: () => gate.promise,
    });
    configure(clients, memoryStorage(record).storage);
    const renderer = await renderPaywall();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    gate.resolve({ billing: billing(false, null), access: access(false) });
    await flush();
    expect(selectMembership().kind).toBe('pending');

    const second = deferred<CanonicalBillingSync>();
    clients.backend.syncBilling.mockImplementation(async () => second.promise);
    const [retry] = pressablesWithTestId(renderer, 'paywall-retry');
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.props.onPress();
      retry!.props.onPress();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    second.resolve({ billing: billing(false, null), access: access(false) });
    await flush();
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
  });

  it('Manage subscription pressed twice opens the App Store twice and never touches the store client', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    };
    const clients = dependencies(truth);
    configure(clients, memoryStorage().storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const renderer = await renderPaywall();
    const [manage] = pressablesWithTestId(
      renderer,
      'paywall-manage-subscription',
    );
    expect(manage).toBeDefined();
    await act(async () => {
      manage!.props.onPress();
      manage!.props.onPress();
    });
    await flush();
    expect(Linking.openURL).toHaveBeenCalledTimes(2);
    expect(Linking.openURL).toHaveBeenCalledWith(APP_STORE_SUBSCRIPTIONS_URL);
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
  });

  it('a rejected Linking.openURL from Settings does not crash and still never invents a state change', async () => {
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    };
    configure(dependencies(truth), memoryStorage().storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
    const renderer = await renderSettings();
    const [row] = manageRows(renderer);
    expect(row).toBeDefined();
    await act(async () => {
      row!.props.onPress();
    });
    await flush();
    expect(selectMembership()).toMatchObject({
      kind: 'fulfilled',
      horizon: FUTURE,
      manageSubscription: true,
    });
    expect(manageRows(renderer)).toHaveLength(1);
  });
});

describe('ATTACK 8 — boundary horizons and malformed server values', () => {
  it('a horizon equal to now is the grace boundary and is dropped by the very next access-only answer (no stale horizon survives)', () => {
    const atNow = new Date(NOW_MS).toISOString();
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, atNow),
    });
    expect(state.kind).toBe('grace');
    expect(
      billingSnapshotAfterAccess(access(true), billing(true, atNow), NOW_MS),
    ).toBeNull();
    expect(
      billingSnapshotAfterAccess(
        access(true),
        billing(true, atNow),
        NOW_MS - 1,
      ),
    ).toEqual(billing(true, atNow));
  });

  it('a year-275760 horizon renders as a real date without inventing a price or lifetime', () => {
    const far = '+275760-09-13T00:00:00.000Z';
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, far),
    });
    expect(state.kind).toBe('fulfilled');
    expect(state.manageSubscription).toBe(true);
    expect(state.horizon).toBe(far);
    expectNoInventedPrice(`${state.label} ${state.detail}`);
  });

  it('a pre-epoch horizon is a lapsed period, never a live one', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, '1969-12-31T23:59:59.000Z'),
    });
    expect(state.kind).toBe('grace');
    expect(state.label).not.toMatch(/through/);
  });

  it('a malformed horizon in a held snapshot never survives an access answer and never becomes lifetime', () => {
    const broken = billing(true, 'not-a-date');
    expect(billingSnapshotAfterAccess(access(true), broken, NOW_MS)).toBeNull();
    const state = describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: broken,
    });
    expect(state.kind).toBe('fulfilled');
    expect(state.manageSubscription).toBe(false);
    expect(state.horizon).toBeNull();
  });

  it('NaN and negative clocks never grant a horizon that the server did not', () => {
    for (const nowMs of [Number.NaN, -1, Number.MAX_SAFE_INTEGER]) {
      const state = describeMembershipState({
        ...baseInput,
        access: access(true),
        billing: billing(true, FUTURE),
        nowMs,
      });
      expect(['fulfilled', 'grace']).toContain(state.kind);
      expect(state.horizon).toBe(FUTURE);
      expectNoInventedPrice(`${state.label} ${state.detail}`);
    }
    const nonPremium = describeMembershipState({
      ...baseInput,
      access: access(false),
      billing: billing(true, FUTURE),
      nowMs: Number.NaN,
    });
    expect(nonPremium.kind).toBe('free');
    expect(nonPremium.manageSubscription).toBe(false);
  });
});

describe('ATTACK 9 — copy and accessibility across every state', () => {
  const inputs: Record<MembershipStateKind, MembershipStateInput> = {
    unverified: { ...baseInput, access: null },
    pending: {
      ...baseInput,
      pendingFulfilment: pendingRecord(),
      fulfilmentStatus: 'pending',
    },
    hold: { ...baseInput, fulfilmentStatus: 'unavailable' },
    fulfilled: {
      ...baseInput,
      access: access(true),
      billing: billing(true, FUTURE),
    },
    grace: {
      ...baseInput,
      access: access(true),
      billing: billing(true, PAST),
      reconciliationStatus: 'unavailable',
    },
    expired: {
      ...baseInput,
      fulfilmentVerdict: verdict(
        {
          pendingId: pendingRecord().id,
          attemptId: pendingRecord().id,
          transaction,
        },
        'refunded',
      ),
    },
    free: { ...baseInput, access: access(false, 2) },
  };

  const forbidden =
    /android|google play|guest|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|\bbest\b|#1|most accurate|world[- ]class|as good as a coach|guarantee/i;

  it('no membership state names a forbidden term, a price, or a server report the client has not received', () => {
    for (const kind of Object.keys(inputs) as MembershipStateKind[]) {
      const state = describeMembershipState(inputs[kind]);
      expect(state.kind).toBe(kind);
      const text = `${state.label} ${state.eyebrow} ${state.title} ${state.detail}`;
      expect(text).not.toMatch(forbidden);
      expectNoInventedPrice(text);
      expect(text).not.toMatch(/server still reports|has not re-verified/i);
      expect(state.eyebrow).toBe(state.eyebrow.toUpperCase());
    }
  });

  it('Settings exposes the membership row and the Manage subscription row with readable accessibility labels at a large font scale', async () => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 2 });
    const truth: ServerTruth = {
      access: access(true),
      sync: () => ({ billing: billing(true, FUTURE), access: access(true) }),
    };
    configure(dependencies(truth), memoryStorage().storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().syncBilling();
    });
    const renderer = await renderSettings();
    expect(membershipValue(renderer)).toBe(
      `Pro active through ${formatMembershipDate(FUTURE)}`,
    );
    const [manage] = manageRows(renderer);
    expect(manage?.props.accessibilityLabel).toBe(
      'Manage subscription, App Store',
    );
    expect(manage?.props.accessibilityRole ?? 'button').toBe('button');
  });

  it('the pending paywall hero explains the state without a price, a purchase button, or a plan card', async () => {
    const record = pendingRecord();
    const clients = dependencies({
      access: access(false),
      sync: request => ({
        billing: billing(false, null),
        access: access(false),
        ...(request ? { fulfilment: verdict(request, 'pending') } : {}),
      }),
    });
    configure(clients, memoryStorage(record).storage);
    const renderer = await renderPaywall();
    const text = allText(renderer);
    expect(text).toContain('Verify your membership.');
    expectNoInventedPrice(text);
    expect(text).not.toMatch(forbidden);
    expect(pressablesWithTestId(renderer, 'paywall-continue')).toHaveLength(0);
    expect(pressablesWithTestId(renderer, 'paywall-plan-annual')).toHaveLength(
      0,
    );
    expect(
      pressablesWithTestId(renderer, 'paywall-retry').length,
    ).toBeGreaterThan(0);
  });
});
