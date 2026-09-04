/**
 * ADVERSARIAL PASS 3 / mobile-ios-config — S6: Sign in with Apple cancelled
 * twice in rapid succession (double tap), through the REAL SignInScreen +
 * authStore + bootstrapCanonicalAccount over a fetch spy.
 *
 * Invariants (coordinator): authStore stays signed-out, no error toast/card,
 * and no duplicate POST /v1/account/bootstrap.
 *
 * The native PickleAuth bridge is faked at NativeModules exactly as
 * flow-sign-in-auth.test.tsx does; the cancel rejection carries the code
 * PickleAuth.swift emits (`auth.canceled`, "Sign-in canceled.").
 */
import React from 'react';
import { NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';

// ─── Module seams (mirrors flow-sign-in-auth.test.tsx) ──────────────────────

const mockKv = new Map<string, string>();
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  signOut: jest.fn(),
  revokeAccess: jest.fn(),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
    legalPrivacyUrl: null,
    legalTermsUrl: null,
  }),
}));

jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'iOS phone',
    },
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

import { SignInScreen } from '../../src/screens/SignInScreen';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { BrandSpinner } from '../../src/design/components';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const CANCEL_CODE = 'auth.canceled';
const CANCEL_MESSAGE = 'Sign-in canceled.';

type NativeApple = { signInWithApple: jest.Mock };
const mockAppleSignIn = jest.fn();
const nativeModules = NativeModules as { PickleAuth?: NativeApple };

function nativeError(code: string, message: string) {
  return Object.assign(new Error(message), {
    code,
    domain: 'PickleAuth',
    userInfo: null,
  });
}

function cancelRejection() {
  return nativeError(CANCEL_CODE, CANCEL_MESSAGE);
}

function applePayload(identityToken: string) {
  return {
    user: 'apple-sub-001',
    identityToken,
    authorizationCode: 'auth-code-001',
    email: 'pat@privaterelay.example',
    givenName: 'Pat',
    familyName: 'Player',
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function bootstrapSuccessFetch(): jest.Mock {
  return jest.fn().mockResolvedValue(
    response({
      user: { id: canonicalId, email: 'pat@example.com' },
      onboardingState: 'complete',
      session: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    }),
  );
}

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;

function bootstrapPosts(): unknown[][] {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url).endsWith('/v1/account/bootstrap') &&
      (init as { method?: string } | undefined)?.method === 'POST',
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── Render helpers ─────────────────────────────────────────────────────────

const onBack = jest.fn();
const mounted: TestRenderer.ReactTestRenderer[] = [];

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<SignInScreen onBack={onBack} />);
  });
  mounted.push(renderer);
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function controls(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityState !== undefined,
  );
}

function control(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = controls(renderer, label);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

/** Two presses in the SAME act — the closest a test gets to a double tap
 * landing before React re-renders the disabled state. */
async function doubleTap(node: TestRenderer.ReactTestInstance) {
  await act(async () => {
    node.props.onPress();
    node.props.onPress();
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectSignedOutQuiet(renderer: TestRenderer.ReactTestRenderer) {
  const state = useAuthStore.getState();
  expect(state.session).toBeNull();
  expect(state.busy).toBe(false);
  expect(getApiSession()).toBeNull();
  expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  expect(controls(renderer, 'Dismiss sign-in error')).toHaveLength(0);
  expect(allText(renderer)).not.toMatch(
    /SIGN-IN FAILED|failed|Sign-in canceled/i,
  );
  expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);
  for (const label of ['Continue with Apple', 'Continue with Google']) {
    expect(control(renderer, label).props.disabled).toBe(false);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
  });
  nativeModules.PickleAuth = { signInWithApple: mockAppleSignIn };
  mockAppleSignIn.mockReset();
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signIn.mockResolvedValue({ type: 'cancelled', data: null });
  mockGoogleSignin.signOut.mockResolvedValue(null);
  fetchMock = bootstrapSuccessFetch();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => {
      renderer.unmount();
    });
  }
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
  delete nativeModules.PickleAuth;
});

describe('S6 — Sign in with Apple cancelled twice in rapid succession', () => {
  it('oracle: a non-cancel failure DOES render the dismissable error card (so its absence below is meaningful)', async () => {
    mockAppleSignIn.mockRejectedValueOnce(
      nativeError('auth.failed', 'Apple returned no credential.'),
    );
    const renderer = renderScreen();
    await doubleTap(control(renderer, 'Continue with Apple'));
    await settle();
    expect(controls(renderer, 'Dismiss sign-in error')).toHaveLength(1);
    expect(allText(renderer)).toContain('Apple returned no credential.');
    expect(bootstrapPosts()).toHaveLength(0);
  });

  it('double tap in ONE tick, sheet cancelled: one native call, signed-out, no card, zero bootstrap POSTs', async () => {
    const pending = deferred<never>();
    mockAppleSignIn.mockReturnValueOnce(pending.promise);
    const renderer = renderScreen();

    await doubleTap(control(renderer, 'Continue with Apple'));
    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().busy).toBe(true);

    await act(async () => {
      pending.reject(cancelRejection());
    });
    await settle();

    expectSignedOutQuiet(renderer);
    expect(useAuthStore.getState().error).toEqual({
      code: CANCEL_CODE,
      message: CANCEL_MESSAGE,
    });
    expect(bootstrapPosts()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('two sequential cancels back-to-back (tap, cancel, tap, cancel): two native calls, still signed-out and quiet, zero POSTs', async () => {
    mockAppleSignIn
      .mockRejectedValueOnce(cancelRejection())
      .mockRejectedValueOnce(cancelRejection());
    const renderer = renderScreen();
    const apple = control(renderer, 'Continue with Apple');

    await act(async () => {
      apple.props.onPress();
    });
    await settle();
    await act(async () => {
      control(renderer, 'Continue with Apple').props.onPress();
    });
    await settle();

    expect(mockAppleSignIn).toHaveBeenCalledTimes(2);
    expectSignedOutQuiet(renderer);
    expect(bootstrapPosts()).toHaveLength(0);
    expect(mockKv.get('auth.last-provider') ?? '').not.toContain('apple');
  });

  it('cancel arriving while a second tap is already queued in the same microtask run: never two native sheets, never a POST', async () => {
    const first = deferred<never>();
    mockAppleSignIn
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(cancelRejection());
    const renderer = renderScreen();
    const apple = control(renderer, 'Continue with Apple');

    await act(async () => {
      apple.props.onPress();
      first.reject(cancelRejection());
      // Second tap lands in the same tick as the cancel rejection — before
      // the store's catch has run.
      apple.props.onPress();
    });
    await settle();

    // Either the guard swallowed the second tap (1 call) or it ran after the
    // cancel settled (2 calls) — both are acceptable; what must never happen
    // is a bootstrap POST or a lingering busy/error card.
    expect(mockAppleSignIn.mock.calls.length).toBeLessThanOrEqual(2);
    expectSignedOutQuiet(renderer);
    expect(bootstrapPosts()).toHaveLength(0);
  });

  it('cancel then immediate success: exactly ONE bootstrap POST, session established once', async () => {
    mockAppleSignIn
      .mockRejectedValueOnce(cancelRejection())
      .mockResolvedValueOnce(applePayload('apple-identity-token-9'));
    const renderer = renderScreen();

    await act(async () => {
      control(renderer, 'Continue with Apple').props.onPress();
    });
    await settle();
    expectSignedOutQuiet(renderer);

    await doubleTap(control(renderer, 'Continue with Apple'));
    await settle();
    await settle();

    expect(mockAppleSignIn).toHaveBeenCalledTimes(2);
    expect(bootstrapPosts()).toHaveLength(1);
    const state = useAuthStore.getState();
    expect(state.session?.provider).toBe('apple');
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(state.error).toBeNull();
  });

  it('double tap while the bootstrap POST is in flight never issues a second POST', async () => {
    const slowBootstrap = deferred<Response>();
    fetchMock.mockReturnValueOnce(slowBootstrap.promise);
    mockAppleSignIn.mockResolvedValueOnce(
      applePayload('apple-identity-token-10'),
    );
    const renderer = renderScreen();

    await doubleTap(control(renderer, 'Continue with Apple'));
    await settle();
    expect(bootstrapPosts()).toHaveLength(1);
    expect(useAuthStore.getState().busy).toBe(true);

    // Third and fourth taps while the network call is pending.
    await doubleTap(control(renderer, 'Continue with Apple'));
    await act(async () => {
      await useAuthStore.getState().signInWithApple();
    });
    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expect(bootstrapPosts()).toHaveLength(1);

    await act(async () => {
      slowBootstrap.resolve(
        response({
          user: { id: canonicalId, email: 'pat@example.com' },
          onboardingState: 'complete',
          session: {
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      );
    });
    await settle();
    expect(bootstrapPosts()).toHaveLength(1);
    expect(useAuthStore.getState().session?.provider).toBe('apple');
  });

  it('hostile cancel shapes (bare {code}, unicode message, code-only string) stay quiet and signed-out', async () => {
    const shapes: unknown[] = [
      { code: CANCEL_CODE },
      nativeError(
        CANCEL_CODE,
        'Sign-in canceled \u2014 \u30E6\u30FC\u30B6\u30FC\u304C\u30AD\u30E3\u30F3\u30BB\u30EB \u{1F44B}',
      ),
      Object.assign(new Error(''), { code: CANCEL_CODE }),
    ];
    for (const shape of shapes) mockAppleSignIn.mockRejectedValueOnce(shape);
    const renderer = renderScreen();
    for (let i = 0; i < shapes.length; i += 1) {
      await act(async () => {
        control(renderer, 'Continue with Apple').props.onPress();
      });
      await settle();
      const state = useAuthStore.getState();
      expect(state.session).toBeNull();
      expect(state.busy).toBe(false);
      expect(state.error?.code).toBe(CANCEL_CODE);
      expect(controls(renderer, 'Dismiss sign-in error')).toHaveLength(0);
    }
    expect(mockAppleSignIn).toHaveBeenCalledTimes(shapes.length);
    expect(bootstrapPosts()).toHaveLength(0);
  });

  it('BASELINE BEHAVIOUR: a plain-string rejection "canceled" (no code) is NOT recognised as a cancel and shows the error card', async () => {
    // toAuthError keys on `err.code`; a string has none, so this lands as
    // auth.failed with the generic message. PickleAuth.swift always sends a
    // code, so this is defence-in-depth information, not a live path.
    mockAppleSignIn.mockRejectedValueOnce('canceled');
    const renderer = renderScreen();
    await act(async () => {
      control(renderer, 'Continue with Apple').props.onPress();
    });
    await settle();
    expect(useAuthStore.getState().error?.code).toBe('auth.failed');
    expect(controls(renderer, 'Dismiss sign-in error')).toHaveLength(1);
    expect(bootstrapPosts()).toHaveLength(0);
  });

  it('cancel that lands after Back unmounted the screen: store settles signed-out, nothing throws', async () => {
    const pending = deferred<never>();
    mockAppleSignIn.mockReturnValueOnce(pending.promise);
    const renderer = renderScreen();
    await doubleTap(control(renderer, 'Continue with Apple'));
    expect(useAuthStore.getState().busy).toBe(true);

    act(() => {
      renderer.unmount();
    });
    mounted.splice(mounted.indexOf(renderer), 1);

    await act(async () => {
      pending.reject(cancelRejection());
    });
    await settle();
    const state = useAuthStore.getState();
    expect(state.busy).toBe(false);
    expect(state.session).toBeNull();
    expect(state.error?.code).toBe(CANCEL_CODE);
    expect(bootstrapPosts()).toHaveLength(0);
  });
});
