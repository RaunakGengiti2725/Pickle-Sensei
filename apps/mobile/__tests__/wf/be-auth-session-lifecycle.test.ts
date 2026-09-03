/**
 * auth-session-lifecycle reproduction: what the mobile client does once its
 * bearer stops being accepted (access token past `exp` or revoked, refresh
 * token revoked elsewhere, account deleted elsewhere…).
 *
 * Facts pinned here (durable-session contract, 2026-09-01):
 *   1. `/v1/account/bootstrap` spends the Apple identity token ONCE and the
 *      bearer installed afterwards is the Supabase ACCESS token it minted.
 *      The refresh token is the only durable credential (device Keychain via
 *      sessionVault.ts); neither the access token nor the provider token is
 *      ever persisted — not in the Keychain, not in SQLite kv.
 *   2. A 401 for the CURRENT bearer on any API caller (generic transport,
 *      training, billing) rotates the session in place through
 *      `POST /v1/auth/refresh`; the user stays signed in, the rotated bearer
 *      reaches every long-lived client through `bearerTokenFor`, and the
 *      rotated refresh token replaces the spent one in the Keychain.
 *   3. The ONE implicit sign-out is the server refusing the refresh token
 *      (401/403 from /v1/auth/refresh): session, bearer, data owner and
 *      Keychain record all go, and the provider is not re-prompted.
 *   4. A 401 for a bearer that is no longer current (a late response for an
 *      already rotated token) is ignored, so one expiry cannot tear down its
 *      successor.
 *   5. The outbox treats 401 as transient: the queued row keeps its attempt
 *      budget and is replayed under the rotated bearer — or, once a session
 *      is gone, simply waits for the next sign-in and never replays the dead
 *      bearer.
 *   6. A LEGACY session (an older server returned no `session` block, so the
 *      bearer IS the provider token and there is nothing to rotate) keeps
 *      the pre-contract path: for Apple, which has no silent restore, the
 *      401 lands the user signed out with an honest "sign-in expired" reason.
 *
 * Mock style follows authDurableSession.test.ts (in-memory kv LocalDb,
 * module mocks for the provider SDKs, the react-native-keychain auto-mock,
 * URL-routed jest.fn fetch).
 */
import { NativeModules } from 'react-native';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import {
  SESSION_EXPIRED_MESSAGE,
  useAuthStore,
} from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { ApiError, createTransport } from '../../src/data/api';
import { drainOutbox, isPermanentSyncFailure } from '../../src/data/sync';
import { createTrainingApi } from '../../src/training/api';
import { TrainingError } from '../../src/training/types';
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import { BillingError } from '../../src/billing/types';
import * as Keychain from 'react-native-keychain';

// The auto-mock (__mocks__/react-native-keychain.ts) exposes its in-memory
// store — the same instance sessionVault requires.
const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Module seams ────────────────────────────────────────────────────────────

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

const mockKv = new Map<string, string>();
const mockOutbox: OutboxRow[] = [];

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
      if (statement.startsWith('SELECT id, kind, payload')) {
        return {
          rows: mockOutbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .map(r => ({ ...r })),
        };
      }
      if (statement.startsWith('UPDATE outbox')) {
        const row = mockOutbox.find(
          r => r.owner_key === params[1] && r.id === params[2],
        );
        if (row) {
          if (statement.includes('attempts = attempts + 1')) row.attempts += 1;
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (statement.startsWith('DELETE FROM outbox')) {
        const index = mockOutbox.findIndex(
          r => r.owner_key === params[0] && r.id === params[1],
        );
        if (index !== -1) mockOutbox.splice(index, 1);
        return { rows: [] };
      }
      if (statement.startsWith('SELECT count(*)')) {
        return {
          rows: [
            {
              n: mockOutbox.filter(row => row.owner_key === params[0]).length,
            },
          ],
        };
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const API = 'https://api.example.test';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

/** Stand-in for an Apple identity token (RS256 JWT, `exp` minutes after
 * issue). Nothing on the client decodes it — bootstrap spends it as an
 * opaque bearer exactly once — so a three-segment string tagged with its exp
 * is sufficient here. */
function appleIdentityToken(expSeconds: number): string {
  return `eyJhbGciOiJSUzI1NiJ9.apple-identity-exp-${expSeconds}.sig`;
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    headers: { get: () => 'application/json' },
  } as unknown as Response;
}

const sessionBlock = (tokens: { access: string; refresh: string }) => ({
  accessToken: tokens.access,
  refreshToken: tokens.refresh,
  expiresAt: FAR_FUTURE_SECONDS,
});

/** A server on the durable-session contract. */
const bootstrapWithSession = (tokens: { access: string; refresh: string }) =>
  response({
    user: { id: canonicalId, email: 'pat@example.com' },
    onboardingState: 'complete',
    session: sessionBlock(tokens),
  });

/** An older server that predates the contract: no `session` block. */
const legacyBootstrap = () =>
  response({
    user: { id: canonicalId, email: 'pat@example.com' },
    onboardingState: 'complete',
  });

const refreshOk = (tokens: { access: string; refresh: string }) =>
  response({ session: sessionBlock(tokens) });

const UNAUTHORIZED_MESSAGE = 'The access token could not be verified.';
const unauthorized = () =>
  response(
    { error: { code: 'unauthorized', message: UNAUTHORIZED_MESSAGE } },
    401,
  );

type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

/** Reads the bearer regardless of header casing (the generic transport sends
 * lowercase `authorization`; bootstrap, training and billing send
 * `Authorization`). */
function bearerOf(init?: RequestInit): string | null {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const value = headers['authorization'] ?? headers['Authorization'] ?? null;
  return value?.replace(/^Bearer /, '') ?? null;
}

/** Routes fetch by URL suffix; unknown routes reject like a dead network. */
function installRoutes(routes: Record<string, RouteHandler>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function callsTo(fetchMock: jest.Mock, suffix: string) {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith(suffix),
  ) as Array<[string, RequestInit | undefined]>;
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function durableMaterial(): string {
  return JSON.stringify([...__keychainStore.values(), ...mockKv.values()]);
}

/** Lets the 401 → refresh → adopt chain (all promise-driven) run to rest. */
async function settleUnauthorizedHandling(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/**
 * Client config shaped the way production builds its long-lived clients
 * (syncRuntime, billing, training): the bearer is a GETTER resolved on EVERY
 * request through `bearerTokenFor`, bound to one account, so a rotation is
 * picked up without reconfiguring the client. Never spread this object — an
 * object spread would evaluate the getter once and capture the bearer, which
 * is exactly the anti-pattern the contract forbids.
 */
function liveClientConfig(fetchFn?: jest.Mock) {
  return {
    baseUrl: API,
    get token(): string | null {
      return bearerTokenFor(canonicalId);
    },
    ...(fetchFn ? { fetchFn } : {}),
  };
}

const analysis: ShotAnalysis & { analysisPermitId: string } = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-26T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
  analysisPermitId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
};

function queueShot(owner: string): void {
  mockOutbox.push({
    id: 1,
    owner_key: owner,
    kind: 'shot.sync',
    payload: JSON.stringify(analysis),
    attempts: 0,
    last_error: null,
  });
}

const realFetch = globalThis.fetch;
const nativeModules = NativeModules as {
  PickleAuth?: { signInWithApple: jest.Mock };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockOutbox.length = 0;
  __keychainStore.clear();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
  });
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  installRoutes({});
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
  delete nativeModules.PickleAuth;
});

/** Signs in with Apple through the real store + real bootstrap client against
 * whatever `/v1/account/bootstrap` route is installed. */
async function signInWithAppleToken(identityToken: string): Promise<jest.Mock> {
  const signInWithApple = jest.fn().mockResolvedValue({
    user: '001234.abcdef.5678',
    identityToken,
    email: 'pat@privaterelay.appleid.com',
    givenName: 'Pat',
    familyName: 'Player',
  });
  nativeModules.PickleAuth = { signInWithApple };
  await useAuthStore.getState().signInWithApple();
  expect(useAuthStore.getState().error).toBeNull();
  expect(useAuthStore.getState().session?.provider).toBe('apple');
  return signInWithApple;
}

/** A durable Apple session: bearer `access-1`, refresh token `refresh-1`. */
async function signInDurably(
  extraRoutes: Record<string, RouteHandler> = {},
): Promise<{
  identityToken: string;
  signInWithApple: jest.Mock;
  fetchMock: jest.Mock;
}> {
  const identityToken = appleIdentityToken(Math.floor(Date.now() / 1000) + 600);
  const fetchMock = installRoutes({
    '/v1/account/bootstrap': () =>
      bootstrapWithSession({ access: 'access-1', refresh: 'refresh-1' }),
    ...extraRoutes,
  });
  const signInWithApple = await signInWithAppleToken(identityToken);
  expect(getApiSession()?.bearerToken).toBe('access-1');
  return { identityToken, signInWithApple, fetchMock };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('auth-session-lifecycle: the bearer is a server-minted session, not the provider token', () => {
  it('bootstrap spends the Apple identity token once; the bearer is the Supabase access token and only the refresh token is durable (Keychain)', async () => {
    const { identityToken, fetchMock } = await signInDurably();

    const apiSession = getApiSession();
    expect(apiSession).not.toBeNull();
    expect(apiSession?.bearerToken).toBe('access-1');
    expect(apiSession?.bearerToken).not.toBe(identityToken);
    expect(apiSession).toMatchObject({
      apiBaseUrl: API,
      canonicalAppUserId: canonicalId,
      provider: 'apple',
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: FAR_FUTURE_SECONDS * 1000,
    });
    expect(Object.keys(apiSession ?? {}).sort()).toEqual([
      'apiBaseUrl',
      'bearerExpiresAtMs',
      'bearerToken',
      'canonicalAppUserId',
      'provider',
      'refreshToken',
    ]);
    expect(bearerTokenFor(canonicalId)).toBe('access-1');
    expect(getActiveDataOwner()).toBe(canonicalDataOwner(canonicalId));

    // The bootstrap exchange itself carried the identity token — the only
    // request that ever does.
    const bootstrapCalls = callsTo(fetchMock, '/v1/account/bootstrap');
    expect(bootstrapCalls).toHaveLength(1);
    expect(bearerOf(bootstrapCalls[0]![1])).toBe(identityToken);

    // Durable material: exactly the refresh token + UI descriptor, in the
    // Keychain, nothing else anywhere.
    expect(vaultRecord()).toEqual({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      refreshToken: 'refresh-1',
      email: 'pat@example.com',
      displayName: 'Pat Player',
    });
    const durable = durableMaterial();
    expect(durable).not.toContain(identityToken);
    expect(durable).not.toContain('access-1');
    for (const value of mockKv.values()) {
      expect(value).not.toContain('refresh-1');
    }
    // Apple gets no legacy silent-restore flag: the vault IS the restore.
    expect(mockKv.get('auth.last-provider') ?? '').toBe('');
  });

  it('an older server that returns no session leaves a LEGACY provider-token session: bearer = identity token, nothing to rotate, nothing persisted', async () => {
    const identityToken = appleIdentityToken(
      Math.floor(Date.now() / 1000) + 600,
    );
    installRoutes({ '/v1/account/bootstrap': () => legacyBootstrap() });
    await signInWithAppleToken(identityToken);

    const apiSession = getApiSession();
    expect(apiSession).toEqual({
      apiBaseUrl: API,
      bearerToken: identityToken,
      canonicalAppUserId: canonicalId,
      provider: 'apple',
      // Explicitly null (not absent): "no refresh material" is a stated fact
      // of the session, and it is what routes a later 401 down the legacy
      // path instead of a refresh.
      refreshToken: null,
      bearerExpiresAtMs: null,
    });
    // Nothing durable: on the next cold start the user is signed out, and
    // this bearer's usable life is bounded by the token's own `exp`.
    expect(vaultRecord()).toBeNull();
    expect(durableMaterial()).not.toContain(identityToken);
    expect(mockKv.get('auth.last-provider') ?? '').toBe('');
  });
});

describe('auth-session-lifecycle: a 401 on the current bearer rotates the session instead of ending it', () => {
  it('generic transport (outbox sync): a 401 refreshes the bearer in place — the row keeps its attempt budget and the next drain replays it under the rotated bearer', async () => {
    const { signInWithApple, fetchMock } = await signInDurably({
      '/v1/auth/refresh': () =>
        refreshOk({ access: 'access-2', refresh: 'refresh-2' }),
      '/v1/shots:sync': init =>
        bearerOf(init) === 'access-2'
          ? response({ acceptedIds: [analysis.id], rejected: [] })
          : unauthorized(),
    });
    const owner = canonicalDataOwner(canonicalId);
    queueShot(owner);
    const transport = createTransport(liveClientConfig());

    // Wall clock moves past the access token's exp; the server answers 401.
    // The drain records the transient failure on the row: no attempt is
    // consumed, so the rating stays syncable.
    const first = await drainOutbox(mockCurrentDb(), transport);
    expect(first).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    const syncCalls = callsTo(fetchMock, '/v1/shots:sync');
    expect(syncCalls).toHaveLength(1);
    expect(bearerOf(syncCalls[0]![1])).toBe('access-1');
    expect(isPermanentSyncFailure(new ApiError(401, 'unauthorized', 'x'))).toBe(
      false,
    );
    expect(mockOutbox[0]).toMatchObject({
      attempts: 0,
      last_error: expect.stringContaining(UNAUTHORIZED_MESSAGE),
    });

    // The auth layer reacted by rotating, not by signing out: one refresh
    // with the spent refresh token, the user still signed in with no error,
    // the rotated bearer live, the rotated refresh token in the Keychain.
    await settleUnauthorizedHandling();
    const refreshCalls = callsTo(fetchMock, '/v1/auth/refresh');
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ refreshToken: 'refresh-1' }),
    });
    expect(useAuthStore.getState().session).toMatchObject({
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      localOnly: false,
    });
    expect(useAuthStore.getState().error).toBeNull();
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
      canonicalAppUserId: canonicalId,
    });
    expect(bearerTokenFor(canonicalId)).toBe('access-2');
    expect(getActiveDataOwner()).toBe(owner);
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
    expect(durableMaterial()).not.toContain('access-2');
    // The provider is never re-prompted behind the user's back.
    expect(signInWithApple).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();

    // The next drain replays the SAME row under the rotated bearer — the
    // transport was never rebuilt — and the server accepts it.
    const second = await drainOutbox(mockCurrentDb(), transport);
    expect(second).toMatchObject({ synced: 1, failed: 0, remaining: 0 });
    const replay = callsTo(fetchMock, '/v1/shots:sync');
    expect(replay).toHaveLength(2);
    expect(bearerOf(replay[1]![1])).toBe('access-2');
    expect(mockOutbox).toHaveLength(0);
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
  });

  it('training client: 401 becomes a non-retryable TrainingError for THAT call, while the session is refreshed rather than torn down', async () => {
    const { fetchMock } = await signInDurably({
      '/v1/auth/refresh': () =>
        refreshOk({ access: 'access-2', refresh: 'refresh-2' }),
    });
    const fetchFn = jest.fn(async (_url: string, init?: RequestInit) =>
      bearerOf(init) === 'access-2' ? response({ items: [] }) : unauthorized(),
    );
    const api = createTrainingApi(liveClientConfig(fetchFn));

    let caught: unknown;
    try {
      await api.listCatalogDrills({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TrainingError);
    expect(caught).toMatchObject({
      code: 'training.session_expired',
      status: 401,
      retryable: false,
    });
    expect(bearerOf(fetchFn.mock.calls[0]![1])).toBe('access-1');

    await settleUnauthorizedHandling();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(useAuthStore.getState().session?.provider).toBe('apple');
    expect(useAuthStore.getState().error).toBeNull();
    expect(getApiSession()?.bearerToken).toBe('access-2');

    // The same client — configured once per sign-in — now sends the rotated
    // bearer and succeeds.
    await expect(api.listCatalogDrills({})).resolves.toEqual([]);
    expect(bearerOf(fetchFn.mock.calls[1]![1])).toBe('access-2');
  });

  it('billing client: 401 is a distinct, non-retryable sign-in-expired error for THAT call (a 503 is a retryable outage), while the session is refreshed rather than torn down', async () => {
    const { fetchMock } = await signInDurably({
      '/v1/auth/refresh': () =>
        refreshOk({ access: 'access-2', refresh: 'refresh-2' }),
    });
    const accessBody = {
      premium: false,
      entitlements: [],
      freeRatings: {
        limit: 2,
        used: 0,
        reserved: 0,
        remaining: 2,
        availableToReserve: 2,
      },
      canStartRating: true,
      paywallRequired: false,
    };
    const fetchFn = jest.fn(async (_url: string, init?: RequestInit) =>
      bearerOf(init) === 'access-2' ? response(accessBody) : unauthorized(),
    );
    const client = createCanonicalAccessClient(liveClientConfig(fetchFn));

    let caught: unknown;
    try {
      await client.getAccess();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BillingError);
    expect(caught).toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: false,
      message:
        'Your sign-in has expired. Sign in again to check membership access.',
    });
    expect(bearerOf(fetchFn.mock.calls[0]![1])).toBe('access-1');
    // A 503 is a retryable outage with different copy and no auth reaction.
    const outageFetch = jest.fn().mockResolvedValue(response({}, 503));
    let outage: unknown;
    try {
      await createCanonicalAccessClient(
        liveClientConfig(outageFetch),
      ).getAccess();
    } catch (error) {
      outage = error;
    }
    expect(outage).toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
      message: 'Membership verification is temporarily unavailable.',
    });

    await settleUnauthorizedHandling();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(useAuthStore.getState().session?.provider).toBe('apple');
    expect(useAuthStore.getState().error).toBeNull();
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });

    // The same client now bears the rotated token and succeeds.
    await expect(client.getAccess()).resolves.toMatchObject({
      premium: false,
      canStartRating: true,
    });
    expect(bearerOf(fetchFn.mock.calls[1]![1])).toBe('access-2');
  });

  it('a late 401 for a bearer that was already rotated away is ignored: no second refresh, no sign-out', async () => {
    const { fetchMock } = await signInDurably({
      '/v1/auth/refresh': () =>
        refreshOk({ access: 'access-2', refresh: 'refresh-2' }),
    });
    // A client that (wrongly) captured the bearer at construction keeps
    // sending `access-1` after the rotation below.
    const staleFetch = jest.fn().mockResolvedValue(unauthorized());
    const staleClient = createCanonicalAccessClient({
      baseUrl: API,
      token: 'access-1',
      fetchFn: staleFetch,
    });

    // First 401 for the CURRENT bearer → one rotation.
    await expect(staleClient.getAccess()).rejects.toBeInstanceOf(BillingError);
    await settleUnauthorizedHandling();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(getApiSession()?.bearerToken).toBe('access-2');

    // A late 401 naming the superseded bearer changes nothing.
    await expect(staleClient.getAccess()).rejects.toBeInstanceOf(BillingError);
    await settleUnauthorizedHandling();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    expect(useAuthStore.getState().session?.provider).toBe('apple');
    expect(useAuthStore.getState().error).toBeNull();
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
  });
});

describe('auth-session-lifecycle: the ONE implicit sign-out is a refused refresh token', () => {
  it.each([401, 403])(
    'a %i from /v1/auth/refresh after a route 401 drops the session: no bearer, no Keychain record, no re-prompt, and the queued row waits for the next sign-in',
    async refusalStatus => {
      const { signInWithApple, fetchMock } = await signInDurably({
        '/v1/auth/refresh': () =>
          response({ error: { message: 'Sign in again.' } }, refusalStatus),
        '/v1/shots:sync': () => unauthorized(),
      });
      const owner = canonicalDataOwner(canonicalId);
      queueShot(owner);
      const transport = createTransport(liveClientConfig());

      const first = await drainOutbox(mockCurrentDb(), transport);
      expect(first).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
      expect(mockOutbox[0]).toMatchObject({ attempts: 0 });

      await settleUnauthorizedHandling();
      expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
      const state = useAuthStore.getState();
      expect(state.session).toBeNull();
      expect(state.busy).toBe(false);
      // dropRevokedSession surfaces no error banner: the sign-in screen
      // simply comes back (pinned as the product behaves).
      expect(state.error).toBeNull();
      expect(getApiSession()).toBeNull();
      expect(bearerTokenFor(canonicalId)).toBeNull();
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(vaultRecord()).toBeNull();
      expect(mockKv.get('auth.last-provider') ?? '').toBe('');
      expect(mockKv.get('auth.local-mode') ?? '').toBe('');
      expect(signInWithApple).toHaveBeenCalledTimes(1);
      expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();

      // A stray tick after teardown sends nothing: the signed-out owner has
      // no rows and the per-request bearer resolves to null, so the dead
      // bearer is never replayed and the row stays queued for the next
      // sign-in with its budget intact.
      const afterTeardown = await drainOutbox(mockCurrentDb(), transport);
      expect(afterTeardown).toMatchObject({
        synced: 0,
        failed: 0,
        remaining: 0,
      });
      expect(callsTo(fetchMock, '/v1/shots:sync')).toHaveLength(1);
      expect(mockOutbox).toHaveLength(1);
      expect(mockOutbox[0]).toMatchObject({ owner_key: owner, attempts: 0 });
    },
  );

  it('a refresh that merely fails transiently (5xx) after a route 401 keeps the user signed in', async () => {
    const { fetchMock } = await signInDurably({
      '/v1/auth/refresh': () =>
        response({ error: { message: 'temporarily unavailable' } }, 503),
    });
    const fetchFn = jest.fn().mockResolvedValue(unauthorized());
    const client = createCanonicalAccessClient(liveClientConfig(fetchFn));
    await expect(client.getAccess()).rejects.toBeInstanceOf(BillingError);
    await settleUnauthorizedHandling();

    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(1);
    // Server trouble is never a sign-out: the session, the (still current)
    // bearer and the Keychain record all stay, and the keeper retries.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(useAuthStore.getState().error).toBeNull();
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-1',
      refreshToken: 'refresh-1',
    });
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
  });
});

describe('auth-session-lifecycle: a LEGACY provider-token session keeps the pre-contract 401 path', () => {
  it('Apple (no silent restore): a 401 ends the session with an honest "sign-in expired" reason, keeps the row for the next sign-in, and never replays the dead bearer', async () => {
    const identityToken = appleIdentityToken(
      Math.floor(Date.now() / 1000) + 600,
    );
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () => legacyBootstrap(),
      '/v1/shots:sync': () =>
        response(
          {
            error: {
              code: 'unauthorized',
              message: 'The identity token could not be verified.',
            },
          },
          401,
        ),
    });
    const signInWithApple = await signInWithAppleToken(identityToken);
    expect(getApiSession()?.bearerToken).toBe(identityToken);
    const owner = canonicalDataOwner(canonicalId);
    expect(getActiveDataOwner()).toBe(owner);
    queueShot(owner);
    const transport = createTransport(liveClientConfig());

    // Wall clock moves past the identity token's exp; server answers 401.
    const result = await drainOutbox(mockCurrentDb(), transport);
    expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    expect(bearerOf(callsTo(fetchMock, '/v1/shots:sync')[0]![1])).toBe(
      identityToken,
    );
    expect(mockOutbox[0]).toMatchObject({
      attempts: 0,
      last_error: expect.stringContaining('could not be verified'),
    });

    // Nothing to rotate: no refresh call is even attempted. Apple has no
    // silent restore, so the user lands signed out with an honest reason,
    // the bearer is gone, and the sync runtime is torn down. The provider is
    // not re-prompted behind their back.
    await settleUnauthorizedHandling();
    expect(callsTo(fetchMock, '/v1/auth/refresh')).toHaveLength(0);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toEqual({
      code: 'auth.session_expired',
      message: SESSION_EXPIRED_MESSAGE,
    });
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(vaultRecord()).toBeNull();
    expect(mockKv.get('auth.local-mode') ?? '').toBe('');
    expect(signInWithApple).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();

    // A stray tick after teardown sends nothing and the row stays queued.
    const afterTeardown = await drainOutbox(mockCurrentDb(), transport);
    expect(afterTeardown).toMatchObject({ synced: 0, failed: 0, remaining: 0 });
    expect(callsTo(fetchMock, '/v1/shots:sync')).toHaveLength(1);
    expect(mockOutbox).toHaveLength(1);
    expect(mockOutbox[0]).toMatchObject({ owner_key: owner, attempts: 0 });
  });
});
