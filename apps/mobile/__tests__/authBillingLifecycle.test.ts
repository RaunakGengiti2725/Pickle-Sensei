import { AppState, NativeModules } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { useAuthStore } from '../src/auth/authStore';
import { clearApiSession, getApiSession } from '../src/account/apiSession';
import {
  refreshSessionNow,
  stopSessionKeeper,
} from '../src/account/sessionKeeper';
import { SESSION_VAULT_SERVICE } from '../src/account/sessionVault';
import * as billing from '../src/billing';
import * as lifecycle from '../src/billing/lifecycle';
import * as revenueCat from '../src/billing/revenueCatClient';
import type {
  BillingStoreClient,
  CanonicalAccessState,
} from '../src/billing/types';
import {
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import type { LocalDb } from '../src/data/db';
import * as accessStore from '../src/state/accessStore';

const mockKv = new Map<string, string>();
const mockDb: LocalDb = {
  async execute(sql, params = []) {
    if (sql.startsWith('SELECT value FROM kv')) {
      const value = mockKv.get(String(params[0]));
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
      mockKv.set(String(params[0]), String(params[1]));
      return { rows: [] };
    }
    if (['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'].includes(sql))
      return { rows: [] };
    throw new Error(`Unexpected database operation: ${sql}`);
  },
  close() {},
};
jest.mock('../src/data/db', () => ({ getDb: () => mockDb }));
jest.mock('../src/billing/pendingFulfilment', () => {
  const actual = jest.requireActual<
    typeof import('../src/billing/pendingFulfilment')
  >('../src/billing/pendingFulfilment');
  return {
    ...actual,
    createPendingFulfilmentStorage: () =>
      actual.createPendingFulfilmentStorage(() => mockDb),
  };
});
jest.mock('../src/data/syncRuntime', () => ({
  configureSyncRuntime: jest.fn(),
  clearSyncRuntime: jest.fn(),
}));
jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: 'appl_public-test-key',
    appVersion: '1.0',
  }),
}));
jest.mock('../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'UTC',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'test',
    },
  }),
}));

const OWNER = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: false,
  paywallRequired: true,
};
const premiumAccess: CanonicalAccessState = {
  ...freeAccess,
  premium: true,
  entitlements: ['premium'],
  canStartRating: true,
  paywallRequired: false,
};
const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};
const nativeModules = NativeModules as { PickleAuth?: unknown };
const originalAuth = nativeModules.PickleAuth;
const originalAppState = AppState.currentState;
const originalFetch = globalThis.fetch;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
  } as unknown as Response;
}

function tokens(access: string) {
  return {
    session: {
      accessToken: access,
      refreshToken: `refresh-${access}`,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    },
  };
}

function verifiedMembership() {
  return response({
    billing: {
      premium: true,
      productKey: 'pickle_sensei_pro_annual',
      expiresAt: null,
      verifiedAt: new Date().toISOString(),
    },
    access: premiumAccess,
  });
}

function installRoutes(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
) {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`Unexpected API route: ${path}`);
    return route(init);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function flush() {
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
}

function storePort() {
  return {
    configure: jest.fn(async () => undefined),
    loadPlans: jest.fn(async () => ({
      offeringId: 'default',
      annual: null,
      monthly: null,
      lifetime: null,
    })),
    purchase: jest.fn(async () => ({
      premium: false,
      productId: null,
      expirationDate: null,
    })),
    restore: jest.fn(async () => ({
      premium: false,
      productId: null,
      expirationDate: null,
    })),
    readEntitlement: jest.fn(async () => ({
      premium: false,
      productId: null,
      expirationDate: null,
    })),
  } satisfies BillingStoreClient;
}

beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00Z') });
  AppState.currentState = 'active';
  mockKv.clear();
  __keychainStore.clear();
  accessStore.discardPendingFulfilmentForOwner(OWNER);
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn(async () => ({
      user: 'apple-subject',
      identityToken: 'apple-id-token',
      authorizationCode: 'apple-code',
    })),
  };
  installRoutes({});
});

afterEach(async () => {
  lifecycle.stopBillingLifecycle();
  stopSessionKeeper();
  clearApiSession();
  accessStore.clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  await flush();
  expect(jest.getTimerCount()).toBe(0);
  nativeModules.PickleAuth = originalAuth;
  AppState.currentState = originalAppState;
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('auth installs the real billing lifecycle once per canonical API connection', () => {
  it('starts only after bootstrap installs canonical owner and bearer; rotation neither restarts nor reconfigures billing', async () => {
    const store = storePort();
    jest
      .spyOn(revenueCat, 'createRevenueCatBillingClient')
      .mockReturnValue(store);
    const create = jest.spyOn(billing, 'createBillingAccessDependencies');
    const configure = jest.spyOn(accessStore, 'configureAccessStore');
    const start = jest.spyOn(lifecycle, 'startBillingLifecycle');
    const stop = jest.spyOn(lifecycle, 'stopBillingLifecycle');
    let releaseBootstrap!: (value: Response) => void;
    const bootstrap = new Promise<Response>(resolve => {
      releaseBootstrap = resolve;
    });
    const reads = jest.fn((init?: RequestInit) => {
      expect(getActiveDataOwner()).toBe(OWNER);
      expect(getApiSession()?.canonicalAppUserId).toBe(OWNER);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer access-1' });
      expect(configure).toHaveBeenCalledTimes(1);
      return response(freeAccess);
    });
    const sync = jest.fn(() => verifiedMembership());
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () => bootstrap,
      '/v1/me/access': reads,
      '/v1/billing/sync': sync,
      '/v1/auth/refresh': () => response(tokens('access-2')),
      '/v1/auth/logout': () => response(null, 204),
    });

    const signIn = useAuthStore.getState().signInWithApple();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getApiSession()).toBeNull();
    expect(configure).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    releaseBootstrap(
      response({
        user: { id: OWNER, email: null },
        onboardingState: 'complete',
        ...tokens('access-1'),
      }),
    );
    await signIn;
    await flush();
    expect(useAuthStore.getState().error).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(OWNER);
    expect(create).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(accessStore.useAccessStore.getState().canonicalAccess).toEqual(
      premiumAccess,
    );
    expect(jest.getTimerCount()).toBe(2);
    const state = accessStore.useAccessStore.getState();

    refreshSessionNow();
    await flush();
    expect(getApiSession()?.bearerToken).toBe('access-2');
    expect(accessStore.useAccessStore.getState()).toBe(state);
    expect(create).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(
      accessStore.BILLING_RECONCILIATION_INTERVAL_MS,
    );
    expect(sync).toHaveBeenCalledTimes(2);
    expect(reads).toHaveBeenCalledTimes(1);
    const billingRequests = fetchMock.mock.calls.filter(([url]) =>
      url.endsWith('/v1/billing/sync'),
    );
    expect(billingRequests.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ Authorization: 'Bearer access-1' }),
      expect.objectContaining({ Authorization: 'Bearer access-2' }),
    ]);
    for (const method of Object.values(store))
      expect(method).not.toHaveBeenCalled();

    const stopsBeforeSignOut = stop.mock.calls.length;
    await useAuthStore.getState().signOut();
    await flush();
    expect(stop).toHaveBeenCalledTimes(stopsBeforeSignOut + 1);
    expect(accessStore.useAccessStore.getState().canonicalAccess).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(
      accessStore.BILLING_RECONCILIATION_INTERVAL_MS,
    );
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('starts on the first late launch refresh, but not while only a vault owner exists or on subsequent rotation', async () => {
    const store = storePort();
    jest
      .spyOn(revenueCat, 'createRevenueCatBillingClient')
      .mockReturnValue(store);
    const configure = jest.spyOn(accessStore, 'configureAccessStore');
    const start = jest.spyOn(lifecycle, 'startBillingLifecycle');
    __keychainStore.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: OWNER,
        refreshToken: 'vault-refresh',
        email: null,
        displayName: null,
      }),
    });
    let releaseRefresh!: (value: Response) => void;
    const firstRefresh = new Promise<Response>(resolve => {
      releaseRefresh = resolve;
    });
    const refresh = jest
      .fn()
      .mockReturnValueOnce(firstRefresh)
      .mockImplementation(() => response(tokens('access-3')));
    const read = jest.fn(() => response(freeAccess));
    const sync = jest.fn(() => verifiedMembership());
    installRoutes({
      '/v1/auth/refresh': refresh,
      '/v1/me/access': read,
      '/v1/billing/sync': sync,
    });

    const restore = useAuthStore.getState().hydrate();
    await jest.advanceTimersByTimeAsync(8_000);
    await restore;
    expect(getActiveDataOwner()).toBe(OWNER);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER);
    expect(getApiSession()).toBeNull();
    expect(configure).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();

    releaseRefresh(response(tokens('access-2')));
    await flush();
    expect(getApiSession()?.bearerToken).toBe('access-2');
    expect(configure).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(accessStore.useAccessStore.getState().canonicalAccess).toEqual(
      premiumAccess,
    );
    const state = accessStore.useAccessStore.getState();
    refreshSessionNow();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(getApiSession()?.bearerToken).toBe('access-3');
    expect(accessStore.useAccessStore.getState()).toBe(state);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    for (const method of Object.values(store))
      expect(method).not.toHaveBeenCalled();
  });

  it('does not start billing for a guest session', async () => {
    const create = jest.spyOn(billing, 'createBillingAccessDependencies');
    const start = jest.spyOn(lifecycle, 'startBillingLifecycle');
    await useAuthStore.getState().continueAsGuest();
    expect(useAuthStore.getState().session?.localOnly).toBe(true);
    expect(getApiSession()).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
