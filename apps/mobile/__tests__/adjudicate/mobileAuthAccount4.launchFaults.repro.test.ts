/**
 * Adjudication reproduction (stress area mobile-auth-account-4).
 *
 * Direct, harness-free replays of the failure-injection matrix rows that
 * were adjudicated as real (SR-1, SR-2, SR-3, SR-5, SR-7). Each case drives
 * the stores exactly as App.tsx's Gate does (authStore.hydrate → desired
 * owner → appStore.hydrate) and asserts the store state the Gate renders
 * from:
 *   session && hydrated && appHydrated && profile === null && hydrateError === null
 *     → Gate renders <OnboardingScreen /> (questionnaire) to a signed-in account
 *   hydrated === false forever → Gate renders LoadingState forever.
 *
 * These tests document the CURRENT (defective) behaviour; a fix must invert
 * the marked assertions.
 */
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

// ─── Fault-injectable Keychain ───────────────────────────────────────────────
type KeychainMode = 'ok' | 'throw' | 'hang';
const mockKeychain: {
  mode: KeychainMode;
  store: Map<string, { username: string; password: string }>;
} = { mode: 'ok', store: new Map() };
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AfterFirstUnlockThisDeviceOnly',
  },
  setGenericPassword: async (
    username: string,
    password: string,
    options: { service: string },
  ) => {
    mockKeychain.store.set(options.service, { username, password });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: (options: { service: string }) => {
    if (mockKeychain.mode === 'hang') return new Promise(() => {});
    if (mockKeychain.mode === 'throw') {
      // errSecInteractionNotAllowed-style failure surfaced by the native module.
      return Promise.reject(new Error('The user interaction is not allowed.'));
    }
    const item = mockKeychain.store.get(options.service);
    return Promise.resolve(
      item ? { service: options.service, storage: 'mock', ...item } : false,
    );
  },
  resetGenericPassword: async (options: { service: string }) =>
    mockKeychain.store.delete(options.service),
}));

// ─── Fault-injectable SQLite kv ──────────────────────────────────────────────
type SqliteMode = 'ok' | 'hang';
const mockSqlite: { mode: SqliteMode; kv: Map<string, string> } = {
  mode: 'ok',
  kv: new Map(),
};
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      if (mockSqlite.mode === 'hang') return new Promise(() => {});
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockSqlite.kv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockSqlite.kv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(),
    signIn: jest.fn(),
    signInSilently: jest.fn(),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
  },
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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const owner = canonicalDataOwner(canonicalId);
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function seedVault() {
  mockKeychain.store.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      refreshToken: 'refresh-1',
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

const realFetch = globalThis.fetch;
const serverCalls: string[] = [];
function installRoutes(
  routes: Record<string, () => Response | Promise<Response>>,
) {
  globalThis.fetch = jest.fn(async (url: string) => {
    const path = url.replace('https://api.example.test', '');
    serverCalls.push(path);
    const handler = routes[path];
    if (!handler) throw new TypeError('Network request failed');
    return handler();
  }) as unknown as typeof fetch;
}

/** What App.tsx's Gate does once authHydrated flips true. */
async function hydrateAppLikeGate(): Promise<void> {
  const auth = useAuthStore.getState();
  expect(auth.hydrated).toBe(true);
  const desiredOwner = auth.session?.canonicalAppUserId
    ? canonicalDataOwner(auth.session.canonicalAppUserId)
    : SIGNED_OUT_DATA_OWNER;
  expect(getActiveDataOwner()).toBe(desiredOwner);
  await useAppStore.getState().hydrate();
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask'],
  });
  mockKeychain.mode = 'ok';
  mockKeychain.store.clear();
  mockSqlite.mode = 'ok';
  mockSqlite.kv.clear();
  serverCalls.length = 0;
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    localDataError: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
  installRoutes({});
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

describe('adjudication: SR-7 — signed-in launch without a bearer and no local profile', () => {
  it.each([
    ['refresh 500', () => response({}, 500)],
    ['refresh 429', () => response({}, 429)],
    ['refresh malformed 200', () => response({ nope: true })],
  ])(
    '%s: after the 8s launch wait the Gate state selects the onboarding questionnaire',
    async (_label, refresh) => {
      seedVault();
      installRoutes({ '/v1/auth/refresh': refresh });

      const hydrate = useAuthStore.getState().hydrate();
      await jest.advanceTimersByTimeAsync(8_000);
      await hydrate;

      const auth = useAuthStore.getState();
      expect(auth.hydrated).toBe(true);
      expect(auth.session?.canonicalAppUserId).toBe(canonicalId);
      expect(getApiSession()).toBeNull();

      await hydrateAppLikeGate();

      // DEFECT: profile unknown (no bearer to ask the server), yet the store
      // lands as "no profile, no error" — exactly the questionnaire branch.
      const app = useAppStore.getState();
      expect(app).toMatchObject({
        hydrated: true,
        ownerKey: owner,
        profile: null,
        hydrateError: null,
      });
      expect(serverCalls.filter(p => p === '/v1/me')).toHaveLength(0);
    },
  );

  it('refresh that never answers: same questionnaire routing after the 8s deadline', async () => {
    seedVault();
    installRoutes({ '/v1/auth/refresh': () => new Promise(() => {}) });

    const hydrate = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrate;
    await hydrateAppLikeGate();

    expect(useAppStore.getState()).toMatchObject({
      hydrated: true,
      profile: null,
      hydrateError: null,
    });
  });
});

describe('adjudication: SR-5 — malformed / partial 200 from GET /v1/me', () => {
  it.each([
    ['malformed body', () => response({})],
    [
      'onboardingState complete but profile missing fields',
      () =>
        response({
          onboardingState: 'complete',
          profile: { skill_level: 'intermediate' },
        }),
    ],
    [
      'unparseable JSON',
      () =>
        ({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected end')),
        }) as unknown as Response,
    ],
  ])(
    '%s is treated as "no profile" and selects the questionnaire',
    async (_label, me) => {
      seedVault();
      installRoutes({
        '/v1/auth/refresh': () =>
          response({
            session: {
              accessToken: 'access-2',
              refreshToken: 'refresh-2',
              expiresAt: FAR_FUTURE_SECONDS,
            },
          }),
        '/v1/me': me,
      });

      await useAuthStore.getState().hydrate();
      expect(getApiSession()?.bearerToken).toBe('access-2');
      await hydrateAppLikeGate();

      expect(serverCalls).toContain('/v1/me');
      // DEFECT: an unusable server answer is indistinguishable from "user has
      // no profile"; the retryable hydrateError path is never taken.
      expect(useAppStore.getState()).toMatchObject({
        hydrated: true,
        ownerKey: owner,
        profile: null,
        hydrateError: null,
      });
    },
  );
});

describe('adjudication: SR-1 — Keychain read error at launch', () => {
  it('a rejected read lands the launch signed out with no error state while the vault record survives', async () => {
    seedVault();
    mockKeychain.mode = 'throw';

    await useAuthStore.getState().hydrate();

    const auth = useAuthStore.getState();
    // DEFECT: the signed-in device shows Welcome for this launch, with no
    // message and no retry; nothing in state distinguishes it from a device
    // that never signed in.
    expect(auth.hydrated).toBe(true);
    expect(auth.session).toBeNull();
    expect(auth.error).toBeNull();
    expect(auth.localDataError).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(mockKeychain.store.has(SESSION_VAULT_SERVICE)).toBe(true);
    expect(serverCalls).toEqual([]);
  });
});

describe('adjudication: SR-2 / SR-3 — launch-path awaits without a deadline', () => {
  it('SR-2: a Keychain read that never settles keeps hydrated=false past 60s (LoadingState forever)', async () => {
    seedVault();
    mockKeychain.mode = 'hang';
    let settled = false;
    void useAuthStore
      .getState()
      .hydrate()
      .then(() => {
        settled = true;
      });

    await jest.advanceTimersByTimeAsync(60_000);

    // DEFECT: no deadline, no fallback to SQLite local mode, no control.
    expect(settled).toBe(false);
    expect(useAuthStore.getState().hydrated).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
  });

  it('SR-3: a SQLite kv read that never settles keeps hydrated=false past 60s even with a valid vault session', async () => {
    seedVault();
    mockSqlite.mode = 'hang';
    installRoutes({
      '/v1/auth/refresh': () =>
        response({
          session: {
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            expiresAt: FAR_FUTURE_SECONDS,
          },
        }),
    });
    let settled = false;
    void useAuthStore
      .getState()
      .hydrate()
      .then(() => {
        settled = true;
      });

    await jest.advanceTimersByTimeAsync(60_000);

    // DEFECT: the vault record was read successfully, yet the sign-in
    // decision waits on SQLite (getKv legacy-session / local-mode) forever.
    expect(settled).toBe(false);
    expect(useAuthStore.getState().hydrated).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    expect(serverCalls).toEqual([]);
  });
});
