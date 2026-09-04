/**
 * ATTACK (MAS-1 fix, fe819e51): the keeper now fires `refresh()` SYNCHRONOUSLY
 * from `startSessionKeeper` whenever the bootstrap expiry is untrusted (past /
 * inside the 60 s lead / > 24 h / millisecond-valued). `establishSyncedAccount`
 * starts the keeper BEFORE `signInWithApple` / `signInWithGoogle` publish the
 * session to the auth store (there is an `await persistLastProvider(...)` —
 * a SQLite write — in between). `adoptRotatedTokens` refuses tokens for an
 * account that is not the store's current session, so a rotation that lands
 * during that window is silently dropped: the keeper keeps the NEW refresh
 * token in memory, the Keychain and the ApiSession keep the OLD (now rotated
 * away server-side) one.
 *
 * On 4d812e1a the same bootstrap scheduled the first rotation ≥ 1 s later, by
 * which time the session was published — this window did not exist.
 *
 * Harness mirrors __tests__/authDurableSession.test.ts, with a kv store whose
 * writes complete on the next macrotask (a real SQLite write crosses the
 * native bridge; the fetch mock resolves in microtasks — i.e. the network
 * answers before the local write lands).
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
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

const mockKv = new Map<string, string>();
const nextMacrotask = () => new Promise<void>(r => setImmediate(r));
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        await nextMacrotask();
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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function installRoutes(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): jest.Mock {
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

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.clearAllMocks();
  mockKv.clear();
  __keychainStore.clear();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
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
  jest.useRealTimers();
});

/** Sign in (Apple or Google) with a bootstrap whose expiry the keeper
 * distrusts, then give the keeper's FIRST rotation room to land (the pre-fix
 * keeper floors it at 1 s; the fixed keeper fires it synchronously inside
 * startSessionKeeper) and flush the persistence that rotation should have
 * triggered. `/v1/auth/refresh` behaves like Supabase: it rotates, and a
 * refresh token that has already been rotated away is refused (401). */
async function signInWithUntrustedBootstrapExpiry(
  expiresAt: number,
  provider: 'apple' | 'google' = 'apple',
) {
  let refreshes = 0;
  let liveRefreshToken = 'refresh-1';
  const fetchMock = installRoutes({
    '/v1/account/bootstrap': () =>
      response({
        user: { id: canonicalId, email: 'pat@example.com' },
        onboardingState: 'complete',
        session: {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresAt,
        },
      }),
    '/v1/auth/refresh': init => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        refreshToken?: string;
      };
      if (body.refreshToken !== liveRefreshToken) {
        return response({ error: { message: 'Sign in again.' } }, 401);
      }
      refreshes += 1;
      liveRefreshToken = `refresh-${refreshes + 1}`;
      return response({
        session: {
          accessToken: `access-${refreshes + 1}`,
          refreshToken: liveRefreshToken,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      });
    },
  });
  if (provider === 'google') {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: {
        user: {
          id: 'google-uid-1',
          name: 'Pat Player',
          email: 'pat@gmail.example',
        },
        idToken: 'google-id-token',
      },
    });
    await useAuthStore.getState().signInWithGoogle();
  } else {
    await useAuthStore.getState().signInWithApple();
  }
  // Session is published. Let one rotation happen (≤ 1.5 s covers both the
  // pre-fix 1 s floor and the fixed immediate refresh) and let its
  // persistence settle before asserting.
  await jest.advanceTimersByTimeAsync(1_500);
  await nextMacrotask();
  await nextMacrotask();
  return {
    fetchMock,
    refreshes: () => refreshes,
    liveRefreshToken: () => liveRefreshToken,
  };
}

/** The user closes the app: in-memory state is gone, the Keychain record is
 * all that survives. */
function killApp(): void {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
}

const untrustedExpiries: Array<[string, () => number]> = [
  [
    'past expiry (device clock ahead)',
    () => Math.floor(Date.now() / 1000) - 3600,
  ],
  ['expiry inside the 60 s lead', () => Math.floor(Date.now() / 1000) + 30],
  ['millisecond-valued expiry', () => Date.now()],
  ['expiry beyond 24 h', () => Math.floor(Date.now() / 1000) + 25 * 3600],
];

describe('MAS-1 fix: immediate rotation at sign-in races the session publish', () => {
  it.each(untrustedExpiries)(
    'Apple sign-in with %s: whatever the keeper rotated to is what the ApiSession bears and the Keychain holds',
    async (_label, expiresAt) => {
      const { fetchMock, refreshes, liveRefreshToken } =
        await signInWithUntrustedBootstrapExpiry(expiresAt());

      const state = useAuthStore.getState();
      expect(state.error).toBeNull();
      expect(state.session?.canonicalAppUserId).toBe(canonicalId);
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).endsWith('/v1/auth/refresh'),
        ).length,
      ).toBe(refreshes());
      // The only refresh token the server still honours is the live one; it
      // MUST be what the next launch reads from the Keychain and what the
      // live ApiSession bears (the fixed keeper rotated refresh-1 → refresh-2
      // here, so anything else means the rotation was dropped on the floor).
      const expectedAccess = `access-${refreshes() + 1}`;
      expect(vaultRecord()).toMatchObject({ refreshToken: liveRefreshToken() });
      expect(getApiSession()).toMatchObject({
        bearerToken: expectedAccess,
        refreshToken: liveRefreshToken(),
      });
    },
  );

  it('Google sign-in with a past expiry: same invariant', async () => {
    const { liveRefreshToken, refreshes } =
      await signInWithUntrustedBootstrapExpiry(
        Math.floor(Date.now() / 1000) - 3600,
        'google',
      );
    expect(useAuthStore.getState().error).toBeNull();
    expect(vaultRecord()).toMatchObject({
      provider: 'google',
      refreshToken: liveRefreshToken(),
    });
    expect(getApiSession()).toMatchObject({
      bearerToken: `access-${refreshes() + 1}`,
      refreshToken: liveRefreshToken(),
    });
  });

  it('DURABLE CONTRACT: closing the app right after such a sign-in and relaunching must NOT sign the user out', async () => {
    await signInWithUntrustedBootstrapExpiry(
      Math.floor(Date.now() / 1000) - 3600,
    );
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );

    killApp();
    const hydrating = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    await hydrating;
    await nextMacrotask();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    // The Keychain refresh token must still be the one the server honours —
    // a relaunch is never an implicit sign-out unless the server refuses it.
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(vaultRecord()).not.toBeNull();
  });

  it('Apple sign-in with a TRUSTED expiry (now+3600s) does not rotate at sign-in at all (control)', async () => {
    const { refreshes } = await signInWithUntrustedBootstrapExpiry(
      Math.floor(Date.now() / 1000) + 3600,
    );
    expect(refreshes()).toBe(0);
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-1',
      refreshToken: 'refresh-1',
    });
  });
});
