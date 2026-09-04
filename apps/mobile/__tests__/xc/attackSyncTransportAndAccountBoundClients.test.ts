/**
 * Adversarial pins for XCM-07's neighbourhood (mutants AU-21, AU-22, AU-23 —
 * all of which SURVIVE the candidate's suites, `--suites all` included):
 *
 *  - AU-21: the SYNC transport built by configureSyncRuntime() is the third
 *    long-lived client named in AGENTS.md ("sync transport, billing,
 *    training"). XCM-07's expected behaviour says `npx jest` must fail when
 *    "sync/billing clients capture the bearer at construction", yet the only
 *    existing outbox-401 test builds its OWN transport with
 *    createTransport(liveClientConfig()) and never exercises the runtime's
 *    transport. Here the runtime's transport itself must carry the rotated
 *    bearer after an in-session rotation, without a reconfigure.
 *  - AU-22 / AU-23: the billing and training getters must stay ACCOUNT-BOUND
 *    (bearerTokenFor(canonicalAppUserId)), not merely per-request. A getter
 *    that resolves getApiSession()?.bearerToken is still "per request" and
 *    still passes every AU-11/AU-12 killer, but a client configured for
 *    account A would put account B's bearer on the wire the moment the live
 *    ApiSession belongs to B (the exact situation the candidate's own AU-16
 *    test sets up). The contract is that such a request never leaves the
 *    device.
 *
 * Same module seams as __tests__/xc/authStoreClientsAndStale401.test.ts.
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import type { SyncTransport } from '../../src/data/sync';
import { useAuthStore } from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearSyncRuntime,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';
import { useAccessStore } from '../../src/state/accessStore';
import { useTrainingStore } from '../../src/training/store';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

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

// The runtime's drain is replaced by one that pushes a single shot through
// WHATEVER transport the runtime hands it, so the bearer the runtime's own
// transport puts on the wire is observable at the fetch mock.
const drains: Array<Promise<void>> = [];
jest.mock('../../src/data/sync', () => {
  const actual = jest.requireActual<typeof import('../../src/data/sync')>(
    '../../src/data/sync',
  );
  return {
    ...actual,
    drainOutbox: jest.fn(async (_db: LocalDb, transport: SyncTransport) => {
      const drain = transport
        .syncShots([])
        .then(() => undefined)
        .catch(() => undefined);
      drains.push(drain);
      await drain;
      return { synced: 0, failed: 1, remaining: 1 };
    }),
  };
});

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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const otherCanonicalId = '11111111-1111-4111-8111-111111111111';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const bootstrapBody = (tokens: { access: string; refresh: string }) => ({
  user: { id: canonicalId, email: 'pat@example.com' },
  onboardingState: 'complete',
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});

const refreshBody = (tokens: { access: string; refresh: string }) => ({
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});

type Route = (init?: RequestInit) => Response | Promise<Response>;

function installRoutes(routes: Record<string, Route>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function bearerOf(init?: RequestInit): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization ?? headers.authorization;
}

/** A route that records each request and answers like a struggling server. */
function recordingRoute(): jest.Mock<Response, [init?: RequestInit]> {
  return jest.fn((init?: RequestInit) => {
    void init;
    return response({}, 500);
  });
}

/** Lets the keeper's / runtime's fire-and-forget chains settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  await Promise.all(drains);
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  drains.length = 0;
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
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn().mockResolvedValue({
      user: 'apple-user-opaque',
      identityToken: 'apple-identity-token',
      authorizationCode: 'one-use-apple-code',
      email: 'pat@privaterelay.example',
      givenName: 'Pat',
      familyName: 'Player',
    }),
  };
  installRoutes({});
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

describe('the sync runtime transport (AU-21)', () => {
  it('sends the rotated bearer after an in-session rotation without being rebuilt', async () => {
    const syncCalls = recordingRoute();
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-3', refresh: 'refresh-3' })),
      '/v1/shots:sync': syncCalls,
    });
    await useAuthStore.getState().signInWithApple();
    // configureSyncRuntime() triggers a first drain on its own.
    await settle();
    expect(syncCalls).toHaveBeenCalledTimes(1);
    expect(bearerOf(syncCalls.mock.calls[0]?.[0])).toBe('Bearer access-1');

    // A 401 for the current bearer → the keeper rotates it right now. The
    // runtime is NOT reconfigured (AGENTS.md: configure resets its state).
    reportApiUnauthorized('access-1');
    await settle();
    expect(getApiSession()?.bearerToken).toBe('access-3');
    expect(bearerTokenFor(canonicalId)).toBe('access-3');

    triggerOutboxSync();
    await settle();
    expect(syncCalls).toHaveBeenCalledTimes(2);
    expect(bearerOf(syncCalls.mock.calls[1]?.[0])).toBe('Bearer access-3');
  });
});

describe('billing and training clients are bound to the account they were configured for (AU-22, AU-23)', () => {
  async function signInThenLiveSessionBelongsToAnotherAccount(): Promise<{
    accessCalls: jest.Mock;
    trainingCalls: jest.Mock;
    fetchMock: jest.Mock;
  }> {
    const accessCalls = recordingRoute();
    const trainingCalls = recordingRoute();
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/me/access': accessCalls,
      '/v1/me/saved-drills': trainingCalls,
    });
    await useAuthStore.getState().signInWithApple();
    expect(bearerTokenFor(canonicalId)).toBe('access-1');

    // The live ApiSession now belongs to ANOTHER account (the situation the
    // canonical "401 for a session that is not the signed-in account" pin
    // sets up). The clients configured for `canonicalId` must not resolve
    // that bearer.
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'other-access',
      canonicalAppUserId: otherCanonicalId,
      provider: 'google',
      refreshToken: 'other-refresh',
      bearerExpiresAtMs: FAR_FUTURE_SECONDS * 1000,
    });
    expect(bearerTokenFor(canonicalId)).toBeNull();
    expect(bearerTokenFor(otherCanonicalId)).toBe('other-access');
    return { accessCalls, trainingCalls, fetchMock };
  }

  it("the billing/access client never puts another account's bearer on the wire", async () => {
    const { accessCalls, fetchMock } =
      await signInThenLiveSessionBelongsToAnotherAccount();
    await useAccessStore.getState().refreshAccess();
    expect(accessCalls).not.toHaveBeenCalled();
    const bearers = fetchMock.mock.calls.map(([, init]) =>
      bearerOf(init as RequestInit | undefined),
    );
    expect(bearers).not.toContain('Bearer other-access');
  });

  it("the training client never puts another account's bearer on the wire", async () => {
    const { trainingCalls, fetchMock } =
      await signInThenLiveSessionBelongsToAnotherAccount();
    await useTrainingStore.getState().loadSavedDrills();
    expect(trainingCalls).not.toHaveBeenCalled();
    const bearers = fetchMock.mock.calls.map(([, init]) =>
      bearerOf(init as RequestInit | undefined),
    );
    expect(bearers).not.toContain('Bearer other-access');
  });
});
