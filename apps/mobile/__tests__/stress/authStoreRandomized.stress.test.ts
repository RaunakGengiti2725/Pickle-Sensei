/**
 * STRESS / mod-auth-store / randomized-seeded — seeded randomized long-run over
 * the PUBLIC API of `src/auth/authStore.ts` (hydrate, signInWithApple,
 * signInWithGoogle, continueAsGuest, signOut, completeAccountDeletion,
 * clearError) with the real sessionKeeper / sessionLifecycle / sessionVault /
 * apiSession / accountScope / syncRuntime stack underneath. Only the device
 * edges are faked: fetch (script-settled, so responses land in ANY order and
 * at ANY time), the Keychain, SQLite kv, the Apple native module, the Google
 * SDK, AppState and the clock (jest modern fake timers).
 *
 * Every sequence is generated from a 32-bit seed (mulberry32) into an EXPLICIT
 * action script of length 5-60: store calls interleaved with delivery of the
 * pending network requests they (or the keeper) issued — ok / rotated / 401 /
 * 403 / 5xx / 429 / network error / malformed body — clock advances (keeper
 * timers, 15 s aborts, the 8 s launch budget), foreground events, API 401
 * reports, environment faults (Keychain / SQLite / provider SDK) and
 * near-legal state injections (corrupt Keychain record, legacy kv flags).
 * Every script ends in a `flush` that delivers everything still pending and
 * waits for every public promise to settle.
 *
 * Invariants (AGENTS.md "Auth sessions", authStore.ts comments, the existing
 * auth suites) are model-checked after EVERY step:
 *   I1  session shape: guest ⇔ localOnly ⇔ canonicalAppUserId null; synced ⇒
 *       canonical backend UUID and subject === canonicalAppUserId.
 *   I2  error / localDataError / deletionCleanup codes are in their unions.
 *   I3  busy ⇒ a sign-in call is in flight; hydrated never flips back.
 *   I4  Keychain: only the sessionVault record shape; NEVER an access token,
 *       a provider identity token or a token the server never issued (unless
 *       the harness itself corrupted the vault and the store has not touched
 *       it since).
 *   I5  SQLite kv never holds any token or the legacy provider subject once
 *       hydrate() has run.
 *   I6  ApiSession bearer/refresh tokens are ones the server issued; account
 *       is a UUID.
 *   I7  THE ONE IMPLICIT SIGN-OUT: a synced session may only become null via
 *       signOut(), completeAccountDeletion(), a relaunch (hydrate) or a
 *       refresh answered 401/403 (or the documented legacy provider-token
 *       expiry). Nothing else — not 5xx, not offline, not a timer. And a
 *       relaunch that began with a durable Keychain record must land signed
 *       in unless the server refused the refresh token meanwhile.
 *   I8  Keeper hygiene: refresh requests carry the CURRENT refresh token of
 *       the CURRENT account; none are issued while signed out / guest.
 *   I9  Explicit sign-out wins: a sign-in / restore that started BEFORE a
 *       signOut()/deletion must not put a synced session back afterwards.
 *   I10 Every public promise settles (never rejects) once the network is
 *       flushed; the store is never stuck busy.
 *   Q1-Q7 (quiescent — no pending requests, no in-flight calls): data owner
 *       ⇔ session; ApiSession bound to the signed-in account; busy false;
 *       vault refresh token === live refresh token; signed out ⇒ vault empty;
 *       kv local-mode ⇔ guest; last-provider flag ⇔ Google session.
 *   Oracles on delivered refresh answers (live keeper only): 401/403 ⇒ signed
 *       out + vault cleared + owner signed-out + no error; ok ⇒ bearer and
 *       refresh token adopted + re-persisted; 5xx/429/network/malformed ⇒
 *       session, vault and ApiSession unchanged.
 *
 * Determinism: each seed is replayed and the two step traces must be
 * identical. Failing seeds are ddmin-minimized and both the seed and the
 * minimized script are written to the JSON artifact.
 *
 * Knobs (all optional):
 *   STRESS_ITER   sequences to run (default 60; the campaign used 2000+)
 *   STRESS_SEED   base seed (default 20260904); sequence i uses base + i
 *   STRESS_MINLEN / STRESS_MAXLEN  script length bounds (default 5 / 60)
 *   STRESS_OUT    artifact path (default artifacts/stress/mod-auth-store/
 *                 randomized-seeded.json at the repo root)
 *   STRESS_REPLAY replay ONE seed with the full trace printed
 *   STRESS_SCRIPT (with STRESS_REPLAY) JSON action array to run instead of
 *                 the generated sequence, e.g. a minimized script
 *
 * Run (apps/mobile):
 *   npx jest --ci __tests__/stress/authStoreRandomized.stress.test.ts
 *   STRESS_ITER=2000 npx jest --ci __tests__/stress/authStoreRandomized.stress.test.ts
 *   STRESS_REPLAY=20260931 npx jest --ci __tests__/stress/authStoreRandomized.stress.test.ts
 */
import { AppState, NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { clearAccessStoreConfiguration } from '../../src/state/accessStore';
import { clearTrainingStoreConfiguration } from '../../src/training/store';

/** Node globals the RN tsconfig does not declare (same pattern as
 * xcMatrixNetworkAuth2.store.test.ts). */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
};
declare function setImmediate(callback: () => void): unknown;
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

// ─── Module seams ────────────────────────────────────────────────────────────

type KeychainItem = { username: string; password: string; accessible?: string };
const mockKeychain = {
  store: new Map<string, KeychainItem>(),
  mode: 'ok' as KeychainMode,
  /** Step index of the most recent Keychain operation that threw. */
  lastFailureStep: -1,
  /** True while the record in the vault was written by the HARNESS (a
   * near-legal corruption) rather than by sessionVault. */
  injected: false,
  step: 0,
  writes: 0,
};
type KeychainMode = 'ok' | 'getFails' | 'setFails' | 'resetFails' | 'allFail';

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
    AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
    ALWAYS: 'AccessibleAlways',
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY:
      'AccessibleWhenPasscodeSetThisDeviceOnly',
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  setGenericPassword: async (
    username: string,
    password: string,
    options: { service?: string; accessible?: string } = {},
  ) => {
    if (mockKeychain.mode === 'setFails' || mockKeychain.mode === 'allFail') {
      mockKeychain.lastFailureStep = mockKeychain.step;
      throw new Error('Keychain: errSecInteractionNotAllowed (fake)');
    }
    const service = options.service ?? '__default__';
    mockKeychain.store.set(service, {
      username,
      password,
      accessible: options.accessible,
    });
    mockKeychain.injected = false;
    mockKeychain.writes += 1;
    return { service, storage: 'KeychainMock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    if (mockKeychain.mode === 'getFails' || mockKeychain.mode === 'allFail') {
      mockKeychain.lastFailureStep = mockKeychain.step;
      throw new Error('Keychain: errSecAuthFailed (fake)');
    }
    const service = options.service ?? '__default__';
    const item = mockKeychain.store.get(service);
    if (!item) return false;
    return {
      service,
      storage: 'KeychainMock',
      username: item.username,
      password: item.password,
    };
  },
  resetGenericPassword: async (options: { service?: string } = {}) => {
    if (mockKeychain.mode === 'resetFails' || mockKeychain.mode === 'allFail') {
      mockKeychain.lastFailureStep = mockKeychain.step;
      throw new Error('Keychain: errSecItemNotFound (fake)');
    }
    const removed = mockKeychain.store.delete(options.service ?? '__default__');
    mockKeychain.injected = false;
    return removed;
  },
}));

type DbMode = 'ok' | 'openFails' | 'execFails';
const mockDb = {
  kv: new Map<string, string>(),
  mode: 'ok' as DbMode,
  lastFailureStep: -1,
  /** True while a kv flag was written by the HARNESS and hydrate() has not
   * run since (legacy-build simulation). */
  injected: false,
  step: 0,
};
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      if (mockDb.mode === 'execFails') {
        mockDb.lastFailureStep = mockDb.step;
        throw new Error('SQLITE_IOERR (fake)');
      }
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockDb.kv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockDb.kv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (statement.startsWith('DELETE FROM kv WHERE key = ?')) {
        mockDb.kv.delete(String(params[0]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (mockDb.mode === 'openFails') {
      mockDb.lastFailureStep = mockDb.step;
      throw new Error('cannot open database (fake)');
    }
    return mockCurrentDb();
  },
}));

type AppleMode = 'success' | 'cancel' | 'error' | 'missing' | 'noToken';
type GoogleMode = 'success' | 'cancel' | 'error' | 'noToken';
type GoogleSilentMode =
  'noPrevious' | 'success' | 'noSaved' | 'noToken' | 'error';
const mockProviders = {
  apple: 'success' as AppleMode,
  google: 'success' as GoogleMode,
  googleSilent: 'noPrevious' as GoogleSilentMode,
  tokenCounter: 0,
  /** Every identity token a provider fake ever handed out. */
  identityTokens: new Set<string>(),
};
function nextIdentityToken(provider: 'apple' | 'google'): string {
  mockProviders.tokenCounter += 1;
  const token = `${provider}-identity-${mockProviders.tokenCounter}`;
  mockProviders.identityTokens.add(token);
  return token;
}
const mockGoogleSignin = {
  configure: () => {},
  hasPlayServices: async () => true,
  signIn: async () => {
    switch (mockProviders.google) {
      case 'success':
        return {
          type: 'success',
          data: {
            idToken: nextIdentityToken('google'),
            user: { name: 'Pat Player', email: 'pat@example.com' },
          },
        };
      case 'noToken':
        return {
          type: 'success',
          data: {
            idToken: null,
            user: { name: 'Pat Player', email: 'pat@example.com' },
          },
        };
      case 'cancel':
        return { type: 'cancelled', data: null };
      case 'error':
        throw new Error('Google Sign-In SDK failure (fake)');
    }
  },
  hasPreviousSignIn: () => mockProviders.googleSilent !== 'noPrevious',
  signInSilently: async () => {
    switch (mockProviders.googleSilent) {
      case 'success':
        return {
          type: 'success',
          data: {
            idToken: nextIdentityToken('google'),
            user: { name: 'Pat Player', email: 'pat@example.com' },
          },
        };
      case 'noToken':
        return {
          type: 'success',
          data: {
            idToken: null,
            user: { name: 'Pat Player', email: 'pat@example.com' },
          },
        };
      case 'noSaved':
      case 'noPrevious':
        return { type: 'noSavedCredentialFound', data: null };
      case 'error':
        throw new Error('Google silent restore failure (fake)');
    }
  },
  signOut: async () => null,
  revokeAccess: async () => null,
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

/** Every authStore-driven keeper start/stop bumps this epoch; a pending
 * refresh request remembers the epoch it was issued under, so the oracles
 * know whether the keeper that issued it is still the live one. */
const mockKeeperEpoch = { value: 0 };
jest.mock('../../src/account/sessionKeeper', () => {
  const actual = jest.requireActual('../../src/account/sessionKeeper') as {
    stopSessionKeeper: () => void;
    startSessionKeeper: (input: unknown) => void;
  };
  return {
    ...actual,
    stopSessionKeeper: () => {
      mockKeeperEpoch.value += 1;
      actual.stopSessionKeeper();
    },
    startSessionKeeper: (input: unknown) => {
      mockKeeperEpoch.value += 1;
      actual.startSessionKeeper(input);
    },
  };
});

const nativeModules = NativeModules as {
  PickleAuth?: {
    signInWithApple(): Promise<{
      user: string;
      identityToken?: string;
      authorizationCode?: string;
      email?: string;
      givenName?: string;
      familyName?: string;
    }>;
  };
};
function installAppleNative(): void {
  if (mockProviders.apple === 'missing') {
    delete nativeModules.PickleAuth;
    return;
  }
  nativeModules.PickleAuth = {
    signInWithApple: async () => {
      switch (mockProviders.apple) {
        case 'success':
        case 'missing':
          return {
            user: 'apple-user-opaque',
            identityToken: nextIdentityToken('apple'),
            authorizationCode: `apple-code-${mockProviders.tokenCounter}`,
            email: 'pat@privaterelay.example',
            givenName: 'Pat',
            familyName: 'Player',
          };
        case 'noToken':
          return { user: 'apple-user-opaque', identityToken: undefined };
        case 'cancel':
          throw { code: 'auth.canceled', message: 'Sign-in canceled.' };
        case 'error':
          throw new Error('ASAuthorizationError unknown (fake)');
      }
    },
  };
}

// ─── Fake server + script-settled fetch ──────────────────────────────────────

const ACCOUNTS = {
  apple: 'a1b2c3d4-1111-4111-8111-00000000000a',
  google: 'a1b2c3d4-2222-4222-8222-00000000000b',
  appleAlt: 'a1b2c3d4-3333-4333-8333-00000000000c',
} as const;
type AccountKey = keyof typeof ACCOUNTS;

type Route = 'bootstrap' | 'refresh' | 'logout' | 'other';

interface PendingRequest {
  id: number;
  route: Route;
  url: string;
  /** Refresh token in the body (refresh route). */
  refreshTokenSent: string | null;
  /** The refresh token the app held (live ApiSession, else the sessionVault-
   * written Keychain record) at the instant the request was issued. */
  appTokenAtIssue: string | null;
  /** Bearer in the Authorization header (bootstrap: identity token; logout:
   * access token). */
  bearer: string | null;
  provider: 'apple' | 'google' | null;
  epoch: number;
  issuedAtStep: number;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

const server = {
  counter: 0,
  issuedAccess: new Set<string>(),
  /** refresh token → account it belongs to. */
  issuedRefresh: new Map<string, string>(),
  /** Tokens the fake server has refused (401/403) or revoked (logout). */
  deadRefresh: new Set<string>(),
};
const net = {
  pending: [] as PendingRequest[],
  log: [] as Array<{
    id: number;
    route: Route;
    step: number;
    refreshTokenSent: string | null;
    appTokenAtIssue: string | null;
    delivered: string | null;
  }>,
  nextId: 1,
  step: 0,
};

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function routeOf(url: string): Route {
  if (url.endsWith('/v1/account/bootstrap')) return 'bootstrap';
  if (url.endsWith('/v1/auth/refresh')) return 'refresh';
  if (url.endsWith('/v1/auth/logout')) return 'logout';
  return 'other';
}

function fakeFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === 'string' ? input : String(input);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers['Authorization'] ?? headers['authorization'] ?? null;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  let refreshTokenSent: string | null = null;
  if (typeof init?.body === 'string') {
    try {
      const body = JSON.parse(init.body) as { refreshToken?: unknown };
      if (typeof body.refreshToken === 'string') {
        refreshTokenSent = body.refreshToken;
      }
    } catch {
      refreshTokenSent = null;
    }
  }
  const route = routeOf(url);
  const provider: PendingRequest['provider'] =
    route === 'bootstrap'
      ? bearer?.startsWith('apple-')
        ? 'apple'
        : bearer?.startsWith('google-')
          ? 'google'
          : null
      : null;
  const appTokenAtIssue = route === 'refresh' ? appHeldRefreshToken() : null;
  return new Promise<Response>((resolve, reject) => {
    const request: PendingRequest = {
      id: net.nextId++,
      route,
      url,
      refreshTokenSent,
      appTokenAtIssue,
      bearer,
      provider,
      epoch: mockKeeperEpoch.value,
      issuedAtStep: net.step,
      resolve,
      reject,
    };
    net.pending.push(request);
    net.log.push({
      id: request.id,
      route,
      step: net.step,
      refreshTokenSent,
      appTokenAtIssue,
      delivered: null,
    });
    const signal = init?.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        const index = net.pending.indexOf(request);
        if (index === -1) return;
        net.pending.splice(index, 1);
        markDelivered(request.id, 'aborted');
        reject(abortError());
      });
    }
  });
}

function markDelivered(id: number, outcome: string): void {
  const entry = net.log.find(e => e.id === id);
  if (entry) entry.delivered = outcome;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}
function unreadableResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError('Unexpected token < (fake)')),
  } as unknown as Response;
}

const BOOTSTRAP_OUTCOMES = [
  'ok',
  'ok',
  'ok',
  'ok',
  'ok_alt_account',
  'ok_legacy',
  'ok_short_expiry',
  'r401',
  'r403',
  'r500',
  'r429',
  'network',
  'malformed_json',
  'bad_account',
  'missing_onboarding',
] as const;
const REFRESH_OUTCOMES = [
  'ok',
  'ok',
  'ok',
  'ok',
  'ok_short_expiry',
  'ok_expired_bearer',
  'r401',
  'r403',
  'r500',
  'r503',
  'r429',
  'network',
  'malformed_no_session',
  'malformed_missing_refresh',
  'non_json',
] as const;
const LOGOUT_OUTCOMES = ['ok', 'ok', 'network', 'r500'] as const;
type BootstrapOutcome = (typeof BOOTSTRAP_OUTCOMES)[number];
type RefreshOutcome = (typeof REFRESH_OUTCOMES)[number];
type LogoutOutcome = (typeof LOGOUT_OUTCOMES)[number];

interface Delivered {
  request: PendingRequest;
  /** What the fake server actually answered (may differ from the requested
   * outcome: an unknown/dead refresh token is always refused). */
  outcome: string;
  status: number | 'network';
  minted: { access: string; refresh: string; account: string } | null;
}

function mintTokens(account: string): {
  access: string;
  refresh: string;
  account: string;
} {
  server.counter += 1;
  const access = `access-${server.counter}`;
  const refresh = `refresh-${server.counter}`;
  server.issuedAccess.add(access);
  server.issuedRefresh.set(refresh, account);
  return { access, refresh, account };
}

function pick<T>(list: readonly T[], n: number): T {
  const item = list[Math.abs(n) % list.length];
  if (item === undefined) throw new Error('empty outcome list');
  return item;
}

/** Answers ONE pending request. `choice` indexes the route's outcome table. */
function deliver(request: PendingRequest, choice: number): Delivered {
  const index = net.pending.indexOf(request);
  if (index !== -1) net.pending.splice(index, 1);
  const nowSec = Math.floor(Date.now() / 1000);
  const finish = (
    outcome: string,
    status: number | 'network',
    response: Response | null,
    minted: Delivered['minted'] = null,
  ): Delivered => {
    markDelivered(request.id, outcome);
    if (response) request.resolve(response);
    else request.reject(new TypeError('Network request failed (fake)'));
    return { request, outcome, status, minted };
  };

  if (request.route === 'refresh') {
    const outcome: RefreshOutcome = pick(REFRESH_OUTCOMES, choice);
    const sent = request.refreshTokenSent;
    const account = sent ? server.issuedRefresh.get(sent) : undefined;
    if (
      outcome.startsWith('ok') &&
      (!sent || account === undefined || server.deadRefresh.has(sent))
    ) {
      // Server truth: a token it never issued (or already refused) is refused.
      if (sent) server.deadRefresh.add(sent);
      return finish(
        'r401_unknown_token',
        401,
        jsonResponse({ error: { message: 'Unknown refresh token.' } }, 401),
      );
    }
    switch (outcome) {
      case 'ok':
      case 'ok_short_expiry':
      case 'ok_expired_bearer': {
        const minted = mintTokens(account as string);
        const expiresAt =
          outcome === 'ok'
            ? nowSec + 3600
            : outcome === 'ok_short_expiry'
              ? nowSec + 90
              : nowSec - 30;
        return finish(
          outcome,
          200,
          jsonResponse({
            session: {
              accessToken: minted.access,
              refreshToken: minted.refresh,
              expiresAt,
            },
          }),
          minted,
        );
      }
      case 'r401':
      case 'r403': {
        if (sent) server.deadRefresh.add(sent);
        const status = outcome === 'r401' ? 401 : 403;
        return finish(
          outcome,
          status,
          jsonResponse({ error: { message: 'Refused.' } }, status),
        );
      }
      case 'r500':
        return finish(
          outcome,
          500,
          jsonResponse({ error: { message: 'Internal error.' } }, 500),
        );
      case 'r503':
        return finish(
          outcome,
          503,
          jsonResponse({ error: { message: 'Unavailable.' } }, 503),
        );
      case 'r429':
        return finish(
          outcome,
          429,
          jsonResponse(
            { error: { code: 'rate_limited', message: 'Slow down.' } },
            429,
          ),
        );
      case 'network':
        return finish(outcome, 'network', null);
      case 'malformed_no_session':
        return finish(
          outcome,
          200,
          jsonResponse({ user: { id: ACCOUNTS.apple } }),
        );
      case 'malformed_missing_refresh':
        return finish(
          outcome,
          200,
          jsonResponse({
            session: { accessToken: 'access-orphan', expiresAt: nowSec + 3600 },
          }),
        );
      case 'non_json':
        return finish(outcome, 200, unreadableResponse());
    }
  }

  if (request.route === 'bootstrap') {
    const outcome: BootstrapOutcome = pick(BOOTSTRAP_OUTCOMES, choice);
    const provider = request.provider ?? 'apple';
    const accountKey: AccountKey =
      outcome === 'ok_alt_account' && provider === 'apple'
        ? 'appleAlt'
        : provider;
    const account = ACCOUNTS[accountKey];
    const user = { id: account, email: 'pat@example.com' };
    switch (outcome) {
      case 'ok':
      case 'ok_alt_account':
      case 'ok_short_expiry': {
        const minted = mintTokens(account);
        return finish(
          outcome,
          200,
          jsonResponse({
            user,
            onboardingState: 'complete',
            session: {
              accessToken: minted.access,
              refreshToken: minted.refresh,
              expiresAt:
                outcome === 'ok_short_expiry' ? nowSec + 90 : nowSec + 3600,
            },
          }),
          minted,
        );
      }
      case 'ok_legacy':
        return finish(
          outcome,
          200,
          jsonResponse({ user, onboardingState: 'pending' }),
        );
      case 'r401':
      case 'r403': {
        const status = outcome === 'r401' ? 401 : 403;
        return finish(
          outcome,
          status,
          jsonResponse({ error: { message: 'Token rejected.' } }, status),
        );
      }
      case 'r500':
        return finish(
          outcome,
          500,
          jsonResponse({ error: { message: 'Internal error.' } }, 500),
        );
      case 'r429':
        return finish(
          outcome,
          429,
          jsonResponse({ error: { message: 'Too many requests.' } }, 429),
        );
      case 'network':
        return finish(outcome, 'network', null);
      case 'malformed_json':
        return finish(outcome, 200, unreadableResponse());
      case 'bad_account':
        return finish(
          outcome,
          200,
          jsonResponse({
            user: { id: 'not-a-uuid', email: null },
            onboardingState: 'complete',
          }),
        );
      case 'missing_onboarding':
        return finish(outcome, 200, jsonResponse({ user }));
    }
  }

  if (request.route === 'logout') {
    const outcome: LogoutOutcome = pick(LOGOUT_OUTCOMES, choice);
    switch (outcome) {
      case 'ok':
        return finish(outcome, 204, jsonResponse(null, 204));
      case 'network':
        return finish(outcome, 'network', null);
      case 'r500':
        return finish(
          outcome,
          500,
          jsonResponse({ error: { message: 'Internal error.' } }, 500),
        );
    }
  }

  return finish(
    'r404',
    404,
    jsonResponse({ error: { message: 'Not found.' } }, 404),
  );
}

// ─── Seeded generator ────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type EnvTarget = 'apple' | 'google' | 'googleSilent' | 'keychain' | 'db';
const ENV_MODES: { [K in EnvTarget]: readonly string[] } = {
  apple: ['success', 'success', 'cancel', 'error', 'missing', 'noToken'],
  google: ['success', 'success', 'cancel', 'error', 'noToken'],
  googleSilent: [
    'noPrevious',
    'success',
    'success',
    'noSaved',
    'noToken',
    'error',
  ],
  keychain: ['ok', 'ok', 'getFails', 'setFails', 'resetFails', 'allFail'],
  db: ['ok', 'ok', 'openFails', 'execFails'],
};
const VAULT_CORRUPTIONS = [
  'garbage',
  'wrongVersion',
  'nonUuidId',
  'unknownToken',
  'staleToken',
] as const;
const KV_INJECTIONS = [
  'lastProviderGoogle',
  'legacySubject',
  'guestMode',
] as const;
const ADVANCE_MS = [
  1_000,
  5_000,
  16_000,
  31_000,
  60_000,
  5 * 60_000,
  10 * 60_000,
  61 * 60_000,
] as const;

type Action =
  | { kind: 'hydrate' }
  | { kind: 'signInApple' }
  | { kind: 'signInGoogle' }
  | { kind: 'guest' }
  | { kind: 'signOut' }
  | { kind: 'deleteAccount' }
  | { kind: 'clearError' }
  | { kind: 'settle'; pick: number; outcome: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'foreground' }
  | { kind: 'report401'; stale: boolean }
  | { kind: 'env'; target: EnvTarget; mode: string }
  | { kind: 'corruptVault'; variant: (typeof VAULT_CORRUPTIONS)[number] }
  | { kind: 'injectKv'; variant: (typeof KV_INJECTIONS)[number] }
  | { kind: 'flush' };

interface Script {
  seed: number;
  /** Seeds that may inject Keychain / SQLite faults. */
  faults: boolean;
  actions: Action[];
}

const ACTION_WEIGHTS: Array<[Action['kind'], number]> = [
  ['hydrate', 8],
  ['signInApple', 8],
  ['signInGoogle', 8],
  ['guest', 2],
  ['signOut', 7],
  ['deleteAccount', 3],
  ['clearError', 3],
  ['settle', 24],
  ['advance', 8],
  ['foreground', 4],
  ['report401', 5],
  ['env', 8],
  ['corruptVault', 3],
  ['injectKv', 2],
  ['flush', 5],
];
const TOTAL_WEIGHT = ACTION_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

function generateScript(seed: number, minLen: number, maxLen: number): Script {
  const rng = mulberry32(seed);
  const length = minLen + Math.floor(rng() * (maxLen - minLen + 1));
  const faults = rng() < 0.35;
  const actions: Action[] = [];
  const int = (n: number) => Math.floor(rng() * n);
  while (actions.length < length) {
    let roll = rng() * TOTAL_WEIGHT;
    let kind: Action['kind'] = 'settle';
    for (const [candidate, weight] of ACTION_WEIGHTS) {
      roll -= weight;
      if (roll < 0) {
        kind = candidate;
        break;
      }
    }
    switch (kind) {
      case 'settle':
        actions.push({ kind, pick: int(1 << 16), outcome: int(1 << 16) });
        break;
      case 'advance':
        actions.push({ kind, ms: pick(ADVANCE_MS, int(ADVANCE_MS.length)) });
        break;
      case 'report401':
        actions.push({ kind, stale: rng() < 0.25 });
        break;
      case 'env': {
        const targets: EnvTarget[] = faults
          ? ['apple', 'google', 'googleSilent', 'keychain', 'db']
          : ['apple', 'google', 'googleSilent'];
        const target = pick(targets, int(targets.length));
        const modes = ENV_MODES[target];
        actions.push({ kind, target, mode: pick(modes, int(modes.length)) });
        break;
      }
      case 'corruptVault':
        actions.push({
          kind,
          variant: pick(VAULT_CORRUPTIONS, int(VAULT_CORRUPTIONS.length)),
        });
        break;
      case 'injectKv':
        actions.push({
          kind,
          variant: pick(KV_INJECTIONS, int(KV_INJECTIONS.length)),
        });
        break;
      default:
        actions.push({ kind } as Action);
    }
  }
  actions.push({ kind: 'flush' });
  return { seed, faults, actions };
}

// ─── Driver + model ──────────────────────────────────────────────────────────

const LOCAL_MODE_KV_KEY = 'auth.local-mode';
const LAST_PROVIDER_KV_KEY = 'auth.last-provider';
const LEGACY_SESSION_KV_KEY = 'auth.session';
const LOCAL_GUEST_VALUE = JSON.stringify({ version: 1, mode: 'guest' });
const LAST_PROVIDER_GOOGLE_VALUE = JSON.stringify({
  version: 1,
  provider: 'google',
});
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODES = new Set([
  'auth.canceled',
  'auth.not_configured',
  'auth.failed',
  'auth.session_expired',
]);

interface VaultView {
  raw: string | null;
  record: {
    version?: unknown;
    provider?: unknown;
    canonicalAppUserId?: unknown;
    refreshToken?: unknown;
    email?: unknown;
    displayName?: unknown;
  } | null;
  keys: string[];
}
function readVault(): VaultView {
  const item = mockKeychain.store.get(SESSION_VAULT_SERVICE);
  if (!item) return { raw: null, record: null, keys: [] };
  try {
    const parsed = JSON.parse(item.password) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        raw: item.password,
        record: parsed as VaultView['record'],
        keys: Object.keys(parsed as object),
      };
    }
    return { raw: item.password, record: null, keys: [] };
  } catch {
    return { raw: item.password, record: null, keys: [] };
  }
}

/** Newest refresh token the APP holds right now: the live ApiSession's, else
 * the Keychain record's — unless the harness planted that record. */
function appHeldRefreshToken(): string | null {
  const live = getApiSession()?.refreshToken;
  if (typeof live === 'string') return live;
  if (mockKeychain.injected) return null;
  const token = readVault().record?.refreshToken;
  return typeof token === 'string' ? token : null;
}

interface Snapshot {
  session: AuthSession | null;
  sessionKey: string | null;
  busy: boolean;
  hydrated: boolean;
  error: string | null;
  localDataError: string | null;
  deletionCleanup: string | null;
  owner: string;
  api: {
    account: string;
    bearer: string;
    refresh: string | null;
    provider: string;
  } | null;
  vault: VaultView;
  /** The vault record was planted by the harness (corruptVault). */
  vaultInjected: boolean;
  kvLocal: string | undefined;
  kvLast: string | undefined;
  kvLegacy: string | undefined;
  pending: string[];
  keychainSize: number;
}

function sessionKeyOf(session: AuthSession | null): string | null {
  if (!session) return null;
  return `${session.provider}:${session.canonicalAppUserId ?? 'local'}`;
}

function snapshot(): Snapshot {
  const state = useAuthStore.getState();
  const api = getApiSession();
  return {
    session: state.session,
    sessionKey: sessionKeyOf(state.session),
    busy: state.busy,
    hydrated: state.hydrated,
    error: state.error?.code ?? null,
    localDataError: state.localDataError?.code ?? null,
    deletionCleanup: state.deletionCleanup?.localPurge ?? null,
    owner: getActiveDataOwner(),
    api: api
      ? {
          account: api.canonicalAppUserId,
          bearer: api.bearerToken,
          refresh: api.refreshToken ?? null,
          provider: api.provider,
        }
      : null,
    vault: readVault(),
    vaultInjected: mockKeychain.injected,
    kvLocal: mockDb.kv.get(LOCAL_MODE_KV_KEY),
    kvLast: mockDb.kv.get(LAST_PROVIDER_KV_KEY),
    kvLegacy: mockDb.kv.get(LEGACY_SESSION_KV_KEY),
    pending: net.pending.map(r => `${r.id}:${r.route}`),
    keychainSize: mockKeychain.store.size,
  };
}

function digest(s: Snapshot): string {
  return JSON.stringify({
    s: s.sessionKey,
    b: s.busy,
    h: s.hydrated,
    e: s.error,
    l: s.localDataError,
    d: s.deletionCleanup,
    o: s.owner,
    a: s.api ? `${s.api.account}|${s.api.bearer}|${s.api.refresh ?? ''}` : null,
    v: s.vault.raw,
    kl: s.kvLocal ?? null,
    kp: s.kvLast ?? null,
    kg: s.kvLegacy ?? null,
    p: s.pending,
  });
}

type CallKind =
  | 'hydrate'
  | 'signInApple'
  | 'signInGoogle'
  | 'guest'
  | 'signOut'
  | 'deleteAccount';
interface StoreCall {
  id: number;
  kind: CallKind;
  startStep: number;
  settled: boolean;
  rejected: string | null;
  settledAtStep: number;
  /** Refresh token the Keychain record held when the call began (hydrate
   * reads the record once; a record replaced later is not what it uses). */
  vaultTokenAtStart: string | null;
  /** Whether a sessionVault-written (not harness-planted) record existed. */
  vaultRecordAtStart: boolean;
}

interface Violation {
  step: number;
  invariant: string;
  detail: string;
  action: string;
}

interface RunResult {
  seed: number;
  faults: boolean;
  length: number;
  stepsExecuted: number;
  violations: Violation[];
  trace: string[];
  deliveredOutcomes: Record<string, number>;
  actionKinds: Record<string, number>;
  requestsByRoute: Record<string, number>;
  finalDigest: string;
  durationMs: number;
}

const REAL_MATH_RANDOM = Math.random;
const appStateHandlers = new Set<(state: string) => void>();

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>(resolve => setImmediate(() => resolve()));
  }
}

function resetWorld(): void {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setApiUnauthorizedListener(null);
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    localDataError: null,
    deletionCleanup: null,
  });
  jest.clearAllTimers();
  mockKeychain.store.clear();
  mockKeychain.mode = 'ok';
  mockKeychain.lastFailureStep = -1;
  mockKeychain.injected = false;
  mockKeychain.step = 0;
  mockKeychain.writes = 0;
  mockDb.kv.clear();
  mockDb.mode = 'ok';
  mockDb.lastFailureStep = -1;
  mockDb.injected = false;
  mockDb.step = 0;
  mockProviders.apple = 'success';
  mockProviders.google = 'success';
  mockProviders.googleSilent = 'noPrevious';
  mockProviders.tokenCounter = 0;
  mockProviders.identityTokens.clear();
  installAppleNative();
  server.counter = 0;
  server.issuedAccess.clear();
  server.issuedRefresh.clear();
  server.deadRefresh.clear();
  net.pending.length = 0;
  net.log.length = 0;
  net.nextId = 1;
  net.step = 0;
  appStateHandlers.clear();
}

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function isSynced(session: AuthSession | null): session is AuthSession {
  return !!session && !session.localOnly;
}

async function runScript(script: Script): Promise<RunResult> {
  const started = Date.now();
  resetWorld();
  const jitter = mulberry32(script.seed ^ 0x5bd1e995);
  Math.random = jitter;

  const violations: Violation[] = [];
  const trace: string[] = [];
  const deliveredOutcomes: Record<string, number> = {};
  const actionKinds: Record<string, number> = {};
  const requestsByRoute: Record<string, number> = {};
  const calls: StoreCall[] = [];
  let callId = 0;
  const dbFailureSteps: number[] = [];
  let lastKvInjectStep = -1;
  let lastExplicitSignOutStep = -1;
  /** Step at which the session last became null / changed account. */
  let lastSessionChangeStep = -1;
  let lastRefreshTokenChangeStep = -1;
  /** A legacy (no refresh token) 401 handler may still be running. */
  let legacyExpiryPendingSince = -1;
  /** Step at which a legacy-401 silent restore issued its bootstrap request
   * (a fire-and-forget flow, not a store call) that is still unanswered. */
  let legacyRestoreSince = -1;
  /** Step at which the server last refused a refresh token (401/403). */
  let lastRefusalStep = -1;
  const bearersSeen: string[] = [];
  let stepIndex = 0;

  const fail = (invariant: string, detail: string, action: Action) => {
    if (SKIP.some(prefix => invariant.startsWith(prefix))) return;
    violations.push({
      step: stepIndex,
      invariant,
      detail,
      action: JSON.stringify(action),
    });
  };

  const startCall = (
    kind: CallKind,
    invoke: () => Promise<void>,
  ): StoreCall => {
    callId += 1;
    const call: StoreCall = {
      id: callId,
      kind,
      startStep: stepIndex,
      settled: false,
      rejected: null,
      settledAtStep: -1,
      vaultTokenAtStart: mockKeychain.injected
        ? null
        : (() => {
            const record = readVault().record;
            return typeof record?.refreshToken === 'string'
              ? record.refreshToken
              : null;
          })(),
      vaultRecordAtStart: !mockKeychain.injected && readVault().record !== null,
    };
    calls.push(call);
    invoke().then(
      () => {
        call.settled = true;
        call.settledAtStep = stepIndex;
      },
      (error: unknown) => {
        call.settled = true;
        call.settledAtStep = stepIndex;
        call.rejected = error instanceof Error ? error.message : String(error);
      },
    );
    return call;
  };
  const inflight = (kinds?: CallKind[]) =>
    calls.filter(c => !c.settled && (!kinds || kinds.includes(c.kind)));
  /** Calls that were in flight at some point during the current step. */
  const activeThisStep = (kinds: CallKind[]) =>
    calls.filter(
      c =>
        kinds.includes(c.kind) && (!c.settled || c.settledAtStep === stepIndex),
    );

  // A record the HARNESS planted (corruptVault) is not app-held state.
  const currentRefreshToken = (s: Snapshot): string | null =>
    s.api?.refresh ??
    (!s.vaultInjected && typeof s.vault.record?.refreshToken === 'string'
      ? s.vault.record.refreshToken
      : null);

  const checkAlways = (
    action: Action,
    before: Snapshot,
    after: Snapshot,
    delivered: Delivered[],
    newRequests: PendingRequest[],
  ) => {
    const session = after.session;
    // I1 session shape
    if (session) {
      if (session.provider === 'guest') {
        if (
          !session.localOnly ||
          session.canonicalAppUserId !== null ||
          session.subject !== 'local-only'
        ) {
          fail('I1.guest_shape', JSON.stringify(session), action);
        }
      } else if (
        session.provider === 'apple' ||
        session.provider === 'google'
      ) {
        if (
          session.localOnly ||
          !session.canonicalAppUserId ||
          !UUID_PATTERN.test(session.canonicalAppUserId) ||
          session.subject !== session.canonicalAppUserId
        ) {
          fail('I1.synced_shape', JSON.stringify(session), action);
        }
      } else {
        fail('I1.provider_enum', JSON.stringify(session), action);
      }
    }
    // I2 enums
    if (after.error !== null && !ERROR_CODES.has(after.error)) {
      fail('I2.error_code', after.error, action);
    }
    if (
      after.localDataError !== null &&
      after.localDataError !== 'local_data.unavailable'
    ) {
      fail('I2.local_data_error_code', after.localDataError, action);
    }
    if (
      after.deletionCleanup !== null &&
      !['complete', 'failed', 'not_needed'].includes(after.deletionCleanup)
    ) {
      fail('I2.deletion_cleanup', after.deletionCleanup, action);
    }
    // I3 busy / hydrated
    if (after.busy && inflight(['signInApple', 'signInGoogle']).length === 0) {
      fail(
        'I3.busy_without_sign_in',
        'busy=true with no sign-in in flight',
        action,
      );
    }
    if (before.hydrated && !after.hydrated) {
      fail('I3.hydrated_flipped_back', '', action);
    }
    // I4 vault contents
    const vault = after.vault;
    if (vault.raw !== null && !mockKeychain.injected) {
      const allowedKeys = [
        'version',
        'provider',
        'canonicalAppUserId',
        'refreshToken',
        'email',
        'displayName',
      ];
      if (
        !vault.record ||
        vault.keys.some(k => !allowedKeys.includes(k)) ||
        vault.record.version !== 1 ||
        (vault.record.provider !== 'apple' &&
          vault.record.provider !== 'google') ||
        typeof vault.record.canonicalAppUserId !== 'string' ||
        !UUID_PATTERN.test(vault.record.canonicalAppUserId) ||
        typeof vault.record.refreshToken !== 'string'
      ) {
        fail('I4.vault_shape', vault.raw, action);
      } else {
        const token = vault.record.refreshToken;
        if (
          server.issuedAccess.has(token) ||
          mockProviders.identityTokens.has(token)
        ) {
          fail('I4.vault_holds_access_or_identity_token', token, action);
        } else if (!server.issuedRefresh.has(token)) {
          fail('I4.vault_holds_unissued_token', token, action);
        } else if (
          server.issuedRefresh.get(token) !== vault.record.canonicalAppUserId
        ) {
          fail(
            'I4.vault_token_account_mismatch',
            `${token} belongs to ${server.issuedRefresh.get(token)} but record says ${String(vault.record.canonicalAppUserId)}`,
            action,
          );
        }
      }
    }
    for (const [service, item] of mockKeychain.store) {
      if (service !== SESSION_VAULT_SERVICE) {
        fail('I4.unexpected_keychain_service', service, action);
      }
      for (const access of server.issuedAccess) {
        if (item.password.includes(access)) {
          fail('I4.keychain_contains_access_token', access, action);
        }
      }
      for (const identity of mockProviders.identityTokens) {
        if (item.password.includes(identity)) {
          fail('I4.keychain_contains_identity_token', identity, action);
        }
      }
    }
    // I5 kv never holds tokens
    for (const [key, value] of mockDb.kv) {
      if (key === LEGACY_SESSION_KV_KEY && mockDb.injected) continue;
      for (const access of server.issuedAccess) {
        if (value.includes(access))
          fail('I5.kv_access_token', `${key}=${value}`, action);
      }
      for (const [refresh] of server.issuedRefresh) {
        if (value.includes(refresh))
          fail('I5.kv_refresh_token', `${key}=${value}`, action);
      }
      for (const identity of mockProviders.identityTokens) {
        if (value.includes(identity))
          fail('I5.kv_identity_token', `${key}=${value}`, action);
      }
    }
    // Blanking needs a hydrate() that saw a healthy database from start to
    // end (a broken SQLite never decides anything, including this).
    const blankingHydrate = calls.some(
      c =>
        c.kind === 'hydrate' &&
        c.settled &&
        c.startStep > lastKvInjectStep &&
        !dbFailureSteps.some(s => s >= c.startStep && s <= c.settledAtStep),
    );
    if (
      blankingHydrate &&
      !mockDb.injected &&
      inflight(['hydrate']).length === 0
    ) {
      if (after.kvLegacy !== undefined && after.kvLegacy !== '') {
        fail('I5.legacy_subject_not_blanked', after.kvLegacy, action);
      }
    }
    // I6 ApiSession material
    if (after.api) {
      if (!UUID_PATTERN.test(after.api.account)) {
        fail('I6.api_account_not_uuid', after.api.account, action);
      }
      if (
        !server.issuedAccess.has(after.api.bearer) &&
        !mockProviders.identityTokens.has(after.api.bearer)
      ) {
        fail('I6.api_bearer_unissued', after.api.bearer, action);
      }
      if (
        after.api.refresh !== null &&
        !server.issuedRefresh.has(after.api.refresh)
      ) {
        fail('I6.api_refresh_unissued', after.api.refresh, action);
      }
      if (
        after.api.refresh !== null &&
        server.issuedRefresh.get(after.api.refresh) !== after.api.account
      ) {
        fail('I6.api_refresh_account_mismatch', after.api.refresh, action);
      }
    }
    // I7 the one implicit sign-out
    const refusedRefresh = delivered.some(
      d =>
        d.request.route === 'refresh' && (d.status === 401 || d.status === 403),
    );
    if (isSynced(before.session) && before.sessionKey !== after.sessionKey) {
      const legacyPath =
        legacyExpiryPendingSince >= 0 ||
        (action.kind === 'report401' &&
          before.api !== null &&
          before.api.refresh === null);
      const signInOrRestoreInFlight =
        activeThisStep(['signInApple', 'signInGoogle', 'hydrate']).length > 0;
      const becameNull = after.session === null;
      // A relaunch re-derives the session from durable state; what it must
      // land on is checked when the hydrate settles (I7.hydrate_dropped_*).
      const allowed =
        action.kind === 'signOut' ||
        action.kind === 'deleteAccount' ||
        action.kind === 'hydrate' ||
        action.kind === 'guest' ||
        activeThisStep(['hydrate']).length > 0 ||
        refusedRefresh ||
        legacyPath ||
        (!becameNull && signInOrRestoreInFlight);
      if (!allowed) {
        fail(
          'I7.implicit_sign_out',
          `${before.sessionKey} → ${after.sessionKey ?? 'null'} caused by ${action.kind}; delivered=${delivered.map(d => `${d.request.route}:${d.outcome}`).join(',')}`,
          action,
        );
      }
    }
    if (refusedRefresh) lastRefusalStep = stepIndex;
    // I7 (relaunch): a hydrate that began with a durable record must land
    // signed in unless the server refused the refresh token or the user
    // signed out / deleted / went guest meanwhile.
    for (const call of calls) {
      if (
        call.kind !== 'hydrate' ||
        !call.settled ||
        call.settledAtStep !== stepIndex
      )
        continue;
      if (!call.vaultRecordAtStart || after.session !== null) continue;
      const userEnded = calls.some(
        c =>
          ['signOut', 'deleteAccount', 'guest'].includes(c.kind) &&
          c.startStep >= call.startStep,
      );
      if (userEnded || lastRefusalStep >= call.startStep) continue;
      fail(
        'I7.hydrate_dropped_durable_record',
        `hydrate@${call.startStep} began with a Keychain record (token ${call.vaultTokenAtStart ?? '?'}) and landed signed out; keychain=${mockKeychain.mode} lastKeychainFailure=${mockKeychain.lastFailureStep} vaultNow=${after.vault.record ? 'present' : 'absent'}`,
        action,
      );
    }
    // I8 keeper hygiene on newly issued requests
    const hydrating = activeThisStep(['hydrate']).length > 0;
    for (const request of newRequests) {
      if (request.route === 'refresh') {
        // A relaunch restores whatever account the Keychain record names
        // (the session is set from the record before the keeper starts).
        const sessionAtIssue = hydrating
          ? (after.session ?? before.session)
          : (before.session ?? after.session);
        if (!isSynced(sessionAtIssue)) {
          fail(
            'I8.refresh_while_not_synced',
            `refresh issued with token ${request.refreshTokenSent ?? 'none'} while session=${sessionKeyOf(sessionAtIssue) ?? 'null'}`,
            action,
          );
          continue;
        }
        const owner = request.refreshTokenSent
          ? server.issuedRefresh.get(request.refreshTokenSent)
          : undefined;
        if (
          owner !== undefined &&
          owner !== sessionAtIssue.canonicalAppUserId
        ) {
          fail(
            'I8.refresh_token_of_other_account',
            `${request.refreshTokenSent} belongs to ${owner}, session is ${sessionAtIssue.canonicalAppUserId}`,
            action,
          );
        }
        // The newest token the app held when the request left. With nothing
        // live and no (untouched) vault record, the keeper that a relaunch
        // started still holds the token that relaunch read.
        const latestHydrate = [...calls]
          .reverse()
          .find(
            c => c.kind === 'hydrate' && c.startStep <= request.issuedAtStep,
          );
        const expected =
          request.appTokenAtIssue ?? latestHydrate?.vaultTokenAtStart ?? null;
        if (
          expected !== null &&
          request.refreshTokenSent !== expected &&
          owner === sessionAtIssue.canonicalAppUserId
        ) {
          // Same account but not the newest token the app holds: a spent
          // token being re-sent (the server may have rotated it away).
          fail(
            'I8.refresh_with_spent_token',
            `sent ${request.refreshTokenSent} but current is ${expected}`,
            action,
          );
        }
      }
      if (request.route === 'bootstrap') {
        const legit =
          activeThisStep(['signInApple', 'signInGoogle', 'hydrate']).length >
            0 ||
          legacyExpiryPendingSince >= 0 ||
          action.kind === 'report401';
        if (!legit) {
          fail('I8.bootstrap_without_cause', request.url, action);
        }
      }
    }
    // I9 explicit sign-out wins over an older sign-in / restore
    if (
      isSynced(after.session) &&
      before.sessionKey !== after.sessionKey &&
      lastExplicitSignOutStep >= 0 &&
      !['signInApple', 'signInGoogle', 'hydrate', 'guest'].includes(action.kind)
    ) {
      const causes = activeThisStep(['signInApple', 'signInGoogle', 'hydrate']);
      const legacyCause = legacyRestoreSince >= 0 ? legacyRestoreSince : null;
      const newestCauseStart = Math.max(
        legacyCause ?? -1,
        ...causes.map(c => c.startStep),
      );
      if (newestCauseStart >= 0 && newestCauseStart < lastExplicitSignOutStep) {
        fail(
          'I9.sign_out_overridden_by_stale_sign_in',
          `session became ${after.sessionKey} at step ${stepIndex}; explicit sign-out at step ${lastExplicitSignOutStep}; causing call started at ${newestCauseStart} (${causes.map(c => c.kind).join(',') || 'legacy-401-restore'})`,
          action,
        );
      }
    }
    // I10 promises never reject
    for (const call of calls) {
      if (call.rejected !== null && call.settledAtStep === stepIndex) {
        fail(
          'I10.public_promise_rejected',
          `${call.kind}: ${call.rejected}`,
          action,
        );
      }
    }
  };

  const checkQuiescent = (action: Action, after: Snapshot) => {
    const quiescent = net.pending.length === 0 && inflight().length === 0;
    if (!quiescent) return;
    const session = after.session;
    // Q1 owner
    const expectedOwner =
      session === null
        ? SIGNED_OUT_DATA_OWNER
        : session.localOnly
          ? GUEST_DATA_OWNER
          : (session.canonicalAppUserId ?? '').toLowerCase();
    if (after.owner !== expectedOwner) {
      fail(
        'Q1.owner_mismatch',
        `owner=${after.owner} session=${after.sessionKey ?? 'null'}`,
        action,
      );
    }
    // Q2 api binding
    if (!isSynced(session) && after.api !== null) {
      fail(
        'Q2.api_session_while_not_synced',
        JSON.stringify(after.api),
        action,
      );
    }
    if (
      isSynced(session) &&
      after.api &&
      after.api.account !== session.canonicalAppUserId
    ) {
      fail(
        'Q2.api_session_other_account',
        `${after.api.account} vs ${session.canonicalAppUserId}`,
        action,
      );
    }
    // Q3 busy
    if (after.busy) fail('Q3.stuck_busy', '', action);
    // Q4 vault refresh token === live refresh token
    const keychainClean =
      mockKeychain.lastFailureStep < lastRefreshTokenChangeStep;
    if (
      isSynced(session) &&
      after.api?.refresh &&
      keychainClean &&
      !mockKeychain.injected &&
      mockKeychain.mode === 'ok'
    ) {
      const vaultToken = after.vault.record?.refreshToken;
      if (vaultToken !== after.api.refresh) {
        fail(
          'Q4.vault_refresh_token_stale',
          `vault=${String(vaultToken)} live=${after.api.refresh}`,
          action,
        );
      }
    }
    // Q5 signed out ⇒ vault empty (unless the Keychain failed since)
    if (
      session === null &&
      after.vault.raw !== null &&
      !mockKeychain.injected &&
      mockKeychain.lastFailureStep < lastSessionChangeStep &&
      mockKeychain.mode === 'ok'
    ) {
      fail('Q5.vault_retained_while_signed_out', after.vault.raw, action);
    }
    // Q6 kv local-mode ⇔ guest (db healthy since the session changed)
    const dbClean =
      mockDb.mode === 'ok' &&
      mockDb.lastFailureStep < lastSessionChangeStep &&
      !mockDb.injected;
    if (dbClean && lastSessionChangeStep >= 0) {
      const guestFlag = after.kvLocal === LOCAL_GUEST_VALUE;
      if (session?.localOnly && !guestFlag) {
        fail('Q6.guest_flag_missing', String(after.kvLocal), action);
      }
      if (!session?.localOnly && guestFlag) {
        fail('Q6.guest_flag_retained', String(after.kvLocal), action);
      }
      // Q7 last-provider flag
      if (isSynced(session)) {
        const expected =
          session.provider === 'google' ? LAST_PROVIDER_GOOGLE_VALUE : '';
        const actual = after.kvLast ?? '';
        if (actual !== expected && after.api !== null) {
          // Only after the sign-in itself completed (api installed); a vault
          // restore never rewrites the flag.
          const restoredFromVault = calls.some(
            c =>
              c.kind === 'hydrate' && c.settledAtStep >= lastSessionChangeStep,
          );
          if (!restoredFromVault) {
            fail(
              'Q7.last_provider_flag',
              `expected ${expected || "''"} got ${actual || "''"}`,
              action,
            );
          }
        }
      }
    }
  };

  const checkDeliveryOracles = (
    action: Action,
    before: Snapshot,
    after: Snapshot,
    delivered: Delivered[],
  ) => {
    for (const d of delivered) {
      if (d.request.route !== 'refresh') continue;
      const live = d.request.epoch === mockKeeperEpoch.value;
      const wasCurrent =
        d.request.refreshTokenSent === currentRefreshToken(before);
      if (!live || !wasCurrent || !isSynced(before.session)) continue;
      if (d.status === 401 || d.status === 403) {
        if (
          after.session !== null ||
          after.api !== null ||
          after.owner !== SIGNED_OUT_DATA_OWNER
        ) {
          fail(
            'O1.refused_refresh_not_signed_out',
            `after ${d.outcome}: session=${after.sessionKey ?? 'null'} api=${after.api ? 'set' : 'null'} owner=${after.owner}`,
            action,
          );
        }
        if (after.error !== null) {
          fail('O1.refused_refresh_surfaced_error', after.error, action);
        }
        if (after.vault.raw !== null && mockKeychain.mode === 'ok') {
          fail('O1.refused_refresh_vault_retained', after.vault.raw, action);
        }
      } else if (d.minted) {
        if (after.sessionKey !== before.sessionKey) {
          fail(
            'O2.rotation_changed_session',
            `${before.sessionKey} → ${after.sessionKey}`,
            action,
          );
        }
        if (
          !after.api ||
          after.api.bearer !== d.minted.access ||
          after.api.refresh !== d.minted.refresh
        ) {
          fail(
            'O2.rotation_not_adopted',
            `minted ${d.minted.access}/${d.minted.refresh}, api=${after.api ? `${after.api.bearer}/${after.api.refresh}` : 'null'}`,
            action,
          );
        }
        if (
          mockKeychain.mode === 'ok' &&
          after.vault.record?.refreshToken !== d.minted.refresh
        ) {
          fail(
            'O2.rotation_not_persisted',
            `vault=${String(after.vault.record?.refreshToken)} minted=${d.minted.refresh}`,
            action,
          );
        }
      } else {
        // transient: 5xx / 429 / network / malformed
        if (after.sessionKey !== before.sessionKey) {
          fail(
            'O3.transient_refresh_changed_session',
            `${d.outcome}: ${before.sessionKey} → ${after.sessionKey}`,
            action,
          );
        }
        if (JSON.stringify(after.api) !== JSON.stringify(before.api)) {
          fail('O3.transient_refresh_changed_api_session', d.outcome, action);
        }
        if (after.vault.raw !== before.vault.raw) {
          fail('O3.transient_refresh_changed_vault', d.outcome, action);
        }
      }
    }
  };

  const applyEnv = (target: EnvTarget, mode: string) => {
    switch (target) {
      case 'apple':
        mockProviders.apple = mode as AppleMode;
        installAppleNative();
        break;
      case 'google':
        mockProviders.google = mode as GoogleMode;
        break;
      case 'googleSilent':
        mockProviders.googleSilent = mode as GoogleSilentMode;
        break;
      case 'keychain':
        mockKeychain.mode = mode as KeychainMode;
        break;
      case 'db':
        mockDb.mode = mode as DbMode;
        break;
    }
  };

  const corruptVault = (variant: (typeof VAULT_CORRUPTIONS)[number]) => {
    const record = {
      version: 1,
      provider: 'google',
      canonicalAppUserId: ACCOUNTS.google,
      refreshToken: 'refresh-never-issued',
      email: 'pat@example.com',
      displayName: 'Pat Player',
    };
    let password: string;
    switch (variant) {
      case 'garbage':
        password = '{not json';
        break;
      case 'wrongVersion':
        password = JSON.stringify({ ...record, version: 2 });
        break;
      case 'nonUuidId':
        password = JSON.stringify({
          ...record,
          canonicalAppUserId: 'apple-user-opaque',
        });
        break;
      case 'unknownToken':
        password = JSON.stringify(record);
        break;
      case 'staleToken': {
        // An older (still server-known) token of some account, as if another
        // device rotated this one away.
        const issued = [...server.issuedRefresh.entries()];
        const first = issued[0];
        if (!first) {
          password = JSON.stringify(record);
        } else {
          password = JSON.stringify({
            ...record,
            provider: first[1] === ACCOUNTS.google ? 'google' : 'apple',
            canonicalAppUserId: first[1],
            refreshToken: first[0],
          });
        }
        break;
      }
    }
    mockKeychain.store.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password,
    });
    mockKeychain.injected = true;
  };

  const injectKv = (variant: (typeof KV_INJECTIONS)[number]) => {
    switch (variant) {
      case 'lastProviderGoogle':
        mockDb.kv.set(LAST_PROVIDER_KV_KEY, LAST_PROVIDER_GOOGLE_VALUE);
        break;
      case 'legacySubject':
        mockDb.kv.set(LEGACY_SESSION_KV_KEY, 'legacy-provider-subject');
        break;
      case 'guestMode':
        mockDb.kv.set(LOCAL_MODE_KV_KEY, LOCAL_GUEST_VALUE);
        break;
    }
    mockDb.injected = true;
    lastKvInjectStep = stepIndex;
  };

  const flush = async (): Promise<Delivered[]> => {
    const delivered: Delivered[] = [];
    for (let round = 0; round < 60; round += 1) {
      while (net.pending.length > 0) {
        const request = net.pending[0];
        if (!request) break;
        delivered.push(deliver(request, 0));
        await drainMicrotasks();
      }
      await drainMicrotasks();
      if (inflight().length === 0 && net.pending.length === 0) break;
      await jest.advanceTimersByTimeAsync(1_000);
      await drainMicrotasks();
    }
    return delivered;
  };

  try {
    for (const action of script.actions) {
      count(actionKinds, action.kind);
      net.step = stepIndex;
      mockKeychain.step = stepIndex;
      mockDb.step = stepIndex;
      const before = snapshot();
      const requestsBefore = net.nextId;
      const store = useAuthStore.getState();
      let delivered: Delivered[] = [];
      switch (action.kind) {
        case 'hydrate':
          mockDb.injected = false;
          startCall('hydrate', () => store.hydrate());
          break;
        case 'signInApple':
          startCall('signInApple', () => store.signInWithApple());
          break;
        case 'signInGoogle':
          startCall('signInGoogle', () => store.signInWithGoogle());
          break;
        case 'guest':
          startCall('guest', () => store.continueAsGuest());
          break;
        case 'signOut':
          lastExplicitSignOutStep = stepIndex;
          startCall('signOut', () => store.signOut());
          break;
        case 'deleteAccount':
          lastExplicitSignOutStep = stepIndex;
          startCall('deleteAccount', () => store.completeAccountDeletion());
          break;
        case 'clearError':
          store.clearError();
          break;
        case 'settle': {
          if (net.pending.length > 0) {
            const request = net.pending[action.pick % net.pending.length];
            if (request) delivered = [deliver(request, action.outcome)];
          }
          break;
        }
        case 'advance':
          await jest.advanceTimersByTimeAsync(action.ms);
          break;
        case 'foreground':
          for (const handler of [...appStateHandlers]) handler('active');
          break;
        case 'report401': {
          const api = getApiSession();
          const bearer = action.stale
            ? (bearersSeen.find(b => b !== api?.bearerToken) ??
              'stale-bearer-never-issued')
            : (api?.bearerToken ?? 'stale-bearer-never-issued');
          if (
            api &&
            bearer === api.bearerToken &&
            !api.refreshToken &&
            !before.busy &&
            isSynced(before.session) &&
            before.session.canonicalAppUserId === api.canonicalAppUserId
          ) {
            legacyExpiryPendingSince = stepIndex;
          }
          reportApiUnauthorized(bearer);
          break;
        }
        case 'env':
          applyEnv(action.target, action.mode);
          break;
        case 'corruptVault':
          corruptVault(action.variant);
          break;
        case 'injectKv':
          injectKv(action.variant);
          break;
        case 'flush':
          delivered = await flush();
          break;
      }
      await drainMicrotasks();
      for (const d of delivered)
        count(deliveredOutcomes, `${d.request.route}:${d.outcome}`);
      const newRequests = net.log
        .filter(e => e.id >= requestsBefore)
        .map(e => net.pending.find(r => r.id === e.id) ?? null)
        .filter((r): r is PendingRequest => r !== null);
      for (const e of net.log.filter(e => e.id >= requestsBefore))
        count(requestsByRoute, e.route);
      const after = snapshot();
      if (after.api && !bearersSeen.includes(after.api.bearer))
        bearersSeen.push(after.api.bearer);
      if (before.sessionKey !== after.sessionKey) {
        lastSessionChangeStep = stepIndex;
      }
      if (
        action.kind === 'report401' &&
        newRequests.some(r => r.route === 'bootstrap') &&
        inflight(['signInApple', 'signInGoogle', 'hydrate']).length === 0
      ) {
        legacyRestoreSince = stepIndex;
      }
      if ((before.api?.refresh ?? null) !== (after.api?.refresh ?? null)) {
        lastRefreshTokenChangeStep = stepIndex;
      }
      if (mockDb.lastFailureStep === stepIndex) dbFailureSteps.push(stepIndex);
      // Requests issued this step but already answered (aborted within the
      // step) still count for I8: re-read them from the log.
      const issuedThisStep = net.log
        .filter(e => e.id >= requestsBefore)
        .map(e => ({
          id: e.id,
          route: e.route,
          refreshTokenSent: e.refreshTokenSent,
          appTokenAtIssue: e.appTokenAtIssue,
        }));
      const syntheticNew: PendingRequest[] = issuedThisStep.map(e => {
        const live = newRequests.find(r => r.id === e.id);
        return (
          live ?? {
            id: e.id,
            route: e.route,
            url: e.route,
            refreshTokenSent: e.refreshTokenSent,
            appTokenAtIssue: e.appTokenAtIssue,
            bearer: null,
            provider: null,
            epoch: -1,
            issuedAtStep: stepIndex,
            resolve: () => {},
            reject: () => {},
          }
        );
      });
      checkAlways(action, before, after, delivered, syntheticNew);
      checkDeliveryOracles(action, before, after, delivered);
      checkQuiescent(action, after);
      // Bookkeeping that the oracles above must still see for THIS step.
      if (before.sessionKey !== after.sessionKey) legacyExpiryPendingSince = -1;
      if (
        legacyRestoreSince >= 0 &&
        delivered.some(
          d =>
            d.request.route === 'bootstrap' &&
            d.request.issuedAtStep === legacyRestoreSince,
        )
      ) {
        legacyRestoreSince = -1;
      }
      trace.push(
        `${stepIndex}:${action.kind}${'outcome' in action ? `#${delivered.map(d => `${d.request.route}=${d.outcome}`).join('+') || 'noop'}` : ''} ${digest(after)}`,
      );
      stepIndex += 1;
    }
    // Liveness: after the trailing flush every public promise must be settled.
    const stuck = inflight();
    if (stuck.length > 0) {
      violations.push({
        step: stepIndex,
        invariant: 'I10.public_promise_never_settled',
        detail: stuck.map(c => `${c.kind}@${c.startStep}`).join(','),
        action: '"end"',
      });
    }
  } finally {
    Math.random = REAL_MATH_RANDOM;
  }
  const finalDigest = digest(snapshot());
  return {
    seed: script.seed,
    faults: script.faults,
    length: script.actions.length,
    stepsExecuted: stepIndex,
    violations,
    trace,
    deliveredOutcomes,
    actionKinds,
    requestsByRoute,
    finalDigest,
    durationMs: REAL_NOW() - started,
  };
}

const REAL_NOW: () => number = Date.now.bind(Date);

// ─── Minimization (ddmin over the action list) ───────────────────────────────

async function failsWith(
  actions: Action[],
  script: Script,
): Promise<Violation[]> {
  const withFlush =
    actions[actions.length - 1]?.kind === 'flush'
      ? actions
      : [...actions, { kind: 'flush' as const }];
  const result = await runScript({ ...script, actions: withFlush });
  return result.violations;
}

async function minimize(
  script: Script,
): Promise<{ actions: Action[]; violations: Violation[] }> {
  let current = script.actions.slice(0, -1);
  let best = await failsWith(current, script);
  if (best.length === 0) return { actions: script.actions, violations: [] };
  let n = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / n);
    let reduced = false;
    for (let i = 0; i < current.length; i += chunk) {
      const candidate = [...current.slice(0, i), ...current.slice(i + chunk)];
      if (candidate.length === 0) continue;
      const violations = await failsWith(candidate, script);
      if (violations.length > 0) {
        current = candidate;
        best = violations;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(current.length, n * 2);
    }
  }
  return { actions: [...current, { kind: 'flush' }], violations: best };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const ITER = Number(process.env['STRESS_ITER'] ?? 60);
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? 20260904);
const MIN_LEN = Number(process.env['STRESS_MINLEN'] ?? 5);
const MAX_LEN = Number(process.env['STRESS_MAXLEN'] ?? 60);
const REPLAY = process.env['STRESS_REPLAY'];
/** With STRESS_REPLAY: a JSON action array (e.g. a `minimized` script from
 * the artifact) to run under that seed instead of the generated sequence. */
const REPLAY_SCRIPT = process.env['STRESS_SCRIPT'];
/** Comma-separated invariant prefixes to ignore (e.g. `I9` to look past the
 * known sign-out-vs-in-flight-sign-in race for other classes). */
const SKIP = (process.env['STRESS_SKIP'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const OUT =
  process.env['STRESS_OUT'] ??
  path.resolve(
    __dirname,
    '../../../../artifacts/stress/mod-auth-store/randomized-seeded.json',
  );

const realFetch = globalThis.fetch;

beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask'],
    now: new Date('2026-09-04T12:00:00Z'),
  });
  globalThis.fetch = fakeFetch as typeof fetch;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      const fn = handler as (state: string) => void;
      appStateHandlers.add(fn);
      return { remove: () => appStateHandlers.delete(fn) } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
});

afterAll(() => {
  resetWorld();
  globalThis.fetch = realFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const describeCampaign = REPLAY ? describe.skip : describe;
const describeReplay = REPLAY ? describe : describe.skip;

describeCampaign('authStore randomized seeded stress campaign', () => {
  it(
    `holds every invariant over ${ITER} seeded action sequences (len ${MIN_LEN}-${MAX_LEN}) and replays each seed identically`,
    async () => {
      const rows: Array<{
        seed: number;
        faults: boolean;
        length: number;
        stepsExecuted: number;
        outcome: 'ok' | 'fail';
        violations: string[];
        deterministic: boolean;
        finalDigest: string;
        durationMs: number;
      }> = [];
      const failures: Array<{
        seed: number;
        violations: Violation[];
        minimized: Action[];
        minimizedViolations: Violation[];
        rerunFailRate: string;
        trace: string[];
      }> = [];
      const totals = {
        deliveredOutcomes: {} as Record<string, number>,
        actionKinds: {} as Record<string, number>,
        requestsByRoute: {} as Record<string, number>,
        steps: 0,
        nondeterministic: [] as number[],
      };
      const campaignStart = REAL_NOW();
      for (let i = 0; i < ITER; i += 1) {
        const seed = (BASE_SEED + i) >>> 0;
        const script = generateScript(seed, MIN_LEN, MAX_LEN);
        const first = await runScript(script);
        const second = await runScript(script);
        const deterministic =
          JSON.stringify(first.trace) === JSON.stringify(second.trace) &&
          JSON.stringify(first.violations) ===
            JSON.stringify(second.violations);
        if (!deterministic) totals.nondeterministic.push(seed);
        totals.steps += first.stepsExecuted;
        for (const [k, v] of Object.entries(first.deliveredOutcomes)) {
          totals.deliveredOutcomes[k] = (totals.deliveredOutcomes[k] ?? 0) + v;
        }
        for (const [k, v] of Object.entries(first.actionKinds)) {
          totals.actionKinds[k] = (totals.actionKinds[k] ?? 0) + v;
        }
        for (const [k, v] of Object.entries(first.requestsByRoute)) {
          totals.requestsByRoute[k] = (totals.requestsByRoute[k] ?? 0) + v;
        }
        const failed = first.violations.length > 0;
        rows.push({
          seed,
          faults: script.faults,
          length: script.actions.length,
          stepsExecuted: first.stepsExecuted,
          outcome: failed ? 'fail' : 'ok',
          violations: [...new Set(first.violations.map(v => v.invariant))],
          deterministic,
          finalDigest: first.finalDigest,
          durationMs: first.durationMs,
        });
        if (failed) {
          let rerunFailures = 0;
          for (let r = 0; r < 10; r += 1) {
            const rerun = await runScript(script);
            if (rerun.violations.length > 0) rerunFailures += 1;
          }
          const minimized = await minimize(script);
          failures.push({
            seed,
            violations: first.violations,
            minimized: minimized.actions,
            minimizedViolations: minimized.violations,
            rerunFailRate: `${rerunFailures}/10`,
            trace: first.trace,
          });
        }
      }
      const summary = {
        unit: 'mod-auth-store',
        lens: 'randomized-seeded',
        file: 'apps/mobile/__tests__/stress/authStoreRandomized.stress.test.ts',
        node: process.version,
        baseSeed: BASE_SEED,
        iterations: ITER,
        lengthRange: [MIN_LEN, MAX_LEN],
        sequencesExecuted: rows.length,
        stepsExecuted: totals.steps,
        determinismReplays: rows.length,
        nondeterministicSeeds: totals.nondeterministic,
        failingSeeds: failures.map(f => f.seed),
        violationHistogram: rows
          .flatMap(r => r.violations)
          .reduce<Record<string, number>>((acc, v) => {
            acc[v] = (acc[v] ?? 0) + 1;
            return acc;
          }, {}),
        actionKinds: totals.actionKinds,
        deliveredOutcomes: totals.deliveredOutcomes,
        requestsByRoute: totals.requestsByRoute,
        wallMs: REAL_NOW() - campaignStart,
        failures,
        rows,
      };
      fs.mkdirSync(path.resolve(OUT, '..'), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
      console.log(
        `[stress mod-auth-store randomized-seeded] seqs=${rows.length} steps=${totals.steps} failing=${failures.length} nondeterministic=${totals.nondeterministic.length} out=${OUT}`,
      );
      expect(totals.nondeterministic).toEqual([]);
      expect(
        failures.map(f => ({ seed: f.seed, first: f.violations[0] })),
      ).toEqual([]);
    },
    60 * 60_000,
  );
});

/**
 * Minimized scripts the campaign reduced every I9 failure to. They pin the
 * contract stated at `signOut` ("the next launch must not restore an account
 * the user just signed out of") for a sign-in whose bootstrap response lands
 * AFTER the explicit sign-out. Kept as explicit scripts so the race is
 * replayable without a seed.
 */
describeCampaign(
  'authStore explicit sign-out vs in-flight sign-in (minimized from the campaign)',
  () => {
    const bootstrap = (outcome: number): Action => ({
      kind: 'settle',
      pick: 0,
      outcome,
    });
    const OK = BOOTSTRAP_OUTCOMES.indexOf('ok');
    const OK_LEGACY = BOOTSTRAP_OUTCOMES.indexOf('ok_legacy');

    it.each([
      [
        'apple',
        [
          { kind: 'signInApple' },
          { kind: 'signOut' },
          bootstrap(OK),
          { kind: 'flush' },
        ],
      ],
      [
        'google',
        [
          { kind: 'signInGoogle' },
          { kind: 'signOut' },
          bootstrap(OK),
          { kind: 'flush' },
        ],
      ],
      [
        'apple → completeAccountDeletion',
        [
          { kind: 'signInApple' },
          { kind: 'deleteAccount' },
          bootstrap(OK),
          { kind: 'flush' },
        ],
      ],
    ] as Array<[string, Action[]]>)(
      'a sign-out issued while %s sign-in awaits bootstrap wins over the late response',
      async (_label, actions) => {
        const result = await runScript({ seed: 0, faults: false, actions });
        expect(result.violations).toEqual([]);
        expect(result.finalDigest).toContain('"s":null');
        expect(result.finalDigest).toContain('"v":null');
      },
    );

    it('a sign-out issued during the legacy-401 silent Google restore wins over the late bootstrap', async () => {
      const actions: Action[] = [
        { kind: 'env', target: 'googleSilent', mode: 'success' },
        { kind: 'signInGoogle' },
        bootstrap(OK_LEGACY),
        { kind: 'report401', stale: false },
        { kind: 'signOut' },
        bootstrap(OK),
        { kind: 'flush' },
      ];
      const result = await runScript({ seed: 0, faults: false, actions });
      expect(result.violations).toEqual([]);
      expect(result.finalDigest).toContain('"s":null');
      expect(result.finalDigest).toContain('"v":null');
    });
  },
);

/**
 * Minimized script the campaign reduced every `I7.hydrate_dropped_durable_record`
 * failure to: a launch whose Keychain READ fails (the record is intact and is
 * read fine on the next launch) lands signed out for the whole run —
 * `loadPersistedSession` maps the read error to "nothing stored".
 */
describeCampaign(
  'authStore relaunch with an unreadable Keychain (minimized from the campaign)',
  () => {
    it.each([
      ['apple', { kind: 'signInApple' }],
      ['google', { kind: 'signInGoogle' }],
    ] as Array<[string, Action]>)(
      'a %s user whose Keychain record cannot be read at launch stays signed in',
      async (_label, signIn) => {
        const actions: Action[] = [
          signIn,
          { kind: 'flush' },
          { kind: 'env', target: 'keychain', mode: 'getFails' },
          { kind: 'hydrate' },
          { kind: 'flush' },
        ];
        const result = await runScript({ seed: 0, faults: false, actions });
        expect(result.violations).toEqual([]);
        expect(result.finalDigest).not.toContain('"s":null');
      },
    );
  },
);

describeReplay('authStore randomized seeded stress replay', () => {
  it(
    `replays seed ${REPLAY} with a full trace`,
    async () => {
      const seed = Number(REPLAY) >>> 0;
      const script: Script = REPLAY_SCRIPT
        ? { seed, faults: true, actions: JSON.parse(REPLAY_SCRIPT) as Action[] }
        : generateScript(seed, MIN_LEN, MAX_LEN);
      const result = await runScript(script);
      console.log(
        JSON.stringify(
          {
            seed,
            actions: script.actions,
            trace: result.trace,
            violations: result.violations,
          },
          null,
          2,
        ),
      );
      expect(result.violations).toEqual([]);
    },
    10 * 60_000,
  );
});
