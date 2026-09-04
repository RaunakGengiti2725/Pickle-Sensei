/**
 * Adversarial pass 3 — mobile auth session (authStore + sessionVault +
 * sessionKeeper + sessionLifecycle + apiSession + accountScope).
 *
 * Each `describe` is one assigned attack scenario (S2–S7) or an extra
 * adversarial probe; every test asserts the ACTUAL behaviour observed at
 * 4d812e1a so a later behaviour change shows up as a failing test. Tests
 * whose observed behaviour is reported as a finding say so in their name
 * ("FINDING:").
 *
 * S1 (RLS + live logout?scope=local) is a live-Auth Docker fixture (real
 * GoTrue + PostgREST + this repo's migrations), not a jest test — see
 * supabase/tests/attack/auth_logout_scope_local.sh.
 *
 * Harness mirrors __tests__/authDurableSession.test.ts (in-memory kv,
 * Keychain auto-mock, URL-routed fetch).
 */
import { AppState, NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
} from '../../src/account/apiSession';
import {
  SESSION_VAULT_SERVICE,
  loadPersistedSession,
} from '../../src/account/sessionVault';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  SessionRefreshError,
  refreshApiSession,
  revokeApiSession,
} from '../../src/account/sessionLifecycle';
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

const API = 'https://api.example.test';
const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const otherId = '11111111-1111-4111-8111-111111111111';
const LOCAL_GUEST_VALUE = JSON.stringify({ version: 1, mode: 'guest' });
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

/** A 200 whose body is not JSON at all. */
function nonJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token <')),
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

const refreshBody = (
  tokens: { access: string; refresh: string },
  expiresAt = FAR_FUTURE_SECONDS,
) => ({
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt,
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

/** A fetch that never answers on its own and rejects with AbortError the
 * moment its AbortSignal fires — how a real fetch behaves on timeout. */
function hangingFetch(): jest.Mock {
  return jest.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const onAbort = () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort);
      }),
  );
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function seedVault(
  refreshToken: string,
  overrides: Record<string, unknown> = {},
) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
      ...overrides,
    }),
  });
}

/** Drain pending promise callbacks without touching (fake) timers. */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

type AppStateListener = (state: string) => void;
let appStateListeners: AppStateListener[] = [];

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;
let addEventListenerSpy: jest.SpyInstance;

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
  appStateListeners = [];
  addEventListenerSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, listener: AppStateListener) => {
      appStateListeners.push(listener);
      return {
        remove: () => {
          appStateListeners = appStateListeners.filter(l => l !== listener);
        },
      };
    }) as unknown as typeof AppState.addEventListener);
  installRoutes({});
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  addEventListenerSpy.mockRestore();
  jest.useRealTimers();
});

function foreground(): void {
  for (const listener of [...appStateListeners]) listener('active');
}

// ─── S2: AbortError after the 15 s request timeout ───────────────────────────

describe('S2 · refresh aborted by the 15 s timeout (fake timers)', () => {
  it('refreshApiSession: the AbortError surfaces as a RETRYABLE SessionRefreshError exactly at 15 000 ms', async () => {
    jest.useFakeTimers();
    const fetchFn = hangingFetch();
    let settled: SessionRefreshError | null = null;
    const pending = refreshApiSession(
      { apiBaseUrl: API, refreshToken: 'refresh-1' },
      { fetchFn },
    ).catch((error: SessionRefreshError) => {
      settled = error;
    });

    await jest.advanceTimersByTimeAsync(14_999);
    expect(settled).toBeNull();
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.signal as AbortSignal).aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect((init.signal as AbortSignal).aborted).toBe(true);
    expect(settled).toBeInstanceOf(SessionRefreshError);
    expect(settled!.retryable).toBe(true);
  });

  it('sessionKeeper: the aborted launch refresh defers (never revokes) and retries exactly 5 s later with the SAME refresh token', async () => {
    jest.useFakeTimers();
    const fetchFn = hangingFetch();
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    const onDeferred = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked,
      onDeferred,
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(15_000);
    expect(onDeferred).toHaveBeenCalledTimes(1);
    const deferredWith = onDeferred.mock.calls[0][0] as SessionRefreshError;
    expect(deferredWith).toBeInstanceOf(SessionRefreshError);
    expect(deferredWith.retryable).toBe(true);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(onRotated).not.toHaveBeenCalled();

    // Retry #1 lands at exactly +5 000 ms (retryDelayMs(1)), not before.
    await jest.advanceTimersByTimeAsync(4_999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String((fetchFn.mock.calls[1][1] as RequestInit).body)),
    ).toEqual({ refreshToken: 'refresh-1' });

    // Backoff doubles: the second failure waits 10 s.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(onDeferred).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('hydrate(): launch proceeds signed-in at 8 s while the hung refresh keeps going; the abort at 15 s keeps the vault and the session', async () => {
    jest.useFakeTimers();
    seedVault('refresh-1');
    const fetchMock = hangingFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let hydrated = false;
    const pending = useAuthStore
      .getState()
      .hydrate()
      .then(() => {
        hydrated = true;
      });

    await jest.advanceTimersByTimeAsync(7_999);
    expect(hydrated).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(hydrated).toBe(true);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(getApiSession()).toBeNull();

    // 15 s: abort → retryable → nothing thrown away.
    await jest.advanceTimersByTimeAsync(7_000);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(useAuthStore.getState().error).toBeNull();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    // 20 s: the retry goes out with the still-valid refresh token.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── S3: 200 with an empty rotated refresh token ─────────────────────────────

describe('S3 · /v1/auth/refresh 200 with session.refreshToken "" (malformed)', () => {
  it.each([
    ['refreshToken ""', { access: 'access-2', refresh: '' }],
    ['refreshToken whitespace', { access: 'access-2', refresh: '   \n\t' }],
    ['accessToken ""', { access: '', refresh: 'refresh-2' }],
  ])(
    'refreshApiSession rejects %s as RETRYABLE, never returning tokens',
    async (_label, tokens) => {
      const fetchFn = jest.fn(async () => response(refreshBody(tokens)));
      await expect(
        refreshApiSession(
          { apiBaseUrl: API, refreshToken: 'refresh-1' },
          { fetchFn },
        ),
      ).rejects.toMatchObject({
        name: 'SessionRefreshError',
        retryable: true,
      });
    },
  );

  it.each([
    ['expiresAt NaN', { expiresAt: Number.NaN }],
    ['expiresAt Infinity', { expiresAt: Number.POSITIVE_INFINITY }],
    ['expiresAt string', { expiresAt: '1900000000' }],
    ['expiresAt missing', { expiresAt: undefined }],
  ])('rejects %s as RETRYABLE', async (_label, patch) => {
    const fetchFn = jest.fn(async () =>
      response({
        session: {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          ...patch,
        },
      }),
    );
    await expect(
      refreshApiSession(
        { apiBaseUrl: API, refreshToken: 'refresh-1' },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ retryable: true });
  });

  it.each([
    ['session: null', { session: null }],
    ['session: []', { session: [] }],
    ['session: "string"', { session: 'access-2' }],
    ['empty object', {}],
    ['top-level array', []],
    ['top-level null', null],
  ])('rejects body %s as RETRYABLE', async (_label, body) => {
    const fetchFn = jest.fn(async () => response(body));
    await expect(
      refreshApiSession(
        { apiBaseUrl: API, refreshToken: 'refresh-1' },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('rejects a 200 whose body is not JSON as RETRYABLE', async () => {
    const fetchFn = jest.fn(async () => nonJsonResponse());
    await expect(
      refreshApiSession(
        { apiBaseUrl: API, refreshToken: 'refresh-1' },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('a 401 with a perfectly well-formed session body is STILL non-retryable (status wins over body)', async () => {
    const fetchFn = jest.fn(async () =>
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' }), 401),
    );
    await expect(
      refreshApiSession(
        { apiBaseUrl: API, refreshToken: 'refresh-1' },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('hydrate(): the empty rotated token is NOT persisted — the vault keeps the spent-but-not-replaced token, the user stays signed in, no bearer is installed', async () => {
    seedVault('refresh-1');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: '' })),
    });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.error).toBeNull();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Nothing from the malformed response leaked into durable storage.
    const durable = JSON.stringify([...__keychainStore.values()]);
    expect(durable).not.toContain('access-2');
    for (const value of mockKv.values()) {
      expect(value).not.toContain('access-2');
      expect(value).not.toContain('refresh-1');
    }
  });

  it('a malformed rotation mid-run keeps the CURRENT bearer and refresh token (nothing is downgraded)', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: '', refresh: '' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(bearerTokenFor(canonicalId)).toBe('access-1');

    refreshSessionNow();
    await flushMicrotasks(16);

    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-1',
      refreshToken: 'refresh-1',
    });
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(useAuthStore.getState().error).toBeNull();
  });
});

// ─── S4: server rotates to a bearer for a DIFFERENT account ──────────────────

describe('S4 · /v1/auth/refresh 200 carrying tokens for another canonicalAppUserId (server bug)', () => {
  it('adoptRotatedTokens keys the rotated pair on the LOCAL id; bearerTokenFor(otherId) is null; the vault owner never changes', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () =>
        response({
          // The wire contract carries no user id; a buggy server could only
          // signal "another user" via extra fields or the JWT itself. Both
          // must be ignored by the client's account binding.
          user: { id: otherId },
          canonicalAppUserId: otherId,
          session: {
            accessToken: 'access-for-other-user',
            refreshToken: 'refresh-for-other-user',
            expiresAt: FAR_FUTURE_SECONDS,
            canonicalAppUserId: otherId,
            user: { id: otherId },
          },
        }),
    });
    await useAuthStore.getState().signInWithApple();

    refreshSessionNow();
    await flushMicrotasks(16);

    const api = getApiSession();
    expect(api).toMatchObject({
      canonicalAppUserId: canonicalId,
      bearerToken: 'access-for-other-user',
      refreshToken: 'refresh-for-other-user',
    });
    expect(bearerTokenFor(canonicalId)).toBe('access-for-other-user');
    expect(bearerTokenFor(otherId)).toBeNull();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: canonicalId,
      refreshToken: 'refresh-for-other-user',
    });
    expect(JSON.stringify(vaultRecord())).not.toContain(otherId);
  });

  it('the same at launch: a persisted session refreshed into "someone else\'s" tokens still resolves only for the persisted owner', async () => {
    seedVault('refresh-1');
    installRoutes({
      '/v1/auth/refresh': () =>
        response({
          user: { id: otherId },
          session: {
            accessToken: 'access-x',
            refreshToken: 'refresh-x',
            expiresAt: FAR_FUTURE_SECONDS,
          },
        }),
    });
    await useAuthStore.getState().hydrate();
    expect(bearerTokenFor(canonicalId)).toBe('access-x');
    expect(bearerTokenFor(otherId)).toBeNull();
    expect(vaultRecord()).toMatchObject({ canonicalAppUserId: canonicalId });
  });

  it('a rotation that lands AFTER sign-out (cancellation mid-flight) is dropped: no bearer, no vault write, no session resurrection', async () => {
    let releaseRefresh: (() => void) | null = null;
    const gate = new Promise<void>(resolve => {
      releaseRefresh = resolve;
    });
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': async () => {
        await gate;
        return response(
          refreshBody({ access: 'access-late', refresh: 'refresh-late' }),
        );
      },
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    refreshSessionNow();
    await flushMicrotasks(4);

    await useAuthStore.getState().signOut();
    expect(vaultRecord()).toBeNull();

    releaseRefresh!();
    await flushMicrotasks(16);

    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });

  it('a rotation that lands after the account CHANGED under it (sign-out → sign-in as B) never touches B', async () => {
    let releaseRefresh: (() => void) | null = null;
    const gate = new Promise<void>(resolve => {
      releaseRefresh = resolve;
    });
    let bootstraps = 0;
    installRoutes({
      '/v1/account/bootstrap': () => {
        bootstraps += 1;
        return bootstraps === 1
          ? response(
              bootstrapBody({ access: 'access-A', refresh: 'refresh-A' }),
            )
          : response({
              user: { id: otherId, email: 'b@example.com' },
              onboardingState: 'complete',
              session: {
                accessToken: 'access-B',
                refreshToken: 'refresh-B',
                expiresAt: FAR_FUTURE_SECONDS,
              },
            });
      },
      '/v1/auth/refresh': async () => {
        await gate;
        return response(
          refreshBody({ access: 'access-A2', refresh: 'refresh-A2' }),
        );
      },
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    refreshSessionNow();
    await flushMicrotasks(4);
    await useAuthStore.getState().signOut();
    await useAuthStore.getState().signInWithApple();
    expect(bearerTokenFor(otherId)).toBe('access-B');

    releaseRefresh!();
    await flushMicrotasks(16);

    expect(bearerTokenFor(otherId)).toBe('access-B');
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(getApiSession()).toMatchObject({
      canonicalAppUserId: otherId,
      refreshToken: 'refresh-B',
    });
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: otherId,
      refreshToken: 'refresh-B',
    });
  });
});

// ─── S5: logout answers 401 then 503 during signOut() ────────────────────────

describe('S5 · /v1/auth/logout fails during signOut()', () => {
  it.each([
    ['401', 401],
    ['503', 503],
    ['500', 500],
    ['429', 429],
  ])(
    'logout %s: signOut resolves, no error surfaces, local material is gone',
    async (_label, status) => {
      const fetchMock = installRoutes({
        '/v1/account/bootstrap': () =>
          response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
        '/v1/auth/logout': () =>
          response({ error: { message: 'nope' } }, status),
      });
      await useAuthStore.getState().signInWithApple();
      expect(vaultRecord()).not.toBeNull();

      await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();

      const state = useAuthStore.getState();
      expect(state.session).toBeNull();
      expect(state.error).toBeNull();
      expect(state.busy).toBe(false);
      expect(getApiSession()).toBeNull();
      expect(vaultRecord()).toBeNull();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(mockKv.get('auth.local-mode')).toBe('');
      expect(mockKv.get('auth.last-provider')).toBe('');
      expect(fetchMock).toHaveBeenCalledWith(
        `${API}/v1/auth/logout`,
        expect.objectContaining({ method: 'POST' }),
      );
    },
  );

  it('401 THEN 503 in one run (sign in → out → in → out): both sign-outs are silent and the second launch is signed out', async () => {
    const logoutStatuses = [401, 503];
    let logoutCalls = 0;
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => {
        const status = logoutStatuses[logoutCalls] ?? 204;
        logoutCalls += 1;
        return response(null, status);
      },
    });
    for (let round = 0; round < 2; round += 1) {
      await useAuthStore.getState().signInWithApple();
      expect(useAuthStore.getState().error).toBeNull();
      await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();
      expect(useAuthStore.getState().error).toBeNull();
      expect(useAuthStore.getState().session).toBeNull();
      expect(vaultRecord()).toBeNull();
    }
    expect(logoutCalls).toBe(2);

    installRoutes({});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
  });

  it('logout that throws synchronously from fetch still completes sign-out', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => {
        throw new TypeError('Network request failed');
      },
    });
    await useAuthStore.getState().signInWithApple();
    await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();
    expect(useAuthStore.getState().error).toBeNull();
    expect(vaultRecord()).toBeNull();
  });

  it('logout that HANGS: signOut() resolves once the 15 s request timeout aborts it (fake timers); local material was already gone at t=0', async () => {
    jest.useFakeTimers();
    const hung = hangingFetch();
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': init => hung('logout', init) as Promise<Response>,
    });
    await useAuthStore.getState().signInWithApple();

    let done = false;
    const pending = useAuthStore
      .getState()
      .signOut()
      .then(() => {
        done = true;
      });
    await flushMicrotasks(16);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(done).toBe(false);

    await jest.advanceTimersByTimeAsync(14_999);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('revokeApiSession never throws for any status or a rejected fetch', async () => {
    const session = {
      apiBaseUrl: API,
      bearerToken: 'access-1',
      canonicalAppUserId: canonicalId,
      provider: 'apple' as const,
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: null,
    };
    for (const status of [200, 204, 400, 401, 403, 404, 429, 500, 502, 503]) {
      await expect(
        revokeApiSession(session, async () => response(null, status)),
      ).resolves.toBeUndefined();
    }
    await expect(
      revokeApiSession(session, async () => {
        throw new Error('boom');
      }),
    ).resolves.toBeUndefined();
  });

  it('rapid double signOut() (two taps) is idempotent: one logout call per bearer, no error, no throw', async () => {
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 503),
    });
    await useAuthStore.getState().signInWithApple();

    await Promise.all([
      useAuthStore.getState().signOut(),
      useAuthStore.getState().signOut(),
    ]);

    const logoutCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/auth/logout'),
    );
    expect(logoutCalls).toHaveLength(1);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});

// ─── S6: vault record with canonicalAppUserId 'not-a-uuid' ───────────────────

describe('S6 · vault canonicalAppUserId "not-a-uuid" → hydrate()', () => {
  it('the vault parser ACCEPTS the record (no UUID validation in sessionVault)', async () => {
    seedVault('refresh-1', { canonicalAppUserId: 'not-a-uuid' });
    await expect(loadPersistedSession()).resolves.toMatchObject({
      canonicalAppUserId: 'not-a-uuid',
      refreshToken: 'refresh-1',
    });
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
  });

  it('FINDING: hydrate() lands signed out, the record is RETAINED, the keeper never starts, and no refresh/revoke is ever sent — on every launch', async () => {
    seedVault('refresh-1', { canonicalAppUserId: 'not-a-uuid' });
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
      '/v1/auth/logout': () => response(null, 204),
    });

    for (let launch = 0; launch < 3; launch += 1) {
      await useAuthStore.getState().hydrate();
      const state = useAuthStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.session).toBeNull();
      expect(state.error).toBeNull();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(getApiSession()).toBeNull();
      // Observed at 4d812e1a: the unusable record (and its live refresh
      // token) survives, and no network call revokes or exchanges it.
      expect(vaultRecord()).toMatchObject({
        canonicalAppUserId: 'not-a-uuid',
        refreshToken: 'refresh-1',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      useAuthStore.setState({ hydrated: false });
    }
  });

  it('the stale record is only ever replaced by a fresh explicit sign-in (which does NOT revoke the orphaned token)', async () => {
    seedVault('refresh-orphan', { canonicalAppUserId: 'not-a-uuid' });
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();

    await useAuthStore.getState().signInWithApple();
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: canonicalId,
      refreshToken: 'refresh-1',
    });
    const logoutCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/auth/logout'),
    );
    expect(logoutCalls).toHaveLength(0);
  });

  it.each([
    ['unicode', 'ユーザー-🥒-id'],
    ['sql-ish', "' OR 1=1 --"],
    ['uuid with trailing junk', `${canonicalId}x`],
    ['uuid v0 (bad version nibble)', '7fc2c743-028f-0ec6-942c-a84508f3be38'],
    ['uuid bad variant nibble', '7fc2c743-028f-4ec6-042c-a84508f3be38'],
    ['1 MiB id', 'a'.repeat(1024 * 1024)],
  ])(
    'any other non-UUID owner (%s) behaves the same: signed out, record retained, zero network',
    async (_label, id) => {
      seedVault('refresh-1', { canonicalAppUserId: id });
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () =>
          response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
      });
      await useAuthStore.getState().hydrate();
      expect(useAuthStore.getState().session).toBeNull();
      expect(useAuthStore.getState().hydrated).toBe(true);
      expect(vaultRecord()).toMatchObject({ canonicalAppUserId: id });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('an UPPER-CASE / padded UUID is restored: owner is normalised but the session id keeps its raw form (bearerTokenFor is exact-match)', async () => {
    const rawId = `  ${canonicalId.toUpperCase()}  `;
    seedVault('refresh-1', { canonicalAppUserId: rawId });
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();
    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(rawId);
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(bearerTokenFor(rawId)).toBe('access-2');
    // Observed: the normalised owner id does NOT resolve a bearer — a client
    // that keys on getActiveDataOwner() would see null here.
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: rawId,
      refreshToken: 'refresh-2',
    });
  });
});

// ─── S7: guest flag AND a valid vault record ─────────────────────────────────

describe('S7 · auth.local-mode = guest AND a valid vault record', () => {
  it('FINDING: guest wins on hydrate(); the vault record is neither restored, cleared nor revoked (zero network)', async () => {
    mockKv.set('auth.local-mode', LOCAL_GUEST_VALUE);
    seedVault('refresh-1');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
      '/v1/auth/logout': () => response(null, 204),
    });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toMatchObject({
      provider: 'guest',
      localOnly: true,
      canonicalAppUserId: null,
    });
    expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
    expect(getApiSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: canonicalId,
      refreshToken: 'refresh-1',
    });
  });

  it('signOut() from that guest state clears the vault LOCALLY but never revokes the orphaned refresh token (no bearer to revoke with)', async () => {
    mockKv.set('auth.local-mode', LOCAL_GUEST_VALUE);
    seedVault('refresh-1');
    const fetchMock = installRoutes({
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().hydrate();

    await useAuthStore.getState().signOut();

    expect(vaultRecord()).toBeNull();
    expect(mockKv.get('auth.local-mode')).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();

    // Next launch: signed out (guest flag gone, vault gone).
    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only the EXACT guest value wins: near-miss values fall through to the vault', async () => {
    for (const nearMiss of [
      JSON.stringify({ mode: 'guest', version: 1 }), // key order differs
      JSON.stringify({ version: 2, mode: 'guest' }),
      JSON.stringify({ version: 1, mode: 'Guest' }),
      'guest',
      '1',
      ' ' + LOCAL_GUEST_VALUE,
    ]) {
      __keychainStore.clear();
      stopSessionKeeper();
      clearApiSession();
      useAuthStore.setState({ hydrated: false, session: null });
      mockKv.set('auth.local-mode', nearMiss);
      seedVault('refresh-1');
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () =>
          response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
      });
      await useAuthStore.getState().hydrate();
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        canonicalId,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('continueAsGuest() while signed in leaves the vault record in place (the state S7 hydrates from)', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(vaultRecord()).not.toBeNull();

    await useAuthStore.getState().continueAsGuest();

    expect(mockKv.get('auth.local-mode')).toBe(LOCAL_GUEST_VALUE);
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    expect(getApiSession()).toBeNull();
  });
});

// ─── Extra adversarial probes ────────────────────────────────────────────────

describe('extra · interleavings, clock skew, foreground, corrupt state', () => {
  it('two concurrent hydrate() calls both spend the SAME refresh token (two refresh POSTs with refresh-1); the FIRST hydrate only settles at the 8 s launch deadline', async () => {
    jest.useFakeTimers();
    seedVault('refresh-1');
    let n = 0;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => {
        n += 1;
        return response(
          refreshBody({ access: `access-${n}`, refresh: `refresh-${n + 1}` }),
        );
      },
    });

    let firstSettled = false;
    const first = useAuthStore
      .getState()
      .hydrate()
      .then(() => {
        firstSettled = true;
      });
    const second = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(7_999);
    // The second keeper stopped the first (generation bump) so the first
    // launch never sees onRotated and rides the deadline instead.
    expect(firstSettled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(firstSettled).toBe(true);

    const refreshBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/auth/refresh'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    // Observed at 4d812e1a: both launches race the same token.
    expect(refreshBodies).toEqual([
      { refreshToken: 'refresh-1' },
      { refreshToken: 'refresh-1' },
    ]);
    // The keeper of the second hydrate owns the outcome; only ONE session
    // is live and its tokens are consistent with the vault.
    const api = getApiSession();
    expect(api?.canonicalAppUserId).toBe(canonicalId);
    expect(vaultRecord()).toMatchObject({ refreshToken: api?.refreshToken });
  });

  it('two concurrent hydrate() where the SECOND refresh is refused (token already rotated by the first) signs the user OUT despite the first success', async () => {
    seedVault('refresh-1');
    let n = 0;
    installRoutes({
      '/v1/auth/refresh': () => {
        n += 1;
        return n === 1
          ? response(refreshBody({ access: 'access-2', refresh: 'refresh-2' }))
          : response({ error: { message: 'refresh_token_not_found' } }, 401);
      },
    });

    jest.useFakeTimers();
    const both = Promise.all([
      useAuthStore.getState().hydrate(),
      useAuthStore.getState().hydrate(),
    ]);
    await jest.advanceTimersByTimeAsync(8_000);
    await both;

    // Observed at 4d812e1a: the second keeper's 401 is treated as revocation.
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getApiSession()).toBeNull();
  });

  it('clock skew: a bearer whose expiresAt is already in the past (device clock behind) is refreshed after MIN_DELAY (1 s), not immediately and not never', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn(async () =>
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: Date.now() - 3_600_000,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(999);
    expect(fetchFn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('FINDING: clock skew ≥ bearer lifetime makes the keeper refresh at 1 Hz forever (every rotated expiresAt is already "past" on the device)', async () => {
    jest.useFakeTimers();
    const deviceNow = () => Date.now();
    // Server clock is 2 h behind the device: each minted bearer "expired" 1 h ago.
    const serverExpiresAt = () =>
      Math.floor(deviceNow() / 1000) - 2 * 3600 + 3600;
    let n = 0;
    const fetchFn = jest.fn(async (_url: string, _init?: RequestInit) => {
      n += 1;
      return response(
        refreshBody(
          { access: `access-${n}`, refresh: `refresh-${n}` },
          serverExpiresAt(),
        ),
      );
    });
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
      now: deviceNow,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10_000);
    // Observed at 4d812e1a: ~1 refresh per second (MIN_DELAY_MS) while skewed.
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(onRotated).toHaveBeenCalledTimes(fetchFn.mock.calls.length);
    // Each rotation used the PREVIOUS response's refresh token (no reuse).
    const bodies = fetchFn.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)).refreshToken,
    );
    expect(bodies.slice(0, 3)).toEqual(['refresh-0', 'refresh-1', 'refresh-2']);
  });

  it('foreground while a refresh is in flight does NOT start a second refresh; foreground with a fresh bearer does nothing', async () => {
    jest.useFakeTimers();
    const hung = hangingFetch();
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn: hung,
    });
    expect(hung).toHaveBeenCalledTimes(1);
    foreground();
    foreground();
    foreground();
    await flushMicrotasks();
    expect(hung).toHaveBeenCalledTimes(1);
    stopSessionKeeper();

    const fresh = jest.fn(async () =>
      response(refreshBody({ access: 'a', refresh: 'r' })),
    );
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: Date.now() + 3_600_000,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn: fresh,
    });
    foreground();
    await flushMicrotasks();
    expect(fresh).not.toHaveBeenCalled();
  });

  it('foreground with < 5 min of bearer left refreshes immediately; a stopped keeper ignores foreground', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn(async () =>
      response(refreshBody({ access: 'a2', refresh: 'r2' })),
    );
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'r1',
      bearerExpiresAtMs: Date.now() + 4 * 60_000,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    foreground();
    await flushMicrotasks();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    stopSessionKeeper();
    foreground();
    await flushMicrotasks();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(appStateListeners).toHaveLength(0);
  });

  it('stop/start churn (rapid repeats) leaks no AppState listeners and no timers', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn(async () =>
      response(refreshBody({ access: 'a', refresh: 'r' })),
    );
    for (let i = 0; i < 50; i += 1) {
      startSessionKeeper({
        apiBaseUrl: API,
        refreshToken: `r-${i}`,
        bearerExpiresAtMs: Date.now() + 3_600_000,
        onRotated: jest.fn(),
        onRevoked: jest.fn(),
        fetchFn,
      });
    }
    expect(appStateListeners).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);
    stopSessionKeeper();
    expect(appStateListeners).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a stale keeper's in-flight success after stopSessionKeeper() is dropped (no onRotated, no reschedule)", async () => {
    jest.useFakeTimers();
    let release: (() => void) | null = null;
    const fetchFn = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          release = () =>
            resolve(refreshBody({ access: 'a', refresh: 'r' }) as never);
        }),
    );
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'r1',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn: async () => response(await fetchFn()),
    });
    stopSessionKeeper();
    release!();
    await flushMicrotasks(16);
    expect(onRotated).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('Keychain read failure (permission denied / locked) at launch: signed out for this run, record untouched, next launch restores', async () => {
    seedVault('refresh-1');
    const getSpy = jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValueOnce(
        new Error('The user interaction is not allowed. (-25308)'),
      );
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });

    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(__keychainStore.get(SESSION_VAULT_SERVICE)?.password).toContain(
      'refresh-1',
    );

    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
    getSpy.mockRestore();
  });

  it('Keychain WRITE failure on rotation: the in-memory session adopts the new tokens and nothing throws (the vault keeps the older token)', async () => {
    seedVault('refresh-1');
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    const setSpy = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValue(new Error('errSecIO'));

    await useAuthStore.getState().hydrate();
    await flushMicrotasks(8);
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
    expect(getApiSession()?.refreshToken).toBe('refresh-2');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    setSpy.mockRestore();
  });

  it.each([
    ['huge refresh token (1 MiB)', { refreshToken: 'r'.repeat(1024 * 1024) }],
    ['unicode descriptor', { email: 'パット@例え.jp', displayName: '🥒 Pat' }],
    ['email/displayName wrong types', { email: 42, displayName: ['x'] }],
    ['extra unknown fields', { extra: { nested: true }, token: 'x' }],
  ])('vault tolerates %s and restores', async (_label, overrides) => {
    seedVault('refresh-1', overrides);
    const expected = { refreshToken: 'refresh-1', ...overrides } as Record<
      string,
      unknown
    >;
    installRoutes({
      '/v1/auth/refresh': init => {
        expect(JSON.parse(String(init?.body)).refreshToken).toBe(
          expected.refreshToken,
        );
        return response(
          refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
        );
      },
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
  });

  it.each([
    ['version 2', { version: 2 }],
    ['version "1"', { version: '1' }],
    ['provider guest', { provider: 'guest' }],
    ['provider Apple (case)', { provider: 'Apple' }],
    ['refreshToken ""', { refreshToken: '' }],
    ['refreshToken number', { refreshToken: 123 }],
    ['canonicalAppUserId ""', { canonicalAppUserId: '' }],
    ['canonicalAppUserId null', { canonicalAppUserId: null }],
  ])(
    'a structurally malformed record (%s) is discarded AND cleared, landing signed out with zero network',
    async (_label, overrides) => {
      seedVault('refresh-1', overrides);
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () =>
          response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
      });
      await useAuthStore.getState().hydrate();
      expect(useAuthStore.getState().session).toBeNull();
      expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['not JSON', 'refresh-1'],
    ['JSON array', '[1,2,3]'],
    ['JSON string', '"refresh-1"'],
    ['empty string', ''],
    ['truncated JSON', '{"version":1,"provider":"apple","canonicalAppUserId":'],
  ])(
    'a non-object Keychain payload (%s) is discarded and cleared',
    async (_l, raw) => {
      __keychainStore.set(SESSION_VAULT_SERVICE, {
        username: 'session',
        password: raw,
      });
      await useAuthStore.getState().hydrate();
      expect(useAuthStore.getState().session).toBeNull();
      expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    },
  );

  it('a revoked launch refresh (401) with the legacy Google flag set does NOT resurrect the account via silent Google restore', async () => {
    seedVault('refresh-stale', { provider: 'google' });
    mockKv.set(
      'auth.last-provider',
      JSON.stringify({ version: 1, provider: 'google' }),
    );
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: { idToken: 'google-id-token', user: { id: 'g', email: null } },
    });
    installRoutes({
      '/v1/auth/refresh': () => response({ error: {} }, 401),
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-z', refresh: 'refresh-z' })),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(vaultRecord()).toBeNull();
    expect(mockKv.get('auth.last-provider')).toBe('');
  });

  it('refresh 403 mid-run (revoked elsewhere) drops the session with NO user-facing error and clears the vault', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () => response({ error: {} }, 403),
    });
    await useAuthStore.getState().signInWithApple();
    refreshSessionNow();
    await flushMicrotasks(16);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });

  it('50 rapid refreshSessionNow() taps while one refresh is in flight produce exactly ONE request', async () => {
    let release: (() => void) | null = null;
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
        return response(
          refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
        );
      },
    });
    const fetchMock = globalThis.fetch as unknown as jest.Mock;
    await useAuthStore.getState().signInWithApple();
    for (let i = 0; i < 50; i += 1) refreshSessionNow();
    await flushMicrotasks(4);
    const refreshCalls = () =>
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/auth/refresh'),
      ).length;
    expect(refreshCalls()).toBe(1);
    release!();
    await flushMicrotasks(16);
    expect(refreshCalls()).toBe(1);
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
  });
});
