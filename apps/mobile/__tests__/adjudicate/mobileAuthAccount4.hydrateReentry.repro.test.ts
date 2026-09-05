/**
 * Adjudication reproduction (stress area mobile-auth-account-4).
 *
 * `authStore.hydrate()` has no generation / re-entry guard. The only
 * production caller is the Gate mount effect (App.tsx), so a second call
 * happens when RootErrorBoundary's "Try again" remounts the Gate while auth
 * I/O from the previous run is still in flight. These two cases replay the
 * concurrency campaign's minimised seeds 2 and 3 / campaign seed 20460938
 * directly against the store, with no scheduler harness: only the Keychain
 * read is deferred, exactly like a real (slow) `SecItemCopyMatching`.
 *
 * Both tests document the CURRENT (defective) behaviour; a fix must invert
 * the marked assertions.
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

// ─── Controllable Keychain: reads capture the item AT CALL TIME and settle
// only when the test releases them (a slow native read); writes/resets are
// immediate.
interface StoredItem {
  username: string;
  password: string;
}
const mockKeychainStore = new Map<string, StoredItem>();
const mockPendingReads: Array<() => void> = [];
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AfterFirstUnlockThisDeviceOnly',
  },
  setGenericPassword: async (
    username: string,
    password: string,
    options: { service: string },
  ) => {
    mockKeychainStore.set(options.service, { username, password });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: (options: { service: string }) => {
    const snapshot = mockKeychainStore.get(options.service);
    return new Promise(resolve => {
      mockPendingReads.push(() =>
        resolve(
          snapshot
            ? { service: options.service, storage: 'mock', ...snapshot }
            : false,
        ),
      );
    });
  },
  resetGenericPassword: async (options: { service: string }) =>
    mockKeychainStore.delete(options.service),
}));

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

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(),
    signIn: jest.fn(),
    signInSilently: jest.fn(),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
  },
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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}
const sessionBody = (access: string, refresh: string) => ({
  accessToken: access,
  refreshToken: refresh,
  expiresAt: FAR_FUTURE_SECONDS,
});

interface Deferred<T> {
  resolve: (v: T) => void;
  promise: Promise<T>;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { resolve, promise };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));
const releaseKeychainReads = async () => {
  while (mockPendingReads.length) mockPendingReads.shift()!();
  await flush();
};

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;
const serverCalls: string[] = [];

beforeEach(() => {
  mockKv.clear();
  mockKeychainStore.clear();
  mockPendingReads.length = 0;
  serverCalls.length = 0;
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
  });
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
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

describe('adjudication: authStore.hydrate() re-entry', () => {
  it('seed 2 (minimised): hydrate() re-entered during a sign-in bootstrap lands the fresh sign-in signed OUT while ApiSession + vault keep it', async () => {
    const bootstrap = deferred<Response>();
    globalThis.fetch = jest.fn(async (url: string) => {
      serverCalls.push(url.replace('https://api.example.test', ''));
      if (url.endsWith('/v1/account/bootstrap')) return bootstrap.promise;
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    // Signed-out launch already hydrated; the user taps Sign in with Apple.
    useAuthStore.setState({ hydrated: true });
    const signIn = useAuthStore.getState().signInWithApple();
    await flush();
    expect(serverCalls).toEqual(['/v1/account/bootstrap']);

    // RootErrorBoundary "Try again" remounts the Gate → second hydrate();
    // its Keychain read is issued now (vault still empty) and is slow.
    const rehydrate = useAuthStore.getState().hydrate();
    await flush();
    expect(mockPendingReads).toHaveLength(1);

    // The bootstrap lands first: the sign-in completes and persists.
    bootstrap.resolve(
      response({
        user: { id: canonicalId, email: 'pat@example.com' },
        onboardingState: 'complete',
        session: sessionBody('access-1', 'refresh-1'),
      }),
    );
    await signIn;
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(mockKeychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);

    // The stale Keychain read now settles with its pre-sign-in snapshot.
    await releaseKeychainReads();
    await rehydrate;

    // DEFECT: the store is signed out, but the API session and the vault
    // still belong to the account that just signed in.
    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(getApiSession()?.canonicalAppUserId).toBe(canonicalId);
    expect(mockKeychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
  });

  it('seed 3 / 20460938 class: signOut() during a re-entered hydrate() resurrects the signed-out account from the stale vault snapshot', async () => {
    globalThis.fetch = jest.fn(async (url: string) => {
      serverCalls.push(url.replace('https://api.example.test', ''));
      if (url.endsWith('/v1/auth/refresh')) {
        return response({ session: sessionBody('access-2', 'refresh-2') });
      }
      if (url.endsWith('/v1/auth/logout')) return response({}, 204);
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    mockKeychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: canonicalId,
        refreshToken: 'refresh-1',
        email: 'pat@example.com',
        displayName: 'Pat Player',
      }),
    });

    // Re-entered hydrate(): Keychain read issued (snapshot holds the record).
    const rehydrate = useAuthStore.getState().hydrate();
    await flush();
    expect(mockPendingReads).toHaveLength(1);

    // The user taps Sign out: store cleared, vault reset, sign-in surface.
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
    expect(mockKeychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);

    // The stale read settles AFTER the sign-out.
    await releaseKeychainReads();
    await rehydrate;

    // DEFECT: signed back in from a record the user just erased; the refresh
    // token was never revoked (no ApiSession existed at sign-out) and the
    // rotation re-writes the vault, so the zombie survives the next launch.
    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(getApiSession()?.bearerToken).toBe('access-2');
    expect(mockKeychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
    expect(serverCalls).toEqual(['/v1/auth/refresh']);
  });
});
