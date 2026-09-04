import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario 2 (Settings focus while offline).
 *
 * The Settings membership row re-reads `/v1/me/access` on every focus. When
 * that read REJECTS (airplane mode, 5xx, timeout) the row must keep the last
 * known ledger value — it must not blank to "Verify access" (a synced player
 * who already verified last session would be told to verify again with no
 * network to do so) and nothing may throw.
 *
 * Extras: rapid refocus storms, a rejection arriving after a later success,
 * and the paywall route gate downstream of the same snapshot.
 */

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../../src/data/db', () => ({
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

// useFocusEffect is driven by the test: `mockFocusListeners` collects the
// focus callbacks so a "refocus" can be replayed as many times as needed.
const mockFocusCallbacks: Array<() => void | (() => void)> = [];
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => {
      mockFocusCallbacks.push(callback);
      const cleanup = callback();
      return () => {
        const index = mockFocusCallbacks.indexOf(callback);
        if (index !== -1) mockFocusCallbacks.splice(index, 1);
        if (typeof cleanup === 'function') cleanup();
      };
    }, [callback]);
  },
}));

import { SettingsScreen } from '../../../src/screens/SettingsScreen';
import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';
import { useConsentStore } from '../../../src/state/consentStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../../src/billing/types';

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
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function refocus() {
  act(() => {
    for (const callback of [...mockFocusCallbacks]) callback();
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

declare const process: {
  on: (event: 'unhandledRejection', handler: (reason: unknown) => void) => void;
  off: (
    event: 'unhandledRejection',
    handler: (reason: unknown) => void,
  ) => void;
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  mockFocusCallbacks.length = 0;
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
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
  process.off('unhandledRejection', onUnhandled);
});

describe('scenario 2 — Settings focus with refreshAccess rejecting (offline)', () => {
  it('keeps the last known membership value when the re-read rejects', async () => {
    const clients = backendReturning(async () => {
      throw new TypeError('Network request failed');
    });
    configureAccessStore(clients);
    // The rating flow verified access earlier in this session.
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });

    const renderer = renderScreen();
    expect(membershipValue(renderer)).toBe('1 free rating left');
    await flush();

    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
    // The rejection must not blank the row.
    expect(useAccessStore.getState().canonicalAccess).not.toBeNull();
    expect(membershipValue(renderer)).toBe('1 free rating left');
  });

  it('a verified Pro member stays "Pro active" through an offline refocus storm', async () => {
    let online = true;
    const clients = backendReturning(async () => {
      if (!online) throw new TypeError('Network request failed');
      return freeAccess(2, true);
    });
    configureAccessStore(clients);

    const renderer = renderScreen();
    await flush();
    expect(membershipValue(renderer)).toBe('Pro active');

    online = false;
    // Ten rapid refocuses (tab switching) with the network gone.
    for (let i = 0; i < 10; i += 1) {
      refocus();
      await flush();
    }
    expect(unhandled).toEqual([]);
    expect(membershipValue(renderer)).toBe('Pro active');
  });

  it('a stale rejection that lands AFTER a newer success does not clobber it', async () => {
    let rejectFirst!: (reason: unknown) => void;
    let call = 0;
    const clients = backendReturning(() => {
      call += 1;
      if (call === 1) {
        return new Promise<CanonicalAccessState>((_, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve(freeAccess(0));
    });
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });

    const renderer = renderScreen();
    await flush();
    expect(membershipValue(renderer)).toBe('1 free rating left');

    // Second focus is skipped while the first load is in flight (documented),
    // so drive the second read through the store directly, as the Analyze
    // unmount cleanup does.
    useAccessStore.setState({ status: 'ready' });
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    expect(membershipValue(renderer)).toBe('2 free ratings left');

    rejectFirst(new TypeError('Network request failed'));
    await flush();
    expect(unhandled).toEqual([]);
    // The older, slower request must not overwrite the newer answer.
    expect(membershipValue(renderer)).toBe('2 free ratings left');
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(0));
  });
});
