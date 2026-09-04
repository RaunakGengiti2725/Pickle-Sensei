/**
 * Durable sign-in: closing, backgrounding or killing the app must never sign
 * the user out.
 *
 * Contract pinned here (authStore + sessionVault + sessionKeeper):
 *  - a sign-in persists the Keychain record { provider, canonical id, refresh
 *    token, UI descriptor } — never the access token, never the provider
 *    token, never anything in SQLite kv;
 *  - a relaunch (hydrate) restores the session from that record alone, for
 *    Apple as much as Google, by exchanging the refresh token through
 *    /v1/auth/refresh — no provider SDK involved;
 *  - offline / 5xx / timeouts at launch keep the user signed in (local data
 *    is owner-scoped and available) and the keeper retries;
 *  - the ONE implicit sign-out is the server refusing the refresh token
 *    (401/403): revoked elsewhere, rotated away, or the account is gone;
 *  - explicit sign-out clears the record and revokes the session server-side;
 *  - rotated access tokens reach long-lived clients without reconfiguring:
 *    the billing and training clients send the CURRENT bearer on the wire on
 *    every request, after a relaunch rotation and after an in-session one;
 *  - a 401 for a session that is NOT the signed-in account's is ignored — no
 *    refresh of the signed-in session, no sign-out, no error.
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../src/data/db';
import { useAuthStore } from '../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../src/account/apiSession';
import {
  SESSION_VAULT_SERVICE,
  loadPersistedSession,
} from '../src/account/sessionVault';
import { stopSessionKeeper } from '../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { clearSyncRuntime } from '../src/data/syncRuntime';
import { useAccessStore } from '../src/state/accessStore';
import { useTrainingStore } from '../src/training/store';
import * as Keychain from 'react-native-keychain';

// The auto-mock (__mocks__/react-native-keychain.ts) exposes its in-memory
// store — the same instance sessionVault requires; the real typings
// naturally don't declare it.
const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Module seams ────────────────────────────────────────────────────────────

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
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

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

jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

jest.mock('../src/account/deviceContext', () => ({
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
const otherCanonicalId = '11111111-1111-4111-8111-111111111111';
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

/** Routes fetch by URL suffix; unknown routes reject like a dead network. */
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

/** A route that records each request and answers like a struggling server. */
function recordingRoute(): jest.Mock<Response, [RequestInit | undefined]> {
  return jest.fn((init?: RequestInit) => {
    void init;
    return response({}, 500);
  });
}

function bearerOf(init?: RequestInit): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization ?? headers.authorization;
}

/** Lets the keeper's fire-and-forget refresh chain settle. */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await new Promise<void>(resolve => setTimeout(resolve, 0));
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

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
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
});

// ─── Sign-in persists exactly the right material ─────────────────────────────

describe('signing in persists a durable session', () => {
  it('Apple sign-in bears the Supabase access token and stores ONLY the refresh token + descriptor in the Keychain', async () => {
    installRoutes({
      '/v1/account/bootstrap': init => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          appleAuthorizationCode: 'one-use-apple-code',
        });
        return response(
          bootstrapBody({ access: 'access-1', refresh: 'refresh-1' }),
        );
      },
    });

    await useAuthStore.getState().signInWithApple();

    const state = useAuthStore.getState();
    expect(state.error).toBeNull();
    expect(state.session).toMatchObject({
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      localOnly: false,
      displayName: 'Pat Player',
      email: 'pat@example.com',
    });
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-1',
      refreshToken: 'refresh-1',
      canonicalAppUserId: canonicalId,
      provider: 'apple',
    });
    expect(vaultRecord()).toEqual({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      refreshToken: 'refresh-1',
      email: 'pat@example.com',
      displayName: 'Pat Player',
    });
    // Neither the access token nor the provider token is durable anywhere.
    const durable = JSON.stringify([...__keychainStore.values()]);
    expect(durable).not.toContain('access-1');
    expect(durable).not.toContain('apple-identity-token');
    expect(durable).not.toContain('one-use-apple-code');
    for (const value of mockKv.values()) {
      expect(value).not.toContain('refresh-1');
      expect(value).not.toContain('access-1');
      expect(value).not.toContain('apple-identity-token');
      expect(value).not.toContain('one-use-apple-code');
    }
    // Apple gets no legacy silent-restore flag: the vault IS the restore.
    expect(mockKv.get('auth.last-provider') ?? '').toBe('');
  });

  it('Google sign-in persists the vault record too (the legacy flag stays as a fallback)', async () => {
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
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-g', refresh: 'refresh-g' })),
    });

    await useAuthStore.getState().signInWithGoogle();

    expect(useAuthStore.getState().error).toBeNull();
    expect(vaultRecord()).toMatchObject({
      provider: 'google',
      refreshToken: 'refresh-g',
    });
    expect(mockKv.get('auth.last-provider')).toBe(
      JSON.stringify({ version: 1, provider: 'google' }),
    );
  });
});

// ─── Relaunch restores from the vault ────────────────────────────────────────

describe('relaunch (hydrate) with a persisted session', () => {
  it('restores an Apple session from the Keychain alone: no provider SDK, one refresh, rotated token re-persisted', async () => {
    seedVault('refresh-1', 'apple');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toEqual({
      provider: 'apple',
      subject: canonicalId,
      canonicalAppUserId: canonicalId,
      localOnly: false,
      displayName: 'Pat Player',
      email: 'pat@example.com',
    });
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
      canonicalAppUserId: canonicalId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/auth/refresh',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'refresh-1' }),
      }),
    );
    // The spent refresh token is replaced by the rotated one.
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(nativeModules.PickleAuth).toBeDefined();
  });

  it('stays signed in when the refresh cannot reach the server (offline launch) and keeps the record for retry', async () => {
    seedVault('refresh-1', 'apple');
    installRoutes({}); // every request fails like a dead network

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(state.error).toBeNull();
    expect(getActiveDataOwner()).toBe(canonicalId);
    // No bearer yet — the keeper retries — but nothing was thrown away.
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
  });

  it('stays signed in on a 5xx from refresh (server trouble is never a sign-out)', async () => {
    seedVault('refresh-1', 'google');
    installRoutes({
      '/v1/auth/refresh': () =>
        response({ error: { message: 'temporarily unavailable' } }, 503),
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(vaultRecord()).not.toBeNull();
    // The legacy Google silent path is NOT consulted while a vault record
    // exists — the record is authoritative.
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
  });

  it('signs out ONLY when the server refuses the refresh token (revoked / rotated away / account gone)', async () => {
    seedVault('refresh-stale', 'apple');
    mockKv.set(
      'auth.last-provider',
      JSON.stringify({ version: 1, provider: 'google' }),
    );
    installRoutes({
      '/v1/auth/refresh': () =>
        response({ error: { message: 'Sign in again.' } }, 401),
    });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(state.error).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(vaultRecord()).toBeNull();
    // A revoked session must not be resurrected by the legacy silent path.
    expect(mockKv.get('auth.last-provider')).toBe('');
  });

  it('discards a malformed Keychain record instead of trusting it', async () => {
    __keychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: '{"version":1,"provider":"apple"}',
    });

    await expect(loadPersistedSession()).resolves.toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
  });
});

// ─── Explicit sign-out ───────────────────────────────────────────────────────

describe('explicit sign-out', () => {
  it('clears the Keychain record and revokes the session server-side, so the next launch starts signed out', async () => {
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    expect(vaultRecord()).not.toBeNull();

    await useAuthStore.getState().signOut();

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer access-1' }),
      }),
    );

    fetchMock.mockClear();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sign-out completes locally even when the revoke call cannot reach the server', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();

    await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();

    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});

// ─── Rotation reaches long-lived clients ─────────────────────────────────────

describe('access-token rotation', () => {
  it('long-lived clients resolve the CURRENT bearer for the signed-in account and nothing for any other', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(bearerTokenFor(canonicalId)).toBe('access-1');
    expect(bearerTokenFor(otherCanonicalId)).toBeNull();

    // Relaunch → refresh rotates the bearer; the same resolver follows it.
    seedVault('refresh-1', 'apple');
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();
    expect(bearerTokenFor(canonicalId)).toBe('access-2');

    await useAuthStore.getState().signOut();
    expect(bearerTokenFor(canonicalId)).toBeNull();
  });

  it('the billing and training clients send the rotated bearer on the wire after a relaunch refresh, without a reconfigure', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(bearerTokenFor(canonicalId)).toBe('access-1');

    seedVault('refresh-1', 'apple');
    const accessCalls = recordingRoute();
    const trainingCalls = recordingRoute();
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
      '/v1/me/access': accessCalls,
      '/v1/me/saved-drills': trainingCalls,
    });
    await useAuthStore.getState().hydrate();
    expect(bearerTokenFor(canonicalId)).toBe('access-2');

    await useAccessStore.getState().refreshAccess();
    await useTrainingStore.getState().loadSavedDrills();

    expect(accessCalls).toHaveBeenCalledTimes(1);
    expect(bearerOf(accessCalls.mock.calls[0][0])).toBe('Bearer access-2');
    expect(trainingCalls).toHaveBeenCalledTimes(1);
    expect(bearerOf(trainingCalls.mock.calls[0][0])).toBe('Bearer access-2');
  });

  it('after an in-session rotation (401 → keeper refresh) both clients follow the new bearer', async () => {
    const accessCalls = recordingRoute();
    const trainingCalls = recordingRoute();
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-3', refresh: 'refresh-3' })),
      '/v1/me/access': accessCalls,
      '/v1/me/saved-drills': trainingCalls,
    });
    await useAuthStore.getState().signInWithApple();

    await useAccessStore.getState().refreshAccess();
    await useTrainingStore.getState().loadSavedDrills();
    expect(bearerOf(accessCalls.mock.calls[0]?.[0])).toBe('Bearer access-1');
    expect(bearerOf(trainingCalls.mock.calls[0]?.[0])).toBe('Bearer access-1');

    // A 401 for the CURRENT bearer → the keeper rotates it right now.
    reportApiUnauthorized('access-1');
    await settle();
    expect(getApiSession()?.bearerToken).toBe('access-3');
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );

    await useAccessStore.getState().refreshAccess();
    await useTrainingStore.getState().loadSavedDrills();
    expect(bearerOf(accessCalls.mock.calls[1]?.[0])).toBe('Bearer access-3');
    expect(bearerOf(trainingCalls.mock.calls[1]?.[0])).toBe('Bearer access-3');
  });
});

// ─── A 401 for someone else's session is not ours to act on ──────────────────

describe('a 401 for a session that is not the signed-in account', () => {
  it('is ignored: no refresh of the signed-in session, no sign-out, no error', async () => {
    const refreshCalls = jest.fn(() =>
      response(refreshBody({ access: 'access-9', refresh: 'refresh-9' })),
    );
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': refreshCalls,
    });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );

    // A stale ApiSession for ANOTHER account becomes current (e.g. a
    // late-landing bootstrap for the previous owner) and its bearer is
    // rejected by the API.
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'other-access',
      canonicalAppUserId: otherCanonicalId,
      provider: 'google',
      refreshToken: 'other-refresh',
      bearerExpiresAtMs: FAR_FUTURE_SECONDS * 1000,
    });
    reportApiUnauthorized('other-access');
    await settle();

    expect(refreshCalls).not.toHaveBeenCalled();
    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(state.error).toBeNull();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
  });
});
