/**
 * Adjudication (mobile-auth-session) — independent reproduction on 4d812e1a.
 *
 * Cases prefixed ADJ-FAIL assert the EXPECTED (fixed) behaviour and are
 * expected to fail on 4d812e1a; they are the executable acceptance criteria
 * for the confirmed findings. Cases prefixed ADJ-HOLDS pin behaviour that
 * already holds and must keep holding after the fix.
 *
 *  ADJ-1  sessionKeeper: a server-issued expiresAt already inside the 60s
 *         lead window (device clock ahead of the server) drives a 1 Hz
 *         rotation loop — every rotation re-arms the 1s floor.
 *  ADJ-2  authStore/sessionVault: a Keychain write failure at sign-in or at
 *         rotation is swallowed with no retry; the in-memory refresh token
 *         is the only copy, so the durable sign-in is silently lost (sign-in)
 *         or refused by the server on next launch (rotation).
 *  ADJ-3  onRevoked rejection: the keeper does not guard `input.onRevoked`,
 *         but every await inside the app's `dropRevokedSession` fails soft —
 *         with Keychain reset AND SQLite both throwing during a 401 there is
 *         no unhandled rejection. Pinned as HOLDS (keeper hardening is P3).
 *
 * Harness mirrors __tests__/authDurableSession.test.ts.
 */
import { AppState, NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Module seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
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

const API = 'https://api.example.test';
const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';

type AppStateHandler = (state: string) => void;
const appStateMock = AppState as unknown as { addEventListener: jest.Mock };
function foregroundHandlers(): AppStateHandler[] {
  return appStateMock.addEventListener.mock.calls
    .filter(([event]) => event === 'change')
    .map(([, handler]) => handler as AppStateHandler);
}
function foreground(): void {
  for (const handler of foregroundHandlers()) handler('active');
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const farFuture = () => Math.floor(Date.now() / 1000) + 3600;

const bootstrapBody = (tokens: { access: string; refresh: string }) => ({
  user: { id: canonicalId, email: 'pat@example.com' },
  onboardingState: 'complete',
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: farFuture(),
  },
});

const refreshBody = (tokens: { access: string; refresh: string }) => ({
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: farFuture(),
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

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;
const keychainModule = Keychain as unknown as {
  setGenericPassword: (...args: unknown[]) => Promise<unknown>;
  resetGenericPassword: (...args: unknown[]) => Promise<unknown>;
};
const realSetGenericPassword = keychainModule.setGenericPassword;
const realResetGenericPassword = keychainModule.resetGenericPassword;

/** setGenericPassword rejects for the first `failures` calls, then works. */
function failKeychainWrites(failures: number): jest.Mock {
  let remaining = failures;
  const spy = jest.fn(async (...args: unknown[]) => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error('errSecInteractionNotAllowed');
    }
    return realSetGenericPassword(...args);
  });
  keychainModule.setGenericPassword = spy;
  return spy;
}

async function signInApple(fetchMock?: jest.Mock): Promise<jest.Mock> {
  const mock =
    fetchMock ??
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
  await useAuthStore.getState().signInWithApple();
  await settle();
  return mock;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockDbFailure = null;
  __keychainStore.clear();
  keychainModule.setGenericPassword = realSetGenericPassword;
  keychainModule.resetGenericPassword = realResetGenericPassword;
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
  keychainModule.resetGenericPassword = realResetGenericPassword;
  jest.useRealTimers();
});

// ─── ADJ-1: clock skew → 1 Hz rotation loop ──────────────────────────────────

describe('ADJ-1 sessionKeeper: server expiresAt already inside the lead window', () => {
  it('ADJ-FAIL: with the device clock ≥ 1h ahead of the server, the keeper rotates at most ~once per minute (not once per second) and never drops the session', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-04T12:00:00Z'));
    let n = 0;
    // Server issues a 3600s bearer, but the device clock is 2h ahead: from
    // the device's point of view every bearer expired an hour ago.
    const fetchFn = jest.fn(async (_url: string, _init?: RequestInit) => {
      n += 1;
      return response({
        session: {
          accessToken: `access-${n}`,
          refreshToken: `refresh-${n}`,
          expiresAt: Math.floor(Date.now() / 1000) - 3600,
        },
      });
    });
    const onRevoked = jest.fn();
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Date.now() - 3600_000,
      onRotated,
      onRevoked,
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(10 * 60_000);

    // Observed on 4d812e1a: 600 refresh POSTs in 10 simulated minutes.
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(12);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(onRotated).toHaveBeenCalled();
    // Every rotation spent the previously issued refresh token (rotation
    // chain intact — the fix must not replay a spent token).
    const spent = fetchFn.mock.calls.map(
      ([, init]) =>
        (JSON.parse(String(init?.body)) as { refreshToken: string })
          .refreshToken,
    );
    expect(spent[0]).toBe('refresh-0');
    for (let i = 1; i < spent.length; i += 1) {
      expect(spent[i]).toBe(`refresh-${i}`);
    }
  });

  it('ADJ-HOLDS: a bearer 30s from expiry (inside the lead window, clock sane) refreshes once after the 1s floor and then follows the new expiry', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-04T12:00:00Z'));
    let n = 0;
    const fetchFn = jest.fn(async () => {
      n += 1;
      return response({
        session: {
          accessToken: `access-${n}`,
          refreshToken: `refresh-${n}`,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      });
    });
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Date.now() + 30_000,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ─── ADJ-2: Keychain write failure is swallowed with no retry ─────────────────

describe('ADJ-2 authStore/sessionVault: Keychain write failure', () => {
  it('ADJ-FAIL: a rotation whose Keychain write fails once re-persists the CURRENT refresh token by the next foreground without spending another rotation', async () => {
    await signInApple();
    expect(vaultRecord()?.['refreshToken']).toBe('refresh-1');

    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    const writes = failKeychainWrites(1);
    refreshSessionNow();
    await settle();
    expect(getApiSession()?.refreshToken).toBe('refresh-2');
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);

    // Keychain is healthy again; app comes to the foreground.
    foreground();
    await settle();

    // Observed on 4d812e1a: setGenericPassword called once (the failure),
    // vault still holds the SPENT refresh-1 → next launch is refused (401)
    // and the durable sign-in is lost.
    expect(writes.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(vaultRecord()?.['refreshToken']).toBe('refresh-2');
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });

  it('ADJ-FAIL: a sign-in whose Keychain write fails once re-persists the record by the next foreground', async () => {
    const writes = failKeychainWrites(1);
    const fetchMock = await signInApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()?.refreshToken).toBe('refresh-1');

    foreground();
    await settle();

    // Observed on 4d812e1a: one failed write, vault empty → next launch
    // starts signed out although the user never signed out.
    expect(writes.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(vaultRecord()?.['refreshToken']).toBe('refresh-1');
    expect(callsTo(fetchMock, '/v1/account/bootstrap')).toHaveLength(1);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
  });

  it('ADJ-HOLDS: a Keychain that keeps failing still signs the user in for this run (fail-soft, never a crash)', async () => {
    failKeychainWrites(Number.POSITIVE_INFINITY);
    await signInApple();
    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(state.error).toBeNull();
    expect(getApiSession()?.refreshToken).toBe('refresh-1');
    expect(getActiveDataOwner()).toBe(canonicalId);
  });
});

// ─── ADJ-3: onRevoked via the app's wiring cannot reject ─────────────────────

describe('ADJ-3 authStore: server 401 on rotation while local storage is failing', () => {
  it('ADJ-HOLDS: Keychain reset AND SQLite throwing during the revoked path produce no unhandled rejection; the user is signed out', async () => {
    await signInApple();
    installRoutes({
      '/v1/auth/refresh': () => response({ error: 'gone' }, 401),
    });
    keychainModule.resetGenericPassword = jest
      .fn()
      .mockRejectedValue(new Error('errSecInteractionNotAllowed'));
    mockDbFailure = new Error('SQLITE_IOERR');

    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      refreshSessionNow();
      await settle();
      await settle();
    } finally {
      process.off('unhandledRejection', listener);
    }

    expect(unhandled).toEqual([]);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });
});
