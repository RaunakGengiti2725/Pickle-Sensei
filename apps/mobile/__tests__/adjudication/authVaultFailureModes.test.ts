/**
 * Durable-session contract under Keychain and SQLite failure
 * (`src/auth/authStore.ts` + `src/account/sessionVault.ts`):
 *
 *  - a Keychain WRITE that fails is retried and surfaced; the vault never
 *    ends up holding a refresh token the server has already rotated away
 *    (MAS-2);
 *  - a Keychain DELETE that fails at explicit sign-out can never bring the
 *    signed-out account back on the next launch, online or offline (MAS-3);
 *  - a local SQLite failure at hydrate degrades local data only — the
 *    Keychain session is restored and refreshed regardless (MAS-4).
 *
 * The Keychain and the local database are controllable mocks; the failures
 * asserted here are injected (real iOS Keychain error semantics are not
 * observable from Linux).
 */
import { AppState, NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import {
  SESSION_VAULT_SERVICE,
  loadPersistedSession,
} from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

// ─── Controllable Keychain ───────────────────────────────────────────────────

const mockKeychainStore = new Map<
  string,
  { username: string; password: string }
>();
/** Remaining failures per operation: 0 = healthy, Infinity = keeps failing. */
const mockKeychainFails = { save: 0, load: 0, clear: 0 };

function mockFailOnce(op: keyof typeof mockKeychainFails): boolean {
  if (mockKeychainFails[op] <= 0) return false;
  mockKeychainFails[op] -= 1;
  return true;
}

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  setGenericPassword: jest.fn(
    async (
      username: string,
      password: string,
      options: { service: string },
    ) => {
      if (mockFailOnce('save')) throw new Error('errSecInteractionNotAllowed');
      mockKeychainStore.set(options.service, { username, password });
      return { service: options.service, storage: 'mock' };
    },
  ),
  getGenericPassword: jest.fn(async (options: { service: string }) => {
    if (mockFailOnce('load')) throw new Error('errSecInteractionNotAllowed');
    const item = mockKeychainStore.get(options.service);
    return item
      ? { ...item, service: options.service, storage: 'mock' }
      : false;
  }),
  resetGenericPassword: jest.fn(async (options: { service: string }) => {
    if (mockFailOnce('clear')) throw new Error('errSecInteractionNotAllowed');
    return mockKeychainStore.delete(options.service);
  }),
}));

// ─── Controllable local database ─────────────────────────────────────────────

const mockKv = new Map<string, string>();
const mockDbFails = { open: false };

function mockCurrentDb(): LocalDb {
  if (mockDbFails.open) throw new Error('database is locked');
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

function refreshCalls(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/v1/auth/refresh'))
    .map(([, init]) => String((init as RequestInit | undefined)?.body));
}

/** The raw Keychain item, if any — NOT parsed, so a tombstone shows as-is. */
function rawVaultItem(): string | null {
  return mockKeychainStore.get(SESSION_VAULT_SERVICE)?.password ?? null;
}

function vaultRecord(): Record<string, unknown> | null {
  const raw = rawVaultItem();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function seedVault(refreshToken: string) {
  mockKeychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

function everyPersistedValue(): string[] {
  return [...mockKv.values(), ...(rawVaultItem() ? [rawVaultItem()!] : [])];
}

/** Simulates a cold launch: in-memory state is gone, storage is whatever
 * the previous run left behind. */
function relaunch() {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  useAuthStore.setState({ hydrated: false, session: null });
}

/** Captures every AppState listener so the test can bring the app back to
 * the foreground; returns a function that does so. */
function captureForeground(): () => Promise<void> {
  const handlers: Array<(state: string) => void> = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      handlers.push(handler as (state: string) => void);
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  return async () => {
    for (const handler of handlers) handler('active');
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  };
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockKeychainStore.clear();
  mockKeychainFails.save = 0;
  mockKeychainFails.load = 0;
  mockKeychainFails.clear = 0;
  mockDbFails.open = false;
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    vaultWritePending: false,
  });
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
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
  jest.restoreAllMocks();
});

// ─── MAS-2: Keychain WRITE failures ──────────────────────────────────────────

describe('MAS-2: a Keychain write that fails', () => {
  it('sign-in: a write that fails once is retried, the vault holds the current refresh token, and the next launch restores the session', async () => {
    mockKeychainFails.save = 1;
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });

    await useAuthStore.getState().signInWithApple();

    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(state.error).toBeNull();
    expect(state.vaultWritePending).toBe(false);
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    relaunch();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(refreshCalls(fetchMock)).toEqual([
      expect.stringContaining('refresh-1'),
    ]);
  });

  it('sign-in: a Keychain that keeps refusing writes is surfaced as not durable and retried on the next foreground', async () => {
    const foreground = captureForeground();
    mockKeychainFails.save = Infinity;
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });

    await useAuthStore.getState().signInWithApple();

    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    // Signed in for this run, but honestly NOT durable yet.
    expect(state.vaultWritePending).toBe(true);
    expect(vaultRecord()).toBeNull();

    // The Keychain becomes writable again; returning to the foreground
    // completes the durable sign-in without another server round trip.
    mockKeychainFails.save = 0;
    await foreground();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    expect(useAuthStore.getState().vaultWritePending).toBe(false);
  });

  it('rotation: a write that fails once ends with the CURRENT refresh token in the vault, and the next cold launch stays signed in', async () => {
    seedVault('refresh-1');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    mockKeychainFails.save = 1;

    await useAuthStore.getState().hydrate();

    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    // Exactly one rotation was spent, and the vault caught up with it.
    expect(refreshCalls(fetchMock)).toHaveLength(1);
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
    expect(useAuthStore.getState().vaultWritePending).toBe(false);

    relaunch();
    const relaunchFetch = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-3', refresh: 'refresh-3' })),
    });
    await useAuthStore.getState().hydrate();
    expect(refreshCalls(relaunchFetch)).toEqual([
      expect.stringContaining('refresh-2'),
    ]);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()?.bearerToken).toBe('access-3');
  });

  it('rotation: a Keychain that keeps refusing writes never leaves the SPENT refresh token behind, and catches up on the next foreground', async () => {
    const foreground = captureForeground();
    seedVault('refresh-1');
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    mockKeychainFails.save = Infinity;

    await useAuthStore.getState().hydrate();

    expect(getApiSession()?.refreshToken).toBe('refresh-2');
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(useAuthStore.getState().vaultWritePending).toBe(true);
    // The server has rotated refresh-1 away; it must not be the record the
    // next launch presents.
    expect(rawVaultItem() ?? '').not.toContain('refresh-1');

    mockKeychainFails.save = 0;
    await foreground();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
    expect(useAuthStore.getState().vaultWritePending).toBe(false);
  });
});

// ─── MAS-3: Keychain DELETE failures at explicit sign-out ────────────────────

describe('MAS-3: a Keychain delete that fails at sign-out', () => {
  it('offline sign-out leaves no restorable session: the next launch is signed out and refreshes nothing', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    mockKeychainFails.clear = Infinity;
    installRoutes({}); // offline: /v1/auth/logout is unreachable
    await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();
    expect(useAuthStore.getState().session).toBeNull();
    // Nothing usable survives sign-out — in the Keychain or in SQLite.
    for (const value of everyPersistedValue()) {
      expect(value).not.toContain('refresh-1');
      expect(value).not.toContain('access-1');
    }

    // Next launch: healthy Keychain, network back, live refresh endpoint.
    mockKeychainFails.clear = 0;
    relaunch();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(refreshCalls(fetchMock)).toEqual([]);
    await expect(loadPersistedSession()).resolves.toBeNull();
  });

  it('when the Keychain refuses both delete and overwrite, hydrate() ignores the signed-out record and finishes the sign-out', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();

    mockKeychainFails.clear = Infinity;
    mockKeychainFails.save = Infinity;
    installRoutes({});
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
    // The Keychain could not be changed at all — the stale record is still
    // physically there…
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    // …but no session material leaked into SQLite to compensate.
    for (const value of mockKv.values()) {
      expect(value).not.toContain('refresh-1');
      expect(value).not.toContain('access-1');
    }

    mockKeychainFails.clear = 0;
    mockKeychainFails.save = 0;
    relaunch();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session).toBeNull();
    expect(refreshCalls(fetchMock)).toEqual([]);
    // The sign-out the Keychain refused earlier is completed now.
    expect(vaultRecord()).toBeNull();

    // And a genuinely new sign-in of the same account is not mistaken for
    // the signed-out one.
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-3', refresh: 'refresh-3' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-3' });
    relaunch();
    const nextFetch = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-4', refresh: 'refresh-4' })),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(refreshCalls(nextFetch)).toEqual([
      expect.stringContaining('refresh-3'),
    ]);
  });

  it('sign-out from an offline launch (no bearer was ever obtained) still ends the durable session', async () => {
    seedVault('refresh-1');
    installRoutes({}); // offline launch: the restore refresh cannot land
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()).toBeNull();

    mockKeychainFails.clear = Infinity;
    mockKeychainFails.save = Infinity;
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();

    mockKeychainFails.clear = 0;
    mockKeychainFails.save = 0;
    relaunch();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(refreshCalls(fetchMock)).toEqual([]);
    expect(vaultRecord()).toBeNull();
  });
});

// ─── MAS-4: local database failure at hydrate ────────────────────────────────

describe('MAS-4: a local SQLite failure at hydrate', () => {
  it('keeps the Keychain session: signed in, hydrated, and the refresh is attempted', async () => {
    seedVault('refresh-1');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    mockDbFails.open = true;

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(refreshCalls(fetchMock)).toEqual([
      expect.stringContaining('refresh-1'),
    ]);
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
  });

  it('an offline launch with a broken database still stays signed in from the record alone', async () => {
    seedVault('refresh-1');
    installRoutes({});
    mockDbFails.open = true;

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
  });
});
