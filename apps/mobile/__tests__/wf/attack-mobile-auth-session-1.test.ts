/**
 * Adversarial pass 3 — subsystem `mobile-auth-session` (authStore, sessionVault,
 * sessionKeeper, sign-out, bearer resolution) against 4d812e1a.
 *
 * Every case is an ATTACK on the durable-session contract pinned by
 * authDurableSession.test.ts: interleavings (concurrent hydrate, sign-out
 * mid-refresh, foreground during an in-flight refresh), corrupt vault state,
 * clock skew, permission denial, and rapid repeats.
 *
 * Cases whose name starts with `REPRO:` pin the behaviour the code has TODAY
 * (the assertion is what happens, not what should) — each one is reported as
 * a finding with the expected behaviour in its comment. Everything else is a
 * `HELD` invariant.
 *
 * Mock style follows authDurableSession.test.ts: in-memory kv LocalDb, the
 * react-native-keychain auto-mock, module mocks for the provider SDKs, a
 * URL-routed jest.fn fetch. `purgeOwnerData` is the one repository seam that
 * is mocked (the SQLite purge cannot run here); getKv/setKv stay real.
 */
import { AppState, NativeModules } from 'react-native';
import type { AppStateStatus } from 'react-native';
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
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  AccountDeletionError,
  confirmAccountDeletion,
} from '../../src/account/deletion';
import {
  GUEST_DATA_OWNER,
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

const mockPurgeOwnerData = jest.fn<Promise<void>, [LocalDb, string]>();
jest.mock('../../src/data/repository', () => ({
  ...jest.requireActual<typeof import('../../src/data/repository')>(
    '../../src/data/repository',
  ),
  purgeOwnerData: (db: LocalDb, owner: string) => mockPurgeOwnerData(db, owner),
}));

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
const otherCanonicalId = '22222222-2222-4222-8222-222222222222';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;
/** Launch waits this long for the restore refresh (authStore.ts). */
const LAUNCH_REFRESH_WAIT_MS = 8_000;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    headers: { get: () => 'application/json' },
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

type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

/** Routes fetch by URL suffix; unknown routes reject like a dead network. */
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
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith(suffix),
  ) as Array<[string, RequestInit | undefined]>;
}

function refreshTokensSent(fetchMock: jest.Mock): string[] {
  return callsTo(fetchMock, '/v1/auth/refresh').map(
    ([, init]) =>
      (JSON.parse(String(init?.body)) as { refreshToken: string }).refreshToken,
  );
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function seedVault(
  refreshToken: string,
  provider: 'apple' | 'google' = 'apple',
  id: string = canonicalId,
) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider,
      canonicalAppUserId: id,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

/** A fetch response the test releases by hand (a request "in flight"). */
function deferredResponse(): {
  handler: RouteHandler;
  resolve: (r: Response) => void;
  pending: () => number;
} {
  const resolvers: Array<(r: Response) => void> = [];
  return {
    handler: () => new Promise<Response>(resolve => resolvers.push(resolve)),
    resolve: r => {
      const next = resolvers.shift();
      if (!next) throw new Error('no refresh request is pending');
      next(r);
    },
    pending: () => resolvers.length,
  };
}

let fakeClock = false;
/** Modern fake timers also fake setImmediate, so `flush` must know which
 * clock is installed. */
function useFakeClock(): void {
  jest.useFakeTimers();
  fakeClock = true;
}

/** Lets promise chains (fetch → keeper → store) run to rest under fake or
 * real timers without advancing the clock. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (fakeClock) {
      await jest.advanceTimersByTimeAsync(0);
    } else {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
}

/** Captures the keeper's AppState subscriptions so the test can emit
 * foreground transitions and count live listeners. */
function captureAppState(): {
  emit: (status: AppStateStatus) => void;
  live: () => number;
} {
  const handlers = new Set<(status: AppStateStatus) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (status: AppStateStatus) => void,
  ) => {
    handlers.add(handler);
    return {
      remove: () => {
        handlers.delete(handler);
      },
    };
  }) as unknown as typeof AppState.addEventListener);
  return {
    emit: status => {
      for (const handler of [...handlers]) handler(status);
    },
    live: () => handlers.size,
  };
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

async function signInApple(
  extraRoutes: Record<string, RouteHandler> = {},
  tokens = { access: 'access-1', refresh: 'refresh-1' },
): Promise<jest.Mock> {
  const fetchMock = installRoutes({
    '/v1/account/bootstrap': () => response(bootstrapBody(tokens)),
    ...extraRoutes,
  });
  await useAuthStore.getState().signInWithApple();
  expect(useAuthStore.getState().error).toBeNull();
  expect(getApiSession()?.bearerToken).toBe(tokens.access);
  return fetchMock;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
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
    deletionCleanup: null,
  });
  mockPurgeOwnerData.mockReset();
  mockPurgeOwnerData.mockResolvedValue(undefined);
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
  jest.useRealTimers();
  fakeClock = false;
});

// ─── S1: continueAsGuest from a synced Apple session ─────────────────────────

describe('S1 — continueAsGuest() from a synced Apple session', () => {
  it('REPRO: the Apple refresh token stays in the Keychain while the user is a guest, and the bearer is dropped so it can never be revoked', async () => {
    const fetchMock = await signInApple({
      '/v1/auth/logout': () => response(null, 204),
    });
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    await useAuthStore.getState().continueAsGuest();

    expect(useAuthStore.getState().session).toMatchObject({
      provider: 'guest',
      localOnly: true,
    });
    expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(canonicalId)).toBeNull();
    // OBSERVED: the synced account's refresh token is still durable on the
    // device although the user left the account. EXPECTED: either the vault
    // is cleared (the record is unreachable — hydrate() takes the guest path
    // first) or the session is revoked. Neither happens; no /v1/auth/logout
    // was sent either.
    expect(vaultRecord()).toMatchObject({
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      refreshToken: 'refresh-1',
    });
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);

    // A relaunch as guest never touches the record and never refreshes.
    fetchMock.mockClear();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.provider).toBe('guest');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    expect(useAuthStore.getState().hydrated).toBe(true);
  });

  it('signOut() from guest clears the orphaned vault record — but REPRO: without a bearer the server session is never revoked', async () => {
    const fetchMock = await signInApple({
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().continueAsGuest();
    expect(vaultRecord()).not.toBeNull();

    await useAuthStore.getState().signOut();

    // HELD: local state is fully cleared.
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(mockKv.get('auth.local-mode') ?? '').not.toBe('guest');
    // OBSERVED: 0 revocations across guest switch + sign-out; the refresh
    // token 'refresh-1' remains valid server-side (Supabase refresh tokens
    // only die when rotated or revoked). EXPECTED: one POST /v1/auth/logout
    // with 'Bearer access-1' at continueAsGuest() or at signOut().
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);

    // A relaunch after that sign-out starts signed out with no network.
    fetchMock.mockClear();
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rapid repeats: continueAsGuest ×3 then signOut ×3 concurrently leave one consistent signed-out state', async () => {
    const fetchMock = await signInApple({
      '/v1/auth/logout': () => response(null, 204),
    });
    await Promise.all([
      useAuthStore.getState().continueAsGuest(),
      useAuthStore.getState().continueAsGuest(),
      useAuthStore.getState().continueAsGuest(),
    ]);
    expect(useAuthStore.getState().session?.provider).toBe('guest');
    await Promise.all([
      useAuthStore.getState().signOut(),
      useAuthStore.getState().signOut(),
      useAuthStore.getState().signOut(),
    ]);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().busy).toBe(false);
    expect(vaultRecord()).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);
  });
});

// ─── S2: hydrate() twice concurrently ────────────────────────────────────────

describe('S2 — hydrate() called twice concurrently with the same vault record', () => {
  it('REPRO: two concurrent hydrate() calls send TWO /v1/auth/refresh requests with the same refresh token (one keeper generation survives)', async () => {
    useFakeClock();
    const appState = captureAppState();
    seedVault('refresh-1', 'apple');
    const refresh = deferredResponse();
    const fetchMock = installRoutes({ '/v1/auth/refresh': refresh.handler });

    const first = useAuthStore.getState().hydrate();
    const second = useAuthStore.getState().hydrate();
    await flush();

    // OBSERVED: 2 requests, both spending 'refresh-1'. EXPECTED: one refresh
    // per launch — the second hydrate() should join the first.
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1', 'refresh-1']);
    expect(refresh.pending()).toBe(2);
    // HELD: only one keeper generation is live (one AppState subscription).
    expect(appState.live()).toBe(1);

    // The first (dead-generation) request lands with rotated tokens: it must
    // be ignored; the second (live) request wins.
    refresh.resolve(
      response(refreshBody({ access: 'access-A', refresh: 'refresh-A' })),
    );
    await flush();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    refresh.resolve(
      response(refreshBody({ access: 'access-B', refresh: 'refresh-B' })),
    );
    await flush();
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-B',
      refreshToken: 'refresh-B',
    });
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-B' });
    expect(bearerTokenFor(canonicalId)).toBe('access-B');

    // The orphaned first hydrate() only settles at the 8 s launch deadline.
    await jest.advanceTimersByTimeAsync(LAUNCH_REFRESH_WAIT_MS);
    await Promise.all([first, second]);
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );

    // Exactly one generation reacts to an explicit refresh request.
    fetchMock.mockClear();
    refreshSessionNow();
    await flush();
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-B']);
    refresh.resolve(
      response(refreshBody({ access: 'access-C', refresh: 'refresh-C' })),
    );
    await flush();
    expect(getApiSession()?.bearerToken).toBe('access-C');
    // Two listeners now: the one keeper generation + syncRuntime's foreground
    // drain (installed with the API session). Tearing both down leaves none.
    expect(appState.live()).toBe(2);
    stopSessionKeeper();
    expect(appState.live()).toBe(1);
    clearSyncRuntime();
    expect(appState.live()).toBe(0);
  });

  it('REPRO: against a server that accepts each refresh token once, the duplicate launch refresh signs the user out', async () => {
    useFakeClock();
    seedVault('refresh-1', 'apple');
    const spent = new Set<string>();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': init => {
        const { refreshToken } = JSON.parse(String(init?.body)) as {
          refreshToken: string;
        };
        if (spent.has(refreshToken)) {
          return response({ error: { message: 'Sign in again.' } }, 401);
        }
        spent.add(refreshToken);
        return response(
          refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
        );
      },
    });

    const launches = [
      useAuthStore.getState().hydrate(),
      useAuthStore.getState().hydrate(),
    ];
    await flush();
    await jest.advanceTimersByTimeAsync(LAUNCH_REFRESH_WAIT_MS);
    await Promise.all(launches);

    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1', 'refresh-1']);
    // OBSERVED: the second use of 'refresh-1' is refused → dropRevokedSession
    // → the durable sign-in is gone at launch. EXPECTED: one refresh, user
    // stays signed in. (Supabase Auth tolerates reuse inside its reuse
    // interval, which bounds the production impact — INFERRED.)
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getApiSession()).toBeNull();
  });

  it('sequential hydrate() calls each send exactly one refresh and rotate cleanly', async () => {
    seedVault('refresh-1', 'apple');
    let n = 1;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => {
        n += 1;
        return response(
          refreshBody({ access: `access-${n}`, refresh: `refresh-${n}` }),
        );
      },
    });
    await useAuthStore.getState().hydrate();
    await useAuthStore.getState().hydrate();
    await useAuthStore.getState().hydrate();
    expect(refreshTokensSent(fetchMock)).toEqual([
      'refresh-1',
      'refresh-2',
      'refresh-3',
    ]);
    expect(getApiSession()?.bearerToken).toBe('access-4');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-4' });
  });
});

// ─── S3: signOut() while /v1/auth/refresh is pending ─────────────────────────

describe('S3 — signOut() while the launch refresh is in flight', () => {
  it('rotated tokens landing after sign-out are dropped: api session null, vault cleared, no Keychain write', async () => {
    useFakeClock();
    seedVault('refresh-1', 'apple');
    const refresh = deferredResponse();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': refresh.handler,
      '/v1/auth/logout': () => response(null, 204),
    });
    const setSpy = jest.spyOn(Keychain, 'setGenericPassword');

    const launch = useAuthStore.getState().hydrate();
    await flush();
    expect(refresh.pending()).toBe(1);
    // Launch deadline passes: the app shows signed in with local data while
    // the refresh keeps going.
    await jest.advanceTimersByTimeAsync(LAUNCH_REFRESH_WAIT_MS);
    await launch;
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()).toBeNull();

    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    setSpy.mockClear();

    refresh.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await flush();

    // HELD: nothing is resurrected.
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(setSpy).not.toHaveBeenCalled();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    // No live keeper reacts to an explicit refresh either.
    fetchMock.mockClear();
    refreshSessionNow();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    // Note (INFERRED): with no bearer yet, signOut() cannot call
    // /v1/auth/logout — the server keeps the rotated token alive.
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);
  });

  it('signOut() INSIDE the 8 s launch wait: the pending hydrate still settles, hydrated flips true, session stays null', async () => {
    useFakeClock();
    seedVault('refresh-1', 'apple');
    const refresh = deferredResponse();
    installRoutes({ '/v1/auth/refresh': refresh.handler });

    const launch = useAuthStore.getState().hydrate();
    await flush();
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().hydrated).toBe(false);

    refresh.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await flush();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();

    await jest.advanceTimersByTimeAsync(LAUNCH_REFRESH_WAIT_MS);
    await launch;
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });

  it('a 401 landing after sign-out does not run the revoked-session path twice or surface an error', async () => {
    useFakeClock();
    seedVault('refresh-1', 'apple');
    const refresh = deferredResponse();
    installRoutes({ '/v1/auth/refresh': refresh.handler });
    const launch = useAuthStore.getState().hydrate();
    await flush();
    await jest.advanceTimersByTimeAsync(LAUNCH_REFRESH_WAIT_MS);
    await launch;
    await useAuthStore.getState().signOut();
    const resetSpy = jest.spyOn(Keychain, 'resetGenericPassword');

    refresh.resolve(response({ error: { message: 'Sign in again.' } }, 401));
    await flush();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
    expect(resetSpy).not.toHaveBeenCalled();
  });
});

// ─── S4: account deletion whose local purge keeps failing ────────────────────

describe('S4 — completeAccountDeletion() when purgeOwnerData throws every time', () => {
  it('reports localPurge=failed after exactly 3 attempts while session, bearer and vault are already gone', async () => {
    await signInApple({ '/v1/auth/logout': () => response(null, 204) });
    const owner = canonicalDataOwner(canonicalId);
    mockPurgeOwnerData.mockRejectedValue(new Error('SQLITE_BUSY'));

    await useAuthStore.getState().completeAccountDeletion();

    expect(mockPurgeOwnerData).toHaveBeenCalledTimes(3);
    for (const [, purgedOwner] of mockPurgeOwnerData.mock.calls) {
      expect(purgedOwner).toBe(owner);
    }
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().error).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(mockKv.get('auth.local-mode') ?? '').not.toBe('guest');
    expect(mockKv.get('auth.last-provider') ?? '').toBe('');
  });

  it('a purge that fails twice and succeeds on the third try reports complete', async () => {
    await signInApple();
    mockPurgeOwnerData
      .mockRejectedValueOnce(new Error('busy'))
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(undefined);
    await useAuthStore.getState().completeAccountDeletion();
    expect(mockPurgeOwnerData).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
    expect(vaultRecord()).toBeNull();
  });

  it('a synchronously throwing purge is retried the same way (no unhandled rejection)', async () => {
    await signInApple();
    mockPurgeOwnerData.mockImplementation(() => {
      throw new Error('native module missing');
    });
    await expect(
      useAuthStore.getState().completeAccountDeletion(),
    ).resolves.toBeUndefined();
    expect(mockPurgeOwnerData).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
  });

  it('the vault is cleared BEFORE the first purge attempt, so a purge hang cannot leave the deleted account restorable', async () => {
    await signInApple();
    let vaultAtFirstPurge: Record<string, unknown> | null | undefined;
    let apiSessionAtFirstPurge: unknown;
    mockPurgeOwnerData.mockImplementation(async () => {
      vaultAtFirstPurge ??= vaultRecord();
      apiSessionAtFirstPurge ??= getApiSession();
      throw new Error('busy');
    });
    await useAuthStore.getState().completeAccountDeletion();
    expect(vaultAtFirstPurge).toBeNull();
    expect(apiSessionAtFirstPurge).toBeNull();
  });

  it('rapid repeat: a second completeAccountDeletion() racing the first does not purge twice and the failure is still reported', async () => {
    await signInApple();
    mockPurgeOwnerData.mockRejectedValue(new Error('busy'));
    await Promise.all([
      useAuthStore.getState().completeAccountDeletion(),
      useAuthStore.getState().completeAccountDeletion(),
    ]);
    expect(mockPurgeOwnerData).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});

// ─── S6 (mobile half): a rejected delete-confirm runs no local purge ─────────

describe('S6 — delete-confirm rejected for a challenge issued to another canonical id', () => {
  const EDGE_403 = {
    error: {
      code: 'account.deletion_challenge_invalid',
      message:
        'This deletion was not requested, or the confirmation does not match. Start again from Settings.',
    },
  };

  it('the 403 is a non-retryable AccountDeletionError and NOTHING local changes: session, bearer, vault, purge', async () => {
    const fetchMock = await signInApple({
      '/v1/me/delete-confirm': () => response(EDGE_403, 403),
    });
    const before = {
      session: useAuthStore.getState().session,
      api: getApiSession(),
      vault: vaultRecord(),
      owner: getActiveDataOwner(),
    };

    const attempt = confirmAccountDeletion(
      getApiSession(),
      '33333333-3333-4333-8333-333333333333',
    );
    await expect(attempt).rejects.toBeInstanceOf(AccountDeletionError);
    await expect(attempt).rejects.toMatchObject({
      code: 'deletion.rejected',
      retryable: false,
      message: EDGE_403.error.message,
    });

    expect(callsTo(fetchMock, '/v1/me/delete-confirm')).toHaveLength(1);
    expect(mockPurgeOwnerData).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).toEqual(before.session);
    expect(getApiSession()).toEqual(before.api);
    expect(vaultRecord()).toEqual(before.vault);
    expect(getActiveDataOwner()).toBe(before.owner);
    expect(useAuthStore.getState().deletionCleanup).toBeNull();
  });

  it('429 too-fast is retryable, 401 is a non-retryable session-expired, 5xx is retryable — none purge', async () => {
    await signInApple({
      '/v1/me/delete-confirm': init => {
        const { challenge } = JSON.parse(String(init?.body)) as {
          challenge: string;
        };
        if (challenge.startsWith('4')) {
          return response(
            { error: { code: 'account.deletion_too_fast', message: 'wait' } },
            429,
          );
        }
        if (challenge.startsWith('5')) return response(null, 503);
        return response({ error: { message: 'unauthorized' } }, 401);
      },
    });
    const codes: Array<[string, boolean]> = [];
    for (const challenge of [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '11111111-1111-4111-8111-111111111111',
    ]) {
      const error: unknown = await confirmAccountDeletion(
        getApiSession(),
        challenge,
      ).catch((e: unknown) => e);
      if (!(error instanceof AccountDeletionError)) {
        throw new Error(`expected AccountDeletionError, got ${String(error)}`);
      }
      codes.push([error.code, error.retryable]);
    }
    expect(codes).toEqual([
      ['deletion.rejected', true],
      ['deletion.rejected', true],
      ['deletion.session_expired', false],
    ]);
    expect(mockPurgeOwnerData).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(vaultRecord()).not.toBeNull();
  });

  it('a 200 without deleted:true is rejected non-retryably and purges nothing', async () => {
    await signInApple({
      '/v1/me/delete-confirm': () => response({ deleted: false }),
    });
    const attempt = confirmAccountDeletion(
      getApiSession(),
      '33333333-3333-4333-8333-333333333333',
    );
    await expect(attempt).rejects.toBeInstanceOf(AccountDeletionError);
    await expect(attempt).rejects.toMatchObject({
      code: 'deletion.rejected',
      retryable: false,
    });
    expect(mockPurgeOwnerData).not.toHaveBeenCalled();
    expect(vaultRecord()).not.toBeNull();
  });
});

// ─── S7: AppState 'active' while a refresh is in flight ──────────────────────

describe('S7 — foreground while a refresh is pending (single-flight)', () => {
  it('launch refresh pending + 5 rapid active transitions → still one /v1/auth/refresh', async () => {
    useFakeClock();
    const appState = captureAppState();
    seedVault('refresh-1', 'apple');
    const refresh = deferredResponse();
    const fetchMock = installRoutes({ '/v1/auth/refresh': refresh.handler });

    const launch = useAuthStore.getState().hydrate();
    await flush();
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1']);

    for (let i = 0; i < 5; i += 1) {
      appState.emit('background');
      appState.emit('active');
    }
    await flush();
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1']);
    expect(refresh.pending()).toBe(1);

    refresh.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await launch;
    expect(getApiSession()?.bearerToken).toBe('access-2');

    // With an hour of bearer life left, foregrounding refreshes nothing.
    appState.emit('active');
    await flush();
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1']);
  });

  it('a bearer inside the 5-minute foreground lead refreshes once on active; a second active during that flight is coalesced', async () => {
    useFakeClock();
    const appState = captureAppState();
    seedVault('refresh-1', 'apple');
    const refresh = deferredResponse();
    const fetchMock = installRoutes({ '/v1/auth/refresh': refresh.handler });
    const launch = useAuthStore.getState().hydrate();
    await flush();
    // Bearer valid for 4 minutes: under FOREGROUND_LEAD_MS, above REFRESH_LEAD.
    refresh.resolve(
      response(
        refreshBody(
          { access: 'access-2', refresh: 'refresh-2' },
          Math.floor(Date.now() / 1000) + 240,
        ),
      ),
    );
    await launch;
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1']);

    appState.emit('active');
    await flush();
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1', 'refresh-2']);
    appState.emit('active');
    appState.emit('active');
    await flush();
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1', 'refresh-2']);
    expect(refresh.pending()).toBe(1);

    // The scheduled ahead-of-expiry timer (240 s − 60 s) firing while the
    // foreground refresh is still in flight is coalesced too.
    await jest.advanceTimersByTimeAsync(190_000);
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1', 'refresh-2']);

    refresh.resolve(
      response(refreshBody({ access: 'access-3', refresh: 'refresh-3' })),
    );
    await flush();
    expect(getApiSession()?.bearerToken).toBe('access-3');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-3' });
    // keeper + syncRuntime foreground drain; no leaked keeper generations.
    expect(appState.live()).toBe(2);
    stopSessionKeeper();
    expect(appState.live()).toBe(1);
  });

  it('refreshSessionNow() (a 401 from an API route) during an in-flight refresh is coalesced as well', async () => {
    useFakeClock();
    captureAppState();
    seedVault('refresh-1', 'apple');
    const refresh = deferredResponse();
    const fetchMock = installRoutes({ '/v1/auth/refresh': refresh.handler });
    const launch = useAuthStore.getState().hydrate();
    await flush();
    refreshSessionNow();
    refreshSessionNow();
    await flush();
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1']);
    refresh.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await launch;
    expect(getApiSession()?.bearerToken).toBe('access-2');
  });
});

// ─── Extra attacks ───────────────────────────────────────────────────────────

describe('extra — clock skew and server-issued expiry', () => {
  it('REPRO: a bearer whose expiresAt is already in the past (device clock ahead) makes the keeper refresh every second, rotating the Keychain record each time', async () => {
    useFakeClock();
    captureAppState();
    seedVault('refresh-1', 'apple');
    let n = 1;
    const setSpy = jest.spyOn(Keychain, 'setGenericPassword');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => {
        n += 1;
        // The server's clock says the bearer lives an hour; the device clock
        // is two hours ahead, so it reads as expired an hour ago.
        return response(
          refreshBody(
            { access: `access-${n}`, refresh: `refresh-${n}` },
            Math.floor(Date.now() / 1000) - 3600,
          ),
        );
      },
    });

    await useAuthStore.getState().hydrate();
    expect(getApiSession()?.bearerToken).toBe('access-2');
    fetchMock.mockClear();
    setSpy.mockClear();

    await jest.advanceTimersByTimeAsync(60_000);

    // OBSERVED: ~60 rotations per minute per device, each a Keychain write,
    // for as long as the app is in the foreground. EXPECTED: a sane floor
    // (the server's own expires_in, or a minimum cadence of minutes) so
    // clock skew degrades to "refresh a bit early", not a 1 Hz loop that
    // trips the server's 30/min auth_refresh budget.
    const refreshes = refreshTokensSent(fetchMock).length;
    expect(refreshes).toBeGreaterThanOrEqual(55);
    expect(setSpy.mock.calls.length).toBeGreaterThanOrEqual(55);
    expect(getApiSession()?.bearerToken).toBe(`access-${n}`);
  });

  it('REPRO: the same loop once the server starts answering 429 (auth_refresh budget) backs off but resumes the 1 Hz cadence after the next success', async () => {
    useFakeClock();
    captureAppState();
    seedVault('refresh-1', 'apple');
    let served = 0;
    const statuses: number[] = [];
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => {
        served += 1;
        if (served > 30 && served <= 33) {
          statuses.push(429);
          return response({ error: { code: 'rate_limited' } }, 429);
        }
        statuses.push(200);
        return response(
          refreshBody(
            { access: `access-${served}`, refresh: `refresh-${served}` },
            Math.floor(Date.now() / 1000) - 1,
          ),
        );
      },
    });
    await useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(120_000);
    const total = refreshTokensSent(fetchMock).length;
    // 30 successes at 1 Hz, three 429s at 5/10/20 s backoff, then 1 Hz again
    // for the remaining ~55 s: well over 60 requests in two minutes.
    expect(statuses.filter(s => s === 429)).toHaveLength(3);
    expect(total).toBeGreaterThan(60);
    // The 429s never signed the user out (HELD).
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
  });

  it('a refresh the server holds longer than 15 s (GoTrue 5xx retry loop in the edge fn runs ~25 s) is aborted client-side as RETRYABLE: session kept, vault kept, next attempt after backoff', async () => {
    useFakeClock();
    captureAppState();
    seedVault('refresh-1', 'apple');
    const aborted: string[] = [];
    let attempts = 0;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': init => {
        attempts += 1;
        if (attempts > 1) {
          return response(
            refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted.push('refresh-1');
            reject(new Error('AbortError'));
          });
        });
      },
    });
    const launched = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await launched;
    // Launch proceeded signed-in on local data (8 s wait) while the refresh
    // was still pending.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(aborted).toEqual([]);
    await jest.advanceTimersByTimeAsync(7_001);
    expect(aborted).toEqual(['refresh-1']);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    // RETRY_BASE_MS = 5 s: the retry lands and rotates.
    await jest.advanceTimersByTimeAsync(5_100);
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1', 'refresh-1']);
    expect(getApiSession()?.bearerToken).toBe('access-2');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
  });

  it('a bearer with a healthy hour of life refreshes exactly once, 60 s ahead of expiry', async () => {
    useFakeClock();
    captureAppState();
    seedVault('refresh-1', 'apple');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(
          refreshBody(
            { access: 'access-2', refresh: 'refresh-2' },
            Math.floor(Date.now() / 1000) + 3600,
          ),
        ),
    });
    await useAuthStore.getState().hydrate();
    fetchMock.mockClear();
    await jest.advanceTimersByTimeAsync(3600_000 - 60_000 - 1_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-2']);
  });
});

describe('extra — corrupt vault state', () => {
  it.each([
    ['empty JSON object', '{}'],
    ['not JSON', 'not json at all'],
    ['unicode garbage', '\u0000\uFFFF\uD83D\uDE00{"version":1}'],
    [
      'wrong version',
      JSON.stringify({
        version: 2,
        provider: 'apple',
        canonicalAppUserId: canonicalId,
        refreshToken: 'r',
      }),
    ],
    [
      'guest provider',
      JSON.stringify({
        version: 1,
        provider: 'guest',
        canonicalAppUserId: canonicalId,
        refreshToken: 'r',
      }),
    ],
    [
      'empty token',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: canonicalId,
        refreshToken: '',
      }),
    ],
    [
      'array token',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: canonicalId,
        refreshToken: ['r'],
      }),
    ],
    [
      'empty canonical id',
      JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: '',
        refreshToken: 'r',
      }),
    ],
    ['JSON array', JSON.stringify([1, 2, 3])],
  ])(
    'a %s record is discarded, deleted, and hydrate() lands signed out with no request',
    async (_label, password) => {
      __keychainStore.set(SESSION_VAULT_SERVICE, {
        username: 'session',
        password,
      });
      const fetchMock = installRoutes({});
      await expect(loadPersistedSession()).resolves.toBeNull();
      expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
      __keychainStore.set(SESSION_VAULT_SERVICE, {
        username: 'session',
        password,
      });
      await useAuthStore.getState().hydrate();
      expect(useAuthStore.getState()).toMatchObject({
        hydrated: true,
        session: null,
        error: null,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    },
  );

  it('REPRO: a whitespace-only refresh token passes vault validation, is sent to the server, and the resulting 400 is retried forever (never a sign-out)', async () => {
    useFakeClock();
    captureAppState();
    seedVault('   ', 'apple');
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
    expect(refreshTokensSent(fetchMock)).toEqual(['   ']);
    // OBSERVED: signed in with no bearer, the record kept, backoff retries
    // of an unfixable request. EXPECTED: a 400 from /v1/auth/refresh is not
    // transient — it should end the session like 401/403 does.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toMatchObject({ refreshToken: '   ' });
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(refreshTokensSent(fetchMock).length).toBeGreaterThanOrEqual(5);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
  });

  it('a 64 kB unicode refresh token is passed through byte-for-byte and rotated away on success', async () => {
    const huge = '🥒'.repeat(16_384);
    seedVault(huge, 'google');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();
    expect(refreshTokensSent(fetchMock)).toEqual([huge]);
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
    expect(useAuthStore.getState().session?.provider).toBe('google');
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
  });

  it('a vault record for account B while the store still holds account A: hydrate() switches cleanly to B and A resolves no bearer', async () => {
    await signInApple();
    expect(bearerTokenFor(canonicalId)).toBe('access-1');
    seedVault('refresh-B', 'google', otherCanonicalId);
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-B', refresh: 'refresh-B2' })),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      otherCanonicalId,
    );
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(bearerTokenFor(otherCanonicalId)).toBe('access-B');
    expect(getActiveDataOwner()).toBe(canonicalDataOwner(otherCanonicalId));
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: otherCanonicalId,
      refreshToken: 'refresh-B2',
    });
  });
});

describe('extra — Keychain permission denial', () => {
  it('sign-in when the Keychain refuses writes: the session still works for this run and nothing else is persisted', async () => {
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValue(new Error('errSecInteractionNotAllowed'));
    await signInApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()?.bearerToken).toBe('access-1');
    expect(vaultRecord()).toBeNull();
    for (const value of mockKv.values()) {
      expect(value).not.toContain('refresh-1');
      expect(value).not.toContain('access-1');
    }
  });

  it('REPRO: sign-out when the Keychain refuses deletes AND the revoke call fails offline → the next launch restores the signed-out account', async () => {
    await signInApple(); // no /v1/auth/logout route: revoke fails like a dead network
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('errSecInteractionNotAllowed'));

    await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    // The stale record survived the explicit sign-out.
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    jest.restoreAllMocks();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();
    // OBSERVED: the user who explicitly signed out is signed back in from
    // the stale record (both failure modes are needed: Keychain delete
    // refused + revoke unreachable). EXPECTED: signed out.
    expect(refreshTokensSent(fetchMock)).toEqual(['refresh-1']);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
  });

  it('sign-out when the Keychain refuses deletes but the revoke succeeds: the stale record is dead on the next launch (401 → signed out)', async () => {
    const fetchMock = await signInApple({
      '/v1/auth/logout': () => response(null, 204),
    });
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('errSecInteractionNotAllowed'));
    await useAuthStore.getState().signOut();
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(1);
    expect(vaultRecord()).not.toBeNull();
    jest.restoreAllMocks();
    installRoutes({
      '/v1/auth/refresh': () =>
        response({ error: { message: 'Sign in again.' } }, 401),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});

describe('extra — rapid repeats and interleavings', () => {
  it('signOut() ×3 concurrently revokes exactly once and ends consistent', async () => {
    const fetchMock = await signInApple({
      '/v1/auth/logout': () => response(null, 204),
    });
    await Promise.all([
      useAuthStore.getState().signOut(),
      useAuthStore.getState().signOut(),
      useAuthStore.getState().signOut(),
    ]);
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(1);
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getApiSession()).toBeNull();
  });

  it('sign-in immediately after sign-out while the old revoke is still in flight: the new session is not torn down by the old revoke', async () => {
    const logout = deferredResponse();
    const fetchMock = await signInApple({ '/v1/auth/logout': logout.handler });
    const signingOut = useAuthStore.getState().signOut();
    await flush();
    expect(logout.pending()).toBe(1);

    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-9', refresh: 'refresh-9' })),
      '/v1/auth/logout': logout.handler,
    });
    await useAuthStore.getState().signInWithApple();
    expect(getApiSession()?.bearerToken).toBe('access-9');
    logout.resolve(response(null, 204));
    await signingOut;
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()?.bearerToken).toBe('access-9');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-9' });
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(1);
  });

  it('a late rotation for account A after switching to account B is ignored (bearer resolution stays exact)', async () => {
    useFakeClock();
    captureAppState();
    seedVault('refresh-A', 'apple', canonicalId);
    const refresh = deferredResponse();
    installRoutes({ '/v1/auth/refresh': refresh.handler });
    const launchA = useAuthStore.getState().hydrate();
    await flush();
    // Account B signs in while A's launch refresh is still pending.
    installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          user: { id: otherCanonicalId, email: 'b@example.com' },
          onboardingState: 'complete',
          session: {
            accessToken: 'access-B',
            refreshToken: 'refresh-B',
            expiresAt: FAR_FUTURE_SECONDS,
          },
        }),
    });
    await useAuthStore.getState().signInWithApple();
    expect(bearerTokenFor(otherCanonicalId)).toBe('access-B');

    refresh.resolve(
      response(refreshBody({ access: 'access-A2', refresh: 'refresh-A2' })),
    );
    await flush();
    await jest.advanceTimersByTimeAsync(LAUNCH_REFRESH_WAIT_MS);
    await launchA;
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(bearerTokenFor(otherCanonicalId)).toBe('access-B');
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: otherCanonicalId,
      refreshToken: 'refresh-B',
    });
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      otherCanonicalId,
    );
  });
});
