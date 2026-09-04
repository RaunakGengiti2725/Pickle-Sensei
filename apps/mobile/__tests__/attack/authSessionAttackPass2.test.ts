/**
 * Adversarial pass 3/3 (tester #2) against `mobile-auth-session` at
 * 4d812e1aa699014cc0521fd92fde66908043aaa8.
 *
 * Every `it` is an attack. The suite is written so that it PASSES against the
 * current behaviour of authStore / sessionVault / sessionKeeper /
 * apiSession — including the places where that behaviour is arguably wrong.
 * Those cases carry an `OBSERVED:` note in their title and are reported as
 * findings by the tester; if a later fix changes the behaviour, the pinned
 * expectation flips and the test tells the integrator exactly what moved.
 *
 * Scenarios (assigned):
 *  S1 10 × reportApiUnauthorized(currentBearer) in one tick → 1 refresh.
 *  S2 reportApiUnauthorized while `busy` → dropped; no later refresh from it.
 *  S3 legacy provider-token session, Google signInSilently throws →
 *     auth.session_expired exactly once, auth.last-provider kept.
 *  S4 getDb() throws during hydrate() with a valid vault record.
 *  S5 getGenericPassword rejects (Keychain-locked analogue) on hydrate.
 *  S6 resetGenericPassword throws during signOut().
 *  S7 setGenericPassword returns false / throws during signInWithApple.
 * Extra:
 *  X1 401 storm across ticks while refresh 5xx-es → backoff is bypassed.
 *  X2 device clock ahead of the server → 1 refresh / MIN_DELAY forever.
 *  X3 rapid foreground bursts → single refresh.
 *  X4 sign-out while the launch refresh is in flight → late tokens dropped,
 *     vault stays empty, but /v1/auth/logout never fires (no bearer yet).
 *  X5 sign-out with Keychain reset failing + offline → relaunch resurrects
 *     the signed-out account.
 *  X6 vault record whose canonical id is not a UUID → signed-out every launch
 *     and the record is never discarded.
 *  X7 unicode / 64 KiB refresh token round-trips vault → refresh body.
 *  X8 stale bearer 401 after rotation is ignored.
 *  X9 rotated tokens racing a sign-in for a DIFFERENT account are dropped.
 *  X10 seeded random interleaving of 401 / foreground / refresh completion
 *      never yields >1 in-flight refresh or a double-spent refresh token.
 */
import { AppState, NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import {
  SESSION_EXPIRED_MESSAGE,
  useAuthStore,
} from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Module seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
function workingDb(): LocalDb {
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
let mockGetDb: () => LocalDb = workingDb;
jest.mock('../../src/data/db', () => ({ getDb: () => mockGetDb() }));

// The sync runtime registers its own AppState listener and drains an outbox
// on foreground; it is out of scope here and would only add fetch noise to
// the request counts below.
jest.mock('../../src/data/syncRuntime', () => ({
  configureSyncRuntime: jest.fn(),
  clearSyncRuntime: jest.fn(),
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
const otherCanonicalId = '0b6f2f1e-9d0a-4c6b-8f1d-2a3b4c5d6e7f';
const LAST_PROVIDER_KEY = 'auth.last-provider';
const LOCAL_MODE_KEY = 'auth.local-mode';

const farFutureSeconds = () => Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const bootstrapBody = (
  tokens: { access: string; refresh: string } | null,
  id = canonicalId,
) => ({
  user: { id, email: 'pat@example.com' },
  onboardingState: 'complete',
  ...(tokens
    ? {
        session: {
          accessToken: tokens.access,
          refreshToken: tokens.refresh,
          expiresAt: farFutureSeconds(),
        },
      }
    : {}),
});

const refreshBody = (
  tokens: { access: string; refresh: string },
  expiresAt = farFutureSeconds(),
) => ({
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt,
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

function callsTo(fetchMock: jest.Mock, suffix: string): RequestInit[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith(suffix))
    .map(([, init]) => init as RequestInit);
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

/** Lets every already-queued microtask + macrotask settle (real timers). */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

/** Deferred fetch response the test releases by hand. */
function deferredRoute(): {
  route: Route;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
  count: () => number;
} {
  const pending: Array<{
    resolve: (r: Response) => void;
    reject: (e: unknown) => void;
  }> = [];
  return {
    route: () =>
      new Promise<Response>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    resolve: r => {
      for (const p of pending.splice(0)) p.resolve(r);
    },
    reject: e => {
      for (const p of pending.splice(0)) p.reject(e);
    },
    count: () => pending.length,
  };
}

/** Captures every AppState 'change' handler registered while spied. */
function captureAppState(): { fire: (state: string) => void } {
  const handlers: Array<(state: string) => void> = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      handlers.push(handler as (state: string) => void);
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  return { fire: state => handlers.slice().forEach(h => h(state)) };
}

/** Deterministic PRNG (mulberry32) so interleavings are reproducible. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function signInApple(
  tokens = { access: 'access-1', refresh: 'refresh-1' },
) {
  installRoutes({
    '/v1/account/bootstrap': () => response(bootstrapBody(tokens)),
  });
  await useAuthStore.getState().signInWithApple();
  expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(canonicalId);
  expect(getApiSession()?.bearerToken).toBe(tokens.access);
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  __keychainStore.clear();
  mockGetDb = workingDb;
  stopSessionKeeper();
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
  jest.useRealTimers();
  jest.restoreAllMocks();
  stopSessionKeeper();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

// ─── S1 ──────────────────────────────────────────────────────────────────────

describe('S1 — 401 storm in one tick', () => {
  it('10 × reportApiUnauthorized(currentBearer) in one tick issues exactly one /v1/auth/refresh', async () => {
    await signInApple();
    const refresh = deferredRoute();
    const fetchMock = installRoutes({ '/v1/auth/refresh': refresh.route });

    for (let i = 0; i < 10; i += 1) reportApiUnauthorized('access-1');
    await flush();

    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(refresh.count()).toBe(1);
    // The bearer is untouched until the rotation lands — callers keep the old
    // token rather than seeing null mid-flight.
    expect(bearerTokenFor(canonicalId)).toBe('access-1');

    refresh.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await flush();

    expect(bearerTokenFor(canonicalId)).toBe('access-2');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
  });

  it('a second 401 storm for the ROTATED bearer after the first lands refreshes exactly once more', async () => {
    await signInApple();
    let n = 1;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => {
        n += 1;
        return response(
          refreshBody({ access: `access-${n}`, refresh: `refresh-${n}` }),
        );
      },
    });

    for (let i = 0; i < 10; i += 1) reportApiUnauthorized('access-1');
    await flush();
    expect(bearerTokenFor(canonicalId)).toBe('access-2');

    for (let i = 0; i < 10; i += 1) reportApiUnauthorized('access-2');
    await flush();

    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(2);
    expect(bearerTokenFor(canonicalId)).toBe('access-3');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-3' });
  });
});

// ─── S2 ──────────────────────────────────────────────────────────────────────

describe('S2 — 401 while busy (mid sign-in)', () => {
  it('OBSERVED: the 401 is dropped and nothing schedules a refresh for it; only the keeper’s pre-existing expiry timer remains', async () => {
    jest.useFakeTimers();
    await signInApple();

    // Start a second interactive sign-in whose native sheet never returns:
    // busy = true while the previous session (and bearer) are still live.
    const hang = new Promise<never>(() => {});
    (
      nativeModules.PickleAuth as { signInWithApple: jest.Mock }
    ).signInWithApple = jest.fn().mockReturnValue(hang);
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    const signIn = useAuthStore.getState().signInWithApple();
    await jest.advanceTimersByTimeAsync(0);
    expect(useAuthStore.getState().busy).toBe(true);
    expect(getApiSession()?.bearerToken).toBe('access-1');

    for (let i = 0; i < 5; i += 1) reportApiUnauthorized('access-1');
    await jest.advanceTimersByTimeAsync(0);

    // Dropped: no refresh, bearer unchanged, no error surfaced.
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(bearerTokenFor(canonicalId)).toBe('access-1');
    expect(useAuthStore.getState().error).toBeNull();

    // Nothing was scheduled BECAUSE of the 401: after 30 minutes the dead
    // bearer is still served. The keeper only rotates at its own
    // expiry − 60s lead (bearer minted for +3600s above).
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(bearerTokenFor(canonicalId)).toBe('access-1');

    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(bearerTokenFor(canonicalId)).toBe('access-2');

    void signIn; // never settles; the store is reset by afterEach
  });

  it('a 401 that arrives after busy clears is honoured normally (self-healing on the next rejected call)', async () => {
    await signInApple();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });

    useAuthStore.setState({ busy: true });
    reportApiUnauthorized('access-1');
    await flush();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);

    useAuthStore.setState({ busy: false });
    reportApiUnauthorized('access-1');
    await flush();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
  });
});

// ─── S3 ──────────────────────────────────────────────────────────────────────

describe('S3 — legacy provider-token session, silent Google restore throws', () => {
  async function signInLegacyGoogle() {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'google-id-token',
        user: {
          id: 'g-user',
          email: 'pat@example.com',
          name: 'Pat Player',
          givenName: 'Pat',
          familyName: 'Player',
          photo: null,
        },
      },
    });
    installRoutes({
      // Legacy server: canonical account, NO session block.
      '/v1/account/bootstrap': () => response(bootstrapBody(null)),
    });
    await useAuthStore.getState().signInWithGoogle();
    const api = getApiSession();
    expect(api?.refreshToken).toBeNull();
    expect(api?.bearerToken).toBe('google-id-token');
    expect(vaultRecord()).toBeNull();
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(
      JSON.stringify({ version: 1, provider: 'google' }),
    );
  }

  it('sets auth.session_expired exactly once (even under a 401 storm) and keeps auth.last-provider', async () => {
    await signInLegacyGoogle();
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockRejectedValue(
      new Error('SIGN_IN_REQUIRED'),
    );
    const setStateSpy = jest.spyOn(useAuthStore, 'setState');
    const fetchMock = installRoutes({});

    for (let i = 0; i < 10; i += 1) reportApiUnauthorized('google-id-token');
    await flush(8);

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.error).toEqual({
      code: 'auth.session_expired',
      message: SESSION_EXPIRED_MESSAGE,
    });
    const expiredWrites = setStateSpy.mock.calls.filter(([patch]) => {
      const p = patch as { error?: { code?: string } | null };
      return p?.error?.code === 'auth.session_expired';
    });
    expect(expiredWrites).toHaveLength(1);
    expect(mockGoogleSignin.signInSilently).toHaveBeenCalledTimes(1);
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    // The flag survives so the next launch may retry the silent restore.
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(
      JSON.stringify({ version: 1, provider: 'google' }),
    );
    expect(mockKv.get(LOCAL_MODE_KEY)).toBe('');
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);
  });

  it('a stale vault record from an earlier durable session is wiped by the legacy expiry path (clearPersistedSession is unconditional)', async () => {
    await signInLegacyGoogle();
    // Stale record left by an earlier account whose sign-out could not reach
    // the Keychain (see S6): the expiry path clears it as a side effect.
    seedVault('someone-elses-refresh', 'apple', otherCanonicalId);
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockRejectedValue(new Error('offline'));

    reportApiUnauthorized('google-id-token');
    await flush(8);

    expect(useAuthStore.getState().error?.code).toBe('auth.session_expired');
    expect(vaultRecord()).toBeNull();
  });

  it('the next launch retries the silent restore and, when Google then answers, restores the account', async () => {
    await signInLegacyGoogle();
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockRejectedValue(new Error('offline'));
    reportApiUnauthorized('google-id-token');
    await flush(8);
    expect(useAuthStore.getState().session).toBeNull();

    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'google-id-token-2',
        user: {
          id: 'g-user',
          email: 'pat@example.com',
          name: 'Pat Player',
          givenName: 'Pat',
          familyName: 'Player',
          photo: null,
        },
      },
    });
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    useAuthStore.setState({ hydrated: false, error: null });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
  });
});

// ─── S4 ──────────────────────────────────────────────────────────────────────

describe('S4 — getDb() throws during hydrate() with a valid vault record', () => {
  it('OBSERVED: the launch lands signed-out (session null, hydrated true) although the vault record is valid; the record survives untouched', async () => {
    seedVault('refresh-1', 'apple');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    mockGetDb = () => {
      throw new Error('SQLITE_CANTOPEN: unable to open database file');
    };
    const getSpy = jest.spyOn(Keychain, 'getGenericPassword');

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    // Pinned current behaviour: signed OUT on a SQLite hiccup — the sign-in
    // screen is shown to a user who has a valid durable session.
    expect(state.session).toBeNull();
    expect(state.error).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    // The vault was never consulted, so nothing was spent or cleared.
    expect(getSpy).not.toHaveBeenCalled();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    expect(getApiSession()).toBeNull();
  });

  it('the NEXT launch (getDb healthy again) restores the account from the surviving record', async () => {
    seedVault('refresh-1', 'apple');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    mockGetDb = () => {
      throw new Error('SQLITE_CANTOPEN');
    };
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();

    mockGetDb = workingDb;
    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(getApiSession()?.bearerToken).toBe('access-2');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });

  it('a getDb() failure AFTER the vault restore (legacy flag read) does not undo the restored session', async () => {
    // The kv read for auth.last-provider only runs when the vault yields
    // nothing or is refused; with a good record the db is touched before
    // the vault only. Prove a db that dies on the SECOND call is harmless.
    seedVault('refresh-1', 'apple');
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    const good = workingDb();
    let calls = 0;
    mockGetDb = () => ({
      close() {},
      async execute(sql, params) {
        calls += 1;
        if (calls > 2) throw new Error('SQLITE_IOERR');
        return good.execute(sql, params);
      },
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()?.bearerToken).toBe('access-2');
  });
});

// ─── S5 ──────────────────────────────────────────────────────────────────────

describe('S5 — Keychain read rejects on hydrate (locked-Keychain analogue)', () => {
  it('lands signed-out, keeps the record, spends nothing, and does not fall into the Google silent path for an Apple record', async () => {
    seedVault('refresh-1', 'apple');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValue(new Error('errSecInteractionNotAllowed (-25308)'));
    const resetSpy = jest.spyOn(Keychain, 'resetGenericPassword');

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(state.error).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(__keychainStore.get(SESSION_VAULT_SERVICE)?.password).toContain(
      'refresh-1',
    );
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(mockKv.get(LOCAL_MODE_KEY)).toBeUndefined();
  });

  it('a Keychain read that rejects while auth.last-provider=google falls back to the legacy silent restore', async () => {
    seedVault('refresh-1', 'google');
    mockKv.set(
      LAST_PROVIDER_KEY,
      JSON.stringify({ version: 1, provider: 'google' }),
    );
    jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValue(new Error('locked'));
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'google-id-token',
        user: {
          id: 'g-user',
          email: 'pat@example.com',
          name: 'Pat Player',
          givenName: 'Pat',
          familyName: 'Player',
          photo: null,
        },
      },
    });
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-9', refresh: 'refresh-9' })),
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()?.bearerToken).toBe('access-9');
  });

  it('the following launch with a readable Keychain restores from the untouched record', async () => {
    seedVault('refresh-1', 'apple');
    const spy = jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValue(new Error('locked'));
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();

    spy.mockRestore();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': init => {
        expect(JSON.parse(String(init?.body))).toEqual({
          refreshToken: 'refresh-1',
        });
        return response(
          refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
        );
      },
    });
    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });
});

// ─── S6 ──────────────────────────────────────────────────────────────────────

describe('S6 — resetGenericPassword throws during signOut()', () => {
  it('still revokes server-side with the current bearer and clears UI/API state, guest flag and last-provider', async () => {
    await signInApple();
    mockKv.set(
      LAST_PROVIDER_KEY,
      JSON.stringify({ version: 1, provider: 'google' }),
    );
    const fetchMock = installRoutes({
      '/v1/auth/logout': () => response({ ok: true }, 204),
    });
    jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('errSecInteractionNotAllowed'));

    await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    const logouts = callsTo(fetchMock, '/v1/auth/logout');
    expect(logouts).toHaveLength(1);
    expect(
      (logouts[0]?.headers as Record<string, string>)['Authorization'],
    ).toBe('Bearer access-1');
    expect(mockKv.get(LOCAL_MODE_KEY)).toBe('');
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe('');
    // The Keychain item could not be removed: the record is still there.
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
  });

  it('a synchronous throw from resetGenericPassword is equally contained', async () => {
    await signInApple();
    const fetchMock = installRoutes({
      '/v1/auth/logout': () => response({ ok: true }, 204),
    });
    jest.spyOn(Keychain, 'resetGenericPassword').mockImplementation(() => {
      throw new Error('native module missing');
    });

    await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();
    expect(useAuthStore.getState().session).toBeNull();
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(1);
  });

  it('after such a sign-out, an ONLINE relaunch is refused by the server (revoked token → 401) and the stale record is finally cleared', async () => {
    await signInApple();
    installRoutes({ '/v1/auth/logout': () => response({ ok: true }, 204) });
    const resetSpy = jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('locked'));
    await useAuthStore.getState().signOut();
    expect(vaultRecord()).not.toBeNull();
    resetSpy.mockRestore();

    installRoutes({
      '/v1/auth/refresh': () =>
        response({ error: { message: 'revoked' } }, 401),
    });
    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(vaultRecord()).toBeNull();
  });
});

// ─── S7 ──────────────────────────────────────────────────────────────────────

describe('S7 — Keychain write fails during signInWithApple', () => {
  it.each([
    ['returns false', () => Promise.resolve(false as const)],
    ['rejects', () => Promise.reject(new Error('errSecDuplicateItem'))],
    [
      'throws synchronously',
      () => {
        throw new Error('native module missing');
      },
    ],
  ])(
    'OBSERVED: setGenericPassword %s → the UI session is established silently (no error, no warning, nothing persisted, keeper running)',
    async (_label, impl) => {
      jest
        .spyOn(Keychain, 'setGenericPassword')
        .mockImplementation(impl as typeof Keychain.setGenericPassword);
      const fetchMock = installRoutes({
        '/v1/account/bootstrap': () =>
          response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      });

      await expect(
        useAuthStore.getState().signInWithApple(),
      ).resolves.toBeUndefined();

      const state = useAuthStore.getState();
      expect(state.session?.canonicalAppUserId).toBe(canonicalId);
      expect(state.busy).toBe(false);
      expect(state.error).toBeNull();
      expect(getApiSession()?.bearerToken).toBe('access-1');
      expect(getActiveDataOwner()).toBe(canonicalId);
      expect(vaultRecord()).toBeNull();
      expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);

      // The keeper still rotates for this run; the rotated token is again
      // offered to the Keychain and again lost.
      installRoutes({
        '/v1/auth/refresh': () =>
          response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
      });
      reportApiUnauthorized('access-1');
      await flush();
      expect(bearerTokenFor(canonicalId)).toBe('access-2');
      expect(vaultRecord()).toBeNull();
    },
  );

  it('OBSERVED: the next launch then lands signed-out with no explanation (nothing was persisted, no error surfaced)', async () => {
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockResolvedValue(false as never);
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session).not.toBeNull();

    // Relaunch.
    stopSessionKeeper();
    clearApiSession();
    useAuthStore.setState({ hydrated: false, session: null });
    const fetchMock = installRoutes({});
    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(state.error).toBeNull();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
  });
});

// ─── X1 ──────────────────────────────────────────────────────────────────────

describe('X1 — 401s across ticks while refresh 5xx-es', () => {
  it('OBSERVED: each rejected API call re-fires refresh immediately, bypassing the keeper backoff (N 401s → N refresh POSTs)', async () => {
    jest.useFakeTimers();
    await signInApple();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response({ error: { message: 'temporarily unavailable' } }, 503),
    });

    for (let i = 0; i < 10; i += 1) {
      reportApiUnauthorized('access-1');
      // Successive API rejections 100 ms apart — far inside the 5 s backoff.
      await jest.advanceTimersByTimeAsync(100);
    }

    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(10);
    // The session itself is intact: a 5xx never signs out.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(bearerTokenFor(canonicalId)).toBe('access-1');
  });

  it('the keeper’s own retry after a 503 does honour backoff (5 s, 10 s, 20 s …)', async () => {
    jest.useFakeTimers();
    seedVault('refresh-1', 'apple');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => response({ error: { message: 'down' } }, 503),
    });

    await useAuthStore.getState().hydrate();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(3);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
  });
});

// ─── X2 ──────────────────────────────────────────────────────────────────────

describe('X2 — device clock skew ahead of the server', () => {
  it('OBSERVED: when every minted bearer already looks expired locally, the keeper refreshes once per MIN_DELAY (1 s) indefinitely', async () => {
    jest.useFakeTimers();
    // Device clock is 2 h ahead: a fresh +1 h token reads as expired 1 h ago.
    const serverNowSeconds = Math.floor(Date.now() / 1000) - 2 * 3600;
    let n = 1;
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          user: { id: canonicalId, email: 'pat@example.com' },
          onboardingState: 'complete',
          session: {
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            expiresAt: serverNowSeconds + 3600,
          },
        }),
      '/v1/auth/refresh': () => {
        n += 1;
        return response(
          refreshBody(
            { access: `access-${n}`, refresh: `refresh-${n}` },
            serverNowSeconds + 3600,
          ),
        );
      },
    });

    await useAuthStore.getState().signInWithApple();
    expect(getApiSession()?.bearerToken).toBe('access-1');

    await jest.advanceTimersByTimeAsync(10_000);

    const refreshes = callsTo(fetchMock, '/v1/auth/refresh').length;
    expect(refreshes).toBeGreaterThanOrEqual(9);
    expect(refreshes).toBeLessThanOrEqual(11);
    // Every rotation was adopted and re-persisted — the vault is rewritten
    // once per second too.
    expect(bearerTokenFor(canonicalId)).toBe(`access-${n}`);
    expect(vaultRecord()).toMatchObject({ refreshToken: `refresh-${n}` });
  });

  it('a device clock BEHIND the server (bearer looks longer-lived) simply delays rotation; no loop', async () => {
    jest.useFakeTimers();
    const serverNowSeconds = Math.floor(Date.now() / 1000) + 2 * 3600;
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          user: { id: canonicalId, email: 'pat@example.com' },
          onboardingState: 'complete',
          session: {
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            expiresAt: serverNowSeconds + 3600,
          },
        }),
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().signInWithApple();

    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    // The server rejects the truly-expired bearer → 401 → immediate rotation.
    reportApiUnauthorized('access-1');
    await jest.advanceTimersByTimeAsync(0);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
  });
});

// ─── X3 ──────────────────────────────────────────────────────────────────────

describe('X3 — foreground bursts', () => {
  it('10 rapid active transitions with a near-expiry bearer issue exactly one refresh', async () => {
    jest.useFakeTimers();
    const appState = captureAppState();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const refresh = deferredRoute();
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          user: { id: canonicalId, email: 'pat@example.com' },
          onboardingState: 'complete',
          session: {
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            // 4 min of life left: under the 5 min foreground lead.
            expiresAt: nowSeconds + 240,
          },
        }),
      '/v1/auth/refresh': refresh.route,
    });
    await useAuthStore.getState().signInWithApple();

    for (let i = 0; i < 10; i += 1) {
      appState.fire('active');
      appState.fire('background');
    }
    await jest.advanceTimersByTimeAsync(0);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);

    refresh.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(bearerTokenFor(canonicalId)).toBe('access-2');

    // With a fresh +1 h bearer, foregrounding no longer refreshes.
    appState.fire('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });

  it('foreground + 401 storm + scheduled rotation all collapsing onto one in-flight refresh', async () => {
    jest.useFakeTimers();
    const appState = captureAppState();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const refresh = deferredRoute();
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          user: { id: canonicalId, email: 'pat@example.com' },
          onboardingState: 'complete',
          session: {
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            expiresAt: nowSeconds + 61, // rotation timer fires in 1 s
          },
        }),
      '/v1/auth/refresh': refresh.route,
    });
    await useAuthStore.getState().signInWithApple();

    appState.fire('active');
    for (let i = 0; i < 10; i += 1) reportApiUnauthorized('access-1');
    await jest.advanceTimersByTimeAsync(5_000); // the scheduled rotation fires too
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);

    refresh.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });
});

// ─── X4 ──────────────────────────────────────────────────────────────────────

describe('X4 — sign-out while the launch refresh is in flight', () => {
  it('late rotated tokens are dropped, the vault stays empty and no ApiSession is installed; OBSERVED: /v1/auth/logout never fires (no bearer yet)', async () => {
    jest.useFakeTimers();
    seedVault('refresh-1', 'apple');
    const refresh = deferredRoute();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': refresh.route,
      '/v1/auth/logout': () => response({ ok: true }, 204),
    });

    const hydrate = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(useAuthStore.getState().hydrated).toBe(false);
    expect(refresh.count()).toBe(1);

    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();

    // The refresh the server already performed lands after the sign-out.
    refresh.resolve(
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(useAuthStore.getState().session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    // Pinned: server-side revocation is impossible without a bearer — the
    // freshly rotated refresh token stays valid server-side.
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(0);

    // hydrate() resolves once its 8 s launch deadline lapses; it must not
    // re-sign the user in.
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrate;
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session).toBeNull();
  });

  it('sign-out during an OFFLINE launch retry: a later successful retry cannot resurrect the account', async () => {
    jest.useFakeTimers();
    seedVault('refresh-1', 'apple');
    let online = false;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () => {
        if (!online) throw new Error('network down');
        return response(
          refreshBody({ access: 'access-2', refresh: 'refresh-2' }),
        );
      },
    });

    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);

    await useAuthStore.getState().signOut();
    online = true;
    await jest.advanceTimersByTimeAsync(10 * 60_000);

    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});

// ─── X5 ──────────────────────────────────────────────────────────────────────

describe('X5 — sign-out with Keychain reset failing while OFFLINE', () => {
  it('OBSERVED: the next launch restores the account the user explicitly signed out of (record survived, logout never reached the server)', async () => {
    await signInApple();
    installRoutes({}); // offline: logout cannot reach the server
    const resetSpy = jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('errSecInteractionNotAllowed'));

    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    resetSpy.mockRestore();

    // Relaunch, still offline (or the server never learned of the logout,
    // which is the same thing: the refresh token is still valid).
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    // Pinned current behaviour: signed back in.
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(getApiSession()?.bearerToken).toBe('access-2');
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });
});

// ─── X6 ──────────────────────────────────────────────────────────────────────

describe('X6 — corrupt vault record with a non-UUID canonical id', () => {
  it('OBSERVED: hydrate lands signed-out on every launch and the poisoned record is never discarded', async () => {
    seedVault('refresh-1', 'apple', 'not-a-uuid');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    const resetSpy = jest.spyOn(Keychain, 'resetGenericPassword');

    for (let launch = 0; launch < 3; launch += 1) {
      useAuthStore.setState({ hydrated: false });
      await useAuthStore.getState().hydrate();
      const state = useAuthStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.session).toBeNull();
      expect(state.error).toBeNull();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    }
    expect(resetSpy).not.toHaveBeenCalled();
    expect(vaultRecord()).toMatchObject({ canonicalAppUserId: 'not-a-uuid' });
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    // The legacy Google path is skipped too: no fallback of any kind.
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
  });

  it('a fresh sign-in overwrites the poisoned record', async () => {
    seedVault('refresh-1', 'apple', 'not-a-uuid');
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();

    await signInApple({ access: 'access-1', refresh: 'refresh-new' });
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: canonicalId,
      refreshToken: 'refresh-new',
    });
  });

  it('an UPPER-CASE canonical id in the record still yields one consistent owner and a resolvable bearer', async () => {
    seedVault('refresh-1', 'apple', canonicalId.toUpperCase());
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId.toUpperCase());
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(bearerTokenFor(canonicalId.toUpperCase())).toBe('access-2');
    // Case-sensitive lookups with the lower-cased owner MISS the bearer.
    expect(bearerTokenFor(canonicalId)).toBeNull();
  });
});

// ─── X7 ──────────────────────────────────────────────────────────────────────

describe('X7 — unicode and huge refresh tokens', () => {
  it('a 64 KiB refresh token with astral-plane unicode round-trips vault → refresh body byte-for-byte', async () => {
    const token = `${'🥒'.repeat(8192)}\u0000${'\u{1F3D3}'.repeat(8192)}`; // ~64 KiB
    seedVault(token, 'apple');
    let seen: string | null = null;
    installRoutes({
      '/v1/auth/refresh': init => {
        seen = (JSON.parse(String(init?.body)) as { refreshToken: string })
          .refreshToken;
        return response(
          refreshBody({ access: 'access-2', refresh: `${token}-rotated` }),
        );
      },
    });

    await useAuthStore.getState().hydrate();

    expect(seen).toBe(token);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(vaultRecord()).toMatchObject({ refreshToken: `${token}-rotated` });
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
  });

  it('an EMPTY refresh token in the vault is treated as malformed and discarded without a network call', async () => {
    seedVault('', 'apple');
    const fetchMock = installRoutes({});

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session).toBeNull();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(vaultRecord()).toBeNull();
  });

  it('OBSERVED: a whitespace-only refresh token passes the vault parser and is sent to the server verbatim; the server’s 401 then ends the session', async () => {
    for (const bad of ['   ', '\n\t']) {
      __keychainStore.clear();
      seedVault(bad, 'apple');
      useAuthStore.setState({ hydrated: false, session: null });
      const fetchMock = installRoutes({
        '/v1/auth/refresh': init => {
          expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: bad });
          return response({ error: { message: 'invalid' } }, 401);
        },
      });

      await useAuthStore.getState().hydrate();

      expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
      expect(useAuthStore.getState().session).toBeNull();
      expect(useAuthStore.getState().hydrated).toBe(true);
      expect(vaultRecord()).toBeNull();
    }
  });
});

// ─── X8 ──────────────────────────────────────────────────────────────────────

describe('X8 — stale bearer reports', () => {
  it('a 401 for the PREVIOUS bearer after a rotation is ignored (no refresh, no sign-out)', async () => {
    await signInApple();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    reportApiUnauthorized('access-1');
    await flush();
    expect(bearerTokenFor(canonicalId)).toBe('access-2');

    for (let i = 0; i < 10; i += 1) reportApiUnauthorized('access-1');
    reportApiUnauthorized('');
    reportApiUnauthorized('Bearer access-2');
    await flush();

    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
  });

  it('a 401 for the current bearer while signed out / guest is a no-op', async () => {
    const fetchMock = installRoutes({});
    reportApiUnauthorized('anything');
    await useAuthStore.getState().continueAsGuest();
    expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
    reportApiUnauthorized('anything');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session?.provider).toBe('guest');
    expect(useAuthStore.getState().error).toBeNull();
  });
});

// ─── X9 ──────────────────────────────────────────────────────────────────────

describe('X9 — rotation racing a sign-in for a different account', () => {
  it('tokens for account A landing after account B signed in are dropped and never persisted', async () => {
    jest.useFakeTimers();
    seedVault('refresh-A', 'apple');
    const refreshA = deferredRoute();
    installRoutes({ '/v1/auth/refresh': refreshA.route });

    const hydrate = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    expect(refreshA.count()).toBe(1);

    // Meanwhile the user signs out and signs in as B.
    await useAuthStore.getState().signOut();
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(
            { access: 'access-B', refresh: 'refresh-B' },
            otherCanonicalId,
          ),
        ),
    });
    await useAuthStore.getState().signInWithApple();
    expect(getApiSession()?.canonicalAppUserId).toBe(otherCanonicalId);

    refreshA.resolve(
      response(refreshBody({ access: 'access-A2', refresh: 'refresh-A2' })),
    );
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrate;

    expect(getApiSession()).toMatchObject({
      canonicalAppUserId: otherCanonicalId,
      bearerToken: 'access-B',
    });
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: otherCanonicalId,
      refreshToken: 'refresh-B',
    });
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      otherCanonicalId,
    );
    expect(getActiveDataOwner()).toBe(otherCanonicalId);
  });
});

// ─── X11 ─────────────────────────────────────────────────────────────────────

describe('X11 — hydrate() re-entered in the same tick (remount / dev fast-refresh)', () => {
  it('OBSERVED: two concurrent hydrate() calls spend the SAME refresh token twice; the first rotation is dropped, the second wins', async () => {
    jest.useFakeTimers();
    seedVault('refresh-1', 'apple');
    const sent: string[] = [];
    let n = 1;
    const fetchMock = installRoutes({
      '/v1/auth/refresh': init => {
        sent.push(
          (JSON.parse(String(init?.body)) as { refreshToken: string })
            .refreshToken,
        );
        n += 1;
        return response(
          refreshBody({ access: `access-${n}`, refresh: `refresh-${n}` }),
        );
      },
    });

    const a = useAuthStore.getState().hydrate();
    const b = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    await b;
    await jest.advanceTimersByTimeAsync(8_000);
    await a;

    // Pinned: the token was presented twice. Against a server with refresh
    // token reuse detection the second exchange is refused and the launch
    // ends signed out.
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(2);
    expect(sent).toEqual(['refresh-1', 'refresh-1']);
    const api = getApiSession();
    expect(api?.bearerToken).toBe('access-3');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-3' });
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(useAuthStore.getState().hydrated).toBe(true);
  });

  it('OBSERVED: with server-side reuse detection (second exchange → 401) the double hydrate signs the user OUT and wipes the record', async () => {
    jest.useFakeTimers();
    seedVault('refresh-1', 'apple');
    let calls = 0;
    installRoutes({
      '/v1/auth/refresh': () => {
        calls += 1;
        return calls === 1
          ? response(refreshBody({ access: 'access-2', refresh: 'refresh-2' }))
          : response({ error: { message: 'refresh token reused' } }, 401);
      },
    });

    const a = useAuthStore.getState().hydrate();
    const b = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    await b;
    await jest.advanceTimersByTimeAsync(8_000);
    await a;

    expect(calls).toBe(2);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });
});

// ─── X10 ─────────────────────────────────────────────────────────────────────

describe('X10 — seeded random interleavings', () => {
  const SEEDS = [1, 42, 1337, 20260904];

  it.each(SEEDS)(
    'seed %d: 401s / foreground / completions never overlap two refreshes nor re-spend a refresh token',
    async seed => {
      jest.useFakeTimers();
      const rand = seededRandom(seed);
      const appState = captureAppState();
      // A refresh token is SPENT once the server rotated it (200). A token
      // that only saw a 503 is legitimately retried with the same value.
      const rotatedAway = new Set<string>();
      let current = 'refresh-1';
      let doubleSpends = 0;
      let staleSends = 0;
      let inFlight = 0;
      let maxInFlight = 0;
      let n = 1;
      const pending: Array<() => void> = [];
      const fetchMock = installRoutes({
        '/v1/account/bootstrap': () =>
          response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
        '/v1/auth/refresh': init => {
          const { refreshToken } = JSON.parse(String(init?.body)) as {
            refreshToken: string;
          };
          if (rotatedAway.has(refreshToken)) doubleSpends += 1;
          if (refreshToken !== current) staleSends += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return new Promise<Response>(resolve => {
            pending.push(() => {
              inFlight -= 1;
              if (rand() < 0.2) {
                resolve(response({ error: { message: 'busy' } }, 503));
                return;
              }
              n += 1;
              rotatedAway.add(refreshToken);
              current = `refresh-${n}`;
              resolve(
                response(
                  refreshBody({
                    access: `access-${n}`,
                    refresh: `refresh-${n}`,
                  }),
                ),
              );
            });
          });
        },
      });
      await useAuthStore.getState().signInWithApple();

      for (let step = 0; step < 200; step += 1) {
        const r = rand();
        if (r < 0.35) {
          const bearer = getApiSession()?.bearerToken ?? '';
          const burst = 1 + Math.floor(rand() * 5);
          for (let i = 0; i < burst; i += 1) reportApiUnauthorized(bearer);
        } else if (r < 0.55) {
          appState.fire('active');
        } else if (r < 0.85) {
          pending.shift()?.();
        } else {
          await jest.advanceTimersByTimeAsync(Math.floor(rand() * 7_000));
        }
        await jest.advanceTimersByTimeAsync(0);
        expect(inFlight).toBeLessThanOrEqual(1);
      }
      while (pending.length) {
        pending.shift()?.();
        await jest.advanceTimersByTimeAsync(0);
      }

      expect(maxInFlight).toBe(1);
      expect(doubleSpends).toBe(0);
      expect(staleSends).toBe(0);
      expect(callsTo(fetchMock, '/v1/auth/refresh').length).toBeGreaterThan(0);
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        canonicalId,
      );
      expect(useAuthStore.getState().error).toBeNull();
      const api = getApiSession();
      expect(api?.refreshToken).toBe(current);
      expect(api?.refreshToken).toBe(vaultRecord()?.['refreshToken']);
      expect(api?.bearerToken).toBe(`access-${n}`);
      expect(api?.bearerToken).toBe(bearerTokenFor(canonicalId));
    },
  );
});
