/**
 * Workflow audit — offline / network-error resilience (screen layer).
 *
 * Drives the real Consent, ManageAccount and Paywall screens through their
 * buttons with the network failing underneath (airplane mode, 401 expired
 * session, 5xx). For every control: the handler is wired, the failure copy
 * is visible, loading terminates, duplicate taps are guarded, and there is
 * always a way out. (AnalyzeScreen lives in the sibling *.analyze test —
 * it needs fake timers.)
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/account/apiSession', () => {
  let session: unknown = null;
  return {
    getApiSession: () => session,
    subscribeToApiSession: () => () => {},
    __setSession: (next: unknown) => {
      session = next;
    },
  };
});
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: {} }),
}));
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  };
});
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
    Ellipse: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { Switch, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { PaywallScreen } from '../../src/screens/PaywallScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useConsentStore } from '../../src/state/consentStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing/types';
import * as apiSessionModule from '../../src/account/apiSession';

const setSession = (
  apiSessionModule as unknown as { __setSession: (s: unknown) => void }
).__setSession;

const apiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'tok',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'google' as const,
};

const syncedSession: AuthSession = {
  provider: 'google',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

const offlineFetch = async (): Promise<Response> => {
  throw new TypeError('Network request failed');
};

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function buttonLabelled(renderer: ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function pressableByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labelled ${label}`);
  return node;
}

function pressableByTestId(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  setSession(apiSession);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSession(null);
});

// ─── ConsentSettingsScreen ─────────────────────────────────────────────────

describe('ConsentSettingsScreen — consent server unreachable', () => {
  beforeEach(() => {
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
    });
    useConsentStore.setState({
      availability: 'loading',
      modelTrainingActive: false,
      lastActionAt: null,
      busy: false,
      error: null,
    });
  });

  it('offline hydrate → visible unavailable copy, toggle disabled (with accessibilityState), consent stays off', async () => {
    globalThis.fetch = offlineFetch as unknown as typeof fetch;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ConsentSettingsScreen />);
    });
    await flush();
    expect(allText(renderer)).toContain(
      'Consent settings are temporarily unavailable.',
    );
    const toggle = renderer.root.findByType(Switch);
    expect(toggle.props.value).toBe(false);
    expect(toggle.props.disabled).toBe(true);
    expect(toggle.props.accessibilityState).toEqual({ disabled: true });
    expect(toggle.props.accessibilityLabel).toBe(
      'Use my video to improve models',
    );
    await act(async () => {
      renderer.unmount();
    });
  });

  it('5xx on grant → the toggle never pretends the change saved; error shown; toggle re-enabled', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(200, { subjectPseudonym: null, scopes: [] });
      }
      return jsonResponse(503, { error: { message: 'generic' } });
    }) as unknown as typeof fetch;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ConsentSettingsScreen />);
    });
    await flush();
    let toggle = renderer.root.findByType(Switch);
    expect(toggle.props.disabled).toBe(false);
    await act(async () => {
      toggle.props.onValueChange(true);
    });
    await flush();
    toggle = renderer.root.findByType(Switch);
    expect(toggle.props.value).toBe(false);
    expect(toggle.props.disabled).toBe(false);
    expect(allText(renderer)).toContain(
      'Consent settings are temporarily unavailable.',
    );
    await act(async () => {
      renderer.unmount();
    });
  });
});

// ─── ManageAccountScreen (account deletion) ────────────────────────────────

describe('ManageAccountScreen — deletion with the network failing', () => {
  beforeEach(() => {
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
  });

  async function openDeleteSheet(): Promise<ReactTestRenderer> {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    await act(async () => {
      pressableByLabel(renderer, 'Delete account').props.onPress();
    });
    return renderer;
  }

  it('offline → "Nothing was deleted" copy, sheet returns to review, buttons re-enabled, exit still available', async () => {
    globalThis.fetch = offlineFetch as unknown as typeof fetch;
    const renderer = await openDeleteSheet();
    await act(async () => {
      buttonLabelled(renderer, 'Continue to delete').props.onPress();
    });
    await flush();
    const copy = allText(renderer);
    expect(copy).toContain(
      'Account deletion is temporarily offline. Nothing was deleted — please try again.',
    );
    expect(buttonLabelled(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    expect(buttonLabelled(renderer, 'Keep my account').props.disabled).toBe(
      false,
    );
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('401 expired session → tells the user to sign in again; nothing deleted', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(401, {
        error: { message: 'The identity token could not be verified.' },
      })) as unknown as typeof fetch;
    const renderer = await openDeleteSheet();
    await act(async () => {
      buttonLabelled(renderer, 'Continue to delete').props.onPress();
    });
    await flush();
    expect(allText(renderer)).toContain(
      'Your sign-in has expired. Sign in again, then delete your account.',
    );
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('while the request is in flight, the danger button is disabled (no double submit) and every dismiss control is inert', async () => {
    let resolveFetch!: (r: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>(resolve => {
        resolveFetch = resolve;
      })) as unknown as typeof fetch;
    const renderer = await openDeleteSheet();
    await act(async () => {
      buttonLabelled(renderer, 'Continue to delete').props.onPress();
    });
    expect(buttonLabelled(renderer, 'Requesting…').props.disabled).toBe(true);
    expect(buttonLabelled(renderer, 'Keep my account').props.disabled).toBe(
      true,
    );
    // The X and the backdrop are disabled until the request settles, so a
    // late response can never arm a sheet the user already dismissed.
    expect(
      renderer.root.findAll(
        n =>
          n.props.accessibilityLabel ===
            'Close account deletion confirmation' &&
          typeof n.props.onPress === 'function',
      ),
    ).toHaveLength(0);
    expect(
      renderer.root
        .findAll(
          n =>
            n.props.accessibilityLabel ===
            'Close account deletion confirmation',
        )
        .some(n => n.props.accessibilityState?.disabled === true),
    ).toBe(true);
    expect(
      renderer.root
        .findAll(n => n.props.accessibilityLabel === 'Cancel account deletion')
        .every(n => n.props.onPress === undefined),
    ).toBe(true);
    await act(async () => {
      resolveFetch(
        jsonResponse(200, {
          challenge: 'chal',
          expiresAt: '2026-09-01T00:10:00.000Z',
        }),
      );
    });
    await flush();
    expect(allText(renderer)).toContain('Permanently delete');
    act(() => renderer.unmount());
  });
});

// ─── PaywallScreen ─────────────────────────────────────────────────────────

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: false,
  paywallRequired: true,
};

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: {
    id: 'monthly',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime',
    productId: 'pickle_sensei_pro_lifetime',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

function billingDeps(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_annual',
        expirationDate: null,
      })),
      restore: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_annual',
        expirationDate: null,
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(getAccess),
      syncBilling: jest.fn(async () => {
        throw new Error('not exercised');
      }),
    },
  };
}

describe('PaywallScreen — membership server unreachable', () => {
  beforeEach(() => clearAccessStoreConfiguration());

  it('offline access check → visible error, purchase disabled, Try again wired to re-initialize, close still works', async () => {
    let online = false;
    const deps = billingDeps(async () => {
      if (!online) throw new TypeError('Network request failed');
      return freeAccess;
    });
    configureAccessStore(deps);
    const onClose = jest.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<PaywallScreen onClose={onClose} />);
    });
    await flush();
    await act(async () => {
      pressableByTestId(renderer, 'paywall-see-plans').props.onPress();
    });
    await flush();

    expect(allText(renderer)).toContain(
      'Membership verification is temporarily unavailable.',
    );
    expect(pressableByTestId(renderer, 'paywall-continue').props.disabled).toBe(
      true,
    );
    const retry = pressableByTestId(renderer, 'paywall-retry');
    expect(retry.props.accessibilityLabel).toBe('Retry loading membership');

    online = true;
    await act(async () => {
      retry.props.onPress();
    });
    await flush();
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(2);
    expect(pressableByTestId(renderer, 'paywall-continue').props.disabled).toBe(
      false,
    );
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-retry'),
    ).toHaveLength(0);

    await act(async () => {
      pressableByLabel(renderer, 'Close membership offer').props.onPress();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
