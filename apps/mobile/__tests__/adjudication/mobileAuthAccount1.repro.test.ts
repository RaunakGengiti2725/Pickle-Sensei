/**
 * ADJUDICATION — stress area `mobile-auth-account-1` (base 1fb0efd7).
 *
 * Minimal, seed-free reproductions of the three CONFIRMED findings, written
 * as the EXPECTED behaviour. Every case here fails at 1fb0efd7 by
 * construction and is the executable acceptance criterion for its fix:
 *
 *   MAA1-A  launch gate has no deadline on the Keychain / SQLite awaits —
 *           a native call that never settles pins `hydrated=false` forever
 *           (App.tsx never leaves LoadingState) and, in signOut, a hung
 *           Keychain reset means the server-side session is never revoked.
 *           Seeds: authStoreFailureInjection 20261010 (kc.get.hang),
 *           sessionVaultGateFailureInjection 100011 / 100069.
 *   MAA1-B  an explicit signOut / completeAccountDeletion issued while a
 *           sign-in (or the legacy-401 silent Google restore) awaits
 *           /v1/account/bootstrap is overridden when the response lands:
 *           the store, ApiSession and Keychain are re-populated.
 *           Seed: authStoreRandomized STRESS_REPLAY=20260916 (I9).
 *   MAA1-C  a Keychain write that fails after the server rotated the
 *           refresh token is ignored (`void persistSession` in
 *           adoptRotatedTokens): the vault keeps the dead token and the
 *           next cold launch is refused (401) → implicit sign-out.
 *           Seed: sessionVaultGateFailureInjection STRESS_SEED=100032.
 *
 * Run (apps/mobile, npm not pnpm):
 *   npx jest --ci __tests__/adjudication/mobileAuthAccount1.repro.test.ts
 */
import { AppState, NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Module seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
let mockDbHang = false;
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      if (mockDbHang) return new Promise(() => {});
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const HOUR_S = 3600;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const bootstrapBody = (access: string, refresh: string) => ({
  user: { id: canonicalId, email: 'pat@example.com' },
  onboardingState: 'complete',
  session: {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: nowSeconds() + HOUR_S,
  },
});
/** An older server: no session → legacy provider-token session. */
const legacyBootstrapBody = () => ({
  user: { id: canonicalId, email: 'pat@example.com' },
  onboardingState: 'complete',
});
const refreshBody = (access: string, refresh: string) => ({
  session: {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: nowSeconds() + HOUR_S,
  },
});

type Route = (init?: RequestInit) => Response | Promise<Response>;
function installRoutes(routes: Record<string, Route>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function seedVault(
  refreshToken: string,
  provider: 'apple' | 'google' = 'apple',
) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider,
      canonicalAppUserId: canonicalId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains the microtask queue without advancing timers. */
async function flush(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;
const keychainMock = Keychain as unknown as {
  getGenericPassword: jest.Mock | typeof Keychain.getGenericPassword;
  setGenericPassword: jest.Mock | typeof Keychain.setGenericPassword;
  resetGenericPassword: jest.Mock | typeof Keychain.resetGenericPassword;
};
const realGet = Keychain.getGenericPassword;
const realSet = Keychain.setGenericPassword;
const realReset = Keychain.resetGenericPassword;

const appStateListeners = new Set<(state: string) => void>();
const realAddEventListener = AppState.addEventListener;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  jest.clearAllMocks();
  mockKv.clear();
  mockDbHang = false;
  __keychainStore.clear();
  keychainMock.getGenericPassword = realGet;
  keychainMock.setGenericPassword = realSet;
  keychainMock.resetGenericPassword = realReset;
  appStateListeners.clear();
  (AppState as unknown as { addEventListener: unknown }).addEventListener = (
    _type: string,
    listener: (state: string) => void,
  ) => {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  };
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    localDataError: null,
    deletionCleanup: null,
  });
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn().mockResolvedValue({
      user: 'apple-user-opaque',
      identityToken: 'apple-identity-token',
      authorizationCode: 'one-use-apple-code',
      email: 'pat@privaterelay.example',
      givenName: 'Pat',
      familyName: 'Player',
    }),
  };
  installRoutes({});
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  keychainMock.getGenericPassword = realGet;
  keychainMock.setGenericPassword = realSet;
  keychainMock.resetGenericPassword = realReset;
  (AppState as unknown as { addEventListener: unknown }).addEventListener =
    realAddEventListener;
  jest.useRealTimers();
});

// ─── MAA1-A: launch gate deadline ────────────────────────────────────────────

describe('MAA1-A launch gate: a Keychain / SQLite call that never settles must not pin the app on LoadingState', () => {
  it('hydrate() with an empty vault whose Keychain READ never settles still flips hydrated within 60s (fake time)', async () => {
    keychainMock.getGenericPassword = jest.fn(() => new Promise(() => {}));

    const hydrate = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(useAuthStore.getState().hydrated).toBe(true);
    await Promise.race([hydrate, flush()]);
  });

  it('hydrate() with a garbage vault record whose Keychain RESET never settles still flips hydrated within 60s (fake time)', async () => {
    __keychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: '{"provider":"apple"}',
    });
    keychainMock.resetGenericPassword = jest.fn(() => new Promise(() => {}));

    void useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(useAuthStore.getState().hydrated).toBe(true);
  });

  it('hydrate() whose SQLite kv READ never settles still flips hydrated within 60s (fake time)', async () => {
    mockDbHang = true;

    void useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(useAuthStore.getState().hydrated).toBe(true);
  });

  it('signOut() whose Keychain RESET never settles still revokes the server-side session within 60s (fake time)', async () => {
    const logout = jest.fn(() => response({ ok: true }));
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody('access-1', 'refresh-1')),
      '/v1/auth/logout': logout,
    });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    keychainMock.resetGenericPassword = jest.fn(() => new Promise(() => {}));

    void useAuthStore.getState().signOut();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(useAuthStore.getState().session).toBeNull();
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

// ─── MAA1-B: explicit sign-out wins over an in-flight sign-in ────────────────

describe('MAA1-B an explicit sign-out / deletion issued while a sign-in awaits bootstrap must win over the late response', () => {
  async function signInAwaitingBootstrap(provider: 'apple' | 'google') {
    const gate = deferred<Response>();
    installRoutes({
      '/v1/account/bootstrap': () => gate.promise,
      '/v1/auth/logout': () => response({ ok: true }),
    });
    if (provider === 'google') {
      mockGoogleSignin.signIn.mockResolvedValue({
        type: 'success',
        data: {
          idToken: 'google-id-token',
          user: { id: 'g-1', name: 'Pat Player', email: 'pat@example.com' },
        },
      });
    }
    const flow =
      provider === 'apple'
        ? useAuthStore.getState().signInWithApple()
        : useAuthStore.getState().signInWithGoogle();
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    return { gate, flow };
  }

  it.each(['apple', 'google'] as const)(
    'signOut() during a %s sign-in: the late bootstrap must not re-install the session, ApiSession or Keychain record',
    async provider => {
      const { gate, flow } = await signInAwaitingBootstrap(provider);

      await useAuthStore.getState().signOut();
      gate.resolve(response(bootstrapBody('access-1', 'refresh-1')));
      await flow;
      await flush();

      expect(useAuthStore.getState().session).toBeNull();
      expect(getApiSession()).toBeNull();
      expect(vaultRecord()).toBeNull();
    },
  );

  it('completeAccountDeletion() during an Apple sign-in: the late bootstrap must not resurrect the account', async () => {
    const { gate, flow } = await signInAwaitingBootstrap('apple');

    await useAuthStore.getState().completeAccountDeletion();
    gate.resolve(response(bootstrapBody('access-1', 'refresh-1')));
    await flow;
    await flush();

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });

  it('signOut() during the legacy-401 silent Google restore (the UI-reachable path: Settings → Sign out while signed in with a provider-token session)', async () => {
    // Legacy server → provider-token session (nothing to persist).
    installRoutes({
      '/v1/account/bootstrap': () => response(legacyBootstrapBody()),
    });
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'google-id-token',
        user: { id: 'g-1', name: 'Pat Player', email: 'pat@example.com' },
      },
    });
    await useAuthStore.getState().signInWithGoogle();
    const legacy = getApiSession();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(legacy?.refreshToken).toBeFalsy();

    // The bearer is refused → silent Google restore → bootstrap in flight.
    const gate = deferred<Response>();
    installRoutes({
      '/v1/account/bootstrap': () => gate.promise,
      '/v1/auth/logout': () => response({ ok: true }),
    });
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'google-id-token-2',
        user: { id: 'g-1', name: 'Pat Player', email: 'pat@example.com' },
      },
    });
    reportApiUnauthorized(legacy?.bearerToken ?? '');
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Settings → Sign out lands while the bootstrap is still pending.
    await useAuthStore.getState().signOut();
    gate.resolve(response(bootstrapBody('access-2', 'refresh-2')));
    await flush();

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});

// ─── MAA1-C: rotated refresh token must reach the vault ──────────────────────

describe('MAA1-C a Keychain write that fails after the server rotated the refresh token must not leave a dead token in the vault', () => {
  it.each([
    [
      'setGenericPassword throws',
      () => Promise.reject(new Error('errSecInteractionNotAllowed')),
    ],
    ['setGenericPassword returns false', () => Promise.resolve(false)],
  ] as Array<[string, () => Promise<unknown>]>)(
    'launch refresh rotates refresh-1 → refresh-2 but the first write fails (%s): the vault must hold refresh-2 once the Keychain is healthy again',
    async (_label, failure) => {
      seedVault('refresh-1');
      installRoutes({
        '/v1/auth/refresh': () =>
          response(refreshBody('access-2', 'refresh-2')),
      });
      const set = jest
        .fn()
        .mockImplementationOnce(failure)
        .mockImplementation(realSet);
      keychainMock.setGenericPassword = set;

      await useAuthStore.getState().hydrate();
      await flush();
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        canonicalId,
      );
      expect(getApiSession()?.refreshToken).toBe('refresh-2');
      expect(set).toHaveBeenCalledTimes(1);

      // Any later opportunity (retry, foreground) with a healthy Keychain.
      await jest.advanceTimersByTimeAsync(60_000);
      for (const listener of appStateListeners) listener('active');
      await jest.advanceTimersByTimeAsync(60_000);

      expect(vaultRecord()?.['refreshToken']).toBe(
        getApiSession()?.refreshToken,
      );
      expect(vaultRecord()?.['refreshToken']).toBe('refresh-2');
    },
  );

  it('the relaunch after the failed write must not be an implicit sign-out (the dead token is what the server refuses)', async () => {
    seedVault('refresh-1');
    installRoutes({
      '/v1/auth/refresh': () => response(refreshBody('access-2', 'refresh-2')),
    });
    keychainMock.setGenericPassword = jest
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('write failed')))
      .mockImplementation(realSet);
    await useAuthStore.getState().hydrate();
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);
    for (const listener of appStateListeners) listener('active');
    await jest.advanceTimersByTimeAsync(60_000);

    // Cold relaunch: the server refuses the rotated-away refresh-1 (401) and
    // accepts refresh-2 — exactly the edge fn's AUTH_REFUSAL_STATUSES contract.
    stopSessionKeeper();
    clearSyncRuntime();
    clearApiSession();
    useAuthStore.setState({ hydrated: false, session: null });
    installRoutes({
      '/v1/auth/refresh': init => {
        const { refreshToken } = JSON.parse(String(init?.body)) as {
          refreshToken: string;
        };
        return refreshToken === 'refresh-2'
          ? response(refreshBody('access-3', 'refresh-3'))
          : response({ error: 'invalid_grant' }, 401);
      },
    });

    await useAuthStore.getState().hydrate();
    await flush();

    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(vaultRecord()?.['refreshToken']).toBe('refresh-3');
  });
});
