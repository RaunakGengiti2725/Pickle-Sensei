/**
 * ATTACK AREA: sign-in -> relaunch -> history under interrupted sessions,
 * corrupted persisted state and slow/lost refresh responses.
 *
 * Invariants under attack (AGENTS.md "Auth sessions"):
 *  - the ONE implicit sign-out is a refresh refusal (401/403);
 *  - an explicit sign-out must win over any refresh still in flight — a late
 *    rotated credential must never be re-persisted or re-adopted;
 *  - unknown/corrupt Keychain state never becomes authorization, never
 *    switches the data owner to a fabricated owner, and never sends garbage
 *    to /v1/auth/refresh;
 *  - the active data owner always matches the session shown to the user.
 *
 * Module seams follow __tests__/authDurableSession.test.ts (kv-backed LocalDb,
 * auto-mocked react-native-keychain, URL-suffix routed fetch); jest module
 * mocks are per file so the seams are re-declared here rather than imported.
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { stopBillingLifecycle } from '../../src/billing/lifecycle';
import { useAppStore } from '../../src/state/appStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

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
const refreshBody = (tokens: { access: string; refresh: string }) => ({
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});
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
function seedRawVault(password: string) {
  __keychainStore.set(SESSION_VAULT_SERVICE, { username: 'session', password });
}
function seedVault(
  refreshToken: string,
  provider: 'apple' | 'google' = 'apple',
) {
  seedRawVault(
    JSON.stringify({
      version: 1,
      provider,
      canonicalAppUserId: canonicalId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  );
}
async function flush(turns = 100) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}
function refreshCalls(fetchMock: jest.Mock) {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith('/v1/auth/refresh'),
  );
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  __keychainStore.clear();
  stopBillingLifecycle();
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
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    ownerContext: null,
    awaitingApiSession: false,
    profile: null,
    hydrateError: null,
  });
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  nativeModules.PickleAuth = { signInWithApple: jest.fn() };
  installRoutes({});
});
afterEach(() => {
  stopBillingLifecycle();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

describe('explicit sign-out racing a slow launch refresh', () => {
  it('a rotated credential that lands AFTER the user signed out is neither adopted nor persisted, and the next launch stays signed out', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    seedVault('refresh-1');
    let deliver!: (value: Response) => void;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        new Promise<Response>(resolve => {
          deliver = resolve;
        }),
      '/v1/auth/logout': () => response(null, 204),
    });
    const launch = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await launch;
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(getApiSession()).toBeNull();

    await useAuthStore.getState().signOut();
    expect(vaultRecord()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);

    // The refresh the launch started now completes with rotated tokens.
    deliver(
      response(refreshBody({ access: 'late-access', refresh: 'late-refresh' })),
    );
    await jest.advanceTimersByTimeAsync(0);
    await flush();

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(vaultRecord()).toBeNull();

    // Relaunch: nothing may come back.
    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(refreshCalls(fetchMock)).toHaveLength(1);
  });

  it('a refresh refusal that lands after the launch deadline signs out exactly once and leaves no credential behind', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    seedVault('refresh-1');
    let deliver!: (value: Response) => void;
    installRoutes({
      '/v1/auth/refresh': () =>
        new Promise<Response>(resolve => {
          deliver = resolve;
        }),
    });
    const launch = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await launch;
    expect(getActiveDataOwner()).toBe(canonicalId);

    deliver(response({ error: { message: 'Sign in again.' } }, 401));
    await jest.advanceTimersByTimeAsync(0);
    await flush();

    expect(useAuthStore.getState().session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});

describe('corrupted Keychain state at relaunch', () => {
  it.each([
    ['guest sentinel as owner', { canonicalAppUserId: GUEST_DATA_OWNER }],
    [
      'signed-out sentinel as owner',
      { canonicalAppUserId: SIGNED_OUT_DATA_OWNER },
    ],
    ['SQL-ish owner', { canonicalAppUserId: "' OR 1=1 --" }],
    ['refresh token is an object', { refreshToken: { token: 'x' } }],
    ['whitespace refresh token', { refreshToken: '   ' }],
    ['provider guest', { provider: 'guest' }],
    ['negative generation', { generation: -1 }],
  ])(
    'never signs in, never switches owner and never calls refresh for a record with %s',
    async (_label, overrides) => {
      seedRawVault(
        JSON.stringify({
          version: 1,
          provider: 'apple',
          canonicalAppUserId: canonicalId,
          refreshToken: 'refresh-1',
          email: 'pat@example.com',
          displayName: 'Pat Player',
          ...overrides,
        }),
      );
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () =>
          response(refreshBody({ access: 'a', refresh: 'r' })),
      });
      await useAuthStore.getState().hydrate();
      const state = useAuthStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.session).toBeNull();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(getApiSession()).toBeNull();
      expect(refreshCalls(fetchMock)).toHaveLength(0);
      // Not trusted: the launch reports the vault as unusable instead of
      // fabricating either a signed-in or a clean signed-out state.
      expect(state.restoreState).toEqual({
        status: 'unavailable',
        reason: 'vault_invalid',
      });
      // A second launch must behave identically (no state is invented).
      useAuthStore.setState({ hydrated: false });
      await useAuthStore.getState().hydrate();
      expect(useAuthStore.getState().session).toBeNull();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(refreshCalls(fetchMock)).toHaveLength(0);
    },
  );

  it('a record from a NEWER schema is not trusted but also not destroyed (downgrade safety), and no refresh is attempted', async () => {
    seedRawVault(
      JSON.stringify({
        version: 2,
        provider: 'apple',
        canonicalAppUserId: canonicalId,
        refreshToken: 'refresh-from-newer-build',
      }),
    );
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'a', refresh: 'r' })),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(refreshCalls(fetchMock)).toHaveLength(0);
    expect(vaultRecord()).toMatchObject({ version: 2 });
  });

  it('a valid record whose owner id has stray case/whitespace is normalized to ONE owner key so history is not split', async () => {
    seedRawVault(
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: `  ${canonicalId.toUpperCase()} `,
        refreshToken: 'refresh-1',
      }),
    );
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(getApiSession()?.canonicalAppUserId).toBe(canonicalId);
    expect(vaultRecord()).toMatchObject({ canonicalAppUserId: canonicalId });
  });
});

describe('corrupted SQLite flags beside a valid vault record', () => {
  it.each([
    ['non-JSON', 'not json at all {'],
    ['huge string', 'x'.repeat(200_000)],
    ['wrong shape', JSON.stringify({ version: 1, mode: 'guest', provider: 7 })],
    ['array', JSON.stringify([1, 2, 3])],
  ])(
    'ignores %s in auth.session / auth.last-provider / auth.local-mode and still restores from the vault',
    async (_label, garbage) => {
      seedVault('refresh-1');
      mockKv.set('auth.session', garbage);
      mockKv.set('auth.last-provider', garbage);
      mockKv.set('auth.local-mode', garbage);
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () =>
          response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
      });
      await useAuthStore.getState().hydrate();
      const state = useAuthStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.session?.canonicalAppUserId).toBe(canonicalId);
      expect(state.session?.localOnly).toBe(false);
      expect(getActiveDataOwner()).toBe(canonicalId);
      expect(getApiSession()?.bearerToken).toBe('access-2');
      expect(refreshCalls(fetchMock)).toHaveLength(1);
      expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    },
  );

  it('a stale local-only flag next to a signed-in vault record never leaves the owner and the visible session disagreeing', async () => {
    seedVault('refresh-1');
    mockKv.set(
      'auth.local-mode',
      JSON.stringify({ version: 1, mode: 'guest' }),
    );
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();
    const session = useAuthStore.getState().session;
    expect(session).not.toBeNull();
    const owner = getActiveDataOwner();
    if (session?.localOnly) expect(owner).toBe(GUEST_DATA_OWNER);
    else {
      expect(session?.canonicalAppUserId).toBe(canonicalId);
      expect(owner).toBe(canonicalId);
    }
    // Whatever wins, the other identity must not also hold an API session.
    const api = getApiSession();
    if (api) expect(api.canonicalAppUserId).toBe(owner);
  });
});
