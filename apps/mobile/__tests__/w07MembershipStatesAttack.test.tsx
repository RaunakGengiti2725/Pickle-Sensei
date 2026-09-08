/**
 * W07-05 ADVERSARIAL ATTACKS against candidate 2b257a064f1fdf852ebd6a5910229beb03c54f23.
 *
 * Every `it` below is one attack at a failure boundary of the membership
 * presentation (Settings row + Paywall). An attack that passes did not break
 * the candidate; a failing attack is a confirmed break and is reported with
 * its observed/expected values. Nothing here touches the candidate's
 * production code or its own regression suite.
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
  APP_STORE_SUBSCRIPTIONS_URL,
  describeMembershipState,
  formatMembershipDate,
  type MembershipState,
  type MembershipStateInput,
} from '../src/billing/membershipState';
import { createCanonicalAccessClient } from '../src/billing/accessApi';
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

const sessionFor = (owner: string): AuthSession => ({
  provider: 'apple',
  subject: owner,
  canonicalAppUserId: owner,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
});

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

interface ServerTruth {
  access: CanonicalAccessState;
  sync?: (request?: BillingFulfilmentRequest) => CanonicalBillingSync;
}

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

/** A journal whose read resolves to a structurally corrupt record. */
function corruptStorage(value: unknown): PendingFulfilmentStorage {
  return {
    read: jest.fn(async () => value as PendingFulfilment | null),
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
  outcome: BillingFulfilmentVerdict['outcome'],
  verifiedAt = VERIFIED_AT,
): BillingFulfilmentVerdict {
  return { ...request, outcome, verifiedAt };
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

function pendingRecord(
  source: 'purchase' | 'restore' = 'purchase',
  owner = OWNER_A,
) {
  return createPendingFulfilment(
    owner,
    source,
    source === 'purchase' ? transaction : undefined,
  );
}

function selectMembership(now = NOW_MS) {
  return selectMembershipState(useAccessStore.getState(), now);
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
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ATTACK 1 — stale premium billing snapshot survives a non-premium access
// answer and re-attaches to a later, unrelated premium grant.
//
// Real server contract (supabase/functions/api/index.ts POST /v1/billing/sync
// + effectivePremium()): billing.premium === access.premium, and a premium
// row is only reported premium while expires_at > now. So when GET
// /v1/me/access answers premium:false, every horizon the client holds is
// superseded; when it later answers premium:true again, the client knows
// NOTHING about the new horizon or product until it re-syncs. A cold start
// in that state renders 'Pro active' with no Manage subscription.
// ---------------------------------------------------------------------------
describe('ATTACK 1 — stale canonicalBilling re-attached to a later premium grant', () => {
  it('renders the revoked FUTURE horizon + Manage subscription after refund → re-grant (lifetime bought elsewhere)', async () => {
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

    // Server revokes the annual (refund): access answers non-premium.
    truth.access = access(false, 2);
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    expect(selectMembership().kind).toBe('free');

    // Server grants premium again (a LIFETIME purchase completed on another
    // device). The client has not re-synced billing; the only server-stated
    // horizon it holds belongs to the refunded annual.
    truth.access = access(true);
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    const afterRegrant = selectMembership();

    // Ground truth for the same server state on a cold start.
    clearAccessStoreConfiguration();
    const cold = dependencies({ access: access(true) });
    configure(cold, memoryStorage());
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    const coldStart = selectMembership();
    expect(coldStart).toMatchObject({
      kind: 'fulfilled',
      label: 'Pro active',
      manageSubscription: false,
      horizon: null,
    });

    // BREAK: the revoked horizon and a Manage subscription entry come back.
    expect(afterRegrant.horizon).toBe(coldStart.horizon);
    expect(afterRegrant.manageSubscription).toBe(coldStart.manageSubscription);
    expect(afterRegrant.label).toBe(coldStart.label);
  });

  it('Settings shows a Manage subscription row and a revoked horizon to a member the server re-granted without a subscription horizon', async () => {
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
    const renderer = await renderSettings(); // focus → refreshAccess()
    expect(clients.backend.getAccess).toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    // BREAK: the row states the refunded subscription's horizon and offers
    // Manage subscription although the server's latest answer carries no
    // subscription horizon at all.
    expect(membershipValue(renderer)).toBe('Pro active');
    expect(manageRows(renderer)).toHaveLength(0);
  });

  it('grace copy claims the server "has not re-verified a renewal yet" right after the server re-verified premium past that horizon', async () => {
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
    // Time passes beyond the horizon; Settings focus asks the server, which
    // answers premium — under effectivePremium() that is only possible with
    // a NEWER expires_at (i.e. the renewal IS verified server-side).
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    const state = selectMembership(AFTER_FUTURE_MS);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    // BREAK: the client contradicts the answer it just received.
    expect(state.detail).not.toMatch(/has not re-verified a renewal/i);
    expect(state.label).not.toContain('renewal unconfirmed');
  });
});

// ---------------------------------------------------------------------------
// ATTACK 2 — process death between the server's terminal disposition and
// the next launch: the "expired" state is in-memory only.
// ---------------------------------------------------------------------------
describe('ATTACK 2 — expired disposition across process death / relaunch', () => {
  it('reads "Membership expired" before relaunch and "Upgrade required" after, for the same server truth', async () => {
    const storage = memoryStorage(pendingRecord('purchase'));
    const clients = dependencies({
      access: access(false, 2),
      sync: request => ({
        billing: billing(false, null),
        access: access(false, 2),
        fulfilment: boundVerdict(request!, 'expired'),
      }),
    });
    configure(clients, storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    const beforeRelaunch = selectMembership();
    expect(beforeRelaunch.kind).toBe('expired');

    // Relaunch: fresh store over the same durable journal (the record was
    // removed once the server settled it, exactly as on-device).
    clearAccessStoreConfiguration();
    const relaunched = dependencies({ access: access(false, 2) });
    configure(relaunched, storage);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    const afterRelaunch = selectMembership();
    // BREAK (minor): the server-bound terminal verdict is presented on one
    // launch and silently becomes a plain "Upgrade required" on the next.
    expect(afterRelaunch.kind).toBe(beforeRelaunch.kind);
    expect(afterRelaunch.label).toBe(beforeRelaunch.label);
  });
});

// ---------------------------------------------------------------------------
// ATTACK 3 — free-rating ledger conservation in the expired state: the
// server still grants 2 free ratings, but the Settings row (documented in
// SettingsScreen as stating the server's free-rating ledger) hides them.
// ---------------------------------------------------------------------------
describe('ATTACK 3 — expired state hides the server free-rating ledger', () => {
  it('Settings row drops "2 free ratings left" for a refunded buyer who never spent one', async () => {
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
    const state = selectMembership();
    expect(state.kind).toBe('expired');
    expect(useAccessStore.getState().canonicalAccess).toMatchObject({
      canStartRating: true,
      freeRatings: { availableToReserve: 2 },
    });
    // BREAK (minor): the ledger the server reports is not stated anywhere
    // in the membership row while the verdict is displayed.
    expect(membershipValue(renderer)).toMatch(/2 free ratings left/);
  });

  it('Paywall value page drops the free allowance copy while expired', async () => {
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
    expect(copy).toMatch(/2 free ratings/);
  });
});

// ---------------------------------------------------------------------------
// ATTACK 4 — copy: the pending/HOLD detail promises "nothing more will be
// charged". The app never charges; the App Store does, and an auto-renewing
// subscription keeps renewing regardless of the client's verification state.
// No grounded fact in APP_STORE_SUBMISSION.md / AGENTS.md supports a
// charging guarantee.
// ---------------------------------------------------------------------------
describe('ATTACK 4 — invented billing guarantee in membership copy', () => {
  const states: Array<[string, MembershipStateInput]> = [
    [
      'pending (non-member)',
      {
        ...baseInput,
        pendingFulfilment: pendingRecord('purchase'),
        fulfilmentStatus: 'pending',
      },
    ],
    [
      'pending (member)',
      {
        ...baseInput,
        access: access(true),
        pendingFulfilment: pendingRecord('purchase'),
        fulfilmentStatus: 'pending',
      },
    ],
    ['hold', { ...baseInput, fulfilmentStatus: 'unavailable' }],
    [
      'hold (member)',
      { ...baseInput, access: access(true), fulfilmentStatus: 'unavailable' },
    ],
  ];

  it.each(states)(
    '%s copy asserts no charging guarantee the client cannot verify',
    (_name, input) => {
      const state: MembershipState = describeMembershipState(input);
      const copy = `${state.label} ${state.eyebrow} ${state.title} ${state.detail}`;
      expect(copy).not.toMatch(/nothing more will be charged/i);
      expect(copy).not.toMatch(/will (not|never) be charged/i);
    },
  );
});

// ---------------------------------------------------------------------------
// ATTACK 5 — interleaved account switch while account A's billing sync is
// in flight: A's late premium answer must never reach account B.
// ---------------------------------------------------------------------------
describe('ATTACK 5 — interleaved account switch during billing verification', () => {
  it('drops A’s late premium horizon after switching to B; B stays on its own server truth', async () => {
    const lateAnswer = deferred<CanonicalBillingSync>();
    const clientsA = {
      ...dependencies({ access: access(true) }),
      backend: {
        getAccess: jest.fn(async () => access(true)),
        syncBilling: jest.fn(() => lateAnswer.promise),
      },
    } satisfies BillingAccessDependencies;
    configure(clientsA, memoryStorage(), OWNER_A);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    const syncA = useAccessStore.getState().syncBilling();
    await flush();
    expect(clientsA.backend.syncBilling).toHaveBeenCalledTimes(1);

    // Account switch while A's request is outstanding.
    const clientsB = dependencies({ access: access(false, 0) });
    configure(clientsB, memoryStorage(), OWNER_B);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(selectMembership().label).toBe('2 free ratings left');

    lateAnswer.resolve({
      billing: billing(true, FUTURE),
      access: access(true),
    });
    await act(async () => {
      await syncA;
    });
    await flush();
    const state = selectMembership();
    expect(useAccessStore.getState().canonicalBilling).toBeNull();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    expect(state).toMatchObject({
      kind: 'free',
      manageSubscription: false,
      horizon: null,
    });
    const renderer = await renderSettings();
    expect(manageRows(renderer)).toHaveLength(0);
    expect(membershipValue(renderer)).toBe('2 free ratings left');
  });

  it('a pending verdict bound to A’s purchase never labels B’s account', async () => {
    const verdictAnswer = deferred<CanonicalBillingSync>();
    let requestA: BillingFulfilmentRequest | undefined;
    const clientsA = {
      ...dependencies({ access: access(false, 2) }),
      backend: {
        getAccess: jest.fn(async () => access(false, 2)),
        syncBilling: jest.fn((request?: BillingFulfilmentRequest) => {
          requestA = request;
          return verdictAnswer.promise;
        }),
      },
    } satisfies BillingAccessDependencies;
    configure(clientsA, memoryStorage(pendingRecord('purchase')), OWNER_A);
    const initA = useAccessStore.getState().initialize();
    await flush();
    expect(requestA).toBeDefined();

    const clientsB = dependencies({ access: access(false, 1) });
    configure(clientsB, memoryStorage(), OWNER_B);
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    verdictAnswer.resolve({
      billing: billing(false, null),
      access: access(false, 2),
      fulfilment: boundVerdict(requestA!, 'refunded'),
    });
    await act(async () => {
      await initA;
    });
    await flush();
    expect(useAccessStore.getState().fulfilmentVerdict).toBeNull();
    expect(selectMembership()).toMatchObject({
      kind: 'free',
      label: '1 free rating left',
    });
  });
});

// ---------------------------------------------------------------------------
// ATTACK 6 — double submit: Retry verification tapped twice while the first
// verification is in flight must issue exactly one server request.
// ---------------------------------------------------------------------------
describe('ATTACK 6 — double-submit Retry verification', () => {
  it('a second Retry tap during an in-flight verification issues no second sync and no store call', async () => {
    const answer = deferred<CanonicalBillingSync>();
    const clients = {
      ...dependencies({ access: access(false, 2) }),
      backend: {
        getAccess: jest.fn(async () => access(false, 2)),
        syncBilling: jest.fn(() => answer.promise),
      },
    } satisfies BillingAccessDependencies;
    configure(clients, memoryStorage(pendingRecord('purchase')));
    const renderer = await renderPaywall();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('VERIFICATION PENDING');
    const retry = byTestId(renderer, 'paywall-retry');
    expect(retry.props.disabled).toBe(true);
    await act(async () => {
      retry.props.onPress();
      retry.props.onPress();
    });
    await flush();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    answer.resolve({
      billing: billing(false, null),
      access: access(false, 2),
    });
    await flush();
    expect(selectMembership().kind).toBe('pending');
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ATTACK 7 — replayed / mis-bound dispositions: a verdict that is not bound
// to THIS attempt must never settle (expire/refund) or fulfil the purchase.
// ---------------------------------------------------------------------------
describe('ATTACK 7 — replayed and duplicate fulfilment identities', () => {
  const tamper: Array<
    [string, (request: BillingFulfilmentRequest) => BillingFulfilmentVerdict]
  > = [
    [
      'foreign pendingId',
      request => boundVerdict({ ...request, pendingId: OWNER_B }, 'refunded'),
    ],
    [
      'stale attemptId (replay of an earlier attempt)',
      request =>
        boundVerdict(
          { ...request, attemptId: '33333333-3333-4333-8333-333333333333' },
          'expired',
        ),
    ],
    [
      'different transaction id',
      request =>
        boundVerdict(
          {
            ...request,
            transaction: { ...request.transaction, transactionId: '1' },
          },
          'refunded',
        ),
    ],
    [
      'verifiedAt before the purchase',
      request => boundVerdict(request, 'expired', '2020-01-01T00:00:00.000Z'),
    ],
    [
      'verifiedAt NaN',
      request => boundVerdict(request, 'refunded', 'not-a-date'),
    ],
  ];

  it.each(tamper)(
    '%s → stays pending, never expired/refunded, no purchase offered',
    async (_name, forge) => {
      const clients = dependencies({
        access: access(false, 2),
        sync: request => ({
          billing: billing(false, null),
          access: access(false, 2),
          fulfilment: forge(request!),
        }),
      });
      const storage = memoryStorage(pendingRecord('purchase'));
      configure(clients, storage);
      await act(async () => {
        await useAccessStore.getState().initialize();
      });
      const state = selectMembership();
      expect(state.kind).toBe('pending');
      expect(state.purchaseAllowed).toBe(false);
      expect(useAccessStore.getState().fulfilmentVerdict).toBeNull();
      expect(useAccessStore.getState().pendingFulfilment).not.toBeNull();
      expect(storage.remove).not.toHaveBeenCalled();
    },
  );

  it('a forged "fulfilled" verdict beside non-premium access never renders fulfilled', async () => {
    const clients = dependencies({
      access: access(false, 2),
      sync: request => ({
        billing: billing(false, null),
        access: access(false, 2),
        fulfilment: boundVerdict(request!, 'fulfilled'),
      }),
    });
    configure(clients, memoryStorage(pendingRecord('purchase')));
    const renderer = await renderSettings();
    expect(selectMembership().kind).toBe('pending');
    expect(membershipValue(renderer)).toBe('Verification pending');
    expect(manageRows(renderer)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ATTACK 8 — boundary horizons and device clock: empty, garbage, epoch,
// max/overflow dates, exact-now, far-future device clock and rollback.
// ---------------------------------------------------------------------------
describe('ATTACK 8 — boundary horizons and clock rollback', () => {
  const premiumWith = (expiresAt: string | null, nowMs = NOW_MS) =>
    describeMembershipState({
      ...baseInput,
      access: access(true),
      billing: billing(true, expiresAt),
      nowMs,
    });

  it.each([
    ['empty string', ''],
    ['garbage', 'not-a-date'],
    ['beyond the max date (NaN)', '+275761-01-01T00:00:00.000Z'],
    ['whitespace', '   '],
  ])(
    '%s horizon → fulfilled without a horizon or Manage subscription',
    (_name, expiresAt) => {
      const state = premiumWith(expiresAt);
      expect(state).toMatchObject({
        kind: 'fulfilled',
        label: 'Pro active',
        horizon: null,
        manageSubscription: false,
      });
      expect(state.detail).not.toMatch(/Invalid Date/);
    },
  );

  it('max representable date stays fulfilled with a rendered horizon and no "Invalid Date"', () => {
    const max = '+275760-09-13T00:00:00.000Z';
    const state = premiumWith(max);
    expect(state.kind).toBe('fulfilled');
    expect(state.manageSubscription).toBe(true);
    expect(state.label).not.toMatch(/Invalid Date|NaN/);
    expect(state.detail).not.toMatch(/Invalid Date|NaN/);
  });

  it.each([
    ['epoch', '1970-01-01T00:00:00.000Z'],
    ['far past', '0001-01-01T00:00:00.000Z'],
    ['exactly now', new Date(NOW_MS).toISOString()],
    ['one ms ago', new Date(NOW_MS - 1).toISOString()],
  ])(
    '%s horizon → grace, never expired, never a new offer',
    (_name, expiresAt) => {
      const state = premiumWith(expiresAt);
      expect(state).toMatchObject({
        kind: 'grace',
        purchaseAllowed: false,
        manageSubscription: true,
      });
      expect(state.label).not.toMatch(/Invalid Date|NaN/);
    },
  );

  it('one ms before the horizon is still fulfilled', () => {
    expect(premiumWith(FUTURE, Date.parse(FUTURE) - 1).kind).toBe('fulfilled');
  });

  it('device clock far ahead then rolled back leaves no sticky state', () => {
    expect(premiumWith(FUTURE, AFTER_FUTURE_MS).kind).toBe('grace');
    expect(premiumWith(FUTURE, NOW_MS).kind).toBe('fulfilled');
    expect(premiumWith(FUTURE, 0).kind).toBe('fulfilled');
    expect(premiumWith(FUTURE, -8.64e15).kind).toBe('fulfilled');
  });

  it('NaN device clock never yields expired or a purchase offer to a member', () => {
    const state = premiumWith(FUTURE, Number.NaN);
    expect(state.kind).not.toBe('expired');
    expect(state.kind).not.toBe('free');
    expect(state.purchaseAllowed).toBe(false);
  });

  it('non-premium billing carrying a stale expiresAt never becomes expired or grace', () => {
    const state = describeMembershipState({
      ...baseInput,
      access: access(false, 2),
      billing: {
        premium: false,
        productKey: 'pickle_sensei_pro_annual',
        expiresAt: PAST,
        verifiedAt: VERIFIED_AT,
      },
    });
    expect(state).toMatchObject({
      kind: 'free',
      label: 'Upgrade required',
      manageSubscription: false,
    });
  });
});

// ---------------------------------------------------------------------------
// ATTACK 9 — corrupt / partial persisted journal records.
// ---------------------------------------------------------------------------
describe('ATTACK 9 — corrupt or partial persisted billing journal', () => {
  const valid = pendingRecord('purchase');
  const corrupt: Array<[string, unknown]> = [
    ['partial record (owner only)', { owner: OWNER_A }],
    ['record for another owner', { ...valid, owner: OWNER_B }],
    ['negative attempts', { ...valid, attempts: -1, lastAttemptAtMs: NOW_MS }],
    [
      'attempts above the cap',
      { ...valid, attempts: 32, lastAttemptAtMs: NOW_MS },
    ],
    ['NaN completedAtMs', { ...valid, completedAtMs: Number.NaN }],
    ['unknown state', { ...valid, state: 'fulfilled' }],
    ['schema v2 without transaction', { ...valid, transaction: undefined }],
    [
      'transaction with empty ids',
      {
        ...valid,
        transaction: { productId: '', transactionId: '', purchasedAt: PAST },
      },
    ],
    ['array instead of record', [valid]],
    ['string instead of record', JSON.stringify(valid)],
  ];

  it.each(corrupt)(
    '%s → HOLD, no plan, no purchase, no invented entitlement',
    async (_name, value) => {
      const clients = dependencies({ access: access(true) });
      configure(clients, corruptStorage(value));
      const renderer = await renderPaywall();
      const state = selectMembership();
      expect(state.kind).toBe('hold');
      expect(state.purchaseAllowed).toBe(false);
      expect(state.manageSubscription).toBe(false);
      expect(useAccessStore.getState().canonicalAccess).toBeNull();
      expect(clients.backend.getAccess).not.toHaveBeenCalled();
      const copy = allText(renderer);
      expect(copy).toContain('VERIFICATION ON HOLD');
      expect(copy).not.toContain(plans.annual!.priceString);
      expect(copy).not.toContain('MEMBERSHIP VERIFIED');
    },
  );
});

// ---------------------------------------------------------------------------
// ATTACK 10 — network failure at each step of pending verification:
// timeout, 5xx, 429 + Retry-After, redirect, invalid body.
// ---------------------------------------------------------------------------
describe('ATTACK 10 — network failures during pending verification', () => {
  const failures: Array<[string, () => Promise<never>]> = [
    [
      'timeout',
      () =>
        Promise.reject(
          new BillingError(
            'billing.backend_unavailable',
            'Membership verification took too long. Please try again.',
            true,
          ),
        ),
    ],
    [
      '503',
      () =>
        Promise.reject(
          new BillingError(
            'billing.backend_unavailable',
            'Membership verification is temporarily unavailable.',
            true,
          ),
        ),
    ],
    [
      '429 + Retry-After',
      () =>
        Promise.reject(
          new BillingError(
            'billing.backend_unavailable',
            'Membership verification is temporarily unavailable.',
            true,
          ),
        ),
    ],
    [
      'invalid body',
      () =>
        Promise.reject(
          new BillingError(
            'billing.backend_invalid_response',
            'The server returned an invalid membership response.',
            true,
          ),
        ),
    ],
    ['generic network error', () => Promise.reject(new Error('ECONNRESET'))],
  ];

  it.each(failures)(
    '%s while a purchase is pending → HOLD for a previously premium member, purchase and restore disabled, no store call',
    async (_name, fail) => {
      const clients = {
        ...dependencies({ access: access(true) }),
        backend: {
          getAccess: jest.fn(async () => access(true)),
          syncBilling: jest.fn(fail),
        },
      } satisfies BillingAccessDependencies;
      configure(clients, memoryStorage(pendingRecord('purchase')));
      const renderer = await renderPaywall();
      const state = selectMembership();
      expect(state.kind).toBe('hold');
      expect(state.purchaseAllowed).toBe(false);
      expect(state.manageSubscription).toBe(false);
      expect(useAccessStore.getState().canonicalAccess).toBeNull();
      expect(useAccessStore.getState().canonicalBilling).toBeNull();
      const copy = allText(renderer);
      expect(copy).toContain('VERIFICATION ON HOLD');
      expect(copy).not.toContain('MEMBERSHIP VERIFIED');
      expect(copy).not.toContain(plans.annual!.priceString);
      expect(byTestId(renderer, 'paywall-retry')).toBeDefined();
      expect(clients.store.purchase).not.toHaveBeenCalled();
      expect(clients.store.restore).not.toHaveBeenCalled();
    },
  );

  it('real client: 429 with Retry-After and 5xx stay retryable; a 3xx that is not followed is not; premium/billing disagreement is rejected', async () => {
    const response = (status: number, headers: Record<string, string> = {}) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        headers,
        json: async () => ({}),
      }) as unknown as Response;
    const client = (fetchFn: () => Promise<Response>) =>
      createCanonicalAccessClient({
        baseUrl: 'https://api.example.test',
        token: 'access-token',
        fetchFn,
      });
    await expect(
      client(async () => response(429, { 'Retry-After': '30' })).syncBilling(),
    ).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
    await expect(
      client(async () => response(503)).syncBilling(),
    ).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
    await expect(
      client(async () =>
        response(302, { Location: 'https://elsewhere' }),
      ).syncBilling(),
    ).rejects.toMatchObject({ code: 'billing.backend_unavailable' });
    const disagreeing = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          billing: billing(true, FUTURE),
          access: access(false, 2),
        }),
      }) as unknown as Response;
    await expect(client(disagreeing).syncBilling()).rejects.toMatchObject({
      code: 'billing.backend_invalid_response',
    });
  });
});

// ---------------------------------------------------------------------------
// ATTACK 11 — Manage subscription: the App Store link fails to open.
// ---------------------------------------------------------------------------
describe('ATTACK 11 — Manage subscription link failure', () => {
  it('Settings row: a rejected openURL shows a notice, never crashes, never changes membership', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
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
    const [row] = manageRows(renderer);
    expect(row).toBeDefined();
    await act(async () => {
      row!.props.onPress();
    });
    await flush();
    expect(Linking.openURL).toHaveBeenCalledWith(APP_STORE_SUBSCRIPTIONS_URL);
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    expect(selectMembership().kind).toBe('fulfilled');
    expect(membershipValue(renderer)).toBe(
      `Pro active through ${formatMembershipDate(FUTURE)}`,
    );
  });

  it('Paywall button: a rejected openURL shows a notice and never opens a store request', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
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
    await act(async () => {
      byTestId(renderer, 'paywall-manage-subscription').props.onPress();
    });
    await flush();
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
  });
});
