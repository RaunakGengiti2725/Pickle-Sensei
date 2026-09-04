/**
 * Adversarial pass 3/3 on mobile-auth-session (tester #4) — the BROKEN
 * scenarios. Each test asserts the EXPECTED behaviour and FAILS at
 * 4d812e1aa699014cc0521fd92fde66908043aaa8; the failure output is the
 * executable repro for the finding. Nothing here is a product expectation
 * the shipped code meets today, so the file lives outside jest's default
 * testMatch (CI stays green). Run it on purpose:
 *
 *   cd apps/mobile && ATTACK_EVIDENCE_DIR=/tmp npx jest --ci \
 *     --testMatch '<rootDir>/attack/*.repro.ts' attack/authSessionAttackPass4.findings.repro.ts
 *
 * Once the underlying issues are fixed, move the cases into
 * __tests__/attack/authSessionAttackPass4.test.ts so they pin the fix.
 *
 *  F1 (S2/S4)  /v1/auth/refresh 200 with expiresAt 0 or -1 (or any value in
 *              the device's past) is ACCEPTED and the keeper refreshes at a
 *              1 Hz cadence forever: 30 refreshes / 30 s of fake time, one
 *              Keychain write each, straight into the 30/min per-IP budget.
 *  F2 (S3/S4)  expiresAt in MILLISECONDS (Date.now()) or 1e308 is ACCEPTED;
 *              `expiresAt * 1000` overflows to ~1.8e15 ms / Infinity, the
 *              timer delay exceeds 2^31−1 → under Node/Jest setTimeout clamps
 *              to 1 ms and the keeper hot-loops (~1000 refreshes per fake
 *              second). INFERRED for iOS (RCTTiming takes an NSTimeInterval,
 *              no clamp): the timer never fires and the bearer is only ever
 *              refreshed reactively after a 401.
 *  F3 (extra)  signInWith* while ANOTHER synced account is live tears A's
 *              runtime down without revoking A's server session; if B's
 *              bootstrap then fails, the store still shows A signed in with
 *              no bearer and no keeper until relaunch. Store-level only:
 *              SignInScreen renders only when `!session` at this commit.
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../src/data/db';
import { useAuthStore } from '../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
} from '../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../src/account/sessionVault';
import {
  startSessionKeeper,
  stopSessionKeeper,
} from '../src/account/sessionKeeper';
import { refreshApiSession } from '../src/account/sessionLifecycle';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { clearSyncRuntime } from '../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

declare const process: { env: Record<string, string | undefined> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { appendFileSync } = require('fs') as {
  appendFileSync: (path: string, data: string) => void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { join } = require('path') as { join: (...parts: string[]) => string };

const mockKv = new Map<string, string>();
jest.mock('../src/data/db', () => ({
  getDb: (): LocalDb => ({
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
  }),
}));

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

jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

jest.mock('../src/account/deviceContext', () => ({
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

const ACCOUNT_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const ACCOUNT_B = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const API = 'https://api.example.test';
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** The edge function's per-IP budget for POST /v1/auth/refresh
 * (supabase/functions/api/index.ts AUTH_REFRESH_LIMIT). */
const AUTH_REFRESH_LIMIT_PER_MINUTE = 30;

/** With ATTACK_EVIDENCE_DIR set, every probe appends one JSON line so the
 * observed numbers survive the (expected) assertion failures. */
function recordEvidence(label: string, data: Record<string, unknown>): void {
  const dir = process.env.ATTACK_EVIDENCE_DIR;
  if (!dir) return;
  appendFileSync(
    join(dir, 'authSessionAttackPass4.findings.jsonl'),
    `${JSON.stringify({ label, ...data }, (_key, value: unknown) =>
      typeof value === 'number' && !Number.isFinite(value)
        ? String(value)
        : value,
    )}\n`,
  );
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function rotation(n: number, expiresAt: number) {
  return response({
    session: {
      accessToken: `access-${n}`,
      refreshToken: `refresh-${n}`,
      expiresAt,
    },
  });
}

function seedVault(refreshToken: string, canonicalAppUserId = ACCOUNT_A) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

type FetchRoute = (init?: RequestInit) => Response | Promise<Response>;
function installRoutes(routes: Record<string, FetchRoute>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const nativeModules = NativeModules as {
  PickleAuth?: { signInWithApple: jest.Mock };
};
const realFetch = globalThis.fetch;
const realSetGenericPassword = Keychain.setGenericPassword;

beforeEach(() => {
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
  installRoutes({});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  (
    Keychain as { setGenericPassword: typeof realSetGenericPassword }
  ).setGenericPassword = realSetGenericPassword;
});

/** Runs hydrate() against a refresh route that always answers `expiresAt`,
 * then advances fake time and reports what the keeper did. */
async function stormProbe(expiresAt: number, advanceMs: number) {
  jest.useFakeTimers();
  const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
  const keychainWrites = jest.spyOn(Keychain, 'setGenericPassword');
  seedVault('refresh-0');
  let calls = 0;
  installRoutes({
    '/v1/auth/refresh': () => {
      calls += 1;
      return rotation(calls, expiresAt);
    },
  });
  const hydrate = useAuthStore.getState().hydrate();
  await jest.advanceTimersByTimeAsync(0);
  await hydrate;
  const callsAtLaunch = calls;
  await jest.advanceTimersByTimeAsync(advanceMs);
  const delays = setTimeoutSpy.mock.calls
    .map(call => call[1])
    .filter((delay): delay is number => typeof delay === 'number');
  const probe = {
    expiresAt,
    advanceMs,
    callsAtLaunch,
    calls,
    keychainWrites: keychainWrites.mock.calls.length,
    maxDelayRequested: delays.length ? Math.max(...delays) : null,
    bearerExpiresAtMs: getApiSession()?.bearerExpiresAtMs ?? null,
    lastVaultRefreshToken: vaultRecord()?.refreshToken ?? null,
    stillSignedInAs:
      useAuthStore.getState().session?.canonicalAppUserId ?? null,
  };
  recordEvidence('stormProbe', probe);
  return probe;
}

// ─── F1 · expiresAt in the past → 1 Hz refresh storm ─────────────────────────

describe('F1 · /v1/auth/refresh 200 with expiresAt 0 / -1 (already expired on the device)', () => {
  it.each([0, -1])(
    'expiresAt %p should be treated as malformed/retryable — instead the keeper refreshes every second (30 s of fake time → ≥30 refreshes, the whole per-IP minute budget in half a minute)',
    async expiresAt => {
      const probe = await stormProbe(expiresAt, 30_000);
      // Observed at 4d812e1a: callsAtLaunch 1, calls 31, keychainWrites 31.
      // Expected: the launch refresh, then at most one retry with backoff —
      // never a cadence that alone exhausts AUTH_REFRESH_LIMIT (30/min).
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        ACCOUNT_A,
      );
      expect(probe.calls - probe.callsAtLaunch).toBeLessThan(
        AUTH_REFRESH_LIMIT_PER_MINUTE / 2,
      );
    },
  );

  it('once the server starts answering 429 for the storm, the keeper backs off but the cadence RESUMES at 1 Hz after the next 200 (never converges)', async () => {
    jest.useFakeTimers();
    seedVault('refresh-0');
    const timeline: Array<{ atMs: number; status: number }> = [];
    const t0 = Date.now();
    let calls = 0;
    installRoutes({
      '/v1/auth/refresh': () => {
        calls += 1;
        // Budget: 30 per rolling minute per IP.
        const inLastMinute = timeline.filter(
          e => Date.now() - t0 - e.atMs < 60_000 && e.status === 200,
        ).length;
        const status =
          inLastMinute >= AUTH_REFRESH_LIMIT_PER_MINUTE ? 429 : 200;
        timeline.push({ atMs: Date.now() - t0, status });
        return status === 200
          ? rotation(calls, 0)
          : response({ error: { message: 'Too many requests' } }, 429);
      },
    });
    const hydrate = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(0);
    await hydrate;
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    const ok = timeline.filter(e => e.status === 200).length;
    const limited = timeline.filter(e => e.status === 429).length;
    recordEvidence('storm-with-429-budget', {
      fakeMinutes: 10,
      accepted200: ok,
      limited429: limited,
      firstTen: timeline.slice(0, 10),
      lastFive: timeline.slice(-5),
    });
    // Observed at 4d812e1a over 10 fake minutes: ~30 accepted rotations per
    // minute plus a train of 429s — roughly 300 rotations + 429s where a
    // healthy device needs ~0. Expected: a handful of calls in total.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(ACCOUNT_A);
    expect(ok + limited).toBeLessThan(20);
  });
});

// ─── F2 · expiresAt far beyond seconds → timer overflow ──────────────────────

describe('F2 · /v1/auth/refresh 200 with expiresAt in MILLISECONDS or 1e308', () => {
  it('refreshApiSession should reject an expiresAt that cannot be seconds (ms-scale Date.now()) — instead it is accepted and bearerExpiresAtMs lands ~1000× in the future', async () => {
    const expiresAt = Date.now(); // milliseconds, not seconds
    const fetchFn = jest.fn(async () => rotation(1, expiresAt));
    let outcome: unknown;
    try {
      outcome = await refreshApiSession(
        { apiBaseUrl: API, refreshToken: 'r' },
        { fetchFn },
      );
    } catch (error) {
      outcome = error;
    }
    // Observed: { bearerExpiresAtMs: ≈1.78e15 } (year ≈ 58 000).
    expect(outcome).toMatchObject({
      name: 'SessionRefreshError',
      retryable: true,
    });
  });

  it('refreshApiSession should reject expiresAt 1e308 — instead `* 1000` overflows to Infinity and the tokens are accepted', async () => {
    const fetchFn = jest.fn(async () => rotation(1, 1e308));
    let outcome: unknown;
    try {
      outcome = await refreshApiSession(
        { apiBaseUrl: API, refreshToken: 'r' },
        { fetchFn },
      );
    } catch (error) {
      outcome = error;
    }
    // Observed: { bearerExpiresAtMs: Infinity }.
    expect(outcome).toMatchObject({
      name: 'SessionRefreshError',
      retryable: true,
    });
  });

  it.each([
    ['Date.now() (ms instead of s)', () => Date.now()],
    ['1e308', () => 1e308],
  ])(
    'hydrate() with expiresAt %s: the keeper should never ask setTimeout for a delay above 2^31−1 nor loop — instead the delay overflows and, under Node/Jest, the keeper refreshes ~1000× per fake second',
    async (_label, expiresAtFor) => {
      const probe = await stormProbe(expiresAtFor(), 1_000);
      // Observed at 4d812e1a: maxDelayRequested ≈ 1.78e15 (or Infinity),
      // calls ≈ 1000 in 1 s of fake time (fake-timers clamps > 2^31−1 to 1 ms,
      // exactly as Node's TimeoutOverflowWarning path does).
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        ACCOUNT_A,
      );
      expect(probe.maxDelayRequested).not.toBeNull();
      expect(probe.maxDelayRequested!).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
      expect(probe.calls - probe.callsAtLaunch).toBeLessThanOrEqual(1);
    },
  );

  it('keeper-level: a bearerExpiresAtMs of Infinity means foreground NEVER refreshes either (Infinity − now < 5 min is false) — the bearer can only be recovered by a 401', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn(async () => rotation(1, 1e308));
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Number.POSITIVE_INFINITY,
      onRotated: () => {},
      onRevoked: () => {},
      fetchFn: fetchFn as unknown as (
        input: string,
        init?: RequestInit,
      ) => Promise<Response>,
    });
    // Advance a whole day: a sane keeper would have refreshed long ago
    // (bearers live ~1 h). Under Node the overflowed timer instead fires at
    // 1 ms and hot-loops; on iOS (INFERRED) it never fires. Either way the
    // expected "one refresh ahead of a ~1 h expiry" does not happen.
    await jest.advanceTimersByTimeAsync(1_000);
    const callsAfter1s = fetchFn.mock.calls.length;
    recordEvidence('keeper-infinity-expiry', { callsAfter1s });
    expect(callsAfter1s).toBeLessThanOrEqual(1);
  });
});

// ─── F3 · sign-in as B over a live A session ─────────────────────────────────

describe('F3 · signInWithApple() while account A is signed in (store-level; SignInScreen is unreachable while signed in at this commit)', () => {
  function bootstrapBody(id: string, n: string) {
    return {
      user: { id, email: `${id}@example.com` },
      onboardingState: 'complete',
      session: {
        accessToken: `access-${n}`,
        refreshToken: `refresh-${n}`,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    };
  }

  it('A’s server session should be revoked (or at least A’s bearer kept) when B replaces it — instead A’s refresh token is silently orphaned: no /v1/auth/logout for A', async () => {
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': init =>
        String(init?.body).includes('code-b')
          ? response(bootstrapBody(ACCOUNT_B, 'b1'))
          : response(bootstrapBody(ACCOUNT_A, 'a1')),
      '/v1/auth/logout': () => response(null, 204),
    });
    nativeModules.PickleAuth = {
      signInWithApple: jest
        .fn()
        .mockResolvedValueOnce({
          user: 'a',
          identityToken: 'id-a',
          authorizationCode: 'code-a',
          email: null,
          givenName: 'A',
          familyName: null,
        })
        .mockResolvedValueOnce({
          user: 'b',
          identityToken: 'id-b',
          authorizationCode: 'code-b',
          email: null,
          givenName: 'B',
          familyName: null,
        }),
    };
    await useAuthStore.getState().signInWithApple();
    expect(getApiSession()?.bearerToken).toBe('access-a1');
    await useAuthStore.getState().signInWithApple();
    expect(getApiSession()?.bearerToken).toBe('access-b1');
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-b1' });

    const logouts = fetchMock.mock.calls.filter(call =>
      String(call[0]).endsWith('/v1/auth/logout'),
    );
    // Observed: []. A's refresh token 'refresh-a1' stays valid server-side
    // (nothing on this device can ever revoke it now — the bearer is gone).
    expect(logouts.map(call => (call[1] as RequestInit).headers)).toEqual([
      expect.objectContaining({ Authorization: 'Bearer access-a1' }),
    ]);
  });

  it('if B’s bootstrap FAILS, A should still be usable (or signed out honestly) — instead the store keeps A’s session with NO bearer and NO keeper', async () => {
    installRoutes({
      '/v1/account/bootstrap': init =>
        String(init?.body).includes('code-b')
          ? response({ error: { message: 'unavailable' } }, 503)
          : response(bootstrapBody(ACCOUNT_A, 'a1')),
    });
    nativeModules.PickleAuth = {
      signInWithApple: jest
        .fn()
        .mockResolvedValueOnce({
          user: 'a',
          identityToken: 'id-a',
          authorizationCode: 'code-a',
          email: null,
          givenName: 'A',
          familyName: null,
        })
        .mockResolvedValueOnce({
          user: 'b',
          identityToken: 'id-b',
          authorizationCode: 'code-b',
          email: null,
          givenName: 'B',
          familyName: null,
        }),
    };
    await useAuthStore.getState().signInWithApple();
    expect(bearerTokenFor(ACCOUNT_A)).toBe('access-a1');

    await useAuthStore.getState().signInWithApple();

    const state = useAuthStore.getState();
    expect(state.error?.code).toBe('auth.failed');
    // Observed: session = A, getApiSession() = null, bearerTokenFor(A) = null,
    // keeper stopped; the vault still holds A's refresh token, so a RELAUNCH
    // recovers — the current run does not.
    const consistent =
      state.session === null ||
      (state.session.canonicalAppUserId === ACCOUNT_A &&
        bearerTokenFor(ACCOUNT_A) === 'access-a1');
    expect(consistent).toBe(true);
  });
});
