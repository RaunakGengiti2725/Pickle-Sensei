/**
 * mobile-security-secrets audit (workflow be-mobile-security-secrets).
 *
 * Executable evidence for the audit report, in two flavours:
 *   - GUARD tests pin the checks that came back clean (no secrets in the
 *     shipped JS/native sources, ATS + URL-scheme invariants in Info.plist,
 *     token storage: the access token and the provider identity token are
 *     never persisted anywhere — not SQLite kv, not the Keychain, not any SQL
 *     statement — and the refresh token's ONLY durable home is the device
 *     Keychain through src/account/sessionVault.ts).
 *   - RECOVERY / GATE tests pin the fixes for the defects the audit found:
 *     a rejected bearer is recovered in-app — a durable session rotates
 *     through /v1/auth/refresh with no provider round-trip, a LEGACY
 *     provider-token session (older server, no refresh material) is
 *     re-acquired silently (Google) or ends with an honest reason — and the
 *     drill WebView only navigates within the provider's hosts.
 *
 * Mock style follows authDurableSession.test.ts (in-memory kv LocalDb, Google
 * SDK module mock, react-native-keychain auto-mock, jest.fn fetch) and
 * drillVideoPlayer.test.tsx (passthrough WebView). No JSX: the workflow file
 * glob is *.test.ts.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import type { InstructionalMedia } from '../../src/training/types';
import { useAuthStore } from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { shouldLoadInPlayer } from '../../src/components/DrillVideoPlayer';
import {
  ApiError,
  createAnalysisPermitClient,
  createTransport,
} from '../../src/data/api';
import { isPermanentSyncFailure } from '../../src/data/sync';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

// The auto-mock (__mocks__/react-native-keychain.ts) exposes its in-memory
// store — the same instance sessionVault requires.
const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// Node built-ins, typed the same way importedRealFootageAnalysis.test.ts does
// (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
interface DirEntry {
  name: string;
  isDirectory(): boolean;
}
const fs = require('fs') as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: 'utf8') => string;
  readdirSync: (p: string, options: { withFileTypes: true }) => DirEntry[];
  statSync: (p: string) => { isDirectory(): boolean };
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
};
const childProcess = require('child_process') as {
  execSync: (cmd: string, options: { cwd: string; encoding: 'utf8' }) => string;
};

// ─── Module seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
const mockSqlLog: string[] = [];
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      mockSqlLog.push(`${statement} :: ${JSON.stringify(params)}`);
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

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

// Passthrough View keeps every WebView prop inspectable from the tree.
jest.mock('react-native-webview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

// Imported after the mocks above are registered (jest hoists jest.mock, but
// keeping the import below documents the dependency).
import { DrillVideoPlayer } from '../../src/components/DrillVideoPlayer';

// ─── Paths / helpers ─────────────────────────────────────────────────────────

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string =>
  fs.readFileSync(path.join(MOBILE_ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const SHIPPED_SOURCE_ROOTS = [
  'src',
  'App.tsx',
  'index.js',
  'app.json',
  'ios/PickleSensei',
  'ios/LocalPods',
  'android/app/src/main',
];

/** Same regex the pre-launch checklist mandates, plus common cloud/API key
 * shapes. Intentionally excludes the public prefixes runtimeConfig ships
 * (appl_, test_, *.apps.googleusercontent.com). */
const SECRET_PATTERNS: RegExp[] = [
  /sk_live/,
  /service_role/,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN (RSA |EC )?PRIVATE KEY/,
  /\bsbp_[A-Za-z0-9]{8,}/,
  /\beyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // literal JWT
  /GOCSPX-[A-Za-z0-9_-]{10,}/, // Google OAuth client secret
  /\bghp_[A-Za-z0-9]{30,}/,
  /\bxox[bp]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\bsk_[A-Za-z0-9]{24,}/, // RevenueCat / Stripe secret keys
  /\bgoog_[A-Za-z0-9]{20,}/, // RevenueCat Play public key (Android not shipping)
  /SUPABASE_SERVICE_ROLE_KEY/,
  /REVENUECAT_SECRET_API_KEY/,
  /REVENUECAT_WEBHOOK_AUTH/,
  /UPSTASH_REDIS_REST_TOKEN/,
];

function plistValue(plist: string, key: string): string | null {
  const m = new RegExp(
    `<key>${key}</key>\\s*(<true/>|<false/>|<string>([^<]*)</string>)`,
  ).exec(plist);
  if (!m) return null;
  if (m[1] === '<true/>') return 'true';
  if (m[1] === '<false/>') return 'false';
  return m[2] ?? null;
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
function installFetch(fetchMock: jest.Mock): void {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

/** Routes fetch by URL suffix; unknown routes reject like a dead network. */
function installRoutes(routes: Record<string, RouteHandler>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  installFetch(fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: jest.Mock, suffix: string) {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith(suffix),
  ) as Array<[string, RequestInit | undefined]>;
}

/** Reads the bearer regardless of header casing (the generic transport sends
 * lowercase `authorization`; bootstrap and the auth routes `Authorization`). */
function bearerOf(init?: RequestInit): string | null {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const value = headers['authorization'] ?? headers['Authorization'] ?? null;
  return value?.replace(/^Bearer /, '') ?? null;
}

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const LAST_PROVIDER_KEY = 'auth.last-provider';
const GOOGLE_FLAG = JSON.stringify({ version: 1, provider: 'google' });
const GOOGLE_ID_TOKEN =
  'header.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20ifQ.sig';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

/** Durable-session tokens: the server-minted Supabase access token (the
 * bearer from now on) and the refresh token (the only durable credential). */
const ACCESS_TOKEN_1 = 'sb-access-token-1';
const REFRESH_TOKEN_1 = 'sb-refresh-token-1';
const ACCESS_TOKEN_2 = 'sb-access-token-2';
const REFRESH_TOKEN_2 = 'sb-refresh-token-2';

const accountBody = {
  user: { id: canonicalId, email: 'pat@example.com' },
  onboardingState: 'complete',
};

/** An older server that predates the session contract: no `session` block,
 * so the app bears the provider token for this run (legacy). */
const legacyBootstrap = () => response(accountBody);

/** A server on the durable-session contract. */
const bootstrapWithSession = (tokens: { access: string; refresh: string }) =>
  response({
    ...accountBody,
    session: {
      accessToken: tokens.access,
      refreshToken: tokens.refresh,
      expiresAt: FAR_FUTURE_SECONDS,
    },
  });

const refreshOk = (tokens: { access: string; refresh: string }) =>
  response({
    session: {
      accessToken: tokens.access,
      refreshToken: tokens.refresh,
      expiresAt: FAR_FUTURE_SECONDS,
    },
  });

const unauthorized = (message = 'The access token could not be verified.') =>
  response({ error: { code: 'unauthorized', message } }, 401);

function googleUser(idToken: string | null) {
  return {
    user: {
      id: 'google-uid-1',
      name: 'Pat Player',
      email: 'pat@gmail.example',
      photo: null,
      familyName: 'Player',
      givenName: 'Pat',
    },
    scopes: [],
    idToken,
    serverAuthCode: null,
  };
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

/** Everything that outlives the process on this device: the Keychain items
 * and the SQLite kv values. */
function durableMaterial(): string {
  return JSON.stringify([...__keychainStore.values(), ...mockKv.values()]);
}

function expectNeverPersisted(...tokens: string[]): void {
  const durable = durableMaterial();
  for (const token of tokens) {
    expect(durable).not.toContain(token);
    // Not even as a parameter of any statement issued so far.
    expect(mockSqlLog.some(line => line.includes(token))).toBe(false);
  }
}

/** Lets the 401 → recovery chain (all promise-driven) run to rest. */
async function settleUnauthorizedHandling(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });
}

/** LEGACY path: a device that signed in before the vault existed restores
 * through the Google silent-restore flag against an older server (no
 * session block) — the bearer is the Google ID token itself. */
async function signInGoogleViaLegacySilentRestore(): Promise<jest.Mock> {
  mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG);
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'success',
    data: googleUser(GOOGLE_ID_TOKEN),
  });
  const fetchMock = installRoutes({
    '/v1/account/bootstrap': () => legacyBootstrap(),
  });
  await useAuthStore.getState().hydrate();
  expect(useAuthStore.getState().session?.provider).toBe('google');
  expect(getApiSession()?.bearerToken).toBe(GOOGLE_ID_TOKEN);
  return fetchMock;
}

/** Durable path: an explicit Google sign-in against a server on the session
 * contract — the ID token is spent once by bootstrap, the bearer is the
 * minted access token, the refresh token lands in the Keychain. */
async function signInGoogleDurably(
  extraRoutes: Record<string, RouteHandler> = {},
): Promise<jest.Mock> {
  mockGoogleSignin.signIn.mockResolvedValue({
    type: 'success',
    data: googleUser(GOOGLE_ID_TOKEN),
  });
  const fetchMock = installRoutes({
    '/v1/account/bootstrap': () =>
      bootstrapWithSession({
        access: ACCESS_TOKEN_1,
        refresh: REFRESH_TOKEN_1,
      }),
    ...extraRoutes,
  });
  await useAuthStore.getState().signInWithGoogle();
  expect(useAuthStore.getState().error).toBeNull();
  expect(useAuthStore.getState().session?.provider).toBe('google');
  expect(getApiSession()?.bearerToken).toBe(ACCESS_TOKEN_1);
  return fetchMock;
}

/** Client config shaped like production's long-lived clients: the bearer is
 * a getter resolved per request through `bearerTokenFor` (never spread this
 * object — a spread would capture the bearer once). */
function liveTransportConfig() {
  return {
    baseUrl: 'https://api.example.test',
    get token(): string | null {
      return bearerTokenFor(canonicalId);
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockSqlLog.length = 0;
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
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signIn.mockResolvedValue({ type: 'cancelled', data: null });
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  installFetch(
    jest.fn().mockRejectedValue(new Error('fetch not configured in test')),
  );
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
});

// ─── GUARD: secrets in the shipped bundle / native project ───────────────────

describe('GUARD bundle secrets', () => {
  const files = SHIPPED_SOURCE_ROOTS.flatMap(rel => {
    const full = path.join(MOBILE_ROOT, rel);
    if (!fs.existsSync(full)) return [];
    return fs.statSync(full).isDirectory() ? walk(full) : [full];
  }).filter(f =>
    /\.(ts|tsx|js|json|plist|entitlements|swift|m|mm|h|kt|java|xml|gradle|properties)$/.test(
      f,
    ),
  );

  it('scans a non-trivial set of shipped source files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('contains no private-key / service-role / secret-API-key material', () => {
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(text)) {
          hits.push(`${path.relative(MOBILE_ROOT, file)} ~ ${pattern}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('runtimeConfig.ts ships only the intentional public values', () => {
    const text = read('src/config/runtimeConfig.ts');
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const literals = Array.from(code.matchAll(/'([^'\n]+)'/g), m => m[1] ?? '');
    const nonPublic = literals.filter(
      value =>
        !(
          value.startsWith('https://') ||
          value.startsWith('appl_') || // RevenueCat App Store PUBLIC SDK key
          value.startsWith('test_') || // RevenueCat Test Store PUBLIC key
          value.endsWith('.apps.googleusercontent.com') || // OAuth client ids
          /^\d+(\.\d+)*$/.test(value) || // APP_VERSION
          value === 'ios' ||
          value === 'android' ||
          value === 'react-native'
        ),
    );
    expect(nonPublic).toEqual([]);
    // The Supabase anon/service keys are never needed by the app: the edge
    // function is deployed --no-verify-jwt and authenticates the bearer (the
    // Supabase access token it minted — transitionally a provider ID token)
    // itself.
    expect(text).not.toMatch(/anon|service_role|SUPABASE_KEY/i);
  });

  it('no .env / keystore / provisioning secrets are tracked besides the RN template debug keystore', () => {
    const tracked = childProcess
      .execSync('git ls-files', { cwd: MOBILE_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    const suspicious = tracked.filter(f =>
      /(\.env($|\.)|\.keystore$|\.jks$|\.p8$|\.p12$|\.pem$|\.mobileprovision$|GoogleService-Info\.plist$|google-services\.json$)/.test(
        f,
      ),
    );
    expect(suspicious.sort()).toEqual(
      ['android/app/debug.keystore', 'ios/.xcode.env'].sort(),
    );
    expect(read('ios/.xcode.env')).not.toMatch(/KEY|SECRET|TOKEN/i);
  });
});

// ─── GUARD: Info.plist ATS + URL schemes + entitlements ──────────────────────

describe('GUARD Info.plist / entitlements', () => {
  const plist = read('ios/PickleSensei/Info.plist');
  const entitlements = read('ios/PickleSensei/PickleSensei.entitlements');
  const runtimeConfigText = read('src/config/runtimeConfig.ts');

  it('ATS forbids arbitrary loads and declares no exception domains', () => {
    expect(plistValue(plist, 'NSAllowsArbitraryLoads')).toBe('false');
    expect(plist).not.toMatch(/NSExceptionDomains/);
    expect(plist).not.toMatch(/NSAllowsArbitraryLoadsInWebContent/);
    expect(plist).not.toMatch(/NSExceptionAllowsInsecureHTTPLoads/);
  });

  it('export compliance flag is present and false', () => {
    expect(plistValue(plist, 'ITSAppUsesNonExemptEncryption')).toBe('false');
  });

  it('the only URL scheme is the reversed Google iOS OAuth client id', () => {
    const schemes = Array.from(
      plist.matchAll(
        /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g,
      ),
      m =>
        Array.from(
          (m[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g),
          s => s[1] ?? '',
        ),
    ).flat();
    const iosClientId = /GOOGLE_IOS_CLIENT_ID[^']*'([^']+)'/.exec(
      runtimeConfigText,
    )?.[1];
    expect(iosClientId).toMatch(/\.apps\.googleusercontent\.com$/);
    const reversed = iosClientId!.split('.').reverse().join('.');
    expect(schemes).toEqual([reversed]);
    // No custom app scheme exists, and the JS side registers no URL listener,
    // so there is no deep-link surface to parse untrusted input from.
    const jsSources = walk(path.join(MOBILE_ROOT, 'src'))
      .filter(f => /\.tsx?$/.test(f))
      .map(f => fs.readFileSync(f, 'utf8'))
      .join('\n');
    expect(jsSources).not.toMatch(
      /Linking\.getInitialURL|addEventListener\(\s*'url'/,
    );
    expect(jsSources).not.toMatch(/linking=\{|prefixes:\s*\[/);
  });

  it('Apple Sign-In entitlement is declared', () => {
    expect(entitlements).toMatch(
      /<key>com\.apple\.developer\.applesignin<\/key>\s*<array>\s*<string>Default<\/string>/,
    );
  });
});

// ─── GUARD: access + provider tokens live in memory only; the refresh token
//     lives ONLY in the Keychain ───────────────────────────────────────────────

describe('GUARD token storage', () => {
  it('a durable Google sign-in persists ONLY the refresh token, in the Keychain: the identity token and the access token appear nowhere durable', async () => {
    const fetchMock = await signInGoogleDurably();
    // The ID token was spent exactly once, by the bootstrap exchange.
    const bootstrapCalls = callsTo(fetchMock, '/v1/account/bootstrap');
    expect(bootstrapCalls).toHaveLength(1);
    expect(bearerOf(bootstrapCalls[0]![1])).toBe(GOOGLE_ID_TOKEN);
    expect(getApiSession()).toMatchObject({
      bearerToken: ACCESS_TOKEN_1,
      refreshToken: REFRESH_TOKEN_1,
      canonicalAppUserId: canonicalId,
    });
    // Keychain: refresh token + UI descriptor, nothing else.
    expect(vaultRecord()).toEqual({
      version: 1,
      provider: 'google',
      canonicalAppUserId: canonicalId,
      refreshToken: REFRESH_TOKEN_1,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    });
    expect(__keychainStore.size).toBe(1);
    expectNeverPersisted(GOOGLE_ID_TOKEN, ACCESS_TOKEN_1);
    // SQLite kv holds no session material at all — the refresh token is not
    // in it either, only the provider-name flag for the legacy fallback.
    for (const value of mockKv.values()) {
      expect(value).not.toContain(REFRESH_TOKEN_1);
    }
    expect(mockSqlLog.some(line => line.includes(REFRESH_TOKEN_1))).toBe(false);
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(GOOGLE_FLAG);
  });

  it('a LEGACY Google silent restore (older server, no session) never writes the identity token to SQLite kv or the Keychain', async () => {
    await signInGoogleViaLegacySilentRestore();
    expect(getApiSession()?.bearerToken).toBe(GOOGLE_ID_TOKEN);
    expectNeverPersisted(GOOGLE_ID_TOKEN);
    // Nothing to persist: a provider token is not a session.
    expect(vaultRecord()).toBeNull();
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(GOOGLE_FLAG);
  });

  it('sign-out clears the in-memory bearer synchronously, wipes the Keychain record, and revokes this device\u2019s session server-side', async () => {
    const fetchMock = await signInGoogleDurably({
      '/v1/auth/logout': () => response(null, 204),
    });
    expect(vaultRecord()).not.toBeNull();

    const pending = useAuthStore.getState().signOut();
    // Before a single await: the bearer is gone, so no request that starts
    // now can go out under it.
    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(canonicalId)).toBeNull();
    await pending;

    expect(vaultRecord()).toBeNull();
    expect(__keychainStore.size).toBe(0);
    expect(mockKv.get(LAST_PROVIDER_KEY) ?? '').not.toBe(GOOGLE_FLAG);
    const logout = callsTo(fetchMock, '/v1/auth/logout');
    expect(logout).toHaveLength(1);
    expect(logout[0]![1]).toMatchObject({ method: 'POST' });
    expect(bearerOf(logout[0]![1])).toBe(ACCESS_TOKEN_1);
    expectNeverPersisted(GOOGLE_ID_TOKEN, ACCESS_TOKEN_1, REFRESH_TOKEN_1);
  });
});

// ─── RECOVERY: a rejected bearer is recovered in-app ─────────────────────────
//
// Durable sessions (2026-09-01 contract): the bearer is a short-lived Supabase
// access token; a 401 for the CURRENT bearer rotates it through
// POST /v1/auth/refresh with the Keychain-held refresh token — no provider
// round-trip, no sign-out. The ONE implicit sign-out is the server refusing
// the refresh token, and it leaves nothing durable behind.
// Legacy sessions (older server, no `session` block): the bearer IS the
// provider ID token and there is nothing to rotate, so the pre-contract path
// stays — silent Google re-acquire, else an honest "sign-in expired".

describe('RECOVERY a rejected bearer is recovered in-app', () => {
  const FRESH_GOOGLE_ID_TOKEN =
    'header.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJmcmVzaCI6MX0.sig';

  it('durable session: a 401 rotates the bearer through /v1/auth/refresh — no provider SDK call, the rotated refresh token replaces the spent one in the Keychain, and no access token is ever persisted', async () => {
    const fetchMock = await signInGoogleDurably({
      '/v1/auth/refresh': () =>
        refreshOk({ access: ACCESS_TOKEN_2, refresh: REFRESH_TOKEN_2 }),
      '/v1/analysis-permits': init =>
        bearerOf(init) === ACCESS_TOKEN_2
          ? response({
              permit: {
                id: '11111111-2222-4333-8444-555555555555',
                accessSource: 'free',
                status: 'reserved',
                expiresAt: '2026-09-01T00:10:00.000Z',
              },
            })
          : unauthorized(),
      '/v1/shots:sync': init =>
        bearerOf(init) === ACCESS_TOKEN_2
          ? response({ acceptedIds: [], rejected: [] })
          : unauthorized(),
    });
    const bootstrapCallsBefore = callsTo(fetchMock, '/v1/account/bootstrap');
    expect(bootstrapCallsBefore).toHaveLength(1);

    // Access tokens are short-lived; once one is past `exp` (or revoked) the
    // edge function answers 401 for EVERY authenticated route until the
    // bearer is rotated. Two callers hit it at once — both report the same
    // rejected bearer, and that must cost exactly ONE refresh.
    const permits = createAnalysisPermitClient(liveTransportConfig());
    const transport = createTransport(liveTransportConfig());
    const [reserve, sync] = await Promise.allSettled([
      permits.reserve('11111111-2222-4333-8444-555555555555'),
      transport.syncShots([]),
    ]);
    expect(reserve.status).toBe('rejected');
    expect((reserve as PromiseRejectedResult).reason).toMatchObject({
      status: 401,
    } satisfies Partial<ApiError>);
    expect(sync.status).toBe('rejected');
    const syncError = (sync as PromiseRejectedResult).reason as unknown;
    expect(syncError).toBeInstanceOf(ApiError);
    expect((syncError as ApiError).status).toBe(401);
    // The outbox treats 401 as transient: rows stay queued for the rotated
    // bearer instead of burning their attempt budget.
    expect(isPermanentSyncFailure(syncError)).toBe(false);

    // The clients reported the rejected bearer; the auth store rotated it
    // with the Keychain-held refresh token. No Google SDK involvement, no
    // second bootstrap, no error, still signed in.
    await settleUnauthorizedHandling();
    const refreshCalls = callsTo(fetchMock, '/v1/auth/refresh');
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ refreshToken: REFRESH_TOKEN_1 }),
    });
    // The refresh call carries the refresh token in the body, never a
    // bearer header.
    expect(bearerOf(refreshCalls[0]![1])).toBeNull();
    expect(callsTo(fetchMock, '/v1/account/bootstrap')).toHaveLength(1);
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signIn).toHaveBeenCalledTimes(1); // the sign-in
    expect(useAuthStore.getState().session?.provider).toBe('google');
    expect(useAuthStore.getState().error).toBeNull();
    expect(getApiSession()).toMatchObject({
      bearerToken: ACCESS_TOKEN_2,
      refreshToken: REFRESH_TOKEN_2,
    });
    // Keychain: the rotated refresh token replaced the spent one; the spent
    // one is gone; neither access token nor the ID token is anywhere.
    expect(vaultRecord()).toMatchObject({ refreshToken: REFRESH_TOKEN_2 });
    expect(durableMaterial()).not.toContain(REFRESH_TOKEN_1);
    expectNeverPersisted(GOOGLE_ID_TOKEN, ACCESS_TOKEN_1, ACCESS_TOKEN_2);

    // The same (never rebuilt) clients now go out under the rotated bearer.
    await expect(
      permits.reserve('11111111-2222-4333-8444-555555555555'),
    ).resolves.toMatchObject({ permit: { status: 'reserved' } });
    await expect(transport.syncShots([])).resolves.toEqual({
      acceptedIds: [],
      rejected: [],
    });
    const permitCalls = callsTo(fetchMock, '/v1/analysis-permits');
    expect(permitCalls.map(([, init]) => bearerOf(init))).toEqual([
      ACCESS_TOKEN_1,
      ACCESS_TOKEN_2,
    ]);
  });

  it('durable session: a refused refresh token (401/403 from /v1/auth/refresh) is the one implicit sign-out and leaves nothing durable behind', async () => {
    const fetchMock = await signInGoogleDurably({
      '/v1/auth/refresh': () =>
        response({ error: { message: 'Sign in again.' } }, 401),
      '/v1/shots:sync': () => unauthorized(),
    });
    const transport = createTransport(liveTransportConfig());
    await expect(transport.syncShots([])).rejects.toMatchObject({
      status: 401,
    } satisfies Partial<ApiError>);
    await settleUnauthorizedHandling();

    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(bearerTokenFor(canonicalId)).toBeNull();
    // Every durable trace is gone: Keychain record, legacy silent-restore
    // flag, guest marker — the next launch starts signed out and cannot
    // resurrect this account through any path.
    expect(__keychainStore.size).toBe(0);
    expect(mockKv.get(LAST_PROVIDER_KEY) ?? '').toBe('');
    expect(mockKv.get('auth.local-mode') ?? '').toBe('');
    expectNeverPersisted(GOOGLE_ID_TOKEN, ACCESS_TOKEN_1, REFRESH_TOKEN_1);
    // No interactive prompt behind the user's back.
    expect(mockGoogleSignin.signIn).toHaveBeenCalledTimes(1); // the sign-in
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
  });

  it('LEGACY session: after the backend rejects the provider token (401), the app silently re-acquires a Google token, re-bootstraps, and installs the fresh bearer — no refresh call, nothing to rotate', async () => {
    await signInGoogleViaLegacySilentRestore();

    // Provider ID tokens are short-lived (Apple ~10 min, Google ~1 h); once
    // expired, Supabase Auth's signInWithIdToken rejects them and the edge
    // function answers 401 "The identity token could not be verified." for
    // EVERY authenticated route — until a fresh token is presented.
    const expiredFetch = installRoutes({
      '/v1/account/bootstrap': init =>
        bearerOf(init) === FRESH_GOOGLE_ID_TOKEN
          ? legacyBootstrap()
          : unauthorized('The identity token could not be verified.'),
      '/v1/analysis-permits': () =>
        unauthorized('The identity token could not be verified.'),
      '/v1/shots:sync': () =>
        unauthorized('The identity token could not be verified.'),
    });
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: googleUser(FRESH_GOOGLE_ID_TOKEN),
    });

    // Two callers hit the dead bearer at once; both go out under it (the
    // first 401 clears the in-memory bearer synchronously, so anything that
    // starts later has no bearer to send).
    const permits = createAnalysisPermitClient(liveTransportConfig());
    const transport = createTransport(liveTransportConfig());
    const [reserve, sync] = await Promise.allSettled([
      permits.reserve('11111111-2222-4333-8444-555555555555'),
      transport.syncShots([]),
    ]);
    expect(reserve.status).toBe('rejected');
    expect((reserve as PromiseRejectedResult).reason).toMatchObject({
      status: 401,
    } satisfies Partial<ApiError>);
    expect(sync.status).toBe('rejected');
    const syncError = (sync as PromiseRejectedResult).reason as unknown;
    expect(syncError).toBeInstanceOf(ApiError);
    expect((syncError as ApiError).status).toBe(401);
    expect(
      callsTo(expiredFetch, '/v1/shots:sync').map(([, init]) => bearerOf(init)),
    ).toEqual([GOOGLE_ID_TOKEN]);
    // The outbox treats 401 as transient: rows stay queued for the refreshed
    // bearer instead of burning their attempt budget.
    expect(isPermanentSyncFailure(syncError)).toBe(false);

    // The transport reported the rejected bearer; with no refresh token the
    // auth store asked the Google SDK for a fresh token (no interactive
    // prompt), re-bootstrapped with it, and the session now carries the NEW
    // bearer with no error. /v1/auth/refresh is never even attempted.
    await settleUnauthorizedHandling();
    expect(callsTo(expiredFetch, '/v1/auth/refresh')).toHaveLength(0);
    expect(mockGoogleSignin.signInSilently).toHaveBeenCalledTimes(2);
    expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
    expect(getApiSession()?.bearerToken).toBe(FRESH_GOOGLE_ID_TOKEN);
    expect(useAuthStore.getState().session?.provider).toBe('google');
    expect(useAuthStore.getState().error).toBeNull();
    const rebootstrap = callsTo(expiredFetch, '/v1/account/bootstrap');
    expect(rebootstrap).toHaveLength(1);
    expect(bearerOf(rebootstrap[0]![1])).toBe(FRESH_GOOGLE_ID_TOKEN);
    // The fresh token is still never persisted; a legacy server minted no
    // session, so the Keychain stays empty.
    expectNeverPersisted(GOOGLE_ID_TOKEN, FRESH_GOOGLE_ID_TOKEN);
    expect(vaultRecord()).toBeNull();
  });

  it('LEGACY session: when no silent token is available, the 401 ends the session with an honest "sign-in expired" reason instead of keeping the dead bearer', async () => {
    await signInGoogleViaLegacySilentRestore();
    const fetchMock = installRoutes({
      '/v1/shots:sync': () =>
        unauthorized('The identity token could not be verified.'),
    });
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);

    const transport = createTransport(liveTransportConfig());
    await expect(transport.syncShots([])).rejects.toMatchObject({
      status: 401,
    } satisfies Partial<ApiError>);
    await settleUnauthorizedHandling();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(getApiSession()).toBeNull();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toMatchObject({
      code: 'auth.session_expired',
    });
    expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
    expect(__keychainStore.size).toBe(0);
    expectNeverPersisted(GOOGLE_ID_TOKEN);
  });

  it('session rotation is confined: /v1/auth/refresh is called only from sessionLifecycle.ts, the Keychain is touched only by sessionVault.ts, the in-memory ApiSession store has no refresh primitive, and no module persists tokens elsewhere', () => {
    // The bearer store is a pure in-memory holder — rotation logic lives in
    // sessionLifecycle.ts (HTTP) + sessionKeeper.ts (scheduling), so nothing
    // that merely reads the bearer can mint or persist one.
    const exported = Object.keys(
      jest.requireActual<Record<string, unknown>>(
        '../../src/account/apiSession',
      ),
    ).sort();
    expect(exported).toContain('establishApiSession');
    expect(exported).toContain('bearerTokenFor');
    expect(
      exported.some(name => /refresh|renew|reauth|exchange/i.test(name)),
    ).toBe(false);

    const stripComments = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const sources = walk(path.join(MOBILE_ROOT, 'src'))
      .filter(f => /\.tsx?$/.test(f))
      .map(f => ({
        rel: path.relative(MOBILE_ROOT, f).split('\\').join('/'),
        code: stripComments(fs.readFileSync(f, 'utf8')),
      }));
    const filesMatching = (pattern: RegExp) =>
      sources.filter(s => pattern.test(s.code)).map(s => s.rel);

    // Exactly one module speaks to the auth routes.
    expect(filesMatching(/\/v1\/auth\/refresh/)).toEqual([
      'src/account/sessionLifecycle.ts',
    ]);
    expect(filesMatching(/\/v1\/auth\/logout/)).toEqual([
      'src/account/sessionLifecycle.ts',
    ]);
    expect(
      filesMatching(/\/v1\/(auth|session|token)[a-z/-]*(exchange|token)/),
    ).toEqual([]);
    // Exactly one module holds the durable credential, in the Keychain, and
    // it never stores the access or provider token.
    expect(filesMatching(/['"]react-native-keychain['"]/)).toEqual([
      'src/account/sessionVault.ts',
    ]);
    const vault = read('src/account/sessionVault.ts');
    expect(vault).toMatch(/AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/);
    const persistedShape =
      /export interface PersistedSession \{([\s\S]*?)\}/.exec(vault)?.[1];
    expect(persistedShape).toBeDefined();
    expect(persistedShape).toMatch(/refreshToken: string;/);
    expect(persistedShape).not.toMatch(
      /accessToken|bearerToken|identityToken|idToken|authorizationCode/,
    );
    // No other durable store is in play for anything: AsyncStorage is not a
    // dependency of the app's sources at all.
    expect(filesMatching(/@react-native-async-storage|AsyncStorage/)).toEqual(
      [],
    );
  });
});

// ─── GATE: DrillVideoPlayer WebView navigation is restricted to the provider ─

describe('GATE DrillVideoPlayer WebView navigation is restricted', () => {
  const youtubeMedia: InstructionalMedia = {
    id: '6c8f2a4e-9b31-4f0d-8a57-2e9d4b7c1f03',
    kind: 'embed',
    provider: 'youtube',
    videoId: 'dnk101xyz',
    embedUrl: 'https://www.youtube-nocookie.com/embed/dnk101xyz',
    sourceUrl: 'https://www.youtube.com/watch?v=dnk101xyz',
    creatorName: 'Third Shot Sports',
    licenseName: 'YouTube Terms of Service',
    licenseUrl: 'https://www.youtube.com/t/terms',
    attribution: 'Video by Third Shot Sports on YouTube',
  };

  function renderPlayer(media: InstructionalMedia) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(DrillVideoPlayer, { media, onClose: jest.fn() }),
      );
    });
    return renderer;
  }

  function findWebView(renderer: TestRenderer.ReactTestRenderer) {
    const [node] = renderer.root.findAll(
      n => n.props.testID === 'drill-video-webview' && n.props.source,
    );
    return node ?? null;
  }

  it('routes every request through onShouldStartLoadWithRequest, which only admits https on the shell or provider hosts', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const embedStage = findWebView(renderer)!;
    expect(embedStage).not.toBeNull();
    // '*' hands EVERY request to the gate; the library's own whitelist would
    // otherwise pass anything outside it straight to Linking.openURL.
    expect(embedStage.props.originWhitelist).toEqual(['*']);
    expect(typeof embedStage.props.onShouldStartLoadWithRequest).toBe(
      'function',
    );
    expect(embedStage.props.setSupportMultipleWindows).toBe(false);
    expect(embedStage.props.javaScriptEnabled).toBe(true);

    const gate = embedStage.props.onShouldStartLoadWithRequest as (request: {
      url: string;
      isTopFrame?: boolean;
    }) => boolean;
    expect(gate({ url: youtubeMedia.embedUrl, isTopFrame: true })).toBe(true);
    expect(gate({ url: youtubeMedia.sourceUrl, isTopFrame: true })).toBe(true);
    expect(gate({ url: 'https://com.picklesensei', isTopFrame: true })).toBe(
      true,
    );
    expect(gate({ url: 'https://evil.example/phish', isTopFrame: true })).toBe(
      false,
    );
    expect(
      gate({ url: 'http://www.youtube.com/watch', isTopFrame: true }),
    ).toBe(false);
    expect(gate({ url: 'javascript:alert(1)', isTopFrame: true })).toBe(false);
    expect(gate({ url: 'intent://foo', isTopFrame: true })).toBe(false);
    // Provider sub-frames pass; the top frame stays on the provider.
    expect(gate({ url: 'https://ads.example/pixel', isTopFrame: false })).toBe(
      true,
    );

    // Fall forward to the watch stage: the provider watch page is still
    // gated the same way.
    await act(async () => {
      embedStage.props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'error', code: 150 }) },
      });
    });
    const watchStage = findWebView(renderer)!;
    expect(watchStage.props.source).toEqual({
      uri: youtubeMedia.sourceUrl,
      headers: { Referer: 'https://com.picklesensei' },
    });
    expect(watchStage.props.originWhitelist).toEqual(['*']);
    expect(typeof watchStage.props.onShouldStartLoadWithRequest).toBe(
      'function',
    );
    act(() => renderer.unmount());
  });

  it('shouldLoadInPlayer admits vimeo hosts for vimeo media and rejects a youtube host there', () => {
    const vimeoMedia: InstructionalMedia = {
      ...youtubeMedia,
      provider: 'vimeo',
      embedUrl: 'https://player.vimeo.com/video/123',
      sourceUrl: 'https://vimeo.com/123',
    };
    expect(
      shouldLoadInPlayer(vimeoMedia, {
        url: 'https://player.vimeo.com/video/123',
        isTopFrame: true,
      }),
    ).toBe(true);
    expect(
      shouldLoadInPlayer(vimeoMedia, {
        url: 'https://www.youtube.com/watch?v=x',
        isTopFrame: true,
      }),
    ).toBe(false);
  });
});
