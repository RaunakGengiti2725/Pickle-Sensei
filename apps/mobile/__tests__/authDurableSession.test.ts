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
 *  - rotated access tokens reach long-lived clients without reconfiguring.
 */
import { AppState, NativeModules } from 'react-native';
import type { LocalDb } from '../src/data/db';
import { useAuthStore } from '../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
  useApiSessionStore,
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
import * as Keychain from 'react-native-keychain';
import * as repository from '../src/data/repository';
import * as billing from '../src/billing';
import * as accessStore from '../src/state/accessStore';
import * as trainingApi from '../src/training/api';
import * as trainingStore from '../src/training/store';
import * as syncRuntime from '../src/data/syncRuntime';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
}

function freshAuthRuntime() {
  let runtime!: {
    auth: typeof useAuthStore;
    apiSession: typeof getApiSession;
    stop: typeof stopSessionKeeper;
  };
  jest.isolateModules(() => {
    runtime = {
      auth: jest.requireActual<typeof import('../src/auth/authStore')>(
        '../src/auth/authStore',
      ).useAuthStore,
      apiSession: jest.requireActual<
        typeof import('../src/account/apiSession')
      >('../src/account/apiSession').getApiSession,
      stop: jest.requireActual<typeof import('../src/account/sessionKeeper')>(
        '../src/account/sessionKeeper',
      ).stopSessionKeeper,
    };
  });
  return runtime;
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

afterEach(async () => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  jest.restoreAllMocks();
  await useAuthStore.getState().continueAsGuest();
  jest.useRealTimers();
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
  it.each(['false', 'throw'] as const)(
    'Retry cannot undo offline sign-out when reset returns %s and the old record is readable',
    async failure => {
      installRoutes({
        '/v1/account/bootstrap': () =>
          response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      });
      await useAuthStore.getState().signInWithApple();
      const reset = jest.spyOn(Keychain, 'resetGenericPassword');
      if (failure === 'false') reset.mockResolvedValue(false);
      else reset.mockRejectedValue(new Error('Keychain unavailable'));
      const fetchMock = installRoutes({});

      await useAuthStore.getState().signOut();
      expect(reset).toHaveBeenCalledTimes(3);
      expect(vaultRecord()?.refreshToken).toBe('refresh-1');
      expect(useAuthStore.getState().error?.code).toBe(
        'auth.persistence_failed',
      );
      fetchMock.mockClear();
      mockGoogleSignin.signInSilently.mockClear();
      mockGoogleSignin.hasPreviousSignIn.mockClear();

      for (let retry = 0; retry < 2; retry += 1) {
        useAuthStore.getState().clearError();
        await useAuthStore.getState().hydrate();
        expect(useAuthStore.getState().session).toBeNull();
        expect(getApiSession()).toBeNull();
        expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
        expect(useAuthStore.getState().error?.code).toBe(
          'auth.persistence_failed',
        );
      }
      expect(reset).toHaveBeenCalledTimes(9);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
      expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
      expect(JSON.stringify([...mockKv.values()])).not.toMatch(
        /refresh-1|access-1|apple-identity-token|pat@example.com|Pat Player|7fc2c743/,
      );
    },
  );

  it.each(['false', 'throw'] as const)(
    'a fresh auth module honors the durable logout intent after reset %s',
    async failure => {
      installRoutes({
        '/v1/account/bootstrap': () =>
          response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      });
      await useAuthStore.getState().signInWithApple();
      const reset = jest.spyOn(Keychain, 'resetGenericPassword');
      if (failure === 'false') reset.mockResolvedValue(false);
      else reset.mockRejectedValue(new Error('Keychain unavailable'));
      await useAuthStore.getState().signOut();
      mockKv.set(
        'auth.last-provider',
        JSON.stringify({ version: 1, provider: 'google' }),
      );
      mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
      const fetchMock = installRoutes({});
      const relaunched = freshAuthRuntime();
      try {
        await relaunched.auth.getState().hydrate();
        await relaunched.auth.getState().hydrate();
        expect(relaunched.auth.getState().session).toBeNull();
        expect(relaunched.apiSession()).toBeNull();
        expect(relaunched.auth.getState().error?.code).toBe(
          'auth.persistence_failed',
        );
        expect(vaultRecord()?.refreshToken).toBe('refresh-1');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
        expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
      } finally {
        relaunched.stop();
      }
    },
  );

  it('uses a credential-free vault tombstone if SQLite cannot save logout intent', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    mockKv.set(
      'auth.last-provider',
      JSON.stringify({ version: 1, provider: 'google' }),
    );
    mockKv.set(
      'auth.local-mode',
      JSON.stringify({ version: 1, mode: 'guest' }),
    );
    jest
      .spyOn(repository, 'setKv')
      .mockRejectedValue(new Error('SQLite unavailable'));
    jest.spyOn(Keychain, 'resetGenericPassword').mockResolvedValue(false);
    await useAuthStore.getState().signOut();

    expect(vaultRecord()).toEqual({
      version: 1,
      signedOut: true,
      guest: false,
    });
    expect(mockKv.has('auth.logout-intent')).toBe(false);
    const fetchMock = installRoutes({});
    const relaunched = freshAuthRuntime();
    try {
      await relaunched.auth.getState().hydrate();
      await relaunched.auth.getState().hydrate();
      expect(relaunched.auth.getState().session).toBeNull();
      expect(relaunched.apiSession()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
      expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    } finally {
      relaunched.stop();
    }
  });

  it('fails closed in this run and gives an honest warning when neither storage channel can record sign-out', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    jest
      .spyOn(repository, 'setKv')
      .mockRejectedValue(new Error('SQLite unavailable'));
    jest.spyOn(Keychain, 'resetGenericPassword').mockResolvedValue(false);
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValue(new Error('Keychain unavailable'));
    await useAuthStore.getState().signOut();
    expect(vaultRecord()?.refreshToken).toBe('refresh-1');
    expect(mockKv.has('auth.logout-intent')).toBe(false);
    const fetchMock = installRoutes({});

    for (let retry = 0; retry < 3; retry += 1) {
      useAuthStore.getState().clearError();
      await useAuthStore.getState().hydrate();
      reportApiUnauthorized('access-1');
      expect(useAuthStore.getState().session).toBeNull();
      expect(getApiSession()).toBeNull();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(useAuthStore.getState().error).toMatchObject({
        code: 'auth.persistence_failed',
        message: expect.stringContaining('only while this app stays open'),
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
  });

  it('only unblocks for an explicit new sign-in whose credential and markers were safely persisted', async () => {
    const otherId = '22222222-2222-4222-8222-222222222222';
    let owner = canonicalId;
    installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          ...bootstrapBody({
            access: `access-${owner}`,
            refresh: `refresh-${owner}`,
          }),
          user: { id: owner, email: null },
        }),
    });
    await useAuthStore.getState().signInWithApple();
    const reset = jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockResolvedValue(false);
    await useAuthStore.getState().signOut();
    owner = otherId;
    const set = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockResolvedValue(false);
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().busy).toBe(false);
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()?.canonicalAppUserId).toBe(canonicalId);
    expect(mockKv.get('auth.logout-intent')).not.toBe('');
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();

    set.mockRestore();
    const nativeSet = repository.setKv;
    const marker = jest
      .spyOn(repository, 'setKv')
      .mockImplementation((...args) =>
        args[1] === 'auth.logout-intent' && args[2] === ''
          ? Promise.reject(new Error('SQLite unavailable'))
          : nativeSet(...args),
      );
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()?.canonicalAppUserId).toBe(otherId);
    expect(mockKv.get('auth.logout-intent')).not.toBe('');

    marker.mockRestore();
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(otherId);
    expect(getApiSession()?.canonicalAppUserId).toBe(otherId);
    expect(vaultRecord()?.canonicalAppUserId).toBe(otherId);
    expect(mockKv.get('auth.logout-intent')).toBe('');
    expect(useAuthStore.getState().error).toBeNull();
    reset.mockRestore();
    const fetchMock = installRoutes({});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(otherId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the logout block and storage warning when a newer interactive sign-in is canceled', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    jest.spyOn(Keychain, 'resetGenericPassword').mockResolvedValue(false);
    jest.spyOn(Keychain, 'setGenericPassword').mockResolvedValue(false);
    jest
      .spyOn(repository, 'setKv')
      .mockRejectedValue(new Error('SQLite unavailable'));
    nativeModules.PickleAuth = {
      signInWithApple: jest
        .fn()
        .mockRejectedValue({ code: 'auth.canceled', message: 'Canceled' }),
    };
    const signingOut = useAuthStore.getState().signOut();
    const signingIn = useAuthStore.getState().signInWithApple();
    await Promise.all([signingOut, signingIn]);

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(useAuthStore.getState().error?.message).toContain(
      'only while this app stays open',
    );
    const fetchMock = installRoutes({});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not cancel durable A logout intent when an immediate B sign-in fails to persist', async () => {
    const otherId = '22222222-2222-4222-8222-222222222222';
    let owner = canonicalId;
    installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          ...bootstrapBody({
            access: `access-${owner}`,
            refresh: `refresh-${owner}`,
          }),
          user: { id: owner, email: null },
        }),
    });
    await useAuthStore.getState().signInWithApple();
    jest.spyOn(Keychain, 'resetGenericPassword').mockResolvedValue(false);
    jest.spyOn(Keychain, 'setGenericPassword').mockResolvedValue(false);
    owner = otherId;
    const signingOut = useAuthStore.getState().signOut();
    const signingIn = useAuthStore.getState().signInWithApple();
    await Promise.all([signingOut, signingIn]);

    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()?.canonicalAppUserId).toBe(canonicalId);
    expect(mockKv.get('auth.logout-intent')).toBeTruthy();
    const fetchMock = installRoutes({});
    const relaunched = freshAuthRuntime();
    try {
      await relaunched.auth.getState().hydrate();
      expect(relaunched.auth.getState().session).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      relaunched.stop();
    }
  });

  it('keeps a late failed A clear behind B safe persistence without blocking or erasing B', async () => {
    const otherId = '22222222-2222-4222-8222-222222222222';
    let owner = canonicalId;
    installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          ...bootstrapBody({
            access: `access-${owner}`,
            refresh: `refresh-${owner}`,
          }),
          user: { id: owner, email: null },
        }),
    });
    await useAuthStore.getState().signInWithApple();
    const gate = deferred<boolean>();
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue(false);
    const signingOut = useAuthStore.getState().signOut();
    await settle();
    owner = otherId;
    const signingIn = useAuthStore.getState().signInWithApple();
    await settle();
    gate.resolve(false);
    await Promise.all([signingOut, signingIn]);

    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(otherId);
    expect(getApiSession()?.canonicalAppUserId).toBe(otherId);
    expect(vaultRecord()?.canonicalAppUserId).toBe(otherId);
    expect(mockKv.get('auth.logout-intent')).toBe('');
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('lets cleanup Retry finish without signing back in and preserves safe legacy explicit sign-in', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    const reset = jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockResolvedValue(false);
    await useAuthStore.getState().signOut();
    reset.mockRestore();
    const fetchMock = installRoutes({});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockKv.get('auth.logout-intent')).not.toBe('');

    installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          user: { id: canonicalId, email: null },
          onboardingState: 'complete',
        }),
    });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()?.refreshToken).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(mockKv.get('auth.logout-intent')).toBe('');
  });

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
  it.each([true, false])(
    'does not rotate every second with a clock two hours ahead (relative lifetime: %s)',
    async relativeLifetime => {
      jest.useFakeTimers();
      const serverNow = 1_800_000_000_000;
      jest.setSystemTime(serverNow + 2 * 60 * 60_000);
      seedVault('refresh-1');
      let refreshes = 0;
      installRoutes({
        '/v1/auth/refresh': () => {
          refreshes += 1;
          return response({
            session: {
              accessToken: `access-${refreshes + 1}`,
              refreshToken: `refresh-${refreshes + 1}`,
              expiresAt: serverNow / 1000 + 3600,
              ...(relativeLifetime ? { expiresIn: 3600 } : {}),
            },
          });
        },
      });

      await useAuthStore.getState().hydrate();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(refreshes).toBe(1);
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        canonicalId,
      );
      expect(getApiSession()?.bearerToken).toBe('access-2');
    },
  );

  it('long-lived clients resolve the CURRENT bearer for the signed-in account and nothing for any other', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(bearerTokenFor(canonicalId)).toBe('access-1');
    expect(bearerTokenFor('11111111-1111-4111-8111-111111111111')).toBeNull();

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
});

describe('durable session persistence failures and owner races', () => {
  it('does not acknowledge a launch rotation until its Keychain write finishes', async () => {
    seedVault('refresh-1');
    const gate = deferred<void>();
    const nativeSet = Keychain.setGenericPassword;
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return nativeSet(...args);
      });
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    let hydrated = false;
    const hydration = useAuthStore
      .getState()
      .hydrate()
      .then(() => {
        hydrated = true;
      });
    await settle();
    const acknowledgedBeforeWrite = hydrated;
    gate.resolve();
    await hydration;

    expect(acknowledgedBeforeWrite).toBe(false);
    expect(vaultRecord()?.refreshToken).toBe('refresh-2');
  });

  it('retries a failed initial write without discarding the live sign-in', async () => {
    const set = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(new Error('Keychain temporarily busy'));
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });

    await useAuthStore.getState().signInWithApple();

    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(useAuthStore.getState().error).toBeNull();
    expect(vaultRecord()?.refreshToken).toBe('refresh-1');
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('surfaces exhausted persistence attempts, stays signed in, and retries the same tokens without another exchange', async () => {
    jest.useFakeTimers();
    const set = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(new Error('Keychain busy'))
      .mockRejectedValueOnce(new Error('Keychain busy'))
      .mockRejectedValueOnce(new Error('Keychain busy'));
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });

    await useAuthStore.getState().signInWithApple();
    const firstState = useAuthStore.getState();
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(firstState.session?.canonicalAppUserId).toBe(canonicalId);
    expect(firstState.error?.code).toBe('auth.persistence_failed');
    expect(vaultRecord()?.refreshToken).toBe('refresh-1');
    expect(useAuthStore.getState().error).toBeNull();
    expect(set).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/auth/refresh'),
      ),
    ).toHaveLength(0);
  });

  it('does not restore signed-out material when a rotation write lands after sign-out', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    const gate = deferred<void>();
    const nativeSet = Keychain.setGenericPassword;
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return nativeSet(...args);
      });
    reportApiUnauthorized('access-1');
    await settle();
    const signingOut = useAuthStore.getState().signOut();
    const immediatelySignedOut = useAuthStore.getState().session === null;
    await settle();
    gate.resolve();
    await signingOut;
    await settle();

    expect(immediatelySignedOut).toBe(true);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });

  it('does not overwrite a new owner with an old rotation that was already writing', async () => {
    const otherId = '22222222-2222-4222-8222-222222222222';
    let nextOwner = canonicalId;
    installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          ...bootstrapBody({
            access: `access-${nextOwner}`,
            refresh: `refresh-${nextOwner}`,
          }),
          user: { id: nextOwner, email: null },
        }),
      '/v1/auth/refresh': () =>
        response(
          refreshBody({
            access: 'access-old-rotated',
            refresh: 'refresh-old-rotated',
          }),
        ),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    const gate = deferred<void>();
    const nativeSet = Keychain.setGenericPassword;
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return nativeSet(...args);
      });
    reportApiUnauthorized(`access-${canonicalId}`);
    await settle();
    const signingOut = useAuthStore.getState().signOut();
    nextOwner = otherId;
    const signingIn = useAuthStore.getState().signInWithApple();
    await settle();
    gate.resolve();
    await Promise.all([signingOut, signingIn]);
    await settle();

    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(otherId);
    expect(getApiSession()?.canonicalAppUserId).toBe(otherId);
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: otherId,
      refreshToken: `refresh-${otherId}`,
    });
  });

  it('ignores an initial bootstrap that completes after explicit sign-out', async () => {
    const gate = deferred<Response>();
    installRoutes({ '/v1/account/bootstrap': () => gate.promise });
    const signingIn = useAuthStore.getState().signInWithApple();
    await settle();
    await useAuthStore.getState().signOut();
    gate.resolve(
      response(
        bootstrapBody({ access: 'access-late', refresh: 'refresh-late' }),
      ),
    );
    await signingIn;

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });

  it('ignores a persisted read that completes after explicit sign-out', async () => {
    seedVault('refresh-1');
    const stored = await Keychain.getGenericPassword({
      service: SESSION_VAULT_SERVICE,
    });
    const gate = deferred<void>();
    jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockImplementationOnce(async () => {
        await gate.promise;
        return stored;
      });
    installRoutes({
      '/v1/auth/refresh': () =>
        response(
          refreshBody({ access: 'access-late', refresh: 'refresh-late' }),
        ),
    });
    const hydration = useAuthStore.getState().hydrate();
    await settle();
    const signingOut = useAuthStore.getState().signOut();
    await settle();
    gate.resolve();
    await Promise.all([hydration, signingOut]);
    await settle();

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });

  it('recovers a temporary Keychain read failure without invoking a provider', async () => {
    seedVault('refresh-1');
    jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValueOnce(new Error('Keychain busy'));
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(vaultRecord()?.refreshToken).toBe('refresh-2');
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
  });

  it('does not replace an unreadable durable account with the legacy Google fallback', async () => {
    seedVault('refresh-1');
    mockKv.set(
      'auth.last-provider',
      JSON.stringify({ version: 1, provider: 'google' }),
    );
    jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValue(new Error('Keychain unavailable'));

    await useAuthStore.getState().hydrate();

    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    expect(useAuthStore.getState().error?.code).toBe('auth.persistence_failed');
    expect(vaultRecord()?.refreshToken).toBe('refresh-1');
  });

  it('retries a temporary clear failure so relaunch cannot restore a signed-out account', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValueOnce(new Error('Keychain busy'));

    await useAuthStore.getState().signOut();

    expect(vaultRecord()).toBeNull();
  });
});

describe('generation-bound session cleanup', () => {
  it('does not finish signing in after an initial Keychain write outlives sign-out', async () => {
    const gate = deferred<void>();
    const nativeSet = Keychain.setGenericPassword;
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return nativeSet(...args);
      });
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    const signingIn = useAuthStore.getState().signInWithApple();
    await settle();
    const signingOut = useAuthStore.getState().signOut();
    gate.resolve();
    await Promise.all([signingIn, signingOut]);

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });

  it.each(['continueAsGuest', 'completeAccountDeletion'] as const)(
    '%s invalidates a pending bootstrap as well as its secure write',
    async action => {
      const gate = deferred<Response>();
      installRoutes({ '/v1/account/bootstrap': () => gate.promise });
      const signingIn = useAuthStore.getState().signInWithApple();
      await settle();
      await useAuthStore.getState()[action]();
      gate.resolve(
        response(
          bootstrapBody({ access: 'access-late', refresh: 'refresh-late' }),
        ),
      );
      await signingIn;

      expect(useAuthStore.getState().session?.provider ?? null).toBe(
        action === 'continueAsGuest' ? 'guest' : null,
      );
      expect(useAuthStore.getState().busy).toBe(false);
      expect(getApiSession()).toBeNull();
      expect(vaultRecord()).toBeNull();
    },
  );

  it.each([200, 401, 403])(
    'an old refresh returning %s cannot affect A after A → B → A',
    async status => {
      const owners = [
        canonicalId,
        '22222222-2222-4222-8222-222222222222',
        canonicalId,
      ];
      let round = 0;
      const gate = deferred<Response>();
      installRoutes({
        '/v1/account/bootstrap': () => {
          const index = round++;
          return response({
            ...bootstrapBody({
              access: `access-${index}`,
              refresh: `refresh-${index}`,
            }),
            user: { id: owners[index], email: null },
          });
        },
        '/v1/auth/refresh': () => gate.promise,
        '/v1/auth/logout': () => response(null, 204),
      });
      await useAuthStore.getState().signInWithApple();
      reportApiUnauthorized('access-0');
      await settle();
      const signingOutA = useAuthStore.getState().signOut();
      await useAuthStore.getState().signInWithApple();
      await useAuthStore.getState().signOut();
      await useAuthStore.getState().signInWithApple();
      gate.resolve(
        response(
          refreshBody({ access: 'access-late', refresh: 'refresh-late' }),
          status,
        ),
      );
      await signingOutA;
      await settle();

      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        canonicalId,
      );
      expect(useAuthStore.getState().error).toBeNull();
      expect(getApiSession()?.bearerToken).toBe('access-2');
      expect(vaultRecord()?.refreshToken).toBe('refresh-2');
    },
  );

  it('a delayed clear finishes before a successor save and cannot disconnect its Google SDK', async () => {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: { user: { name: 'Pat', email: null }, idToken: 'google-id-token' },
    });
    let round = 0;
    installRoutes({
      '/v1/account/bootstrap': () => {
        const index = round++;
        return response(
          bootstrapBody({
            access: `access-${index}`,
            refresh: `refresh-${index}`,
          }),
        );
      },
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithGoogle();
    const gate = deferred<void>();
    const nativeReset = Keychain.resetGenericPassword;
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return nativeReset(...args);
      });
    const signingOut = useAuthStore.getState().signOut();
    await settle();
    const signingIn = useAuthStore.getState().signInWithGoogle();
    await settle();
    gate.resolve();
    await Promise.all([signingOut, signingIn]);

    expect(useAuthStore.getState().session?.provider).toBe('google');
    expect(vaultRecord()?.refreshToken).toBe('refresh-1');
    expect(mockKv.get('auth.last-provider')).toBe(
      JSON.stringify({ version: 1, provider: 'google' }),
    );
    expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
  });

  it('does not re-arm legacy restore when a provider marker write finishes after sign-out', async () => {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: { user: { name: 'Pat', email: null }, idToken: 'google-id-token' },
    });
    const gate = deferred<void>();
    const nativeSet = repository.setKv;
    let blocked = false;
    jest.spyOn(repository, 'setKv').mockImplementation(async (...args) => {
      if (args[1] === 'auth.last-provider' && !blocked) {
        blocked = true;
        await gate.promise;
      }
      return nativeSet(...args);
    });
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    const signingIn = useAuthStore.getState().signInWithGoogle();
    await settle();
    const signingOut = useAuthStore.getState().signOut();
    await settle();
    gate.resolve();
    await Promise.all([signingIn, signingOut]);

    expect(mockKv.get('auth.last-provider')).toBe('');
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
  });

  it('does not finish signing in after the refresh was revoked during a pending metadata write', async () => {
    jest.useFakeTimers();
    const gate = deferred<void>();
    const nativeSet = repository.setKv;
    let blocked = false;
    jest.spyOn(repository, 'setKv').mockImplementation(async (...args) => {
      if (args[1] === 'auth.last-provider' && !blocked) {
        blocked = true;
        await gate.promise;
      }
      return nativeSet(...args);
    });
    installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          ...bootstrapBody({ access: 'access-1', refresh: 'refresh-1' }),
          session: {
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            expiresAt: Math.floor(Date.now() / 1000) - 60,
          },
        }),
      '/v1/auth/refresh': () => response(null, 401),
    });
    const signingIn = useAuthStore.getState().signInWithApple();
    await settle();
    await jest.advanceTimersByTimeAsync(1_000);
    gate.resolve();
    await signingIn;
    await settle();

    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().busy).toBe(false);
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });

  it('reports exhausted clear attempts without bringing the local session back', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    const reset = jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('Keychain unavailable'));

    await useAuthStore.getState().signOut();

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(useAuthStore.getState().error?.code).toBe('auth.persistence_failed');
    expect(reset).toHaveBeenCalledTimes(3);
  });
});

describe('durable retry and client stability', () => {
  it('waits for a readable logout-intent marker before restoring a cold secure session', async () => {
    seedVault('refresh-1');
    const get = jest
      .spyOn(repository, 'getKv')
      .mockRejectedValue(new Error('SQLite busy'));
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error?.code).toBe('auth.persistence_failed');
    expect(vaultRecord()?.refreshToken).toBe('refresh-1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();

    get.mockRestore();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(vaultRecord()?.refreshToken).toBe('refresh-2');
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('retries a failed launch rotation write with the same tokens while keeping its bearer live', async () => {
    jest.useFakeTimers();
    seedVault('refresh-1');
    const set = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(new Error('Keychain busy'))
      .mockRejectedValueOnce(new Error('Keychain busy'))
      .mockResolvedValueOnce(false);
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();
    const firstState = useAuthStore.getState();
    const tokenBeforeRetry = vaultRecord()?.refreshToken;
    await jest.advanceTimersByTimeAsync(5_000);

    expect(firstState.session?.canonicalAppUserId).toBe(canonicalId);
    expect(firstState.error?.code).toBe('auth.persistence_failed');
    expect(tokenBeforeRetry).toBe('refresh-1');
    expect(getApiSession()?.bearerToken).toBe('access-2');
    expect(vaultRecord()?.refreshToken).toBe('refresh-2');
    expect(useAuthStore.getState().error).toBeNull();
    expect(set).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/auth/refresh'),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify([...mockKv.values()])).not.toMatch(
      /access-2|refresh-2/,
    );
  });

  it.each([400, 408, 429, 500, 503])(
    'refresh %s keeps the durable account and retries with backoff',
    async status => {
      jest.useFakeTimers();
      seedVault('refresh-1');
      let calls = 0;
      installRoutes({
        '/v1/auth/refresh': () =>
          ++calls === 1
            ? response(null, status)
            : response(
                refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
              ),
      });
      await useAuthStore.getState().hydrate();
      const firstState = useAuthStore.getState();
      await jest.advanceTimersByTimeAsync(4_999);
      const callsBeforeRetry = calls;
      await jest.advanceTimersByTimeAsync(1);

      expect(firstState.session?.canonicalAppUserId).toBe(canonicalId);
      expect(firstState.error).toBeNull();
      expect(callsBeforeRetry).toBe(1);
      expect(calls).toBe(2);
      expect(vaultRecord()?.refreshToken).toBe('refresh-2');
    },
  );

  it('retries pending persistence on foreground without resetting the configured clients', async () => {
    const listener = jest.spyOn(AppState, 'addEventListener');
    const configureAccess = jest.spyOn(accessStore, 'configureAccessStore');
    const configureTraining = jest.spyOn(
      trainingStore,
      'configureTrainingStore',
    );
    const configureSync = jest.spyOn(syncRuntime, 'configureSyncRuntime');
    const createBilling = jest.spyOn(
      billing,
      'createBillingAccessDependencies',
    );
    const createTraining = jest.spyOn(trainingApi, 'createTrainingApi');
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().signInWithApple();
    const billingConfig = createBilling.mock.calls[0]![0];
    const trainingConfig = createTraining.mock.calls[0]![0];
    const accessState = accessStore.useAccessStore.getState();
    const trainingState = trainingStore.useTrainingStore.getState();
    const set = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(new Error('Keychain busy'))
      .mockRejectedValueOnce(new Error('Keychain busy'))
      .mockRejectedValueOnce(new Error('Keychain busy'));
    reportApiUnauthorized('access-1');
    await settle();
    for (const [, onChange] of listener.mock.calls) onChange('active');
    await settle();

    expect(vaultRecord()?.refreshToken).toBe('refresh-2');
    expect(set).toHaveBeenCalledTimes(4);
    expect(billingConfig.apiToken).toBe('access-2');
    expect(trainingConfig.token).toBe('access-2');
    expect(accessStore.useAccessStore.getState()).toBe(accessState);
    expect(trainingStore.useTrainingStore.getState()).toBe(trainingState);
    expect(configureAccess).toHaveBeenCalledTimes(1);
    expect(configureTraining).toHaveBeenCalledTimes(1);
    expect(configureSync).toHaveBeenCalledTimes(1);
  });
});

describe('explicit revocation without a live bearer', () => {
  it('uses an in-flight refresh only for revocation after synchronously clearing the runtime', async () => {
    const gate = deferred<Response>();
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () => gate.promise,
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    reportApiUnauthorized('access-1');
    await settle();
    const observedBearers: Array<string | null> = [];
    const unsubscribe = useApiSessionStore.subscribe(state =>
      observedBearers.push(state.session?.bearerToken ?? null),
    );
    const signingOut = useAuthStore.getState().signOut();
    await settle();
    const locallyCleared = getApiSession() === null && vaultRecord() === null;
    gate.resolve(
      response(
        refreshBody({
          access: 'access-for-logout',
          refresh: 'refresh-for-logout',
        }),
      ),
    );
    await signingOut;
    await settle();
    unsubscribe();

    expect(locallyCleared).toBe(true);
    expect(observedBearers).toEqual([null]);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/auth/refresh'),
      ),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/auth/logout',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-for-logout',
        }),
      }),
    );
    expect(vaultRecord()).toBeNull();
  });

  it.each([401, 403])(
    'refreshes once for a logout bearer rejected with %s without adopting the result',
    async status => {
      let logouts = 0;
      const fetchMock = installRoutes({
        '/v1/account/bootstrap': () =>
          response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
        '/v1/auth/refresh': () =>
          response(
            refreshBody({
              access: 'access-for-logout',
              refresh: 'refresh-for-logout',
            }),
          ),
        '/v1/auth/logout': () => response(null, ++logouts === 1 ? status : 204),
      });
      await useAuthStore.getState().signInWithApple();
      const observedBearers: Array<string | null> = [];
      const unsubscribe = useApiSessionStore.subscribe(state =>
        observedBearers.push(state.session?.bearerToken ?? null),
      );
      await useAuthStore.getState().signOut();
      unsubscribe();

      expect(logouts).toBe(2);
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).endsWith('/v1/auth/refresh'),
        ),
      ).toHaveLength(1);
      expect(observedBearers).toEqual([null]);
      expect(useAuthStore.getState().session).toBeNull();
      expect(vaultRecord()).toBeNull();
    },
  );

  it('refreshes an expired access token solely for device-local logout', async () => {
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          ...bootstrapBody({ access: 'access-expired', refresh: 'refresh-1' }),
          session: {
            accessToken: 'access-expired',
            refreshToken: 'refresh-1',
            expiresAt: Math.floor(Date.now() / 1000) - 60,
          },
        }),
      '/v1/auth/refresh': () =>
        response(
          refreshBody({
            access: 'access-for-logout',
            refresh: 'refresh-for-logout',
          }),
        ),
      '/v1/auth/logout': init =>
        response(
          null,
          String((init?.headers as Record<string, string>)?.Authorization) ===
            'Bearer access-for-logout'
            ? 204
            : 401,
        ),
    });
    await useAuthStore.getState().signInWithApple();

    await useAuthStore.getState().signOut();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/auth/logout',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-for-logout',
        }),
      }),
    );
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });

  it('can revoke a restored refresh-only session and never install the detached logout tokens', async () => {
    seedVault('refresh-1');
    await useAuthStore.getState().hydrate();
    expect(getApiSession()).toBeNull();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(
          refreshBody({
            access: 'access-for-logout',
            refresh: 'refresh-for-logout',
          }),
        ),
      '/v1/auth/logout': () => response(null, 204),
    });

    await useAuthStore.getState().signOut();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/auth/refresh',
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: 'refresh-1' }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/auth/logout',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-for-logout',
        }),
      }),
    );
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});
