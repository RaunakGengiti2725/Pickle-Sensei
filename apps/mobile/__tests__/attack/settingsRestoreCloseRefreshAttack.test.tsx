import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Adversarial probe for the XC-ADJ-BEH-1 fix at the screen level.
 *
 * Settings → Membership → Paywall → Restore purchases. The Paywall close
 * button is NOT disabled while `operation === 'restoring'`
 * (PaywallScreen.tsx: only the action buttons take `disabled={busy}`), so the
 * user can dismiss the paywall while the backend syncBilling is still
 * re-verifying with RevenueCat. Settings regains focus → `useFocusEffect` →
 * `refreshAccess()` (status is 'ready', so the in-flight guard does not
 * apply). That GET reaches the server before the sync wrote
 * billing_entitlements and answers with the pre-restore free snapshot; if its
 * response arrives after the sync's, the verified membership must still stand.
 */

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
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

import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useConsentStore } from '../../src/state/consentStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  CanonicalBillingSync,
} from '../../src/billing/types';
import { deferred } from '../../testing/xcBehavioral/deferred';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function freeAccess(used: number, premium = false): CanonicalAccessState {
  const remaining = 2 - used;
  const canStartRating = premium || remaining > 0;
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
    canStartRating,
    paywallRequired: !canStartRating,
  };
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
    await new Promise<void>(resolve => setImmediate(resolve));
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
  mockNavigate.mockReset();
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
  clearAccessStoreConfiguration();
});

it('Settings focus refresh issued while a restore is verifying must not displace the restored membership when its older snapshot answers last', async () => {
  const sync = deferred<CanonicalBillingSync>();
  const staleGet = deferred<CanonicalAccessState>();
  let getAccessCalls = 0;
  const clients: BillingAccessDependencies = {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this test');
      }),
      purchase: jest.fn(),
      restore: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_yearly',
        expirationDate: null,
      })),
      readEntitlement: jest.fn(),
    },
    backend: {
      getAccess: jest.fn(() => {
        getAccessCalls += 1;
        // First visit: immediate free snapshot. Second visit (after closing
        // the paywall mid-restore): the slow, pre-write snapshot.
        return getAccessCalls === 1
          ? Promise.resolve(freeAccess(1))
          : staleGet.promise;
      }),
      syncBilling: jest.fn(() => sync.promise),
    },
  };
  configureAccessStore(clients);
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(1) });

  // Visit 1: Settings focus refresh lands the free snapshot.
  let renderer = renderScreen();
  await flush();
  expect(membershipValue(renderer)).toBe('1 free rating left');
  expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);

  // Paywall: Restore purchases. Store step done, backend sync on the wire.
  const restore = useAccessStore.getState().restorePurchases();
  await flush();
  expect(useAccessStore.getState().operation).toBe('restoring');
  expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);

  // User closes the paywall while "Restoring…" (close is never disabled).
  // Settings regains focus → refreshAccess() → second GET.
  act(() => renderer.unmount());
  renderer = renderScreen();
  await flush();
  expect(clients.backend.getAccess).toHaveBeenCalledTimes(2);

  // The sync answers first: membership verified.
  sync.resolve({
    billing: {
      premium: true,
      productKey: 'pickle_sensei_pro_yearly',
      expiresAt: null,
      verifiedAt: '2026-09-04T00:00:00.000Z',
    },
    access: freeAccess(1, true),
  });
  await act(async () => {
    expect(await restore).toBe(true);
  });
  await flush();
  expect(membershipValue(renderer)).toBe('Pro active');

  // The focus refresh answers last with the snapshot the server produced
  // BEFORE the entitlement write.
  staleGet.resolve(freeAccess(1));
  await flush();

  expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
  expect(membershipValue(renderer)).toBe('Pro active');
});
