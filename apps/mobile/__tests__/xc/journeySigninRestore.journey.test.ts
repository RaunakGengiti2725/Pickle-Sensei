/**
 * xc `journey-signin-restore` — the whole durable sign-in journey, driven
 * end to end against a STATEFUL fake session server (real rotation +
 * scope=local revocation semantics) with mocked provider SDKs:
 *
 *   Apple/Google sign-in → bootstrap → vault persist → kill/relaunch
 *   (jest.resetModules: every in-memory store, keeper timer and module-level
 *   variable dies; only the Keychain + SQLite kv survive) → restored
 *   signed-in within the 8 s launch budget → refresh rotation → sign-out
 *   (local scope) → other-device semantics.
 *
 * Every test ends with a leak scan over EVERYTHING durable or visible
 * (Keychain items, SQLite kv, console output, the auth UI state): no access
 * token, provider ID token or Apple authorization code may appear anywhere,
 * and the Keychain must hold exactly the CURRENT refresh token and nothing
 * else. Tests named `CHARACTERIZATION:` pin observed behaviour that is
 * reported as a finding rather than asserted as desired.
 *
 * Raw evidence (server call log with redacted tokens, timings, heap) is
 * written to artifacts/xc-journey-signin-restore/journey.json.
 */
// Node globals, typed the way the other __tests__ do (RN tsconfig ships no
// node types). `require` is what lets each scenario load a FRESH app process
// after jest.resetModules() — i.e. "kill and relaunch".
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
import type { LocalDb } from '../../src/data/db';
import {
  ACCESS_PREFIX,
  APPLE_CODE_PREFIX,
  FakeAuthServer,
  ID_TOKEN_PREFIX,
  Prng,
  REFRESH_PREFIX,
  captureConsole,
  findSecrets,
  heapNumbers,
  jsonResponse,
  safeStringify,
  secretsOfKind,
  writeArtifact,
  type ConsoleCapture,
} from '../../test-support/xc/journeySigninRestore.support';

// ─── Module seams (declared here so jest hoists them for this file) ──────────

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

const API_BASE_URL = 'https://api.example.test';
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

// ─── The app process: every module the journey touches, loaded fresh ─────────

type KeychainItem = { username: string; password: string; accessible?: string };

interface AppProcess {
  auth: typeof import('../../src/auth/authStore');
  api: typeof import('../../src/account/apiSession');
  vault: typeof import('../../src/account/sessionVault');
  keeper: typeof import('../../src/account/sessionKeeper');
  scope: typeof import('../../src/data/accountScope');
  sync: typeof import('../../src/data/syncRuntime');
  rn: typeof import('react-native');
  keychain: Map<string, KeychainItem>;
  appleSignIn: jest.Mock;
}

function loadApp(): AppProcess {
  const rn = require('react-native') as typeof import('react-native');
  const keychainModule = require('react-native-keychain') as {
    __keychainStore: Map<string, KeychainItem>;
  };
  const appleSignIn = jest.fn();
  (rn.NativeModules as { PickleAuth?: unknown }).PickleAuth = {
    signInWithApple: appleSignIn,
  };
  return {
    auth: require('../../src/auth/authStore') as AppProcess['auth'],
    api: require('../../src/account/apiSession') as AppProcess['api'],
    vault: require('../../src/account/sessionVault') as AppProcess['vault'],
    keeper: require('../../src/account/sessionKeeper') as AppProcess['keeper'],
    scope: require('../../src/data/accountScope') as AppProcess['scope'],
    sync: require('../../src/data/syncRuntime') as AppProcess['sync'],
    rn,
    keychain: keychainModule.__keychainStore,
    appleSignIn,
  };
}

/** Process death: every in-memory store, timer and module variable is gone;
 * the Keychain and SQLite kv are what the next launch finds. */
function killAndRelaunch(app: AppProcess): AppProcess {
  const keychainSnapshot = [...app.keychain.entries()].map(
    ([service, item]) => [service, { ...item }] as const,
  );
  app.keeper.stopSessionKeeper();
  app.sync.clearSyncRuntime();
  delete (app.rn.NativeModules as { PickleAuth?: unknown }).PickleAuth;
  jest.resetModules();
  const next = loadApp();
  next.keychain.clear();
  for (const [service, item] of keychainSnapshot) {
    next.keychain.set(service, item);
  }
  return next;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const USER_B = '2b1f6d0e-5c3a-4f7b-9e8d-1a2b3c4d5e6f';
const SESSION_VAULT_SERVICE = 'com.picklesensei.auth.session';

interface Journey {
  server: FakeAuthServer;
  restoreFetch: () => void;
  console: ConsoleCapture;
  app: AppProcess;
  seed: number;
  log: Array<Record<string, unknown>>;
}

let journey: Journey;
const evidence: Array<Record<string, unknown>> = [];
const SEED = Number(process.env['XC_JOURNEY_SEED'] ?? 20260904);

function startJourney(seed = SEED): Journey {
  const server = new FakeAuthServer({
    prng: new Prng(seed),
    baseUrl: API_BASE_URL,
  });
  server.registerAccount('subA', USER_A, 'pat@example.com');
  server.registerAccount('subB', USER_B, 'sam@example.com');
  const restoreFetch = server.install();
  const app = loadApp();
  app.keychain.clear();
  return {
    server,
    restoreFetch,
    console: captureConsole(),
    app,
    seed,
    log: [],
  };
}

function armApple(app: AppProcess, server: FakeAuthServer, subject = 'subA') {
  const identityToken = server.issueIdToken('apple', subject);
  const authorizationCode = server.issueAppleAuthorizationCode();
  app.appleSignIn.mockResolvedValue({
    user: 'apple-user-opaque',
    identityToken,
    authorizationCode,
    email: 'pat@privaterelay.example',
    givenName: 'Pat',
    familyName: 'Player',
  });
  return { identityToken, authorizationCode };
}

function armGoogle(server: FakeAuthServer, subject = 'subA') {
  const idToken = server.issueIdToken('google', subject);
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.signIn.mockResolvedValue({
    type: 'success',
    data: {
      user: {
        id: 'google-uid-1',
        name: 'Pat Player',
        email: 'pat@gmail.example',
      },
      idToken,
    },
  });
  return { idToken };
}

function vaultRecord(app: AppProcess): Record<string, unknown> | null {
  const item = app.keychain.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function keychainBlob(app: AppProcess): string {
  return JSON.stringify([...app.keychain.entries()]);
}

/**
 * The no-leak oracle. `currentRefresh` is the ONE refresh token allowed in
 * the Keychain (null ⇒ the Keychain must hold no session material at all).
 */
function assertNoLeak(app: AppProcess, currentRefresh: string | null) {
  const keychain = keychainBlob(app);
  expect(secretsOfKind(keychain, ACCESS_PREFIX)).toEqual([]);
  expect(secretsOfKind(keychain, ID_TOKEN_PREFIX)).toEqual([]);
  expect(secretsOfKind(keychain, APPLE_CODE_PREFIX)).toEqual([]);
  expect(secretsOfKind(keychain, REFRESH_PREFIX)).toEqual(
    currentRefresh ? [currentRefresh] : [],
  );
  expect(findSecrets(JSON.stringify([...mockKv.entries()]))).toEqual([]);
  expect(findSecrets(journey.console.lines.join('\n'))).toEqual([]);
  expect(findSecrets(safeStringify(app.auth.useAuthStore.getState()))).toEqual(
    [],
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  mockKv.clear();
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  journey = startJourney();
});

afterEach(() => {
  const { app } = journey;
  app.keeper.stopSessionKeeper();
  app.sync.clearSyncRuntime();
  app.api.clearApiSession();
  journey.restoreFetch();
  journey.console.restore();
  evidence.push({
    test: expect.getState().currentTestName,
    seed: journey.seed,
    server: journey.server.snapshot(),
    steps: journey.log,
    consoleLines: journey.console.lines.length,
    heap: heapNumbers(),
  });
  jest.useRealTimers();
});

afterAll(() => {
  writeArtifact('journey.json', {
    generatedAt: new Date().toISOString(),
    seed: SEED,
    tests: evidence,
  });
});

// ─── 1. Apple: the whole journey on one device ───────────────────────────────

describe('Apple: sign-in → vault → kill/relaunch → rotation → sign-out', () => {
  it('persists exactly {version, provider, canonical id, refresh token, email, displayName} and nothing else; restores after a kill with ONE refresh; sign-out revokes THIS session and the next launch is signed out with zero network', async () => {
    let { app } = journey;
    const { server } = journey;
    const { identityToken, authorizationCode } = armApple(app, server);

    // ── sign-in
    await app.auth.useAuthStore.getState().signInWithApple();
    const state = app.auth.useAuthStore.getState();
    expect(state.error).toBeNull();
    expect(state.session).toEqual({
      provider: 'apple',
      subject: USER_A,
      canonicalAppUserId: USER_A,
      localOnly: false,
      displayName: 'Pat Player',
      email: 'pat@example.com',
    });
    const serverSession = server.onlyLiveSession(USER_A);
    expect(server.liveSessionsFor(USER_A)).toHaveLength(1);
    expect(app.api.getApiSession()).toEqual({
      apiBaseUrl: API_BASE_URL,
      bearerToken: serverSession.accessToken,
      canonicalAppUserId: USER_A,
      provider: 'apple',
      refreshToken: serverSession.refreshToken,
      bearerExpiresAtMs: serverSession.expiresAt * 1000,
    });
    // Exact durable material.
    expect([...app.keychain.keys()]).toEqual([SESSION_VAULT_SERVICE]);
    const item = app.keychain.get(SESSION_VAULT_SERVICE)!;
    expect(item.username).toBe('session');
    expect(item.accessible).toBe('AccessibleAfterFirstUnlockThisDeviceOnly');
    expect(JSON.parse(item.password)).toEqual({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: USER_A,
      refreshToken: serverSession.refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    });
    expect(Object.keys(JSON.parse(item.password)).sort()).toEqual([
      'canonicalAppUserId',
      'displayName',
      'email',
      'provider',
      'refreshToken',
      'version',
    ]);
    expect(mockKv.get('auth.last-provider') ?? '').toBe('');
    assertNoLeak(app, serverSession.refreshToken);
    // The provider token was spent exactly once, on bootstrap, with the
    // Apple authorization code beside it — and never again.
    const bootstraps = server.calls.filter(c => c.route === 'bootstrap');
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]?.authorization).toBe(`Bearer ${identityToken}`);
    expect(bootstraps[0]?.body).toMatchObject({
      appleAuthorizationCode: authorizationCode,
    });
    expect(
      server.calls.filter(c => c.authorization?.includes(identityToken)),
    ).toHaveLength(1);
    journey.log.push({ step: 'sign-in', calls: server.calls.length });

    // ── kill + relaunch
    const refreshBeforeKill = serverSession.refreshToken;
    app = killAndRelaunch(app);
    journey.app = app;
    expect(app.auth.useAuthStore.getState()).toMatchObject({
      hydrated: false,
      session: null,
    });
    expect(app.api.getApiSession()).toBeNull();
    const callsBefore = server.calls.length;
    const startedAt = Date.now();
    await app.auth.useAuthStore.getState().hydrate();
    const hydrateMs = Date.now() - startedAt;
    journey.log.push({ step: 'relaunch-hydrate', hydrateMs });
    expect(hydrateMs).toBeLessThan(8_000);
    const restored = app.auth.useAuthStore.getState();
    expect(restored.hydrated).toBe(true);
    expect(restored.session).toEqual(state.session);
    expect(app.scope.getActiveDataOwner()).toBe(USER_A);
    // One refresh, with the vault's token; no provider SDK.
    const newCalls = server.calls.slice(callsBefore);
    expect(newCalls.map(c => c.route)).toEqual(['refresh']);
    expect(newCalls[0]?.body).toEqual({ refreshToken: refreshBeforeKill });
    expect(app.appleSignIn).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    expect(mockGoogleSignin.configure).not.toHaveBeenCalled();
    // Rotated pair adopted + rotated refresh token re-persisted.
    expect(serverSession.spentRefreshTokens).toEqual([refreshBeforeKill]);
    expect(app.api.getApiSession()).toMatchObject({
      bearerToken: serverSession.accessToken,
      refreshToken: serverSession.refreshToken,
    });
    expect(app.api.bearerTokenFor(USER_A)).toBe(serverSession.accessToken);
    expect(vaultRecord(app)).toMatchObject({
      refreshToken: serverSession.refreshToken,
    });
    assertNoLeak(app, serverSession.refreshToken);
    expect(server.reusedRefreshTokens).toEqual([]);

    // ── explicit sign-out (local scope)
    const bearerAtSignOut = serverSession.accessToken;
    await app.auth.useAuthStore.getState().signOut();
    journey.log.push({ step: 'sign-out', calls: server.calls.length });
    const logouts = server.calls.filter(c => c.route === 'logout');
    expect(logouts).toHaveLength(1);
    expect(logouts[0]?.authorization).toBe(`Bearer ${bearerAtSignOut}`);
    expect(logouts[0]?.outcome).toBe('status:204');
    expect(server.liveSessionsFor(USER_A)).toEqual([]);
    expect(app.auth.useAuthStore.getState().session).toBeNull();
    expect(app.api.getApiSession()).toBeNull();
    expect(app.api.bearerTokenFor(USER_A)).toBeNull();
    expect(app.keychain.size).toBe(0);
    expect(app.scope.getActiveDataOwner()).toBe(
      app.scope.SIGNED_OUT_DATA_OWNER,
    );
    assertNoLeak(app, null);

    // ── kill + relaunch again: signed out, no network at all
    app = killAndRelaunch(app);
    journey.app = app;
    const quiet = server.calls.length;
    await app.auth.useAuthStore.getState().hydrate();
    expect(app.auth.useAuthStore.getState()).toMatchObject({
      hydrated: true,
      session: null,
    });
    expect(server.calls.length).toBe(quiet);
    expect(app.appleSignIn).not.toHaveBeenCalled();
    assertNoLeak(app, null);
  });
});

// ─── 2. Google: same journey, plus the legacy flag stays token-free ──────────

describe('Google: sign-in → vault → kill/relaunch → sign-out', () => {
  it('persists the same exact record; the SQLite flag names the provider only; restore never touches the Google SDK; sign-out clears flag + vault and signs the SDK out', async () => {
    let { app } = journey;
    const { server } = journey;
    const { idToken } = armGoogle(server);

    await app.auth.useAuthStore.getState().signInWithGoogle();
    expect(app.auth.useAuthStore.getState().error).toBeNull();
    const serverSession = server.onlyLiveSession(USER_A);
    expect(mockGoogleSignin.configure).toHaveBeenCalledWith({
      webClientId: 'test-web-client.apps.googleusercontent.com',
      iosClientId: 'test-ios-client.apps.googleusercontent.com',
    });
    expect(vaultRecord(app)).toEqual({
      version: 1,
      provider: 'google',
      canonicalAppUserId: USER_A,
      refreshToken: serverSession.refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    });
    expect(mockKv.get('auth.last-provider')).toBe(
      JSON.stringify({ version: 1, provider: 'google' }),
    );
    const bootstraps = server.calls.filter(c => c.route === 'bootstrap');
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]?.authorization).toBe(`Bearer ${idToken}`);
    expect(bootstraps[0]?.body).not.toHaveProperty('appleAuthorizationCode');
    assertNoLeak(app, serverSession.refreshToken);

    app = killAndRelaunch(app);
    journey.app = app;
    jest.clearAllMocks();
    await app.auth.useAuthStore.getState().hydrate();
    expect(app.auth.useAuthStore.getState().session).toMatchObject({
      provider: 'google',
      canonicalAppUserId: USER_A,
    });
    expect(mockGoogleSignin.configure).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    expect(app.api.getApiSession()?.bearerToken).toBe(
      serverSession.accessToken,
    );
    assertNoLeak(app, serverSession.refreshToken);

    await app.auth.useAuthStore.getState().signOut();
    expect(mockGoogleSignin.signOut).toHaveBeenCalledTimes(1);
    expect(mockKv.get('auth.last-provider')).toBe('');
    expect(server.liveSessionsFor(USER_A)).toEqual([]);
    expect(app.keychain.size).toBe(0);
    assertNoLeak(app, null);

    app = killAndRelaunch(app);
    journey.app = app;
    const quiet = server.calls.length;
    await app.auth.useAuthStore.getState().hydrate();
    expect(app.auth.useAuthStore.getState().session).toBeNull();
    expect(server.calls.length).toBe(quiet);
    // The legacy silent path stays disarmed after an explicit sign-out.
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
  });
});

// ─── 3. The 8 s launch budget ─────────────────────────────────────────────────

describe('launch budget: hydrate resolves signed-in within 8 s whatever the network does', () => {
  async function signInThenKill(): Promise<{
    app: AppProcess;
    refreshToken: string;
  }> {
    const { server } = journey;
    armApple(journey.app, server);
    await journey.app.auth.useAuthStore.getState().signInWithApple();
    const serverSession = server.onlyLiveSession(USER_A);
    const app = killAndRelaunch(journey.app);
    journey.app = app;
    return { app, refreshToken: serverSession.refreshToken };
  }

  it('a refresh that hangs: signed in at exactly 8 000 ms with local data, no bearer yet, vault untouched; tokens adopted when the response finally lands', async () => {
    const { app, refreshToken } = await signInThenKill();
    const { server } = journey;
    jest.useFakeTimers();
    server.queueFault('refresh', { kind: 'hang' });

    let settled = false;
    const hydrating = app.auth.useAuthStore
      .getState()
      .hydrate()
      .then(() => {
        settled = true;
      });
    await jest.advanceTimersByTimeAsync(7_999);
    expect(settled).toBe(false);
    expect(app.auth.useAuthStore.getState().hydrated).toBe(false);
    // Signed in from the record already (data owner + session), waiting on
    // the bearer.
    expect(app.auth.useAuthStore.getState().session?.canonicalAppUserId).toBe(
      USER_A,
    );
    await jest.advanceTimersByTimeAsync(1);
    await hydrating;
    expect(settled).toBe(true);
    expect(app.auth.useAuthStore.getState()).toMatchObject({
      hydrated: true,
      session: { canonicalAppUserId: USER_A, provider: 'apple' },
      error: null,
    });
    expect(app.api.getApiSession()).toBeNull();
    expect(app.api.bearerTokenFor(USER_A)).toBeNull();
    expect(vaultRecord(app)).toMatchObject({ refreshToken });
    journey.log.push({ step: 'hydrate-settled-at-ms', atMs: 8_000 });

    // The refresh lands late: adopted, re-persisted, still ONE call.
    expect(server.releaseHang('refresh')).toBe(true);
    await flush();
    const serverSession = server.onlyLiveSession(USER_A);
    expect(app.api.getApiSession()).toMatchObject({
      bearerToken: serverSession.accessToken,
      refreshToken: serverSession.refreshToken,
    });
    expect(vaultRecord(app)).toMatchObject({
      refreshToken: serverSession.refreshToken,
    });
    expect(server.calls.filter(c => c.route === 'refresh')).toHaveLength(1);
    assertNoLeak(app, serverSession.refreshToken);
  });

  it('a refresh that never answers: aborted at 15 s, retried after 5 s backoff, user still signed in throughout', async () => {
    const { app, refreshToken } = await signInThenKill();
    const { server } = journey;
    jest.useFakeTimers();
    server.queueFault('refresh', { kind: 'hang' });

    const hydrating = app.auth.useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrating;
    expect(app.auth.useAuthStore.getState().hydrated).toBe(true);
    expect(server.calls.filter(c => c.route === 'refresh')).toHaveLength(1);
    // 15 s request timeout → abort → retryable → retry at +5 s.
    await jest.advanceTimersByTimeAsync(7_000); // t = 15 000
    await flush();
    expect(server.pendingHangs).toHaveLength(0);
    expect(server.calls.filter(c => c.route === 'refresh')).toHaveLength(1);
    expect(app.auth.useAuthStore.getState().session?.canonicalAppUserId).toBe(
      USER_A,
    );
    await jest.advanceTimersByTimeAsync(4_999); // t = 19 999
    expect(server.calls.filter(c => c.route === 'refresh')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1); // t = 20 000
    await flush();
    const refreshes = server.calls.filter(c => c.route === 'refresh');
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]?.body).toEqual({ refreshToken });
    expect(refreshes[1]?.outcome).toBe('status:200');
    const serverSession = server.onlyLiveSession(USER_A);
    expect(app.api.getApiSession()?.bearerToken).toBe(
      serverSession.accessToken,
    );
    expect(vaultRecord(app)).toMatchObject({
      refreshToken: serverSession.refreshToken,
    });
    assertNoLeak(app, serverSession.refreshToken);
  });

  it('a refresh that answers at 3 s: hydrate resolves at 3 s (not 8) with the bearer already installed', async () => {
    const { app } = await signInThenKill();
    const { server } = journey;
    jest.useFakeTimers();
    server.queueFault('refresh', { kind: 'delay', ms: 3_000 });

    let settled = false;
    const hydrating = app.auth.useAuthStore
      .getState()
      .hydrate()
      .then(() => {
        settled = true;
      });
    await jest.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    await hydrating;
    expect(settled).toBe(true);
    const serverSession = server.onlyLiveSession(USER_A);
    expect(app.api.getApiSession()?.bearerToken).toBe(
      serverSession.accessToken,
    );
    expect(app.auth.useAuthStore.getState().hydrated).toBe(true);
    // The launch deadline timer was cleared: crossing the 8 s mark changes
    // nothing and sends nothing.
    const refreshCalls = server.calls.filter(c => c.route === 'refresh').length;
    await jest.advanceTimersByTimeAsync(5_001);
    expect(server.calls.filter(c => c.route === 'refresh')).toHaveLength(
      refreshCalls,
    );
    expect(app.api.getApiSession()?.bearerToken).toBe(
      serverSession.accessToken,
    );
    assertNoLeak(app, serverSession.refreshToken);
  });

  it('a 401 that lands AFTER the budget: the user was shown signed in, then the session is dropped and the vault cleared (the one implicit sign-out)', async () => {
    const { app } = await signInThenKill();
    const { server } = journey;
    jest.useFakeTimers();
    server.queueFault('refresh', { kind: 'hang' });

    const hydrating = app.auth.useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrating;
    expect(app.auth.useAuthStore.getState().session).not.toBeNull();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(
      server.releaseHang(
        'refresh',
        jsonResponse(401, { error: { message: 'Sign in again.' } }),
      ),
    ).toBe(true);
    await flush();
    expect(app.auth.useAuthStore.getState()).toMatchObject({
      hydrated: true,
      session: null,
      error: null,
    });
    expect(app.keychain.size).toBe(0);
    expect(app.api.getApiSession()).toBeNull();
    expect(app.scope.getActiveDataOwner()).toBe(
      app.scope.SIGNED_OUT_DATA_OWNER,
    );
    expect(jest.getTimerCount()).toBe(0);
    assertNoLeak(app, null);
  });

  it('offline (dead network) and 5xx launches settle immediately, signed in, vault kept; 403 signs out like 401', async () => {
    const outcomes: Array<Record<string, unknown>> = [];
    for (const fault of [
      { kind: 'network' } as const,
      { kind: 'status', status: 500 } as const,
      { kind: 'status', status: 503 } as const,
      { kind: 'malformed' } as const,
      { kind: 'status', status: 429 } as const,
      { kind: 'status', status: 403 } as const,
    ]) {
      journey.restoreFetch();
      journey.console.restore();
      journey = startJourney(SEED + outcomes.length + 1);
      const { app, refreshToken } = await signInThenKill();
      const { server } = journey;
      server.queueFault('refresh', fault);
      const startedAt = Date.now();
      await app.auth.useAuthStore.getState().hydrate();
      const ms = Date.now() - startedAt;
      const state = app.auth.useAuthStore.getState();
      const signedIn = state.session !== null;
      outcomes.push({ fault, ms, signedIn, vault: vaultRecord(app) !== null });
      expect(ms).toBeLessThan(1_000);
      expect(state.hydrated).toBe(true);
      if (fault.kind === 'status' && fault.status === 403) {
        expect(signedIn).toBe(false);
        expect(app.keychain.size).toBe(0);
        assertNoLeak(app, null);
      } else {
        expect(signedIn).toBe(true);
        expect(vaultRecord(app)).toMatchObject({ refreshToken });
        expect(app.api.getApiSession()).toBeNull();
        assertNoLeak(app, refreshToken);
      }
      app.keeper.stopSessionKeeper();
      app.sync.clearSyncRuntime();
    }
    journey.log.push({ step: 'launch-fault-matrix', outcomes });
  });
});

// ─── 4. Refresh rotation while the app runs ──────────────────────────────────

describe('refresh rotation', () => {
  it('rotates 60 s before expiry, re-persists each rotated refresh token, never re-sends a spent one, and refreshes on foreground only when the bearer is short-lived', async () => {
    const { app, server } = journey;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-04T06:00:00Z'));
    armApple(app, server);
    await app.auth.useAuthStore.getState().signInWithApple();
    const serverSession = server.onlyLiveSession(USER_A);
    const firstRefresh = serverSession.refreshToken;
    const firstAccess = serverSession.accessToken;

    // Not before T-60 s.
    await jest.advanceTimersByTimeAsync(3_600_000 - 60_000 - 1);
    expect(server.calls.filter(c => c.route === 'refresh')).toHaveLength(0);
    expect(app.api.bearerTokenFor(USER_A)).toBe(firstAccess);
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    let refreshes = server.calls.filter(c => c.route === 'refresh');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.body).toEqual({ refreshToken: firstRefresh });
    expect(app.api.bearerTokenFor(USER_A)).toBe(serverSession.accessToken);
    expect(app.api.bearerTokenFor(USER_A)).not.toBe(firstAccess);
    expect(vaultRecord(app)).toMatchObject({
      refreshToken: serverSession.refreshToken,
    });
    assertNoLeak(app, serverSession.refreshToken);

    // Second rotation, same cadence, with the ROTATED token.
    const secondRefresh = serverSession.refreshToken;
    await jest.advanceTimersByTimeAsync(3_600_000 - 60_000);
    await flush();
    refreshes = server.calls.filter(c => c.route === 'refresh');
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]?.body).toEqual({ refreshToken: secondRefresh });
    expect(server.reusedRefreshTokens).toEqual([]);
    expect(serverSession.spentRefreshTokens).toEqual([
      firstRefresh,
      secondRefresh,
    ]);

    // Foreground with a fresh bearer (59 min left): no refresh.
    const appState = app.rn.AppState.addEventListener as jest.Mock;
    const listeners = appState.mock.calls
      .filter(([event]) => event === 'change')
      .map(([, listener]) => listener as (s: string) => void);
    expect(listeners.length).toBeGreaterThan(0);
    const fire = (s: string) => listeners.forEach(l => l(s));
    fire('background');
    fire('active');
    await flush();
    expect(server.calls.filter(c => c.route === 'refresh')).toHaveLength(2);
    // Foreground with < 5 min left: refresh at once.
    await jest.advanceTimersByTimeAsync(3_600_000 - 5 * 60_000 + 1);
    // (the scheduled T-60 s rotation has not fired yet: 4 min 59 s left)
    expect(server.calls.filter(c => c.route === 'refresh')).toHaveLength(2);
    fire('active');
    await flush();
    expect(server.calls.filter(c => c.route === 'refresh')).toHaveLength(3);
    expect(app.api.bearerTokenFor(USER_A)).toBe(serverSession.accessToken);
    expect(vaultRecord(app)).toMatchObject({
      refreshToken: serverSession.refreshToken,
    });
    assertNoLeak(app, serverSession.refreshToken);
  });

  it('a route 401 on the current bearer (refreshSessionNow) rotates in place; a concurrent second call does not double-send', async () => {
    const { app, server } = journey;
    jest.useFakeTimers();
    armApple(app, server);
    await app.auth.useAuthStore.getState().signInWithApple();
    const serverSession = server.onlyLiveSession(USER_A);
    server.queueFault('refresh', { kind: 'delay', ms: 200 });
    app.keeper.refreshSessionNow();
    app.keeper.refreshSessionNow();
    await jest.advanceTimersByTimeAsync(250);
    await flush();
    expect(server.calls.filter(c => c.route === 'refresh')).toHaveLength(1);
    expect(serverSession.spentRefreshTokens).toHaveLength(1);
    expect(app.api.bearerTokenFor(USER_A)).toBe(serverSession.accessToken);
    expect(app.auth.useAuthStore.getState().session?.canonicalAppUserId).toBe(
      USER_A,
    );
    assertNoLeak(app, serverSession.refreshToken);
  });
});

// ─── 5. Other-device semantics ───────────────────────────────────────────────

describe('other-device semantics (scope=local)', () => {
  it('device B signing out revokes only B; device A relaunches signed in; a server-side revocation of A ends A on its next refresh', async () => {
    const { server } = journey;
    let { app } = journey;

    // Device A signs in and is killed; its Keychain is kept aside.
    server.device = 'device-A';
    armApple(app, server);
    await app.auth.useAuthStore.getState().signInWithApple();
    const sessionA = server.onlyLiveSession(USER_A);
    const keychainA = [...app.keychain.entries()].map(
      ([k, v]) => [k, { ...v }] as const,
    );

    // Device B: a different phone — empty Keychain, fresh process.
    app = killAndRelaunch(app);
    journey.app = app;
    app.keychain.clear();
    server.device = 'device-B';
    armGoogle(server);
    await app.auth.useAuthStore.getState().signInWithGoogle();
    const sessionB = server
      .liveSessionsFor(USER_A)
      .find(s => s.device === 'device-B');
    if (!sessionB) throw new Error('device-B did not get a session');
    expect(server.liveSessionsFor(USER_A)).toHaveLength(2);
    expect(vaultRecord(app)).toMatchObject({
      refreshToken: sessionB.refreshToken,
    });
    expect(vaultRecord(app)?.refreshToken).not.toBe(sessionA.refreshToken);

    // B signs out: exactly B's bearer is presented; A is untouched.
    await app.auth.useAuthStore.getState().signOut();
    const logouts = server.calls.filter(c => c.route === 'logout');
    expect(logouts).toHaveLength(1);
    expect(logouts[0]?.authorization).toBe(`Bearer ${sessionB.accessToken}`);
    expect(sessionB.revokedAt).not.toBeNull();
    expect(sessionA.revokedAt).toBeNull();
    expect(server.liveSessionsFor(USER_A).map(s => s.device)).toEqual([
      'device-A',
    ]);

    // Device A relaunches: its refresh token is still current → signed in.
    app = killAndRelaunch(app);
    journey.app = app;
    app.keychain.clear();
    for (const [k, v] of keychainA) app.keychain.set(k, v);
    server.device = 'device-A';
    await app.auth.useAuthStore.getState().hydrate();
    expect(app.auth.useAuthStore.getState().session?.canonicalAppUserId).toBe(
      USER_A,
    );
    expect(app.api.bearerTokenFor(USER_A)).toBe(sessionA.accessToken);
    expect(sessionA.spentRefreshTokens).toHaveLength(1);
    assertNoLeak(app, sessionA.refreshToken);

    // The account's sessions are revoked server-side (account deleted /
    // signed out everywhere): A's next launch refresh is refused → out.
    sessionA.revokedAt = Date.now();
    app = killAndRelaunch(app);
    journey.app = app;
    await app.auth.useAuthStore.getState().hydrate();
    expect(app.auth.useAuthStore.getState()).toMatchObject({
      hydrated: true,
      session: null,
    });
    expect(app.keychain.size).toBe(0);
    expect(mockKv.get('auth.last-provider') ?? '').toBe('');
    assertNoLeak(app, null);
    expect(server.reusedRefreshTokens).toEqual([]);
  });

  it('account switch on one device: A signs out, B signs in — the vault holds ONLY B, A can never be resolved as a bearer again', async () => {
    const { app, server } = journey;
    armApple(app, server, 'subA');
    await app.auth.useAuthStore.getState().signInWithApple();
    const sessionA = server.onlyLiveSession(USER_A);
    await app.auth.useAuthStore.getState().signOut();
    expect(sessionA.revokedAt).not.toBeNull();

    armGoogle(server, 'subB');
    await app.auth.useAuthStore.getState().signInWithGoogle();
    const sessionB = server.onlyLiveSession(USER_B);
    expect(vaultRecord(app)).toEqual({
      version: 1,
      provider: 'google',
      canonicalAppUserId: USER_B,
      refreshToken: sessionB.refreshToken,
      email: 'sam@example.com',
      displayName: 'Pat Player',
    });
    expect(app.api.bearerTokenFor(USER_A)).toBeNull();
    expect(app.api.bearerTokenFor(USER_B)).toBe(sessionB.accessToken);
    expect(app.scope.getActiveDataOwner()).toBe(USER_B);
    assertNoLeak(app, sessionB.refreshToken);
  });
});

// ─── 6. Races and fail-soft paths ────────────────────────────────────────────

describe('races', () => {
  it('sign-out during an in-flight launch refresh: late tokens are dropped, nothing is re-persisted, the next launch is signed out', async () => {
    const { server } = journey;
    armApple(journey.app, server);
    await journey.app.auth.useAuthStore.getState().signInWithApple();
    let app = killAndRelaunch(journey.app);
    journey.app = app;
    jest.useFakeTimers();
    server.queueFault('refresh', { kind: 'hang' });

    const hydrating = app.auth.useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrating;
    expect(app.auth.useAuthStore.getState().session).not.toBeNull();

    await app.auth.useAuthStore.getState().signOut();
    expect(app.keychain.size).toBe(0);
    // The refresh lands after sign-out: must be ignored.
    expect(server.releaseHang('refresh')).toBe(true);
    await flush();
    await jest.advanceTimersByTimeAsync(100);
    expect(app.api.getApiSession()).toBeNull();
    expect(app.auth.useAuthStore.getState().session).toBeNull();
    expect(app.keychain.size).toBe(0);
    assertNoLeak(app, null);

    jest.useRealTimers();
    app = killAndRelaunch(app);
    journey.app = app;
    const quiet = server.calls.length;
    await app.auth.useAuthStore.getState().hydrate();
    expect(app.auth.useAuthStore.getState().session).toBeNull();
    expect(server.calls.length).toBe(quiet);
  });

  it('CHARACTERIZATION: sign-out while the launch refresh is still pending (no bearer in memory) never calls /v1/auth/logout — the server session stays live after the device forgot it', async () => {
    const { server } = journey;
    armApple(journey.app, server);
    await journey.app.auth.useAuthStore.getState().signInWithApple();
    const sessionA = server.onlyLiveSession(USER_A);
    const app = killAndRelaunch(journey.app);
    journey.app = app;
    jest.useFakeTimers();
    server.queueFault('refresh', { kind: 'hang' });
    const hydrating = app.auth.useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await hydrating;

    await app.auth.useAuthStore.getState().signOut();
    server.releaseHang('refresh');
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);

    const logouts = server.calls.filter(c => c.route === 'logout');
    journey.log.push({
      step: 'characterization.signout-without-bearer',
      logoutCalls: logouts.length,
      serverSessionLive: sessionA.revokedAt === null,
      serverRotationsAfterSignOut: sessionA.spentRefreshTokens.length,
    });
    // Observed today (reported as a finding, not asserted as desired):
    expect(logouts).toHaveLength(0);
    expect(sessionA.revokedAt).toBeNull();
    expect(server.liveSessionsFor(USER_A)).toHaveLength(1);
    // Local state is nonetheless fully signed out.
    expect(app.keychain.size).toBe(0);
    expect(app.api.getApiSession()).toBeNull();
  });

  it('CHARACTERIZATION: sign-out while offline leaves the server session live; nothing retries the revocation later', async () => {
    const { app, server } = journey;
    armApple(app, server);
    await app.auth.useAuthStore.getState().signInWithApple();
    const sessionA = server.onlyLiveSession(USER_A);
    server.queueFault('logout', { kind: 'network' });
    await app.auth.useAuthStore.getState().signOut();
    expect(app.keychain.size).toBe(0);
    expect(app.auth.useAuthStore.getState().session).toBeNull();
    const logouts = server.calls.filter(c => c.route === 'logout');
    expect(logouts).toHaveLength(1);
    expect(logouts[0]?.outcome).toBe('fault:network:TypeError');
    expect(sessionA.revokedAt).toBeNull();
    journey.log.push({
      step: 'characterization.offline-signout',
      serverSessionLive: sessionA.revokedAt === null,
    });
  });

  it('Keychain write failure at sign-in: the run stays signed in, nothing is persisted, the next launch is signed out (fail-soft, no crash)', async () => {
    const { app, server } = journey;
    const keychainModule = require('react-native-keychain') as {
      setGenericPassword: (...args: unknown[]) => Promise<unknown>;
    };
    const original = keychainModule.setGenericPassword;
    keychainModule.setGenericPassword = () =>
      Promise.reject(new Error('errSecInteractionNotAllowed'));
    try {
      armApple(app, server);
      await app.auth.useAuthStore.getState().signInWithApple();
    } finally {
      keychainModule.setGenericPassword = original;
    }
    expect(app.auth.useAuthStore.getState().error).toBeNull();
    expect(app.auth.useAuthStore.getState().session?.canonicalAppUserId).toBe(
      USER_A,
    );
    expect(app.api.getApiSession()).not.toBeNull();
    expect(app.keychain.size).toBe(0);
    assertNoLeak(app, null);
    const next = killAndRelaunch(app);
    journey.app = next;
    await next.auth.useAuthStore.getState().hydrate();
    expect(next.auth.useAuthStore.getState()).toMatchObject({
      hydrated: true,
      session: null,
    });
  });

  it('a bootstrap that answers without a session (legacy server): bearer = provider token in memory only, nothing durable, relaunch signed out', async () => {
    const { server } = journey;
    let { app } = journey;
    const { identityToken } = armApple(app, server);
    server.queueFault('bootstrap', {
      kind: 'status',
      status: 200,
      body: {
        user: { id: USER_A, email: 'pat@example.com' },
        onboardingState: 'complete',
      },
    });
    await app.auth.useAuthStore.getState().signInWithApple();
    expect(app.auth.useAuthStore.getState().session?.canonicalAppUserId).toBe(
      USER_A,
    );
    expect(app.api.getApiSession()).toMatchObject({
      bearerToken: identityToken,
      refreshToken: null,
    });
    expect(app.keychain.size).toBe(0);
    expect(findSecrets(JSON.stringify([...mockKv.entries()]))).toEqual([]);
    app = killAndRelaunch(app);
    journey.app = app;
    await app.auth.useAuthStore.getState().hydrate();
    expect(app.auth.useAuthStore.getState().session).toBeNull();
  });
});
