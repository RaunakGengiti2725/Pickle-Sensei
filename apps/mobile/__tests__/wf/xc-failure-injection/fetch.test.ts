/**
 * xc-failure-injection-mobile — FETCH THROWS SYNCHRONOUSLY.
 *
 * Injects `fetch` implementations that throw synchronously (the shape of a
 * missing/broken networking layer: `TypeError: fetch is not a function`,
 * `Network request failed` thrown before a promise exists), return a
 * non-Response, or return a Response whose `.json()` throws synchronously —
 * and drives the REAL session lifecycle, session keeper, launch hydration,
 * account bootstrap and sync transport on top.
 *
 * Invariants (assignment): retryable classification, `onDeferred` fires,
 * `onRevoked` does NOT fire, retry scheduling is bounded, no store crash,
 * launch hydration settles.
 */
import { AppState } from 'react-native';
import type { LocalDb } from '../../../src/data/db';
import {
  runScenario,
  seededRng,
  pick,
  settleWithinFakeTime,
  verdictFor,
  type Invariants,
} from '../../../scripts/failure-injection/recorder';

// ─── Module seams for the launch-hydration scenario ─────────────────────────

const mockVault = new Map<string, { username: string; password: string }>();
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'x' },
  async setGenericPassword(
    username: string,
    password: string,
    options: { service: string },
  ) {
    mockVault.set(options.service, { username, password });
    return { service: options.service, storage: 'keychain' };
  },
  async getGenericPassword(options: { service: string }) {
    const item = mockVault.get(options.service);
    return item
      ? { ...item, service: options.service, storage: 'keychain' }
      : false;
  },
  async resetGenericPassword(options: { service: string }) {
    mockVault.delete(options.service);
    return true;
  },
}));

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
jest.mock('../../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(async () => true),
    signIn: jest.fn(),
    signInSilently: jest.fn(async () => ({
      type: 'noSavedCredentialFound',
      data: null,
    })),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(async () => null),
    revokeAccess: jest.fn(async () => null),
  },
}));
jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
jest.mock('../../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));
jest.mock('../../../src/account/deviceContext', () => ({
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

import {
  refreshApiSession,
  revokeApiSession,
  SessionRefreshError,
  type SessionFetch,
} from '../../../src/account/sessionLifecycle';
import {
  startSessionKeeper,
  stopSessionKeeper,
  retryDelayMs,
} from '../../../src/account/sessionKeeper';
import {
  bootstrapCanonicalAccount,
  AccountBootstrapError,
} from '../../../src/account/bootstrap';
import { createTransport, ApiError } from '../../../src/data/api';
import { isPermanentSyncFailure } from '../../../src/data/sync';
import { useAuthStore } from '../../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
} from '../../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../../src/account/sessionVault';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';

const SUITE = 'fetch';
const FILES = {
  post: 'apps/mobile/src/account/sessionLifecycle.ts:33-50',
  refreshCatch: 'apps/mobile/src/account/sessionLifecycle.ts:68-87',
  refreshStatus: 'apps/mobile/src/account/sessionLifecycle.ts:88-90',
  refreshJson: 'apps/mobile/src/account/sessionLifecycle.ts:91',
  keeperCatch: 'apps/mobile/src/account/sessionKeeper.ts:122-131',
  keeperRetry: 'apps/mobile/src/account/sessionKeeper.ts:72-74',
  launchWait: 'apps/mobile/src/auth/authStore.ts:381-427',
  bootstrapCatch: 'apps/mobile/src/account/bootstrap.ts:199-226',
  apiRequest: 'apps/mobile/src/data/api.ts:79-98',
  syncPermanent: 'apps/mobile/src/data/sync.ts:79-89',
  revoke: 'apps/mobile/src/account/sessionLifecycle.ts:124-140',
};

const API = 'https://api.example.test';
const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';

type FetchFault =
  | 'throw_sync'
  | 'reject'
  | 'return_undefined'
  | 'return_plain_object'
  | 'json_throws_sync'
  | 'status_500'
  | 'status_401'
  | 'fetch_undefined';

const FAULT_MESSAGE: Record<FetchFault, string> = {
  throw_sync: 'TypeError: Network request failed (thrown synchronously)',
  reject: 'Network request failed',
  return_undefined: '',
  return_plain_object: '',
  json_throws_sync: 'JSON body stream already consumed',
  status_500: '',
  status_401: '',
  fetch_undefined: '',
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => body,
  } as unknown as Response;
}

function faultyFetch(
  fault: FetchFault,
  calls: { url: string }[] = [],
): SessionFetch | undefined {
  if (fault === 'fetch_undefined') return undefined;
  return ((url: string) => {
    calls.push({ url });
    switch (fault) {
      case 'throw_sync':
        throw new TypeError(FAULT_MESSAGE.throw_sync);
      case 'reject':
        return Promise.reject(new TypeError(FAULT_MESSAGE.reject));
      case 'return_undefined':
        return Promise.resolve(undefined as unknown as Response);
      case 'return_plain_object':
        return Promise.resolve({ weird: true } as unknown as Response);
      case 'json_throws_sync':
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => {
            throw new TypeError(FAULT_MESSAGE.json_throws_sync);
          },
        } as unknown as Response);
      case 'status_500':
        return Promise.resolve(response({ error: 'boom' }, 500));
      case 'status_401':
        return Promise.resolve(response({ error: 'revoked' }, 401));
      default:
        return Promise.reject(new Error('unreachable'));
    }
  }) as SessionFetch;
}

type Classified =
  | { kind: 'typed'; retryable: boolean; message: string }
  | { kind: 'raw'; name: string; message: string }
  | { kind: 'resolved' };

async function classifyRefresh(
  fetchFn: SessionFetch | undefined,
): Promise<Classified> {
  try {
    await refreshApiSession(
      { apiBaseUrl: API, refreshToken: 'rt-1' },
      { fetchFn },
    );
    return { kind: 'resolved' };
  } catch (error) {
    if (error instanceof SessionRefreshError) {
      return {
        kind: 'typed',
        retryable: error.retryable,
        message: error.message,
      };
    }
    return {
      kind: 'raw',
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.useRealTimers();
  mockKv.clear();
  mockVault.clear();
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
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

describe('xc-failure-injection — fetch throws synchronously', () => {
  it('FET-01 refreshApiSession with a synchronously-throwing fetch → typed SessionRefreshError(retryable=true)', async () => {
    await runScenario(
      {
        id: 'FET-01',
        failureClass: 'fetch',
        suite: SUITE,
        title: 'fetchFn throws TypeError before returning a promise',
        seed: 61,
        inputs: { fault: 'throw_sync', message: FAULT_MESSAGE.throw_sync },
        files: [FILES.post, FILES.refreshCatch],
      },
      async () => {
        const result = await classifyRefresh(faultyFetch('throw_sync'));
        expect(result).toEqual({
          kind: 'typed',
          retryable: true,
          message: 'The session could not be refreshed right now.',
        });
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: JSON.stringify(result),
          expected:
            'Sync throw inside async post() becomes a rejection the catch wraps as retryable.',
        };
      },
    );
  });

  it('FET-02 startSessionKeeper over a synchronously-throwing fetch: onDeferred fires each attempt, onRevoked never, retries bounded by capped backoff over 1h fake time', async () => {
    jest.useFakeTimers();
    await runScenario(
      {
        id: 'FET-02',
        failureClass: 'fetch',
        suite: SUITE,
        title: 'keeper refresh loop against a sync-throwing fetch',
        seed: 62,
        inputs: {
          fault: 'throw_sync',
          fakeTimeMs: 3_600_000,
          bearerExpiresAtMs: null,
        },
        files: [FILES.keeperCatch, FILES.keeperRetry],
      },
      async () => {
        const calls: { url: string }[] = [];
        const deferred: string[] = [];
        const onRevoked = jest.fn();
        const onRotated = jest.fn();
        startSessionKeeper({
          apiBaseUrl: API,
          refreshToken: 'rt-1',
          bearerExpiresAtMs: null,
          onRotated,
          onRevoked,
          onDeferred: error =>
            deferred.push(
              error instanceof SessionRefreshError
                ? `typed:${error.retryable}`
                : `raw:${error instanceof Error ? error.name : typeof error}`,
            ),
          fetchFn: faultyFetch('throw_sync', calls),
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);
        expect(deferred).toEqual(['typed:true']);

        // Expected attempt schedule: t=0 then +5s,+10s,+20s,+40s,+80s,+160s,
        // then +300s capped.
        let expectedAttempts = 1;
        let elapsed = 0;
        let attempt = 1;
        while (elapsed + retryDelayMs(attempt) <= 3_600_000) {
          elapsed += retryDelayMs(attempt);
          attempt += 1;
          expectedAttempts += 1;
        }
        await jest.advanceTimersByTimeAsync(3_600_000);
        expect(calls.length).toBe(expectedAttempts);
        expect(deferred.every(d => d === 'typed:true')).toBe(true);
        expect(onRevoked).not.toHaveBeenCalled();
        expect(onRotated).not.toHaveBeenCalled();
        expect(retryDelayMs(50)).toBe(300_000);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `${calls.length} attempts in 1h fake time (expected ${expectedAttempts}), ${deferred.length} onDeferred, onRevoked=0, cap=${retryDelayMs(50)}ms.`,
          expected:
            'Bounded exponential backoff, capped at 5 minutes; never a sign-out.',
        };
      },
    );
  });

  it('FET-03 globalThis.fetch undefined (no fetchFn): refresh is still typed-retryable', async () => {
    await runScenario(
      {
        id: 'FET-03',
        failureClass: 'fetch',
        suite: SUITE,
        title: 'options.fetchFn ?? globalThis.fetch resolves to undefined',
        seed: 63,
        inputs: { fault: 'fetch_undefined' },
        files: [FILES.refreshCatch],
      },
      async () => {
        (globalThis as { fetch?: unknown }).fetch = undefined;
        const result = await classifyRefresh(undefined);
        expect(result).toMatchObject({ kind: 'typed', retryable: true });
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: JSON.stringify(result),
          expected: 'Typed retryable failure.',
        };
      },
    );
  });

  it('FET-04 fetch resolves a NON-Response (undefined): TypeError escapes refreshApiSession untyped; the keeper still treats it as transient (no sign-out)', async () => {
    jest.useFakeTimers();
    await runScenario(
      {
        id: 'FET-04',
        failureClass: 'fetch',
        suite: SUITE,
        title:
          'fetch resolves undefined → response.status dereference outside the try',
        seed: 64,
        inputs: { fault: 'return_undefined' },
        files: [FILES.refreshStatus, FILES.keeperCatch],
      },
      async () => {
        const direct = await classifyRefresh(faultyFetch('return_undefined'));
        expect(direct.kind).toBe('raw');
        const deferred: unknown[] = [];
        const onRevoked = jest.fn();
        startSessionKeeper({
          apiBaseUrl: API,
          refreshToken: 'rt-1',
          bearerExpiresAtMs: null,
          onRotated: jest.fn(),
          onRevoked,
          onDeferred: error => deferred.push(error),
          fetchFn: faultyFetch('return_undefined'),
        });
        await jest.advanceTimersByTimeAsync(20_000);
        expect(deferred.length).toBeGreaterThanOrEqual(2);
        expect(deferred[0]).toBeInstanceOf(TypeError);
        expect(onRevoked).not.toHaveBeenCalled();
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed: `direct=${JSON.stringify(direct)}; keeper: ${deferred.length} deferrals in 20s, onRevoked=0.`,
          expected:
            'Ideally a SessionRefreshError; the keeper\u2019s `instanceof` gate makes any non-typed error retryable, so behavior is safe.',
        };
      },
    );
  });

  it('FET-05 Response whose json() THROWS synchronously: `.json().catch` never attaches — raw TypeError escapes, keeper treats as transient', async () => {
    jest.useFakeTimers();
    await runScenario(
      {
        id: 'FET-05',
        failureClass: 'fetch',
        suite: SUITE,
        title: 'response.json throws instead of rejecting',
        seed: 65,
        inputs: { fault: 'json_throws_sync' },
        files: [FILES.refreshJson, FILES.keeperCatch],
      },
      async () => {
        const direct = await classifyRefresh(faultyFetch('json_throws_sync'));
        expect(direct).toMatchObject({
          kind: 'raw',
          message: FAULT_MESSAGE.json_throws_sync,
        });
        const deferred: unknown[] = [];
        const onRevoked = jest.fn();
        startSessionKeeper({
          apiBaseUrl: API,
          refreshToken: 'rt-1',
          bearerExpiresAtMs: null,
          onRotated: jest.fn(),
          onRevoked,
          onDeferred: error => deferred.push(error),
          fetchFn: faultyFetch('json_throws_sync'),
        });
        await jest.advanceTimersByTimeAsync(20_000);
        expect(deferred.length).toBeGreaterThanOrEqual(2);
        expect(onRevoked).not.toHaveBeenCalled();
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed: `direct=${JSON.stringify(direct)}; keeper deferrals=${deferred.length}, onRevoked=0.`,
          expected:
            'Typed retryable; observed raw but still safe in the keeper.',
        };
      },
    );
  });

  it('FET-06 launch hydrate() with a persisted session and a sync-throwing fetch: settles immediately as signed-in/offline (not the 8s deadline), session retained, keeper retrying', async () => {
    jest.useFakeTimers();
    await runScenario(
      {
        id: 'FET-06',
        failureClass: 'fetch',
        suite: SUITE,
        title: 'authStore.hydrate() launch refresh over a sync-throwing fetch',
        seed: 66,
        inputs: { fault: 'throw_sync', vault: 'seeded', launchWaitMs: 8_000 },
        files: [FILES.launchWait, FILES.keeperCatch],
      },
      async () => {
        mockVault.set(SESSION_VAULT_SERVICE, {
          username: 'session',
          password: JSON.stringify({
            version: 1,
            provider: 'apple',
            canonicalAppUserId: canonicalId,
            refreshToken: 'rt-persisted',
            email: 'pat@example.com',
            displayName: 'Pat Player',
          }),
        });
        const calls: { url: string }[] = [];
        globalThis.fetch = faultyFetch(
          'throw_sync',
          calls,
        ) as unknown as typeof fetch;
        const settled = await settleWithinFakeTime(
          useAuthStore.getState().hydrate(),
          30_000,
          ms => jest.advanceTimersByTimeAsync(ms),
          100,
        );
        expect(settled.settled).toBe(true);
        expect(settled.elapsedMs).toBeLessThan(8_000);
        const state = useAuthStore.getState();
        expect(state.hydrated).toBe(true);
        expect(state.session?.canonicalAppUserId).toBe(canonicalId);
        expect(mockVault.has(SESSION_VAULT_SERVICE)).toBe(true);
        expect(getApiSession()).toBeNull();
        const before = calls.length;
        await jest.advanceTimersByTimeAsync(60_000);
        expect(calls.length).toBeGreaterThan(before);
        expect(useAuthStore.getState().session).not.toBeNull();
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `hydrate settled in ${settled.elapsedMs}ms fake time; hydrated=true; session kept; vault kept; bearer=null; keeper attempts after +60s: ${calls.length}.`,
          expected:
            'Signed in with local data; refresh keeps retrying; no sign-out.',
        };
      },
    );
  });

  it('FET-07 bootstrapCanonicalAccount (sign-in) over a sync-throwing fetch → AccountBootstrapError account.unavailable retryable', async () => {
    await runScenario(
      {
        id: 'FET-07',
        failureClass: 'fetch',
        suite: SUITE,
        title: 'account bootstrap fetch throws synchronously',
        seed: 67,
        inputs: { fault: 'throw_sync' },
        files: [FILES.bootstrapCatch],
      },
      async () => {
        let caught: unknown;
        try {
          await bootstrapCanonicalAccount({
            apiBaseUrl: API,
            bearerToken: 'apple-identity-token',
            provider: 'apple',
            environment: {
              locale: 'en-US',
              timezone: 'America/Los_Angeles',
              device: {
                platform: 'ios',
                osVersion: '18.5',
                appVersion: '1.0',
                model: 'iOS phone',
              },
            },
            fetchFn: faultyFetch('throw_sync') as never,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(AccountBootstrapError);
        const typed = caught as AccountBootstrapError;
        expect(typed.code).toBe('account.unavailable');
        expect(typed.retryable).toBe(true);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `code=${typed.code} retryable=${typed.retryable} message="${typed.message}"`,
          expected: 'Typed retryable bootstrap failure with user-facing copy.',
        };
      },
    );
  });

  it('FET-08 sync transport request() over a sync-throwing global fetch: raw TypeError escapes (not ApiError) and sync classifies it TRANSIENT (attempt budget intact)', async () => {
    await runScenario(
      {
        id: 'FET-08',
        failureClass: 'fetch',
        suite: SUITE,
        title: 'data/api.ts request() with sync-throwing fetch',
        seed: 68,
        inputs: { fault: 'throw_sync' },
        files: [FILES.apiRequest, FILES.syncPermanent],
      },
      async () => {
        globalThis.fetch = faultyFetch('throw_sync') as unknown as typeof fetch;
        const transport = createTransport({ baseUrl: API, token: 'bearer-1' });
        let caught: unknown;
        try {
          await transport.syncShots([]);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(TypeError);
        expect(caught).not.toBeInstanceOf(ApiError);
        expect(isPermanentSyncFailure(caught)).toBe(false);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `rejected ${(caught as Error).name}: ${(caught as Error).message}; isPermanentSyncFailure=false.`,
          expected:
            'Transient: the outbox row records the error and stays retryable.',
        };
      },
    );
  });

  it('FET-09 revokeApiSession (sign-out) over a sync-throwing fetch resolves — local sign-out never blocks on the network', async () => {
    await runScenario(
      {
        id: 'FET-09',
        failureClass: 'fetch',
        suite: SUITE,
        title: 'best-effort logout with sync-throwing fetch',
        seed: 69,
        inputs: { fault: 'throw_sync' },
        files: [FILES.revoke],
      },
      async () => {
        await expect(
          revokeApiSession(
            {
              apiBaseUrl: API,
              bearerToken: 'b',
              canonicalAppUserId: canonicalId,
              provider: 'apple',
              refreshToken: 'r',
              bearerExpiresAtMs: null,
            },
            faultyFetch('throw_sync'),
          ),
        ).resolves.toBeUndefined();
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'n/a',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: 'resolved undefined.',
          expected: 'Best-effort; caller already cleared local tokens.',
        };
      },
    );
  });

  it('FET-10 seeded sweep ×32: random fetch fault × keeper — onRevoked ONLY for 401; everything else defers with a bounded retry', async () => {
    jest.useFakeTimers();
    const faults: FetchFault[] = [
      'throw_sync',
      'reject',
      'return_undefined',
      'return_plain_object',
      'json_throws_sync',
      'status_500',
      'status_401',
    ];
    const matrix: Record<
      string,
      { direct: string; deferred: number; revoked: number }
    > = {};
    for (let seed = 600; seed < 632; seed += 1) {
      const rng = seededRng(seed);
      const fault = pick(rng, faults);
      await runScenario(
        {
          id: `FET-10/${seed}`,
          failureClass: 'fetch',
          suite: SUITE,
          title: 'random fetch fault through refreshApiSession + keeper',
          seed,
          inputs: { fault },
          files: [FILES.refreshCatch, FILES.keeperCatch],
        },
        async () => {
          stopSessionKeeper();
          const direct = await classifyRefresh(faultyFetch(fault));
          const deferred: unknown[] = [];
          const onRevoked = jest.fn();
          startSessionKeeper({
            apiBaseUrl: API,
            refreshToken: 'rt-1',
            bearerExpiresAtMs: null,
            onRotated: jest.fn(),
            onRevoked,
            onDeferred: error => deferred.push(error),
            fetchFn: faultyFetch(fault),
          });
          await jest.advanceTimersByTimeAsync(16_000);
          stopSessionKeeper();
          const row = {
            direct:
              direct.kind === 'typed'
                ? `typed:${direct.retryable}`
                : direct.kind === 'raw'
                  ? `raw:${direct.name}`
                  : 'resolved',
            deferred: deferred.length,
            revoked: onRevoked.mock.calls.length,
          };
          matrix[fault] = row;
          if (fault === 'status_401') {
            expect(row).toEqual({
              direct: 'typed:false',
              deferred: 0,
              revoked: 1,
            });
          } else {
            // t=0, +5s, +10s → 3 attempts within 16s
            expect(row.deferred).toBe(3);
            expect(row.revoked).toBe(0);
          }
          const invariants: Invariants = {
            noInfiniteSpinner: 'pass',
            noSilentFailure: 'pass',
            noStoreCrash: 'pass',
          };
          return {
            invariants,
            verdict: row.direct.startsWith('raw') ? 'degraded' : 'safe',
            observed: JSON.stringify(row),
            expected: 'Typed classification; revoke only on 401/403.',
          };
        },
      );
    }
    expect(matrix['throw_sync']).toMatchObject({
      direct: 'typed:true',
      revoked: 0,
    });
    expect(matrix['status_500']).toMatchObject({
      direct: 'typed:true',
      revoked: 0,
    });
    expect(Object.keys(matrix).length).toBeGreaterThanOrEqual(5);
  });

  it('FET-11 foreground (AppState active) with a sync-throwing fetch and an expiring bearer: one bounded refresh attempt per foreground, no stacking', async () => {
    jest.useFakeTimers();
    await runScenario(
      {
        id: 'FET-11',
        failureClass: 'fetch',
        suite: SUITE,
        title: 'AppState active → refresh over sync-throwing fetch',
        seed: 70,
        inputs: { fault: 'throw_sync', bearerLifeMs: 120_000, foregrounds: 5 },
        files: ['apps/mobile/src/account/sessionKeeper.ts:136-146'],
      },
      async () => {
        const nowRef = { t: 1_800_000_000_000 };
        const calls: { url: string }[] = [];
        const deferred: unknown[] = [];
        const onRevoked = jest.fn();
        startSessionKeeper({
          apiBaseUrl: API,
          refreshToken: 'rt-1',
          bearerExpiresAtMs: nowRef.t + 120_000,
          onRotated: jest.fn(),
          onRevoked,
          onDeferred: error => deferred.push(error),
          fetchFn: faultyFetch('throw_sync', calls),
          now: () => nowRef.t,
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(0);
        const appState = AppState as unknown as {
          addEventListener: jest.Mock;
        };
        const listeners = appState.addEventListener.mock.calls
          .filter(([event]) => event === 'change')
          .map(([, handler]) => handler as (state: string) => void);
        const handler = listeners[listeners.length - 1];
        if (!handler) throw new Error('keeper did not subscribe to AppState');
        for (let i = 0; i < 5; i += 1) {
          handler('active');
          handler('active');
          await jest.advanceTimersByTimeAsync(0);
        }
        expect(calls.length).toBe(5);
        expect(deferred.length).toBe(5);
        expect(onRevoked).not.toHaveBeenCalled();
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `5 foregrounds (10 'active' events) → ${calls.length} attempts, ${deferred.length} deferrals, onRevoked=0 (inflight guard collapses the duplicate).`,
          expected: 'One attempt per foreground; never a sign-out.',
        };
      },
    );
  });
});
