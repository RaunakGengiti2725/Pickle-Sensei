/**
 * Structural audit (mobile-auth-session, pass 1): authStore lifecycle edges
 * that no existing suite drives — a vault record whose canonical id is not a
 * UUID, a SQLite failure at launch with an intact vault, sign-out before the
 * launch refresh has landed, Keychain write failures during sign-in and
 * rotation, `continueAsGuest` over a durable session, and the ≤ 8s launch
 * deadline under fake timers.
 *
 * Harness mirrors __tests__/authDurableSession.test.ts (in-memory kv LocalDb,
 * module mocks for the provider SDKs, the react-native-keychain auto-mock,
 * URL-routed jest.fn fetch). Cases prefixed SUSPECT are expected to FAIL on
 * 4d812e1a; the rest pin behaviour that holds.
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import {
  refreshSessionNow,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Module seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
/** When set, every getDb() call throws it (SQLite unavailable). */
let mockDbFailure: Error | null = null;

function mockCurrentDb(): LocalDb {
  if (mockDbFailure) throw mockDbFailure;
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const bootstrapBody = (tokens: { access: string; refresh: string }) => ({
  user: { id: canonicalId, email: 'pat@example.com' },
  onboardingState: 'complete',
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});

const refreshBody = (tokens: { access: string; refresh: string }) => ({
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});

type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

function installRoutes(routes: Record<string, RouteHandler>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function callsTo(fetchMock: jest.Mock, suffix: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function seedVault(record: Record<string, unknown>) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify(record),
  });
}

const goodRecord = (refreshToken: string) => ({
  version: 1,
  provider: 'apple',
  canonicalAppUserId: canonicalId,
  refreshToken,
  email: 'pat@example.com',
  displayName: 'Pat Player',
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;
const keychainModule = Keychain as unknown as {
  setGenericPassword: (...args: unknown[]) => Promise<unknown>;
};
const realSetGenericPassword = keychainModule.setGenericPassword;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockDbFailure = null;
  __keychainStore.clear();
  keychainModule.setGenericPassword = realSetGenericPassword;
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
  keychainModule.setGenericPassword = realSetGenericPassword;
  jest.useRealTimers();
});

// ─── Vault record validation at launch ───────────────────────────────────────

describe('audit/authStore: vault record validation at launch', () => {
  it('SUSPECT: a record whose canonicalAppUserId is not a UUID is discarded (vault cleared), not left in place', async () => {
    seedVault({ ...goodRecord('refresh-1'), canonicalAppUserId: 'not-a-uuid' });
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    // Signed out for this launch — correct: the record cannot name a data
    // owner (canonicalDataOwner throws for a non-UUID).
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    // I5: a record the app will never trust must not stay in the Keychain
    // with a live refresh token in it. Observed on 4d812e1a: retained.
    expect(vaultRecord()).toBeNull();
  });

  it('a record with an unknown version is discarded and the vault cleared', async () => {
    seedVault({ ...goodRecord('refresh-1'), version: 2 });
    const fetchMock = installRoutes({});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(vaultRecord()).toBeNull();
  });

  it('SUSPECT: a record with a whitespace-only refresh token is discarded, not restored into a session the server can never refresh', async () => {
    // bootstrap.ts parseSessionTokens trims (so the app never WRITES such a
    // record) but sessionVault.ts parsePersistedSession only checks for a
    // non-empty string. The edge fn answers 400 `validation.refresh` to a
    // blank token, which sessionLifecycle classes as RETRYABLE — so the
    // launch lands signed in with no bearer and a keeper that retries a
    // token the server will refuse forever.
    seedVault(goodRecord('   '));
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(
          {
            error: {
              code: 'validation.refresh',
              message: 'refreshToken is required.',
            },
          },
          400,
        ),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(getApiSession()).toBeNull();
    expect(useAuthStore.getState().session).toBeNull();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(vaultRecord()).toBeNull();
  });

  it('a record with provider "guest" is discarded and the vault cleared', async () => {
    seedVault({ ...goodRecord('refresh-1'), provider: 'guest' });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});

// ─── Local storage failures at launch ────────────────────────────────────────

describe('audit/authStore: SQLite unavailable at launch', () => {
  it('SUSPECT: a getDb() failure with an intact vault must not launch signed out (the vault is the durable sign-in, SQLite holds no session material)', async () => {
    seedVault(goodRecord('refresh-1'));
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    mockDbFailure = new Error('unable to open database file');

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    // The vault was never consulted: no refresh, no session for this launch.
    // Observed on 4d812e1a: session null, zero refresh calls.
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(state.session).toMatchObject({
      provider: 'apple',
      canonicalAppUserId: canonicalId,
    });
  });

  it('the vault record survives a SQLite failure at launch (the next launch can still restore)', async () => {
    seedVault(goodRecord('refresh-1'));
    mockDbFailure = new Error('unable to open database file');
    await useAuthStore.getState().hydrate();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
  });
});

// ─── Launch deadline ─────────────────────────────────────────────────────────

describe('audit/authStore: launch refresh deadline', () => {
  it('a refresh that never answers lets hydrate() resolve signed-in after 8s, and the keeper adopts the tokens when they land', async () => {
    jest.useFakeTimers();
    seedVault(goodRecord('refresh-1'));
    let release: (() => void) | null = null;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        new Promise<Response>(resolve => {
          release = () =>
            resolve(
              response(
                refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
              ),
            );
        }),
    });

    let resolved = false;
    const hydrating = useAuthStore
      .getState()
      .hydrate()
      .then(() => {
        resolved = true;
      });
    await jest.advanceTimersByTimeAsync(7_999);
    expect(resolved).toBe(false);
    // Signed in from the record alone while the refresh is pending.
    expect(useAuthStore.getState().session).toMatchObject({
      canonicalAppUserId: canonicalId,
    });
    expect(getApiSession()).toBeNull();

    await jest.advanceTimersByTimeAsync(1);
    await hydrating;
    expect(resolved).toBe(true);
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session).not.toBeNull();
    expect(getActiveDataOwner()).toBe(canonicalDataOwner(canonicalId));

    release!();
    await jest.advanceTimersByTimeAsync(0);
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });
});

// ─── Sign-out before the launch refresh landed ───────────────────────────────

describe('audit/authStore: sign-out before the launch refresh landed', () => {
  it('SUSPECT: signing out of a session restored offline never revokes the device refresh token server-side, even once the network is back', async () => {
    seedVault(goodRecord('refresh-1'));
    // Launch: the API answers 503 → restore outcome "offline", signed in
    // from the record, keeper backing off, no bearer yet.
    let online = false;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        online
          ? response(refreshBody({ access: 'access-2', refresh: 'refresh-2' }))
          : response({ error: 'unavailable' }, 503),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).not.toBeNull();
    expect(getApiSession()).toBeNull();

    // Network is back; the user taps Sign out before the keeper's retry.
    online = true;
    await useAuthStore.getState().signOut();
    await settle();

    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    // The device held a live refresh token (refresh-1) and was online at
    // sign-out; the server must be told. Observed on 4d812e1a: signOut only
    // revokes through a bearer it already holds (authStore.ts L721), so no
    // /v1/auth/logout (and no refresh-then-logout) ever happens.
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(1);
  });

  it('sign-out during an offline restore stops the keeper: a later retry never resurrects the account', async () => {
    seedVault(goodRecord('refresh-1'));
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => response({ error: 'unavailable' }, 503),
    });
    await useAuthStore.getState().hydrate();
    await useAuthStore.getState().signOut();
    await settle();
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });
});

// ─── Keychain write failures ─────────────────────────────────────────────────

describe('audit/authStore: Keychain write failures', () => {
  it('SUSPECT: a Keychain write failure during sign-in is silently accepted — the user is signed in for this run only and the server session is never revoked', async () => {
    keychainModule.setGenericPassword = async () => {
      throw new Error('errSecInteractionNotAllowed');
    };
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });

    await useAuthStore.getState().signInWithApple();

    const state = useAuthStore.getState();
    expect(state.session).toMatchObject({ canonicalAppUserId: canonicalId });
    expect(getApiSession()?.bearerToken).toBe('access-1');
    // Expected: the failure to make the sign-in durable is visible to the
    // caller (typed error, or at least a durable record). Observed on
    // 4d812e1a: error null, vault empty — the next launch is signed out.
    expect(vaultRecord() !== null || state.error !== null).toBe(true);
  });

  it('SUSPECT: a Keychain write failure during rotation leaves the SPENT refresh token in the vault; the next launch is then refused and signed out', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    // Rotation: the server rotates, the Keychain write fails once.
    keychainModule.setGenericPassword = async () => {
      throw new Error('errSecInteractionNotAllowed');
    };
    let refreshCalls = 0;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': init => {
        refreshCalls += 1;
        const { refreshToken } = JSON.parse(String(init?.body)) as {
          refreshToken: string;
        };
        // Server semantics: only the CURRENT refresh token rotates; a spent
        // one is refused.
        return refreshToken === 'refresh-1' && refreshCalls === 1
          ? response(refreshBody({ access: 'access-2', refresh: 'refresh-2' }))
          : response({ error: 'refused' }, 401);
      },
    });
    refreshSessionNow();
    await settle();
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    // Keychain works again, but nothing re-persists: the vault still holds
    // refresh-1, which the server has already rotated away.
    keychainModule.setGenericPassword = realSetGenericPassword;
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });

    // Relaunch: the stale record is refused → implicit sign-out on a device
    // that was never offline and never signed out.
    stopSessionKeeper();
    clearSyncRuntime();
    clearApiSession();
    useAuthStore.setState({ hydrated: false, session: null });
    await useAuthStore.getState().hydrate();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(2);
    expect(useAuthStore.getState().session).not.toBeNull();
  });
});

// ─── continueAsGuest over a durable session ──────────────────────────────────

describe('audit/authStore: continueAsGuest over a durable session', () => {
  it('SUSPECT: switching to guest leaves the previous account\u2019s refresh token in the Keychain and never revokes it', async () => {
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    await useAuthStore.getState().continueAsGuest();
    await settle();

    expect(useAuthStore.getState().session?.provider).toBe('guest');
    expect(getApiSession()).toBeNull();
    // The account is no longer signed in on this device: its refresh token
    // must not remain durable here. Observed on 4d812e1a: record retained,
    // no /v1/auth/logout.
    expect(vaultRecord()).toBeNull();
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(1);
  });
});
