/**
 * mobile-security-secrets audit (workflow be-mobile-security-secrets).
 *
 * Executable evidence for the audit report, in two flavours:
 *   - GUARD tests pin the checks that came back clean (no secrets in the
 *     shipped JS/native sources, ATS + URL-scheme invariants in Info.plist,
 *     provider tokens never written to SQLite kv).
 *   - RECOVERY / GATE tests pin the fixes for the defects the audit found:
 *     a rejected bearer is re-acquired silently (Google) or ends the session
 *     with an honest reason, and the drill WebView only navigates within the
 *     provider's hosts.
 *
 * Mock style follows authHydrateRestore.test.ts (in-memory kv LocalDb, Google
 * SDK module mock, jest.fn fetch) and drillVideoPlayer.test.tsx (passthrough
 * WebView). No JSX: the workflow file glob is *.test.ts.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import type { InstructionalMedia } from '../../src/training/types';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const LAST_PROVIDER_KEY = 'auth.last-provider';
const GOOGLE_FLAG = JSON.stringify({ version: 1, provider: 'google' });
const GOOGLE_ID_TOKEN =
  'header.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20ifQ.sig';

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

async function signInGoogleViaSilentRestore(): Promise<void> {
  mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG);
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'success',
    data: googleUser(GOOGLE_ID_TOKEN),
  });
  installFetch(
    jest.fn().mockResolvedValue(
      response({
        user: { id: canonicalId, email: 'pat@example.com' },
        onboardingState: 'complete',
      }),
    ),
  );
  await useAuthStore.getState().hydrate();
  expect(useAuthStore.getState().session?.provider).toBe('google');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockSqlLog.length = 0;
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
  installFetch(
    jest.fn().mockRejectedValue(new Error('fetch not configured in test')),
  );
});

afterEach(() => {
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
    // function is deployed --no-verify-jwt and authenticates the provider
    // token itself.
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

// ─── GUARD: provider token lives in memory only ──────────────────────────────

describe('GUARD token storage', () => {
  it('a Google sign-in never writes the identity token to SQLite kv', async () => {
    await signInGoogleViaSilentRestore();
    expect(getApiSession()?.bearerToken).toBe(GOOGLE_ID_TOKEN);
    for (const value of mockKv.values()) {
      expect(value).not.toContain(GOOGLE_ID_TOKEN);
    }
    // Not even as a parameter of any statement issued during sign-in.
    expect(mockSqlLog.some(line => line.includes(GOOGLE_ID_TOKEN))).toBe(false);
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(GOOGLE_FLAG);
  });

  it('sign-out clears the in-memory bearer synchronously', async () => {
    await signInGoogleViaSilentRestore();
    await useAuthStore.getState().signOut();
    expect(getApiSession()).toBeNull();
    expect(mockKv.get(LAST_PROVIDER_KEY) ?? '').not.toBe(GOOGLE_FLAG);
  });
});

// ─── REPRO: the bearer IS the provider ID token and is never refreshed ───────

describe('RECOVERY provider-token expiry is handled in-app', () => {
  const FRESH_GOOGLE_ID_TOKEN =
    'header.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJmcmVzaCI6MX0.sig';

  it('after the backend rejects the token (401), the app silently re-acquires a Google token, re-bootstraps, and installs the fresh bearer', async () => {
    await signInGoogleViaSilentRestore();
    const session = getApiSession()!;
    const bootstrapCalls = (globalThis.fetch as jest.Mock).mock.calls.length;

    // Provider ID tokens are short-lived (Apple ~10 min, Google ~1 h); once
    // expired, Supabase Auth's signInWithIdToken rejects them and the edge
    // function answers 401 "The identity token could not be verified." for
    // EVERY authenticated route — until a fresh token is presented.
    const expiredFetch = jest.fn(
      async (url: string, init: { headers: Record<string, string> }) => {
        const bearer =
          init.headers['authorization'] ?? init.headers['Authorization'];
        if (
          bearer === `Bearer ${FRESH_GOOGLE_ID_TOKEN}` &&
          url.endsWith('/v1/account/bootstrap')
        ) {
          return response({
            user: { id: canonicalId, email: 'pat@example.com' },
            onboardingState: 'complete',
          });
        }
        return response(
          {
            error: {
              code: 'unauthorized',
              message: 'The identity token could not be verified.',
            },
          },
          401,
        );
      },
    );
    installFetch(expiredFetch);
    mockGoogleSignin.signInSilently.mockResolvedValue({
      type: 'success',
      data: googleUser(FRESH_GOOGLE_ID_TOKEN),
    });

    const permits = createAnalysisPermitClient({
      baseUrl: session.apiBaseUrl,
      token: session.bearerToken,
    });
    await expect(
      permits.reserve('11111111-2222-4333-8444-555555555555'),
    ).rejects.toMatchObject({ status: 401 } satisfies Partial<ApiError>);

    const transport = createTransport({
      baseUrl: session.apiBaseUrl,
      token: session.bearerToken,
    });
    let syncError: unknown = null;
    try {
      await transport.syncShots([]);
    } catch (error) {
      syncError = error;
    }
    expect(syncError).toBeInstanceOf(ApiError);
    expect((syncError as ApiError).status).toBe(401);
    // The outbox treats 401 as transient: rows stay queued for the refreshed
    // bearer instead of burning their attempt budget.
    expect(isPermanentSyncFailure(syncError)).toBe(false);

    // The transport reported the rejected bearer; the auth store asked the
    // Google SDK for a fresh token (no interactive prompt), re-bootstrapped
    // with it, and the session now carries the NEW bearer with no error.
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
    expect(mockGoogleSignin.signInSilently).toHaveBeenCalledTimes(2);
    expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
    expect(getApiSession()?.bearerToken).toBe(FRESH_GOOGLE_ID_TOKEN);
    expect(useAuthStore.getState().session?.provider).toBe('google');
    expect(useAuthStore.getState().error).toBeNull();
    expect(bootstrapCalls).toBe(1);
    const rebootstrap = expiredFetch.mock.calls.filter(([url]) =>
      url.endsWith('/v1/account/bootstrap'),
    );
    expect(rebootstrap).toHaveLength(1);
    expect(rebootstrap[0]![1].headers['Authorization']).toBe(
      `Bearer ${FRESH_GOOGLE_ID_TOKEN}`,
    );
    // The fresh token is still never persisted.
    for (const value of mockKv.values()) {
      expect(value).not.toContain(FRESH_GOOGLE_ID_TOKEN);
    }
  });

  it('when no silent token is available, the 401 ends the session with an honest "sign-in expired" reason instead of keeping the dead bearer', async () => {
    await signInGoogleViaSilentRestore();
    const session = getApiSession()!;
    installFetch(
      jest.fn().mockResolvedValue(
        response(
          {
            error: {
              code: 'unauthorized',
              message: 'The identity token could not be verified.',
            },
          },
          401,
        ),
      ),
    );
    mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);

    const transport = createTransport({
      baseUrl: session.apiBaseUrl,
      token: session.bearerToken,
    });
    await expect(transport.syncShots([])).rejects.toMatchObject({
      status: 401,
    } satisfies Partial<ApiError>);
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
    expect(getApiSession()).toBeNull();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toMatchObject({
      code: 'auth.session_expired',
    });
    expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
  });

  it('the api session module exposes no refresh / re-auth primitive', () => {
    const exported = Object.keys(
      jest.requireActual<Record<string, unknown>>(
        '../../src/account/apiSession',
      ),
    ).sort();
    expect(exported).toContain('establishApiSession');
    expect(
      exported.some(name => /refresh|renew|reauth|exchange/i.test(name)),
    ).toBe(false);
    // Nor does any app module call a refresh/exchange endpoint.
    const jsSources = walk(path.join(MOBILE_ROOT, 'src'))
      .filter(f => /\.tsx?$/.test(f))
      .map(f => fs.readFileSync(f, 'utf8'))
      .join('\n');
    expect(jsSources).not.toMatch(
      /\/v1\/(auth|session|token)[a-z/-]*(refresh|exchange)/,
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
