/**
 * xc-failure-injection-mobile — KEYCHAIN UNAVAILABLE.
 *
 * `react-native-keychain` is replaced by a controllable mock whose every
 * operation can reject, throw synchronously (the shape a missing native
 * module produces: TypeError on an undefined bridge), resolve `false`, or
 * hang. The real authStore / sessionVault / sessionKeeper run on top of it.
 *
 * Invariants under test (assignment): no infinite spinner, no silent
 * failure, no crash out of a store. Each scenario records seed + inputs to
 * artifacts/failure-injection/records/keychain.jsonl (see recorder.ts).
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../../src/data/db';
import {
  runScenario,
  seededRng,
  pick,
  settleWithinFakeTime,
  verdictFor,
  type Invariants,
} from '../../../scripts/failure-injection/recorder';

// ─── Controllable Keychain ───────────────────────────────────────────────────

type KeychainOp = 'get' | 'set' | 'reset';
type KeychainFault = 'ok' | 'reject' | 'throw_sync' | 'resolve_false' | 'hang';

const mockKeychainState: {
  faults: Record<KeychainOp, KeychainFault>;
  message: string;
  store: Map<string, { username: string; password: string }>;
  calls: { op: KeychainOp; fault: KeychainFault }[];
} = {
  faults: { get: 'ok', set: 'ok', reset: 'ok' },
  message: 'Keychain error: errSecInteractionNotAllowed (-25308)',
  store: new Map(),
  calls: [],
};

function mockKeychainFault(op: KeychainOp): void | Promise<never> {
  const fault = mockKeychainState.faults[op];
  mockKeychainState.calls.push({ op, fault });
  if (fault === 'reject') {
    return Promise.reject(new Error(mockKeychainState.message));
  }
  if (fault === 'throw_sync') {
    throw new TypeError(
      "Cannot read property 'setGenericPasswordForOptions' of null (RNKeychainManager native module missing)",
    );
  }
  if (fault === 'hang') return new Promise<never>(() => {});
  return undefined;
}

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  async setGenericPassword(
    username: string,
    password: string,
    options: { service: string },
  ) {
    const pending = mockKeychainFault('set');
    if (pending) return pending;
    if (mockKeychainState.faults.set === 'resolve_false') return false;
    mockKeychainState.store.set(options.service, { username, password });
    return { service: options.service, storage: 'keychain' };
  },
  async getGenericPassword(options: { service: string }) {
    const pending = mockKeychainFault('get');
    if (pending) return pending;
    const item = mockKeychainState.store.get(options.service);
    return item
      ? { ...item, service: options.service, storage: 'keychain' }
      : false;
  },
  async resetGenericPassword(options: { service: string }) {
    const pending = mockKeychainFault('reset');
    if (pending) return pending;
    if (mockKeychainState.faults.reset === 'resolve_false') return false;
    mockKeychainState.store.delete(options.service);
    return true;
  },
}));

// ─── Other module seams (same shape as authDurableSession.test.ts) ──────────

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

import { useAuthStore } from '../../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
} from '../../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../../src/account/sessionVault';
import { stopSessionKeeper } from '../../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';

const SUITE = 'keychain';
const FILES = {
  hydrateLoad: 'apps/mobile/src/auth/authStore.ts:568',
  hydrateCatch: 'apps/mobile/src/auth/authStore.ts:600-604',
  persistSession: 'apps/mobile/src/auth/authStore.ts:247',
  signOutClear: 'apps/mobile/src/auth/authStore.ts:715',
  vaultLoad: 'apps/mobile/src/account/sessionVault.ts:105-119',
  vaultSave: 'apps/mobile/src/account/sessionVault.ts:83-101',
  vaultClear: 'apps/mobile/src/account/sessionVault.ts:121-130',
};

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const sessionBody = (access: string, refresh: string) => ({
  session: {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});

function installRoutes(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function seedVault(refreshToken: string) {
  mockKeychainState.store.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

function vaultHas(): boolean {
  return mockKeychainState.store.has(SESSION_VAULT_SERVICE);
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

function resetAuthWorld() {
  mockKv.clear();
  mockKeychainState.store.clear();
  mockKeychainState.calls.length = 0;
  mockKeychainState.faults = { get: 'ok', set: 'ok', reset: 'ok' };
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
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn(async () => ({
      user: 'apple-user-opaque',
      identityToken: 'apple-identity-token',
      authorizationCode: 'one-use-apple-code',
      email: 'pat@privaterelay.example',
      givenName: 'Pat',
      familyName: 'Player',
    })),
  };
  installRoutes({});
}

beforeEach(() => {
  jest.useRealTimers();
  resetAuthWorld();
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

const bootstrapRoutes = () => ({
  '/v1/account/bootstrap': () =>
    response({
      user: { id: canonicalId, email: 'pat@example.com' },
      onboardingState: 'complete',
      ...sessionBody('access-1', 'refresh-1'),
    }),
  '/v1/auth/refresh': () => response(sessionBody('access-2', 'refresh-2')),
  '/v1/auth/logout': () => response({ ok: true }),
});

// ─── Scenarios ───────────────────────────────────────────────────────────────

describe('xc-failure-injection — Keychain unavailable', () => {
  it('KC-01 Keychain READ rejects at launch: hydrate settles signed-out, store intact, but the durable session is dropped for this launch with no surfaced reason', async () => {
    await runScenario(
      {
        id: 'KC-01',
        failureClass: 'keychain',
        suite: SUITE,
        title: 'getGenericPassword rejects during authStore.hydrate()',
        seed: 1,
        inputs: {
          faults: { get: 'reject' },
          message: mockKeychainState.message,
          vaultSeeded: true,
        },
        files: [FILES.hydrateLoad, FILES.vaultLoad, FILES.hydrateCatch],
      },
      async () => {
        seedVault('refresh-durable');
        mockKeychainState.faults.get = 'reject';
        installRoutes(bootstrapRoutes());
        const fetchMock = globalThis.fetch as jest.Mock;

        await expect(
          useAuthStore.getState().hydrate(),
        ).resolves.toBeUndefined();
        const state = useAuthStore.getState();
        expect(state.hydrated).toBe(true);
        expect(state.session).toBeNull();
        expect(state.error).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(vaultHas()).toBe(true);

        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          // The record is intact and valid, yet the launch lands signed-out
          // with `error: null`: nothing tells the user or telemetry why.
          noSilentFailure: 'fail',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'hydrate() resolved; hydrated=true, session=null, error=null; refresh never attempted; Keychain record still present and valid.',
          expected:
            'Signed-out fallback is acceptable, but the launch should surface a reason (error state or retry of the vault read) instead of a silent Welcome screen while a valid durable session exists.',
        };
      },
    );
  });

  it('KC-02 Keychain READ hangs at launch: hydrate never settles — Gate shows "Getting things ready" forever (no launch-time bound on the vault read)', async () => {
    jest.useFakeTimers();
    await runScenario(
      {
        id: 'KC-02',
        failureClass: 'keychain',
        suite: SUITE,
        title: 'getGenericPassword never resolves during authStore.hydrate()',
        seed: 2,
        inputs: {
          faults: { get: 'hang' },
          fakeTimeBudgetMs: 120_000,
          vaultSeeded: true,
        },
        files: [
          FILES.hydrateLoad,
          FILES.vaultLoad,
          'apps/mobile/App.tsx (Gate: !ready → LoadingState)',
        ],
      },
      async () => {
        seedVault('refresh-durable');
        mockKeychainState.faults.get = 'hang';
        const result = await settleWithinFakeTime(
          useAuthStore.getState().hydrate(),
          120_000,
          ms => jest.advanceTimersByTimeAsync(ms),
          5_000,
        );
        expect(result.settled).toBe(false);
        expect(useAuthStore.getState().hydrated).toBe(false);
        const invariants: Invariants = {
          noInfiniteSpinner: 'fail',
          noSilentFailure: 'fail',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'After 120s of fake time hydrate() had not settled; hydrated=false so App.tsx Gate keeps rendering LoadingState("Getting things ready").',
          expected:
            'The launch vault read should be bounded (like the 8s launch refresh wait) so a stalled Keychain degrades to signed-out/retry instead of a permanent spinner.',
        };
      },
    );
  });

  it('KC-03 Keychain WRITE rejects during Apple sign-in: sign-in succeeds in memory with error=null; the next launch is silently signed out', async () => {
    await runScenario(
      {
        id: 'KC-03',
        failureClass: 'keychain',
        suite: SUITE,
        title:
          'setGenericPassword rejects during signInWithApple → persistSession',
        seed: 3,
        inputs: {
          faults: { set: 'reject' },
          message: mockKeychainState.message,
        },
        files: [FILES.persistSession, FILES.vaultSave, FILES.hydrateLoad],
      },
      async () => {
        installRoutes(bootstrapRoutes());
        mockKeychainState.faults.set = 'reject';
        await expect(
          useAuthStore.getState().signInWithApple(),
        ).resolves.toBeUndefined();
        const afterSignIn = useAuthStore.getState();
        expect(afterSignIn.error).toBeNull();
        expect(afterSignIn.busy).toBe(false);
        expect(afterSignIn.session?.canonicalAppUserId).toBe(canonicalId);
        expect(getApiSession()?.bearerToken).toBe('access-1');
        expect(vaultHas()).toBe(false);

        // Relaunch with a healthy Keychain: nothing was persisted.
        stopSessionKeeper();
        clearApiSession();
        useAuthStore.setState({ hydrated: false, session: null });
        mockKeychainState.faults.set = 'ok';
        await useAuthStore.getState().hydrate();
        expect(useAuthStore.getState().hydrated).toBe(true);
        expect(useAuthStore.getState().session).toBeNull();

        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          noSilentFailure: 'fail',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'signInWithApple() resolved with session set and error=null although savePersistedSession returned false; relaunch landed signed-out.',
          expected:
            'The store should learn that the session is NOT durable (savePersistedSession result is discarded at authStore.ts:247) and surface it, or retry the write.',
        };
      },
    );
  });

  it('KC-04 Keychain WRITE resolves false (no item written): same silent non-persistence as KC-03', async () => {
    await runScenario(
      {
        id: 'KC-04',
        failureClass: 'keychain',
        suite: SUITE,
        title: 'setGenericPassword resolves false during signInWithApple',
        seed: 4,
        inputs: { faults: { set: 'resolve_false' } },
        files: [FILES.persistSession, FILES.vaultSave],
      },
      async () => {
        installRoutes(bootstrapRoutes());
        mockKeychainState.faults.set = 'resolve_false';
        await useAuthStore.getState().signInWithApple();
        expect(useAuthStore.getState().error).toBeNull();
        expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
          canonicalId,
        );
        expect(vaultHas()).toBe(false);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          noSilentFailure: 'fail',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: 'Sign-in completed; vault empty; error=null.',
          expected:
            'As KC-03: the non-durable outcome should be surfaced or retried.',
        };
      },
    );
  });

  it('KC-05 Keychain RESET rejects during an OFFLINE sign-out: signOut settles signed-out, but the Keychain record survives and the next launch restores the signed-out account', async () => {
    await runScenario(
      {
        id: 'KC-05',
        failureClass: 'keychain',
        suite: SUITE,
        title:
          'resetGenericPassword rejects during signOut while /v1/auth/logout is unreachable',
        seed: 5,
        inputs: {
          faults: { reset: 'reject' },
          network: 'logout route unreachable',
          relaunchNetwork: 'refresh route 200',
        },
        files: [FILES.signOutClear, FILES.vaultClear, FILES.hydrateLoad],
      },
      async () => {
        // Sign in with a healthy Keychain.
        installRoutes(bootstrapRoutes());
        await useAuthStore.getState().signInWithApple();
        expect(vaultHas()).toBe(true);

        // Offline sign-out with the vault reset failing.
        installRoutes({});
        mockKeychainState.faults.reset = 'reject';
        await expect(
          useAuthStore.getState().signOut(),
        ).resolves.toBeUndefined();
        expect(useAuthStore.getState().session).toBeNull();
        expect(vaultHas()).toBe(true);

        // Relaunch online with a healthy Keychain.
        mockKeychainState.faults.reset = 'ok';
        installRoutes(bootstrapRoutes());
        useAuthStore.setState({ hydrated: false, session: null });
        await useAuthStore.getState().hydrate();
        const restored = useAuthStore.getState();
        expect(restored.hydrated).toBe(true);
        expect(restored.session?.canonicalAppUserId).toBe(canonicalId);

        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          noSilentFailure: 'fail',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'signOut() resolved with session=null while the Keychain record remained (reset rejected, logout unreachable); the next hydrate() restored the account via /v1/auth/refresh.',
          expected:
            'An explicit sign-out whose vault clear fails should not leave the account restorable on the next launch (retry the reset, or mark the record dead in SQLite kv so hydrate ignores it).',
        };
      },
    );
  });

  it('KC-06 Keychain native module missing (synchronous TypeError from the bridge): every vault op fails soft; hydrate, sign-in and sign-out all settle', async () => {
    await runScenario(
      {
        id: 'KC-06',
        failureClass: 'keychain',
        suite: SUITE,
        title:
          'All Keychain ops throw synchronously (RNKeychainManager missing)',
        seed: 6,
        inputs: {
          faults: { get: 'throw_sync', set: 'throw_sync', reset: 'throw_sync' },
        },
        files: [FILES.vaultLoad, FILES.vaultSave, FILES.vaultClear],
      },
      async () => {
        mockKeychainState.faults = {
          get: 'throw_sync',
          set: 'throw_sync',
          reset: 'throw_sync',
        };
        installRoutes(bootstrapRoutes());
        await expect(
          useAuthStore.getState().hydrate(),
        ).resolves.toBeUndefined();
        expect(useAuthStore.getState().hydrated).toBe(true);
        await expect(
          useAuthStore.getState().signInWithApple(),
        ).resolves.toBeUndefined();
        expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
          canonicalId,
        );
        expect(useAuthStore.getState().error).toBeNull();
        await expect(
          useAuthStore.getState().signOut(),
        ).resolves.toBeUndefined();
        expect(useAuthStore.getState().session).toBeNull();
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noStoreCrash: 'pass',
          noSilentFailure: 'n/a',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'hydrate/signInWithApple/signOut all resolved; no exception escaped a store action; sign-in worked in memory for the run.',
          expected: 'Fail-soft as documented in sessionVault.ts header.',
        };
      },
    );
  });

  it('KC-07 seeded sweep ×32: random fault per Keychain op — every store action settles, none throws', async () => {
    const faultsPool: KeychainFault[] = [
      'ok',
      'reject',
      'throw_sync',
      'resolve_false',
    ];
    const rows: {
      seed: number;
      faults: Record<KeychainOp, KeychainFault>;
      signedInAfterRelaunch: boolean;
    }[] = [];
    for (let seed = 100; seed < 132; seed += 1) {
      const rng = seededRng(seed);
      const faults: Record<KeychainOp, KeychainFault> = {
        get: pick(rng, faultsPool),
        set: pick(rng, faultsPool),
        reset: pick(rng, faultsPool),
      };
      await runScenario(
        {
          id: `KC-07/${seed}`,
          failureClass: 'keychain',
          suite: SUITE,
          title: 'sign-in → relaunch → sign-out under seeded Keychain faults',
          seed,
          inputs: { faults },
          files: [FILES.vaultLoad, FILES.vaultSave, FILES.vaultClear],
        },
        async () => {
          resetAuthWorld();
          installRoutes(bootstrapRoutes());
          mockKeychainState.faults = { ...faults };
          await expect(
            useAuthStore.getState().signInWithApple(),
          ).resolves.toBeUndefined();
          expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
            canonicalId,
          );
          stopSessionKeeper();
          clearApiSession();
          useAuthStore.setState({ hydrated: false, session: null });
          await expect(
            useAuthStore.getState().hydrate(),
          ).resolves.toBeUndefined();
          expect(useAuthStore.getState().hydrated).toBe(true);
          const signedInAfterRelaunch =
            useAuthStore.getState().session !== null;
          const persisted = faults.set === 'ok';
          // `resolve_false` has no meaning for a read: the mock returns the
          // stored item, so the record is readable.
          const readable =
            faults.get === 'ok' || faults.get === 'resolve_false';
          expect(signedInAfterRelaunch).toBe(persisted && readable);
          await expect(
            useAuthStore.getState().signOut(),
          ).resolves.toBeUndefined();
          expect(useAuthStore.getState().session).toBeNull();
          rows.push({ seed, faults, signedInAfterRelaunch });
          const invariants: Invariants = {
            noInfiniteSpinner: 'pass',
            noStoreCrash: 'pass',
            noSilentFailure: persisted && readable ? 'pass' : 'fail',
          };
          return {
            invariants,
            verdict: verdictFor(invariants),
            observed: `relaunch signed-in=${signedInAfterRelaunch} (set=${faults.set}, get=${faults.get}, reset=${faults.reset}); all actions settled.`,
            expected:
              'Actions settle; durable-session loss is deterministic in (set, get) faults and should be surfaced.',
          };
        },
      );
    }
    expect(rows).toHaveLength(32);
  });
});
