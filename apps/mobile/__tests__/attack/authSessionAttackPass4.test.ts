/**
 * Adversarial pass 3/3 on mobile-auth-session (tester #4), against
 * 4d812e1aa699014cc0521fd92fde66908043aaa8.
 *
 * Every case here asserts the CONTRACT (AGENTS.md "Auth sessions") and passes
 * at that commit — these are the HELD scenarios. The BROKEN scenarios live in
 * authSessionAttackPass4.findings.test.ts, where each test asserts the
 * expected behaviour and fails at the commit as the executable repro.
 *
 * Scenarios (coordinator numbering):
 *  S1 account switch A → B without sign-out; A's late refresh resolves
 *  S4 expiresAt NaN / "123" are malformed → retryable, still signed in
 *     (expiresAt 0 / -1 / ms-scale / 1e308 → findings file)
 *  S5 appStore.hydrate() with {} / non-object canonical profile body
 *  S6 foreground refresh lead: 4 min left → one refresh, 10 min → none
 *  S7 503 ×5 then 200 → 5/10/20/40/80 s, failedAttempts reset on success
 *  S8 apiBaseUrl http://api.example.com → hydrate() is 'offline', 0 requests
 *  S9 setActiveDataOwner A → B mid-write lands under the owner at call start
 *  extra: interleavings, cancellation, stale 401 after switch, boundaries
 */
import { AppState, NativeModules } from 'react-native';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import {
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  refreshApiSession,
  SessionRefreshError,
  type RefreshedTokens,
} from '../../src/account/sessionLifecycle';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  finishSession,
  saveAnalysis,
  saveSession,
  setKv,
} from '../../src/data/repository';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { useAppStore } from '../../src/state/appStore';
import type { Profile } from '../../src/state/profile';
import * as Keychain from 'react-native-keychain';

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

// Mutable so S8 can point the build at a non-HTTPS host.
let mockApiBaseUrl = 'https://api.example.test';
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: mockApiBaseUrl,
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

const ACCOUNT_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const ACCOUNT_B = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const API = 'https://api.example.test';
const HOUR_S = 3600;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function bootstrapBody(
  canonicalAppUserId: string,
  tokens: { access: string; refresh: string },
  expiresAt = nowSeconds() + HOUR_S,
) {
  return {
    user: {
      id: canonicalAppUserId,
      email: `${canonicalAppUserId}@example.com`,
    },
    onboardingState: 'complete',
    session: {
      accessToken: tokens.access,
      refreshToken: tokens.refresh,
      expiresAt,
    },
  };
}

function refreshBody(
  tokens: { access: string; refresh: string },
  expiresAt: unknown = nowSeconds() + HOUR_S,
) {
  return {
    session: {
      accessToken: tokens.access,
      refreshToken: tokens.refresh,
      expiresAt,
    },
  };
}

type RouteHandler = (
  init: RequestInit | undefined,
  url: string,
) => Response | Promise<Response>;

/** Routes fetch by URL suffix; unknown routes reject like a dead network. */
function installRoutes(routes: Record<string, RouteHandler>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init, url);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

/** The refreshToken each POST carried, in call order. */
function sentRefreshTokens(fetchFn: jest.Mock): unknown[] {
  return (fetchFn.mock.calls as Array<[string, RequestInit | undefined]>).map(
    ([, init]) => requestBody(init).refreshToken,
  );
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function durableMaterial(): string {
  return JSON.stringify([...__keychainStore.values(), ...mockKv.values()]);
}

function seedVault(
  refreshToken: string,
  canonicalAppUserId = ACCOUNT_A,
  provider: 'apple' | 'google' = 'apple',
) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider,
      canonicalAppUserId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Settle promise chains that need no timer (fake or real). */
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

type AppStateListener = (state: string) => void;
function appStateListeners(): AppStateListener[] {
  const calls = (AppState.addEventListener as jest.Mock).mock.calls as Array<
    [string, AppStateListener]
  >;
  return calls.map(([, listener]) => listener);
}
/** What RN does on a state change: every registered listener hears it (the
 * keeper's AND the sync runtime's). Listeners of stopped generations are
 * inert by contract, which is part of what is under test. */
function emitAppState(state: string): void {
  const listeners = appStateListeners();
  if (listeners.length === 0)
    throw new Error('no AppState listener registered');
  for (const listener of listeners) listener(state);
}

function appleIdentity(canonicalAppUserId: string) {
  return {
    user: `apple-user-${canonicalAppUserId}`,
    identityToken: `apple-identity-${canonicalAppUserId}`,
    authorizationCode: `apple-code-${canonicalAppUserId}`,
    email: `${canonicalAppUserId}@privaterelay.example`,
    givenName: 'Pat',
    familyName: 'Player',
  };
}

const nativeModules = NativeModules as {
  PickleAuth?: { signInWithApple: jest.Mock };
};
const realFetch = globalThis.fetch;

function resetAuthWorld(): void {
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
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApiBaseUrl = API;
  resetAuthWorld();
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn().mockResolvedValue(appleIdentity(ACCOUNT_A)),
  };
  installRoutes({});
});

afterEach(() => {
  jest.useRealTimers();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

// ─── S1 · account switch A → B, A's late refresh ─────────────────────────────

describe('S1 · sign in as A (keeper running), sign in as B without sign-out, then A’s late refresh lands', () => {
  async function signInAsAWithRefreshInFlight() {
    const lateA = deferred<Response>();
    const refreshCalls: Array<Record<string, unknown>> = [];
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': init => {
        const body = requestBody(init);
        return body.appleAuthorizationCode === `apple-code-${ACCOUNT_B}`
          ? response(
              bootstrapBody(ACCOUNT_B, {
                access: 'access-b1',
                refresh: 'refresh-b1',
              }),
            )
          : response(
              bootstrapBody(ACCOUNT_A, {
                access: 'access-a1',
                refresh: 'refresh-a1',
              }),
            );
      },
      '/v1/auth/refresh': init => {
        refreshCalls.push(requestBody(init));
        return lateA.promise;
      },
    });
    await useAuthStore.getState().signInWithApple();
    expect(getApiSession()?.bearerToken).toBe('access-a1');
    expect(vaultRecord()).toMatchObject({ canonicalAppUserId: ACCOUNT_A });

    // An API route rejected A's bearer → the keeper refreshes right now; the
    // server holds the response (this is A's "late" refresh).
    refreshSessionNow();
    await flush();
    expect(refreshCalls).toEqual([{ refreshToken: 'refresh-a1' }]);
    return { lateA, refreshCalls, fetchMock };
  }

  async function signInAsB() {
    nativeModules.PickleAuth!.signInWithApple.mockResolvedValue(
      appleIdentity(ACCOUNT_B),
    );
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(ACCOUNT_B);
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-b1',
      refreshToken: 'refresh-b1',
      canonicalAppUserId: ACCOUNT_B,
    });
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: ACCOUNT_B,
      refreshToken: 'refresh-b1',
    });
  }

  function expectBUntouched() {
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-b1',
      refreshToken: 'refresh-b1',
      canonicalAppUserId: ACCOUNT_B,
    });
    expect(bearerTokenFor(ACCOUNT_B)).toBe('access-b1');
    expect(bearerTokenFor(ACCOUNT_A)).toBeNull();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(ACCOUNT_B);
    expect(getActiveDataOwner()).toBe(ACCOUNT_B);
    expect(vaultRecord()).toEqual(
      expect.objectContaining({
        canonicalAppUserId: ACCOUNT_B,
        refreshToken: 'refresh-b1',
      }),
    );
    const durable = durableMaterial();
    expect(durable).not.toContain('access-a2');
    expect(durable).not.toContain('refresh-a2');
    expect(durable).not.toContain('refresh-a1');
  }

  it('A’s late SUCCESS is dropped: B’s bearer/refresh token untouched, A’s rotated tokens persisted nowhere', async () => {
    const { lateA, refreshCalls } = await signInAsAWithRefreshInFlight();
    await signInAsB();

    lateA.resolve(
      response(refreshBody({ access: 'access-a2', refresh: 'refresh-a2' })),
    );
    await flush(16);

    expectBUntouched();
    // No follow-up refresh was scheduled for A either (B's keeper owns the
    // only timer).
    expect(refreshCalls).toEqual([{ refreshToken: 'refresh-a1' }]);
  });

  it('A’s late 401 is dropped too: B is NOT signed out and B’s vault record survives', async () => {
    const { lateA } = await signInAsAWithRefreshInFlight();
    await signInAsB();

    lateA.resolve(response({ error: { message: 'Sign in again.' } }, 401));
    await flush(16);

    expectBUntouched();
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('A’s late success landing WHILE B’s bootstrap is still in flight is dropped as well', async () => {
    const lateA = deferred<Response>();
    const lateBootstrapB = deferred<Response>();
    installRoutes({
      '/v1/account/bootstrap': init =>
        requestBody(init).appleAuthorizationCode === `apple-code-${ACCOUNT_B}`
          ? lateBootstrapB.promise
          : response(
              bootstrapBody(ACCOUNT_A, {
                access: 'access-a1',
                refresh: 'refresh-a1',
              }),
            ),
      '/v1/auth/refresh': () => lateA.promise,
    });
    await useAuthStore.getState().signInWithApple();
    refreshSessionNow();
    await flush();

    nativeModules.PickleAuth!.signInWithApple.mockResolvedValue(
      appleIdentity(ACCOUNT_B),
    );
    const signInB = useAuthStore.getState().signInWithApple();
    await flush();
    // B's bootstrap is pending: the store still shows A, but A's runtime is
    // already torn down. A's rotation must not resurrect a bearer for A.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(ACCOUNT_A);
    expect(getApiSession()).toBeNull();
    lateA.resolve(
      response(refreshBody({ access: 'access-a2', refresh: 'refresh-a2' })),
    );
    await flush(16);
    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(ACCOUNT_A)).toBeNull();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-a1' });

    lateBootstrapB.resolve(
      response(
        bootstrapBody(ACCOUNT_B, {
          access: 'access-b1',
          refresh: 'refresh-b1',
        }),
      ),
    );
    await signInB;
    expectBUntouched();
  });

  it('a stale 401 for A’s old bearer after the switch is ignored (no refresh, no sign-out)', async () => {
    const { lateA, fetchMock } = await signInAsAWithRefreshInFlight();
    await signInAsB();
    lateA.resolve(
      response(refreshBody({ access: 'access-a2', refresh: 'refresh-a2' })),
    );
    await flush(16);
    fetchMock.mockClear();

    reportApiUnauthorized('access-a1');
    reportApiUnauthorized('access-a2');
    await flush(16);

    expect(fetchMock).not.toHaveBeenCalled();
    expectBUntouched();
  });

  it('launch restore of A in flight, user signs in as B during the 8 s wait: A’s late refresh is dropped and hydrate still settles', async () => {
    jest.useFakeTimers();
    seedVault('refresh-a1', ACCOUNT_A);
    const lateA = deferred<Response>();
    const refreshTokensSeen: unknown[] = [];
    installRoutes({
      '/v1/auth/refresh': init => {
        const { refreshToken } = requestBody(init);
        refreshTokensSeen.push(refreshToken);
        return refreshToken === 'refresh-a1'
          ? lateA.promise
          : response(
              refreshBody({ access: 'access-b2', refresh: 'refresh-b2' }),
            );
      },
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(ACCOUNT_B, {
            access: 'access-b1',
            refresh: 'refresh-b1',
          }),
        ),
    });
    const hydrate = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(ACCOUNT_A);
    expect(useAuthStore.getState().hydrated).toBe(false);

    nativeModules.PickleAuth!.signInWithApple.mockResolvedValue(
      appleIdentity(ACCOUNT_B),
    );
    await useAuthStore.getState().signInWithApple();
    lateA.resolve(
      response(refreshBody({ access: 'access-a2', refresh: 'refresh-a2' })),
    );
    await jest.advanceTimersByTimeAsync(0);
    expectBUntouched();

    await jest.advanceTimersByTimeAsync(8_000);
    await hydrate;
    expect(useAuthStore.getState().hydrated).toBe(true);
    expectBUntouched();
    // The only keeper left is B's: an hour later exactly one more refresh
    // goes out, with B's token, and A's token is never re-sent.
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(refreshTokensSeen).toEqual(['refresh-a1', 'refresh-b1']);
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-b2',
      canonicalAppUserId: ACCOUNT_B,
    });
    expect(vaultRecord()).toMatchObject({
      canonicalAppUserId: ACCOUNT_B,
      refreshToken: 'refresh-b2',
    });
  });
});

// ─── S4 · malformed expiresAt values that ARE rejected ───────────────────────

describe('S4 · /v1/auth/refresh with expiresAt NaN / "123" (malformed → retryable, still signed in)', () => {
  it.each([
    ['NaN', Number.NaN],
    ['"123" (string)', '123'],
    ['null', null],
    ['true', true],
    ['{}', {}],
    ['"1788552335" (numeric string)', '1788552335'],
  ])(
    'refreshApiSession rejects expiresAt %s as RETRYABLE',
    async (_label, expiresAt) => {
      const fetchFn = jest.fn(async () =>
        response(refreshBody({ access: 'a', refresh: 'r' }, expiresAt)),
      );
      await expect(
        refreshApiSession({ apiBaseUrl: API, refreshToken: 'r0' }, { fetchFn }),
      ).rejects.toMatchObject({ name: 'SessionRefreshError', retryable: true });
    },
  );

  it('refreshApiSession rejects a session with NO expiresAt key as RETRYABLE', async () => {
    const fetchFn = jest.fn(async () =>
      response({ session: { accessToken: 'a', refreshToken: 'r' } }),
    );
    await expect(
      refreshApiSession({ apiBaseUrl: API, refreshToken: 'r0' }, { fetchFn }),
    ).rejects.toMatchObject({ name: 'SessionRefreshError', retryable: true });
  });

  it.each([
    ['NaN', Number.NaN],
    ['"123"', '123'],
  ])(
    'hydrate() with a rotation whose expiresAt is %s stays signed in, keeps the vault token, installs no bearer, retries 5 s later',
    async (_label, expiresAt) => {
      jest.useFakeTimers();
      seedVault('refresh-1');
      let calls = 0;
      installRoutes({
        '/v1/auth/refresh': () => {
          calls += 1;
          return response(
            refreshBody(
              { access: `access-${calls}`, refresh: `refresh-${calls + 1}` },
              expiresAt,
            ),
          );
        },
      });

      const hydrate = useAuthStore.getState().hydrate();
      await jest.advanceTimersByTimeAsync(0);
      await hydrate;

      expect(useAuthStore.getState().hydrated).toBe(true);
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        ACCOUNT_A,
      );
      expect(getApiSession()).toBeNull();
      expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
      expect(calls).toBe(1);

      await jest.advanceTimersByTimeAsync(4_999);
      expect(calls).toBe(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      // The spent token is re-sent (nothing valid replaced it).
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        ACCOUNT_A,
      );
      expect(durableMaterial()).not.toContain('access-');
    },
  );
});

// ─── S5 · appStore.hydrate() with malformed canonical profile bodies ─────────

describe('S5 · GET canonical profile answers {} / non-object for a signed-in account', () => {
  const localProfile: Profile = {
    firstName: 'Dana',
    gender: 'female',
    skillLevel: '3.5',
    handedness: 'right',
    goal: 'drops',
    biggestProblem: 'control',
    focusCheckpoint: 'paddle_set',
  };

  function signedInAsA() {
    setActiveDataOwner(ACCOUNT_A);
    establishApiSession({
      apiBaseUrl: API,
      bearerToken: 'access-a1',
      canonicalAppUserId: ACCOUNT_A,
      provider: 'apple',
      refreshToken: 'refresh-a1',
      bearerExpiresAtMs: Date.now() + HOUR_S * 1000,
    });
  }

  const malformedBodies: Array<[string, unknown]> = [
    ['{}', {}],
    ['"a string"', 'a string'],
    ['null', null],
    ['42', 42],
    ['[] (array)', []],
    ['true', true],
    [
      '{ onboardingState: "complete" } without profile',
      { onboardingState: 'complete' },
    ],
    [
      '{ onboardingState: "complete", profile: "x" }',
      { onboardingState: 'complete', profile: 'x' },
    ],
    [
      '{ onboardingState: "complete", profile: {} }',
      { onboardingState: 'complete', profile: {} },
    ],
  ];

  it.each(malformedBodies)(
    'with a LOCAL profile: body %s is never even fetched; the local profile is kept and nothing throws',
    async (_label, body) => {
      signedInAsA();
      mockKv.set(profileKeyForOwner(ACCOUNT_A), JSON.stringify(localProfile));
      const fetchMock = installRoutes({
        '/v1/me': () => response(body),
        '/v1/me/onboarding': () => response(body),
      });

      await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();

      const state = useAppStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.hydrateError).toBeNull();
      expect(state.ownerKey).toBe(ACCOUNT_A);
      expect(state.profile).toEqual(localProfile);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockKv.get(profileKeyForOwner(ACCOUNT_A))).toBe(
        JSON.stringify(localProfile),
      );
    },
  );

  it.each(malformedBodies)(
    'with NO local profile: body %s hydrates to profile=null (questionnaire), no error, no throw, no kv write',
    async (_label, body) => {
      signedInAsA();
      const urls: string[] = [];
      installRoutes({
        '/v1/me': (_init, url) => {
          urls.push(url);
          return response(body);
        },
      });

      await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();

      const state = useAppStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.hydrateError).toBeNull();
      expect(state.profile).toBeNull();
      // The canonical profile is read from GET /v1/me (there is no GET
      // /v1/me/onboarding on the client; PUT /v1/me/onboarding is the save).
      expect(urls).toEqual([`${API}/v1/me`]);
      expect(mockKv.has(profileKeyForOwner(ACCOUNT_A))).toBe(false);
    },
  );

  it('a body whose json() REJECTS (invalid JSON) with a 200 hydrates to null without throwing', async () => {
    signedInAsA();
    installRoutes({
      '/v1/me': () =>
        ({
          ok: true,
          status: 200,
          json: jest.fn().mockRejectedValue(new SyntaxError('bad json')),
        }) as unknown as Response,
    });
    await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      hydrateError: null,
      profile: null,
    });
  });

  it('a 5xx / network failure keeps the LOCAL profile out of reach only when there is none: local profile present → served, absent → retry state (never a throw)', async () => {
    signedInAsA();
    mockKv.set(profileKeyForOwner(ACCOUNT_A), JSON.stringify(localProfile));
    installRoutes({
      '/v1/me': () => response({ error: { message: 'down' } }, 503),
    });
    await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();
    expect(useAppStore.getState().profile).toEqual(localProfile);
    expect(useAppStore.getState().hydrateError).toBeNull();

    mockKv.delete(profileKeyForOwner(ACCOUNT_A));
    useAppStore.setState({
      hydrated: false,
      profile: null,
      hydrateError: null,
    });
    await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();
    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: null,
    });
    expect(useAppStore.getState().hydrateError).toEqual(expect.any(String));
  });

  it('a malformed body that lands after the owner switched to B never writes B’s profile slot', async () => {
    signedInAsA();
    const late = deferred<Response>();
    installRoutes({ '/v1/me': () => late.promise });
    const hydrate = useAppStore.getState().hydrate();
    await flush();
    setActiveDataOwner(ACCOUNT_B);
    late.resolve(response({}));
    await hydrate;
    expect(mockKv.has(profileKeyForOwner(ACCOUNT_A))).toBe(false);
    expect(mockKv.has(profileKeyForOwner(ACCOUNT_B))).toBe(false);
    // The stale hydrate did not flip the store for owner B either.
    expect(useAppStore.getState().ownerKey).toBe(ACCOUNT_A);
    expect(useAppStore.getState().hydrated).toBe(false);
  });
});

// ─── S6 · foreground refresh lead ────────────────────────────────────────────

describe('S6 · AppState "active" with 4 min of bearer left → one refresh; with 10 min left → none', () => {
  function keeper(bearerLeftMs: number | null, fetchFn: jest.Mock) {
    const rotated: RefreshedTokens[] = [];
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-1',
      bearerExpiresAtMs:
        bearerLeftMs === null ? null : Date.now() + bearerLeftMs,
      onRotated: tokens => {
        rotated.push(tokens);
      },
      onRevoked: () => {
        throw new Error('must not revoke');
      },
      fetchFn: fetchFn as unknown as (
        input: string,
        init?: RequestInit,
      ) => Promise<Response>,
    });
    return rotated;
  }

  it('keeper-level: 4 min left → exactly one extra refresh; then 10 min left → none; the scheduled rotation still happens 60 s before expiry', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return response(
        refreshBody(
          { access: `access-${calls}`, refresh: `refresh-${calls + 1}` },
          Date.now() / 1000 + 10 * 60,
        ),
      );
    });
    const rotated = keeper(4 * 60_000, fetchFn);
    expect(calls).toBe(0);

    emitAppState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.bearerToken).toBe('access-1');

    // New bearer has 10 min of life. Foreground again: nothing.
    emitAppState('active');
    emitAppState('background');
    emitAppState('inactive');
    emitAppState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // The regular rotation is scheduled at 10 min − 60 s = 9 min.
    await jest.advanceTimersByTimeAsync(9 * 60_000 - 1);
    expect(calls).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    expect(sentRefreshTokens(fetchFn)).toEqual(['refresh-1', 'refresh-2']);
  });

  it('boundary: exactly 5 min left does NOT refresh on foreground, 5 min − 1 ms does', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return response(refreshBody({ access: 'a', refresh: 'r' }));
    });
    keeper(5 * 60_000, fetchFn);
    emitAppState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toBe(0);

    await jest.advanceTimersByTimeAsync(1);
    emitAppState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
  });

  it('rapid foreground churn (10 × active) while the refresh is in flight is coalesced into ONE request; a non-"active" state never refreshes', async () => {
    jest.useFakeTimers();
    const held = deferred<Response>();
    const fetchFn = jest.fn(async () => held.promise);
    keeper(4 * 60_000, fetchFn);
    for (let i = 0; i < 10; i += 1) {
      emitAppState('active');
    }
    emitAppState('background');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    held.resolve(response(refreshBody({ access: 'a', refresh: 'r' })));
    await jest.advanceTimersByTimeAsync(0);
    emitAppState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('store-level: a persisted session restored with a 4-min bearer refreshes once more on foreground and the vault follows the rotation', async () => {
    jest.useFakeTimers();
    seedVault('refresh-1');
    let calls = 0;
    installRoutes({
      '/v1/auth/refresh': () => {
        calls += 1;
        return response(
          refreshBody(
            { access: `access-${calls}`, refresh: `refresh-${calls + 1}` },
            nowSeconds() + (calls === 1 ? 4 * 60 : HOUR_S),
          ),
        );
      },
    });
    const hydrate = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    await hydrate;
    expect(calls).toBe(1);
    expect(getApiSession()?.bearerToken).toBe('access-1');

    emitAppState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(getApiSession()?.bearerToken).toBe('access-2');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-3' });

    emitAppState('active');
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toBe(2);
  });

  it('a STOPPED keeper ignores foreground (listener removed) — sign-out then active → zero requests', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn(async () =>
      response(refreshBody({ access: 'a', refresh: 'r' })),
    );
    keeper(4 * 60_000, fetchFn);
    stopSessionKeeper();
    emitAppState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).not.toHaveBeenCalled();
    const subscription = (AppState.addEventListener as jest.Mock).mock
      .results[0]?.value as { remove: jest.Mock };
    expect(subscription.remove).toHaveBeenCalledTimes(1);
  });
});

// ─── S7 · backoff 503 ×5 then 200 ────────────────────────────────────────────

describe('S7 · 503 five times then 200: delays 5/10/20/40/80 s and failedAttempts resets after success', () => {
  it('keeper-level timeline', async () => {
    jest.useFakeTimers();
    const t0 = Date.now();
    const attempts: number[] = [];
    const deferredCount: number[] = [];
    let failures = 5;
    let postSuccessFail = 0;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      attempts.push(Date.now() - t0);
      calls += 1;
      if (failures > 0) {
        failures -= 1;
        return response({ error: { message: 'unavailable' } }, 503);
      }
      if (postSuccessFail > 0) {
        postSuccessFail -= 1;
        return response({ error: { message: 'unavailable' } }, 503);
      }
      // A short-lived bearer so the next scheduled rotation is 2 s away.
      return response(
        refreshBody(
          { access: `access-${calls}`, refresh: `refresh-${calls}` },
          Date.now() / 1000 + 62,
        ),
      );
    });
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: () => {},
      onRevoked: () => {
        throw new Error('503 must never revoke');
      },
      onDeferred: () => deferredCount.push(Date.now() - t0),
      fetchFn: fetchFn as unknown as (
        input: string,
        init?: RequestInit,
      ) => Promise<Response>,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual([0]);

    for (const expected of [5_000, 15_000, 35_000, 75_000, 155_000]) {
      await jest.advanceTimersByTimeAsync(expected - (Date.now() - t0) - 1);
      expect(attempts[attempts.length - 1]).toBeLessThan(expected);
      await jest.advanceTimersByTimeAsync(1);
      expect(attempts[attempts.length - 1]).toBe(expected);
    }
    // attempts 0..5: 0, 5s, 15s, 35s, 75s, 155s → deltas 5,10,20,40,80.
    expect(attempts.slice(1).map((t, i) => t - attempts[i]!)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000,
    ]);
    expect(deferredCount).toHaveLength(5);
    // The 6th call (at 155 s) succeeded: the next rotation is 62 s − 60 s
    // lead = 2 s later, not another backoff step.
    postSuccessFail = 1;
    await jest.advanceTimersByTimeAsync(2_000);
    expect(attempts).toHaveLength(7);
    expect(attempts[6]! - attempts[5]!).toBe(2_000);
    // That one failed → failedAttempts restarted at 1 → 5 s, not 160 s.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(attempts).toHaveLength(8);
    expect(attempts[7]! - attempts[6]!).toBe(5_000);
    expect(deferredCount).toHaveLength(6);
    // The refresh token re-sent after every failure is the last GOOD one.
    const sent = sentRefreshTokens(fetchFn);
    expect(sent.slice(0, 6)).toEqual(Array(6).fill('refresh-0'));
    expect(sent[6]).toBe('refresh-6');
    expect(sent[7]).toBe('refresh-6');
  });

  it('retryDelayMs caps at 5 min and never overflows to Infinity/NaN for absurd attempt counts', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
    expect(retryDelayMs(0)).toBe(5_000);
    expect(retryDelayMs(-5)).toBe(5_000);
    expect(retryDelayMs(1_100)).toBe(300_000);
    expect(retryDelayMs(Number.MAX_SAFE_INTEGER)).toBe(300_000);
  });

  it('store-level: a launch that sees 503 ×5 stays signed in, installs the bearer at 155 s and re-persists the rotated token', async () => {
    jest.useFakeTimers();
    seedVault('refresh-0');
    let calls = 0;
    installRoutes({
      '/v1/auth/refresh': () => {
        calls += 1;
        return calls <= 5
          ? response({ error: { message: 'unavailable' } }, 503)
          : response(
              refreshBody({ access: 'access-ok', refresh: 'refresh-ok' }),
            );
      },
    });
    const hydrate = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    await hydrate; // 'offline' after the first 503
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(ACCOUNT_A);
    expect(getApiSession()).toBeNull();

    await jest.advanceTimersByTimeAsync(154_999);
    expect(calls).toBe(5);
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-0' });
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toBe(6);
    expect(getApiSession()?.bearerToken).toBe('access-ok');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-ok' });
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(ACCOUNT_A);
  });
});

// ─── S8 · non-HTTPS apiBaseUrl at launch ─────────────────────────────────────

describe('S8 · apiBaseUrl "http://api.example.com" + a vault record → hydrate() is offline: signed in, no request', () => {
  it.each([
    'http://api.example.com',
    'http://api.example.com/',
    '   ',
    'not a url',
    'ftp://api.example.com',
  ])('apiBaseUrl %p', async apiBaseUrl => {
    jest.useFakeTimers();
    mockApiBaseUrl = apiBaseUrl;
    seedVault('refresh-1');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'never', refresh: 'never' })),
    });

    const hydrate = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    await hydrate;

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toMatchObject({
      provider: 'apple',
      canonicalAppUserId: ACCOUNT_A,
      localOnly: false,
    });
    expect(getActiveDataOwner()).toBe(ACCOUNT_A);
    expect(getApiSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
    // No keeper: no timer, no AppState listener; foreground and 401s are no-ops.
    expect(jest.getTimerCount()).toBe(0);
    expect(AppState.addEventListener).not.toHaveBeenCalled();
    refreshSessionNow();
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(durableMaterial()).not.toContain('never');
  });

  it('localhost over http is the ONLY plain-http exception and does refresh', async () => {
    mockApiBaseUrl = 'http://localhost:54321/functions/v1/api/';
    seedVault('refresh-1');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:54321/functions/v1/api/v1/auth/refresh',
      expect.anything(),
    );
    expect(getApiSession()?.bearerToken).toBe('access-2');
  });

  it('explicit signOut() from the offline-restored state clears the vault locally and sends nothing (no bearer to revoke with)', async () => {
    mockApiBaseUrl = 'http://api.example.com';
    seedVault('refresh-1');
    const fetchMock = installRoutes({});
    await useAuthStore.getState().hydrate();
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });
});

// ─── S9 · owner captured at call start ───────────────────────────────────────

describe('S9 · repositoryAccountScope: setActiveDataOwner A → B mid-write lands under A', () => {
  const analysis: ShotAnalysis = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.8,
    analysisConfidence: 0.91,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'validated-bundle-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'score-1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
  const permitId = '22222222-2222-4222-8222-222222222222';

  /** A db whose every statement switches the active owner before returning
   * — the most hostile interleaving a concurrent sign-in could produce. */
  function switchingDb(switchTo: () => void) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: LocalDb = {
      async execute(sql, params = []) {
        calls.push({ sql, params });
        switchTo();
        await Promise.resolve();
        return { rows: [] };
      },
      close() {},
    };
    return { db, calls };
  }

  function ownerParams(calls: Array<{ sql: string; params: unknown[] }>) {
    return calls
      .filter(call => call.params.length > 0)
      .map(call => ({
        sql: call.sql.trim().split(/\s+/).slice(0, 4).join(' '),
        owner: call.params[0],
      }));
  }

  it('saveAnalysis: owner flips to B after the FIRST statement — both rows and the outbox entry stay under A', async () => {
    setActiveDataOwner(ACCOUNT_A);
    const { db, calls } = switchingDb(() => setActiveDataOwner(ACCOUNT_B));
    await saveAnalysis(db, analysis, permitId);
    expect(
      calls.map(call => call.sql.trim().split(/\s+/).slice(0, 2).join(' ')),
    ).toEqual(['BEGIN IMMEDIATE', 'INSERT OR', 'INSERT INTO', 'COMMIT']);
    expect(ownerParams(calls).map(entry => entry.owner)).toEqual([
      ACCOUNT_A,
      ACCOUNT_A,
    ]);
    expect(getActiveDataOwner()).toBe(ACCOUNT_B);
  });

  it('saveSession / finishSession likewise bind the owner captured at call start (every owner_key param is A, none is B)', async () => {
    setActiveDataOwner(ACCOUNT_A);
    const { db, calls } = switchingDb(() => setActiveDataOwner(ACCOUNT_B));
    await saveSession(db, {
      id: 'ssssssss-1111-4111-8111-111111111111',
      mode: 'guided',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-27T18:00:00.000Z',
    });
    setActiveDataOwner(ACCOUNT_A);
    await finishSession(db, 'ssssssss-1111-4111-8111-111111111111', {
      shots: 0,
    });
    const withParams = calls.filter(call => call.params.length > 0);
    expect(withParams).toHaveLength(4);
    for (const call of withParams) {
      expect(call.params).toContain(ACCOUNT_A);
      expect(call.params).not.toContain(ACCOUNT_B);
    }
  });

  it('owner flips to SIGNED-OUT mid-write: the in-flight transaction still completes under A (atomic), nothing under "signed-out"', async () => {
    setActiveDataOwner(ACCOUNT_A);
    const { db, calls } = switchingDb(() =>
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER),
    );
    await saveAnalysis(db, analysis, permitId);
    expect(ownerParams(calls).map(entry => entry.owner)).toEqual([
      ACCOUNT_A,
      ACCOUNT_A,
    ]);
    // …and the NEXT write is refused.
    await expect(saveAnalysis(db, analysis, permitId)).rejects.toThrow(
      'Sign in or continue locally',
    );
  });

  it('rapid A→B→A→B flips across 50 interleaved writes: every write lands under the owner current at ITS call start', async () => {
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const writes: Array<{
      expected: string;
      calls: Array<{ sql: string; params: unknown[] }>;
    }> = [];
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 50; i += 1) {
      const owner = rand() < 0.5 ? ACCOUNT_A : ACCOUNT_B;
      setActiveDataOwner(owner);
      const { db, calls } = switchingDb(() =>
        setActiveDataOwner(rand() < 0.5 ? ACCOUNT_A : ACCOUNT_B),
      );
      writes.push({ expected: owner, calls });
      pending.push(
        saveAnalysis(
          db,
          {
            ...analysis,
            id: `${i}`.padStart(8, '0') + '-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          },
          permitId,
        ),
      );
    }
    await Promise.all(pending);
    for (const write of writes) {
      expect(ownerParams(write.calls).map(entry => entry.owner)).toEqual([
        write.expected,
        write.expected,
      ]);
    }
  });

  it('setActiveDataOwner normalises case and rejects garbage/unicode/huge owners without changing the current one', () => {
    setActiveDataOwner(ACCOUNT_A.toUpperCase());
    expect(getActiveDataOwner()).toBe(ACCOUNT_A);
    for (const bad of [
      '',
      ' ' + ACCOUNT_B,
      ACCOUNT_B + '\n',
      'device-guest ',
      'signed-out\u0000',
      'ｄｅｖｉｃｅ-guest',
      'b'.repeat(100_000),
      '../../signed-out',
      '00000000-0000-0000-0000-000000000000', // version nibble 0 is not a valid UUID here
    ]) {
      expect(() => setActiveDataOwner(bad)).toThrow(
        'Invalid local data owner.',
      );
      expect(getActiveDataOwner()).toBe(ACCOUNT_A);
    }
  });

  it('appStore.hydrate(): owner flips A → B while the local read is pending → nothing is committed for B and the store keeps A’s frame', async () => {
    setActiveDataOwner(ACCOUNT_A);
    await setKv(
      mockCurrentDb(),
      profileKeyForOwner(ACCOUNT_A),
      JSON.stringify({
        skillLevel: '3.5',
        handedness: 'right',
        goal: 'drops',
        biggestProblem: 'control',
        focusCheckpoint: 'paddle_set',
      }),
    );
    const hydrate = useAppStore.getState().hydrate();
    setActiveDataOwner(ACCOUNT_B);
    await hydrate;
    expect(useAppStore.getState().ownerKey).toBe(ACCOUNT_A);
    expect(mockKv.has(profileKeyForOwner(ACCOUNT_B))).toBe(false);
  });
});

// ─── extra · sign-in / sign-out interleavings not covered above ──────────────

describe('extra · interleavings and cancellation', () => {
  it('double-tap sign-in (two concurrent signInWithApple) performs ONE bootstrap and one vault write', async () => {
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(ACCOUNT_A, {
            access: 'access-a1',
            refresh: 'refresh-a1',
          }),
        ),
    });
    await Promise.all([
      useAuthStore.getState().signInWithApple(),
      useAuthStore.getState().signInWithApple(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(nativeModules.PickleAuth!.signInWithApple).toHaveBeenCalledTimes(1);
    expect(getApiSession()?.bearerToken).toBe('access-a1');
  });

  it('signOut() racing a scheduled rotation: the rotation that lands after sign-out is dropped and the logout used the bearer that was live at sign-out', async () => {
    jest.useFakeTimers();
    const lateRefresh = deferred<Response>();
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(
            ACCOUNT_A,
            { access: 'access-a1', refresh: 'refresh-a1' },
            nowSeconds() + 61,
          ),
        ),
      '/v1/auth/refresh': () => lateRefresh.promise,
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    await jest.advanceTimersByTimeAsync(1_000); // 61 s − 60 s lead → 1 s min
    expect(
      fetchMock.mock.calls.filter(call =>
        String(call[0]).endsWith('/v1/auth/refresh'),
      ),
    ).toHaveLength(1);

    await useAuthStore.getState().signOut();
    lateRefresh.resolve(
      response(refreshBody({ access: 'access-a2', refresh: 'refresh-a2' })),
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(durableMaterial()).not.toContain('refresh-a2');
    const logout = fetchMock.mock.calls.find(call =>
      String(call[0]).endsWith('/v1/auth/logout'),
    );
    expect((logout?.[1] as RequestInit | undefined)?.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer access-a1' }),
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('SessionRefreshError classification: 429 / 500 / 502 / 504 / 200-with-empty-body / thrown fetch are retryable; 401 and 403 are not', async () => {
    const cases: Array<[number | 'throw', boolean]> = [
      [429, true],
      [500, true],
      [502, true],
      [504, true],
      [200, true],
      ['throw', true],
      [401, false],
      [403, false],
    ];
    for (const [status, retryable] of cases) {
      const fetchFn = jest.fn(async () => {
        if (status === 'throw') throw new TypeError('Network request failed');
        return response(
          status === 200 ? {} : { error: { message: 'x' } },
          status,
        );
      });
      let caught: unknown;
      try {
        await refreshApiSession(
          { apiBaseUrl: API, refreshToken: 'r' },
          { fetchFn },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionRefreshError);
      expect((caught as SessionRefreshError).retryable).toBe(retryable);
    }
  });
});
