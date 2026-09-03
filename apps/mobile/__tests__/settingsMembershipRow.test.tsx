import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Settings → Membership → "Pickle Sensei Pro" states the server's free-rating
 * ledger. That ledger moves every time a scored analysis syncs, so the row
 * must re-read it on every visit and derive its wording from what the server
 * says can still be started — never from the snapshot taken when the rating
 * flow first opened (which once kept saying "2 free ratings left" after both
 * had been scored).
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
    initialWindowMetrics: null,
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

import { SettingsScreen } from '../src/screens/SettingsScreen';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';
import { useConsentStore } from '../src/state/consentStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../src/billing/types';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const guestSession: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

function freeAccess(
  used: number,
  reserved = 0,
  premium = false,
): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  const canStartRating = premium || availableToReserve > 0;
  return {
    premium,
    entitlements: premium ? ['premium'] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

function backendReturning(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this test');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: {
      getAccess: jest.fn(getAccess),
      syncBilling: jest.fn(),
    },
  };
}

/** Seeds the snapshot the store holds BEFORE Settings opens (what the
 * rating flow loaded earlier), leaving the configured backend untouched. */
function seedStaleSnapshot(access: CanonicalAccessState) {
  useAccessStore.setState({ status: 'ready', canonicalAccess: access });
}

let mounted: TestRenderer.ReactTestRenderer | null = null;

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<SettingsScreen />);
  });
  mounted = renderer;
  return renderer;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

beforeEach(() => {
  clearAccessStoreConfiguration();
  useAuthStore.setState({ session: syncedSession });
  useConsentStore.setState({
    availability: 'signed_out',
    modelTrainingActive: false,
    hydrate: jest.fn(() => Promise.resolve()),
  });
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe('Settings membership row', () => {
  it('re-reads the server ledger on focus instead of the stale snapshot', async () => {
    const clients = backendReturning(async () => freeAccess(1));
    configureAccessStore(clients);
    seedStaleSnapshot(freeAccess(0));

    const renderer = renderScreen();
    await flush();

    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(membershipValue(renderer)).toBe('1 free rating left');
  });

  it('keeps the last known value on screen while the re-read is in flight', async () => {
    let resolveAccess!: (value: CanonicalAccessState) => void;
    const clients = backendReturning(
      () =>
        new Promise<CanonicalAccessState>(resolve => {
          resolveAccess = resolve;
        }),
    );
    configureAccessStore(clients);
    seedStaleSnapshot(freeAccess(0));

    const renderer = renderScreen();
    await flush();
    expect(membershipValue(renderer)).toBe('2 free ratings left');

    resolveAccess(freeAccess(2));
    await flush();
    expect(membershipValue(renderer)).toBe('Upgrade required');
  });

  it('says Upgrade required as soon as nothing is left to reserve, even while the last score is still syncing', async () => {
    // Second scored analysis saved, its permit still reserved until the
    // outbox syncs: remaining is 1 by the server's arithmetic, but nothing
    // can be started — the row must not advertise a rating the gate refuses.
    const clients = backendReturning(async () => freeAccess(1, 1));
    configureAccessStore(clients);
    seedStaleSnapshot(freeAccess(0));

    const renderer = renderScreen();
    await flush();

    expect(membershipValue(renderer)).toBe('Upgrade required');
  });

  it('shows Pro active for a verified membership', async () => {
    const clients = backendReturning(async () => freeAccess(2, 0, true));
    configureAccessStore(clients);

    const renderer = renderScreen();
    await flush();

    expect(membershipValue(renderer)).toBe('Pro active');
  });

  it('loads the ledger on first visit even when the rating flow never opened', async () => {
    const clients = backendReturning(async () => freeAccess(0));
    configureAccessStore(clients);

    const renderer = renderScreen();
    await flush();

    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(membershipValue(renderer)).toBe('2 free ratings left');
  });

  it('never asks the server about a local-only guest', async () => {
    const clients = backendReturning(async () => freeAccess(0));
    configureAccessStore(clients);
    useAuthStore.setState({ session: guestSession });

    const renderer = renderScreen();
    await flush();

    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(membershipValue(renderer)).toBe('Sign in first');
  });
});
