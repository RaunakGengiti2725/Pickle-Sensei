/**
 * Structural audit #2 (mobile-auth-session) — authStore × sessionVault ×
 * sessionKeeper seams that no existing suite drives:
 *
 *  - Keychain write/delete failures (sessionVault swallows them and returns
 *    false / void; authStore ignores the result at L247/L304/L715);
 *  - a vault record whose canonical id is not a UUID (canonicalDataOwner
 *    throws at authStore L393 before any vault cleanup);
 *  - SQLite unavailable at launch (hydrate catch-all L600-604);
 *  - continueAsGuest leaving the vault behind (L699-705, no UI caller);
 *  - sign-out / account switch racing an in-flight launch refresh.
 *
 * Audit-only: new file, touches no production code and no existing test.
 * Tests titled "SUSPECTED DEFECT" are expected to FAIL on 4d812e1a; the
 * failure is the evidence. Tests titled "VERIFIED" pin behaviour that holds.
 */
import { NativeModules } from 'react-native';
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
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

// ─── Module seams ────────────────────────────────────────────────────────────

const mockKeychainStore = new Map<
  string,
  { username: string; password: string }
>();
const mockKeychainFailures: { set: Error | null; reset: Error | null } = {
  set: null,
  reset: null,
};
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  setGenericPassword: async (
    username: string,
    password: string,
    options: { service?: string } = {},
  ) => {
    if (mockKeychainFailures.set) throw mockKeychainFailures.set;
    mockKeychainStore.set(options.service ?? '__default__', {
      username,
      password,
    });
    return { service: options.service, storage: 'KeychainMock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    const item = mockKeychainStore.get(options.service ?? '__default__');
    if (!item) return false;
    return { service: options.service, storage: 'KeychainMock', ...item };
  },
  resetGenericPassword: async (options: { service?: string } = {}) => {
    if (mockKeychainFailures.reset) throw mockKeychainFailures.reset;
    return mockKeychainStore.delete(options.service ?? '__default__');
  },
}));

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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const otherCanonicalId = '1b6f1a7e-5c2d-4c1e-9a3b-2d4f6e8a0c12';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const bootstrapBody = (
  tokens: { access: string; refresh: string },
  id = canonicalId,
) => ({
  user: { id, email: 'pat@example.com' },
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

type Route = (init?: RequestInit) => Response | Promise<Response>;

/** Routes fetch by URL suffix; unknown routes reject like a dead network. */
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

function callsTo(fetchMock: jest.Mock, suffix: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function vaultRecord(): Record<string, unknown> | null {
  const item = mockKeychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function seedVault(
  refreshToken: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  mockKeychainStore.set(SESSION_VAULT_SERVICE, {
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

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockKeychainStore.clear();
  mockKeychainFailures.set = null;
  mockKeychainFailures.reset = null;
  mockDbFailure = null;
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
  jest.useRealTimers();
});

// ─── Keychain failures are swallowed ─────────────────────────────────────────

describe('sessionVault failures are silent (savePersistedSession → false is ignored by authStore)', () => {
  it('SUSPECTED DEFECT: a Keychain write failure during sign-in leaves a session that is NOT durable, with no error and no retry — the next launch is signed out with the server session still alive', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    mockKeychainFailures.set = new Error('errSecInteractionNotAllowed');

    await useAuthStore.getState().signInWithApple();

    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(getApiSession()?.refreshToken).toBe('refresh-1');
    // Observed on 4d812e1a: error is null AND the vault is empty — the store
    // reports a normal sign-in while nothing survives a relaunch.
    const durable = vaultRecord()?.refreshToken === 'refresh-1';
    const surfaced = state.error !== null;
    expect({ durable, surfaced, vault: vaultRecord() }).toEqual(
      expect.objectContaining({ durable: true }),
    );
  });

  it('SUSPECTED DEFECT: a Keychain write failure during rotation leaves the SPENT refresh token in the vault; nothing re-persists it until the next rotation', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    // Rotation (route 401 → refreshSessionNow) while the Keychain rejects
    // exactly one write.
    mockKeychainFailures.set = new Error('errSecInteractionNotAllowed');
    refreshSessionNow();
    await flush(20);
    mockKeychainFailures.set = null;
    await flush(20);

    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    // Observed on 4d812e1a: the vault still says refresh-1, which the server
    // has already rotated away. Killed now, the next launch refreshes with a
    // spent token → 401 → the ONE implicit sign-out fires for a user who did
    // nothing wrong. Expected: vault === live refresh token (or a retry).
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
  });

  it('SUSPECTED DEFECT: a Keychain delete failure during sign-out is swallowed; an offline relaunch restores the account the user just signed out of', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    mockKeychainFailures.reset = new Error('errSecInteractionNotAllowed');
    await useAuthStore.getState().signOut();
    mockKeychainFailures.reset = null;

    expect(useAuthStore.getState().session).toBeNull();
    // The vault still holds the record (the comment at sessionVault.ts L127
    // calls a stale item "harmless").
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    // Next launch, offline: the refresh cannot be refused, so the persisted
    // record wins and the signed-out user is back in, with their local data.
    jest.useFakeTimers();
    installRoutes({});
    const hydrating = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrating;
    const state = useAuthStore.getState();
    // Expected (authStore.ts L713-714: "the next launch must not restore an
    // account the user just signed out of"): signed out.
    expect(state.session).toBeNull();
  });
});

// ─── Malformed / untrusted vault material ────────────────────────────────────

describe('vault record validation (I5: a malformed Keychain record is discarded, never trusted)', () => {
  it('SUSPECTED DEFECT: a record whose canonicalAppUserId is not a UUID is neither restored nor discarded — sticky signed-out launch with the refresh token retained and never exchanged or revoked', async () => {
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    seedVault('refresh-1', { canonicalAppUserId: 'apple:001234.abcdef' });
    // sessionVault accepts it (type-only validation)…
    await expect(loadPersistedSession()).resolves.toMatchObject({
      canonicalAppUserId: 'apple:001234.abcdef',
    });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    // …authStore.restorePersistedSession throws at canonicalDataOwner()
    // before any cleanup; hydrate's catch-all lands signed out. Observed on
    // 4d812e1a: no refresh attempted, record still in the Keychain — every
    // launch repeats this. Expected (I5): the record is discarded.
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(vaultRecord()).toBeNull();
  });

  it('VERIFIED: a record with a wrong version / missing token is discarded by sessionVault itself and the launch is a clean signed-out one', async () => {
    seedVault('refresh-1', { version: 2 });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();

    seedVault('', {});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});

// ─── SQLite unavailable at launch ────────────────────────────────────────────

describe('hydrate catch-all (authStore.ts L600-604)', () => {
  it('SUSPECTED DEFECT: when SQLite cannot be opened at launch, an intact Keychain session is not restored — the user is signed out for that launch and no refresh is attempted', async () => {
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    seedVault('refresh-1');
    mockDbFailure = new Error('unable to open database file');

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    // Observed on 4d812e1a: session null, owner signed-out, zero refresh
    // calls. Expected (AGENTS.md: "hydrate() restores from the vault FIRST";
    // the vault has no SQLite dependency): signed in from the record.
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
  });
});

// ─── continueAsGuest is live in the store but has no UI caller ───────────────

describe('continueAsGuest (authStore.ts L699-705)', () => {
  it('SUSPECTED DEFECT: switching a synced session to the local guest leaves the Keychain record (and a live, unrevoked refresh token) behind', async () => {
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    await useAuthStore.getState().continueAsGuest();

    expect(useAuthStore.getState().session?.provider).toBe('guest');
    expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
    expect(getApiSession()).toBeNull();
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);
    // Observed on 4d812e1a: the record survives; the guest flag shadows it on
    // relaunch, so the token is never exchanged, never revoked, and comes
    // back the moment the guest flag is cleared. Expected: cleared like
    // signOut / dropRevokedSession do.
    expect(vaultRecord()).toBeNull();
  });
});

// ─── Races the existing suites do not drive ──────────────────────────────────

describe('in-flight launch refresh vs. sign-out / account switch (VERIFIED)', () => {
  it('VERIFIED: sign-out while the launch refresh is still in flight — the late rotation is dropped, nothing is resurrected', async () => {
    jest.useFakeTimers();
    const pending = deferred<Response>();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => pending.promise,
      '/v1/auth/logout': () => response(null, 204),
    });
    seedVault('refresh-1');
    const hydrating = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );

    await useAuthStore.getState().signOut();
    pending.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrating;

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    // INFERRED, recorded not asserted: with no bearer yet, signOut has
    // nothing to send to /v1/auth/logout — the server-side session that the
    // late rotation just minted is never revoked from this device.
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);
  });

  it("VERIFIED: account A signed in offline (refresh still pending past the 8 s launch wait) → sign-out → sign in as B → A's late rotation cannot touch B", async () => {
    jest.useFakeTimers();
    const pendingA = deferred<Response>();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => pendingA.promise,
      '/v1/auth/logout': () => response(null, 204),
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(
            { access: 'access-B1', refresh: 'refresh-B1' },
            otherCanonicalId,
          ),
        ),
    });
    seedVault('refresh-A1');
    const hydrating = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrating;
    expect(useAuthStore.getState()).toMatchObject({
      hydrated: true,
      session: expect.objectContaining({ canonicalAppUserId: canonicalId }),
    });
    expect(getApiSession()).toBeNull();

    await useAuthStore.getState().signOut();
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      otherCanonicalId,
    );
    expect(getApiSession()?.bearerToken).toBe('access-B1');

    pendingA.resolve(
      response(refreshBody({ access: 'access-A2', refresh: 'refresh-A2' })),
    );
    await jest.advanceTimersByTimeAsync(0);
    await flush(20);

    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      otherCanonicalId,
    );
    expect(getApiSession()).toMatchObject({
      canonicalAppUserId: otherCanonicalId,
      bearerToken: 'access-B1',
      refreshToken: 'refresh-B1',
    });
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(bearerTokenFor(otherCanonicalId)).toBe('access-B1');
    expect(getActiveDataOwner()).toBe(canonicalDataOwner(otherCanonicalId));
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: otherCanonicalId,
      refreshToken: 'refresh-B1',
    });
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });

  it('VERIFIED: a revoked launch refresh clears everything and the legacy Google flag is not consulted afterwards', async () => {
    installRoutes({
      '/v1/auth/refresh': () => response({ error: 'revoked' }, 401),
    });
    seedVault('refresh-1', { provider: 'google' });
    mockKv.set('auth.last-provider', 'google');
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState()).toMatchObject({
      hydrated: true,
      session: null,
      error: null,
    });
    expect(vaultRecord()).toBeNull();
    expect(mockKv.get('auth.last-provider') ?? '').toBe('');
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });
});
