/**
 * STRESS / failure-injection — authStore (hydrate, sign-in/out, one implicit
 * sign-out rule) against every dependency the store actually reaches:
 * fetch (bootstrap / refresh / logout routes), SQLite (`LocalDb`), the
 * Keychain vault (`react-native-keychain`), the native Apple module, the
 * Google Sign-In SDK, runtime/auth config, device context, the clock, and the
 * lazily loaded RevenueCat SDK. Camera / Vision / TTS / permissions /
 * navigation are not reachable from this unit and are not simulated.
 *
 * Every iteration is a pure function of its seed: seed → primary fault (seed
 * mod catalog size, so a consecutive seed range covers the whole catalog) →
 * flow → solo or 1–2 extra faults on other seams (alternating in
 * catalog-sized seed blocks) → parameters. The real authStore, sessionVault,
 * sessionKeeper, sessionLifecycle, apiSession and bootstrap modules run;
 * only the dependency edges are faked so throw / reject / timeout /
 * malformed / partial / slow / never-resolves can be injected per seam.
 *
 * Invariants (per iteration, after the flow settles or 60s of fake time):
 *  settles     — the flow's promise settled within 60s of fake time
 *  no-spinner  — busy=false and hydrated=true once 60s have elapsed
 *  no-throw    — store methods never reject; no unhandled rejections
 *  visible     — a failed sign-in leaves a non-null error (no silent failure)
 *  honest      — a synced session exists only if the server accepted the
 *                identity (no fake success)
 *  consistent  — store.session ↔ ApiSession ↔ active data owner agree
 *  vault       — the Keychain record is absent or a well-formed record whose
 *                refresh token the server issued; never an access/identity
 *                token; SQLite kv never holds identity material
 *  one-rule    — a durable session ends implicitly ONLY on a 401/403 refresh
 *  storm       — ≤ 6 refresh calls per 60s (backoff is 5s·2^n)
 *  launch-wait — hydrate with a readable record settles within ~8s + slow
 *                dependency delays
 *
 * Known reproducible failures are pinned in KNOWN_ISSUES (xfail semantics):
 * the suite fails if one stops reproducing (prune the entry) or if any
 * unexpected violation shows up.
 *
 * Scale:  STRESS_ITER=<n>      iterations (default 272 = 2×catalog → every
 *                              fault once solo and once combined)
 *         STRESS_SEED=<n>      first seed (default 20260904)
 * Replay: STRESS_ONLY_SEED=<seed>
 * Output: STRESS_OUT=<dir>     JSON result table (seed → outcome)
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import {
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
import { clearSyncRuntime } from '../../src/data/syncRuntime';

// Node built-ins for the result table. The mobile tsconfig excludes node
// typings (see __tests__/matrix/networkAuthMatrix.test.ts), so the shims
// stay local.
declare const require: (id: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const STRESS_ITER = Number(process.env.STRESS_ITER ?? 272);
const STRESS_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const ONLY_SEED = process.env.STRESS_ONLY_SEED
  ? Number(process.env.STRESS_ONLY_SEED)
  : null;
const OUT_DIR = process.env.STRESS_OUT ?? null;

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = (seed ^ 0x9e3779b9) >>> 0;
  }
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_TIME_MS = Date.parse('2026-09-04T12:00:00Z');
const CANONICAL_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const CANONICAL_B = '0d1a3c6e-5b7f-4a1d-9c2e-8f4b6a7d9e01';
const LOCAL_MODE_KEY = 'auth.local-mode';
const LAST_PROVIDER_KEY = 'auth.last-provider';
const LEGACY_SESSION_KEY = 'auth.session';
const GUEST_FLAG = JSON.stringify({ version: 1, mode: 'guest' });
const GOOGLE_FLAG = JSON.stringify({ version: 1, provider: 'google' });
const SETTLE_BUDGET_MS = 60_000;
const SETTLE_STEP_MS = 500;
const LAUNCH_REFRESH_WAIT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ─── Dependency controllers (referenced from hoisted jest.mock factories) ────

type Never = 'hang';
type Delay = { slowMs: number };

type KeychainGetMode =
  | 'ok'
  | 'false'
  | 'throwSync'
  | 'reject'
  | Never
  | 'slow'
  | 'missingFn'
  | { corrupt: string | number };
type KeychainWriteMode =
  | 'ok'
  | 'false'
  | 'throwSync'
  | 'reject'
  | Never
  | 'slow'
  | 'missingFn'
  | 'missingAccessible';

const mockVault = new Map<string, { username: string; password: string }>();
const mockKeychain: {
  get: KeychainGetMode;
  set: KeychainWriteMode;
  reset: KeychainWriteMode;
} & Delay = { get: 'ok', set: 'ok', reset: 'ok', slowMs: 3_000 };

function mockDelay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
function mockHang<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

jest.mock('react-native-keychain', () => {
  const ACCESSIBLE = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  };
  const getGenericPassword = async (options: { service: string }) => {
    const mode = mockKeychain.get;
    if (mode === 'throwSync') throw new Error('keychain: sync failure');
    if (mode === 'reject') {
      await Promise.resolve();
      throw new Error('keychain: errSecInteractionNotAllowed');
    }
    if (mode === 'hang') return mockHang();
    if (mode === 'slow') await mockDelay(mockKeychain.slowMs);
    if (mode === 'false') return false;
    if (typeof mode === 'object') {
      return { username: 'session', password: mode.corrupt };
    }
    return mockVault.get(options.service) ?? false;
  };
  const setGenericPassword = async (
    username: string,
    password: string,
    options: { service: string },
  ) => {
    const mode = mockKeychain.set;
    if (mode === 'throwSync') throw new Error('keychain: sync failure');
    if (mode === 'reject') {
      await Promise.resolve();
      throw new Error('keychain: errSecIO');
    }
    if (mode === 'hang') return mockHang();
    if (mode === 'slow') await mockDelay(mockKeychain.slowMs);
    if (mode === 'false') return false;
    mockVault.set(options.service, { username, password });
    return { service: options.service, storage: 'keychain' };
  };
  const resetGenericPassword = async (options: { service: string }) => {
    const mode = mockKeychain.reset;
    if (mode === 'throwSync') throw new Error('keychain: sync failure');
    if (mode === 'reject') {
      await Promise.resolve();
      throw new Error('keychain: errSecItemNotFound');
    }
    if (mode === 'hang') return mockHang();
    if (mode === 'slow') await mockDelay(mockKeychain.slowMs);
    if (mode === 'false') return false;
    mockVault.delete(options.service);
    return true;
  };
  return {
    get ACCESSIBLE() {
      return mockKeychain.set === 'missingAccessible' ? undefined : ACCESSIBLE;
    },
    get getGenericPassword() {
      return mockKeychain.get === 'missingFn' ? undefined : getGenericPassword;
    },
    get setGenericPassword() {
      return mockKeychain.set === 'missingFn' ? undefined : setGenericPassword;
    },
    get resetGenericPassword() {
      return mockKeychain.reset === 'missingFn'
        ? undefined
        : resetGenericPassword;
    },
  };
});

type DbOpenMode = 'ok' | 'throw' | 'throwAfterFirst';
type DbOpMode = 'ok' | 'reject' | 'throwSync' | Never | 'slow' | 'malformed';
type DbPurgeMode = 'ok' | 'reject' | 'rejectTwice' | Never;

const mockKv = new Map<string, string>();
const mockDb: {
  open: DbOpenMode;
  read: DbOpMode;
  write: DbOpMode;
  purge: DbPurgeMode;
  opens: number;
  purgeAttempts: number;
  deletes: number;
} & Delay = {
  open: 'ok',
  read: 'ok',
  write: 'ok',
  purge: 'ok',
  opens: 0,
  purgeAttempts: 0,
  deletes: 0,
  slowMs: 3_000,
};

async function mockDbFault(mode: DbOpMode, label: string): Promise<void> {
  if (mode === 'throwSync') throw new Error(`sqlite ${label}: sync failure`);
  if (mode === 'reject') {
    await Promise.resolve();
    throw new Error(`sqlite ${label}: SQLITE_BUSY`);
  }
  if (mode === 'hang') return mockHang();
  if (mode === 'slow') await mockDelay(mockDb.slowMs);
}

function mockCurrentDb(): LocalDb {
  mockDb.opens += 1;
  if (mockDb.open === 'throw') throw new Error('sqlite: cannot open');
  if (mockDb.open === 'throwAfterFirst' && mockDb.opens > 1) {
    throw new Error('sqlite: cannot open (later)');
  }
  return {
    execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        return (async () => {
          await mockDbFault(mockDb.read, 'read');
          const value = mockKv.get(String(params[0]));
          if (mockDb.read === 'malformed') {
            return { rows: [{ value: { nested: true } }, { value: 7 }] };
          }
          return { rows: value === undefined ? [] : [{ value }] };
        })();
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        return (async () => {
          await mockDbFault(mockDb.write, 'write');
          mockKv.set(String(params[0]), String(params[1]));
          return { rows: [] };
        })();
      }
      if (statement.startsWith('DELETE')) {
        return (async () => {
          mockDb.deletes += 1;
          if (mockDb.purge === 'hang') return mockHang();
          if (
            mockDb.purge === 'reject' ||
            (mockDb.purge === 'rejectTwice' && mockDb.purgeAttempts <= 2)
          ) {
            await Promise.resolve();
            throw new Error('sqlite delete: SQLITE_IOERR');
          }
          return { rows: [] };
        })();
      }
      if (statement.startsWith('BEGIN')) mockDb.purgeAttempts += 1;
      return Promise.resolve({ rows: [] });
    },
    close() {},
  } as unknown as LocalDb;
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

type GoogleCall =
  | 'ok'
  | 'reject'
  | 'throwSync'
  | Never
  | 'slow'
  | 'cancelled'
  | 'noCredential'
  | 'nullToken'
  | 'malformed';
const mockGoogle: {
  moduleMissing: boolean;
  configure: 'ok' | 'throwSync';
  hasPlayServices: 'ok' | 'reject';
  hasPreviousSignIn: boolean | 'throwSync';
  signIn: GoogleCall;
  signInSilently: GoogleCall;
  signOut: 'ok' | 'reject' | Never;
  revokeAccess: 'ok' | 'reject';
  idToken: string;
} & Delay = {
  moduleMissing: false,
  configure: 'ok',
  hasPlayServices: 'ok',
  hasPreviousSignIn: false,
  signIn: 'ok',
  signInSilently: 'ok',
  signOut: 'ok',
  revokeAccess: 'ok',
  idToken: 'google-id-token',
  slowMs: 3_000,
};

async function mockGoogleResponse(mode: GoogleCall) {
  if (mode === 'throwSync') throw new Error('google sdk: sync failure');
  if (mode === 'reject') {
    await Promise.resolve();
    throw Object.assign(new Error('google sdk: SIGN_IN_REQUIRED'), {
      code: 'SIGN_IN_REQUIRED',
    });
  }
  if (mode === 'hang') return mockHang();
  if (mode === 'slow') await mockDelay(mockGoogle.slowMs);
  if (mode === 'cancelled') return { type: 'cancelled', data: null };
  if (mode === 'noCredential') {
    return { type: 'noSavedCredentialFound', data: null };
  }
  if (mode === 'malformed') return { type: 'success' };
  return {
    type: 'success',
    data: {
      idToken: mode === 'nullToken' ? null : mockGoogle.idToken,
      serverAuthCode: null,
      scopes: [],
      user: {
        id: 'google-uid-1',
        name: 'Pat Player',
        email: 'pat@gmail.example',
        photo: null,
        familyName: 'Player',
        givenName: 'Pat',
      },
    },
  };
}

jest.mock('@react-native-google-signin/google-signin', () => {
  const GoogleSignin = {
    configure: () => {
      if (mockGoogle.configure === 'throwSync') {
        throw new Error('google sdk: configure failed');
      }
    },
    hasPlayServices: async () => {
      if (mockGoogle.hasPlayServices === 'reject') {
        throw new Error('google sdk: PLAY_SERVICES_NOT_AVAILABLE');
      }
      return true;
    },
    hasPreviousSignIn: () => {
      if (mockGoogle.hasPreviousSignIn === 'throwSync') {
        throw new Error('google sdk: hasPreviousSignIn failed');
      }
      return mockGoogle.hasPreviousSignIn;
    },
    signIn: () => mockGoogleResponse(mockGoogle.signIn),
    signInSilently: () => mockGoogleResponse(mockGoogle.signInSilently),
    signOut: async () => {
      if (mockGoogle.signOut === 'reject') {
        throw new Error('google sdk: signOut failed');
      }
      if (mockGoogle.signOut === 'hang') return mockHang();
      return null;
    },
    revokeAccess: async () => {
      if (mockGoogle.revokeAccess === 'reject') {
        throw new Error('google sdk: revokeAccess failed');
      }
      return null;
    },
  };
  return {
    get GoogleSignin() {
      if (mockGoogle.moduleMissing) {
        throw new Error(
          "Cannot find module '@react-native-google-signin/google-signin'",
        );
      }
      return GoogleSignin;
    },
  };
});

const mockRevenueCat = { moduleMissing: false, loads: 0 };
jest.mock('react-native-purchases', () => ({
  get default() {
    mockRevenueCat.loads += 1;
    if (mockRevenueCat.moduleMissing) {
      throw new Error("Cannot find module 'react-native-purchases'");
    }
    return {};
  },
}));

const mockConfig: {
  apiBaseUrl: string | null;
  throws: boolean;
  googleWebClientId: string | null;
  googleIosClientId: string | null;
} = {
  apiBaseUrl: 'https://api.example.test',
  throws: false,
  googleWebClientId: 'test-web-client.apps.googleusercontent.com',
  googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
};
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => {
    if (mockConfig.throws) throw new Error('runtime config unavailable');
    return {
      apiBaseUrl: mockConfig.apiBaseUrl,
      revenueCatPublicSdkKey: 'appl_test',
      googleIosClientId: mockConfig.googleIosClientId,
      googleWebClientId: mockConfig.googleWebClientId,
      appVersion: '1.0',
      legalPrivacyUrl: null,
      legalTermsUrl: null,
      appStoreId: null,
      appStoreWriteReviewUrl: null,
    };
  },
}));
jest.mock('../../src/config/authConfig', () => ({
  get GOOGLE_WEB_CLIENT_ID() {
    return mockConfig.googleWebClientId;
  },
  get GOOGLE_IOS_CLIENT_ID() {
    return mockConfig.googleIosClientId;
  },
}));

const mockDevice = { throws: false };
jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => {
    if (mockDevice.throws) throw new Error('device context unavailable');
    return {
      locale: 'en-US',
      timezone: 'America/Los_Angeles',
      device: {
        platform: 'ios',
        osVersion: '18.5',
        appVersion: '1.0',
        model: 'iOS phone',
      },
    };
  },
}));

// ─── Native Apple module ─────────────────────────────────────────────────────

type AppleMode =
  | 'ok'
  | 'moduleMissing'
  | 'methodMissing'
  | 'throwSync'
  | 'rejectCanceled'
  | 'rejectGeneric'
  | 'rejectString'
  | Never
  | 'slow'
  | 'nullToken'
  | 'emptyToken'
  | 'resolveNull'
  | 'resolveEmpty';
const apple: { mode: AppleMode; identityToken: string } & Delay = {
  mode: 'ok',
  identityToken: 'apple-identity-token',
  slowMs: 3_000,
};

function installAppleNative(): void {
  const modules = NativeModules as { PickleAuth?: unknown };
  if (apple.mode === 'moduleMissing') {
    delete modules.PickleAuth;
    return;
  }
  if (apple.mode === 'methodMissing') {
    modules.PickleAuth = {};
    return;
  }
  modules.PickleAuth = {
    signInWithApple: () => {
      if (apple.mode === 'throwSync') throw new Error('apple: sync failure');
      return (async () => {
        if (apple.mode === 'rejectCanceled') {
          throw Object.assign(new Error('Sign-in canceled.'), {
            code: 'auth.canceled',
          });
        }
        if (apple.mode === 'rejectGeneric') {
          throw new Error('ASAuthorizationError 1000');
        }
        if (apple.mode === 'rejectString') throw 'apple failed';
        if (apple.mode === 'hang') return mockHang();
        if (apple.mode === 'slow') await mockDelay(apple.slowMs);
        if (apple.mode === 'resolveNull') return null;
        if (apple.mode === 'resolveEmpty') return {};
        return {
          user: 'apple-user-1',
          identityToken:
            apple.mode === 'nullToken'
              ? null
              : apple.mode === 'emptyToken'
                ? '   '
                : apple.identityToken,
          authorizationCode: 'apple-auth-code',
          email: 'pat@example.com',
          givenName: 'Pat',
          familyName: 'Player',
        };
      })();
    },
  };
}

// ─── Fake server (fetch) ─────────────────────────────────────────────────────

type Route = 'bootstrap' | 'refresh' | 'logout' | 'other';
type RouteMode =
  | { kind: 'ok' }
  | { kind: 'reject' }
  | { kind: 'rejectString' }
  | { kind: 'throwSync' }
  | { kind: 'hang' } // abort-aware: rejects once the caller's AbortController fires
  | { kind: 'slow'; ms: number; then: RouteMode }
  | { kind: 'status'; status: number; body?: unknown }
  | {
      kind: 'body';
      body: (tokens: IssuedTokens) => unknown;
      /** The server accepted the identity (a legacy-shaped success). */
      accepted?: boolean;
    }
  | { kind: 'jsonRejects' }
  | { kind: 'jsonThrowsSync' };

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const server: {
  routes: Record<Route, RouteMode>;
  calls: Record<Route, number>;
  issuedAccess: Set<string>;
  issuedRefresh: Set<string>;
  acceptedBootstraps: number;
  acceptedRefreshes: number;
  /** Server clock is truth; the device clock may be skewed against it. */
  nowMs: number;
  expiresInSec: number;
  userId: string;
  seq: number;
  refreshTokensSeen: string[];
} = {
  routes: {
    bootstrap: { kind: 'ok' },
    refresh: { kind: 'ok' },
    logout: { kind: 'ok' },
    other: { kind: 'reject' },
  },
  calls: { bootstrap: 0, refresh: 0, logout: 0, other: 0 },
  issuedAccess: new Set(),
  issuedRefresh: new Set(),
  acceptedBootstraps: 0,
  acceptedRefreshes: 0,
  nowMs: BASE_TIME_MS,
  expiresInSec: 3600,
  userId: CANONICAL_A,
  seq: 0,
  refreshTokensSeen: [],
};

function issueTokens(): IssuedTokens {
  server.seq += 1;
  const tokens = {
    accessToken: `access-${server.seq}`,
    refreshToken: `refresh-${server.seq}`,
    expiresAt: Math.floor(server.nowMs / 1000) + server.expiresInSec,
  };
  server.issuedAccess.add(tokens.accessToken);
  server.issuedRefresh.add(tokens.refreshToken);
  return tokens;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function okBody(route: Route, tokens: IssuedTokens): unknown {
  if (route === 'bootstrap') {
    server.acceptedBootstraps += 1;
    return {
      user: { id: server.userId, email: 'pat@example.com' },
      onboardingState: 'complete',
      session: tokens,
    };
  }
  if (route === 'refresh') {
    server.acceptedRefreshes += 1;
    return { session: tokens };
  }
  return { ok: true };
}

function abortAware(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(
        Object.assign(new Error('The operation was aborted.'), {
          name: 'AbortError',
        }),
      );
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort);
  });
}

async function serve(
  route: Route,
  mode: RouteMode,
  init: RequestInit | undefined,
): Promise<Response> {
  switch (mode.kind) {
    case 'ok':
      return jsonResponse(okBody(route, issueTokens()));
    case 'reject':
      await Promise.resolve();
      throw new TypeError('Network request failed');
    case 'rejectString':
      await Promise.resolve();
      throw 'network down';
    case 'throwSync':
      throw new TypeError('fetch: sync failure');
    case 'hang':
      return abortAware(init?.signal);
    case 'slow':
      await mockDelay(mode.ms);
      return serve(route, mode.then, init);
    case 'status':
      return jsonResponse(
        mode.body ?? { error: { message: `server said ${mode.status}` } },
        mode.status,
      );
    case 'body':
      if (mode.accepted && route === 'bootstrap')
        server.acceptedBootstraps += 1;
      return jsonResponse(mode.body(issueTokens()));
    case 'jsonRejects':
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      } as unknown as Response;
    case 'jsonThrowsSync':
      return {
        ok: true,
        status: 200,
        json: () => {
          throw new SyntaxError('body already consumed');
        },
      } as unknown as Response;
  }
}

function routeOf(url: string): Route {
  if (url.endsWith('/v1/account/bootstrap')) return 'bootstrap';
  if (url.endsWith('/v1/auth/refresh')) return 'refresh';
  if (url.endsWith('/v1/auth/logout')) return 'logout';
  return 'other';
}

function installFetch(): void {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const route = routeOf(url);
    server.calls[route] += 1;
    if (route === 'refresh' && typeof init?.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as { refreshToken?: unknown };
        if (typeof parsed.refreshToken === 'string') {
          server.refreshTokensSeen.push(parsed.refreshToken);
        }
      } catch {
        // not under test
      }
    }
    const mode = server.routes[route];
    if (mode.kind === 'throwSync') throw new TypeError('fetch: sync failure');
    return serve(route, mode, init);
  }) as unknown as typeof fetch;
}

// ─── Fault catalog ───────────────────────────────────────────────────────────

type Flow =
  | 'hydrate.empty'
  | 'hydrate.guest'
  | 'hydrate.vault'
  | 'hydrate.legacyGoogle'
  | 'signIn.apple'
  | 'signIn.google'
  | 'signOut'
  | 'delete'
  | 'unauthorized'
  | 'rotation'
  | 'doubleTap'
  | 'signOutDuringRestore'
  | 'signInDuringHydrate';

const FLOWS: readonly Flow[] = [
  'hydrate.empty',
  'hydrate.guest',
  'hydrate.vault',
  'hydrate.legacyGoogle',
  'signIn.apple',
  'signIn.google',
  'signOut',
  'delete',
  'unauthorized',
  'rotation',
  'doubleTap',
  'signOutDuringRestore',
  'signInDuringHydrate',
];

const HYDRATE_FLOWS: readonly Flow[] = [
  'hydrate.empty',
  'hydrate.guest',
  'hydrate.vault',
  'hydrate.legacyGoogle',
];
const SIGN_IN_FLOWS: readonly Flow[] = ['signIn.apple', 'signIn.google'];
const REFRESH_FLOWS: readonly Flow[] = [
  'hydrate.vault',
  'unauthorized',
  'rotation',
];
const PERSIST_FLOWS: readonly Flow[] = [
  ...SIGN_IN_FLOWS,
  'hydrate.legacyGoogle',
  'hydrate.vault',
  'rotation',
  'unauthorized',
];
const CLEAR_FLOWS: readonly Flow[] = [
  'signOut',
  'delete',
  'signOutDuringRestore',
];
const BOOTSTRAP_FLOWS: readonly Flow[] = [
  ...SIGN_IN_FLOWS,
  'hydrate.legacyGoogle',
  'doubleTap',
];

type Seam =
  | 'keychain.get'
  | 'keychain.set'
  | 'keychain.reset'
  | 'db.open'
  | 'db.read'
  | 'db.write'
  | 'db.purge'
  | 'fetch.bootstrap'
  | 'fetch.refresh'
  | 'fetch.logout'
  | 'apple'
  | 'google'
  | 'config'
  | 'device'
  | 'clock'
  | 'revenuecat';

/** What the oracle needs to know about a fault's effect. */
interface Hints {
  /** The Keychain record cannot be read (or parses to nothing). */
  vaultUnreadable?: boolean;
  /** The record parses but its canonical id is not a UUID. */
  vaultNonUuid?: boolean;
  /** Effect on /v1/auth/refresh. */
  refresh?: 'transient' | 'revoked' | 'slow-ok' | 'slow-transient';
  refreshSlowMs?: number;
  /** Effect on /v1/account/bootstrap. */
  bootstrap?: 'fail' | 'legacy' | 'slow-ok';
  bootstrapSlowMs?: number;
  /** No usable API in this build. */
  notConfigured?: boolean;
  /** Runtime config module throws (generic failure, not a config error). */
  configThrows?: boolean;
  /** Device context cannot be read (generic bootstrap failure). */
  deviceFails?: boolean;
  /** Interactive provider effect. */
  provider?: 'fail' | 'canceled' | 'notConfigured' | 'hang' | 'slow';
  providerSlowMs?: number;
  /** Silent Google restore effect. */
  silent?: 'none' | 'noCredential' | 'transient';
  kcSet?: 'fail' | 'hang' | 'slow';
  kcReset?: 'fail' | 'hang' | 'slow';
  dbOpen?: 'fail' | 'failLater';
  dbRead?: 'fail' | 'hang' | 'slow' | 'malformed';
  dbWrite?: 'fail' | 'hang' | 'slow';
  purge?: 'fail' | 'recover' | 'hang';
  clockSkewMs?: number;
  extraDelayMs?: number;
}

interface Fault {
  id: string;
  seam: Seam;
  flows: readonly Flow[];
  apply(rng: Rng): Hints;
}

const SLOW_CHOICES = [1_000, 2_500, 4_000, 7_000] as const;
const TRANSIENT_STATUSES = [429, 500, 502, 503, 504] as const;
const NON_AUTH_CLIENT_STATUSES = [400, 404, 409, 422] as const;
const REVOKED_STATUSES = [401, 403] as const;

function keychainGetCorruption(id: string, payload: string | number): Fault {
  return {
    id,
    seam: 'keychain.get',
    flows: ['hydrate.vault'],
    apply: () => {
      mockKeychain.get = { corrupt: payload };
      return { vaultUnreadable: true };
    },
  };
}

function validRecord(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    provider: 'apple',
    canonicalAppUserId: CANONICAL_A,
    refreshToken: 'refresh-seeded',
    email: 'pat@example.com',
    displayName: 'Pat Player',
    ...overrides,
  });
}

const CATALOG: readonly Fault[] = [
  // ── Keychain: read ──
  {
    id: 'kc.get.throwSync',
    seam: 'keychain.get',
    flows: ['hydrate.vault'],
    apply: () => ((mockKeychain.get = 'throwSync'), { vaultUnreadable: true }),
  },
  {
    id: 'kc.get.reject',
    seam: 'keychain.get',
    flows: ['hydrate.vault'],
    apply: () => ((mockKeychain.get = 'reject'), { vaultUnreadable: true }),
  },
  {
    id: 'kc.get.hang',
    seam: 'keychain.get',
    flows: HYDRATE_FLOWS,
    apply: () => ((mockKeychain.get = 'hang'), { extraDelayMs: Infinity }),
  },
  {
    id: 'kc.get.slow',
    seam: 'keychain.get',
    flows: HYDRATE_FLOWS,
    apply: rng => {
      mockKeychain.get = 'slow';
      mockKeychain.slowMs = rng.pick(SLOW_CHOICES);
      return { extraDelayMs: mockKeychain.slowMs };
    },
  },
  {
    id: 'kc.get.false',
    seam: 'keychain.get',
    flows: ['hydrate.vault'],
    apply: () => ((mockKeychain.get = 'false'), { vaultUnreadable: true }),
  },
  {
    id: 'kc.get.missingFn',
    seam: 'keychain.get',
    flows: ['hydrate.vault'],
    apply: () => ((mockKeychain.get = 'missingFn'), { vaultUnreadable: true }),
  },
  keychainGetCorruption('kc.get.malformedJson', '{"version":1,"provider":'),
  keychainGetCorruption('kc.get.nullJson', 'null'),
  keychainGetCorruption('kc.get.arrayJson', '[1,2,3]'),
  keychainGetCorruption('kc.get.numberPassword', 42),
  keychainGetCorruption(
    'kc.get.partialNoRefresh',
    validRecord({ refreshToken: undefined }),
  ),
  keychainGetCorruption(
    'kc.get.emptyRefresh',
    validRecord({ refreshToken: '' }),
  ),
  keychainGetCorruption('kc.get.wrongVersion', validRecord({ version: 2 })),
  keychainGetCorruption(
    'kc.get.badProvider',
    validRecord({ provider: 'facebook' }),
  ),
  keychainGetCorruption(
    'kc.get.numericId',
    validRecord({ canonicalAppUserId: 12345 }),
  ),
  keychainGetCorruption('kc.get.huge', 'x'.repeat(2_000_000)),
  {
    id: 'kc.get.nonUuidId',
    seam: 'keychain.get',
    flows: ['hydrate.vault'],
    apply: () => {
      mockKeychain.get = {
        corrupt: validRecord({ canonicalAppUserId: 'apple-user-000123' }),
      };
      return { vaultNonUuid: true };
    },
  },
  // ── Keychain: write ──
  {
    id: 'kc.set.reject',
    seam: 'keychain.set',
    flows: PERSIST_FLOWS,
    apply: () => ((mockKeychain.set = 'reject'), { kcSet: 'fail' }),
  },
  {
    id: 'kc.set.throwSync',
    seam: 'keychain.set',
    flows: PERSIST_FLOWS,
    apply: () => ((mockKeychain.set = 'throwSync'), { kcSet: 'fail' }),
  },
  {
    id: 'kc.set.false',
    seam: 'keychain.set',
    flows: PERSIST_FLOWS,
    apply: () => ((mockKeychain.set = 'false'), { kcSet: 'fail' }),
  },
  {
    id: 'kc.set.missingFn',
    seam: 'keychain.set',
    flows: PERSIST_FLOWS,
    apply: () => ((mockKeychain.set = 'missingFn'), { kcSet: 'fail' }),
  },
  {
    id: 'kc.set.missingAccessible',
    seam: 'keychain.set',
    flows: PERSIST_FLOWS,
    apply: () => ((mockKeychain.set = 'missingAccessible'), { kcSet: 'fail' }),
  },
  {
    id: 'kc.set.hang',
    seam: 'keychain.set',
    flows: PERSIST_FLOWS,
    apply: () => ((mockKeychain.set = 'hang'), { kcSet: 'hang' }),
  },
  {
    id: 'kc.set.slow',
    seam: 'keychain.set',
    flows: PERSIST_FLOWS,
    apply: rng => {
      mockKeychain.set = 'slow';
      mockKeychain.slowMs = rng.pick(SLOW_CHOICES);
      return { kcSet: 'slow', extraDelayMs: mockKeychain.slowMs };
    },
  },
  // ── Keychain: reset ──
  {
    id: 'kc.reset.reject',
    seam: 'keychain.reset',
    flows: [...CLEAR_FLOWS, ...REFRESH_FLOWS],
    apply: () => ((mockKeychain.reset = 'reject'), { kcReset: 'fail' }),
  },
  {
    id: 'kc.reset.throwSync',
    seam: 'keychain.reset',
    flows: [...CLEAR_FLOWS, ...REFRESH_FLOWS],
    apply: () => ((mockKeychain.reset = 'throwSync'), { kcReset: 'fail' }),
  },
  {
    id: 'kc.reset.false',
    seam: 'keychain.reset',
    flows: [...CLEAR_FLOWS, ...REFRESH_FLOWS],
    apply: () => ((mockKeychain.reset = 'false'), { kcReset: 'fail' }),
  },
  {
    id: 'kc.reset.missingFn',
    seam: 'keychain.reset',
    flows: [...CLEAR_FLOWS, ...REFRESH_FLOWS],
    apply: () => ((mockKeychain.reset = 'missingFn'), { kcReset: 'fail' }),
  },
  {
    id: 'kc.reset.hang',
    seam: 'keychain.reset',
    flows: [...CLEAR_FLOWS, ...REFRESH_FLOWS],
    apply: () => ((mockKeychain.reset = 'hang'), { kcReset: 'hang' }),
  },
  {
    id: 'kc.reset.slow',
    seam: 'keychain.reset',
    flows: [...CLEAR_FLOWS, ...REFRESH_FLOWS],
    apply: rng => {
      mockKeychain.reset = 'slow';
      mockKeychain.slowMs = rng.pick(SLOW_CHOICES);
      return { kcReset: 'slow', extraDelayMs: mockKeychain.slowMs };
    },
  },
  // ── SQLite ──
  {
    id: 'db.open.throw',
    seam: 'db.open',
    flows: [...HYDRATE_FLOWS, ...SIGN_IN_FLOWS, ...CLEAR_FLOWS],
    apply: () => ((mockDb.open = 'throw'), { dbOpen: 'fail' }),
  },
  {
    id: 'db.open.throwAfterFirst',
    seam: 'db.open',
    flows: ['delete', 'hydrate.legacyGoogle'],
    apply: () => ((mockDb.open = 'throwAfterFirst'), { dbOpen: 'failLater' }),
  },
  {
    id: 'db.read.reject',
    seam: 'db.read',
    flows: HYDRATE_FLOWS,
    apply: () => ((mockDb.read = 'reject'), { dbRead: 'fail' }),
  },
  {
    id: 'db.read.throwSync',
    seam: 'db.read',
    flows: HYDRATE_FLOWS,
    apply: () => ((mockDb.read = 'throwSync'), { dbRead: 'fail' }),
  },
  {
    id: 'db.read.hang',
    seam: 'db.read',
    flows: HYDRATE_FLOWS,
    apply: () => ((mockDb.read = 'hang'), { dbRead: 'hang' }),
  },
  {
    id: 'db.read.slow',
    seam: 'db.read',
    flows: HYDRATE_FLOWS,
    apply: rng => {
      mockDb.read = 'slow';
      mockDb.slowMs = rng.pick(SLOW_CHOICES);
      // hydrate performs up to three kv reads before deciding
      return { dbRead: 'slow', extraDelayMs: 3 * mockDb.slowMs };
    },
  },
  {
    id: 'db.read.malformedRows',
    seam: 'db.read',
    flows: HYDRATE_FLOWS,
    apply: () => ((mockDb.read = 'malformed'), { dbRead: 'malformed' }),
  },
  {
    id: 'db.write.reject',
    seam: 'db.write',
    flows: [
      ...HYDRATE_FLOWS,
      ...SIGN_IN_FLOWS,
      ...CLEAR_FLOWS,
      ...REFRESH_FLOWS,
    ],
    apply: () => ((mockDb.write = 'reject'), { dbWrite: 'fail' }),
  },
  {
    id: 'db.write.throwSync',
    seam: 'db.write',
    flows: [...HYDRATE_FLOWS, ...SIGN_IN_FLOWS, ...CLEAR_FLOWS],
    apply: () => ((mockDb.write = 'throwSync'), { dbWrite: 'fail' }),
  },
  {
    id: 'db.write.hang',
    seam: 'db.write',
    flows: [...HYDRATE_FLOWS, ...SIGN_IN_FLOWS, ...CLEAR_FLOWS],
    apply: () => ((mockDb.write = 'hang'), { dbWrite: 'hang' }),
  },
  {
    id: 'db.write.slow',
    seam: 'db.write',
    flows: [...HYDRATE_FLOWS, ...SIGN_IN_FLOWS, ...CLEAR_FLOWS],
    apply: rng => {
      mockDb.write = 'slow';
      mockDb.slowMs = rng.pick(SLOW_CHOICES);
      return { dbWrite: 'slow', extraDelayMs: 3 * mockDb.slowMs };
    },
  },
  {
    id: 'db.purge.reject',
    seam: 'db.purge',
    flows: ['delete'],
    apply: () => ((mockDb.purge = 'reject'), { purge: 'fail' }),
  },
  {
    id: 'db.purge.rejectTwice',
    seam: 'db.purge',
    flows: ['delete'],
    apply: () => ((mockDb.purge = 'rejectTwice'), { purge: 'recover' }),
  },
  {
    id: 'db.purge.hang',
    seam: 'db.purge',
    flows: ['delete'],
    apply: () => ((mockDb.purge = 'hang'), { purge: 'hang' }),
  },
  // ── fetch: bootstrap ──
  {
    id: 'bs.networkReject',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = { kind: 'reject' };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.rejectString',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = { kind: 'rejectString' };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.throwSync',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = { kind: 'throwSync' };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.timeout',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = { kind: 'hang' };
      return { bootstrap: 'fail', bootstrapSlowMs: REQUEST_TIMEOUT_MS };
    },
  },
  {
    id: 'bs.slow',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: rng => {
      const ms = rng.pick(SLOW_CHOICES);
      server.routes.bootstrap = { kind: 'slow', ms, then: { kind: 'ok' } };
      return { bootstrap: 'slow-ok', bootstrapSlowMs: ms };
    },
  },
  {
    id: 'bs.slowThenFail',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: rng => {
      const ms = rng.pick(SLOW_CHOICES);
      server.routes.bootstrap = {
        kind: 'slow',
        ms,
        then: { kind: 'status', status: rng.pick(TRANSIENT_STATUSES) },
      };
      return { bootstrap: 'fail', bootstrapSlowMs: ms };
    },
  },
  {
    id: 'bs.status401or403',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: rng => {
      server.routes.bootstrap = {
        kind: 'status',
        status: rng.pick(REVOKED_STATUSES),
      };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.status5xxOr429',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: rng => {
      server.routes.bootstrap = {
        kind: 'status',
        status: rng.pick(TRANSIENT_STATUSES),
      };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.status4xxOther',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: rng => {
      server.routes.bootstrap = {
        kind: 'status',
        status: rng.pick(NON_AUTH_CLIENT_STATUSES),
      };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.errorBodyNonJson',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = { kind: 'status', status: 503, body: 'html' };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.jsonRejects',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = { kind: 'jsonRejects' };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.jsonThrowsSync',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = { kind: 'jsonThrowsSync' };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.bodyNull',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = { kind: 'body', body: () => null };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.bodyString',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = { kind: 'body', body: () => 'ok' };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.bodyEmptyObject',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = { kind: 'body', body: () => ({}) };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.userNonUuid',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = {
        kind: 'body',
        body: t => ({
          user: { id: 'user-123', email: null },
          onboardingState: 'complete',
          session: t,
        }),
      };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.userEmailNumber',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = {
        kind: 'body',
        body: t => ({
          user: { id: CANONICAL_A, email: 42 },
          onboardingState: 'complete',
          session: t,
        }),
      };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.onboardingInvalid',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = {
        kind: 'body',
        body: t => ({
          user: { id: CANONICAL_A, email: null },
          onboardingState: 'later',
          session: t,
        }),
      };
      return { bootstrap: 'fail' };
    },
  },
  {
    id: 'bs.noSession',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = {
        kind: 'body',
        accepted: true,
        body: () => ({
          user: { id: CANONICAL_A, email: 'pat@example.com' },
          onboardingState: 'complete',
        }),
      };
      return { bootstrap: 'legacy' };
    },
  },
  {
    id: 'bs.sessionMissingRefresh',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = {
        kind: 'body',
        accepted: true,
        body: t => ({
          user: { id: CANONICAL_A, email: null },
          onboardingState: 'complete',
          session: { accessToken: t.accessToken, expiresAt: t.expiresAt },
        }),
      };
      return { bootstrap: 'legacy' };
    },
  },
  {
    id: 'bs.sessionExpiresString',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = {
        kind: 'body',
        accepted: true,
        body: t => ({
          user: { id: CANONICAL_A, email: null },
          onboardingState: 'complete',
          session: { ...t, expiresAt: String(t.expiresAt) },
        }),
      };
      return { bootstrap: 'legacy' };
    },
  },
  {
    id: 'bs.sessionEmptyAccess',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = {
        kind: 'body',
        accepted: true,
        body: t => ({
          user: { id: CANONICAL_A, email: null },
          onboardingState: 'complete',
          session: { ...t, accessToken: '  ' },
        }),
      };
      return { bootstrap: 'legacy' };
    },
  },
  {
    id: 'bs.sessionArray',
    seam: 'fetch.bootstrap',
    flows: BOOTSTRAP_FLOWS,
    apply: () => {
      server.routes.bootstrap = {
        kind: 'body',
        accepted: true,
        body: t => ({
          user: { id: CANONICAL_A, email: null },
          onboardingState: 'complete',
          session: [t],
        }),
      };
      return { bootstrap: 'legacy' };
    },
  },
  // ── fetch: refresh ──
  {
    id: 'rf.networkReject',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = { kind: 'reject' };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.rejectString',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = { kind: 'rejectString' };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.throwSync',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = { kind: 'throwSync' };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.timeout',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = { kind: 'hang' };
      return { refresh: 'transient', refreshSlowMs: REQUEST_TIMEOUT_MS };
    },
  },
  {
    id: 'rf.slow',
    seam: 'fetch.refresh',
    flows: [...REFRESH_FLOWS, 'signOutDuringRestore', 'signInDuringHydrate'],
    apply: rng => {
      const ms = rng.pick(SLOW_CHOICES);
      server.routes.refresh = { kind: 'slow', ms, then: { kind: 'ok' } };
      return { refresh: 'slow-ok', refreshSlowMs: ms };
    },
  },
  {
    id: 'rf.slowPastLaunchWait',
    seam: 'fetch.refresh',
    flows: [...REFRESH_FLOWS, 'signOutDuringRestore', 'signInDuringHydrate'],
    apply: rng => {
      const ms = rng.pick([9_000, 12_000, 14_000] as const);
      server.routes.refresh = { kind: 'slow', ms, then: { kind: 'ok' } };
      return { refresh: 'slow-ok', refreshSlowMs: ms };
    },
  },
  {
    id: 'rf.slowThenFail',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: rng => {
      const ms = rng.pick(SLOW_CHOICES);
      server.routes.refresh = {
        kind: 'slow',
        ms,
        then: { kind: 'status', status: rng.pick(TRANSIENT_STATUSES) },
      };
      return { refresh: 'slow-transient', refreshSlowMs: ms };
    },
  },
  {
    id: 'rf.status401or403',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: rng => {
      server.routes.refresh = {
        kind: 'status',
        status: rng.pick(REVOKED_STATUSES),
      };
      return { refresh: 'revoked' };
    },
  },
  {
    id: 'rf.status5xxOr429',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: rng => {
      server.routes.refresh = {
        kind: 'status',
        status: rng.pick(TRANSIENT_STATUSES),
      };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.status4xxOther',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: rng => {
      server.routes.refresh = {
        kind: 'status',
        status: rng.pick(NON_AUTH_CLIENT_STATUSES),
      };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.jsonRejects',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = { kind: 'jsonRejects' };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.jsonThrowsSync',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = { kind: 'jsonThrowsSync' };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.bodyNull',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = { kind: 'body', body: () => null };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.bodyArray',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = { kind: 'body', body: t => [t] };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.sessionMissingRefresh',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = {
        kind: 'body',
        body: t => ({
          session: { accessToken: t.accessToken, expiresAt: t.expiresAt },
        }),
      };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.sessionMissingExpires',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = {
        kind: 'body',
        body: t => ({
          session: { accessToken: t.accessToken, refreshToken: t.refreshToken },
        }),
      };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.sessionExpiresString',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = {
        kind: 'body',
        body: t => ({ session: { ...t, expiresAt: String(t.expiresAt) } }),
      };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.sessionEmptyAccess',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = {
        kind: 'body',
        body: t => ({ session: { ...t, accessToken: '' } }),
      };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.sessionEmptyRefresh',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.routes.refresh = {
        kind: 'body',
        body: t => ({ session: { ...t, refreshToken: ' ' } }),
      };
      return { refresh: 'transient' };
    },
  },
  {
    id: 'rf.expiresAlreadyPast',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: () => {
      server.expiresInSec = -600;
      return {};
    },
  },
  {
    id: 'rf.expiresVerySoon',
    seam: 'fetch.refresh',
    flows: REFRESH_FLOWS,
    apply: rng => {
      server.expiresInSec = rng.pick([1, 5, 30, 61] as const);
      return {};
    },
  },
  // ── fetch: logout ──
  {
    id: 'lo.networkReject',
    seam: 'fetch.logout',
    flows: ['signOut', 'signOutDuringRestore'],
    apply: () => ((server.routes.logout = { kind: 'reject' }), {}),
  },
  {
    id: 'lo.throwSync',
    seam: 'fetch.logout',
    flows: ['signOut', 'signOutDuringRestore'],
    apply: () => ((server.routes.logout = { kind: 'throwSync' }), {}),
  },
  {
    id: 'lo.timeout',
    seam: 'fetch.logout',
    flows: ['signOut', 'signOutDuringRestore'],
    apply: () => {
      server.routes.logout = { kind: 'hang' };
      return { extraDelayMs: REQUEST_TIMEOUT_MS };
    },
  },
  {
    id: 'lo.slow',
    seam: 'fetch.logout',
    flows: ['signOut', 'signOutDuringRestore'],
    apply: rng => {
      const ms = rng.pick(SLOW_CHOICES);
      server.routes.logout = { kind: 'slow', ms, then: { kind: 'ok' } };
      return { extraDelayMs: ms };
    },
  },
  {
    id: 'lo.status5xx',
    seam: 'fetch.logout',
    flows: ['signOut', 'signOutDuringRestore'],
    apply: rng => {
      server.routes.logout = {
        kind: 'status',
        status: rng.pick(TRANSIENT_STATUSES),
      };
      return {};
    },
  },
  {
    id: 'lo.status401',
    seam: 'fetch.logout',
    flows: ['signOut', 'signOutDuringRestore'],
    apply: () => ((server.routes.logout = { kind: 'status', status: 401 }), {}),
  },
  // ── Native Apple module ──
  {
    id: 'ap.moduleMissing',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap'],
    apply: () => (
      (apple.mode = 'moduleMissing'),
      { provider: 'notConfigured' }
    ),
  },
  {
    id: 'ap.methodMissing',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap'],
    apply: () => (
      (apple.mode = 'methodMissing'),
      { provider: 'notConfigured' }
    ),
  },
  {
    id: 'ap.throwSync',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap'],
    apply: () => ((apple.mode = 'throwSync'), { provider: 'fail' }),
  },
  {
    id: 'ap.rejectCanceled',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap'],
    apply: () => ((apple.mode = 'rejectCanceled'), { provider: 'canceled' }),
  },
  {
    id: 'ap.rejectGeneric',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap'],
    apply: () => ((apple.mode = 'rejectGeneric'), { provider: 'fail' }),
  },
  {
    id: 'ap.rejectString',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap'],
    apply: () => ((apple.mode = 'rejectString'), { provider: 'fail' }),
  },
  {
    id: 'ap.hang',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap', 'signInDuringHydrate'],
    apply: () => ((apple.mode = 'hang'), { provider: 'hang' }),
  },
  {
    id: 'ap.slow',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap', 'signInDuringHydrate'],
    apply: rng => {
      apple.mode = 'slow';
      apple.slowMs = rng.pick(SLOW_CHOICES);
      return { provider: 'slow', providerSlowMs: apple.slowMs };
    },
  },
  {
    id: 'ap.nullToken',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap'],
    apply: () => ((apple.mode = 'nullToken'), { provider: 'fail' }),
  },
  {
    id: 'ap.emptyToken',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap'],
    apply: () => ((apple.mode = 'emptyToken'), { provider: 'fail' }),
  },
  {
    id: 'ap.resolveNull',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap'],
    apply: () => ((apple.mode = 'resolveNull'), { provider: 'fail' }),
  },
  {
    id: 'ap.resolveEmpty',
    seam: 'apple',
    flows: ['signIn.apple', 'doubleTap'],
    apply: () => ((apple.mode = 'resolveEmpty'), { provider: 'fail' }),
  },
  // ── Google SDK ──
  {
    id: 'gg.moduleMissing',
    seam: 'google',
    flows: ['signIn.google', 'hydrate.legacyGoogle', 'signOut', 'delete'],
    apply: () => {
      mockGoogle.moduleMissing = true;
      return { provider: 'fail', silent: 'transient' };
    },
  },
  {
    id: 'gg.configureThrows',
    seam: 'google',
    flows: ['signIn.google', 'hydrate.legacyGoogle'],
    apply: () => {
      mockGoogle.configure = 'throwSync';
      return { provider: 'fail', silent: 'transient' };
    },
  },
  {
    id: 'gg.playServicesReject',
    seam: 'google',
    flows: ['signIn.google'],
    apply: () => (
      (mockGoogle.hasPlayServices = 'reject'),
      { provider: 'fail' }
    ),
  },
  {
    id: 'gg.signInReject',
    seam: 'google',
    flows: ['signIn.google'],
    apply: () => ((mockGoogle.signIn = 'reject'), { provider: 'fail' }),
  },
  {
    id: 'gg.signInThrowSync',
    seam: 'google',
    flows: ['signIn.google'],
    apply: () => ((mockGoogle.signIn = 'throwSync'), { provider: 'fail' }),
  },
  {
    id: 'gg.signInCancelled',
    seam: 'google',
    flows: ['signIn.google'],
    apply: () => ((mockGoogle.signIn = 'cancelled'), { provider: 'canceled' }),
  },
  {
    id: 'gg.signInNullToken',
    seam: 'google',
    flows: ['signIn.google'],
    apply: () => ((mockGoogle.signIn = 'nullToken'), { provider: 'fail' }),
  },
  {
    id: 'gg.signInMalformed',
    seam: 'google',
    flows: ['signIn.google'],
    apply: () => ((mockGoogle.signIn = 'malformed'), { provider: 'fail' }),
  },
  {
    id: 'gg.signInHang',
    seam: 'google',
    flows: ['signIn.google'],
    apply: () => ((mockGoogle.signIn = 'hang'), { provider: 'hang' }),
  },
  {
    id: 'gg.signInSlow',
    seam: 'google',
    flows: ['signIn.google'],
    apply: rng => {
      mockGoogle.signIn = 'slow';
      mockGoogle.slowMs = rng.pick(SLOW_CHOICES);
      return { provider: 'slow', providerSlowMs: mockGoogle.slowMs };
    },
  },
  {
    id: 'gg.notConfigured',
    seam: 'google',
    flows: ['signIn.google', 'hydrate.legacyGoogle'],
    apply: () => {
      mockConfig.googleWebClientId = null;
      return { provider: 'notConfigured', silent: 'none' };
    },
  },
  {
    id: 'gg.silentHasPreviousThrows',
    seam: 'google',
    flows: ['hydrate.legacyGoogle'],
    apply: () => {
      mockGoogle.hasPreviousSignIn = 'throwSync';
      return { silent: 'transient' };
    },
  },
  {
    id: 'gg.silentNoPrevious',
    seam: 'google',
    flows: ['hydrate.legacyGoogle'],
    apply: () => ((mockGoogle.hasPreviousSignIn = false), { silent: 'none' }),
  },
  {
    id: 'gg.silentReject',
    seam: 'google',
    flows: ['hydrate.legacyGoogle'],
    apply: () => (
      (mockGoogle.signInSilently = 'reject'),
      { silent: 'transient' }
    ),
  },
  {
    id: 'gg.silentNoCredential',
    seam: 'google',
    flows: ['hydrate.legacyGoogle'],
    apply: () => {
      mockGoogle.signInSilently = 'noCredential';
      return { silent: 'noCredential' };
    },
  },
  {
    id: 'gg.silentNullToken',
    seam: 'google',
    flows: ['hydrate.legacyGoogle'],
    apply: () => (
      (mockGoogle.signInSilently = 'nullToken'),
      { silent: 'none' }
    ),
  },
  {
    id: 'gg.silentMalformed',
    seam: 'google',
    flows: ['hydrate.legacyGoogle'],
    apply: () => {
      mockGoogle.signInSilently = 'malformed';
      return { silent: 'transient' };
    },
  },
  {
    id: 'gg.silentHang',
    seam: 'google',
    flows: ['hydrate.legacyGoogle'],
    apply: () => (
      (mockGoogle.signInSilently = 'hang'),
      { silent: 'transient', provider: 'hang' }
    ),
  },
  {
    id: 'gg.signOutReject',
    seam: 'google',
    flows: ['signOut'],
    apply: () => ((mockGoogle.signOut = 'reject'), {}),
  },
  {
    id: 'gg.signOutHang',
    seam: 'google',
    flows: ['signOut'],
    apply: () => ((mockGoogle.signOut = 'hang'), { extraDelayMs: Infinity }),
  },
  {
    id: 'gg.revokeAccessReject',
    seam: 'google',
    flows: ['delete'],
    apply: () => ((mockGoogle.revokeAccess = 'reject'), {}),
  },
  // ── Runtime config ──
  {
    id: 'cfg.apiNull',
    seam: 'config',
    flows: [...BOOTSTRAP_FLOWS, 'hydrate.vault'],
    apply: () => ((mockConfig.apiBaseUrl = null), { notConfigured: true }),
  },
  {
    id: 'cfg.apiEmpty',
    seam: 'config',
    flows: [...BOOTSTRAP_FLOWS, 'hydrate.vault'],
    apply: () => ((mockConfig.apiBaseUrl = '   '), { notConfigured: true }),
  },
  {
    id: 'cfg.apiHttpRemote',
    seam: 'config',
    flows: [...BOOTSTRAP_FLOWS, 'hydrate.vault'],
    apply: () => {
      mockConfig.apiBaseUrl = 'http://api.example.test';
      return { notConfigured: true };
    },
  },
  {
    id: 'cfg.apiGarbage',
    seam: 'config',
    flows: [...BOOTSTRAP_FLOWS, 'hydrate.vault'],
    apply: () => (
      (mockConfig.apiBaseUrl = 'not a url'),
      { notConfigured: true }
    ),
  },
  {
    id: 'cfg.throws',
    seam: 'config',
    flows: [...BOOTSTRAP_FLOWS, 'hydrate.vault'],
    apply: () => (
      (mockConfig.throws = true),
      { notConfigured: true, configThrows: true }
    ),
  },
  // ── Device context ──
  {
    id: 'dev.envThrows',
    seam: 'device',
    flows: BOOTSTRAP_FLOWS,
    apply: () => ((mockDevice.throws = true), { deviceFails: true }),
  },
  // ── Clock ──
  // Skews stay under Node's 2^31-1 ms timer cap (~24.8 days): Jest's fake
  // timers mirror Node and collapse a longer setTimeout to 1 ms, which would
  // fabricate a refresh storm that React Native's double-precision iOS
  // timers (RCTTiming NSTimeInterval) cannot produce.
  {
    id: 'clk.deviceAhead',
    seam: 'clock',
    flows: [...SIGN_IN_FLOWS, ...REFRESH_FLOWS],
    apply: rng => {
      const ms = rng.pick([3_600_000, 86_400_000, 20 * 86_400_000] as const);
      return { clockSkewMs: ms };
    },
  },
  {
    id: 'clk.deviceBehind',
    seam: 'clock',
    flows: [...SIGN_IN_FLOWS, ...REFRESH_FLOWS],
    apply: rng => {
      const ms = rng.pick([3_600_000, 86_400_000, 20 * 86_400_000] as const);
      return { clockSkewMs: -ms };
    },
  },
  // ── RevenueCat (lazy SDK) ──
  {
    id: 'rc.moduleMissing',
    seam: 'revenuecat',
    flows: [...SIGN_IN_FLOWS, 'hydrate.vault', 'rotation'],
    apply: () => ((mockRevenueCat.moduleMissing = true), {}),
  },
];

// Faults whose observed failure is reproducible on this revision. Each entry
// pins the invariant it violates so the suite stays green while the issue is
// visible; when the code is fixed the entry stops reproducing and the suite
// fails until it is removed. Keyed by fault id (any flow it applies to).
//
// Every entry below is the same root cause: authStore awaits its Keychain,
// SQLite and provider-SDK calls with no timeout or cancellation, so a call
// that never settles (`*.hang`) leaves the flow's promise pending forever.
//   settles     — the flow promise is still pending after 60s of fake time
//   no-spinner  — hydrate: `hydrated` stays false → App.tsx never leaves
//                 LoadingState; sign-in: `busy` stays true → SignInScreen keeps
//                 every provider button disabled with no cancel control
//   consistent  — sign-in hung after installApiSession(): an ApiSession and
//                 data owner exist for an account the store does not show
//   visible     — sign-out hung before revokeApiSession(): the server-side
//                 session is never revoked (and a hung Keychain reset leaves
//                 the record that re-signs the user in on the next launch)
// The first invariant is the root symptom and must reproduce in every default
// campaign (each fault runs solo); the rest are consequences that depend on
// the flow the seed picked and are only tolerated, never required.
// Reproduced on origin/main as well (not a regression of this branch), except
// that main's guest launch did not wait on the Keychain (kc.get.hang).
const KNOWN_ISSUES: Readonly<Record<string, readonly string[]>> = {
  'kc.get.hang': ['settles', 'no-spinner'],
  'kc.set.hang': ['settles', 'no-spinner', 'consistent'],
  // (also no-spinner: hydrate clears a malformed vault record before it
  // continues, so a hung reset blocks the launch gate)
  'kc.reset.hang': ['settles', 'visible', 'no-spinner'],
  'db.read.hang': ['settles', 'no-spinner'],
  'db.write.hang': ['settles', 'no-spinner', 'consistent', 'visible'],
  'db.purge.hang': ['settles'],
  'ap.hang': ['settles', 'no-spinner'],
  'gg.signInHang': ['settles', 'no-spinner'],
  'gg.silentHang': ['settles', 'no-spinner'],
};

// ─── Plan ────────────────────────────────────────────────────────────────────

interface Plan {
  seed: number;
  flow: Flow;
  faults: Fault[];
  /** Which interactive provider the flow uses; fixed by the flow or by the
   * provider seam under test so a Google fault is never "tested" by an Apple
   * sign-in. */
  provider: 'apple' | 'google';
  legacyKvPresent: boolean;
}

function plan(seed: number): Plan {
  const rng = new Rng(seed);
  const primary = CATALOG[seed % CATALOG.length];
  if (!primary) throw new Error('empty catalog');
  const flow = rng.pick(primary.flows);
  const faults = [primary];
  // Seeds alternate in catalog-sized blocks: one block runs every fault solo
  // (so a masking co-fault can never hide it), the next adds 1–2 faults on
  // other seams. 2×catalog consecutive seeds therefore cover both.
  const solo = seed % (2 * CATALOG.length) < CATALOG.length;
  const extras = solo ? 0 : 1 + rng.int(2);
  const usedSeams = new Set<Seam>([primary.seam]);
  const candidates = CATALOG.filter(
    f => f.flows.includes(flow) && !usedSeams.has(f.seam),
  );
  for (let i = 0; i < extras && candidates.length > 0; i += 1) {
    const pool = candidates.filter(f => !usedSeams.has(f.seam));
    if (pool.length === 0) break;
    const extra = rng.pick(pool);
    usedSeams.add(extra.seam);
    faults.push(extra);
  }
  const randomProvider = rng.chance(0.5) ? 'apple' : 'google';
  const provider =
    flow === 'signIn.apple'
      ? 'apple'
      : flow === 'signIn.google'
        ? 'google'
        : faults.some(f => f.seam === 'apple')
          ? 'apple'
          : faults.some(f => f.seam === 'google')
            ? 'google'
            : randomProvider;
  return {
    seed,
    flow,
    faults,
    provider,
    legacyKvPresent: rng.chance(0.5),
  };
}

// ─── Iteration ───────────────────────────────────────────────────────────────

interface Violation {
  invariant: string;
  detail: string;
}

interface StateSnapshot {
  session: string | null;
  busy: boolean;
  hydrated: boolean;
  error: string | null;
  localDataError: boolean;
  deletionCleanup: string | null;
  apiSession: string | null;
  owner: string;
  vault: 'none' | 'record' | 'other';
  vaultRefreshToken: string | null;
  kv: Record<string, string>;
  calls: Record<Route, number>;
  unhandled: number;
}

interface Row {
  iteration: number;
  seed: number;
  flow: Flow;
  faults: string[];
  hints: Hints;
  outcome: 'HELD' | 'BROKEN' | 'KNOWN';
  violations: Violation[];
  settledMs: number | null;
  state: StateSnapshot;
  replay: string;
}

let unhandledRejections = 0;
const onUnhandled = () => {
  unhandledRejections += 1;
};

function resetWorld(): void {
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
    deletionCleanup: null,
  });
  mockVault.clear();
  mockKv.clear();
  mockKeychain.get = 'ok';
  mockKeychain.set = 'ok';
  mockKeychain.reset = 'ok';
  mockKeychain.slowMs = 3_000;
  mockDb.open = 'ok';
  mockDb.read = 'ok';
  mockDb.write = 'ok';
  mockDb.purge = 'ok';
  mockDb.opens = 0;
  mockDb.purgeAttempts = 0;
  mockDb.deletes = 0;
  mockDb.slowMs = 3_000;
  mockGoogle.moduleMissing = false;
  mockGoogle.configure = 'ok';
  mockGoogle.hasPlayServices = 'ok';
  mockGoogle.hasPreviousSignIn = false;
  mockGoogle.signIn = 'ok';
  mockGoogle.signInSilently = 'ok';
  mockGoogle.signOut = 'ok';
  mockGoogle.revokeAccess = 'ok';
  mockGoogle.slowMs = 3_000;
  mockRevenueCat.moduleMissing = false;
  mockRevenueCat.loads = 0;
  mockConfig.apiBaseUrl = 'https://api.example.test';
  mockConfig.throws = false;
  mockConfig.googleWebClientId = 'test-web-client.apps.googleusercontent.com';
  mockConfig.googleIosClientId = 'test-ios-client.apps.googleusercontent.com';
  mockDevice.throws = false;
  apple.mode = 'ok';
  apple.slowMs = 3_000;
  server.routes = {
    bootstrap: { kind: 'ok' },
    refresh: { kind: 'ok' },
    logout: { kind: 'ok' },
    other: { kind: 'reject' },
  };
  server.calls = { bootstrap: 0, refresh: 0, logout: 0, other: 0 };
  server.issuedAccess = new Set();
  server.issuedRefresh = new Set();
  server.acceptedBootstraps = 0;
  server.acceptedRefreshes = 0;
  server.nowMs = BASE_TIME_MS;
  server.expiresInSec = 3600;
  server.userId = CANONICAL_A;
  server.seq = 0;
  server.refreshTokensSeen = [];
  unhandledRejections = 0;
  jest.clearAllTimers();
  jest.setSystemTime(BASE_TIME_MS);
  installAppleNative();
  installFetch();
}

function seedVault(provider: 'apple' | 'google', refreshToken: string): void {
  server.issuedRefresh.add(refreshToken);
  mockVault.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider,
      canonicalAppUserId: CANONICAL_A,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

async function settle(
  promise: Promise<unknown>,
  budgetMs = SETTLE_BUDGET_MS,
): Promise<number | null> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  let elapsed = 0;
  await jest.advanceTimersByTimeAsync(0);
  while (!done && elapsed < budgetMs) {
    await jest.advanceTimersByTimeAsync(SETTLE_STEP_MS);
    elapsed += SETTLE_STEP_MS;
  }
  return done ? elapsed : null;
}

async function advance(ms: number): Promise<void> {
  let elapsed = 0;
  while (elapsed < ms) {
    const step = Math.min(SETTLE_STEP_MS * 4, ms - elapsed);
    await jest.advanceTimersByTimeAsync(step);
    elapsed += step;
  }
}

function snapshot(): StateSnapshot {
  const s = useAuthStore.getState();
  const api = getApiSession();
  const stored = mockVault.get(SESSION_VAULT_SERVICE);
  let vault: StateSnapshot['vault'] = 'none';
  let vaultRefreshToken: string | null = null;
  if (stored) {
    vault = 'other';
    try {
      const parsed = JSON.parse(stored.password) as Record<string, unknown>;
      if (
        parsed &&
        parsed['version'] === 1 &&
        (parsed['provider'] === 'apple' || parsed['provider'] === 'google') &&
        typeof parsed['canonicalAppUserId'] === 'string' &&
        typeof parsed['refreshToken'] === 'string' &&
        parsed['refreshToken']
      ) {
        vault = 'record';
        vaultRefreshToken = parsed['refreshToken'];
      }
    } catch {
      vault = 'other';
    }
  }
  return {
    session: s.session
      ? `${s.session.provider}:${s.session.canonicalAppUserId ?? 'local'}`
      : null,
    busy: s.busy,
    hydrated: s.hydrated,
    error: s.error ? s.error.code : null,
    localDataError: s.localDataError !== null,
    deletionCleanup: s.deletionCleanup?.localPurge ?? null,
    apiSession: api ? `${api.canonicalAppUserId}:${api.bearerToken}` : null,
    owner: getActiveDataOwner(),
    vault,
    vaultRefreshToken,
    kv: Object.fromEntries(mockKv),
    calls: { ...server.calls },
    unhandled: unhandledRejections,
  };
}

function mergeHints(faults: readonly Fault[], rng: Rng): Hints {
  const merged: Hints = {};
  for (const fault of faults) {
    const hints = fault.apply(rng);
    for (const [key, value] of Object.entries(hints)) {
      (merged as Record<string, unknown>)[key] =
        key === 'extraDelayMs'
          ? (merged.extraDelayMs ?? 0) + (value as number)
          : value;
    }
  }
  return merged;
}

/** A synced sign-in (or a bootstrapping restore) succeeds only when the
 * identity provider produced a token AND the server accepted it. */
function bootstrapExpected(
  hints: Hints,
): 'ok' | 'legacy' | 'fail' | 'canceled' | 'notConfigured' | 'hang' {
  if (hints.provider === 'hang') return 'hang';
  if (hints.provider === 'notConfigured') return 'notConfigured';
  if (hints.provider === 'canceled') return 'canceled';
  if (hints.provider === 'fail') return 'fail';
  // establishSyncedAccount reads the device context and the runtime config
  // before it classifies the API base URL, so those generic errors win.
  if (hints.deviceFails || hints.configThrows) return 'fail';
  if (hints.notConfigured) return 'notConfigured';
  if (hints.bootstrap === 'fail') return 'fail';
  if (hints.bootstrap === 'legacy') return 'legacy';
  return 'ok';
}

const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola/i;

function checkCommon(
  flow: Flow,
  hints: Hints,
  settledMs: number | null,
  state: StateSnapshot,
  violations: Violation[],
): void {
  const s = useAuthStore.getState();
  if (state.unhandled > 0) {
    violations.push({
      invariant: 'no-throw',
      detail: `${state.unhandled} unhandled rejection(s)`,
    });
  }
  // signOut is fire-and-forget in the UI (SettingsScreen `void signOut()`):
  // its state is cleared synchronously, so only the state checks apply.
  const fireAndForget = flow === 'signOut' || flow === 'signOutDuringRestore';
  if (!fireAndForget && settledMs === null) {
    violations.push({
      invariant: 'settles',
      detail: `flow promise still pending after ${SETTLE_BUDGET_MS}ms`,
    });
  }
  if (state.busy) {
    violations.push({
      invariant: 'no-spinner',
      detail: 'busy=true after 60s of fake time',
    });
  }
  if (flow.startsWith('hydrate') || flow === 'signInDuringHydrate') {
    if (!state.hydrated) {
      violations.push({
        invariant: 'no-spinner',
        detail: 'hydrated=false after 60s of fake time (launch gate stuck)',
      });
    }
  }
  if (s.error && FORBIDDEN_COPY.test(s.error.message)) {
    violations.push({
      invariant: 'copy',
      detail: `error copy violates dossier: ${s.error.message}`,
    });
  }
  // Consistency: session ↔ ApiSession ↔ data owner.
  const session = s.session;
  const api = getApiSession();
  if (!session) {
    if (api) {
      violations.push({
        invariant: 'consistent',
        detail: `ApiSession ${api.canonicalAppUserId} alive with no session`,
      });
    }
    if (state.owner !== SIGNED_OUT_DATA_OWNER) {
      violations.push({
        invariant: 'consistent',
        detail: `owner=${state.owner} with no session`,
      });
    }
  } else if (session.provider === 'guest') {
    if (api || state.owner !== GUEST_DATA_OWNER) {
      violations.push({
        invariant: 'consistent',
        detail: `guest session with api=${state.apiSession} owner=${state.owner}`,
      });
    }
  } else {
    if (state.owner !== session.canonicalAppUserId) {
      violations.push({
        invariant: 'consistent',
        detail: `owner=${state.owner} ≠ session ${session.canonicalAppUserId}`,
      });
    }
    if (api && api.canonicalAppUserId !== session.canonicalAppUserId) {
      violations.push({
        invariant: 'consistent',
        detail: `ApiSession ${api.canonicalAppUserId} ≠ session ${session.canonicalAppUserId}`,
      });
    }
    if (
      api &&
      !server.issuedAccess.has(api.bearerToken) &&
      api.bearerToken !== apple.identityToken &&
      api.bearerToken !== mockGoogle.idToken
    ) {
      violations.push({
        invariant: 'honest',
        detail: `bearer ${api.bearerToken} was never issued`,
      });
    }
  }
  // Persisted state hygiene.
  const stored = mockVault.get(SESSION_VAULT_SERVICE);
  if (stored && state.vault !== 'record' && !hints.vaultUnreadable) {
    violations.push({
      invariant: 'vault',
      detail: `vault holds a non-record payload: ${String(stored.password).slice(0, 80)}`,
    });
  }
  if (
    state.vault === 'record' &&
    state.vaultRefreshToken &&
    !server.issuedRefresh.has(state.vaultRefreshToken)
  ) {
    violations.push({
      invariant: 'vault',
      detail: `vault refresh token ${state.vaultRefreshToken} was never issued`,
    });
  }
  if (stored) {
    for (const access of server.issuedAccess) {
      if (String(stored.password).includes(access)) {
        violations.push({
          invariant: 'vault',
          detail: `vault contains access token ${access}`,
        });
      }
    }
    if (
      String(stored.password).includes(apple.identityToken) ||
      String(stored.password).includes(mockGoogle.idToken) ||
      String(stored.password).includes('apple-auth-code')
    ) {
      violations.push({
        invariant: 'vault',
        detail: 'vault contains provider identity material',
      });
    }
  }
  for (const [key, value] of Object.entries(state.kv)) {
    if (
      value.includes(apple.identityToken) ||
      value.includes(mockGoogle.idToken) ||
      [...server.issuedAccess, ...server.issuedRefresh].some(t =>
        value.includes(t),
      )
    ) {
      violations.push({
        invariant: 'vault',
        detail: `SQLite kv ${key} holds session material`,
      });
    }
  }
  // Backoff is 5s·2^n, so a permanently failing refresh legitimately makes
  // ≤ 5 attempts in 60s; anything beyond that is a storm.
  if (state.calls.refresh > 6) {
    violations.push({
      invariant: 'storm',
      detail: `${state.calls.refresh} refresh calls within 60s`,
    });
  }
}

function checkSignIn(
  hints: Hints,
  state: StateSnapshot,
  violations: Violation[],
  provider: 'apple' | 'google',
): void {
  const s = useAuthStore.getState();
  const expected = bootstrapExpected(hints);
  if (expected === 'hang') {
    // The provider never answered: covered by settles / no-spinner.
    return;
  }
  if (expected === 'ok' || expected === 'legacy') {
    if (!s.session || s.session.provider !== provider) {
      violations.push({
        invariant: 'visible',
        detail: `sign-in should have succeeded, session=${state.session} error=${state.error}`,
      });
      return;
    }
    if (server.acceptedBootstraps < 1) {
      violations.push({
        invariant: 'honest',
        detail: 'session present but the server never accepted a bootstrap',
      });
    }
    if (expected === 'ok' && !hints.kcSet && state.vault !== 'record') {
      violations.push({
        invariant: 'vault',
        detail: 'durable session was minted but the vault holds no record',
      });
    }
    if (
      expected === 'ok' &&
      hints.kcSet === 'fail' &&
      state.vault === 'record'
    ) {
      violations.push({
        invariant: 'vault',
        detail: 'Keychain write failed yet a record appeared',
      });
    }
    if (expected === 'legacy' && state.vault !== 'none') {
      violations.push({
        invariant: 'vault',
        detail: 'legacy (no-session) bootstrap must persist nothing',
      });
    }
    return;
  }
  // Expected failure.
  if (s.session) {
    violations.push({
      invariant: 'honest',
      detail: `sign-in reported a session (${state.session}) although ${expected}`,
    });
  }
  if (!s.error) {
    violations.push({
      invariant: 'visible',
      detail: `sign-in failed (${expected}) with no visible error`,
    });
  } else if (expected === 'canceled' && s.error.code !== 'auth.canceled') {
    violations.push({
      invariant: 'visible',
      detail: `cancel surfaced as ${s.error.code}`,
    });
  } else if (
    expected === 'notConfigured' &&
    s.error.code !== 'auth.not_configured'
  ) {
    violations.push({
      invariant: 'visible',
      detail: `not-configured surfaced as ${s.error.code}`,
    });
  } else if (expected === 'fail' && !s.error.message.trim()) {
    violations.push({
      invariant: 'visible',
      detail: 'failure surfaced with an empty message',
    });
  }
  if (state.vault !== 'none') {
    violations.push({
      invariant: 'vault',
      detail: 'a failed sign-in left a Keychain record',
    });
  }
}

function checkHydrateVault(
  hints: Hints,
  settledMs: number | null,
  state: StateSnapshot,
  violations: Violation[],
  seededRefresh: string,
): void {
  const s = useAuthStore.getState();
  const hung =
    hints.extraDelayMs === Infinity ||
    hints.dbRead === 'hang' ||
    hints.dbWrite === 'hang';
  if (hung) return; // covered by settles / no-spinner
  if (hints.vaultUnreadable || hints.vaultNonUuid) {
    if (s.session) {
      violations.push({
        invariant: 'honest',
        detail: `unreadable record produced a session ${state.session}`,
      });
    }
    return;
  }
  // Without a usable API base URL the restore is 'offline' by design: no
  // refresh is attempted, so the server's refusal is never seen.
  const revoked = hints.refresh === 'revoked' && !hints.notConfigured;
  if (revoked) {
    if (s.session) {
      violations.push({
        invariant: 'one-rule',
        detail: 'server refused the refresh token but the session survived',
      });
    }
    if (state.vault === 'record' && !hints.kcReset) {
      violations.push({
        invariant: 'vault',
        detail: 'revoked session left its Keychain record',
      });
    }
    return;
  }
  // Transient / slow / ok / offline: the durable session must survive.
  if (!s.session || s.session.canonicalAppUserId !== CANONICAL_A) {
    violations.push({
      invariant: 'one-rule',
      detail: `durable session dropped without a 401/403 (refresh=${hints.refresh ?? 'ok'}, session=${state.session})`,
    });
  }
  if (state.vault !== 'record') {
    violations.push({
      invariant: 'vault',
      detail: `Keychain record lost (vault=${state.vault}) without a 401/403`,
    });
  } else if (
    state.vaultRefreshToken !== seededRefresh &&
    !server.issuedRefresh.has(state.vaultRefreshToken ?? '')
  ) {
    violations.push({
      invariant: 'vault',
      detail: `vault refresh token ${state.vaultRefreshToken} is neither the seeded nor a rotated one`,
    });
  }
  const dependencyDelay = Number.isFinite(hints.extraDelayMs ?? 0)
    ? (hints.extraDelayMs ?? 0)
    : 0;
  const refreshWait = Math.min(
    hints.refreshSlowMs ?? 0,
    LAUNCH_REFRESH_WAIT_MS,
  );
  const budget =
    (hints.notConfigured
      ? 0
      : Math.max(refreshWait, hints.refresh ? LAUNCH_REFRESH_WAIT_MS : 0)) +
    dependencyDelay +
    2 * SETTLE_STEP_MS;
  if (settledMs !== null && settledMs > budget) {
    violations.push({
      invariant: 'launch-wait',
      detail: `hydrate took ${settledMs}ms (budget ${budget}ms)`,
    });
  }
  if (
    (hints.refresh === undefined || hints.refresh === 'slow-ok') &&
    !hints.notConfigured &&
    !getApiSession()
  ) {
    violations.push({
      invariant: 'honest',
      detail: 'refresh succeeded but no ApiSession was installed',
    });
  }
}

function checkSignedOut(
  hints: Hints,
  state: StateSnapshot,
  violations: Violation[],
  label: string,
): void {
  const s = useAuthStore.getState();
  if (s.session || getApiSession() || state.owner !== SIGNED_OUT_DATA_OWNER) {
    violations.push({
      invariant: 'consistent',
      detail: `${label}: session=${state.session} api=${state.apiSession} owner=${state.owner}`,
    });
  }
  if (state.vault !== 'none' && !hints.kcReset) {
    violations.push({
      invariant: 'vault',
      detail: `${label}: Keychain record survived (vault=${state.vault})`,
    });
  }
  if (s.error && label !== 'unauthorized') {
    violations.push({
      invariant: 'visible',
      detail: `${label}: unexpected error ${s.error.code}`,
    });
  }
}

/** Runs the flow under the plan and returns the result row. */
async function runIteration(iteration: number, seed: number): Promise<Row> {
  const p = plan(seed);
  const rng = new Rng(seed ^ 0x5bd1e995);
  resetWorld();
  const hints = mergeHints(p.faults, rng);
  if (hints.clockSkewMs) jest.setSystemTime(BASE_TIME_MS + hints.clockSkewMs);
  installAppleNative();
  const violations: Violation[] = [];
  const seededRefresh = 'refresh-seeded';
  let settledMs: number | null = null;

  const signIn = () =>
    p.provider === 'apple'
      ? useAuthStore.getState().signInWithApple()
      : useAuthStore.getState().signInWithGoogle();

  // Pre-conditions that must succeed run with the faults disarmed.
  const withFaultsDisarmed = async (fn: () => Promise<void>) => {
    const armed = {
      kc: { ...mockKeychain },
      db: { ...mockDb },
      routes: { ...server.routes },
      google: { ...mockGoogle },
      apple: apple.mode,
      config: { ...mockConfig },
      device: mockDevice.throws,
      rc: mockRevenueCat.moduleMissing,
      expiresInSec: server.expiresInSec,
    };
    Object.assign(mockKeychain, { get: 'ok', set: 'ok', reset: 'ok' });
    Object.assign(mockDb, { open: 'ok', read: 'ok', write: 'ok', purge: 'ok' });
    server.routes = {
      bootstrap: { kind: 'ok' },
      refresh: { kind: 'ok' },
      logout: { kind: 'ok' },
      other: { kind: 'reject' },
    };
    Object.assign(mockGoogle, {
      moduleMissing: false,
      configure: 'ok',
      hasPlayServices: 'ok',
      signIn: 'ok',
    });
    apple.mode = 'ok';
    mockConfig.apiBaseUrl = 'https://api.example.test';
    mockConfig.throws = false;
    mockConfig.googleWebClientId = 'test-web-client.apps.googleusercontent.com';
    mockDevice.throws = false;
    mockRevenueCat.moduleMissing = false;
    installAppleNative();
    await fn();
    Object.assign(mockKeychain, armed.kc);
    Object.assign(mockDb, armed.db);
    server.routes = armed.routes;
    Object.assign(mockGoogle, armed.google);
    apple.mode = armed.apple;
    Object.assign(mockConfig, armed.config);
    mockDevice.throws = armed.device;
    mockRevenueCat.moduleMissing = armed.rc;
    server.expiresInSec = armed.expiresInSec;
    installAppleNative();
  };

  switch (p.flow) {
    case 'hydrate.empty': {
      if (p.legacyKvPresent) mockKv.set(LEGACY_SESSION_KEY, 'apple:legacy');
      settledMs = await settle(useAuthStore.getState().hydrate());
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      if (settledMs !== null) {
        if (useAuthStore.getState().session) {
          violations.push({
            invariant: 'honest',
            detail: `empty device hydrated a session ${state.session}`,
          });
        }
        if (
          p.legacyKvPresent &&
          !hints.dbWrite &&
          !hints.dbOpen &&
          !hints.dbRead &&
          state.kv[LEGACY_SESSION_KEY] !== ''
        ) {
          violations.push({
            invariant: 'vault',
            detail: 'legacy SQLite subject was not blanked',
          });
        }
        if (
          (hints.dbOpen || hints.dbRead === 'fail') &&
          !state.localDataError
        ) {
          violations.push({
            invariant: 'visible',
            detail: 'SQLite failed but localDataError is null',
          });
        }
      }
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'hydrate.guest': {
      mockKv.set(LOCAL_MODE_KEY, GUEST_FLAG);
      settledMs = await settle(useAuthStore.getState().hydrate());
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      if (settledMs !== null) {
        const s = useAuthStore.getState();
        const flagReadable =
          !hints.dbOpen &&
          hints.dbRead !== 'fail' &&
          hints.dbRead !== 'malformed';
        if (flagReadable && s.session?.provider !== 'guest') {
          violations.push({
            invariant: 'honest',
            detail: `guest flag readable but session=${state.session}`,
          });
        }
        if (
          !flagReadable &&
          hints.dbRead !== 'malformed' &&
          !state.localDataError
        ) {
          violations.push({
            invariant: 'visible',
            detail: 'guest flag unreadable and localDataError is null',
          });
        }
        if (!flagReadable && s.session) {
          violations.push({
            invariant: 'honest',
            detail: `unreadable SQLite produced session ${state.session}`,
          });
        }
      }
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'hydrate.vault': {
      seedVault(p.provider, seededRefresh);
      if (p.legacyKvPresent) mockKv.set(LEGACY_SESSION_KEY, 'apple:legacy');
      settledMs = await settle(useAuthStore.getState().hydrate());
      // Let a background refresh (post-8s launch wait) land.
      await advance(SETTLE_BUDGET_MS - (settledMs ?? SETTLE_BUDGET_MS));
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      checkHydrateVault(hints, settledMs, state, violations, seededRefresh);
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'hydrate.legacyGoogle': {
      mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG);
      if (mockGoogle.hasPreviousSignIn === false) {
        mockGoogle.hasPreviousSignIn = true;
      }
      const noPrevious = p.faults.some(f => f.id === 'gg.silentNoPrevious');
      if (noPrevious) mockGoogle.hasPreviousSignIn = false;
      settledMs = await settle(useAuthStore.getState().hydrate());
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      if (settledMs !== null) {
        const s = useAuthStore.getState();
        // hydrate() opens the database once and keeps the handle, so only a
        // failure of the FIRST open hides the last-provider flag.
        const flagReadable =
          hints.dbOpen !== 'fail' &&
          hints.dbRead !== 'fail' &&
          hints.dbRead !== 'malformed';
        const expected = bootstrapExpected(hints);
        const silentBlocked = hints.silent !== undefined;
        if (!flagReadable || silentBlocked || expected !== 'ok') {
          if (s.session && expected !== 'legacy') {
            violations.push({
              invariant: 'honest',
              detail: `silent restore should not have produced ${state.session}`,
            });
          }
          if (
            hints.silent === 'noCredential' &&
            flagReadable &&
            !hints.dbOpen &&
            !hints.dbWrite &&
            state.kv[LAST_PROVIDER_KEY] !== ''
          ) {
            violations.push({
              invariant: 'vault',
              detail: 'definitive no-credential kept the silent-restore flag',
            });
          }
          if (
            hints.silent !== 'noCredential' &&
            flagReadable &&
            (hints.silent === 'transient' || expected === 'fail') &&
            state.kv[LAST_PROVIDER_KEY] !== GOOGLE_FLAG
          ) {
            violations.push({
              invariant: 'one-rule',
              detail: 'transient silent-restore failure cleared the flag',
            });
          }
        } else if (!s.session || s.session.provider !== 'google') {
          violations.push({
            invariant: 'visible',
            detail: `silent restore should have succeeded, session=${state.session}`,
          });
        } else if (!hints.kcSet && state.vault !== 'record') {
          violations.push({
            invariant: 'vault',
            detail: 'silent restore minted a session but persisted no record',
          });
        }
      }
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'signIn.apple':
    case 'signIn.google': {
      settledMs = await settle(signIn());
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      if (settledMs !== null) checkSignIn(hints, state, violations, p.provider);
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'doubleTap': {
      const first = signIn();
      const second = signIn();
      settledMs = await settle(Promise.all([first, second]));
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      if (state.calls.bootstrap > 1) {
        violations.push({
          invariant: 'honest',
          detail: `double tap issued ${state.calls.bootstrap} bootstraps`,
        });
      }
      if (settledMs !== null) checkSignIn(hints, state, violations, p.provider);
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'signOut': {
      await withFaultsDisarmed(async () => {
        await settle(signIn());
      });
      if (!useAuthStore.getState().session) {
        throw new Error(`seed ${seed}: precondition sign-in failed`);
      }
      const before = snapshot();
      settledMs = await settle(useAuthStore.getState().signOut());
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      checkSignedOut(hints, state, violations, 'signOut');
      if (state.calls.logout < 1 && before.apiSession && !hints.notConfigured) {
        violations.push({
          invariant: 'visible',
          detail: 'sign-out never attempted the server-side revocation',
        });
      }
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'delete': {
      await withFaultsDisarmed(async () => {
        await settle(signIn());
      });
      if (!useAuthStore.getState().session) {
        throw new Error(`seed ${seed}: precondition sign-in failed`);
      }
      mockDb.opens = 0;
      settledMs = await settle(
        useAuthStore.getState().completeAccountDeletion(),
      );
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      checkSignedOut(hints, state, violations, 'delete');
      if (settledMs !== null) {
        const purgeExpected =
          hints.purge === 'fail' || hints.dbOpen
            ? 'failed'
            : hints.purge === 'hang'
              ? null
              : 'complete';
        if (purgeExpected && state.deletionCleanup !== purgeExpected) {
          violations.push({
            invariant: 'honest',
            detail: `deletionCleanup=${state.deletionCleanup}, expected ${purgeExpected}`,
          });
        }
        if (
          hints.purge === 'fail' &&
          !hints.dbOpen &&
          mockDb.purgeAttempts !== 3
        ) {
          violations.push({
            invariant: 'honest',
            detail: `purge attempted ${mockDb.purgeAttempts}× (expected 3)`,
          });
        }
      }
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'unauthorized': {
      seedVault(p.provider, seededRefresh);
      await withFaultsDisarmed(async () => {
        await settle(useAuthStore.getState().hydrate());
      });
      const live = getApiSession();
      if (!live) throw new Error(`seed ${seed}: precondition hydrate failed`);
      const rotatedRefresh = live.refreshToken;
      reportApiUnauthorized(live.bearerToken);
      settledMs = 0;
      await advance(SETTLE_BUDGET_MS);
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      if (state.calls.refresh < 2) {
        violations.push({
          invariant: 'visible',
          detail: `a 401 on the bearer triggered no refresh (${state.calls.refresh} calls)`,
        });
      }
      if (hints.refresh === 'revoked') {
        checkSignedOut(hints, state, violations, 'unauthorized');
      } else {
        const s = useAuthStore.getState();
        if (!s.session) {
          violations.push({
            invariant: 'one-rule',
            detail: `401 on the bearer + ${hints.refresh ?? 'ok'} refresh dropped the session`,
          });
        }
        if (state.vault !== 'record') {
          violations.push({
            invariant: 'vault',
            detail: `Keychain record lost (vault=${state.vault}) without a 401/403`,
          });
        } else if (
          hints.refresh &&
          hints.refresh !== 'slow-ok' &&
          state.vaultRefreshToken !== rotatedRefresh &&
          !hints.kcSet
        ) {
          violations.push({
            invariant: 'vault',
            detail: `failed refresh replaced the vault token (${state.vaultRefreshToken} ≠ ${rotatedRefresh})`,
          });
        }
      }
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'rotation': {
      // Bearer expires in 90s → the keeper rotates at +30s.
      await withFaultsDisarmed(async () => {
        server.expiresInSec = 90;
        await settle(signIn());
      });
      if (!getApiSession()) {
        throw new Error(`seed ${seed}: precondition sign-in failed`);
      }
      const before = snapshot();
      settledMs = 0;
      await advance(SETTLE_BUDGET_MS);
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      if ((hints.clockSkewMs ?? 0) < 0) {
        // The keeper trusts the device clock (sessionKeeper.ts: a lagging
        // clock must not become a refresh storm), so a bearer that expired
        // by the server's clock is rotated by the first route 401 through
        // refreshSessionNow — the 'unauthorized' flow. Here: no implicit
        // sign-out and no storm.
        if (!useAuthStore.getState().session) {
          violations.push({
            invariant: 'one-rule',
            detail: 'device clock behind the server dropped the session',
          });
        }
        return finish(iteration, p, hints, settledMs, state, violations);
      }
      if (state.calls.refresh < 1) {
        violations.push({
          invariant: 'visible',
          detail: 'no rotation attempted before the bearer expired',
        });
      }
      if (hints.refresh === 'revoked') {
        checkSignedOut(hints, state, violations, 'rotation');
      } else {
        const s = useAuthStore.getState();
        if (!s.session) {
          violations.push({
            invariant: 'one-rule',
            detail: `rotation failure (${hints.refresh ?? 'ok'}) dropped the session`,
          });
        }
        if (state.vault !== 'record') {
          violations.push({
            invariant: 'vault',
            detail: `Keychain record lost (vault=${state.vault}) during rotation`,
          });
        }
        if (
          (hints.refresh === undefined || hints.refresh === 'slow-ok') &&
          !hints.kcSet &&
          state.vaultRefreshToken === before.vaultRefreshToken &&
          server.acceptedRefreshes > 0
        ) {
          violations.push({
            invariant: 'vault',
            detail: 'rotated refresh token was not re-persisted',
          });
        }
      }
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'signOutDuringRestore': {
      seedVault(p.provider, seededRefresh);
      if (!hints.refreshSlowMs) {
        server.routes.refresh = {
          kind: 'slow',
          ms: 4_000,
          then: { kind: 'ok' },
        };
        hints.refresh = 'slow-ok';
        hints.refreshSlowMs = 4_000;
      }
      const hydrate = useAuthStore.getState().hydrate();
      await advance(1_000);
      const signOut = useAuthStore.getState().signOut();
      settledMs = await settle(Promise.all([hydrate, signOut]));
      await advance(SETTLE_BUDGET_MS - (settledMs ?? SETTLE_BUDGET_MS));
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      checkSignedOut(hints, state, violations, 'signOutDuringRestore');
      return finish(iteration, p, hints, settledMs, state, violations);
    }
    case 'signInDuringHydrate': {
      seedVault(p.provider, seededRefresh);
      if (!hints.refreshSlowMs) {
        server.routes.refresh = {
          kind: 'slow',
          ms: 6_000,
          then: { kind: 'ok' },
        };
        hints.refresh = 'slow-ok';
        hints.refreshSlowMs = 6_000;
      }
      server.userId = CANONICAL_B;
      const hydrate = useAuthStore.getState().hydrate();
      await advance(1_000);
      const appleSignIn = useAuthStore.getState().signInWithApple();
      settledMs = await settle(Promise.all([hydrate, appleSignIn]));
      await advance(SETTLE_BUDGET_MS - (settledMs ?? SETTLE_BUDGET_MS));
      const state = snapshot();
      checkCommon(p.flow, hints, settledMs, state, violations);
      if (settledMs !== null) {
        const s = useAuthStore.getState();
        const expected = bootstrapExpected(hints);
        if (expected === 'ok' || expected === 'legacy') {
          if (s.session?.canonicalAppUserId !== CANONICAL_B) {
            violations.push({
              invariant: 'consistent',
              detail: `late restore clobbered the new sign-in: session=${state.session}`,
            });
          }
          if (
            expected === 'ok' &&
            !hints.kcSet &&
            state.vault === 'record' &&
            !server.issuedRefresh.has(state.vaultRefreshToken ?? '')
          ) {
            violations.push({
              invariant: 'vault',
              detail: `vault holds ${state.vaultRefreshToken} after the new sign-in`,
            });
          }
          const api = getApiSession();
          if (api && api.canonicalAppUserId !== CANONICAL_B) {
            violations.push({
              invariant: 'consistent',
              detail: `late refresh installed ApiSession for ${api.canonicalAppUserId}`,
            });
          }
        }
      }
      return finish(iteration, p, hints, settledMs, state, violations);
    }
  }
}

function finish(
  iteration: number,
  p: Plan,
  hints: Hints,
  settledMs: number | null,
  state: StateSnapshot,
  violations: Violation[],
): Row {
  const known = new Set(p.faults.flatMap(f => KNOWN_ISSUES[f.id] ?? []));
  const unexpected = violations.filter(v => !known.has(v.invariant));
  const outcome: Row['outcome'] =
    violations.length === 0
      ? 'HELD'
      : unexpected.length === 0
        ? 'KNOWN'
        : 'BROKEN';
  return {
    iteration,
    seed: p.seed,
    flow: p.flow,
    faults: p.faults.map(f => f.id),
    hints: { ...hints, extraDelayMs: hints.extraDelayMs ?? 0 },
    outcome,
    violations,
    settledMs,
    state,
    replay: `cd apps/mobile && STRESS_ONLY_SEED=${p.seed} npx jest --ci __tests__/stress/authStoreFailureInjection.stress.test.ts`,
  };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const seeds: number[] =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: STRESS_ITER }, (_, i) => STRESS_SEED + i);

const rows: Row[] = [];
const wallStart = Date.now();

beforeAll(() => {
  jest.useFakeTimers();
  process.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  resetWorld();
  jest.useRealTimers();
  if (!OUT_DIR) return;
  const byFault: Record<
    string,
    { executed: number; broken: number; known: number }
  > = {};
  const byFlow: Record<
    string,
    { executed: number; broken: number; known: number }
  > = {};
  const byInvariant: Record<string, number> = {};
  for (const row of rows) {
    for (const id of row.faults) {
      const bucket = (byFault[id] ??= { executed: 0, broken: 0, known: 0 });
      bucket.executed += 1;
      if (row.outcome === 'BROKEN') bucket.broken += 1;
      if (row.outcome === 'KNOWN') bucket.known += 1;
    }
    const flowBucket = (byFlow[row.flow] ??= {
      executed: 0,
      broken: 0,
      known: 0,
    });
    flowBucket.executed += 1;
    if (row.outcome === 'BROKEN') flowBucket.broken += 1;
    if (row.outcome === 'KNOWN') flowBucket.known += 1;
    for (const v of row.violations) {
      byInvariant[v.invariant] = (byInvariant[v.invariant] ?? 0) + 1;
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    iterations: STRESS_ITER,
    firstSeed: STRESS_SEED,
    onlySeed: ONLY_SEED,
    catalogSize: CATALOG.length,
    executed: rows.length,
    held: rows.filter(r => r.outcome === 'HELD').length,
    known: rows.filter(r => r.outcome === 'KNOWN').length,
    broken: rows.filter(r => r.outcome === 'BROKEN').length,
    injectedFaults: rows.reduce((n, r) => n + r.faults.length, 0),
    wallMs: Date.now() - wallStart,
    byFlow,
    byFault,
    byInvariant,
    failures: rows
      .filter(r => r.outcome !== 'HELD')
      .map(r => ({
        seed: r.seed,
        flow: r.flow,
        faults: r.faults,
        outcome: r.outcome,
        violations: r.violations,
        settledMs: r.settledMs,
        state: r.state,
        replay: r.replay,
      })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const suffix = ONLY_SEED !== null ? `-seed${ONLY_SEED}` : '';
  writeFileSync(
    join(OUT_DIR, `auth-store-failure-injection-summary${suffix}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `auth-store-failure-injection-results${suffix}.json`),
    JSON.stringify(rows, null, 2),
  );
});

describe('authStore failure injection (seeded)', () => {
  it('catalog covers every dependency seam with ≥ 60 faults', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(60);
    expect(new Set(CATALOG.map(f => f.id)).size).toBe(CATALOG.length);
    const seams = new Set(CATALOG.map(f => f.seam));
    for (const seam of [
      'keychain.get',
      'keychain.set',
      'keychain.reset',
      'db.open',
      'db.read',
      'db.write',
      'db.purge',
      'fetch.bootstrap',
      'fetch.refresh',
      'fetch.logout',
      'apple',
      'google',
      'config',
      'device',
      'clock',
      'revenuecat',
    ] as const) {
      expect(seams.has(seam)).toBe(true);
    }
    for (const fault of CATALOG) {
      for (const flow of fault.flows) expect(FLOWS).toContain(flow);
    }
  });

  it.each(seeds.map((seed, i) => [i, seed] as const))(
    'iteration %i seed=%i',
    async (iteration, seed) => {
      const row = await runIteration(iteration, seed);
      rows.push(row);
      if (row.outcome === 'BROKEN') {
        throw new Error(
          [
            `STRESS FAILURE seed=${seed} flow=${row.flow} faults=${row.faults.join(',')}`,
            `replay: ${row.replay}`,
            ...row.violations.map(v => `  [${v.invariant}] ${v.detail}`),
            `state: ${JSON.stringify(row.state)}`,
          ].join('\n'),
        );
      }
    },
  );

  it('executed the planned scale and every catalog fault at least once', () => {
    expect(rows.length).toBe(seeds.length);
    if (ONLY_SEED !== null || STRESS_ITER < CATALOG.length) return;
    const exercised = new Set(rows.flatMap(r => r.faults));
    const missing = CATALOG.map(f => f.id).filter(id => !exercised.has(id));
    expect(missing).toEqual([]);
    if (STRESS_ITER < 2 * CATALOG.length) return;
    const solo = new Set(
      rows.filter(r => r.faults.length === 1).map(r => r.faults[0]),
    );
    expect(CATALOG.map(f => f.id).filter(id => !solo.has(id))).toEqual([]);
  });

  it('every KNOWN_ISSUES entry still reproduces (prune it once fixed)', () => {
    if (ONLY_SEED !== null || STRESS_ITER < CATALOG.length) return;
    for (const [faultId, invariants] of Object.entries(KNOWN_ISSUES)) {
      const seen = new Set(
        rows
          .filter(r => r.faults.includes(faultId))
          .flatMap(r => r.violations.map(v => v.invariant)),
      );
      const invariant = invariants[0] ?? '';
      expect({ faultId, invariant, reproduced: seen.has(invariant) }).toEqual({
        faultId,
        invariant,
        reproduced: true,
      });
    }
  });
});
