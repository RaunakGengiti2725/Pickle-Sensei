/**
 * Execution audit (mobile-auth-session, pass 2): authStore restore/rotation
 * edges that the 26 existing auth/account suites never execute.
 *
 * `jest --coverage` left authStore.ts:403 (no usable API URL at relaunch),
 * :407 (the 8 s launch deadline firing) and sessionVault.ts:98-99 (Keychain
 * write failure) unexecuted. This harness drives them through the REAL
 * store, vault and keeper with fake timers and a routed fetch, plus two
 * adversarial cases (sign-out racing an in-flight rotation; a corrupted vault
 * record) that the contract in AGENTS.md implies but nothing pins.
 *
 * Tests prefixed `[defect]` pin CURRENT behaviour that this audit reports as a
 * finding; the expected behaviour is described in each test's comment.
 */
import { NativeModules } from 'react-native';
import * as Keychain from 'react-native-keychain';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
import {
  SESSION_VAULT_SERVICE,
  loadPersistedSession,
} from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Module seams (same shape as __tests__/authDurableSession.test.ts) ──────

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

// Mutable so one case can relaunch against a build with a rejected API URL.
const mockRuntime = { apiBaseUrl: 'https://api.example.test' };
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: mockRuntime.apiBaseUrl,
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
const T0 = Date.UTC(2026, 8, 4, 12, 0, 0);
const HOUR_S = 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const sessionBlock = (tokens: { access: string; refresh: string }) => ({
  accessToken: tokens.access,
  refreshToken: tokens.refresh,
  expiresAt: Math.floor(Date.now() / 1000) + HOUR_S,
});

const bootstrapBody = (tokens: { access: string; refresh: string }) => ({
  user: { id: canonicalId, email: 'pat@example.com' },
  onboardingState: 'complete',
  session: sessionBlock(tokens),
});

const refreshBody = (tokens: { access: string; refresh: string }) => ({
  session: sessionBlock(tokens),
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

function refreshTokenSent(init?: RequestInit): string {
  return (JSON.parse(String(init?.body)) as { refreshToken: string })
    .refreshToken;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve: value => resolve(value) };
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function seedVault(refreshToken: string, id: string = canonicalId): void {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: id,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

/** Lets promise chains that are not timer-driven settle under fake timers. */
async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  jest.clearAllMocks();
  mockKv.clear();
  __keychainStore.clear();
  mockRuntime.apiBaseUrl = 'https://api.example.test';
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
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ─── Launch deadline ─────────────────────────────────────────────────────────

describe('relaunch: the 8 s launch deadline', () => {
  it('a slow refresh lets launch proceed signed in (from the record, no bearer) at 8 s; the late tokens are adopted and re-persisted when they land', async () => {
    seedVault('refresh-1');
    const gate = deferred<Response>();
    const fetchMock = installRoutes({ '/v1/auth/refresh': () => gate.promise });

    let hydrated = false;
    const hydrating = useAuthStore
      .getState()
      .hydrate()
      .then(() => {
        hydrated = true;
      });

    await jest.advanceTimersByTimeAsync(7_999);
    expect(hydrated).toBe(false);
    expect(useAuthStore.getState().hydrated).toBe(false);
    // Signed in from the record already; the gate just hasn't been released.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getActiveDataOwner()).toBe(canonicalId);

    await jest.advanceTimersByTimeAsync(1);
    await hydrating;
    expect(hydrated).toBe(true);
    expect(useAuthStore.getState()).toMatchObject({
      hydrated: true,
      error: null,
    });
    expect(useAuthStore.getState().session?.localOnly).toBe(false);
    expect(getApiSession()).toBeNull(); // no bearer yet — keeper still waiting
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    gate.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await flush();
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
      canonicalAppUserId: canonicalId,
    });
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a refusal landing AFTER the deadline still ends the session (the ONE implicit sign-out is not gated by the launch wait)', async () => {
    seedVault('refresh-1');
    const gate = deferred<Response>();
    installRoutes({ '/v1/auth/refresh': () => gate.promise });
    const hydrating = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrating;
    expect(useAuthStore.getState().session).not.toBeNull();

    gate.resolve(response({ error: 'gone' }, 401));
    await flush();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });
});

// ─── No usable API URL ───────────────────────────────────────────────────────

describe('relaunch: build without a usable API URL', () => {
  it('a rejected (plain-http, non-local) API URL keeps the user signed in with local data, sends nothing, keeps the record', async () => {
    seedVault('refresh-1');
    mockRuntime.apiBaseUrl = 'http://api.example.test';
    const fetchMock = installRoutes({});

    const hydrating = useAuthStore.getState().hydrate();
    await flush();
    await hydrating;

    expect(useAuthStore.getState()).toMatchObject({
      hydrated: true,
      error: null,
    });
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(getApiSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ─── Sign-out racing a rotation ──────────────────────────────────────────────

describe('explicit sign-out while a rotation is in flight', () => {
  it('drops the rotated tokens when they land, clears everything, revokes with the pre-rotation bearer, and the next launch stays signed out', async () => {
    const gate = deferred<Response>();
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () => gate.promise,
      '/v1/auth/logout': () => response(null, 204),
    });
    const signingIn = useAuthStore.getState().signInWithApple();
    await flush();
    await signingIn;
    expect(getApiSession()?.bearerToken).toBe('access-1');

    // An API route rejects the current bearer → the keeper rotates now.
    reportApiUnauthorized('access-1');
    await flush();
    const refreshCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
    expect(refreshTokenSent(refreshCalls[0][1] as RequestInit)).toBe(
      'refresh-1',
    );

    const signingOut = useAuthStore.getState().signOut();
    await flush();
    await signingOut;
    expect(useAuthStore.getState().session).toBeNull();

    gate.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await flush();

    expect(getApiSession()).toBeNull();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    const durable = JSON.stringify([
      ...__keychainStore.values(),
      ...mockKv.values(),
    ]);
    expect(durable).not.toContain('refresh-2');
    expect(durable).not.toContain('access-2');
    const logoutCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/auth/logout'),
    );
    expect(logoutCalls).toHaveLength(1);
    expect(
      (logoutCalls[0][1] as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ Authorization: 'Bearer access-1' });

    fetchMock.mockClear();
    const rehydrating = useAuthStore.getState().hydrate();
    await flush();
    await rehydrating;
    expect(useAuthStore.getState().session).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── Defects ─────────────────────────────────────────────────────────────────

describe('[defect] rotation re-persistence is fire-and-forget', () => {
  // authStore.ts:304 `void persistSession(session, next)` discards the
  // boolean from sessionVault.ts:83-101 (false on a Keychain write failure)
  // and nothing retries. The vault then holds the SPENT refresh token while
  // the live session uses the rotated one; if the app is killed before the
  // next scheduled rotation (~59 min) re-persists, the next launch presents
  // the spent token and the server refuses it (index.ts:560-566 maps every
  // non-5xx Supabase refresh error to 401) — the user is silently signed out
  // by a transient local storage failure, not by any server-side revocation.
  // Expected: a failed re-persist is retried (or the previous record is kept
  // in sync some other way) so a transient Keychain error cannot end a
  // durable session.
  it('a Keychain write failure at rotation leaves the spent token in the vault; relaunch → 401 → forced sign-out', async () => {
    // A rotating server: each refresh token is honoured once, then refused.
    const spent = new Set<string>();
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': init => {
        const token = refreshTokenSent(init);
        if (spent.has(token) || token !== 'refresh-1') {
          return response({ error: 'Sign in again.' }, 401);
        }
        spent.add(token);
        return response(
          refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
        );
      },
    });
    const signingIn = useAuthStore.getState().signInWithApple();
    await flush();
    await signingIn;
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    // The rotation lands but the Keychain write for it fails once.
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(new Error('errSecInteractionNotAllowed'));
    reportApiUnauthorized('access-1');
    await flush();
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    // Live session moved on; the durable record did not.
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    expect(useAuthStore.getState().session).not.toBeNull();

    // App killed before the next scheduled rotation; relaunch.
    stopSessionKeeper();
    clearApiSession();
    useAuthStore.setState({ hydrated: false, session: null });
    fetchMock.mockClear();
    const rehydrating = useAuthStore.getState().hydrate();
    await flush();
    await rehydrating;

    const refreshCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
    // The SPENT token is presented, not the rotated one the session held.
    expect(refreshTokenSent(refreshCalls[0][1] as RequestInit)).toBe(
      'refresh-1',
    );
    // Server correctly refuses the spent token → the ONE implicit sign-out.
    expect(useAuthStore.getState()).toMatchObject({
      hydrated: true,
      session: null,
      error: null,
    });
    expect(vaultRecord()).toBeNull();
  });
});

describe('[defect] vault record validation does not cover the canonical id shape', () => {
  // sessionVault.ts:56-65 accepts any non-empty string as canonicalAppUserId,
  // but restorePersistedSession (authStore.ts:393) requires a UUID via
  // canonicalDataOwner (accountScope.ts:15-19) and throws BEFORE the vault
  // is consulted again. hydrate()'s outer catch (authStore.ts:600-604) lands
  // signed out — and the record survives, so every launch repeats this with
  // no refresh attempt, no surfaced error, and no cleanup until an explicit
  // sign-in overwrites it. Expected: the malformed record is discarded like
  // every other malformed record (sessionVault.ts:114).
  it('a non-UUID canonicalAppUserId lands signed out on every launch, never contacts the server, and is never discarded', async () => {
    seedVault('refresh-1', '001234.abcdef.5678'); // an Apple subject, not a UUID
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });

    for (let launch = 1; launch <= 2; launch += 1) {
      useAuthStore.setState({ hydrated: false, session: null });
      const hydrating = useAuthStore.getState().hydrate();
      await flush();
      await hydrating;
      expect(useAuthStore.getState()).toMatchObject({
        hydrated: true,
        session: null,
        error: null,
      });
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(fetchMock).not.toHaveBeenCalled();
      // Still there, still accepted by the vault parser.
      await expect(loadPersistedSession()).resolves.toMatchObject({
        canonicalAppUserId: '001234.abcdef.5678',
        refreshToken: 'refresh-1',
      });
    }
  });
});
