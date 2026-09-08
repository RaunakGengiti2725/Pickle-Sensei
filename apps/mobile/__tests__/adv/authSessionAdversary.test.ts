/**
 * INT-auth-session adversary (integration head 30a40650) — mobile side.
 *
 * Attacks the durable-session contract of authStore + sessionVault +
 * sessionKeeper + sessionLifecycle from the outside: refresh rotation races,
 * account switch and sign-out while a refresh is in flight, the 401-vs-
 * transient boundary on every status the refresh route can answer,
 * expiresAt rollback, vault corruption, token persistence, and the launch
 * deadline followed by a late refusal.
 *
 * Tests named `REPRO (defect)` assert the behaviour observed at the attacked
 * head so the finding is executable; the contract they contradict is stated
 * in the title. Everything else pins behaviour that held under attack.
 *
 *   cd apps/mobile && npx jest __tests__/adv/authSessionAdversary.test.ts
 */
import { AppState, NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import {
  refreshSessionNow,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import { stopBillingLifecycle } from '../../src/billing/lifecycle';
import { useAppStore } from '../../src/state/appStore';
import {
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

const USER_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const USER_B = '0b1c8d2e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

/** A 200 whose body is not JSON at all (HTML error page, truncated stream). */
function unparseable(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token <')),
  } as unknown as Response;
}

const bootstrapBody = (
  tokens: { access: string; refresh: string },
  userId = USER_A,
) => ({
  user: { id: userId, email: `${userId.slice(0, 8)}@example.com` },
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

type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

function installRoutes(routes: Record<string, RouteHandler>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new TypeError(`Network request failed (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function callsTo(fetchMock: jest.Mock, suffix: string): RequestInit[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith(suffix))
    .map(([, init]) => init as RequestInit);
}

function presentedRefreshTokens(fetchMock: jest.Mock): string[] {
  return callsTo(fetchMock, '/v1/auth/refresh').map(init => {
    const parsed = JSON.parse(String(init.body)) as { refreshToken: string };
    return parsed.refreshToken;
  });
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function rawVault(): string | null {
  return __keychainStore.get(SESSION_VAULT_SERVICE)?.password ?? null;
}

function seedVault(
  refreshToken: string,
  provider: 'apple' | 'google' = 'apple',
  userId = USER_A,
) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider,
      canonicalAppUserId: userId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

function seedRawVault(password: string) {
  __keychainStore.set(SESSION_VAULT_SERVICE, { username: 'session', password });
}

async function settle(turns = 120) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function useLaunchTimers() {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
  });
}

type AppStateListener = (state: string) => void;
const appStateListeners = new Set<AppStateListener>();

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  __keychainStore.clear();
  appStateListeners.clear();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      const change = listener as AppStateListener;
      appStateListeners.add(change);
      return { remove: () => appStateListeners.delete(change) };
    });
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
  stopBillingLifecycle();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/** Relaunch with the vault seeded; resolves once the launch wait is over. */
async function relaunch() {
  const restore = useAuthStore.getState().hydrate();
  await jest.advanceTimersByTimeAsync(8_000);
  await restore;
}

// ─── Attack 1: refresh rotation races ────────────────────────────────────────

describe('attack: refresh rotation races', () => {
  it('collapses concurrent triggers (route 401, foreground, explicit) into ONE request and never re-presents a spent refresh token', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    let release!: (value: Response) => void;
    let refreshCalls = 0;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          return new Promise<Response>(resolve => {
            release = resolve;
          });
        }
        return response(
          refreshBody({
            access: `access-${refreshCalls}`,
            refresh: `refresh-${refreshCalls}`,
          }),
        );
      },
    });
    const restore = useAuthStore.getState().hydrate();
    await settle();
    // The launch refresh is in flight: pile on every trigger the app has.
    refreshSessionNow();
    refreshSessionNow();
    for (const listener of appStateListeners) listener('active');
    reportApiUnauthorized('not-the-current-bearer');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(
      response(refreshBody({ access: 'access-1', refresh: 'refresh-1' })),
    );
    await jest.advanceTimersByTimeAsync(0);
    await restore;
    expect(getApiSession()?.bearerToken).toBe('access-1');
    expect(vaultRecord()?.refreshToken).toBe('refresh-1');

    // A route rejects the live bearer: exactly one more rotation, presenting
    // the ROTATED token, not the spent launch token.
    reportApiUnauthorized('access-1');
    await settle();
    expect(presentedRefreshTokens(fetchMock)).toEqual([
      'refresh-0',
      'refresh-1',
    ]);
    expect(getApiSession()?.bearerToken).toBe('access-2');
    expect(vaultRecord()?.refreshToken).toBe('refresh-2');
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
  });

  it('a stale 401 report for a bearer that was already rotated away does not trigger another rotation', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    let n = 0;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => {
        n += 1;
        return response(
          refreshBody({ access: `access-${n}`, refresh: `refresh-${n}` }),
        );
      },
    });
    await relaunch();
    expect(getApiSession()?.bearerToken).toBe('access-1');
    reportApiUnauthorized('access-1');
    await settle();
    expect(getApiSession()?.bearerToken).toBe('access-2');
    // Late 401s for the previous bearer are noise, not a reason to rotate.
    reportApiUnauthorized('access-1');
    reportApiUnauthorized('access-0');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getApiSession()?.bearerToken).toBe('access-2');
  });
});

// ─── Attack 2: account switch / sign-out while a refresh is in flight ────────

describe('attack: account switch and sign-out during an in-flight refresh', () => {
  it('A signs out and B signs in while A refresh is pending: the late A rotation cannot touch B bearer, vault, or owner', async () => {
    useLaunchTimers();
    seedVault('a-refresh-0', 'apple', USER_A);
    let releaseA!: (value: Response) => void;
    let logoutCalls = 0;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        new Promise<Response>(resolve => {
          releaseA = resolve;
        }),
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(
            { access: 'b-access-0', refresh: 'b-refresh-0' },
            USER_B,
          ),
        ),
      '/v1/auth/logout': () => {
        logoutCalls += 1;
        return response(null, 204);
      },
    });
    await relaunch();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
    await useAuthStore.getState().signOut();
    await useAuthStore.getState().signInWithApple();
    const b = useAuthStore.getState().session;
    expect(b?.canonicalAppUserId).toBe(USER_B);
    const ownerB = getActiveDataOwner();

    releaseA(
      response(refreshBody({ access: 'a-access-1', refresh: 'a-refresh-1' })),
    );
    await settle();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(useAuthStore.getState().session).toBe(b);
    expect(getActiveDataOwner()).toBe(ownerB);
    expect(getApiSession()?.canonicalAppUserId).toBe(USER_B);
    expect(getApiSession()?.bearerToken).toBe('b-access-0');
    expect(bearerTokenFor(USER_A)).toBeNull();
    expect(bearerTokenFor(USER_B)).toBe('b-access-0');
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: USER_B,
      refreshToken: 'b-refresh-0',
    });
    expect(rawVault()).not.toContain('a-refresh-1');
    expect(rawVault()).not.toContain('a-access-1');
    // A had no bearer yet (refresh pending), so nothing could be revoked for A.
    expect(logoutCalls).toBe(0);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('sign-out while the refresh is in flight: the late rotation resurrects neither the vault nor a bearer', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    let release!: (value: Response) => void;
    installRoutes({
      '/v1/auth/refresh': () =>
        new Promise<Response>(resolve => {
          release = resolve;
        }),
      '/v1/auth/logout': () => response(null, 204),
    });
    await relaunch();
    await useAuthStore.getState().signOut();
    expect(rawVault()).toBeNull();
    release(
      response(refreshBody({ access: 'late-access', refresh: 'late-refresh' })),
    );
    await settle();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(rawVault()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    for (const value of mockKv.values()) {
      expect(value).not.toContain('late-refresh');
      expect(value).not.toContain('late-access');
    }
    // A relaunch must not restore the account the user signed out of.
    await relaunch();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'signed_out',
      reason: 'user_sign_out',
    });
  });

  it('REPRO (defect): signing out while the launch refresh is still pending (online, slow server) never revokes the server session — no bearer exists yet, so /v1/auth/logout is never called', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    let release!: (value: Response) => void;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        new Promise<Response>(resolve => {
          release = resolve;
        }),
      '/v1/auth/logout': () => response(null, 204),
    });
    await relaunch();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
    expect(getApiSession()).toBeNull();
    await useAuthStore.getState().signOut();
    // The server then rotates the token the device presented; the device
    // drops the result. The session (and its fresh refresh token) stays
    // alive server-side although the user explicitly signed out online.
    release(
      response(refreshBody({ access: 'late-access', refresh: 'late-refresh' })),
    );
    await settle();
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);
    expect(useAuthStore.getState().session).toBeNull();
    expect(rawVault()).toBeNull();
  });
});

// ─── Attack 3: 401 vs transient — every answer the refresh route can give ────

describe('attack: refresh failure classification', () => {
  const transientStatuses = [400, 404, 408, 409, 422, 429, 500, 502, 503, 504];

  it.each(transientStatuses)(
    'a %s from /v1/auth/refresh keeps the session, keeps the vault intact, and retries with backoff',
    async status => {
      useLaunchTimers();
      seedVault('refresh-0');
      let n = 0;
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () => {
          n += 1;
          return n <= 2
            ? response({ error: { message: `forced ${status}` } }, status)
            : response(
                refreshBody({ access: 'access-ok', refresh: 'refresh-ok' }),
              );
        },
        '/v1/auth/logout': () => response(null, 204),
      });
      // Launch (t=0) fails, the 5s retry fails too; the launch wait ends at 8s.
      await relaunch();
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
      expect(getActiveDataOwner()).not.toBe(SIGNED_OUT_DATA_OWNER);
      expect(getApiSession()).toBeNull();
      expect(vaultRecord()?.refreshToken).toBe('refresh-0');
      expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);
      expect(useAuthStore.getState().restoreState).toEqual({
        status: 'restored',
        connectivity: 'offline',
      });
      expect(presentedRefreshTokens(fetchMock)).toEqual([
        'refresh-0',
        'refresh-0',
      ]);
      // Second retry after 10s more (t=15s): the never-spent credential is
      // presented again and the session comes online.
      await jest.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(presentedRefreshTokens(fetchMock)).toEqual([
        'refresh-0',
        'refresh-0',
        'refresh-0',
      ]);
      expect(getApiSession()?.bearerToken).toBe('access-ok');
      expect(vaultRecord()?.refreshToken).toBe('refresh-ok');
      expect(useAuthStore.getState().restoreState).toEqual({
        status: 'restored',
        connectivity: 'online',
      });
    },
  );

  const malformedSuccesses: Array<[string, () => Response]> = [
    ['200 with a non-JSON body', () => unparseable()],
    ['200 with no session', () => response({})],
    ['200 with session: null', () => response({ session: null })],
    [
      '200 missing the refresh token',
      () =>
        response({
          session: { accessToken: 'x', expiresAt: FAR_FUTURE_SECONDS },
        }),
    ],
    [
      '200 with a blank access token',
      () =>
        response({
          session: {
            accessToken: '   ',
            refreshToken: 'r',
            expiresAt: FAR_FUTURE_SECONDS,
          },
        }),
    ],
    [
      '200 with expiresAt as a string',
      () =>
        response({
          session: {
            accessToken: 'a',
            refreshToken: 'r',
            expiresAt: String(FAR_FUTURE_SECONDS),
          },
        }),
    ],
    [
      '200 with expiresAt = Infinity-ish (null)',
      () =>
        response({
          session: { accessToken: 'a', refreshToken: 'r', expiresAt: null },
        }),
    ],
    ['204 empty', () => response(null, 204)],
  ];

  it.each(malformedSuccesses)(
    'a malformed refresh answer (%s) is transient: session kept, vault untouched, no token adopted',
    async (_label, answer) => {
      useLaunchTimers();
      seedVault('refresh-0');
      installRoutes({
        '/v1/auth/refresh': answer,
        '/v1/auth/logout': () => response(null, 204),
      });
      await relaunch();
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
      expect(getApiSession()).toBeNull();
      expect(vaultRecord()?.refreshToken).toBe('refresh-0');
      expect(useAuthStore.getState().restoreState).toEqual({
        status: 'restored',
        connectivity: 'offline',
      });
    },
  );

  it.each([
    [
      'network failure',
      () => Promise.reject(new TypeError('Network request failed')),
    ],
    ['abort', () => Promise.reject(new DOMException('Aborted', 'AbortError'))],
  ])(
    'a %s during refresh keeps the session and the vault',
    async (_label, answer) => {
      useLaunchTimers();
      seedVault('refresh-0');
      installRoutes({ '/v1/auth/refresh': answer });
      await relaunch();
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
      expect(vaultRecord()?.refreshToken).toBe('refresh-0');
      expect(getActiveDataOwner()).not.toBe(SIGNED_OUT_DATA_OWNER);
    },
  );

  it('a refresh that hangs past the 15s request timeout is transient, not a sign-out', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    let n = 0;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': init => {
        n += 1;
        if (n === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          });
        }
        return response(
          refreshBody({ access: 'access-ok', refresh: 'refresh-ok' }),
        );
      },
    });
    await relaunch();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
    await jest.advanceTimersByTimeAsync(7_500);
    await settle();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
    expect(vaultRecord()?.refreshToken).toBe('refresh-0');
    await jest.advanceTimersByTimeAsync(5_500);
    await settle();
    expect(presentedRefreshTokens(fetchMock)).toEqual([
      'refresh-0',
      'refresh-0',
    ]);
    expect(getApiSession()?.bearerToken).toBe('access-ok');
  });

  it.each([401, 403])(
    'a %s from /v1/auth/refresh is the one implicit sign-out: vault cleared, owner signed out, no retry',
    async status => {
      useLaunchTimers();
      seedVault('refresh-0');
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () =>
          response(
            {
              error: {
                message: 'The session could not be refreshed. Sign in again.',
              },
            },
            status,
          ),
        '/v1/auth/logout': () => response(null, 204),
      });
      await relaunch();
      expect(useAuthStore.getState().session).toBeNull();
      expect(rawVault()).toBeNull();
      expect(getApiSession()).toBeNull();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(useAuthStore.getState().restoreState).toMatchObject({
        status: 'reauth_required',
        reason: 'revoked',
        provider: 'apple',
      });
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      refreshSessionNow();
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);
    },
  );
});

// ─── Attack 4: expiresAt skew and rollback ───────────────────────────────────

describe('attack: expiresAt skew / rollback', () => {
  it.each([
    ['two hours in the past', () => Math.floor(Date.now() / 1000) - 7_200],
    ['epoch zero', () => 0],
    ['exactly now', () => Math.floor(Date.now() / 1000)],
    ['inside the 60s lead', () => Math.floor(Date.now() / 1000) + 20],
  ])(
    'a server expiresAt %s keeps the user signed in and never re-arms faster than the 30s rotation floor',
    async (_label, expiresAt) => {
      useLaunchTimers();
      seedVault('refresh-0');
      let n = 0;
      const requestedAt: number[] = [];
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () => {
          n += 1;
          requestedAt.push(Date.now());
          return response(
            refreshBody(
              { access: `access-${n}`, refresh: `refresh-${n}` },
              expiresAt(),
            ),
          );
        },
      });
      await relaunch();
      expect(getApiSession()?.bearerToken).toBe('access-1');
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      await settle();
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1 + 300 / 30 + 1);
      for (let i = 1; i < requestedAt.length; i += 1) {
        expect(requestedAt[i]! - requestedAt[i - 1]!).toBeGreaterThanOrEqual(
          30_000,
        );
      }
      // Every rotation presented the previous answer's token: no reuse.
      const presented = presentedRefreshTokens(fetchMock);
      for (let i = 1; i < presented.length; i += 1) {
        expect(presented[i]).toBe(`refresh-${i}`);
      }
      expect(vaultRecord()?.refreshToken).toBe(`refresh-${n}`);
    },
  );

  it('a bearer already inside the 5-minute foreground lead is refreshed on foreground, and a fresh one is left alone', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    let n = 0;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => {
        n += 1;
        return response(
          refreshBody(
            { access: `access-${n}`, refresh: `refresh-${n}` },
            Math.floor(Date.now() / 1000) + (n === 1 ? 240 : 3600),
          ),
        );
      },
    });
    await relaunch();
    expect(getApiSession()?.bearerToken).toBe('access-1');
    for (const listener of appStateListeners) listener('active');
    await settle();
    expect(getApiSession()?.bearerToken).toBe('access-2');
    for (const listener of appStateListeners) listener('active');
    for (const listener of appStateListeners) listener('background');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── Attack 5: vault corruption ──────────────────────────────────────────────

describe('attack: corrupted persisted state', () => {
  const corruptRecords: Array<[string, string]> = [
    [
      'truncated JSON',
      '{"version":1,"provider":"apple","canonicalAppUserId":"7fc2c743-028f-4ec6-9',
    ],
    ['a JSON array', '[1,2,3]'],
    ['a JSON string', '"refresh-token-in-a-string"'],
    [
      'unknown provider',
      JSON.stringify({
        version: 1,
        provider: 'email',
        canonicalAppUserId: USER_A,
        refreshToken: 'r',
      }),
    ],
    [
      'guest provider',
      JSON.stringify({
        version: 1,
        provider: 'guest',
        canonicalAppUserId: USER_A,
        refreshToken: 'r',
      }),
    ],
    [
      'non-UUID canonical id (Apple opaque user)',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: '001234.abcdef.1234',
        refreshToken: 'r',
      }),
    ],
    [
      'canonical id with path characters',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: `${USER_A}/../other`,
        refreshToken: 'r',
      }),
    ],
    [
      'blank refresh token',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: USER_A,
        refreshToken: '   ',
      }),
    ],
    [
      'numeric refresh token',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: USER_A,
        refreshToken: 12345,
      }),
    ],
    [
      'negative generation',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: USER_A,
        refreshToken: 'r',
        generation: -1,
      }),
    ],
    [
      'fractional generation',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: USER_A,
        refreshToken: 'r',
        generation: 1.5,
      }),
    ],
    [
      'string generation',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: USER_A,
        refreshToken: 'r',
        generation: '3',
      }),
    ],
    [
      'version 2 (from a newer build)',
      JSON.stringify({
        version: 2,
        provider: 'apple',
        canonicalAppUserId: USER_A,
        refreshToken: 'r',
      }),
    ],
    [
      'version as a string',
      JSON.stringify({
        version: '1',
        provider: 'apple',
        canonicalAppUserId: USER_A,
        refreshToken: 'r',
      }),
    ],
    [
      'prototype pollution shape',
      '{"__proto__":{"provider":"apple"},"version":1,"canonicalAppUserId":"7fc2c743-028f-4ec6-942c-a84508f3be38","refreshToken":"r"}',
    ],
  ];

  it.each(corruptRecords)(
    'a Keychain record that is %s is never trusted: no session, no network, no crash',
    async (_label, password) => {
      useLaunchTimers();
      seedRawVault(password);
      const fetchMock = installRoutes({
        '/v1/auth/refresh': () =>
          response(refreshBody({ access: 'never', refresh: 'never' })),
      });
      await relaunch();
      const state = useAuthStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.session).toBeNull();
      expect(getApiSession()).toBeNull();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(['unavailable', 'signed_out']).toContain(
        state.restoreState.status,
      );
    },
  );

  it('a Keychain read failure leaves the record in place (not deleted, not replaced) and signs nobody out', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    const before = rawVault();
    jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValue(new Error('errSecInteractionNotAllowed'));
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'never', refresh: 'never' })),
    });
    await relaunch();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'unavailable',
      reason: 'vault_unavailable',
    });
    expect(rawVault()).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
    for (const value of mockKv.values()) {
      expect(value).not.toContain('signed_out');
      expect(value).not.toContain('revoked');
    }
  });

  it('a valid record whose canonical id is upper-case is normalised, restored, and re-persisted lower-case', async () => {
    useLaunchTimers();
    seedRawVault(
      JSON.stringify({
        version: 1,
        provider: 'google',
        canonicalAppUserId: USER_A.toUpperCase(),
        refreshToken: 'refresh-0',
        email: null,
        displayName: null,
      }),
    );
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await relaunch();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
    expect(bearerTokenFor(USER_A)).toBe('access-1');
    expect(vaultRecord()?.canonicalAppUserId).toBe(USER_A);
  });

  it('a corrupt restore marker in SQLite cannot suppress a valid Keychain credential', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    mockKv.set('auth.session', '{"version":1,"status":"signed_out","reason":');
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await relaunch();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
    expect(getApiSession()?.bearerToken).toBe('access-1');
  });
});

// ─── Attack 6: launch deadline then a late refusal ───────────────────────────

describe('attack: slow launch refresh followed by a late verdict', () => {
  it('a 401 landing after the 8s deadline signs the already-shown session out cleanly', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    let release!: (value: Response) => void;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        new Promise<Response>(resolve => {
          release = resolve;
        }),
      '/v1/auth/logout': () => response(null, 204),
    });
    await relaunch();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(USER_A);
    expect(useAuthStore.getState().restoreState).toEqual({
      status: 'restored',
      connectivity: 'offline',
    });
    release(response({ error: { message: 'Sign in again.' } }, 401));
    await settle();
    expect(useAuthStore.getState().session).toBeNull();
    expect(rawVault()).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(useAuthStore.getState().restoreState).toMatchObject({
      status: 'reauth_required',
      reason: 'revoked',
    });
    refreshSessionNow();
    for (const listener of appStateListeners) listener('active');
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The next relaunch stays signed out instead of retrying the dead token.
    await relaunch();
    expect(useAuthStore.getState().session).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a success landing after the deadline installs the bearer exactly once and does not double-configure clients', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    let release!: (value: Response) => void;
    installRoutes({
      '/v1/auth/refresh': () =>
        new Promise<Response>(resolve => {
          release = resolve;
        }),
    });
    await relaunch();
    const session = useAuthStore.getState().session;
    release(
      response(refreshBody({ access: 'access-1', refresh: 'refresh-1' })),
    );
    await settle();
    expect(useAuthStore.getState().session).toBe(session);
    expect(getApiSession()?.bearerToken).toBe('access-1');
    expect(vaultRecord()?.refreshToken).toBe('refresh-1');
    // Hydrating again (a screen re-mount) is a no-op: same session, same
    // bearer, no second refresh.
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBe(session);
    expect(getApiSession()?.bearerToken).toBe('access-1');
  });
});

// ─── Attack 7: repeated / double sign-out and failing local storage ──────────

describe('attack: repeated actions and failing storage on sign-out', () => {
  it('a single sign-out revokes the current bearer server-side exactly once and a relaunch stays signed out', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    await relaunch();
    expect(getApiSession()?.bearerToken).toBe('access-1');
    await useAuthStore.getState().signOut();
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(1);
    const logout = callsTo(fetchMock, '/v1/auth/logout')[0]!;
    expect(new Headers(logout.headers).get('Authorization')).toBe(
      'Bearer access-1',
    );
    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      busy: false,
      hydrated: true,
    });
    expect(rawVault()).toBeNull();
    await relaunch();
    expect(useAuthStore.getState().session).toBeNull();
    expect(presentedRefreshTokens(fetchMock)).toEqual(['refresh-0']);
  });

  it('REPRO (defect): a double-tapped sign-out (two overlapping signOut calls) never calls /v1/auth/logout — the second call bumps authRevision and clears the bearer, so the first returns before revoking and the server session survives', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    await relaunch();
    expect(getApiSession()?.bearerToken).toBe('access-1');
    await Promise.all([
      useAuthStore.getState().signOut(),
      useAuthStore.getState().signOut(),
    ]);
    // Contract (AGENTS.md "Auth sessions"): explicit sign-out revokes THIS
    // device's session server-side. Observed: zero logout requests.
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);
    // Local state is otherwise clean, so the user cannot tell.
    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      busy: false,
      hydrated: true,
    });
    expect(rawVault()).toBeNull();
    await relaunch();
    expect(useAuthStore.getState().session).toBeNull();
    expect(presentedRefreshTokens(fetchMock)).toEqual(['refresh-0']);
  });

  it('when the Keychain refuses to delete on sign-out, the SQLite marker still blocks the next launch from restoring the account', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    await relaunch();
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('errSecInteractionNotAllowed'));
    await useAuthStore.getState().signOut();
    expect(rawVault()).not.toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
    await relaunch();
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(presentedRefreshTokens(fetchMock)).toEqual(['refresh-0']);
  });

  it('a logout the server answers 5xx does not resurrect anything locally and the app is not left busy', async () => {
    useLaunchTimers();
    seedVault('refresh-0');
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response({ error: { message: 'down' } }, 503),
    });
    await relaunch();
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      busy: false,
    });
    expect(rawVault()).toBeNull();
    expect(getApiSession()).toBeNull();
  });
});

// ─── Attack 8: token persistence anywhere ────────────────────────────────────

describe('attack: token persistence (Keychain, SQLite kv, console, store state)', () => {
  it('through sign-in, rotation, route-401 rotation and sign-out, only the current refresh token ever reaches the Keychain and nothing reaches kv, console, or serialisable store state', async () => {
    useLaunchTimers();
    const consoleSpies = (
      ['log', 'info', 'warn', 'error', 'debug'] as const
    ).map(level => jest.spyOn(console, level).mockImplementation(() => {}));
    let n = 0;
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-0', refresh: 'refresh-0' })),
      '/v1/auth/refresh': () => {
        n += 1;
        return response(
          refreshBody({ access: `access-${n}`, refresh: `refresh-${n}` }),
        );
      },
      '/v1/auth/logout': () => response(null, 204),
    });
    const secrets = () => [
      'apple-identity-token',
      'one-use-apple-code',
      'access-0',
      'access-1',
      'access-2',
      'refresh-0',
      'refresh-1',
      'refresh-2',
    ];
    const everywhereExceptVault = () =>
      [
        ...mockKv.keys(),
        ...mockKv.values(),
        ...consoleSpies.flatMap(spy =>
          spy.mock.calls.map(call => call.map(String).join(' ')),
        ),
        JSON.stringify(useAuthStore.getState()),
        JSON.stringify(useAppStore.getState()),
      ].join('\n');

    await useAuthStore.getState().signInWithApple();
    expect(getApiSession()?.bearerToken).toBe('access-0');
    let vault = rawVault() ?? '';
    expect(vault).toContain('refresh-0');
    for (const secret of secrets().filter(s => s !== 'refresh-0')) {
      expect(vault).not.toContain(secret);
    }
    for (const secret of secrets()) {
      expect(everywhereExceptVault()).not.toContain(secret);
    }

    refreshSessionNow();
    await settle();
    expect(getApiSession()?.bearerToken).toBe('access-1');
    vault = rawVault() ?? '';
    expect(vault).toContain('refresh-1');
    expect(vault).not.toContain('refresh-0');
    expect(vault).not.toContain('access-1');

    reportApiUnauthorized('access-1');
    await settle();
    expect(getApiSession()?.bearerToken).toBe('access-2');
    vault = rawVault() ?? '';
    expect(vault).toContain('refresh-2');
    expect(vault).not.toContain('refresh-1');
    for (const secret of secrets()) {
      expect(everywhereExceptVault()).not.toContain(secret);
    }

    await useAuthStore.getState().signOut();
    expect(rawVault()).toBeNull();
    for (const secret of secrets()) {
      expect(everywhereExceptVault()).not.toContain(secret);
    }
  });

  it('the Keychain item is written with AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY and never with a default accessibility', async () => {
    const setSpy = jest.spyOn(Keychain, 'setGenericPassword');
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-0', refresh: 'refresh-0' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(setSpy).toHaveBeenCalled();
    for (const call of setSpy.mock.calls) {
      const options = call[2] as { accessible?: string; service?: string };
      expect(options.service).toBe(SESSION_VAULT_SERVICE);
      expect(options.accessible).toBe(
        Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      );
    }
  });
});
