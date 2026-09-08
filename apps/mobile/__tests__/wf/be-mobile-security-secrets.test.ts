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
  mkdtempSync: (prefix: string) => string;
  writeFileSync: (p: string, data: string, encoding: 'hex') => void;
  rmSync: (p: string, options: { recursive: true; force: true }) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
};
interface ProbeStream {
  on(event: 'data', listener: (chunk: { toString(): string }) => void): void;
}
interface SpawnedProbe {
  stdout: ProbeStream;
  stderr: ProbeStream;
  kill(signal: 'SIGKILL'): boolean;
  on(event: 'error', listener: (error: Error) => void): void;
  on(
    event: 'close',
    listener: (status: number | null, signal: string | null) => void,
  ): void;
}
const childProcess = require('child_process') as {
  execSync: (cmd: string, options: { cwd: string; encoding: 'utf8' }) => string;
  spawn: (
    executable: string,
    args: string[],
    options: { cwd: string; stdio: ['ignore', 'pipe', 'pipe'] },
  ) => SpawnedProbe;
  spawnSync: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      encoding: 'utf8';
      timeout: number;
      killSignal: 'SIGKILL';
      maxBuffer: number;
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'];
    },
  ) => {
    status: number | null;
    signal: string | null;
    error?: { code?: string };
    stdout: string;
    stderr: string;
    output: (string | null)[] | null;
  };
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

function buildProbe(source: string, args: string[] = [], timeout = 5000) {
  const { execPath } = require('node:process') as { execPath: string };
  const { performance } = require('node:perf_hooks') as {
    performance: { now(): number };
  };
  // A separate pipe preserves the exact stdout/stderr assertions. Synchronous
  // markers survive SIGKILL and distinguish startup, parsing and exit stalls.
  // Keep spawnSync's original TOTAL deadline, heap, output cap and kill signal.
  const instrumentedSource = `
    const __pickleProbeFs = require('node:fs');
    const __pickleProbeStart = process.hrtime.bigint();
    const __pickleProbeCpu = process.cpuUsage();
    let __pickleProbeRecords = 0;
    const __pickleProbeMark = phase => {
      if (__pickleProbeRecords++ >= 32) return;
      __pickleProbeFs.writeSync(3, JSON.stringify({
        phase,
        elapsedMs: Number(process.hrtime.bigint() - __pickleProbeStart) / 1e6,
        cpu: process.cpuUsage(__pickleProbeCpu),
      }) + '\\n');
    };
    __pickleProbeMark('node-ready');
    process.on('beforeExit', () => __pickleProbeMark('beforeExit'));
    process.on('exit', () => __pickleProbeMark('exit'));
    ${source}
  `;
  const started = performance.now();
  const result = childProcess.spawnSync(
    execPath,
    ['--max-old-space-size=192', '-e', instrumentedSource, ...args],
    {
      cwd: MOBILE_ROOT,
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    },
  );
  return { ...result, elapsedMs: performance.now() - started };
}

function loopProbe(source: string, args: string[] = []) {
  const { execPath } = require('node:process') as { execPath: string };
  return new Promise<{
    stdout: string;
    stderr: string;
    status: number | null;
    signal: string | null;
    timeoutPhase: 'startup' | 'execution' | null;
    outputLimitExceeded: boolean;
  }>((resolve, reject) => {
    const child = childProcess.spawn(
      execPath,
      ['--max-old-space-size=192', '-e', source, ...args],
      {
        cwd: MOBILE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let ready = false;
    let timeoutPhase: 'startup' | 'execution' | null = null;
    let outputLimitExceeded = false;
    // A cold/busy CI process must actually enter the parser before its short
    // execution deadline begins. Startup failure is not a reproduced loop.
    let deadline = setTimeout(() => {
      timeoutPhase = 'startup';
      child.kill('SIGKILL');
    }, 2500);
    const capOutput = () => {
      if (stdout.length + stderr.length > 1024 * 1024) {
        outputLimitExceeded = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      capOutput();
      if (!ready && stdout.includes('entered:')) {
        ready = true;
        clearTimeout(deadline);
        deadline = setTimeout(() => {
          timeoutPhase = 'execution';
          child.kill('SIGKILL');
        }, 100);
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      capOutput();
    });
    child.on('error', error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(deadline);
      resolve({
        stdout,
        stderr,
        status,
        signal,
        timeoutPhase,
        outputLimitExceeded,
      });
    });
  });
}

function requireSuccessfulProbe(result: ReturnType<typeof buildProbe>): string {
  const failed =
    result.status !== 0 ||
    result.signal !== null ||
    result.error?.code !== undefined ||
    result.stderr !== '';
  expect({
    status: result.status,
    signal: result.signal,
    error: result.error?.code,
    stderr: result.stderr,
    ...(failed
      ? {
          probeDiagnostics: {
            elapsedMs: result.elapsedMs,
            phases: result.output?.[3] ?? '(no node-ready marker received)',
            stdout: result.stdout,
          },
        }
      : {}),
  }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
  return result.stdout.trim();
}

function successfulProbe(source: string, args: string[] = []): string {
  return requireSuccessfulProbe(buildProbe(source, args));
}

const unsafeImageFixtures = [
  {
    type: 'icns',
    hex: '69636e73000000106963703100000000',
  },
  {
    type: 'jxl',
    hex: '0000000c4a584c200d0a870a00000014667479706a786c20000000006a786c20000000006a786c70',
  },
  ...[
    '61766966',
    '6d696631',
    '6d736631',
    '68656963',
    '68656978',
    '68657663',
    '68657678',
  ].map(brand => ({
    type: 'heif',
    hex: `0000001066747970${brand}00000000000000006d657461`,
  })),
];

const assetInventoryProbe = `
  const { readFileSync, readdirSync } = require('node:fs');
  const { createHash } = require('node:crypto');
  const { join, extname } = require('node:path');
  const { getAssetSize } = require('metro/private/Assets');
  const assets = [];
  function inspect(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      // Notice resources are deliberately regenerated separately from app media.
      if (file === 'assets/legal') continue;
      if (entry.isDirectory()) inspect(file);
      else {
        const bytes = readFileSync(file);
        assets.push([file, getAssetSize(extname(file).slice(1), bytes, file),
          createHash('sha256').update(bytes).digest('hex')]);
      }
    }
  }
  inspect('assets');
  console.log(JSON.stringify(assets));
  __pickleProbeMark('source-complete');
`;

const workerProbe = `
  const assert = require('node:assert/strict');
  const { transform } = require('metro/private/DeltaBundler/Worker');
  const config = JSON.parse(process.argv[1]);
  assert.equal(require.cache[require.resolve('./metro.config.js')], undefined);
  (async () => {
    const results = [];
    for (const file of JSON.parse(process.argv[2])) {
      try {
        const value = await transform(file, {
          type: 'asset', platform: 'ios', dev: false, minify: false,
          inlineRequires: false, experimentalImportSupport: false,
          unstable_transformProfile: 'hermes-stable',
        }, config.projectRoot, config.worker);
        results.push({ output: value.result.output });
      } catch (error) {
        results.push({ error: error.message });
      }
    }
    console.log(JSON.stringify(results));
    __pickleProbeMark('source-complete');
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;

function workerConfig(guardedWorker = true): string {
  return successfulProbe(`
    __pickleProbeMark('config-start');
    const config = require('./metro.config.js');
    __pickleProbeMark('config-ready');
    console.log(JSON.stringify({
      projectRoot: config.projectRoot,
      worker: {
        transformerPath: ${guardedWorker} ? config.transformerPath : require.resolve('metro-transform-worker'),
        transformerConfig: config.transformer,
      },
    }));
    __pickleProbeMark('source-complete');
  `);
}

describe('GUARD build dependency security', () => {
  it('reports the failed config phase without hiding its stderr', () => {
    const result = buildProbe(`
      __pickleProbeMark('config-start');
      throw new Error('intentional config failure');
    `);
    expect(result.stderr).toContain('intentional config failure');
    expect(result.output?.[3]).not.toContain('config-ready');
    expect(() => requireSuccessfulProbe(result)).toThrow(/config-start/);
  });

  it('rejects a process exit stall even after the exact success output', () => {
    const result = buildProbe(`
      __pickleProbeMark('parser-rejected');
      console.log('rejected-before-decoding');
      __pickleProbeMark('source-complete');
      setInterval(() => {}, 1000);
    `);
    expect(result.stdout.trim()).toBe('rejected-before-decoding');
    expect(result.stderr).toBe('');
    expect(result.error?.code).toBe('ETIMEDOUT');
    expect(result.signal).toBe('SIGKILL');
    expect(result.output?.[3]).not.toContain('beforeExit');
    expect(() => requireSuccessfulProbe(result)).toThrow(/source-complete/);
  });

  it('qs 6.16.0 closes GHSA-4mjr-xmp4-gh2g and GHSA-x5fp-wj9c-mxmx through the locked body-parser path', () => {
    successfulProbe(`
      const assert = require('node:assert/strict');
      const { createRequire } = require('node:module');
      const bodyParserRequire = createRequire(require.resolve('body-parser/package.json'));
      assert.equal(bodyParserRequire.resolve('qs'), require.resolve('qs'));
      assert.equal(require('qs/package.json').version, '6.16.0');
      const qs = bodyParserRequire('qs');
      const input = 'x%5Bconstructor%5D%5BisBuffer%5D=y';
      for (const options of [{ plainObjects: true }, { allowPrototypes: true }]) {
        const parsed = qs.parse(input, options);
        assert.equal(qs.stringify(parsed), input);
      }
      const options = { comma: true, arrayLimit: 3, throwOnLimitExceeded: true };
      for (const input of ['a[]=1,2,3,4', 'a=1,2,3,4']) {
        assert.throws(() => qs.parse(input, options), RangeError);
      }
      assert.deepEqual(qs.parse('name=Pat+Player&tags[]=serve&tags[]=return'), {
        name: 'Pat Player', tags: ['serve', 'return'],
      });
      const { PassThrough } = require('node:stream');
      const req = new PassThrough();
      const form = 'name=Pat+Player&tags[]=serve&tags[]=return';
      req.headers = { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) };
      require('body-parser').urlencoded({ extended: true })(req, {}, error => {
        assert.ifError(error);
        assert.deepEqual(req.body, { name: 'Pat Player', tags: ['serve', 'return'] });
        console.log('body-parser-compatible');
      });
      req.end(form);
    `);
  });

  it.each(unsafeImageFixtures.slice(0, 2))(
    'reproduces the unmitigated $type loop only in a time- and heap-bounded child',
    async ({ type, hex }) => {
      const result = await loopProbe(
        `
          const { getAssetSize } = require('metro/private/Assets');
          console.log('entered:${type}');
          getAssetSize('png', Buffer.from(process.argv[1], 'hex'), 'disguised.png');
        `,
        [hex],
      );
      expect(result.stdout).toContain(`entered:${type}`);
      expect(result.timeoutPhase).toBe('execution');
      expect(result.outputLimitExceeded).toBe(false);
      expect(result.stderr).toBe('');
      expect(result.signal).toBe('SIGKILL');
    },
  );

  it('the installed HEIF zero-size traversal is already bounded, without treating the advisory as fixed', () => {
    successfulProbe(
      `
      const assert = require('node:assert/strict');
      const imageSize = require('image-size');
      assert.equal(require('image-size/package.json').version, '1.2.1');
      for (const { hex } of JSON.parse(process.argv[1])) {
        assert.throws(() => imageSize(Buffer.from(hex, 'hex')), /Invalid HEIF, no size found/);
      }
    `,
      [JSON.stringify(unsafeImageFixtures.slice(2))],
    );
  });

  it.each(unsafeImageFixtures)(
    'rejects detected $type bytes disguised as PNG in the config process',
    ({ type, hex }) => {
      expect(
        successfulProbe(
          `
        __pickleProbeMark('config-start');
        require('./metro.config.js');
        __pickleProbeMark('config-ready');
        const assert = require('node:assert/strict');
        const { getAssetSize } = require('metro/private/Assets');
        __pickleProbeMark('parser-start');
        assert.throws(
          () => getAssetSize('png', Buffer.from(process.argv[1], 'hex'), 'disguised.png'),
          { name: 'TypeError', message: 'disabled file type: ${type}' },
        );
        __pickleProbeMark('parser-rejected');
        console.log('rejected-before-decoding');
        __pickleProbeMark('source-complete');
      `,
          [hex],
        ),
      ).toBe('rejected-before-decoding');
    },
  );

  it('fresh Metro workers fail fast on disguised files without loading the app config', () => {
    const config = workerConfig();
    const { tmpdir } = require('node:os') as { tmpdir: () => string };
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'pickle-build-security-'));
    try {
      for (const [index, { type, hex }] of unsafeImageFixtures.entries()) {
        const file = path.join(dir, `disguised-${index}.png`);
        fs.writeFileSync(file, hex, 'hex');
        expect(
          JSON.parse(
            successfulProbe(workerProbe, [config, JSON.stringify([file])]),
          ),
        ).toEqual([{ error: `disabled file type: ${type}` }]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves every real app bitmap, font and movie byte/dimension and worker output', () => {
    const original = JSON.parse(successfulProbe(assetInventoryProbe)) as [
      string,
      { width: number; height: number } | null,
      string,
    ][];
    const protectedAssets = JSON.parse(
      successfulProbe(`
        __pickleProbeMark('config-start');
        require('./metro.config.js');
        __pickleProbeMark('config-ready');
        ${assetInventoryProbe}
      `),
    );
    expect(original.some(([, size]) => size !== null)).toBe(true);
    expect(protectedAssets).toEqual(original);
    const files = JSON.stringify(
      original
        .filter(([file, size]) => size !== null || /\.(mp4|ttf)$/.test(file))
        .map(([file]) => file),
    );
    const upstream = JSON.parse(
      successfulProbe(workerProbe, [workerConfig(false), files]),
    );
    const transformed = JSON.parse(
      successfulProbe(workerProbe, [workerConfig(), files]),
    );
    expect(transformed).toEqual(upstream);
    for (const result of transformed) {
      expect(result.error).toBeUndefined();
      expect(result.output[0].type).toBe('js/module/asset');
      expect(result.output[0].data.code).toContain('registerAsset');
    }
  });

  it('disables only the affected decoders, preserving cache keys, Sentry configuration, other formats and movie assets', () => {
    successfulProbe(
      `
      const assert = require('node:assert/strict');
      const { createRequire } = require('node:module');
      const { readFileSync } = require('node:fs');
      __pickleProbeMark('config-start');
      const config = require('./metro.config.js');
      __pickleProbeMark('config-ready');
      const metroRequire = createRequire(require.resolve('metro/package.json'));
      const imageSize = metroRequire('image-size');
      const wrapped = require(config.transformerPath);
      const upstream = require('metro-transform-worker');
      assert.equal(wrapped.transform, upstream.transform);
      assert.equal(wrapped.getCacheKey, upstream.getCacheKey);
      assert.equal(typeof wrapped.getCacheKey(config.transformer, { projectRoot: config.projectRoot }), 'string');
      assert.equal(typeof config.serializer.customSerializer, 'function');
      const { typeHandlers } = require(require('node:path').join(require.resolve('image-size'), '..', 'types/index.js'));
      const called = new Set();
      for (const [type, handler] of Object.entries(typeHandlers)) {
        handler.validate = input => input[0] === imageSize.types.indexOf(type);
        handler.calculate = () => { called.add(type); return { width: 1, height: 1 }; };
      }
      for (const [index, type] of imageSize.types.entries()) {
        const decode = () => imageSize(Buffer.from([index]));
        if (['icns', 'jxl', 'heif'].includes(type)) {
          assert.throws(decode, { message: 'disabled file type: ' + type });
          assert.ok(!called.has(type));
        } else {
          assert.deepEqual(decode(), { width: 1, height: 1, type });
          assert.ok(called.has(type));
        }
      }
      const { getAssetSize } = require('metro/private/Assets');
      assert.ok(config.resolver.assetExts.includes('mp4'));
      assert.ok(config.resolver.assetExts.includes('mov'));
      assert.equal(getAssetSize('mp4', readFileSync('assets/brand/splash.mp4'), 'splash.mp4'), null);
      assert.equal(getAssetSize('mov', Buffer.from(process.argv[1], 'hex'), 'native-import.mov'), null);
      __pickleProbeMark('source-complete');
    `,
      [unsafeImageFixtures[0]!.hex],
    );
  });

  it('keeps the vulnerable navigation decoder outside external navigation input while retaining its audit boundary', () => {
    const sourcePaths = [
      ...walk(path.join(MOBILE_ROOT, 'src')).filter(file =>
        /\.[jt]sx?$/.test(file),
      ),
      path.join(MOBILE_ROOT, 'App.tsx'),
      path.join(MOBILE_ROOT, 'index.js'),
    ];
    const sources = sourcePaths
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(
      /\b(getStateFromPath|useLinkTo|useLinkBuilder|useBuildAction|useLinkProps|createStaticNavigation)\b/,
    );
    expect(sources).not.toMatch(
      /['"](?:query-string|decode-uri-component)['"]/,
    );
    expect(sources).not.toMatch(/linking\s*=|prefixes:\s*\[/);
    expect(read('src/navigation/RootNavigator.tsx')).toMatch(
      /<NavigationContainer ref=\{navigationRef\} theme=\{theme\}>/,
    );
    expect(
      read('node_modules/@react-navigation/native/src/NavigationContainer.tsx'),
    ).toContain(
      'const isLinkingEnabled = linking ? linking.enabled !== false : false;',
    );
    const nativeLinking = read(
      'node_modules/@react-navigation/native/src/useLinking.native.tsx',
    );
    expect(nativeLinking).toMatch(
      /if \(enabledRef.current\)\s*\{\s*const url = getInitialURLRef.current\(\)/,
    );
    expect(nativeLinking).toMatch(
      /if \(!enabled \|\| !navigation\)\s*\{\s*return;/,
    );
    successfulProbe(`
      const assert = require('node:assert/strict');
      assert.equal(require('query-string/package.json').dependencies['decode-uri-component'], '^0.2.2');
      assert.equal(typeof require('decode-uri-component'), 'function');
      const lock = require('./package-lock.json');
      assert.equal(lock.packages['node_modules/@react-navigation/core'].dependencies['query-string'], '^7.1.3');
    `);
  });

  it('does not blind-override the CommonJS query-string decoder with an ESM default export', () => {
    successfulProbe(`
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const { runInThisContext } = require('node:vm');
      // Offline export-contract fixture, not a vendored or patched decoder.
      // The actual 0.5.0 tarball was separately integrity-verified during W11.
      const source = 'export default function decode(value) { return decodeURIComponent(value); }';
      (async () => {
        const namespace = await import('data:text/javascript,' + encodeURIComponent(source));
        const transformed = require('@babel/core').transformSync(source, {
          babelrc: false, configFile: false, filename: 'decoder-contract.js',
          presets: ['module:@react-native/babel-preset'],
        });
        const compiled = { exports: {} };
        runInThisContext(Module.wrap(transformed.code))(
          compiled.exports, require, compiled, 'decoder-contract.js', process.cwd(),
        );
        const originalLoad = Module._load;
        for (const replacement of [namespace, compiled.exports]) {
          assert.equal(typeof replacement.default, 'function');
          assert.equal(typeof replacement, 'object');
          delete require.cache[require.resolve('query-string')];
          Module._load = function (id, ...args) {
            return id === 'decode-uri-component' ? replacement : originalLoad.call(this, id, ...args);
          };
          try {
            assert.throws(() => require('query-string').parse('name=Pat%20Player'), {
              name: 'TypeError', message: 'decodeComponent is not a function',
            });
          } finally { Module._load = originalLoad; }
        }
        assert.equal(require('./package-lock.json').packages['node_modules/decode-uri-component'].version, '0.2.2');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
  });

  it('retains the reachable decoder advisory when getStateFromPath is explicitly invoked, in a bounded child only', async () => {
    const result = await loopProbe(`
      const { getStateFromPath } = require('./node_modules/@react-navigation/core/lib/module/getStateFromPath.js');
      console.log('entered:navigation-decoder');
      getStateFromPath('/Home?name=' + '%FF'.repeat(512));
    `);
    expect(result.stdout).toContain('entered:navigation-decoder');
    expect(result.timeoutPhase).toBe('execution');
    expect(result.outputLimitExceeded).toBe(false);
    expect(result.stderr).toBe('');
    expect(result.signal).toBe('SIGKILL');
  });

  it('the real native linking hook ignores cold-start and event URLs when disabled, with an enabled positive control', () => {
    expect(
      successfulProbe(`
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const { runInThisContext } = require('node:vm');
      const React = require('react');
      const Renderer = require('react-test-renderer');
      const { getStateFromPath } = require('./node_modules/@react-navigation/core/lib/module/getStateFromPath.js');
      const { getActionFromState } = require('./node_modules/@react-navigation/core/lib/module/getActionFromState.js');
      const extract = require('./node_modules/@react-navigation/native/lib/module/extractPathFromURL.js');
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      const originalError = console.error;
      console.error = (message, ...args) => {
        if (String(message).startsWith('react-test-renderer is deprecated.')) return;
        originalError(message, ...args);
      };
      let listener, parseCalls = 0, initialCalls = 0, removals = 0;
      let initialURL = 'pickle://Home?name=' + '%FF'.repeat(512);
      const actions = [];
      const navigation = { current: {
        getRootState: () => ({ key: 'root', routes: [{ name: 'Home' }] }),
        dispatch: action => actions.push(action),
        resetRoot: state => actions.push(state),
      } };
      const Linking = {
        getInitialURL: () => { initialCalls++; return Promise.resolve(initialURL); },
        addEventListener: (type, callback) => {
          assert.equal(type, 'url'); listener = callback;
          return { remove: () => { removals++; listener = undefined; } };
        },
      };
      const transformed = require('@babel/core').transformFileSync(
        './node_modules/@react-navigation/native/src/useLinking.native.tsx',
        { babelrc: false, configFile: false, presets: ['module:@react-native/babel-preset'] },
      );
      const compiled = { exports: {} };
      const localRequire = id => {
        if (id === 'react-native') return { Linking, Platform: { OS: 'ios' } };
        if (id === '@react-navigation/core') return {
          getStateFromPath: (...args) => { parseCalls++; return getStateFromPath(...args); },
          getActionFromState, useNavigationIndependentTree: () => false,
        };
        if (id === './extractPathFromURL') return extract;
        return require(id);
      };
      runInThisContext(Module.wrap(transformed.code))(
        compiled.exports, localRequire, compiled, 'native-linking-probe.js', process.cwd(),
      );
      let hook, tree;
      function Probe({ enabled }) {
        hook = compiled.exports.useLinking(navigation, { enabled, prefixes: ['pickle://'] });
        return null;
      }
      (async () => {
        try {
          await React.act(async () => { tree = Renderer.create(React.createElement(Probe, { enabled: false })); });
          assert.equal(await hook.getInitialState(), undefined);
          listener({ url: initialURL });
          assert.equal(initialCalls, 0);
          assert.equal(parseCalls, 0);
          assert.deepEqual(actions, []);
          await React.act(async () => { tree.unmount(); });
          assert.equal(removals, 1);
          initialURL = 'pickle://Home?name=Pat+Player&tag=serve&tag=return';
          await React.act(async () => { tree = Renderer.create(React.createElement(Probe, { enabled: true })); });
          const state = await hook.getInitialState();
          assert.deepEqual(state.routes[0].params, { name: 'Pat Player', tag: ['serve', 'return'] });
          listener({ url: initialURL });
          assert.equal(initialCalls, 1);
          assert.equal(parseCalls, 2);
          assert.equal(actions.length, 1);
          console.log('native-linking-boundary-verified');
        } finally {
          await React.act(async () => { tree?.unmount(); });
          console.error = originalError;
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `),
    ).toBe('native-linking-boundary-verified');
  });

  it("the scoped uuid 11.1.1 CommonJS patch preserves xcode's zero-argument v4 calls, outside the advisory buffer paths", () => {
    successfulProbe(`
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const xcodeRequire = Module.createRequire(require.resolve('xcode/package.json'));
      assert.equal(xcodeRequire.resolve('uuid'), require.resolve('uuid'));
      assert.equal(xcodeRequire('uuid/package.json').version, '11.1.1');
      assert.ok(xcodeRequire.resolve('uuid').endsWith('/dist/cjs/index.js'));
      const uuid = xcodeRequire('uuid');
      const originalLoad = Module._load;
      const calls = [];
      Module._load = function (id, ...args) {
        if (id === 'uuid') return new Proxy({}, {
          get(_, key) {
            assert.equal(key, 'v4');
            return (...values) => { calls.push(values); return uuid.v4(...values); };
          },
        });
        return originalLoad.call(this, id, ...args);
      };
      const project = require('xcode').project('in-memory.pbxproj');
      project.hash = { project: { objects: {} } };
      const ids = Array.from({ length: 100 }, () => project.generateUuid());
      assert.equal(new Set(ids).size, 100);
      assert.ok(ids.every(id => /^[A-F0-9]{24}$/.test(id)));
      assert.equal(calls.length, 100);
      assert.ok(calls.every(args => args.length === 0));
      const lock = require('./package-lock.json');
      const consumers = Object.entries(lock.packages).filter(([, value]) => value.dependencies?.uuid).map(([name]) => name);
      assert.deepEqual(consumers, ['node_modules/xcode']);
      assert.equal(lock.packages['node_modules/react-native-notify-kit'].optionalDependencies.xcode, '^3.0.1');
      assert.deepEqual(require('./package.json').overrides, { 'xcode@3.0.1': { uuid: '11.1.1' } });
    `);
  });

  it('uuid 11.1.1 rejects the v3/v5/v6 advisory output-buffer bounds without partial writes', () => {
    successfulProbe(`
      const assert = require('node:assert/strict');
      const uuid = require('uuid');
      for (const [size, offset] of [[8, 4], [16, 1], [16, -1]]) {
        for (const name of ['v3', 'v5', 'v6']) {
          const bytes = new Uint8Array(size).fill(170);
          const call = () => name === 'v6'
            ? uuid.v6({}, bytes, offset)
            : uuid[name]('x', uuid[name].DNS, bytes, offset);
          assert.throws(call, RangeError);
          assert.ok(bytes.every(value => value === 170));
        }
      }
    `);
  });
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
          value === 'react-native' ||
          value === 'com.picklesensei' ||
          value === 'development' ||
          value === 'test' ||
          value === 'production'
        ),
    );
    expect(nonPublic).toEqual([]);
    // The Supabase anon/service keys are never needed by the app: the edge
    // function is deployed --no-verify-jwt and authenticates the bearer (the
    // Supabase access token it minted — transitionally a provider ID token)
    // itself.
    expect(text).not.toMatch(/anon|service_role|SUPABASE_KEY/i);
  });

  it('pins the API platform JWT setting in versioned CLI configuration', () => {
    const config = read('../../supabase/config.toml');
    expect(config).toMatch(/^project_id\s*=\s*"pickle-sensei"\s*$/m);
    expect(config).toMatch(
      /^\[functions\.api\]\s*\nverify_jwt\s*=\s*false\s*$/m,
    );
    expect(config.match(/^\[/gm)).toHaveLength(1);
    expect(config).not.toMatch(/secret|token|password|service_role|anon_key/i);
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
      generation: expect.any(Number),
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

  it('confines session rotation and credentials to their owners, with deletion capabilities in a separate device-only job vault', () => {
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
    expect(filesMatching(/['"]react-native-keychain['"]/).sort()).toEqual([
      'src/account/deletionCapabilityVault.ts',
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
    const deletionVault = read('src/account/deletionCapabilityVault.ts');
    expect(deletionVault).toContain(
      'com.picklesensei.account-deletion.v1.${jobId}',
    );
    expect(deletionVault).toContain('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
    expect(deletionVault).toContain('cloudSync: false');
    expect(deletionVault).toContain('sameDeletionBinding(record, binding)');
    expect(deletionVault).toContain('parseDeletionSecret(value)');
    expect(deletionVault).not.toMatch(
      /refreshToken|accessToken|bearerToken|identityToken|idToken|authorizationCode|resetGenericPassword|sessionVault|sessionLifecycle/,
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
