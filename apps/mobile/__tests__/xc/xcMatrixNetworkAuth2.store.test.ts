/**
 * xc-matrix-network-auth-2 — MOBILE plane, store-level matrix: the whole
 * durable-session stack (authStore.hydrate → sessionVault Keychain record →
 * sessionKeeper → sessionLifecycle) driven through every NETWORK × AUTH cell
 * with fake timers, so an offline launch, a flaky reconnect and hours of
 * backoff run in milliseconds.
 *
 *   NETWORK  offline        every request fails (reject or hang until the
 *                           15 s abort) for the whole scenario
 *            intermittent   the first N requests fail, then the server answers
 *            reconnect      requests fail until T ms after launch, then answer
 *   AUTH     what the EDGE answers once reachable: ok (rotation), refused_401,
 *            refused_403, edge_429, edge_503, edge_500, malformed_200_*,
 *            non_json_200, wrong-shape 200.
 *
 * Expected, per the ONE implicit sign-out rule (AGENTS.md "Auth sessions"):
 *   - refused_401 / refused_403 delivered  ⇒ signed out, Keychain record
 *     cleared, data owner signed-out, no error surfaced, no further refresh
 *     requests (exactly once).
 *   - anything else, delivered or not      ⇒ still signed in from the record,
 *     Keychain record intact, hydrate() resolved within the 8 s launch
 *     budget, keeper still retrying; once an `ok` lands the bearer is
 *     installed and the rotated refresh token replaces the spent one.
 *
 * Also recorded (timing evidence for the lost-response case): how long after
 * the FIRST refresh request the SECOND one is sent when the first hangs — the
 * server may have rotated the token and lost the response, so the retry
 * re-sends the spent token that long after the server rotated.
 *
 * Run (apps/mobile):
 *   npx jest --ci __tests__/xc/xcMatrixNetworkAuth2.store.test.ts
 *   XC_STORE_CELL=refused_401@reconnect npx jest --ci __tests__/xc/xcMatrixNetworkAuth2.store.test.ts
 * Artifacts: artifacts/xc-matrix-network-auth-2/mobile/store-matrix-*.json (XC_OUT overrides).
 */
import { AppState, NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

/** Node globals the RN tsconfig does not declare (same pattern as
 * be-mobile-security-secrets.test.ts / liveCourt.test.ts). */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  memoryUsage: () => { heapUsed: number; rss: number; external: number };
};
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

/** What the classifier sees when the app-side timeout aborts the fetch. */
function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

const REAL_NOW: () => number = Date.now.bind(Date);

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Module seams (same shape as authDurableSession.test.ts) ─────────────────

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

// ─── Matrix axes ─────────────────────────────────────────────────────────────

type Network = 'offline' | 'intermittent' | 'reconnect';
type Auth =
  | 'ok'
  | 'refused_401'
  | 'refused_403'
  | 'edge_429'
  | 'edge_500'
  | 'edge_503'
  | 'malformed_200_no_session'
  | 'malformed_200_missing_refresh'
  | 'malformed_200_expires_string'
  | 'non_json_200'
  | 'html_200';
type Failure = 'reject' | 'hang';

const NETWORKS: readonly Network[] = ['offline', 'intermittent', 'reconnect'];
const AUTHS: readonly Auth[] = [
  'ok',
  'refused_401',
  'refused_403',
  'edge_429',
  'edge_500',
  'edge_503',
  'malformed_200_no_session',
  'malformed_200_missing_refresh',
  'malformed_200_expires_string',
  'non_json_200',
  'html_200',
];
const FAILURES: readonly Failure[] = ['reject', 'hang'];

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const INTERMITTENT_DROPS = 3;
const RECONNECT_AFTER_MS = 90_000;
const OBSERVATION_MS = 20 * 60_000;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let rotation = 0;
function serve(auth: Auth): Response {
  rotation += 1;
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const session = {
    accessToken: `access-${rotation}`,
    refreshToken: `refresh-${rotation}`,
    expiresAt,
  };
  switch (auth) {
    case 'ok':
      return response({ session });
    case 'refused_401':
      return response(
        {
          error: {
            message: 'The session could not be refreshed. Sign in again.',
          },
        },
        401,
      );
    case 'refused_403':
      return response({ error: { message: 'Forbidden.' } }, 403);
    case 'edge_429':
      return response(
        { error: { code: 'rate_limited', message: 'Too many requests.' } },
        429,
      );
    case 'edge_500':
      return response({ error: { message: 'Internal error.' } }, 500);
    case 'edge_503':
      return response(
        { error: { message: 'Session refresh is unavailable.' } },
        503,
      );
    case 'malformed_200_no_session':
      return response({ user: { id: canonicalId } });
    case 'malformed_200_missing_refresh':
      return response({
        session: { accessToken: session.accessToken, expiresAt },
      });
    case 'malformed_200_expires_string':
      return response({
        session: { ...session, expiresAt: String(expiresAt) },
      });
    case 'non_json_200':
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      } as unknown as Response;
    case 'html_200':
      return {
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      } as unknown as Response;
  }
}

interface RequestLog {
  t: number;
  url: string;
  refreshTokenSent: string | null;
  bearer: string | null;
  result: 'delivered' | 'reject' | 'hang';
  status: number | null;
}

interface CellResult {
  id: string;
  network: Network;
  auth: Auth;
  failure: Failure;
  expected: 'signed_out' | 'signed_in';
  observed:
    'signed_out' | 'signed_in' | 'signed_out_with_error' | 'inconsistent';
  verdict: 'PASS' | 'FAIL';
  violations: string[];
  hydrateMs: number;
  hydratedSignedInAtLaunch: boolean;
  requests: RequestLog[];
  refreshRequests: number;
  deliveredAuthAnswers: number;
  bearerAtEnd: string | null;
  vaultRefreshTokenAtEnd: string | null;
  dataOwnerAtEnd: string;
  errorAtEnd: unknown;
  signedOutAtMs: number | null;
  firstRetryAfterHangMs: number | null;
}

let appStateHandlers: Array<(state: string) => void> = [];

function vaultRecord(): { refreshToken?: string } | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as { refreshToken?: string }) : null;
}

function seedVault(refreshToken: string, provider: 'apple' | 'google') {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider,
      canonicalAppUserId: canonicalId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

async function runCell(
  network: Network,
  auth: Auth,
  failure: Failure,
): Promise<CellResult> {
  const id = `${auth}@${network}/${failure}`;
  const start = Date.now();
  const requests: RequestLog[] = [];
  const violations: string[] = [];
  let signedOutAtMs: number | null = null;
  let deliveredAuthAnswers = 0;
  rotation = 0;
  seedVault('refresh-seed', auth === 'refused_403' ? 'google' : 'apple');

  const reachable = (index: number): boolean => {
    switch (network) {
      case 'offline':
        return false;
      case 'intermittent':
        return index >= INTERMITTENT_DROPS;
      case 'reconnect':
        return Date.now() - start >= RECONNECT_AFTER_MS;
    }
  };

  globalThis.fetch = jest.fn(
    async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      let refreshTokenSent: string | null = null;
      try {
        refreshTokenSent =
          (
            JSON.parse(String(init?.body ?? 'null')) as {
              refreshToken?: string;
            } | null
          )?.refreshToken ?? null;
      } catch {
        refreshTokenSent = null;
      }
      const entry: RequestLog = {
        t: Date.now() - start,
        url,
        refreshTokenSent,
        bearer: headers.Authorization ?? null,
        result: 'delivered',
        status: null,
      };
      requests.push(entry);
      if (!url.endsWith('/v1/auth/refresh')) {
        throw new Error(`unexpected request ${url}`);
      }
      if (!reachable(requests.length - 1)) {
        entry.result = failure;
        if (failure === 'reject') throw new TypeError('Network request failed');
        await new Promise<never>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()));
        });
      }
      deliveredAuthAnswers += 1;
      const res = serve(auth);
      entry.status = res.status;
      return res;
    },
  ) as unknown as typeof fetch;

  // Launch.
  const hydrateStarted = Date.now();
  const hydrate = useAuthStore.getState().hydrate();
  let hydrateMs = -1;
  void hydrate.then(() => {
    hydrateMs = Date.now() - hydrateStarted;
  });
  // The launch budget is 8 s; give it 9 s of fake time then require settlement.
  await jest.advanceTimersByTimeAsync(9_000);
  await hydrate;
  const launchState = useAuthStore.getState();
  const hydratedSignedInAtLaunch =
    launchState.hydrated &&
    launchState.session?.canonicalAppUserId === canonicalId;
  if (!launchState.hydrated)
    violations.push(
      'hydrate() did not resolve within the 8 s launch budget (+1 s)',
    );

  // Observe: foreground events, an API 401 report, and enough time for the
  // reconnect + several backoff cycles.
  const unsubscribe = useAuthStore.subscribe(state => {
    if (state.session === null && signedOutAtMs === null && state.hydrated) {
      signedOutAtMs = Date.now() - start;
    }
  });
  if (launchState.session === null) signedOutAtMs = Date.now() - start;
  for (let i = 0; i < 4; i++) {
    await jest.advanceTimersByTimeAsync(OBSERVATION_MS / 8);
    for (const handler of appStateHandlers) {
      handler('background');
      handler('active');
    }
    await jest.advanceTimersByTimeAsync(0);
    const api = getApiSession();
    if (api) reportApiUnauthorized(api.bearerToken);
    await jest.advanceTimersByTimeAsync(OBSERVATION_MS / 8);
  }
  unsubscribe();

  const end = useAuthStore.getState();
  const vault = vaultRecord();
  const refusalDelivered =
    (auth === 'refused_401' || auth === 'refused_403') &&
    deliveredAuthAnswers > 0;
  const expected: CellResult['expected'] = refusalDelivered
    ? 'signed_out'
    : 'signed_in';
  const refreshRequests = requests.filter(r =>
    r.url.endsWith('/v1/auth/refresh'),
  ).length;

  let observed: CellResult['observed'];
  if (
    end.session === null &&
    vault === null &&
    getActiveDataOwner() === SIGNED_OUT_DATA_OWNER
  ) {
    observed = end.error ? 'signed_out_with_error' : 'signed_out';
  } else if (
    end.session?.canonicalAppUserId === canonicalId &&
    vault !== null
  ) {
    observed = 'signed_in';
  } else {
    observed = 'inconsistent';
  }

  if (expected === 'signed_out') {
    if (observed !== 'signed_out')
      violations.push(`refusal delivered but state is ${observed}`);
    const refusalIndex = requests.findIndex(
      r => r.status === 401 || r.status === 403,
    );
    const after = requests.slice(refusalIndex + 1);
    if (after.length > 0)
      violations.push(
        `${after.length} refresh request(s) sent after the refusal`,
      );
    if (deliveredAuthAnswers !== 1)
      violations.push(`refusal answered ${deliveredAuthAnswers} times`);
  } else {
    if (observed !== 'signed_in')
      violations.push(`no refusal delivered but state is ${observed}`);
    if (end.error)
      violations.push(`error surfaced: ${JSON.stringify(end.error)}`);
    if (getActiveDataOwner() === SIGNED_OUT_DATA_OWNER)
      violations.push('data owner reset to signed-out');
    if (!hydratedSignedInAtLaunch)
      violations.push('not signed in at launch from the Keychain record');
    if (auth === 'ok' && deliveredAuthAnswers > 0) {
      if (!bearerTokenFor(canonicalId))
        violations.push('rotation landed but no bearer installed');
      if (vault?.refreshToken === 'refresh-seed')
        violations.push(
          'rotation landed but the Keychain still holds the spent refresh token',
        );
      const lastRotation = `refresh-${rotation}`;
      if (vault?.refreshToken !== lastRotation)
        violations.push(
          `Keychain refresh token ${vault?.refreshToken} != last rotated ${lastRotation}`,
        );
    }
    if (auth !== 'ok') {
      if (bearerTokenFor(canonicalId))
        violations.push(
          'a bearer was installed although no valid rotation landed',
        );
      if (vault?.refreshToken !== 'refresh-seed')
        violations.push(
          'Keychain refresh token changed without a valid rotation',
        );
    }
    // Keeper alive: the last observation window must contain a request.
    const lastWindow = requests.filter(
      r => r.t > OBSERVATION_MS + 9_000 - OBSERVATION_MS / 4,
    );
    if (lastWindow.length === 0)
      violations.push('keeper went silent during the last observation window');
  }
  // The spent token must never be re-sent once a rotation was adopted.
  let adopted: string | null = null;
  for (const r of requests) {
    if (adopted && r.refreshTokenSent !== adopted) {
      violations.push(
        `stale refresh token re-sent at t=${r.t}: ${r.refreshTokenSent} (current ${adopted})`,
      );
    }
    if (r.status === 200 && auth === 'ok')
      adopted = `refresh-${requests.filter(x => x.status === 200 && x.t <= r.t).length}`;
  }
  const firstHang = requests.findIndex(r => r.result === 'hang');
  const firstRetryAfterHangMs =
    firstHang >= 0 && requests[firstHang + 1]
      ? requests[firstHang + 1]!.t - requests[firstHang]!.t
      : null;

  return {
    id,
    network,
    auth,
    failure,
    expected,
    observed,
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
    violations,
    hydrateMs,
    hydratedSignedInAtLaunch,
    requests,
    refreshRequests,
    deliveredAuthAnswers,
    bearerAtEnd: bearerTokenFor(canonicalId),
    vaultRefreshTokenAtEnd: vault?.refreshToken ?? null,
    dataOwnerAtEnd: getActiveDataOwner(),
    errorAtEnd: end.error,
    signedOutAtMs,
    firstRetryAfterHangMs,
  };
}

// ─── Test ────────────────────────────────────────────────────────────────────

const OUT_DIR =
  process.env.XC_OUT ??
  path.resolve(
    __dirname,
    '../../../../artifacts/xc-matrix-network-auth-2/mobile',
  );

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

function resetWorld() {
  jest.clearAllMocks();
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
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  nativeModules.PickleAuth = { signInWithApple: jest.fn() };
  appStateHandlers = [];
}

describe('xc-matrix-network-auth-2 store matrix: hydrate → keeper → vault under {offline, intermittent, reconnect} × {refusal, malformed, 4xx/5xx}', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      handler: (state: string) => void,
    ) => {
      appStateHandlers.push(handler);
      return {
        remove: () => {
          appStateHandlers = appStateHandlers.filter(h => h !== handler);
        },
      };
    }) as unknown as typeof AppState.addEventListener);
    resetWorld();
  });

  afterEach(() => {
    stopSessionKeeper();
    clearSyncRuntime();
    clearApiSession();
    delete nativeModules.PickleAuth;
    globalThis.fetch = realFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('signs out exactly when a refusal is delivered and never otherwise', async () => {
    const only = process.env.XC_STORE_CELL ?? null;
    const heapBefore = process.memoryUsage();
    const wallStart = REAL_NOW();
    const results: CellResult[] = [];
    for (const network of NETWORKS) {
      for (const auth of AUTHS) {
        for (const failure of FAILURES) {
          const id = `${auth}@${network}/${failure}`;
          if (only && id !== only && `${auth}@${network}` !== only) continue;
          resetWorld();
          results.push(await runCell(network, auth, failure));
          stopSessionKeeper();
        }
      }
    }
    const wallMs = REAL_NOW() - wallStart;
    const heapAfter = process.memoryUsage();

    const failures = results.filter(r => r.verdict === 'FAIL');
    const matrix: Record<string, Record<string, string>> = {};
    for (const r of results) {
      matrix[r.auth] ??= {};
      matrix[r.auth]![`${r.network}/${r.failure}`] =
        `${r.observed}${r.verdict === 'FAIL' ? ' ✗' : ''} (reqs=${r.refreshRequests}, delivered=${r.deliveredAuthAnswers})`;
    }
    const retryAfterHang = results
      .filter(r => r.firstRetryAfterHangMs !== null)
      .map(r => ({ id: r.id, firstRetryAfterHangMs: r.firstRetryAfterHangMs }));

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date(REAL_NOW()).toISOString().replace(/[:.]/g, '-');
    const report = {
      cell: 'matrix-network-auth-2',
      plane:
        'mobile (jest, real authStore + sessionVault(Keychain mock) + sessionKeeper + sessionLifecycle, scripted fetch, fake timers)',
      commit: process.env.XC_COMMIT ?? null,
      generatedAt: new Date(REAL_NOW()).toISOString(),
      node: process.version,
      parameters: {
        INTERMITTENT_DROPS,
        RECONNECT_AFTER_MS,
        OBSERVATION_MS,
        launchBudgetMs: 8_000,
        appRefreshTimeoutMs: 15_000,
      },
      totals: {
        cells: results.length,
        pass: results.length - failures.length,
        fail: failures.length,
      },
      wallMs,
      heap: {
        before: heapBefore,
        after: heapAfter,
        heapUsedDeltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
      },
      matrix,
      lostResponseTiming: {
        note: 'ms between a hung refresh request (server may have rotated, response lost) and the retry that re-sends the spent token; GoTrue reuse interval default is 10 s',
        cells: retryAfterHang,
        min: retryAfterHang.length
          ? Math.min(...retryAfterHang.map(r => r.firstRetryAfterHangMs ?? 0))
          : null,
      },
      failures: failures.map(f => ({
        id: f.id,
        replay: `XC_STORE_CELL=${f.id} npx jest --ci __tests__/xc/xcMatrixNetworkAuth2.store.test.ts`,
        violations: f.violations,
        requests: f.requests,
      })),
      cells: results,
    };
    const file = path.join(OUT_DIR, `store-matrix-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(OUT_DIR, 'store-matrix-latest.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(
      `[xc-matrix-network-auth-2] store matrix: ${results.length} cells, ${failures.length} failures, wall ${wallMs} ms → ${file}`,
    );

    if (!only) {
      expect(results).toHaveLength(
        NETWORKS.length * AUTHS.length * FAILURES.length,
      );
      // Sanity: refusals sign out where delivered (intermittent + reconnect) and never where offline.
      expect(
        results.filter(
          r => r.network === 'offline' && r.observed !== 'signed_in',
        ),
      ).toEqual([]);
      expect(
        results
          .filter(
            r =>
              r.network !== 'offline' &&
              (r.auth === 'refused_401' || r.auth === 'refused_403'),
          )
          .every(r => r.observed === 'signed_out'),
      ).toBe(true);
    }
    expect(failures.map(f => ({ id: f.id, violations: f.violations }))).toEqual(
      [],
    );
  });
});
